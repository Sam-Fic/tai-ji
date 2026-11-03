/**
 * turn 边界索引 sidecar 存储（turn-boundary-index 设计 §3.1，D1/D3/D5）。
 *
 * 职责（§5.2 文件改动地图）：sidecar 读写、stat 判定、续扫、重建、在途合并与失配
 * 重建承接（rebuildAfterMismatch 是实际 entryId 校验失败后的重建入口；校验原语
 * verifyTurnBoundaries 在 scanner，窗口选择与消息转换在 history-reader 编排）。
 *
 * 写入点全集（设计「写入点全集与持久化时机」，本域恰三点）：
 * ① turns.json 本体——仅一次完整构建/重建算完之后提交一次；续扫只更新内存与在途
 *   Promise，不落盘（健康追加会话的磁盘索引停留在上次完整构建快照）。
 * ② 固定名 turns.json.tmp——tmp + renameSync 原子范式，hand-rolled 不经过
 *   utils/fs-utils 的 atomicWrite：其 tmpPathOf 恒产 .tmp_<pid>_<seq> 后缀，与读取侧
 *   忽略的固定名对不上（fs-utils.ts:13-17 注释记录固定 .tmp 名被放弃的多进程互踩
 *   顾虑在本域不成立——索引只由 runtime 单进程写入，同文件在途构建已由 Promise
 *   合并串行，且目录创建、tmp 写与 rename 在同一无 await 同步段内完成）。
 * ③ history-index 目录——仅首次提交前的同一同步段 mkdir 一次。
 *
 * 提交段无 await 构造性保证：commitToDisk 从取消复检到 renameSync 全同步执行，
 * onSessionDeleted 的取消标记不能插入复检与提交之间（设计「生命周期与错误」：
 * 不存在检查后行动窗口）。
 *
 * 重建按原因分类计数（设计「增量与失效」+ U1 检查点 11）：getRebuildCounters 输出
 * 单会话 touch 触发重建次数与读取次数，是 SI2 mismatch 归因的采样入口；采样约定值
 * 由监控侧实施期确定（设计 ⏳ 前提），本单元只保证计数存在且可读取。
 *
 * 生命周期挂点（设计「生命周期与错误」）：
 * - onSessionDisposed：只清内存索引与计数，不取消文件读取（回调还覆盖 pi 进程退出、
 *   强杀与恢复清场——文件读取继续，被取消才是错误）。
 * - onSessionDeleted：真删除专属（lifecycle.delete / btw closeLine / purgeArchive 三
 *   调用方在整树删除前触发）——设取消标记（拒绝在途构建的落盘提交）+ 清内存。标记
 *   永不清除：session id 是不复活的 uuidv7 形态，条目为一个字符串键，量级可忽略。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts 注释），
// Node 端从子路径 import（attachment-store 同款）
import { getSessionHistoryIndexFile } from '@taiji/shared/paths'
import type { ITurnIndexScanner } from '../ports/turn-index-scanner.js'
import type { TurnIndexSnapshot, TurnIndexTurnRecord } from '../../infra/pi/turn-index-types.js'
import { parseTurnIndexContent, snapshotToTurnIndexFile, turnIndexFileToSnapshot } from '../../infra/pi/turn-index-types.js'

/** 内存索引 LRU 上限（设计「生命周期与错误」：最近 8 个文件）。 */
export const TURN_INDEX_MEMORY_LIMIT = 8

/** 固定名临时文件后缀（设计②：残留每会话至多 1 个，读取侧忽略、随整树删除回收）。 */
export const TURN_INDEX_TMP_SUFFIX = '.tmp'

/** 索引重建原因（设计「增量与失效」分类：touch / 失配 / 版本不支持 / 结构损坏）。 */
export type TurnIndexRebuildReason = 'touch' | 'mismatch' | 'unsupported-version' | 'corrupted'

/** 单会话可采样计数（SI2 归因：touch 触发重建次数与读取次数的取数入口）。 */
export interface TurnIndexSessionCounters { // oe-exempt:20261103:framework:可采样计数数据契约（SI2 归因取数入口，无变体预期）
  /** ensureFresh 编排次数（在途合并复用不重复计数——一次读取编排一次）。 */
  reads: number
  /** 按原因分类的重建次数。 */
  rebuilds: Partial<Record<TurnIndexRebuildReason, number>>
}

/** 构造依赖（缺省 = 生产实现；测试注入 tmp 目录的路径推导实现隔离）。 */
export interface TurnIndexStoreOptions { // oe-exempt:20261103:framework:构造依赖注入契约（DI 端口先立，组合根装配单实现常态）
  /** sessionId → turns.json 路径推导（缺省 = shared paths SSOT getSessionHistoryIndexFile）。 */
  indexFileOf?: (sessionId: string) => string
  /**
   * turn 边界扫描 port（scanTurnBoundariesForward 文件 IO 原语，C-comm-03 须经 port——
   * infra 实装由组合根 index.ts 装配注入，services 层禁 value import infra 实现，故无缺省
   * 绑定；未注入即用即抛（scannerPort fail-fast），恢复动作 = 构造时注入（测试直 import
   * infra/pi/turn-index-scanner.js 的同名函数装配）。
   */
  scanner?: ITurnIndexScanner
}

/** 主 JSONL stat 快照（stat 判定与最终定格的基准元组）。 */
interface JsonlStat { // oe-exempt:20261103:framework:stat 快照基准元组（store 私有判定形状，非对外扩展点）
  size: number
  mtimeMs: number
}

/** sidecar 读取结果（missing 含「turns.json 缺失而 .tmp 残留」形态：视为无索引）。 */
type SidecarRead =
  | { ok: true; snapshot: TurnIndexSnapshot }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'unsupported-version'; version: unknown }
  | { ok: false; reason: 'corrupted'; detail: string }

/** buildSnapshot 产出（rebuiltFromScratch = 本次产出含从 0 全量扫描 → 允许落盘）。 */
interface BuiltTurnIndex { // oe-exempt:20261103:framework:buildSnapshot 产出契约（store 内部推导中间态，无变体预期）
  snapshot: TurnIndexSnapshot
  rebuiltFromScratch: boolean
}

/** errno code 收窄（JSON.parse/IO 错误形态各异，只按 NodeJS.ErrnoException 约定读 code）。 */
function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class TurnIndexStore {
  /** 内存索引 LRU（Map 插入序即访问序：touchMemory 先删后插维持 recency）。 */
  private readonly memory = new Map<string, TurnIndexSnapshot>()
  /** 同会话在途编排合并（key = sessionId，值 = 完成后自清理的共享 Promise）。 */
  private readonly inflight = new Map<string, Promise<TurnIndexSnapshot | null>>()
  /** 真删除取消标记（onSessionDeleted 设置；提交段同步复检，永不清除）。 */
  private readonly deleted = new Set<string>()
  /** 单会话重建/读取计数（SI2 采样入口；随内存索引同生命周期清理）。 */
  private readonly counters = new Map<string, TurnIndexSessionCounters>()
  private readonly indexFileOf: (sessionId: string) => string
  /** turn 边界扫描 port（构造注入；缺省绑定在组合根——见 TurnIndexStoreOptions.scanner）。 */
  private readonly scanner: ITurnIndexScanner | undefined

  constructor(options?: TurnIndexStoreOptions) {
    this.indexFileOf = options?.indexFileOf ?? ((sessionId) => getSessionHistoryIndexFile(sessionId))
    this.scanner = options?.scanner
  }

  /** 扫描 port 取用（fail-fast）：未注入即抛（缺省绑定禁在 services 层，见 options.scanner 注释）。 */
  private scannerPort(): ITurnIndexScanner {
    if (this.scanner === undefined) {
      throw new Error(
        '[turn-index-store] scanner port 未注入，无法构建索引；恢复动作 = 构造时经 TurnIndexStoreOptions.scanner 注入' +
          '（组合根 index.ts 装配 infra/pi/turn-index-scanner.js 同名函数；测试直 import 同源装配）',
      )
    }
    return this.scanner
  }

  /**
   * 确保索引新鲜并返回不可变快照（设计「窗口选择与单次快照」的 S：右端固定为
   * scannedOffset，快照之后的追加不进入本次读取）。
   *
   * - null 语义：主 JSONL ENOENT（reader 沿用现有空页语义）或会话已真删除（被取消
   *   的请求按同一 ENOENT 空页语义返回空页并记录警告——含删除发生在编排进行中的
   *   形态，返回前复检标记）。
   * - 同会话在途编排合并：并发调用复用同一 Promise（设计「首次建索引」）。
   *
   * @param sessionId 会话 id（主会话用主 id，btw 线用线 id）
   * @param jsonlPath pi session JSONL 绝对路径
   */
  async ensureFresh(sessionId: string, jsonlPath: string): Promise<TurnIndexSnapshot | null> {
    if (this.deleted.has(sessionId)) {
      this.warnCancelled(sessionId)
      return null
    }
    const existing = this.inflight.get(sessionId)
    if (existing !== undefined) return existing
    const task = this.runFresh(sessionId, jsonlPath)
    const guarded = task.finally(() => {
      if (this.inflight.get(sessionId) === guarded) this.inflight.delete(sessionId)
    })
    this.inflight.set(sessionId, guarded)
    const snapshot = await guarded
    // 完成后复检真删除标记：编排期间被 onSessionDeleted 取消的请求不返回半完成结果，
    // 按现有 ENOENT 空页语义收尾（设计「生命周期与错误」）；收尾同时回收内存态——
    // runFresh 内的 touchMemory 不感知删除标记，构建后完成会把条目复活回 LRU（竞态
    // 收尾清理，RL5「内存 LRU 清理」的竞态形态承载点）。
    if (this.deleted.has(sessionId)) {
      this.warnCancelled(sessionId)
      this.dropSessionState(sessionId)
      return null
    }
    return snapshot
  }

  /**
   * 失配重建入口（设计 D3/SI4）：reader 对选中窗口 + cursor turn 做实际 entryId 校验
   * 失败后调用——丢弃索引、全量重建、按新快照重读；仍失配时由 reader 显式报错。
   *
   * @param detail 校验失败原因（进日志，供 SI2 归因之外的人工定位）
   */
  async rebuildAfterMismatch(sessionId: string, jsonlPath: string, detail: string): Promise<TurnIndexSnapshot | null> {
    if (this.deleted.has(sessionId)) {
      this.warnCancelled(sessionId)
      return null
    }
    const existing = this.inflight.get(sessionId)
    if (existing !== undefined) return existing
    console.warn(
      `[turn-index-store] 索引失配 sessionId=${sessionId}: ${detail}；恢复动作 = 已全量重建并刷新落盘，返回新快照`,
    )
    const task = this.runFresh(sessionId, jsonlPath, true)
    const guarded = task.finally(() => {
      if (this.inflight.get(sessionId) === guarded) this.inflight.delete(sessionId)
    })
    this.inflight.set(sessionId, guarded)
    const snapshot = await guarded
    // 完成后复检真删除标记：与 ensureFresh 同语义（不返回半完成结果 + 竞态收尾回收
    // touchMemory 复活的内存条目）。
    if (this.deleted.has(sessionId)) {
      this.warnCancelled(sessionId)
      this.dropSessionState(sessionId)
      return null
    }
    return snapshot
  }

  /** 普通销毁挂点：只清内存态，不取消文件读取（设计 D5）。 */
  onSessionDisposed(sessionId: string): void {
    this.memory.delete(sessionId)
    this.counters.delete(sessionId)
  }

  /** 真删除专属挂点：设取消标记（拒绝在途提交落盘）+ 清内存态（设计 D5）。 */
  onSessionDeleted(sessionId: string): void {
    this.deleted.add(sessionId)
    this.memory.delete(sessionId)
    this.counters.delete(sessionId)
  }

  /** 删除取消路径的请求收尾 warn（设计「被取消的 session.history 请求按 ENOENT 空页并记录警告」）。 */
  private warnCancelled(sessionId: string): void {
    console.warn(
      `[turn-index-store] 会话已真删除，在途索引请求取消，本次历史按空页收尾 sessionId=${sessionId}；` +
        '恢复动作 = 无（真删除后无历史可读，侧栏刷新后不再发起该会话的 history 请求）',
    )
  }

  /** 内存态回收（删除取消的竞态收尾：touchMemory 复活的条目回收 + 计数清理）。 */
  private dropSessionState(sessionId: string): void {
    this.memory.delete(sessionId)
    this.counters.delete(sessionId)
  }

  /** 单会话计数读取（SI2 采样入口；会话未产生读取或已被清理时为 undefined）。 */
  getRebuildCounters(sessionId: string): TurnIndexSessionCounters | undefined {
    const counters = this.counters.get(sessionId)
    if (counters === undefined) return undefined
    return { reads: counters.reads, rebuilds: { ...counters.rebuilds } }
  }

  /** 内存 LRU 是否持有该会话索引（LRU 行为观察入口：上限与驱逐语义断言用）。 */
  hasMemoryIndex(sessionId: string): boolean {
    return this.memory.has(sessionId)
  }

  /** 内存 LRU 当前条目数（上限 8 断言用）。 */
  getMemoryCachedCount(): number {
    return this.memory.size
  }

  /**
   * 编排主体（ensureFresh / rebuildAfterMismatch 共用）。forceMismatchRebuild = 失配
   * 强制重建：跳过全部复用判定，直接从 0 全量。
   */
  private async runFresh(sessionId: string, jsonlPath: string, forceMismatchRebuild = false): Promise<TurnIndexSnapshot | null> {
    this.countersFor(sessionId).reads++
    if (forceMismatchRebuild) {
      this.classifyRebuild(sessionId, 'mismatch')
      return this.buildAndStore(sessionId, jsonlPath, null)
    }
    const st = this.statJsonl(jsonlPath)
    if (st === null) {
      this.memory.delete(sessionId)
      return null
    }
    let base = this.memory.get(sessionId) ?? null
    if (base === null) {
      const sidecar = this.readSidecar(sessionId)
      if (sidecar.ok) {
        base = sidecar.snapshot
      } else if (sidecar.reason !== 'missing') {
        // 版本不支持 / 结构损坏：分类计数（日志已在 readSidecar 就地记录）
        this.classifyRebuild(sessionId, sidecar.reason)
      }
    }
    if (base !== null) {
      if (st.size > base.fileSize) {
        // 追加：从残尾起点（scannedOffset）续扫；结果只进内存不落盘（写入点全集①）
      } else if (st.size < base.fileSize) {
        // 重写缩小：失配全量重建（设计「增量与失效」）
        this.classifyRebuild(sessionId, 'mismatch')
        base = null
      } else if (st.mtimeMs !== base.mtimeMs) {
        // 同尺寸 mtime 变化：touch 全量重建（stat 只是加速判定线索，内容正确性由
        // reader 的实际 entryId 校验把关——本处重建仅按设计登记 touch 归因）
        this.classifyRebuild(sessionId, 'touch')
        base = null
      } else {
        // stat 不变：复用（线索命中；先入内存 LRU 再返回，后续校验由 reader 承担）
        this.touchMemory(sessionId, base)
        return base
      }
    }
    return this.buildAndStore(sessionId, jsonlPath, base)
  }

  /**
   * 构建 + 入内存 + 按需落盘。base = null（首次/重建/失配）从 0 全量；非 null 从其
   * scannedOffset 续扫。落盘条件 = rebuiltFromScratch（完整构建/重建才提交，写入点①）。
   */
  private async buildAndStore(
    sessionId: string,
    jsonlPath: string,
    base: TurnIndexSnapshot | null,
  ): Promise<TurnIndexSnapshot | null> {
    const built = await this.buildSnapshot(jsonlPath, base, () => this.classifyRebuild(sessionId, 'mismatch'))
    if (built === null) {
      this.memory.delete(sessionId)
      return null
    }
    this.touchMemory(sessionId, built.snapshot)
    if (built.rebuiltFromScratch) this.commitToDisk(sessionId, built.snapshot)
    return built.snapshot
  }

  /**
   * 扫描收敛循环（设计「首次建索引」：构建定格一个 stat 快照，完成后若文件已发生
   * 不兼容变化则丢弃本次结果并按新快照重建；若只是追加，先按新 stat 续扫并把追加
   * 纳入本次索引）。收敛判定基准 = 本轮扫描的 observedSize（打开文件时观察尾）：
   * re-stat 相等 → 收敛（残尾稳态 scannedOffset < observedSize 合法保留）；更大 →
   * 扫描期间追加，续扫纳入后重新收敛；更小 → 重写缩小，丢弃本轮按新快照从 0 重建。
   * 收敛依据是 scannedOffset 单调推进的事实（每轮至少纳入新数据），非时间窗兜底。
   */
  private async buildSnapshot(
    jsonlPath: string,
    base: TurnIndexSnapshot | null,
    onShrink: () => void,
  ): Promise<BuiltTurnIndex | null> {
    let resume: { startOffset: number; priorTurns: readonly TurnIndexTurnRecord[] } | undefined =
      base === null ? undefined : { startOffset: base.scannedOffset, priorTurns: base.turns }
    let rebuiltFromScratch = base === null
    const scanner = this.scannerPort()
    for (;;) {
      const scan = await scanner.scanTurnBoundariesForward(jsonlPath, resume)
      if (scan === null) return null
      let merged = scan
      let shrunk = false
      for (;;) {
        const st = this.statJsonl(jsonlPath)
        if (st === null) return null
        if (st.size > merged.observedSize) {
          // 扫描期间追加：把新增字节续扫纳入本次索引，再对新观察尾收敛
          const more = await scanner.scanTurnBoundariesForward(jsonlPath, {
            startOffset: merged.scannedOffset,
            priorTurns: merged.turns,
          })
          if (more === null) return null
          merged = more
          continue
        }
        if (st.size < merged.observedSize) {
          // 扫描期间文件被重写缩小：丢弃本轮全部结果，按新快照从 0 重建（失配）
          onShrink()
          rebuiltFromScratch = true
          shrunk = true
          break
        }
        return {
          snapshot: {
            fileSize: st.size,
            mtimeMs: st.mtimeMs,
            scannedOffset: merged.scannedOffset,
            turns: merged.turns,
          },
          rebuiltFromScratch,
        }
      }
      if (shrunk) resume = undefined
    }
  }

  /**
   * 持久提交（写入点①②③）。从取消复检到 renameSync 全程无 await——onSessionDeleted
   * 的标记不可能插入复检与提交之间；写失败只损失加速能力，warn 不抛（历史已由内存
   * 快照返回，下次读取自动重试持久化）。
   */
  private commitToDisk(sessionId: string, snapshot: TurnIndexSnapshot): void {
    if (this.deleted.has(sessionId)) return
    const finalPath = this.indexFileOf(sessionId)
    const tmpPath = finalPath + TURN_INDEX_TMP_SUFFIX
    try {
      mkdirSync(dirname(finalPath), { recursive: true })
      writeFileSync(tmpPath, JSON.stringify(snapshotToTurnIndexFile(snapshot)))
      renameSync(tmpPath, finalPath)
    } catch (error) {
      // 降级策略（设计 D5）：索引是辅助加速副本，写失败不阻断 P0 历史查看——快照已在
      // 内存返回本次请求，warn 后由下次读取自然重试持久化，不自动循环重试。
      console.warn(
        `[turn-index-store] 索引落盘失败 sessionId=${sessionId} path=${finalPath}: ${errorMessage(error)}；` +
          '恢复动作 = 无需处理，本次历史已由内存索引返回，下次读取自动重试持久化',
      )
    }
  }

  /** 主 JSONL stat；ENOENT → null（空页语义），其余错误显式上抛（设计 D5 错误分级）。 */
  private statJsonl(jsonlPath: string): JsonlStat | null {
    try {
      const st = statSync(jsonlPath)
      return { size: st.size, mtimeMs: st.mtimeMs }
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return null
      throw error
    }
  }

  /** sidecar 读取 + guard 收窄；反常形态就地 warn（含路径与恢复动作），missing 含残留形态。 */
  private readSidecar(sessionId: string): SidecarRead {
    const path = this.indexFileOf(sessionId)
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return { ok: false, reason: 'missing' }
      console.warn(
        `[turn-index-store] 索引读取失败 path=${path}: ${errorMessage(error)}；恢复动作 = 已按无索引处理，本次读取重建`,
      )
      return { ok: false, reason: 'missing' }
    }
    const parsed = parseTurnIndexContent(raw)
    if (parsed.ok) return { ok: true, snapshot: turnIndexFileToSnapshot(parsed.index) }
    if (parsed.reason === 'unsupported-version') {
      console.warn(
        `[turn-index-store] 索引版本不支持 path=${path} version=${String(parsed.version)}；` +
          '恢复动作 = 已按当前版本全量重建并重新落盘',
      )
    } else {
      console.warn(
        `[turn-index-store] 索引结构损坏 path=${path}: ${parsed.detail}；恢复动作 = 已全量重建并重新落盘`,
      )
    }
    return parsed
  }

  private countersFor(sessionId: string): TurnIndexSessionCounters {
    let counters = this.counters.get(sessionId)
    if (counters === undefined) {
      counters = { reads: 0, rebuilds: {} }
      this.counters.set(sessionId, counters)
    }
    return counters
  }

  private classifyRebuild(sessionId: string, reason: TurnIndexRebuildReason): void {
    const counters = this.countersFor(sessionId)
    counters.rebuilds[reason] = (counters.rebuilds[reason] ?? 0) + 1
  }

  /** 内存 LRU 写入（先删后插维持访问序；超上限驱逐最旧条目——驱逐只损失一次 sidecar 读取）。 */
  private touchMemory(sessionId: string, snapshot: TurnIndexSnapshot): void {
    this.memory.delete(sessionId)
    this.memory.set(sessionId, snapshot)
    while (this.memory.size > TURN_INDEX_MEMORY_LIMIT) {
      const oldest = this.memory.keys().next()
      if (oldest.done === true) break
      this.memory.delete(oldest.value)
    }
  }
}
