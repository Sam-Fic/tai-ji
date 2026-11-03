/**
 * turn 边界索引契约（turn-boundary-index 设计 §3.1「存储与格式」，D1/D3）。
 *
 * 索引是 session JSONL 的持久派生只读副本：只保存 user turn 边界 entryId 与物理字节
 * 范围，不含消息正文、永不回写 JSONL（AX1）。落点 = session 存储树
 * history-index/turns.json（路径推导 SSOT = shared paths.ts getSessionHistoryIndexFile）。
 *
 * 字段口径（与设计逐字段一致，禁止增删）：
 * - version：索引格式版本，当前恒 1；不支持的版本触发全量重建。
 * - fileSize / mtimeMs：最后一次 stat 快照（加速判定线索，不构成内容正确性证明——
 *   同尺寸且保留 mtime 的重写由实际 entryId 校验拦截，SI2/SI4）。
 * - scannedOffset：已完成完整行扫描的字节位置，只推进到最后完整换行之后；文件存在
 *   残尾（pi 崩溃留下的无换行残行，SI3）时 scannedOffset < fileSize，下次从残尾起点
 *   重读。
 * - turns[]：每 user turn 一条记录。byteOffset / byteLength 是 turn 的物理字节范围
 *   （从边界行首字节到下一 user 边界行首字节 / 已扫完整行末尾，含行尾换行）；
 *   budgetBytes 是现有尾读口径（session-history collectRecentTurnEntriesFromTail
 *   逐行 Buffer.byteLength(line)）下不计行尾换行的预算字节数。role 恒为 user，
 *   timestamp / parentId 不冗余进索引（从实际窗口 entry 获得）。
 * - 首条 turn 之前的前导段（session header 等）不单独建记录，只有窗口包含首条
 *   turn 时才从 byte 0 读取。
 *
 * 运行时收窄 guard（parseTurnIndexContent）：索引文件是外部输入（可能被旧版本 /
 * 手工 / 损坏写入），读取侧必须经本 guard 收窄——版本不支持与结构损坏分别归类
 * （turn-index-store 按原因分类记录重建）。
 */

/** 索引格式版本（当前 = 1）。 */
export const TURN_INDEX_VERSION = 1

/** 单条 turn 边界记录（字段口径见文件头）。 */
export interface TurnIndexTurnRecord { // oe-exempt:20261103:framework:持久化索引文件格式契约（history-index/turns.json 序列化形态与内存快照），无变体预期
  /** 边界 user message entry 的 id（pi generateId 产出的 8 位十六进制短 id）。 */
  entryId: string
  /** turn 首字节（边界行行首）在文件中的字节偏移。 */
  byteOffset: number
  /** turn 物理字节长度（含各行行尾换行；末 turn 截到已扫完整行末尾）。 */
  byteLength: number
  /** 预算字节数（各行字节长合计，不计行尾换行——现有尾读口径）。 */
  budgetBytes: number
}

/**
 * 索引文件形状（turns.json 的 JSON 序列化形态；序列化用紧凑 JSON.stringify）。
 */
export interface TurnIndexFile { // oe-exempt:20261103:framework:持久化索引文件格式契约（history-index/turns.json 序列化形态与内存快照），无变体预期
  version: number
  fileSize: number
  mtimeMs: number
  scannedOffset: number
  turns: TurnIndexTurnRecord[]
}

/**
 * 不可变索引快照（ensureFresh 完成后交给读取方的视图，设计 §3.1「窗口选择与
 * 单次快照」的 S）：本次读取的右端固定为 scannedOffset。比 TurnIndexFile 少
 * version（内存态恒当前版本），turns 只读。
 */
export interface TurnIndexSnapshot { // oe-exempt:20261103:framework:持久化索引文件格式契约（history-index/turns.json 序列化形态与内存快照），无变体预期
  readonly fileSize: number
  readonly mtimeMs: number
  readonly scannedOffset: number
  readonly turns: readonly TurnIndexTurnRecord[]
}

/**
 * guard 判定结果：
 * - ok：收窄通过（version 恒 TURN_INDEX_VERSION）
 * - unsupported-version：JSON 合法但 version 不是当前支持的值（携带实际值供日志）
 * - corrupted：JSON 解析失败或结构/字段形态不符（携带原因供日志）
 */
export type TurnIndexParseResult =
  | { ok: true; index: TurnIndexFile }
  | { ok: false; reason: 'unsupported-version'; version: unknown }
  | { ok: false; reason: 'corrupted'; detail: string }

/** 非负有限整数判定（字段级 guard：JSON 里可能是负数 / 小数 / 字符串 / NaN 形态）。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 非负有限数判定（mtimeMs 专用：Node stat.mtimeMs 是浮点秒，非整数）。 */
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** turns 数组逐条收窄（结构损坏分类，返回 null = 合法）。 */
function turnRecordProblem(turn: unknown, i: number): string | null {
  if (typeof turn !== 'object' || turn === null) return `turns[${i}] 非 object`
  const t = turn as Record<string, unknown>
  if (typeof t.entryId !== 'string' || t.entryId.length === 0) return `turns[${i}].entryId 非非空 string`
  for (const field of ['byteOffset', 'byteLength', 'budgetBytes'] as const) {
    if (!isNonNegativeInteger(t[field])) return `turns[${i}].${field} 非非负整数`
  }
  return null
}

/**
 * 索引文件内容运行时收窄 guard。
 *
 * 收窄规则（超出即 corrupted）：
 * - 顶层恰为对象且 version / fileSize / mtimeMs / scannedOffset / turns 五字段齐备；
 * - version 是 number 且等于 TURN_INDEX_VERSION（不等 → unsupported-version）；
 * - fileSize / mtimeMs / scannedOffset 是安全数，scannedOffset ≤ fileSize
 *   （跨字段不变量：scannedOffset 只能落在文件内）；
 * - turns 是数组且逐条过 turnRecordProblem；
 * - turns 逐条 byteOffset 严格递增（正序物理偏移，乱序/重叠 = 结构损坏）。
 *
 * @param raw turns.json 文件原文（utf-8）
 */
export function parseTurnIndexContent(raw: string): TurnIndexParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, reason: 'corrupted', detail: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'corrupted', detail: '顶层非 object' }
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.version !== 'number' || !Number.isSafeInteger(obj.version)) {
    return { ok: false, reason: 'corrupted', detail: 'version 非整数' }
  }
  if (obj.version !== TURN_INDEX_VERSION) {
    return { ok: false, reason: 'unsupported-version', version: obj.version }
  }
  if (!isNonNegativeInteger(obj.fileSize)) {
    return { ok: false, reason: 'corrupted', detail: 'fileSize 非非负整数' }
  }
  if (!isNonNegativeInteger(obj.scannedOffset)) {
    return { ok: false, reason: 'corrupted', detail: 'scannedOffset 非非负整数' }
  }
  if (!isNonNegativeNumber(obj.mtimeMs)) {
    return { ok: false, reason: 'corrupted', detail: 'mtimeMs 非非负有限数' }
  }
  if (obj.scannedOffset > obj.fileSize) {
    return { ok: false, reason: 'corrupted', detail: 'scannedOffset > fileSize（越出文件）' }
  }
  if (!Array.isArray(obj.turns)) {
    return { ok: false, reason: 'corrupted', detail: 'turns 非数组' }
  }
  let prevOffset = -1
  for (let i = 0; i < obj.turns.length; i++) {
    const problem = turnRecordProblem(obj.turns[i], i)
    if (problem !== null) return { ok: false, reason: 'corrupted', detail: problem }
    const offset = (obj.turns[i] as { byteOffset: number }).byteOffset
    if (offset <= prevOffset) {
      return { ok: false, reason: 'corrupted', detail: `turns[${i}].byteOffset 非严格递增` }
    }
    prevOffset = offset
  }
  return {
    ok: true,
    index: {
      version: TURN_INDEX_VERSION,
      fileSize: obj.fileSize,
      mtimeMs: obj.mtimeMs,
      scannedOffset: obj.scannedOffset,
      turns: obj.turns as TurnIndexTurnRecord[],
    },
  }
}

/** 索引快照 → 落盘形态（version 回填当前值）。 */
export function snapshotToTurnIndexFile(snapshot: TurnIndexSnapshot): TurnIndexFile {
  return {
    version: TURN_INDEX_VERSION,
    fileSize: snapshot.fileSize,
    mtimeMs: snapshot.mtimeMs,
    scannedOffset: snapshot.scannedOffset,
    turns: snapshot.turns.map((t) => ({ ...t })),
  }
}

/** 落盘形态 → 不可变快照（深拷贝 turns，切断与调用方持有数组的共享）。 */
export function turnIndexFileToSnapshot(file: TurnIndexFile): TurnIndexSnapshot {
  return {
    fileSize: file.fileSize,
    mtimeMs: file.mtimeMs,
    scannedOffset: file.scannedOffset,
    turns: file.turns.map((t) => ({ ...t })),
  }
}
