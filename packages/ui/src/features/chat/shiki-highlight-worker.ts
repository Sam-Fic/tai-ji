/**
 * fence 高亮 Web Worker（批3 B-worker：fence 闭合的 shiki 高亮移出主线程）。
 *
 * 存在理由（GLM 对抗审查 C4/M6/D6/F3）：shiki 语法高亮的突发发生在 fence 闭合时刻
 * （流式中途、全文约 60% 处），单次实测 1.16/3.15/3.26s 主线程硬冻结；分帧 tokenize
 * 对单块无效、可视区优先粒度不匹配（virtua 虚拟化粒度是 turn），Worker 是唯一与块
 * 大小无关的解。主线程发「代码文本+语言」，本 worker 跑 codeToHtml 回填 HTML。
 *
 * 协议（类型 SSOT = ./shiki-highlight-core）：
 *   入：{type:'jobs',jobs:[{id,code,lang}]} 一批 fence；{type:'cancel',ids} 丢弃未开始的
 *   出：{type:'result',id,html} 逐 job 回填；{type:'jobError',id,message}；{type:'log'}
 *
 * 设计约束：
 * - **无 ready 握手**：job 消息到达即入内部队列，highlighter 惰性初始化（首条 jobs
 *   触发）期间排队等待——主线程无需状态机区分 starting/ready。
 * - **串行处理**：单线程天然排队，多 fence 连续闭合 = 一批 job 一次往返、按序高亮。
 * - **取消只丢未开始的**：codeToHtml 是同步 API，运行中的 job 无法中断——其结果照常
 *   回传，主线程对已取消 id 忽略（客户端pending 表已删）。这是同步 API 的物理边界，
 *   登记为设计已知限制（docs/tp-design-batch3.md 非功能节）。
 * - **无任何墙钟**：不设超时/判死（ADR-0190）；失败只抛 jobError 由主线程降级。
 * - **init 失败 = worker 拒绝态**：highlighter 惰性初始化若异步失败（构造成功但 init
 *   抛错），队列全部 job 逐个 jobError（主线程逐 job 同步回退），后续到达的 jobs 亦
 *   立即 jobError、不重试 init——无 catch 时 rejection 抛出 pump → void pump() =
 *   unhandled rejection，主线程 error/messageerror 事件均不触发，pending 永不
 *   settle → renderMarkdown 挂死（分支审查 dmg-r1-2）。
 * - **成本出声**：init 与每 job 耗时经 log 消息回主线程 console，进验收对比表
 *   （worker 侧成本登记，G5）。
 */
import type { HighlighterCore } from 'shiki/core'
import type { HighlightJob, HighlightWorkerInbound, HighlightWorkerOutbound } from './shiki-highlight-core'
import { createShikiHighlighter, highlightWithHighlighter } from './shiki-highlight-core'

/** worker 全局的窄类型（避免 lib.dom 的 Window 签名干扰；本文件只在 worker 上下文运行） */
interface WorkerContext {
  postMessage(message: HighlightWorkerOutbound): void
  onmessage: ((event: MessageEvent<HighlightWorkerInbound>) => void) | null
}
const ctx = self as unknown as WorkerContext

const post = (msg: HighlightWorkerOutbound): void => ctx.postMessage(msg)

let hl: HighlighterCore | null = null
let starting: Promise<HighlighterCore> | null = null
/** init 异步失败后的 worker 拒绝态：null = 未失败；非空 = 失败 message（后续 jobs 立即逐 job jobError，不重试 init） */
let initFailed: string | null = null
/** 已取消但尚未处理的 job id（处理时删除；运行中的 job 取消由主线程侧忽略结果） */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记 §4 ⑧ 2026-11-26）：worker 内取消跳过集合
const cancelled = new Set<number>()
/** 迟到取消残留条目的封顶：超限整体清空（无正确性影响，说明见 onmessage cancel 分支注释） */
const CANCELLED_SET_CLEAR_THRESHOLD = 256
const queue: HighlightJob[] = []
let pumping = false

ctx.onmessage = (event) => {
  const msg = event.data
  if (msg.type === 'cancel') {
    for (const id of msg.ids) cancelled.add(id)
    // 取消集合封顶保护：运行中 job 的迟到取消会残留条目（主线程已忽略其结果），
    // 超限即清空——最坏后果是某个已取消 job 白跑一次，结果被主线程丢弃，无正确性影响。
    if (cancelled.size > CANCELLED_SET_CLEAR_THRESHOLD) cancelled.clear()
    return
  }
  if (msg.type === 'jobs') {
    queue.push(...msg.jobs)
    void pump()
  }
}

/** 串行泵干队列：惰性初始化 highlighter（一次/worker 生命周期）后逐 job 高亮回传 */
async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    if (hl === null && initFailed !== null) {
      failQueuedJobs(initFailed)
      return
    }
    if (hl === null) {
      const t0 = performance.now()
      try {
        hl = await (starting ??= createShikiHighlighter())
      } catch (err) {
        // init 异步失败：复位 starting（释放 rejected promise）+ 进入拒绝态（不重试 init，
        // 防 rejected promise 反复抛出），队列全部 job 逐个 jobError——复用既有协议，
        // 客户端逐 job settle null → 主线程同步回退，零新增状态机。
        starting = null
        initFailed = err instanceof Error ? err.message : String(err)
        post({ type: 'log', level: 'error', msg: `highlighter init failed: ${initFailed}` })
        failQueuedJobs(initFailed)
        return
      }
      post({ type: 'log', level: 'log', msg: `highlighter init ${Math.round(performance.now() - t0)}ms` })
    }
    while (queue.length > 0) {
      const job = queue.shift()
      if (job === undefined) break
      if (cancelled.delete(job.id)) continue
      const t = performance.now()
      try {
        post({ type: 'result', id: job.id, html: highlightWithHighlighter(hl, job.code, job.lang) })
      } catch (err) {
        post({ type: 'jobError', id: job.id, message: err instanceof Error ? err.message : String(err) })
      }
      post({ type: 'log', level: 'log', msg: `job ${job.id} (${job.lang || 'text'}) ${Math.round(performance.now() - t)}ms` })
    }
  } finally {
    pumping = false
  }
}

/** init 失败的队列排空：未取消 job 逐个 jobError（取消的照常丢弃，主线程已忽略其结果） */
function failQueuedJobs(message: string): void {
  while (queue.length > 0) {
    const job = queue.shift()
    if (job === undefined) break
    if (cancelled.delete(job.id)) continue
    post({ type: 'jobError', id: job.id, message })
  }
}
