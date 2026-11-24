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
/** 已取消但尚未处理的 job id（处理时删除；运行中的 job 取消由主线程侧忽略结果） */
const cancelled = new Set<number>()
const queue: HighlightJob[] = []
let pumping = false

ctx.onmessage = (event) => {
  const msg = event.data
  if (msg.type === 'cancel') {
    for (const id of msg.ids) cancelled.add(id)
    // 取消集合封顶保护：运行中 job 的迟到取消会残留条目（主线程已忽略其结果），
    // 超限即清空——最坏后果是某个已取消 job 白跑一次，结果被主线程丢弃，无正确性影响。
    if (cancelled.size > 256) cancelled.clear()
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
    if (hl === null) {
      const t0 = performance.now()
      hl = await (starting ??= createShikiHighlighter())
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
