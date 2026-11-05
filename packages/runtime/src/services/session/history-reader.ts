/**
 * session 历史读编排（turn-boundary-index 终态：索引窗口读取，设计 §3.1 + D2/D4/D5）。
 *
 * 正常历史查看只有索引窗口这一条数据路径（AX4）：getHistory 先经 TurnIndexStore.ensureFresh
 * 取得不可变索引快照 S（本次读取右端固定为 S.scannedOffset），再从 S.turns 按 limitTurns +
 * budgetBytes 双预算选窗（首个 turn 豁免，同既有尾读语义），按记录的字节范围读有限窗口，
 * 经实际 entryId 校验（verifyTurnBoundaries）后进入既有转换链（convertWindowEntries）。
 * 跨窗口 toolCall/toolResult 配对（设计 §4.4/§5）：fold 产出孤儿 toolResult 时按索引向前
 * 扩 turn 段重读重 fold（有界，不退化为全量读），消息形状与全量重建路径对齐。
 * 执行进程是否存在不参与读取分派——pi 进程不存在时同样可打开并连续翻阅长会话（GL1）。
 *
 * 兼容分支（仅两处，设计「cursor 未命中」段）：
 * - 索引零 turn（S.turns.length === 0）：走现有尾读兼容分支；ensureFresh 每次仍先 stat
 *   判定续扫或重建，文件出现首个 user turn 即自然回到索引路径。
 * - cursor 未命中 turns：交现有尾读 cursor 兼容链定位（合法的非边界 entryId 由该链定位，
 *   真正未知由其返回空页且 truncated=false）。
 *
 * 一致性（D3/SI4）：stat 只是加速判定线索；每次窗口读取都把「选中窗口 turns + cursor turn」
 * 交给 verifyTurnBoundaries 做实际 entryId 反证，失配即丢弃索引、全量重建并按新快照重读一次，
 * 仍失配显式报错——旧索引不能凭空产生、删除或拼接消息（AX2）。
 *
 * 生命周期（D5）：onSessionDisposed（session-entry-removal 第 12 步经 SessionService 透传）
 * 只清内存索引，不取消文件读取（回调还覆盖 pi 进程退出、强杀与恢复清场）；onSessionDeleted
 * 是真删除专属挂点（lifecycle.delete / btw closeLine / archive purgeArchive 三入口在整树删除
 * 前经 SessionService 调用），转发内部 store 设取消标记 + 清内存 LRU——被取消的请求按现有
 * ENOENT 空页语义收尾。TurnIndexStore 由 reader 构造时自持（组合接线裁定：session-service
 * 构造点不改签名，删除挂点经本类转发方法到达同一 store 实例）。
 *
 * 退役映射（D4）：per-session 完整消息缓存类、增量合并函数、后台全量重建任务编排
 * （任务句柄 / 待启动登记 / FIFO 队列 / 事件驱动启动四件）与缓存就绪通知及其快照对账、
 * 失败态已全部删除——没有后台全量消息结果，因此没有第二次全量精化合并。已删符号的
 * 权威清单 = 设计文档 §3.1「退役映射」段（本文件不残留任何旧符号字面，机器 grep 门可证）。
 */
import { existsSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SegmentsMetadataFile } from '@taiji/shared'
import { HISTORY_BUDGET } from '@taiji/shared'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getAttachmentsDir } from '@taiji/shared/paths'
import { isPiSessionId } from '@taiji/shared/session-store-paths'
import type { IProcessManager } from '../ports/pi-engine.js'
import type { ISessionStore } from '../ports/session.js'
import type { ITurnIndexScanner } from '../ports/turn-index-scanner.js'
import { exceedsTurnByteBudget, type TurnIndexSnapshot, type TurnIndexTurnRecord } from '../../infra/pi/turn-index-types.js'
import { TurnIndexStore } from './turn-index-store.js'
import {
  activePathEntriesOf,
  convertWindowEntries,
  filterObjectEntries,
  makeMalformedLineWatcher,
  tailReadHistory,
  type HistoryWindowQuery,
  type HistoryWindowResult,
  type TailReadSidecarOpts,
} from '../session-history.js'
import { parseJsonl } from '../../utils/jsonl.js'
import { isEnoent } from '../../utils/errors.js'
import { warnOnce } from '../../utils/warn-once.js'

/**
 * SessionHistoryReader 装配依赖（窄注入；组合接线裁定：本形状即 session-service 构造点
 * 签名，第三波写入只剩 u-lifecycle 的挂点委托调用，不再变化）。
 */
export interface SessionHistoryReaderDeps { // oe-exempt:20261103:framework:装配依赖注入契约（DI 端口先立，组合根构造单实现常态）
  /**
   * pi 进程管理。终态编排不消费 get-entries RPC（AX4：读取分派与进程在场性解耦）；唯一残留
   * 消费 = interrupted 判定的「会话未附着」前提（getClient 在场性纯查询，不发 RPC——设计
   * 「消息转换」段：中断判定只在未附着且最新文件尾窗口时启用，附着会话由 live 链承载，
   * 文件尾推断标记不得误标活跃会话）。
   */
  pm: IProcessManager
  /** session 存储端口（scanSessions 定位主会话文件 + convertHistory 翻译）。 */
  sessionStore: ISessionStore
  /**
   * btw 线 session id → 线会话文件绝对路径（组合根接 BtwService 注册表成员查询，late-bound
   * 闭包）。命中即走线文件（索引与线 sessionId 一一对应，btw 线用线 sessionId 的独立索引，
   * 设计 V6）；返回 undefined = 注册表无此线（主会话经 scanSessions 定位）。缺省注入（未接线
   * 构造）= btw 判别恒 miss，主会话路径零影响。
   */
  resolveBtwThreadFile?: (sessionId: string) => string | undefined
  /**
   * turn 边界扫描 port（store 索引构建的 scanTurnBoundariesForward 与本类窗口校验的
   * verifyTurnBoundaries 同源装配，C-comm-03 须经 port）。infra 实装由组合根 index.ts 经
   * SessionService 构造透传装配，services 层禁 value import infra 实现，故无缺省绑定——
   * 未注入时索引构建与窗口校验即用即抛（scannerPort fail-fast），恢复动作 = 构造时注入
   * （测试直 import infra/pi/turn-index-scanner.js 的同名函数装配）。
   */
  scanner?: ITurnIndexScanner
}

/** 空页（每次新对象：messages 数组随返回值交付，调用方可就地变更，不共享常量数组）。 */
function emptyPage(): HistoryWindowResult {
  return { messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }
}

/**
 * 孤儿驱动的向前扩段上限（设计 §5「跨窗口 toolCall/toolResult 配对」的有界口径）：
 * 连续孤儿链（每扩一段又见更早孤儿）若不设界会逐步扩到 turn 0，等价退化为全量读
 *（设计红线「不读全量」）；超过本数仍有孤儿按现状丢弃并计数观测。
 */
const MAX_ORPHAN_TURN_EXTENSIONS = 2

/** 单次「校验 + 读窗 + 转换」的产出（ok=false = 实际 entryId 校验失配，detail 供归因）。 */
type WindowRead =
  | { ok: true; result: HistoryWindowResult }
  | { ok: false; mismatchDetail: string }

/** 索引窗口选择产物（字节区间与校验集合的推导中间态，readIndexWindow 消费）。 */
interface SelectedIndexWindow { // oe-exempt:20261103:framework:索引窗口选择推导中间态（reader 私有形状，非对外扩展点）
  /** 窗口首 turn 在 snapshot.turns 的下标（孤儿驱动的向前扩段起点；loadedTurns=0 时 = endIdx）。 */
  startIdx: number
  /** 选中窗口的 turn 记录（byteOffset 升序；校验与转换共用）。 */
  windowTurns: TurnIndexTurnRecord[]
  /** cursor 所在 turn（仅进校验集合，不进转换窗口）。 */
  cursorTurn: TurnIndexTurnRecord | undefined
  /** 窗口字节读起点：窗口含首条 turn 时从 byte 0 读（前导段 header 不单独建记录，设计）。 */
  startByte: number
  /** 窗口字节读终点（不含）：cursor 窗口 = cursor turn 的 byteOffset；最新窗口 = scannedOffset。 */
  endByte: number
  /** 窗口外仍有更早 turn（窗口首 turn 下标 > 0）。 */
  truncated: boolean
  /** 窗口内 turn 数。 */
  loadedTurns: number
}

/** 选窗循环产物（字节区间推导中间态）。 */
interface WindowRange {
  /** 窗口首 turn 下标（含）。 */
  startIdx: number
  /** 窗口内 turn 数。 */
  loadedTurns: number
  /** 窗口 budgetBytes 合计（不计行尾换行的尾读口径）。 */
  accBytes: number
}

/**
 * 从 turns[endIdx-1] 向前按 limitTurns + maxBytes 双预算选窗：首个 turn 豁免字节条件
 *（单 turn 超预算完整放行，与尾读 collectRecentTurnEntriesFromTail 共用
 * exceedsTurnByteBudget 单点判定）。
 *
 * 纯函数（无 IO）；budgetBytes 是尾读口径（不计行尾换行）的预算字节，与 tailReadHistory
 * 同源，同一 query 在两条链上选出同量级窗口。
 */
function pickWindowRange(turns: readonly TurnIndexTurnRecord[], endIdx: number, limitTurns: number, maxBytes: number): WindowRange {
  let startIdx = endIdx
  let loadedTurns = 0
  let accBytes = 0
  for (let i = endIdx - 1; i >= 0 && loadedTurns < limitTurns; i--) {
    const budget = turns[i].budgetBytes
    if (exceedsTurnByteBudget(loadedTurns, accBytes + budget, maxBytes)) break
    accBytes += budget
    loadedTurns++
    startIdx = i
  }
  return { startIdx, loadedTurns, accBytes }
}

/**
 * 从索引快照选窗（设计「窗口选择与单次快照」）：最新窗口从 S.turns 末尾向前选 limitTurns
 * 与 budgetBytes 双预算内的完整 turn；cursor 命中时选该 turn 之前的窗口（cursor turn 只进
 * 校验集合，返回时排除）。首个 turn 豁免字节条件（单 turn 超预算完整放行，与尾读
 * collectRecentTurnEntriesFromTail 共用 exceedsTurnByteBudget 单点判定）；窗口起点恒落在 turn
 * 边界（索引记录天然是边界），单 turn 内 entry 不切分（entry 原子性）。
 */
export function selectIndexWindow(
  snapshot: TurnIndexSnapshot,
  cursorIdx: number | undefined,
  query?: HistoryWindowQuery,
): SelectedIndexWindow {
  const turns = snapshot.turns
  const limitTurns = query?.limitTurns ?? HISTORY_BUDGET.RECENT_TURNS
  const maxBytes = query?.maxBytes ?? HISTORY_BUDGET.MAX_BYTES
  const endIdx = cursorIdx ?? turns.length
  const { startIdx, loadedTurns, accBytes } = pickWindowRange(turns, endIdx, limitTurns, maxBytes)
  if (accBytes > maxBytes) {
    // 单 turn 豁免所致的字节超出（随本改造退役的 Message[] 预算窗口纯函数的 warn 同语义）：
    // 极端 turn 由帧检查兜底，warn 如实暴露。
    console.warn(
      `[history-reader] history budget exceeded by the most recent turn(s): ${accBytes} bytes > ${maxBytes}, released in full per entry atomicity`,
    )
  }
  const windowTurns = turns.slice(startIdx, endIdx)
  const first = windowTurns[0]
  return {
    startIdx,
    windowTurns,
    cursorTurn: cursorIdx !== undefined ? turns[cursorIdx] : undefined,
    startByte: startIdx === 0 ? 0 : (first?.byteOffset ?? snapshot.scannedOffset),
    endByte: cursorIdx !== undefined ? turns[cursorIdx].byteOffset : snapshot.scannedOffset,
    truncated: startIdx > 0,
    loadedTurns,
  }
}

/** 窗口原始 object entry（翻译前的 JSONL 解析产物）：类型恒等于 filterObjectEntries 的
 * 收窄产物，从该出口结构推导而非直引 infra/pi 协议类型——pi 词汇合法持有点规则
 * （runtime-layering.md services 行 + check_pi_type_leak 类型项）要求 services 不点名
 * pi 原始类型标识符；消费链（convertWindowEntries）类型恒等不受影响。 */
type RawWindowEntry = ReturnType<typeof filterObjectEntries>[number]

/**
 * 按字节区间读窗口 entries：区间恒由行边界偏移围成（startByte = 边界行首字节或 0；
 * endByte = 下一边界行首字节或 scannedOffset = 最后完整换行之后），读出内容 = 完整行
 * 集合，无 UTF-8 多字节截断形态。逐行 parse + object 过滤（parseJsonl 可能返回裸数字/
 * 字符串/null，复用 session-history 的 filterObjectEntries 单点）。
 *
 * 畸形行观测（RT-8#13，与尾读/全量读同款）：窗口内半截 JSON 行（崩溃残留等）经
 * makeMalformedLineWatcher warn-once 归因（同文件跨次读只出声一次；watcher 按调用创建，
 * key 含文件路径按文件隔离），不静默丢弃。
 *
 * @returns null = 文件打开 ENOENT（校验通过后的删除竞态窗口——调用方按现有空页语义收尾）；
 *          其余 IO 错误显式上抛（设计 D5 错误分级：主文件故障不伪装成空历史）。
 */
async function readEntriesAtOffset(filePath: string, startByte: number, endByte: number): Promise<RawWindowEntry[] | null> {
  const length = endByte - startByte
  if (length <= 0) return []
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, 'r')
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
  try {
    const buf = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(buf, read, length - read, startByte + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    const text = buf.subarray(0, read).toString('utf-8')
    const malformed = makeMalformedLineWatcher(filePath)
    const entries = filterObjectEntries(text.split('\n').flatMap((line) => (line.trim() === '' ? [] : parseJsonl(line, malformed.opts))))
    malformed.report()
    return entries
  } finally {
    await handle.close()
  }
}
/**
 * session 历史读编排（索引窗口读取）：getHistory 单一数据路径 + 两处尾读兼容分支。
 * per-request inflight 合并保留（W20 Fix-5：同 session 并发调用共享同一 promise，inflight
 * key 含 cursor——同 session 并发翻页不同游标不得共享同一 promise）。
 */
export class SessionHistoryReader {
  /**
   * turn 边界索引 sidecar 存储（reader 构造时自持——组合接线裁定：不在 session-service
   * 重复实例化，删除挂点经本类转发方法到达同一实例；stat 判定/续扫/失效重建/在途合并/
   * 取消标记/内存 LRU 详见 TurnIndexStore）。扫描 port 经构造透传（deps.scanner）。
   */
  private readonly indexStore: TurnIndexStore
  /** per-request inflight（W20 Fix-5 语义保留：finally 清理，无泄漏）。 */
  private readonly inflightGetHistory = new Map<string, Promise<HistoryWindowResult>>()
  /**
   * 扩段耗尽后仍未配对的孤儿 toolResult 累计计数（观测：SI2 之外的数据异常形态归因，
   * 正常 pi 会话恒 0；量级 = 会话数，不随请求增长）。
   */
  private readonly unpairedOrphanToolResults = new Map<string, number>()

  constructor(private readonly deps: SessionHistoryReaderDeps) {
    this.indexStore = new TurnIndexStore({ scanner: deps.scanner })
  }

  /** 校验扫描 port 取用（fail-fast）：未注入即抛（缺省绑定禁在 services 层，见 deps.scanner 注释）。 */
  private scannerPort(): ITurnIndexScanner {
    if (this.deps.scanner === undefined) {
      throw new Error(
        '[history-reader] scanner port 未注入，无法做索引窗口 entryId 校验；恢复动作 = 构造时经 SessionHistoryReaderDeps.scanner 注入' +
          '（组合根 index.ts 装配 infra/pi/turn-index-scanner.js 同名函数；测试直 import 同源装配）',
      )
    }
    return this.deps.scanner
  }

  /**
   * 拉取 session 历史（索引窗口读取；session.history 请求响应字段不变，D4）。
   *
   * 编排（设计「窗口选择与单次快照」）：
   * 1. 定位会话文件：btw 判别命中 → 线文件（线 sessionId 独立索引）；否则 scanSessions
   *    定位主会话文件（miss = 现状静默空，含 subagent 虚拟 id）。
   * 2. ensureFresh 取不可变快照 S（每次请求一次：stat 线索判定复用/续扫/重建 + 在途合并）。
   *    null = 主文件 ENOENT 或会话已真删除（被取消请求）→ 现有空页语义。
   * 3. 零 turn → 尾读兼容分支；cursor 未命中 turns → 尾读 cursor 兼容链。
   * 4. 选窗 → 读有限字节窗口 → 实际 entryId 校验 → 既有转换链（segments sidecar 回填 +
   *    活跃路径裁剪 + endedAt 回填）→ totalTurnsEstimate = S.turns.length（完整索引原始
   *    user turn 总数，含被撤分支——索引就绪后的精确值，不再是尾读提前停止的下界）。
   */
  async getHistory(sessionId: string, query?: HistoryWindowQuery): Promise<HistoryWindowResult> {
    // inflight key 含 cursor（[u6] 语义保留：不同请求页不同；无 cursor 请求共享）
    const inflightKey = query?.cursor ? `${sessionId}::cursor:${query.cursor}` : sessionId
    const inflight = this.inflightGetHistory.get(inflightKey)
    if (inflight) return inflight
    const promise = this.doGetHistory(sessionId, query).finally(() => this.inflightGetHistory.delete(inflightKey))
    this.inflightGetHistory.set(inflightKey, promise)
    return promise
  }

  private async doGetHistory(sessionId: string, query?: HistoryWindowQuery): Promise<HistoryWindowResult> {
    // btw 线判别（注册表纯查询，单次）：命中 = 线文件在手（索引按线 sessionId 独立）；
    // miss = 主会话经 scanSessions 定位（{ force: true } 旁路目录 TTL 缓存——刚落盘 session
    // 在 TTL 窗口内也必须解析到，与既有尾读定位语义一致）。
    const btwFile = this.deps.resolveBtwThreadFile?.(sessionId)
    const filePath = btwFile ?? this.locateMainSessionFile(sessionId)
    if (filePath === undefined) return emptyPage()
    // btw 线文件缺失（注册表 stale / pi 从未 flush）：异常态轻量 warn 留痕 + 空页（与合法
    // 空线区分的既有口径保留；主会话文件缺失由 scanSessions miss 静默空承接，无此 warn）。
    if (btwFile !== undefined && !existsSync(btwFile)) {
      console.warn(
        `[session-history] btw line session file missing for ${sessionId}: ${btwFile} — ` +
        'the line never flushed (pi lazy write) or was removed; send a message to re-establish it, or close the line',
      )
      return emptyPage()
    }
    const snapshot = await this.indexStore.ensureFresh(sessionId, filePath)
    if (snapshot === null) return emptyPage()
    // 零 turn 兼容分支（设计「cursor 未命中」段）：文件可能只有前导段 / 无 user turn /
    // 全 custom entry——走现有尾读兼容分支（计数口径保持现状）；下次请求 ensureFresh 仍先
    // stat 判定，出现首个 user turn 即回到索引路径。
    if (snapshot.turns.length === 0) {
      return await this.tailReadCompat(sessionId, filePath, query)
    }
    // cursor 定位（只在快照 turns 上查——S 是本次读取的一致快照，S 之后的追加不参与）。
    const cursorIdx = query?.cursor !== undefined
      ? snapshot.turns.findIndex((t) => t.entryId === query.cursor)
      : undefined
    if (cursorIdx !== undefined && cursorIdx === -1) {
      // cursor 未命中 turns：不直接判定未知——交现有尾读 cursor 兼容链区分合法非边界
      // entryId 与真正未知（真正未知由该链返回空页 truncated=false）。
      return await this.tailReadCompat(sessionId, filePath, query)
    }
    const sidecar: TailReadSidecarOpts = { segmentsMetadata: await readSegmentsMetadataFile(sessionId) }
    // 中断判定只在未附着且最新窗口启用（游标页与附着会话不判——设计「消息转换」段）；
    // 失配重读沿用同一判定（重建不改变「是否未附着」与「是否最新窗口」两个前提）。
    return await this.readIndexWindow(sessionId, filePath, snapshot, cursorIdx, query, sidecar)
  }

  /** 主会话文件定位（getHistoryTailFromFile 同款 force 扫描语义，单一消费点）。 */
  private locateMainSessionFile(sessionId: string): string | undefined {
    return this.deps.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)?.filePath
  }

  /** 中断判定启用前提（设计「消息转换」段：未附着 ∧ 最新窗口）。 */
  /**
   * 索引窗口读取（选窗 → 读 → 校验 → 转换；失配重建重读一次）。
   *
   * 失配处置（D3/SI4）：校验集合 = 选中窗口 turns + cursor turn（如有），要求实际边界
   * entryId 序列与快照精确相等；边界偏移解析失败、非 user 对象、entryId 不符都按失配。
   * 失配后经 rebuildAfterMismatch 丢弃索引全量重建，用新快照重选重读一次；重建后 cursor
   * 重定位（索引 turns 已变化），重建后仍未命中则交兼容链，重读仍失配显式报错。
   */
  private async readIndexWindow(
    sessionId: string,
    filePath: string,
    snapshot: TurnIndexSnapshot,
    cursorIdx: number | undefined,
    query: HistoryWindowQuery | undefined,
    sidecar: TailReadSidecarOpts,
  ): Promise<HistoryWindowResult> {
    const first = await this.readSelectedWindow(sessionId, filePath, snapshot, selectIndexWindow(snapshot, cursorIdx, query), sidecar)
    if (first.ok) return first.result
    // 失配：丢弃索引、全量重建、按新快照重读一次（设计 D3）
    const fresh = await this.indexStore.rebuildAfterMismatch(
      sessionId,
      filePath,
      `窗口实际 entryId 校验失败: ${first.mismatchDetail}`,
    )
    if (fresh === null) return emptyPage()
    const freshCursorIdx = cursorIdx !== undefined && query?.cursor !== undefined
      ? fresh.turns.findIndex((t) => t.entryId === query.cursor)
      : undefined
    if (freshCursorIdx !== undefined && freshCursorIdx === -1) {
      // 重建后 cursor 仍不在索引：与首次未命中同语义，交尾读 cursor 兼容链
      return await this.tailReadCompat(sessionId, filePath, query)
    }
    const second = await this.readSelectedWindow(
      sessionId,
      filePath,
      fresh,
      selectIndexWindow(fresh, freshCursorIdx === -1 ? undefined : freshCursorIdx, query),
      sidecar,
    )
    if (!second.ok) {
      throw new Error(
        `[history-reader] turn index verification failed twice for ${sessionId} (${second.mismatchDetail}) — ` +
        'session file may have been rewritten incompatibly; recovery = inspect the session file and delete <dataDir>/ext-sessions/<sessionId>/history-index/ to force a clean rebuild',
      )
    }
    return second.result
  }

  /**
   * 单次快照上的一次「校验 + 读窗 + 转换（孤儿驱动有界扩段）」。
   *
   * 校验集合 = 窗口 turns + cursor turn（如有），按 byteOffset 升序（cursor turn 恰在窗口
   * 右侧紧邻位，天然升序——SI4 直接反证，不依赖 stat 元数据）。校验通过后读有限字节窗口进
   * 转换复用出口（AX5）：剥 session header → 活跃路径裁剪（leafId = 窗口末条 entry）→
   * mapSessionEntries + port 翻译 → segments sidecar 回填 → endedAt 回填——与尾读兼容链
   * 同一条 convertWindowEntries 单点，不另写一套消息语义。
   *
   * 跨窗口 toolCall/toolResult 配对（设计 §4.4/§5）：fold 产出孤儿 toolResult（其
   * toolCall 在窗口外更早 turn 段）时，按索引向前扩一个 turn 段重读重 fold——扩段把
   * toolCall 所在 assistant 消息纳入窗口，toolResult 在同一 fold 内配对回填（消息形状与
   * 全量重建路径一致）。扩进的 turn 段边界行同样过实际 entryId 校验（SI4 同源反证）；
   * 有界 ≤ MAX_ORPHAN_TURN_EXTENSIONS 次扩展（连续孤儿链不得退化为全量读），扩到 turn 0
   * 或扩满仍有孤儿 → 按现状丢弃（reducer 已逐条 warn）+ 计数观测。
   *
   * loadedTurns === 0（cursor 为最早 turn：锚前无 turn）与读取期 ENOENT（校验后删除竞态
   * 窗口）都按现有空页语义值返回；失配走 ok=false。
   */
  private async readSelectedWindow(
    sessionId: string,
    filePath: string,
    snapshot: TurnIndexSnapshot,
    selected: SelectedIndexWindow,
    sidecar: TailReadSidecarOpts,
  ): Promise<WindowRead> {
    if (selected.loadedTurns === 0) return { ok: true, result: emptyPage() }
    const records = selected.cursorTurn !== undefined ? [...selected.windowTurns, selected.cursorTurn] : selected.windowTurns
    const verify = await this.scannerPort().verifyTurnBoundaries(filePath, records)
    if (!verify.ok) {
      return { ok: false, mismatchDetail: `turn#${verify.index} ${verify.reason} (expected ${verify.expected})` }
    }
    let startIdx = selected.startIdx
    let orphans: unknown[] = []
    let entries = await readEntriesAtOffset(filePath, selected.startByte, selected.endByte)
    if (entries === null) return { ok: true, result: emptyPage() }
    let messages = convertWindowEntries(entries, this.deps.sessionStore, sidecar.segmentsMetadata, orphans)
    let extensions = 0
    while (orphans.length > 0 && startIdx > 0 && extensions < MAX_ORPHAN_TURN_EXTENSIONS) {
      // 向前扩一个 turn 段：扩进段先过边界 entryId 反证（失配交 rebuildAfterMismatch 重建）
      const prevIdx = startIdx - 1
      const prevVerify = await this.scannerPort().verifyTurnBoundaries(filePath, [snapshot.turns[prevIdx]])
      if (!prevVerify.ok) {
        return { ok: false, mismatchDetail: `extended turn#${prevIdx} ${prevVerify.reason} (expected ${prevVerify.expected})` }
      }
      startIdx = prevIdx
      // 扩到 turn 0 时从 byte 0 读（前导段 header 不单独建记录，与 selectIndexWindow 同口径）
      const startByte = startIdx === 0 ? 0 : snapshot.turns[startIdx].byteOffset
      const reEntries = await readEntriesAtOffset(filePath, startByte, selected.endByte)
      if (reEntries === null) return { ok: true, result: emptyPage() }
      entries = reEntries
      orphans = []
      messages = convertWindowEntries(entries, this.deps.sessionStore, sidecar.segmentsMetadata, orphans)
      extensions++
    }
    if (orphans.length > 0) {
      // 扩段耗尽仍有孤儿：不可配对已由 reducer 逐条 warn，此处补累计计数观测（同会话
      // warn-once，防历史翻页刷屏；计数随读取累计）。
      const total = (this.unpairedOrphanToolResults.get(sessionId) ?? 0) + orphans.length
      this.unpairedOrphanToolResults.set(sessionId, total)
      warnOnce(
        `history-reader:unpaired-tool-results:${sessionId}`,
        `[history-reader] 窗口向前扩段 ${extensions} 次后仍有 ${orphans.length} 条孤儿 toolResult 未配对（该会话累计 ${total} 条），已按现状丢弃: sessionId=${sessionId}。` +
          '恢复动作 = 检查会话 JSONL 中这些 toolCallId 是否存在对应 toolCall entry（写入中断/异常落盘形态）；正常 pi 会话不应出现',
      )
    }
    return {
      ok: true,
      result: {
        messages,
        truncated: startIdx > 0,
        loadedTurns: selected.loadedTurns + extensions,
        // 索引就绪后的精确总数：完整索引原始 user turn 总数（含被撤分支），不再随窗口提前
        // 停止退化为下界（设计「cursor 未命中」段明确改写的字段口径）。
        totalTurnsEstimate: snapshot.turns.length,
      },
    }
  }

  /**
   * 尾读兼容分支（设计保留的两处入口：索引零 turn / cursor 未命中 turns）：与既有离线尾读
   * 同链（tailReadHistory：分块扩窗 / cursorId 定位 / segments sidecar）。
   * 文件路径已在本编排定位（btw 线 = 注册表直给，主会话 = scanSessions），直接文件读，
   * 不重复扫描。
   */
  private async tailReadCompat(
    sessionId: string,
    filePath: string,
    query?: HistoryWindowQuery,
  ): Promise<HistoryWindowResult> {
    const segmentsMetadata = await readSegmentsMetadataFile(sessionId)
    const sidecar: TailReadSidecarOpts = { segmentsMetadata }
    return tailReadHistory(
      filePath,
      this.deps.sessionStore,
      query?.limitTurns ?? HISTORY_BUDGET.RECENT_TURNS,
      { cursor: query?.cursor, maxBytes: query?.maxBytes ?? HISTORY_BUDGET.MAX_BYTES },
      sidecar,
    )
  }

  /**
   * 普通销毁挂点（session-entry-removal 第 12 步经 SessionService 透传，四路删除路径覆盖）：
   * 只清内存索引与计数，不取消文件读取（D5——回调还覆盖 pi 进程退出、强杀与恢复清场，
   * 文件读取继续、被取消才是错误）。
   */
  onSessionDisposed(sessionId: string): void {
    this.indexStore.onSessionDisposed(sessionId)
  }

  /**
   * 真删除专属挂点转发（u-lifecycle 接线：lifecycle.delete / btw closeLine / archive
   * purgeArchive 三入口在整树删除前经 SessionService 调用）：转发内部自持 store——设取消
   * 标记（拒绝在途构建的无 await 提交段落盘，删除后无 history-index 写回残留）+ 清内存
   * LRU（purgeArchive 不经 removeSessionEntry，onSessionDisposed 不会触发，内存索引只能
   * 由本挂点清理）。被取消的 session.history 请求由 store 按 ENOENT 空页语义收尾。
   */
  onSessionDeleted(sessionId: string): void {
    this.indexStore.onSessionDeleted(sessionId)
  }
}

/**
 * 读 segments.json sidecar（runtime 直接读文件，不经 IPC）。
 *
 * IPC 的 writeSegmentsMetadata / readSegmentsMetadata 是 renderer→main 通道，runtime 是独立 Node 进程
 * （不持 electron app 句柄），不能走 IPC。runtime 直接读 getAttachmentsDir(sessionId)
 * （session 存储树域 1，<root>/<sessionId>/attachments/）下的 segments.json。
 *
 * 文件缺失/损坏（JSON parse 失败 / entries 非数组）→ 返回 null（convertWindowEntries 据此
 * 全降级为占位文本，非硬错误）。异步读：统一走异步避免事件循环阻塞。
 *
 * 非法 pi sessionId（如 subagent 三段式虚拟 id `subagent:<main>:<sub>`）同样按「无 sidecar」
 * 返 null：getAttachmentsDir 对非法 id 会 assertPiSessionId fail-fast（路径穿越防线），而本函数
 * 所在的历史读取链对这类 id 的语义是通用链空页静默降级——sidecar 缺失（null）恰是该降级的
 * 一部分，不是可 fail-fast 的异常。
 */
async function readSegmentsMetadataFile(sessionId: string): Promise<SegmentsMetadataFile | null> {
  if (!isPiSessionId(sessionId)) return null
  const filePath = join(getAttachmentsDir(sessionId), 'segments.json')
  try {
    if (!existsSync(filePath)) return null
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as SegmentsMetadataFile
    if (!parsed || !Array.isArray(parsed.entries)) {
      // RT-5#6：结构损坏（合法 JSON 但 entries 非数组）显形——不留痕则「全降级占位文本」不可归因
      warnOnce(
        filePath,
        `[history-reader] segments.json sidecar 结构损坏（entries 非数组），本次全降级为占位文本：${filePath}`,
      )
      return null
    }
    return parsed
  } catch (e) {
    // RT-5#6：读失败不留痕则降级不可归因；ENOENT（existsSync 后 TOCTOU 删除窗口）保持
    // 安静，其余（EACCES/半截 JSON 等）warn 一次（按路径去重）
    if (!isEnoent(e)) {
      warnOnce(
        filePath,
        `[history-reader] segments.json sidecar 读/解析失败，本次全降级为占位文本：${filePath}`,
        e instanceof Error ? e.message : e,
      )
    }
    return null
  }
}
