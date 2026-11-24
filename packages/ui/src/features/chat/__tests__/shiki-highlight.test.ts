/**
 * 批3 B-worker 单测：shiki 高亮 Worker 客户端状态机 + markdown 三段拆分集成。
 *
 * 覆盖（对应设计文档 G1/G4 与长叶「单测补全」）：
 * - 客户端：happy path 逐 job 结算 / 无 Worker 全局回退 / 构造抛错回退 / error 事件永久
 *   降级 / 单 jobError 单独回退不拖垮全局 / 组取消（哨兵）/ 全局取消（null）/ 迟到结果忽略；
 * - 集成（markdown.ts）：fence 高亮走 worker 产物 / worker 挂掉回退主线程同一函数产物 /
 *   组取消落纯文本降级（内容不丢）/ mermaid 与 html-preview 不发高亮 job。
 *
 * mock 策略：vi.stubGlobal('Worker', FakeWorker) 注入假 worker（协议与
 * shiki-highlight-worker.ts 逐条对应）；shiki/core stub 区分「worker 产物」与「主线程
 * 降级产物」两条通道的输出。模块级状态（worker 单例 / degraded）每例 resetModules 隔离。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── 假 Worker：记录发出的消息，按测试脚本决定如何回应 ─────────────────────────
interface FakeMessageEvent { data: unknown }
class FakeWorker {
  static instances: FakeWorker[] = []
  posted: unknown[] = []
  listeners = new Map<string, Array<(e: FakeMessageEvent) => void>>()
  terminated = false
  constructor(public url: unknown, public opts: unknown) {
    FakeWorker.instances.push(this)
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg)
  }
  addEventListener(type: string, cb: (e: FakeMessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type)!.push(cb)
  }
  terminate(): void {
    this.terminated = true
  }
  /** 模拟 worker 回消息 */
  emit(type: string, data: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data })
  }
  emitRaw(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event as FakeMessageEvent)
  }
}

const WORKER_HTML = '<pre class="shiki">WORKER-OUTPUT</pre>'
const MAIN_HTML = '<pre class="shiki">MAIN-OUTPUT</pre>'

/**
 * 等 worker 被创建（renderMarkdown 内创建点晚于 getMarkdown 的 await，晚于调用方
 * 同步可见点）；轮询微任务而非墙钟（测试环境事件驱动）。
 */
async function waitForWorker(): Promise<FakeWorker> {
  for (let i = 0; i < 100; i++) {
    if (FakeWorker.instances.length > 0) return FakeWorker.instances[FakeWorker.instances.length - 1]
    await Promise.resolve()
  }
  throw new Error('worker not created')
}

/** 回应全部已发出的 job（按「批序 × 批内序」顺序取 htmls；缺省用最后一个） */
function respondResults(worker: FakeWorker, htmls: string[]): void {
  const jobsMsgs = worker.posted.filter((m) => (m as { type: string }).type === 'jobs') as { jobs: { id: number }[] }[]
  let idx = 0
  for (const jobsMsg of jobsMsgs) {
    for (const job of jobsMsg.jobs) {
      worker.emit('message', { type: 'result', id: job.id, html: htmls[idx] ?? htmls[htmls.length - 1] })
      idx++
    }
  }
}

/** 动态 import 客户端模块（每例全新模块状态） */
async function freshClient() {
  vi.resetModules()
  return import('../shiki-highlight-client')
}

beforeEach(() => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('shiki-highlight-client 状态机', () => {
  it('happy path：一批 job 一次往返，逐 job 按序结算', async () => {
    const { resolveFenceHighlights } = await freshClient()
    const promise = resolveFenceHighlights([
      { code: 'const a = 1', lang: 'typescript' },
      { code: 'body { color: red }', lang: 'css' },
    ])
    const worker = FakeWorker.instances[0]
    expect(worker).toBeDefined()
    expect(worker.opts).toEqual({ type: 'module' })
    expect(worker.posted).toHaveLength(1)
    const msg = worker.posted[0] as { type: string; jobs: { id: number; code: string; lang: string }[] }
    expect(msg.type).toBe('jobs')
    expect(msg.jobs.map((j) => j.code)).toEqual(['const a = 1', 'body { color: red }'])
    respondResults(worker, [WORKER_HTML + '-a', WORKER_HTML + '-b'])
    await expect(promise).resolves.toEqual([WORKER_HTML + '-a', WORKER_HTML + '-b'])
  })

  it('多批排队：worker 单例复用，消息按序发出', async () => {
    const { resolveFenceHighlights } = await freshClient()
    const p1 = resolveFenceHighlights([{ code: 'a', lang: 'typescript' }])
    const p2 = resolveFenceHighlights([{ code: 'b', lang: 'typescript' }])
    expect(FakeWorker.instances).toHaveLength(1)
    const worker = FakeWorker.instances[0]
    expect(worker.posted).toHaveLength(2)
    respondResults(worker, ['h1', 'h2'])
    await expect(p1).resolves.toEqual(['h1'])
    await expect(p2).resolves.toEqual(['h2'])
  })

  it('无 Worker 全局：全部回退 null（不建 worker）', async () => {
    vi.stubGlobal('Worker', undefined)
    const { resolveFenceHighlights } = await freshClient()
    const r = await resolveFenceHighlights([{ code: 'a', lang: 'typescript' }])
    expect(r).toEqual([null])
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('构造抛错：全部回退 null + 出声 + 后续不再尝试建 worker', async () => {
    vi.stubGlobal('Worker', class {
      constructor() { throw new Error('CSP blocked') }
    })
    const { resolveFenceHighlights } = await freshClient()
    const r = await resolveFenceHighlights([{ code: 'a', lang: 'typescript' }])
    expect(r).toEqual([null])
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/worker unavailable \(worker construction threw\)/), expect.anything())
    // 已 degraded：再来一批也不建 worker
    const r2 = await resolveFenceHighlights([{ code: 'b', lang: 'typescript' }])
    expect(r2).toEqual([null])
  })

  it('error 事件：永久降级 + 在途全部回退 null + 终止 worker', async () => {
    const { resolveFenceHighlights } = await freshClient()
    const p = resolveFenceHighlights([{ code: 'a', lang: 'typescript' }])
    const worker = FakeWorker.instances[0]
    worker.emitRaw('error', { type: 'error', message: 'script load failed' })
    await expect(p).resolves.toEqual([null])
    expect(worker.terminated).toBe(true)
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/worker unavailable \(worker error event\)/), expect.anything())
    // 后续批次直接回退，不建新 worker
    const r = await resolveFenceHighlights([{ code: 'b', lang: 'typescript' }])
    expect(r).toEqual([null])
    expect(FakeWorker.instances).toHaveLength(1)
  })

  it('单 jobError：该 job 回退 null、出声，其余 job 照常 + 不降级全局', async () => {
    const { resolveFenceHighlights } = await freshClient()
    const promise = resolveFenceHighlights([
      { code: 'a', lang: 'typescript' },
      { code: 'b', lang: 'typescript' },
    ])
    const worker = FakeWorker.instances[0]
    const jobsMsg = worker.posted[0] as { jobs: { id: number }[] }
    worker.emit('message', { type: 'jobError', id: jobsMsg.jobs[0].id, message: 'boom' })
    worker.emit('message', { type: 'result', id: jobsMsg.jobs[1].id, html: WORKER_HTML })
    await expect(promise).resolves.toEqual([null, WORKER_HTML])
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/worker job failed/), 'boom')
    // 未降级：下一批仍走 worker
    const p2 = resolveFenceHighlights([{ code: 'c', lang: 'typescript' }])
    respondResults(FakeWorker.instances[0], ['h'])
    await expect(p2).resolves.toEqual(['h'])
  })

  it('组取消：在途 job 结算取消哨兵 + 通知 worker 丢弃', async () => {
    const { resolveFenceHighlights, cancelShikiHighlightGroup, HIGHLIGHT_CANCELLED } = await freshClient()
    const group = {}
    const promise = resolveFenceHighlights([{ code: 'a', lang: 'typescript' }], group)
    const worker = FakeWorker.instances[0]
    cancelShikiHighlightGroup(group)
    await expect(promise).resolves.toEqual([HIGHLIGHT_CANCELLED])
    const cancelMsg = worker.posted.find((m) => (m as { type: string }).type === 'cancel') as { ids: number[] }
    expect(cancelMsg).toBeDefined()
    expect(cancelMsg.ids).toHaveLength(1)
  })

  it('组取消后 worker 迟到结果被忽略（不重复结算）', async () => {
    const { resolveFenceHighlights, cancelShikiHighlightGroup, HIGHLIGHT_CANCELLED } = await freshClient()
    const group = {}
    const promise = resolveFenceHighlights([{ code: 'a', lang: 'typescript' }], group)
    const worker = FakeWorker.instances[0]
    cancelShikiHighlightGroup(group)
    await promise
    const jobsMsg = worker.posted.find((m) => (m as { type: string }).type === 'jobs') as { jobs: { id: number }[] }
    // 迟到 result：pending 已删 → 静默忽略（无二次结算、无抛错）
    worker.emit('message', { type: 'result', id: jobsMsg.jobs[0].id, html: 'late' })
    // 再取消一次：空组不再发消息
    const before = worker.posted.length
    cancelShikiHighlightGroup(group)
    expect(worker.posted).toHaveLength(before)
  })

  it('全局取消：全部在途回退 null（页面隐藏路径）', async () => {
    const { resolveFenceHighlights, cancelAllShikiHighlights } = await freshClient()
    const p1 = resolveFenceHighlights([{ code: 'a', lang: 'typescript' }])
    const p2 = resolveFenceHighlights([{ code: 'b', lang: 'typescript' }])
    cancelAllShikiHighlights()
    await expect(p1).resolves.toEqual([null])
    await expect(p2).resolves.toEqual([null])
    const worker = FakeWorker.instances[0]
    const cancelMsg = worker.posted.filter((m) => (m as { type: string }).type === 'cancel').pop() as { ids: number[] }
    expect(cancelMsg.ids).toHaveLength(2)
  })

  it('空批次：不建 worker、返回空数组', async () => {
    const { resolveFenceHighlights } = await freshClient()
    await expect(resolveFenceHighlights([])).resolves.toEqual([])
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('log 消息转发出声（成本登记通道）', async () => {
    const { resolveFenceHighlights } = await freshClient()
    const promise = resolveFenceHighlights([{ code: 'a', lang: 'typescript' }])
    const worker = FakeWorker.instances[0]
    worker.emit('message', { type: 'log', level: 'log', msg: 'highlighter init 512ms' })
    respondResults(worker, ['h'])
    await promise
    expect(console.log).toHaveBeenCalledWith('[shiki-worker]', 'highlighter init 512ms')
  })
})

// ── 集成：markdown.ts 三段拆分 ──────────────────────────────────────────────
describe('markdown 三段拆分 × worker 高亮', () => {
  beforeEach(() => {
    // shiki/core stub：主线程降级通道产物（与 worker 通道产物可区分）
    vi.doMock('shiki/core', () => ({
      createHighlighterCore: vi.fn(() =>
        Promise.resolve({
          codeToHtml: vi.fn(() => MAIN_HTML),
          getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
        }),
      ),
    }))
  })

  async function freshMarkdown() {
    vi.resetModules()
    return import('../markdown')
  }

  it('fence 高亮走 worker 产物（非主线程降级产物）', async () => {
    const { renderMarkdown } = await freshMarkdown()
    const promise = renderMarkdown('```ts\nconst a = 1\n```\n')
    respondResults(await waitForWorker(), [WORKER_HTML])
    const html = await promise
    expect(html).toContain(WORKER_HTML)
    expect(html).not.toContain(MAIN_HTML)
    expect(html).toContain('class="md-codeblock"')
    expect(html).toContain('data-code=')
  })

  it('worker error 事件 → 降级主线程同步高亮（产物不丢）', async () => {
    const { renderMarkdown } = await freshMarkdown()
    const promise = renderMarkdown('```ts\nconst a = 1\n```\n')
    ;(await waitForWorker()).emitRaw('error', { type: 'error', message: 'blocked' })
    const html = await promise
    expect(html).toContain(MAIN_HTML)
    expect(html).not.toContain(WORKER_HTML)
    expect(html).toContain('class="md-codeblock"')
  })

  it('组取消 → 纯文本降级（内容不丢，无 worker/主线程高亮）', async () => {
    const { renderMarkdown } = await freshMarkdown()
    const { cancelShikiHighlightGroup } = await import('../shiki-highlight-client')
    const group = {}
    const promise = renderMarkdown('```ts\nconst a = 1\n```\n', undefined, group)
    await waitForWorker() // 等 job 注册进组再取消（renderMarkdown 内创建点晚于同步可见点）
    cancelShikiHighlightGroup(group)
    const html = await promise
    // 代码文本经转义保留（可读），但不含任何高亮产物
    expect(html).toContain('const a = 1')
    expect(html).not.toContain(WORKER_HTML)
    expect(html).not.toContain(MAIN_HTML)
  })

  it('mermaid 与 html-preview fence 不发高亮 job（不走 shiki）', async () => {
    const { renderMarkdown } = await freshMarkdown()
    const promise = renderMarkdown('```mermaid\ngraph TD\n  A --> B\n```\n\n```html-preview\n/tmp/x.html\n```\n')
    // 两个 fence 都不产生高亮 job → worker 从未被创建
    expect(FakeWorker.instances).toHaveLength(0)
    const html = await promise
    expect(html).toContain('md-mermaid')
    expect(html).toContain('md-html-preview')
  })

  it('无 fence 文档不建 worker（零开销路径）', async () => {
    const { renderMarkdown } = await freshMarkdown()
    const html = await renderMarkdown('# 标题\n\n普通段落。\n')
    expect(FakeWorker.instances).toHaveLength(0)
    expect(html).toContain('<p>普通段落。</p>')
  })

  it('重复代码块去重：一批只发一个 job', async () => {
    const { renderMarkdown } = await freshMarkdown()
    const promise = renderMarkdown('```ts\nsame code\n```\n\n```ts\nsame code\n```\n')
    const worker = await waitForWorker()
    const jobsMsg = worker.posted[0] as { jobs: unknown[] }
    expect(jobsMsg.jobs).toHaveLength(1)
    respondResults(worker, [WORKER_HTML])
    const html = await promise
    expect(html.match(new RegExp(WORKER_HTML, 'g'))).toHaveLength(2)
  })
})

// ── worker 侧协议（多 fence 排队 / 取消只丢未开始的 / jobError）────────────────
describe('shiki-highlight-worker 协议', () => {
  /** 导入 worker 模块（core 依赖 mock：高亮函数可控），self.postMessage 收消息 */
  async function freshWorker() {
    vi.resetModules()
    vi.doMock('../shiki-highlight-core', () => ({
      createShikiHighlighter: vi.fn(() => Promise.resolve({ tag: 'fake-hl' })),
      highlightWithHighlighter: vi.fn((_hl, code, lang) => `HL(${lang}):${code}`),
    }))
    const posted: unknown[] = []
    const selfObj = globalThis.self as unknown as { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => void) | null }
    selfObj.postMessage = (m) => posted.push(m)
    await import('../shiki-highlight-worker')
    return { posted, emit: (data: unknown) => selfObj.onmessage?.({ data }) }
  }

  it('一批多 job 串行处理、逐 job 回传 result（多 fence 连续闭合排队）', async () => {
    const { posted, emit } = await freshWorker()
    emit({ type: 'jobs', jobs: [{ id: 1, code: 'a', lang: 'typescript' }, { id: 2, code: 'b', lang: 'css' }] })
    await vi.waitFor(() => expect(posted.filter((m) => (m as { type: string }).type === 'result')).toHaveLength(2))
    const results = posted.filter((m) => (m as { type: string }).type === 'result')
    expect(results).toEqual([
      { type: 'result', id: 1, html: 'HL(typescript):a' },
      { type: 'result', id: 2, html: 'HL(css):b' },
    ])
    // init 日志一条（一次/worker 生命周期）
    expect(posted.filter((m) => (m as { type: string }).type === 'log' && /init/.test((m as { msg: string }).msg))).toHaveLength(1)
  })

  it('cancel 只丢未开始的：排队中的 job 被取消后不产出 result', async () => {
    const { posted, emit } = await freshWorker()
    // 首个 job 的处理依赖 mock highlighter（微任务解析），cancel 在同批次之后到达即排队态
    emit({ type: 'jobs', jobs: [{ id: 1, code: 'a', lang: 'typescript' }, { id: 2, code: 'b', lang: 'typescript' }] })
    emit({ type: 'cancel', ids: [2] })
    await vi.waitFor(() => expect(posted.filter((m) => (m as { type: string }).type === 'result')).toHaveLength(1))
    const results = posted.filter((m) => (m as { type: string }).type === 'result')
    expect(results).toEqual([{ type: 'result', id: 1, html: 'HL(typescript):a' }])
  })

  it('高亮函数抛错 → jobError 回传（该 job 由主线程回退，不拖垮队列）', async () => {
    vi.resetModules()
    vi.doMock('../shiki-highlight-core', () => ({
      createShikiHighlighter: vi.fn(() => Promise.resolve({ tag: 'fake-hl' })),
      highlightWithHighlighter: vi.fn((_hl, code) => { if (code === 'bad') throw new Error('boom'); return `HL:${code}` }),
    }))
    const posted: unknown[] = []
    const selfObj = globalThis.self as unknown as { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => void) | null }
    selfObj.postMessage = (m) => posted.push(m)
    await import('../shiki-highlight-worker')
    selfObj.onmessage?.({ data: { type: 'jobs', jobs: [{ id: 1, code: 'bad', lang: 'ts' }, { id: 2, code: 'ok', lang: 'ts' }] } })
    await vi.waitFor(() => {
      expect(posted.some((m) => (m as { type: string }).type === 'jobError')).toBe(true)
      expect(posted.some((m) => (m as { type: string; id: number }).type === 'result' && m.id === 2)).toBe(true)
    })
    const err = posted.find((m) => (m as { type: string }).type === 'jobError')
    expect(err).toEqual({ type: 'jobError', id: 1, message: 'boom' })
  })
})

// ── 页面隐藏 → 取消全部在途（生命周期）────────────────────────────────────────
describe('页面隐藏取消在途高亮', () => {
  it('visibilitychange → hidden：在途 job 结算 null（回退同步），queued 之后的批次照常', async () => {
    const { resolveFenceHighlights, cancelAllShikiHighlights } = await freshClient()
    const p = resolveFenceHighlights([{ code: 'a', lang: 'typescript' }])
    const worker = FakeWorker.instances[0]
    // 直接驱动 visibility 钩子注册的监听器（模块在首个 worker 创建时注册）
    const visSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await expect(p).resolves.toEqual([null])
    const cancelMsg = worker.posted.find((m) => (m as { type: string }).type === 'cancel') as { ids: number[] }
    expect(cancelMsg.ids).toHaveLength(1)
    visSpy.mockRestore()
    // 未 degraded：后续批次仍走 worker
    const p2 = resolveFenceHighlights([{ code: 'b', lang: 'typescript' }])
    respondResults(worker, ['h'])
    await expect(p2).resolves.toEqual(['h'])
  })
})
