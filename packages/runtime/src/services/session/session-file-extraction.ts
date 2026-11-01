/**
 * 会话文件读取策略双轨（W1 [D6/D7]）：
 * - 旧格式惰性兼容读路径 extractRecordsFromSessionFile：读侧换源后调用方收窄为
 *   oversize 分流（v1 巨文件时代会话，>32MB）——32MB 预检与 oversize 语义退役至
 *   此专属。行为冻结：预检/降级/错误分级语义保持改造前逐字不变；
 * - 新路径冷启动流式扫描 scanRecordFamilyEntriesFromSessionFile：按块读 + 行预过滤
 *   + 仅 record 族与 plan-state 条目进结果（[U5 plan 冷路径归一 D6] 起 plan-state 条目
 *   同批进产出——getPlanState 冷启动派生的喂数通道；不整串物化、不解析全部对话行），
 *   journal 派生视图的 entry 源冷启动专用（events-projection.ts 消费）。
 *
 * subagent-extractor 与 workflow-extractor 的文件读取骨架此前逐字复制（statSync 预检 →
 * oversize 降级 warn → readFileSync → parseJsonl → entry 扫描），两份漂移即行为分叉；
 * 本骨架把读取/预检/降级语义收单点，两个 extractor 只提供各自的日志标签、降级文案
 * 与 entry 扫描器。
 *
 * 错误分级契约（renderer 侧栏 stale 检查的前提，两 extractor 原样保留）：
 * - ENOENT → 空列表 + oversize:false（pi session 文件延迟写入的合法窗口）
 * - 其他读错误 → 原样上抛（RPC 报错，renderer catch 保留旧分区 + 重试态，不与「真实删空」混淆）
 * - 预检 stat 失败（含 ENOENT）→ 走原读路径，错误分级由 readFileSync 承担，预检不引入新抛错
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { parseJsonl } from '../../utils/jsonl.js'
import { isEnoent } from '../../utils/errors.js'
import { warnOnce } from '../../utils/warn-once.js'
import { BYTES_PER_MB, READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
import {
  SUBAGENT_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_STATE_LINK_CUSTOM_TYPE,
} from '@zhushanwen/subagent-core'
import { PLAN_STATE_CUSTOM_TYPE } from '@zhushanwen/extension-protocol'

/** extract*FromSessionFile 的结果形状：records + oversize 正交降级标志（不往 records
 * 里塞哨兵记录；正交字段先例 = HistoryFileReadResult {messages, truncated} /
 * traceEntries source:'oversize'）。 */
export interface SessionFileExtraction<T> {
  /** 派生记录列表；oversize 时恒空数组（不做尾读部分提取——extractor 是全文扫描
   * 语义，部分提取的记录缺失面难界定，memory-leak-remediation 三审 INFO-3） */
  records: T[]
  /** 主 session JSONL 超预检阈值的降级标记（true = 未读文件，records 为降级空列表） */
  oversize: boolean
}

/** 各 extractor 注入的差异点：日志标签、降级文案的被提取对象名、entry 扫描器。 */
export interface SessionFileExtractionReader<T> {
  /** warn 留痕的日志前缀（如 'subagent-extractor'） */
  warnTag: string
  /** oversize 降级文案中的被提取对象名（如 'subagent' / 'workflow'） */
  subject: string
  /** entry 扫描器（与实时增量拉取同一份派生代码） */
  scan: (entries: unknown[]) => T[]
}

/**
 * 从主 session JSONL 文件提取记录（冷启动 / RPC 路径的共享骨架）。
 *
 * [G3 / crash-resilience D5⑤] READ_PRECHECK 预检：statSync 大小 > READ_PRECHECK_MAX_BYTES
 * （32MB，与 session-file-utils 全量读预检同阈值同标尺）时不读全文，降级返回空列表 +
 * oversize 标记 + warn 留痕（对齐 trace-sync D5④ 的 oversize 降级范式）。
 */
export function extractRecordsFromSessionFile<T>(
  filePath: string,
  reader: SessionFileExtractionReader<T>,
): SessionFileExtraction<T> {
  let fileSize = -1
  try {
    fileSize = statSync(filePath).size
  } catch {
    // 预检失败不改变错误契约：fall through 到读路径，由 readFileSync 产生原分级错误
    fileSize = -1
  }
  if (fileSize > READ_PRECHECK_MAX_BYTES) {
    console.warn(
      `[${reader.warnTag}] session file oversize ` +
      `(${(fileSize / BYTES_PER_MB).toFixed(1)} MB > ${(READ_PRECHECK_MAX_BYTES / BYTES_PER_MB).toFixed(0)} MB), ` +
      `skip ${reader.subject} extraction (degraded to empty list): ${filePath}`,
    )
    return { records: [], oversize: true }
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) return { records: [], oversize: false }
    throw e
  }

  const entries = parseJsonl(content)
  return { records: reader.scan(entries), oversize: false }
}

// ── [W1 / D6] 新路径冷启动流式扫描（32MB 扫描上界）─────────────

/**
 * 行预过滤线索（substring 先行，命中才 JSON.parse——会话文件主体是对话 entry，
 * record 族条目是稀疏少数；线索取宽：误命中无害，解析后由扫描器形状过滤；
 * 漏命中有害：记录消失）。覆盖 v1/v2 条目族 + legacy 解析所需的 message/
 * session/bg-notify 形态。
 */
const RECORD_FAMILY_LINE_HINTS: readonly string[] = [
  SUBAGENT_RECORD_CUSTOM_TYPE, // v1 快照 + v2 注册/终态条目
  WORKFLOW_RECORD_CUSTOM_TYPE, // 同上（两族）
  WORKFLOW_STATE_LINK_CUSTOM_TYPE, // legacy workflow 指针
  PLAN_STATE_CUSTOM_TYPE, // [U5 plan 冷路径归一 D6] plan-state 条目——续读链是 getPlanState
  // 冷启动 plan 派生的唯一喂数通道（读路径归一，全文解析已退役）；漏掉它 = plan 冷启动
  // 派生永远为空（「线索取宽：漏命中有害」的本族成员）
  'subagent-bg-notify', // legacy bg-notify custom_message
  '"subagent"', // legacy toolCall（"name":"subagent"）/ toolResult（"toolName":"subagent"）
  '"type":"session"', // legacy 主 cwd 提取（findLegacyMainCwd）
]

/** 流式扫描的读块大小（256KiB = 262_144：行平均 <2KB，跨块行拼接余量充足）。 */
const STREAM_CHUNK_BYTES = 262_144

/** 行边界字节（0x0A）：UTF-8 多字节序列的续字节均 ≥ 0x80，按字节找行界构造性安全。 */
const LINE_FEED_BYTE = 0x0a
/** 残行缓冲的容量倍增系数（逐块追加 O(1) 摊销——超长行不产生逐块全量拷贝）。 */
const PENDING_GROWTH_FACTOR = 2

/** 流式扫描结果：record 族 entry 列表 + 续读游标（[U1 续读化] 游标登记点）。 */
export interface RecordFamilyScanResult {
  entries: unknown[]
  /**
   * 扫描到达的字节偏移（下一轮续读起点，恒落在完整行边界——末段无尾随换行的残行
   * 不计入，等下次拼齐）。append-only 前提下游标只经实际读取推进，size 与游标相等
   * 即「已读到文件尾」（零重算核对判据，见 session-records 续读核对）。
   */
  nextOffset: number
  /** true = 文件 size 小于 startOffset（截断/重写形态——调用方唯一应整体重建的场景）。 */
  truncated: boolean
  /**
   * [U3 分片扫描] true = 本片软预算（maxBytes）用尽且未到文件尾——调用方继续排下一片；
   * 缺省（undefined/false）= 已读到文件尾。仅在 maxBytes 生效时可能为 true。
   */
  hasMore?: boolean
}

/**
 * 主 session 文件的 record 族条目流式扫描（journal 派生视图的 entry 源喂入面；
 * [U1 续读化] 起点参数化——startOffset 缺省 0 = 冷启动全量，>0 = 从已读游标续读
 * 增量段）。append-only 前提（AS1）下 startOffset 处恒为行边界（游标只在读完
 * 文件时登记），续读段首行即完整行。
 *
 * [U3 分片扫描] opts.maxBytes = 单片软预算：本片最多推进的字节量（到完整行边界即
 * 停，hasMore: true）。异步整建/续读任务按片调度（片间让出事件循环——单片同步块
 * 有界，预算语义见 session-records QUERY_SYNC_BUDGET_BYTES）。软预算在行尾兑现：
 * 残行跨预算时本片推进到该行末尾（超支 ≤ 一行；会话行无 MB 级形态，登记为边界
 * 语义非风险）。缺省 = 单片读全程（既有语义不变）。
 *
 * 与上方全文兼容路径的区别：按块读 + 行预过滤 + 仅 record 族 entry 进结果。
 * 返回 null = 扫描字节上界外（v1 巨文件时代会话 / stat 与读之间增长超界的竞态
 * 防御）——调用方回落旧格式惰性兼容读路径，游标不得登记。
 *
 * ENOENT / 打开失败 → 空条目、游标原地不动（pi session 文件延迟写入的合法窗口，
 * 与既有骨架分级一致：缺文件必然无 record；归零会诱导上层把重写后的文件当增量续读）。
 *
 * 实现注：残行按字节（Buffer）拼接、完整行区按 0x0A 切分后逐行 utf8 解码——
 * 分片中途退出需要字节级行边界定位（nextOffset 恒行边界的载体）；UTF-8 多字节
 * 序列的续字节均 ≥ 0x80，0x0A 只出现在 ASCII 区间，按字节切行构造性不截断
 * 多字节字符（替代早前的字符串 carry 拼接——块边界截断多字节字符会产生 U+FFFD）。
 */
export function scanRecordFamilyEntriesFromSessionFile(
  filePath: string,
  startOffset = 0,
  opts?: { maxBytes?: number },
): RecordFamilyScanResult | null {
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return { entries: [], nextOffset: startOffset, truncated: false }
  }
  if (size > READ_PRECHECK_MAX_BYTES) return null
  if (size < startOffset) {
    return { entries: [], nextOffset: 0, truncated: true }
  }
  const entries: unknown[] = []
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return { entries: [], nextOffset: startOffset, truncated: false }
  }
  const maxBytes = opts?.maxBytes
  try {
    // 分片形态下读块对齐片预算（块内无行界检查点——块大于预算时单片会超支到块尾）
    const chunkCap = maxBytes !== undefined ? Math.min(STREAM_CHUNK_BYTES, maxBytes) : STREAM_CHUNK_BYTES
    const chunk = Buffer.alloc(chunkCap)
    // 残行缓冲：自有容量倍增 buffer（不共享读块内存——readSync 复用 chunk 覆写）。
    // 逐块追加 O(1) 摊销（无换行的超长行不产生逐块全量拷贝）；残段移动用同 buffer
    // 重叠 copy（memmove 语义）。
    let pending = Buffer.allocUnsafe(chunkCap)
    let pendingLen = 0
    const appendPending = (bytesRead: number): void => {
      if (pendingLen + bytesRead > pending.length) {
        const grown = Buffer.allocUnsafe(Math.max(pending.length * PENDING_GROWTH_FACTOR, pendingLen + bytesRead))
        pending.copy(grown, 0, 0, pendingLen)
        pending = grown
      }
      chunk.copy(pending, pendingLen, 0, bytesRead)
      pendingLen += bytesRead
    }
    let position = startOffset
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunkCap, position)
      if (bytesRead === 0) break
      position += bytesRead
      if (position - startOffset > READ_PRECHECK_MAX_BYTES) return null // 防御：stat 与读之间增长超界
      appendPending(bytesRead)
      const lastNewline = pending.lastIndexOf(LINE_FEED_BYTE, pendingLen - 1)
      if (lastNewline === -1) continue
      const restLen = pendingLen - (lastNewline + 1)
      const boundaryOffset = position - restLen // 完整行区末尾 = 行边界（字节精确）
      for (const line of pending.toString('utf8', 0, lastNewline).split('\n')) {
        collectRecordFamilyLine(filePath, line, entries)
      }
      if (maxBytes !== undefined && boundaryOffset - startOffset >= maxBytes && boundaryOffset < size) {
        // 软预算用尽：停在行边界，剩余交下片（hasMore 语义）
        return { entries, nextOffset: boundaryOffset, truncated: false, hasMore: true }
      }
      // 残段移到缓冲头部（重叠 copy = memmove）
      pending.copy(pending, 0, lastNewline + 1, pendingLen)
      pendingLen = restLen
    }
    collectRecordFamilyLine(filePath, pending.toString('utf8', 0, pendingLen), entries) // 末段（无尾随换行的最后一行）
    return { entries, nextOffset: position, truncated: false }
  } finally {
    closeSync(fd)
  }
}

function collectRecordFamilyLine(filePath: string, line: string, entries: unknown[]): void {
  if (line.length === 0) return
  let hit = false
  for (const hint of RECORD_FAMILY_LINE_HINTS) {
    if (line.includes(hint)) {
      hit = true
      break
    }
  }
  if (!hit) return
  try {
    entries.push(JSON.parse(line))
  } catch (e) {
    // 坏行宽容跳过 + warnOnce 留证（与 JSONL 全文解析器的逐行容忍语义一致；
    // 按文件去重防坏行密集的旧文件刷屏）
    warnOnce(
      `record-family-scan:${filePath}`,
      `[session-file-extraction] record family scan skipped a malformed line in ${filePath}`,
      e instanceof Error ? e.message : e,
    )
  }
}

/**
 * [U3 异步读入通道] record 族条目分片扫描生成器：每片 ≤ segmentBudgetBytes（软预算，
 * 行边界停），片间经 setTimeout(0) 让出事件循环（macrotask 切片——后续片在下一次事件
 * 循环空闲时执行，查询应答与 /health 等请求可交错；vitest fake timers 可确定性驱动）。
 * 到文件尾（或 truncated / 超界 null）即止，不追任务执行期间的新追加——游标推进到
 * 扫描时点 EOF，剩余增量留给下一轮核对（收敛语义，见 session-records 异步读入任务）。
 *
 * 单源义务：分片调度节奏（片大小与让出原语）只有这一份——异步整建（events-projection
 * buildInSegments）与超预算续读（session-records 异步任务）两个消费方共用，防两处漂移。
 */
export async function* scanRecordFamilyInSegments(
  filePath: string,
  startOffset: number,
  segmentBudgetBytes: number,
): AsyncGenerator<RecordFamilyScanResult | null> {
  let offset = startOffset
  for (;;) {
    const scan = scanRecordFamilyEntriesFromSessionFile(filePath, offset, { maxBytes: segmentBudgetBytes })
    yield scan
    if (scan === null || scan.truncated || !scan.hasMore) return
    offset = scan.nextOffset
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
}
