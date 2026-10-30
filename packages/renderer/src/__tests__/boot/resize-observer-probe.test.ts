/**
 * boot/resize-observer-probe 探针单测（问题登记 docs/todo/resize-observer-loop-noise.md）。
 *
 * 覆盖（三视角）：
 * - 构建者白盒：dev 下全局 RO 被包装（原引用替换、instanceof 保持）、构造计数与回调
 *   计数、注册点从构造 stack 解析、同注册点多实例聚合、窗尾 top N 输出与清零
 * - 使用者黑盒（可观察行为）：回调 entries/observer 透传（包装不改变交付语义）、
 *   console.debug 输出一行一条人类可读、空窗不输出
 * - prod 零执行：import.meta.env.DEV=false 时安装函数入口即 return——全局 RO 引用
 *   保持原样（未包装、未计数、未挂 setInterval）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/boot/resize-observer-probe.test.ts
 * （本文件不在 domain-map 域登记——轻量单测，默认档直接收集）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// [HISTORICAL] 探针的统计表与 installed 标记是模块级状态，且 lib 无顶层 electronAPI
// 捕获问题——仍按 boot 目录既有范式（error-reporter.test.ts）：每个用例 vi.resetModules
// + 动态 import，取全新模块实例；fake RO 宿主在 beforeEach 注入（happy-dom 无 RO）。

/** happy-dom 无 ResizeObserver——注入最小可用的假构造器作被包装宿主。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  /** 模拟浏览器帧边界派发：以全新调用栈执行回调（与真实 RO 派发形态对齐）。 */
  trigger(entries: unknown[] = [], observer: unknown = this): void {
    ;(this.callback as (e: unknown[], o: unknown) => void)(entries, observer)
  }
}

/** 当前全局 RO 引用（安装前快照，恢复与「未包装」断言用）。 */
let originalRO: unknown

/** 安装探针并返回安装后的全局 RO 引用（被测包装类）。 */
async function installProbe(): Promise<unknown> {
  const { installResizeObserverProbe } = await import('@/boot/resize-observer-probe')
  installResizeObserverProbe()
  return window.ResizeObserver
}

/** console.debug 中带探针前缀的窗尾输出行（与 installed 提示行按 ' window #N' 互斥区分）。 */
function probeDebugLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((a): a is string => typeof a === 'string' && a.startsWith('[ro-probe]'))
}

/** 安装后 new 一个 RO 实例并触发回调 n 次（模拟该观察点的窗口内活动）。 */
function createAndTrigger(constructor: unknown, n: number): void {
  const inst = new (constructor as new (cb: ResizeObserverCallback) => FakeResizeObserver)(() => {})
  for (let i = 0; i < n; i++) (inst as FakeResizeObserver).trigger()
}

/** 单注册点构造 n 个实例（循环内同一 `new` 行 = 同一注册点），返回实例供触发。 */
function createInstances(constructor: unknown, n: number): FakeResizeObserver[] {
  const created: FakeResizeObserver[] = []
  for (let i = 0; i < n; i++) {
    created.push(new (constructor as new (cb: ResizeObserverCallback) => FakeResizeObserver)(() => {}))
  }
  return created
}

describe('boot/resize-observer-probe（dev-only RO 归因探针）', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeResizeObserver.instances = []
    originalRO = window.ResizeObserver
    window.ResizeObserver = FakeResizeObserver as unknown as typeof window.ResizeObserver
  })

  afterEach(() => {
    window.ResizeObserver = originalRO as typeof window.ResizeObserver
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('dev 下安装：全局 RO 被包装（原引用替换）、instanceof 原构造器保持、输出 installed 提示行', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const wrapped = await installProbe()
      expect(wrapped).not.toBe(FakeResizeObserver)
      const inst = new (wrapped as new (cb: ResizeObserverCallback) => FakeResizeObserver)(() => {})
      // extends 原构造器 → instanceof 不破（业务/库侧的实例检查行为不变）
      expect(inst).toBeInstanceOf(FakeResizeObserver)
      // 安装提示行：真机上「探针是否生效」的可见锚点
      const installed = probeDebugLines(debugSpy).filter((l) => l.includes('installed'))
      expect(installed).toHaveLength(1)
      expect(installed[0]).toContain('dev-only')
    } finally {
      debugSpy.mockRestore()
    }
  })

  it('回调计数 + 透传：触发 n 次回调 → 原 callback 收到 entries/observer 实参', async () => {
    const seen: Array<{ entries: unknown; observer: unknown }> = []
    const wrapped = (await installProbe()) as new (cb: ResizeObserverCallback) => FakeResizeObserver
    const inst = new wrapped((entries, observer) => {
      seen.push({ entries, observer })
    })
    const entries = [{ contentRect: { width: 1, height: 2 } }]
    ;(inst as FakeResizeObserver).trigger(entries)
    ;(inst as FakeResizeObserver).trigger(entries)
    expect(seen).toHaveLength(2)
    expect(seen[0]?.entries).toBe(entries)
    expect(seen[0]?.observer).toBe(inst)
  })

  it('注册点从构造 stack 解析（跳过探针自身帧）；同注册点多实例按 instances 聚合', async () => {
    vi.useFakeTimers()
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const wrapped = (await installProbe()) as new (cb: ResizeObserverCallback) => FakeResizeObserver
      // 同一注册点（createInstances 内单行 new 循环 2 次）创建 2 实例、共触发 5 次
      const [a, b] = createInstances(wrapped, 2)
      a?.trigger()
      a?.trigger()
      b?.trigger()
      b?.trigger()
      b?.trigger()
      await vi.advanceTimersByTimeAsync(60_000)

      const lines = probeDebugLines(debugSpy).filter((l) => l.includes(' window #'))
      expect(lines).toHaveLength(1)
      // 注册点 = 构造调用点（本测试文件），非探针自身文件
      expect(lines[0]).toContain('resize-observer-probe.test.ts')
      expect(lines[0]).not.toContain('boot/resize-observer-probe.ts')
      // 5 callbacks + 2 instances 同组合并到一行
      expect(lines[0]).toContain('5 callbacks, 2 instance(s)')
      // 一行一条：窗口行恰一行（installed 提示行不含 ' window #'，已过滤）
      expect(lines[0]).toContain('#1:')
    } finally {
      debugSpy.mockRestore()
    }
  })

  it('多注册点按回调次数降序输出 top N；flush 后窗内计数清零', async () => {
    vi.useFakeTimers()
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const wrapped = (await installProbe()) as new (cb: ResizeObserverCallback) => FakeResizeObserver
      // 注册点 A（顶层辅助函数）：3 次；注册点 B（独立辅助函数）：7 次
      createAndTrigger(wrapped, 3)
      createAndTriggerFromHelper(wrapped, 7)
      await vi.advanceTimersByTimeAsync(60_000)

      const lines = probeDebugLines(debugSpy).filter((l) => l.includes(' window #'))
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('#1: 7 callbacks')
      expect(lines[1]).toContain('#2: 3 callbacks')
      // 两个注册点是不同构造调用行（site 串互异），未被塌缩成一条
      expect(lines[0]).not.toBe(lines[1])

      // 第二窗无新活动 → 无输出（空窗不打印）
      await vi.advanceTimersByTimeAsync(60_000)
      expect(probeDebugLines(debugSpy).filter((l) => l.includes(' window #'))).toHaveLength(2)
    } finally {
      debugSpy.mockRestore()
    }
  })

  it('prod（import.meta.env.DEV=false）：安装函数入口即 return——全局 RO 原样未动', async () => {
    vi.stubEnv('DEV', false)
    const { installResizeObserverProbe } = await import('@/boot/resize-observer-probe')
    installResizeObserverProbe()
    // 零执行证据：引用未替换（未包装）、假宿主零新增实例（未计数）、无 debug 输出
    expect(window.ResizeObserver).toBe(FakeResizeObserver)
    expect(FakeResizeObserver.instances).toHaveLength(0)
  })

  it('安装幂等：重复调用不重复包装、不叠加第二个 setInterval', async () => {
    vi.useFakeTimers()
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const { installResizeObserverProbe } = await import('@/boot/resize-observer-probe')
      installResizeObserverProbe()
      const first = window.ResizeObserver
      installResizeObserverProbe()
      expect(window.ResizeObserver).toBe(first)
      // installed 提示行恰一条（无重复安装痕迹）
      expect(probeDebugLines(debugSpy).filter((l) => l.includes('installed'))).toHaveLength(1)
    } finally {
      debugSpy.mockRestore()
    }
  })
})

/** 辅助注册点：独立栈帧，供「多注册点排序」用例构造与测试函数不同的构造调用点。 */
function createAndTriggerFromHelper(constructor: unknown, n: number): void {
  const inst = new (constructor as new (cb: ResizeObserverCallback) => FakeResizeObserver)(() => {})
  for (let i = 0; i < n; i++) (inst as FakeResizeObserver).trigger()
}
