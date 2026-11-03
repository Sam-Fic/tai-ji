/**
 * turn 边界索引正序分块扫描器（turn-boundary-index 设计 §3.1「首次建索引」/「增量
 * 与失效」，D3）。
 *
 * 职责（§5.2 文件改动地图）：正序分块读取 pi session JSONL、按完整行推进 turn 边界
 * 识别，集中持有上游字段形态（pi entry 的 type / message.role / id——本文件是
 * infra/pi 合法持有点，AGENTS.md 关键规则 5）。不构建 Message[]、不耦合窗口选择与
 * stat 失效判定（turn-index-store 编排）。
 *
 * 核心算法：
 * - 分块正序读（默认 1MB/块），块间维护 leftover（最后一个 '\n' 之后的未完整字节），
 *   只把完整行交付解析——完整行的字节区间内不含被切断的 UTF-8 多字节字符（'\n'
 *   是单字节字符且不出现在多字节序列内部，行内序列必完整），decode 无 U+FFFD 污染。
 * - scannedOffset 只推进到最后完整换行之后（SI3 保守位置）；残尾（无换行结尾的
 *   半截行）留在 [scannedOffset, fileSize)，下次从残尾起点重读。
 * - 续扫（resume.startOffset + priorTurns）：每收到一条完整行先延长当前末 turn 的
 *   byteLength / budgetBytes，遇到新 user 边界时以该边界行首偏移开始新记录——旧末
 *   turn 的长度构造性不会越过新边界（逐行累计到边界即止）。
 * - 每块处理后让出事件循环（setImmediate）：单块同步计算有界（≤1MB 解析量），
 *   全量扫描不长时间独占事件循环。
 *
 * 边界判定复用 session-history.ts isTurnBoundary 语义（type === 'message' &&
 * message.role === 'user'，D11 turn 定义），叠加索引必需的 string id 收窄（无 id
 * 的 user 行不可索引，按普通行降级留在当前 turn 内——防御形态，pi 正常写入恒有 id）。
 *
 * 实际 entryId 校验（verifyTurnBoundaries，D3）：按记录 byteOffset 只读边界行本身，
 * 解析失败 / 非 user message / entryId 不符都按失配返回——窗口读取前的直接反证，
 * 不依赖 stat 元数据（SI4）。
 */
import { open } from 'node:fs/promises'

import { isEnoent } from '../../utils/errors.js'
import type { TurnIndexTurnRecord } from './turn-index-types.js'

/* eslint-disable no-magic-numbers -- 块大小与 '\n' 字节值是设计标定量（对齐
 * utils/history-reverse-read.ts DEFAULT_REVERSE_CHUNK_BYTES 的同款豁免形态），
 * 命名常量承载语义，非散落魔法数 */
/** 默认块大小：1MB（对齐 utils/history-reverse-read DEFAULT_REVERSE_CHUNK_BYTES 量级）。 */
export const TURN_SCAN_CHUNK_BYTES = 1024 * 1024

/** 校验读的行读取块大小（64KB 增长读，边界行本身通常百字节级）。 */
const VERIFY_READ_CHUNK_BYTES = 64 * 1024

/** 行分隔字节（'\n'，JSONL 行界；单字节字符，不出现在 UTF-8 多字节序列内部）。 */
const LINE_DELIMITER_BYTE = 0x0a
/* eslint-enable no-magic-numbers */

/** 续扫入参：从上次完整换行之后继续，末条既有 turn 记录随行延长。 */
export interface TurnScanResume { // oe-exempt:20261103:framework:扫描器 IO 原语边界数据契约（续扫入参，单实现常态）
  /** 续扫起点（上次 scannedOffset——已确认完整换行之后的字节偏移，即残尾起点）。 */
  startOffset: number
  /** 续扫前的既有 turns（末条将被延长；数组与记录对象都不被修改，内部深拷贝）。 */
  priorTurns: readonly TurnIndexTurnRecord[]
}

/** 正序扫描结果（stat 快照由调用方 turn-index-store 另行定格）。 */
export interface TurnScanResult { // oe-exempt:20261103:framework:扫描器 IO 原语边界数据契约（扫描产出，单实现常态）
  /** 全量 turns（= priorTurns 延长 + 新增；新数组，入参不被修改）。 */
  turns: TurnIndexTurnRecord[]
  /** 已扫过最后完整换行的字节位置（残尾起点；无残尾 = 所观察文件大小）。 */
  scannedOffset: number
  /**
   * 本轮扫描打开文件时观察到的文件大小（fstat size）。残尾稳态下 scannedOffset <
   * observedSize（半截行未完成）；调用方以它做「扫描期间是否追加 / 缩小」的收敛
   * 判定基准——不能用 scannedOffset 对比（会把残尾稳态误判为待续扫追加）。
   */
  observedSize: number
}

/**
 * 边界行解析：返回 user message 边界的 entryId；非边界（含畸形 JSON / 非 object /
 * message.role 非 user / id 非非空 string）返回 null。
 *
 * 与 session-history.ts isTurnBoundary 逐字同语义（type / message.role 两级判定）；
 * 独立持有而非 import——该函数未导出且 services→infra 反向依赖不成层
 * （archive/summary-extractor 同款先例）。
 */
function userBoundaryIdOf(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const entry = parsed as Record<string, unknown>
  if (entry.type !== 'message') return null
  const message = entry.message
  if (typeof message !== 'object' || message === null) return null
  if ((message as Record<string, unknown>).role !== 'user') return null
  const id = entry.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** 扫描跨行累积状态（processLine 与主循环共享）。 */
interface ForwardScanState { // oe-exempt:20261103:framework:扫描内部跨行累积状态（文件私有形状，非对外扩展点）
  /** 输出 turns（延长中的末条是 turns[turns.length - 1]）。 */
  turns: TurnIndexTurnRecord[]
  /** 下一行首字节的绝对偏移。 */
  lineStart: number
  /** 已扫过最后完整换行的位置。 */
  scannedOffset: number
}

/**
 * 单条完整行入账：user 边界开新 turn，其余行延长当前末 turn（无末 turn = 首条 turn
 * 前的前导段，不建记录——设计「前导段不单独建记录」）。
 */
function processLine(state: ForwardScanState, line: string): void {
  const lineBytes = Buffer.byteLength(line, 'utf-8')
  const boundaryId = userBoundaryIdOf(line)
  if (boundaryId !== null) {
    // 边界行自身计入本 turn：byteLength 含边界行（含行尾换行）——窗口按
    // [byteOffset, byteOffset+byteLength) 读取必须覆盖 turn 首条 entry（边界行）；
    // budgetBytes 含边界行（不计换行），对齐 session-history.ts collectLineIntoWindow
    // 的尾读口径（边界行入列时即按 Buffer.byteLength 累计）。
    state.turns.push({
      entryId: boundaryId,
      byteOffset: state.lineStart,
      byteLength: lineBytes + 1,
      budgetBytes: lineBytes,
    })
  } else {
    const last = state.turns[state.turns.length - 1]
    if (last !== undefined) {
      last.byteLength += lineBytes + 1
      last.budgetBytes += lineBytes
    }
  }
  state.lineStart += lineBytes + 1
  state.scannedOffset = state.lineStart
}

/**
 * 正序分块扫描 turn 边界（全量或从 resume 续扫）。
 *
 * 读取到打开时观察到的文件尾（fstat size）；扫描期间的继续增长 / 重写缩小由调用方
 * re-stat 后裁决（续扫收敛或失配重建，编排与判定在 turn-index-store）——本函数对
 * resume.startOffset > size 的竞态形态不做钳制（钳制会静默产出重复 turns），
 * 无迭代即返回，startOffset 原样透传给调用方的 stat 失效判定。
 *
 * @param filePath pi session JSONL 绝对路径
 * @param resume 续扫状态（缺省 = 从 0 全量扫描）
 * @param options chunkBytes 块大小（测试注入小块验证跨块行拼接）
 * @returns null = 文件打开 ENOENT（pi 延迟落盘 / 竞态删除——空页语义由调用方承接）；
 *          EACCES/EIO 等其它打开失败显式上抛（设计 D5 错误分级：主文件故障不伪装成空历史，
 *          基线 stat 预检同款分级 RT-5#4）
 */
export async function scanTurnBoundariesForward(
  filePath: string,
  resume?: TurnScanResume,
  options?: { chunkBytes?: number },
): Promise<TurnScanResult | null> {
  const chunkBytes = Math.max(1, options?.chunkBytes ?? TURN_SCAN_CHUNK_BYTES)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, 'r')
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
  try {
    const size = (await handle.stat()).size
    const startOffset = resume?.startOffset ?? 0
    const state: ForwardScanState = {
      turns: (resume?.priorTurns ?? []).map((t) => ({ ...t })),
      lineStart: startOffset,
      scannedOffset: startOffset,
    }
    const chunk = Buffer.alloc(chunkBytes)
    let leftover: Buffer = Buffer.alloc(0)
    let cursor = startOffset
    while (cursor < size) {
      const readLen = Math.min(chunkBytes, size - cursor)
      const { bytesRead } = await handle.read(chunk, 0, readLen, cursor)
      if (bytesRead === 0) break
      cursor += bytesRead
      const combined = leftover.length === 0
        ? chunk.subarray(0, bytesRead)
        : Buffer.concat([leftover, chunk.subarray(0, bytesRead)])
      const lastNewline = combined.lastIndexOf(LINE_DELIMITER_BYTE)
      if (lastNewline === -1) {
        // 必须拷贝：combined 是外层复用 chunk buffer 的子数组，下一轮 read 会覆写它
        leftover = Buffer.from(combined)
      } else {
        const text = combined.subarray(0, lastNewline).toString('utf-8')
        leftover = Buffer.from(combined.subarray(lastNewline + 1))
        for (const line of text.split('\n')) processLine(state, line)
      }
      // 每块处理后让出事件循环（设计「首次建索引」：块级同步计算有界 + 段间让出）
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return { turns: state.turns, scannedOffset: state.scannedOffset, observedSize: size }
  } finally {
    await handle.close()
  }
}

/** verifyTurnBoundaries 的失败原因（SI4：读取窗口对索引的直接反证）。 */
export type TurnBoundaryVerifyReason =
  /** 边界行 JSON 解析失败（含读不到行内容）。 */
  | 'parse-failed'
  /** 行解析成功但非 user message 边界（对象类型 / role 不符）。 */
  | 'not-user-boundary'
  /** 是 user 边界但 entryId 与记录不符。 */
  | 'entry-id-mismatch'

/** 单条校验失败（index = 入参 records 中的下标，expected = 期望 entryId）。 */
export interface TurnBoundaryVerifyFailure { // oe-exempt:20261103:framework:边界校验结果契约（scanner↔store 边界数据形状，单实现常态）
  ok: false
  index: number
  reason: TurnBoundaryVerifyReason
  expected: string
}

/**
 * 实际 entryId 校验（D3）：按记录 byteOffset 逐条读边界行，要求解析成功、是 user
 * message 边界且 entryId 与记录精确相等。
 *
 * 只读边界行本身（64KB 增长读到行尾换行 / EOF），不读整个窗口——校验集合是选中的
 * 窗口 turn 加 cursor turn（如有），由调用方（turn-index-store / reader）组传入参。
 * 记录须按 byteOffset 升序（索引 turns 的天然序）；首个失配即整体判失败，调用方按
 * 失配重建处置。
 *
 * @returns { ok: true } 全部精确相等；否则首个失败项
 */
export async function verifyTurnBoundaries(
  filePath: string,
  records: readonly TurnIndexTurnRecord[],
): Promise<{ ok: true } | TurnBoundaryVerifyFailure> {
  if (records.length === 0) return { ok: true }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, 'r')
  } catch (e) {
    if (isEnoent(e)) {
      // ENOENT 竞态删除：校验无法成立，按首记录 parse-failed 报告失配（重建扫描对已删
      // 文件返回 null → ensureFresh null → 空页语义）
      return { ok: false, index: 0, reason: 'parse-failed', expected: records[0].entryId }
    }
    // EACCES/EIO 等显式上抛（设计 D5 错误分级：主文件故障不伪装成失配重建——伪装会让
    // 权限故障先烧一次无谓重建再在重建扫描处失败，还污染失配分类观测）
    throw e
  }
  try {
    for (let i = 0; i < records.length; i++) {
      const record = records[i]
      const trimmed = (await readLineAt(handle, record.byteOffset)).trim()
      if (trimmed.length === 0 || !isJsonParsable(trimmed)) {
        return { ok: false, index: i, reason: 'parse-failed', expected: record.entryId }
      }
      const boundaryId = userBoundaryIdOf(trimmed)
      if (boundaryId === null) {
        return { ok: false, index: i, reason: 'not-user-boundary', expected: record.entryId }
      }
      if (boundaryId !== record.entryId) {
        return { ok: false, index: i, reason: 'entry-id-mismatch', expected: record.entryId }
      }
    }
    return { ok: true }
  } finally {
    await handle.close()
  }
}

/** JSON.parse 布尔探测（verify 的 parse-failed / not-user-boundary 分类用）。 */
function isJsonParsable(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * 从指定偏移读到行尾（第一个 '\n' 或 EOF），返回行文本（不含 '\n'）。
 * 64KB 增长读——边界行长度上界 = 文件大小，无独立截断。
 */
async function readLineAt(handle: Awaited<ReturnType<typeof open>>, offset: number): Promise<string> {
  const parts: Buffer[] = []
  let cursor = offset
  for (;;) {
    const buf = Buffer.alloc(VERIFY_READ_CHUNK_BYTES)
    const { bytesRead } = await handle.read(buf, 0, VERIFY_READ_CHUNK_BYTES, cursor)
    if (bytesRead === 0) break
    const nl = buf.subarray(0, bytesRead).indexOf(LINE_DELIMITER_BYTE)
    if (nl !== -1) {
      parts.push(buf.subarray(0, nl))
      return Buffer.concat(parts).toString('utf-8')
    }
    parts.push(buf.subarray(0, bytesRead))
    cursor += bytesRead
  }
  return Buffer.concat(parts).toString('utf-8')
}
