/**
 * reattach 编排（docs/architecture/crash-forensics-and-watchdog.md §3.3 D3，实施单元 u5）。
 *
 * 职责：runtime 启动（WS listen 后独立并行任务，组合根 index.ts 挂载）消费
 * runtime-checkpoint 快照，恢复崩溃前的活跃 session。与 startup-background-init
 * 串行链解耦（不阻塞链尾 reaper 启动）；唯一强制时序点是「live 孤儿未收割完不 spawn」
 * （收割等待直接 await 该 promise——收割对象是已死进程的事实判定，无时间上界，
 * 架构 P9 消灭双持瞬态）。
 *
 * 流程（D3 时序，时间过滤/高水位延迟/收割上界已随时间机制清查删除）：读 checkpoint →
 * 全量候选 → 等孤儿收割完成（事实判定，一次性尝试）→ 分批 restore（并发 2，逐 session
 * 容错）→ 全部尝试完删除 checkpoint 文件。
 *
 * **可信度判定不在本模块（与 D3 原文的分工差异，机制等价）**：D3 原文把「判可信度」写进
 * runtime 启动流程，u4 落地时该判定归 main 侧冷启动块（marker 属主——main 独占
 * consume→判→写三步序，runtime 侧读 marker 会与 main 写序竞态）。clean-exit 残留已在
 * runtime 启动前被 isolateStaleCheckpoint 隔离 ⟹ 本编排读到 checkpoint 即 trusted-unclean，
 * 无需重复校验 unclean 信号。
 *
 * **errs 方向（排查口径）**：恢复失败逐 session 记 reattach-skipped（restore-failed /
 * file-missing），退化 lazy，不冒进 spawn。
 *
 * **checkpoint 删除（D3 契约 1 删除属主第二路）**：全部尝试完后无条件删（含全跳过/全
 * 失败形态）；删除失败 best-effort（残留由 main 退出链删除 + 下次启动隔离双通道收敛）。
 */
import { existsSync, unlinkSync } from 'node:fs'
import type { CrashJournalWriter } from '@taiji/shared'
import { getCrashJournal } from '../infra/crash-journal.js'
import {
  getRuntimeCheckpointStore,
  type RuntimeCheckpointEntry,
  type RuntimeCheckpointStore,
} from './session/runtime-checkpoint.js'

/** restore 并发上限（设计 D3「分批 reattach，并发上限 2」，spawn 峰值实测检查点初值）。 */
export const DEFAULT_REATTACH_CONCURRENCY = 2

/** reattach-skipped reason：staleness guard 命中（filePath 未知或会话文件已缺失）。 */
export const REATTACH_SKIP_STALENESS = 'file-missing'

/** reattach-skipped reason：restore 执行失败（spawn/附着异常，含未配模型等运行态错误）。 */
export const REATTACH_SKIP_RESTORE_FAILED = 'restore-failed'

/** reattach-skipped reason 词表（开放枚举的登记清单，非校验门禁）。 */
export const REATTACH_SKIP_REASONS = [
  REATTACH_SKIP_STALENESS,
  REATTACH_SKIP_RESTORE_FAILED,
] as const

/** reattach 编排的外部依赖（组合根注入；全部窄接口）。 */
export interface StartupReattachDeps {
  /**
   * 恢复执行（spawn + 附着）：生产 = sessionService.restoreSession（lifecycle
   * restoreSession → registerSession 汇聚点，onSessionRegistered 挂点随之触发）。
   */
  restore: (sessionId: string) => Promise<unknown>
  /**
   * 等待「live 孤儿收割完成」（startup-background-init 的收殓链 settle，含 5s 调度宽限）。
   * 契约：永不 reject（内部全 catch）。live 孤儿未收割完不 spawn（P9 消灭双持）。
   */
  waitForOrphanReap: () => Promise<void>
}

export interface StartupReattachOptions {
  /** journal writer（reattach-skipped 事件）；缺省 getCrashJournal() 单例。 */
  journal?: CrashJournalWriter
  /** checkpoint 读侧与删除路径；缺省 getRuntimeCheckpointStore() 单例。 */
  checkpoint?: RuntimeCheckpointStore
  /** 会话文件存在性查询注入（测试替身）；缺省 fs existsSync。 */
  fileExists?: (path: string) => boolean
  /** restore 并发上限；缺省 2（D3）。 */
  restoreConcurrency?: number
}

/** 编排结果（组合根/测试断言范围）。 */
export interface ReattachReport {
  /** 是否读到 checkpoint（false = clean/corrupt，编排零动作）。 */
  checkpointFound: boolean
  /** 进入恢复的 session id（按 checkpoint 顺序，全量候选）。 */
  candidates: string[]
  /** restore 成功的 session id。 */
  restored: string[]
  /** 跳过明细（逐 session 一条 reattach-skipped journal 行对应一项）。 */
  skipped: Array<{ sessionId: string; reason: string }>
  /** checkpoint 主文件是否已删除（D3 契约 1 第二路）。 */
  checkpointDeleted: boolean
}

/**
 * reattach 编排上下文：options/依赖的解析结果（缺省值解析集中于此，主函数只剩编排序）。
 */
interface ReattachContext {
  deps: StartupReattachDeps
  checkpoint: RuntimeCheckpointStore
  journal: CrashJournalWriter
  concurrency: number
  fileExists: (path: string) => boolean
}

/** 解析 options 缺省值与依赖引用。 */
function createReattachContext(deps: StartupReattachDeps, options: StartupReattachOptions): ReattachContext {
  return {
    deps,
    concurrency: Math.max(1, options.restoreConcurrency ?? DEFAULT_REATTACH_CONCURRENCY),
    checkpoint: options.checkpoint ?? getRuntimeCheckpointStore(),
    journal: options.journal ?? getCrashJournal(),
    fileExists: options.fileExists ?? ((path: string) => existsSync(path)),
  }
}

function emptyReattachReport(): ReattachReport {
  return {
    checkpointFound: false,
    candidates: [],
    restored: [],
    skipped: [],
    checkpointDeleted: false,
  }
}

/**
 * 编排期活跃标记（session-cold-switch-perf §3.3-6 让位检查的查询点）：预热槽补位 spawn
 * 与本编排期（checkpoint 读 → 孤儿收割等待 → 分批恢复）重叠时推迟。计数形态防重入误清；
 * runStartupReattach 零动作早退（无 checkpoint）同样瞬时进出，不产生恒 busy 误让位。
 */
let activeOrchestrations = 0

/** startup-reattach 编排是否正在执行（预热槽补位的让位检查消费点）。 */
export function isStartupReattachActive(): boolean {
  return activeOrchestrations > 0
}

/**
 * 执行 reattach 编排（一次性；组合根 listen 后 fire-and-forget 调用）。
 * 本函数不抛（内部逐步容错），返回编排报告供日志与测试断言。
 */
export async function runStartupReattach(
  deps: StartupReattachDeps,
  options: StartupReattachOptions = {},
): Promise<ReattachReport> {
  activeOrchestrations++
  try {
    return await runStartupReattachOrchestrating(deps, options)
  } finally {
    activeOrchestrations--
  }
}

async function runStartupReattachOrchestrating(
  deps: StartupReattachDeps,
  options: StartupReattachOptions,
): Promise<ReattachReport> {
  const ctx = createReattachContext(deps, options)
  const report = emptyReattachReport()

  // ① 读 checkpoint（staleness 第 0 步）：undefined = 无快照（clean exit 已删 / 首次启动，
  //    常态）或损坏已隔离退 lazy（u4 read() 契约）——零动作，冷启动维持 lazy（A3b）。
  const snapshot = ctx.checkpoint.read()
  if (!snapshot) return report
  report.checkpointFound = true

  // ② 全量候选（逐 entry 建映射；全部 checkpoint 内 session 都尝试恢复）。
  const entryById = new Map<string, RuntimeCheckpointEntry>()
  for (const entry of snapshot.sessions) {
    entryById.set(entry.piSessionId, entry)
    report.candidates.push(entry.piSessionId)
  }

  // ③ 零候选 = 零尝试：直接删 checkpoint（A6「全跳过也删」的零尝试形态）。
  if (report.candidates.length === 0) {
    report.checkpointDeleted = deleteCheckpointFile(ctx.checkpoint)
    return report
  }

  // ④ 等孤儿收割完成（事实判定，无时间上界）；收割 promise 意外 reject（契约永不 reject
  //    的防御兜底）时完成「全部候选跳过 + 删 checkpoint」的终态处理，返回 false 直接收束。
  if (!(await waitForOrphanReap(ctx, report))) return report

  // ⑤ 分批 restore（并发上限；Promise.allSettled 结构性保证单 session 失败不阻断批次，
  //    逐 session 容错在 restoreOne 内部收敛——allSettled 是第二道结构防线）。
  await restoreCandidates(ctx, entryById, report)

  // ⑥ 全部尝试完删除 checkpoint（D3 契约 1 第二路——无条件删，含全跳过/全失败形态）。
  report.checkpointDeleted = deleteCheckpointFile(ctx.checkpoint)
  console.log(`[reattach] done: restored=${report.restored.length} skipped=${report.skipped.length} checkpointDeleted=${report.checkpointDeleted}`)
  return report
}

/**
 * ④ 等待孤儿收割完成（收割链含 5s 调度宽限——live 孤儿未收割完不 spawn）。
 *
 * 收割 promise reject（契约外形态）时本函数完成全部候选的终态处理：逐候选记
 * reattach-skipped（restore-failed 同向的退化 lazy）+ 删 checkpoint（A6 语义）。
 */
async function waitForOrphanReap(ctx: ReattachContext, report: ReattachReport): Promise<boolean> {
  try {
    await ctx.deps.waitForOrphanReap()
    return true
  } catch (e: unknown) {
    // 收割 promise 契约永不 reject；防御性 reject 按「未收割」处理（宁 lazy 不双持）。
    console.warn('[reattach] orphan reap wait rejected unexpectedly, skipping reattach:', e)
    for (const sessionId of report.candidates) {
      appendSkip(ctx.journal, sessionId, REATTACH_SKIP_RESTORE_FAILED,
        'orphan reap chain rejected unexpectedly; all candidates fall back to lazy (never double-spawn)')
      report.skipped.push({ sessionId, reason: REATTACH_SKIP_RESTORE_FAILED })
    }
    // 跳过 = 本实例内全部尝试已终态：删 checkpoint（A6 语义）。
    report.checkpointDeleted = deleteCheckpointFile(ctx.checkpoint)
    return false
  }
}

/** ⑤ 分批 restore（并发上限 = ctx.concurrency，缺省 2；逐批 allSettled）。 */
async function restoreCandidates(
  ctx: ReattachContext,
  entryById: Map<string, RuntimeCheckpointEntry>,
  report: ReattachReport,
): Promise<void> {
  for (let i = 0; i < report.candidates.length; i += ctx.concurrency) {
    const batch = report.candidates.slice(i, i + ctx.concurrency)
    await Promise.allSettled(batch.map((sessionId) => restoreOne({
      sessionId,
      entry: entryById.get(sessionId),
      deps: ctx.deps,
      journal: ctx.journal,
      fileExists: ctx.fileExists,
      report,
    })))
  }
}

/** 单 session 恢复（staleness guard → restore；失败记事件，不向上抛）。 */
async function restoreOne(input: {
  sessionId: string
  entry: RuntimeCheckpointEntry | undefined
  deps: StartupReattachDeps
  journal: CrashJournalWriter
  fileExists: (path: string) => boolean
  report: ReattachReport
}): Promise<void> {
  const { sessionId, entry, deps, journal, fileExists, report } = input
  try {
    // staleness guard（D3 契约 2，消费侧职责）：filePath=null（pi 延迟写入窗口，快照未知）
    // 或会话文件已缺失（用户删除/清理）→ 跳过 + 记事件（逐 session 一条）。
    if (!entry?.filePath || !fileExists(entry.filePath)) {
      const detail = entry?.filePath
        ? `session file missing on disk: ${entry.filePath} (deleted by user or cleaned)`
        : 'checkpoint filePath unknown (pi delayed-write window before first flush)'
      appendSkip(journal, sessionId, REATTACH_SKIP_STALENESS, detail)
      report.skipped.push({ sessionId, reason: REATTACH_SKIP_STALENESS })
      return
    }
    await deps.restore(sessionId)
    report.restored.push(sessionId)
  } catch (e: unknown) {
    // 逐 session 容错（D3「失败走既有 lazy，不阻断」）：记录事件后继续其余候选。
    const message = e instanceof Error ? e.message : String(e)
    appendSkip(journal, sessionId, REATTACH_SKIP_RESTORE_FAILED, `restore failed: ${message}`)
    report.skipped.push({ sessionId, reason: REATTACH_SKIP_RESTORE_FAILED })
  }
}

/** 记一条 reattach-skipped journal 行（runtime 层，字段集 = schema D1；best-effort）。 */
function appendSkip(journal: CrashJournalWriter, sessionId: string, reason: string, detailDigest: string): void {
  journal.append({
    layer: 'runtime',
    event: 'reattach-skipped',
    sessionId,
    reason,
    detailDigest,
  })
}

/**
 * 删除 checkpoint 主文件（D3 契约 1 删除属主第二路——删除属主在 main 退出链与本编排，
 * runtime 自身退出路径一律不删）。ENOENT = 已删/竞态删除（非失败）；其余失败 best-effort
 * 记日志，残留交 main 退出链与下次启动隔离双通道收敛。
 */
function deleteCheckpointFile(checkpoint: RuntimeCheckpointStore): boolean {
  try {
    unlinkSync(checkpoint.checkpointPath)
    return true
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    console.warn(`[reattach] checkpoint delete failed (${checkpoint.checkpointPath}):`, e)
    return false
  }
}
