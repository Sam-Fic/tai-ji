/**
 * fence 高亮 Worker 客户端（批3 B-worker）：主线程侧协议 + 降级状态机。
 *
 * 状态机：idle（未建 worker）→ ready（已建）→ degraded（worker 不可用，页生命周期内
 * 永久回退主线程同步高亮）。degraded 触发面 = 确定性事件，**无任何墙钟判死**
 * （ADR-0190）：① typeof Worker 缺席（vitest/happy-dom 等）；② new Worker 同步抛错；
 * ③ worker error / messageerror 事件（CSP 被外部策略拦、脚本加载失败）；
 * ④ 单 job jobError（该 job 单独回退，不 degraded 全局）。
 *
 * 取消语义（两态，见 docs/tp-design-batch3.md 长叶节）：
 * - cancelShikiHighlightGroup(group)：组 = 一条消息的渲染链（增量 cache 对象）。
 *   调用点 = 组件卸载（切 session 整树重建）——该组全部在途渲染的结果都不会被消费，
 *   故 settle 取消哨兵：渲染继续走完但不做同步补高亮（不为已丢弃结果烧主线程），
 *   fence 规则缓存未命中落纯文本降级（该 cache 随组件卸载死亡，不污染任何活缓存）。
 * - cancelAllShikiHighlights()：页面隐藏（visibilitychange→hidden）。在途渲染的结果
 *   **仍会被消费**（组件还活着），故 settle null → 主线程同步补高亮：隐藏期主线程
 *   空闲，成本不可见，且高亮不丢、活缓存不被纯文本污染。
 *
 * 内存：worker 页生命周期内常驻复用（回收再建 = 重复付 shiki 初始化成本）；组登记表
 * 是 WeakMap<组对象, Set<jobId>>，随组对象死亡自动回收。
 */
import type { HighlightJob, HighlightWorkerInbound, HighlightWorkerOutbound } from './shiki-highlight-core'

/** 取消哨兵：resolveFenceHighlights 对该 job 返回它 = 「消费方已卸载，放弃而非回退」 */
export const HIGHLIGHT_CANCELLED = Symbol('shiki-highlight-cancelled')

/** 单 job 解析结果：HTML 串 = worker 产物；null = 需主线程同步回退；哨兵 = 已取消放弃 */
export type HighlightResolution = string | null | typeof HIGHLIGHT_CANCELLED

interface PendingEntry {
  group: object
  settle: (value: HighlightResolution) => void
}

let worker: Worker | null = null
let degraded = false
let visibilityBound = false

/** jobId → 在途登记（结果关联 / 取消结算） */
const pending = new Map<number, PendingEntry>() // taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记 §4 ⑧ 2026-11-26）：在途 job 结算表
/** 组对象 → 在途 jobId 集合（WeakMap：组随消息组件死亡自动回收） */
const groupJobs = new WeakMap<object, Set<number>>() // taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记 §4 ⑧ 2026-11-26）：取消组登记表
let nextJobId = 1

/**
 * 批量解析 fence 高亮，按入参顺序返回逐 job 结果（id 由客户端内部分配，调用方无感）。
 * worker 可用 → 一批 job 一次往返，逐 job 结算；不可用 / 被取消 / jobError → 按调用方
 * 语义返回 null 或取消哨兵（见文件头两态取消）。
 *
 * @param group 取消组令牌（增量渲染传 cache 对象；一次性渲染不传）
 */
export async function resolveFenceHighlights(
  jobs: ReadonlyArray<{ code: string; lang: string }>,
  group?: object,
): Promise<HighlightResolution[]> {
  if (jobs.length === 0) return []

  if (degraded || typeof Worker === 'undefined') {
    return jobs.map(() => null)
  }

  if (worker === null) {
    try {
      // new URL 必须与 new Worker 同行内联：Vite worker 插件只识别该形态，
      // 抽成变量会令打包态解析到不存在的 .ts 资产路径（dev 态碰巧可服）。
      worker = new Worker(new URL('./shiki-highlight-worker.ts', import.meta.url), { type: 'module' })
    } catch (err) {
      degrade('worker construction threw', err)
      return jobs.map(() => null)
    }
    bindWorker(worker)
    ensureVisibilityHook()
  }

  const w = worker
  const groupKey = group ?? FALLBACK_GROUP
  let ids = groupJobs.get(groupKey)
  if (ids === undefined) {
    ids = new Set()
    groupJobs.set(groupKey, ids)
  }
  const assigned: HighlightJob[] = []
  const settlements: Promise<HighlightResolution>[] = []
  for (const job of jobs) {
    const id = nextJobId++
    let settleFn: (value: HighlightResolution) => void = () => {}
    const settlement = new Promise<HighlightResolution>((resolve) => { settleFn = resolve })
    pending.set(id, { group: groupKey, settle: settleFn })
    ids.add(id)
    assigned.push({ id, code: job.code, lang: job.lang })
    settlements.push(settlement)
  }
  try {
    w.postMessage({ type: 'jobs', jobs: assigned } satisfies HighlightWorkerInbound)
  } catch (err) {
    degrade('worker postMessage threw', err)
  }
  // settlement promise 只 resolve 不 reject（构造即仅暴露 resolve，单 job 无失败态），
  // allSettled 保持「单 job 异常不炸整批」的部分降级语义（rejected → null 主线程同步回退）。
  const settled = await Promise.allSettled(settlements)
  return settled.map((r) => (r.status === 'fulfilled' ? r.value : null))
}

/** 未传组的调用方共享的占位组（不可取消；组登记随进程，条目为空集） */
const FALLBACK_GROUP = {}

/** 取消一组的在途 job（组件卸载路径）：结算取消哨兵 + 通知 worker 丢弃未开始的 */
export function cancelShikiHighlightGroup(group: object): void {
  const ids = groupJobs.get(group)
  if (ids === undefined || ids.size === 0) return
  for (const id of ids) {
    const entry = pending.get(id)
    if (entry) {
      pending.delete(id)
      entry.settle(HIGHLIGHT_CANCELLED)
    }
  }
  groupJobs.delete(group)
  if (worker !== null && !degraded) {
    try {
      worker.postMessage({ type: 'cancel', ids: [...ids] } satisfies HighlightWorkerInbound)
    } catch (err) {
      /* worker 已死：degrade 由 error 事件接管，此处不重复 degrade，仅留痕 */
      console.warn('[shiki-highlight] cancel postMessage failed (degrade follows via error event):', err)
    }
  }
}

/** 取消全部在途 job（页面隐藏路径）：结算 null → 在途渲染回退主线程同步高亮 */
export function cancelAllShikiHighlights(): void {
  if (pending.size === 0) return
  const ids = [...pending.keys()]
  for (const [id, entry] of pending) {
    pending.delete(id)
    entry.settle(null)
  }
  if (worker !== null && !degraded) {
    try {
      worker.postMessage({ type: 'cancel', ids } satisfies HighlightWorkerInbound)
    } catch (err) {
      /* 同上：degrade 由 error 事件接管，此处不重复 degrade，仅留痕 */
      console.warn('[shiki-highlight] cancelAll postMessage failed (degrade follows via error event):', err)
    }
  }
}

function bindWorker(w: Worker): void {
  w.addEventListener('message', (event: MessageEvent<HighlightWorkerOutbound>) => {
    const msg = event.data
    if (msg.type === 'result') {
      settlePending(msg.id, msg.html)
      return
    }
    if (msg.type === 'jobError') {
      // 单 job 失败不 degraded 全局：该 job 回退主线程同步高亮，其余照常走 worker
      console.error('[shiki-highlight] worker job failed, fallback to main-thread sync highlight:', msg.message)
      settlePending(msg.id, null)
      return
    }
    // log：worker 侧成本（init / 每 job 耗时）转发出声——验收探针经此采集登记
    if (msg.type === 'log') {
      if (msg.level === 'error') console.error('[shiki-worker]', msg.msg)
      else if (msg.level === 'warn') console.warn('[shiki-worker]', msg.msg)
      else console.log('[shiki-worker]', msg.msg)
    }
  })
  w.addEventListener('error', (event) => {
    degrade('worker error event', event.message || event.type)
  })
  w.addEventListener('messageerror', () => {
    degrade('worker messageerror', 'structured clone failed')
  })
}

/** 结算一个在途 job 并清理组登记 */
function settlePending(id: number, value: HighlightResolution): void {
  const entry = pending.get(id)
  if (entry === undefined) return // 已取消/已结算（迟到结果直接忽略）
  pending.delete(id)
  const ids = groupJobs.get(entry.group)
  if (ids !== undefined) {
    ids.delete(id)
    if (ids.size === 0) groupJobs.delete(entry.group)
  }
  entry.settle(value)
}

/** 永久降级：出声（2026-08 CSP 事故教训：静默吞错不可查）+ 终止 worker + 在途全部回退同步 */
function degrade(reason: string, detail: unknown): void {
  if (degraded) return
  degraded = true
  console.error(`[shiki-highlight] worker unavailable (${reason}), fallback to main-thread sync highlight:`, detail)
  const w = worker
  worker = null
  if (w !== null) w.terminate()
  for (const [id, entry] of pending) {
    pending.delete(id)
    entry.settle(null)
  }
}

/** 页面隐藏 → 取消全部在途（在途渲染回退同步；隐藏期主线程空闲，成本不可见） */
function ensureVisibilityHook(): void {
  if (visibilityBound || typeof document === 'undefined') return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') cancelAllShikiHighlights()
  })
}
