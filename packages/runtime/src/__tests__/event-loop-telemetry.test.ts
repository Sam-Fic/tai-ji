/**
 * 常驻事件循环滞后遥测单测（startup-readiness 设计 §7.1 / D4；RL4 看守面）。
 *
 * 看守行为：
 * - monitorEventLoopDelay 直方图快照可读：负载期（同步阻塞 > 50ms）滞后被观测到
 *   （A3「负载期滞后无一次 > 50ms」的断言读取口存在且量纲正确——真机 A3 剧本归
 *   D3 验收面，此处看守遥测源自身的观测能力）；
 * - 直方图分布进结构化日志：落盘口（注入的 log fn）按窗口收到含 percentile 的
 *   meta（fake timers 推进落盘间隔）；
 * - 不参与杀进程决策：模块导出面无进程控制原语（结构断言——start/stop/snapshot
 *   之外零导出，supervisor/watchdog 无本模块消费，RL11 判据前提不拖累）；
 * - 生命周期：stop 后快照 running=false；start 幂等。
 *
 * 测试框架：vitest + fake timers（落盘间隔推进）。
 * 运行：cd packages/runtime && npx vitest run src/__tests__/event-loop-telemetry.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startEventLoopDelayTelemetry,
  stopEventLoopDelayTelemetry,
  getEventLoopDelaySnapshot,
  _resetEventLoopTelemetryForTest,
} from '../infra/event-loop-telemetry.js'

describe('event-loop-telemetry（RL4 常驻滞后遥测）', () => {
  afterEach(() => {
    _resetEventLoopTelemetryForTest()
    vi.useRealTimers()
  })

  it('负载期滞后可观测：负载驱动下同步阻塞 120ms → 快照 maxMs > 50（A3 断言读取口量纲正确）', async () => {
    const log = vi.fn()
    startEventLoopDelayTelemetry(log)
    const before = getEventLoopDelaySnapshot()
    expect(before.running).toBe(true)

    // 负载驱动：monitorEventLoopDelay 的采样 timer 是 unref 的，事件循环需有
    // 活跃 handle 持续运转才如实记录 tick 间隔——空转循环里阻塞期间错过的采样点
    // 直接丢失，同步阻塞不留任何样本。10ms 周期任务模拟负载期的事件驱动。
    const load = setInterval(() => {}, 10)
    await new Promise((resolve) => setTimeout(resolve, 100)) // 负载稳定运转

    // 同步忙等 120ms：阻塞事件循环，monitorEventLoopDelay 在事件循环恢复后的
    // tick 记录该轮滞后（20ms 桶宽量化 + 开销，实测 ~123ms）。阻塞结束后让循环
    // 转 200ms（真实定时器）使直方图完成计量，再读快照。
    const t0 = Date.now()
    while (Date.now() - t0 < 120) {
      // busy loop
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    clearInterval(load)
    const snap = getEventLoopDelaySnapshot()
    expect(snap.running).toBe(true)
    // 断言 > 50ms 即 A3 判据阈值（该用例看守「遥测源能观测到 > 50ms 的滞后」，
    // A3 真机剧本的「无一次 > 50ms」断言归 D3 验收面）。
    expect(snap.maxMs).toBeGreaterThan(50)
  })

  it('未启动 → 快照 running=false 全零（消费方按无数据处理）', () => {
    const snap = getEventLoopDelaySnapshot()
    expect(snap).toEqual({ count: 0, p50ms: 0, p90ms: 0, p99ms: 0, maxMs: 0, meanMs: 0, running: false })
  })

  it('直方图进结构化日志：落盘间隔到期 → log 收到含 percentile 的窗口行（窗口重置后零样本行照发）', () => {
    vi.useFakeTimers()
    const log = vi.fn()
    startEventLoopDelayTelemetry(log)
    expect(log).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000) // 落盘间隔 60s
    expect(log).toHaveBeenCalledTimes(1)
    const [message, meta] = log.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toContain('[event-loop-telemetry]')
    expect(meta).toMatchObject({
      count: expect.any(Number),
      p50ms: expect.any(Number),
      p90ms: expect.any(Number),
      p99ms: expect.any(Number),
      maxMs: expect.any(Number),
      meanMs: expect.any(Number),
    })

    // 窗口重置语义：第二窗口是独立窗口（count 归零重积），不再是第一窗累积
    vi.advanceTimersByTime(60_000)
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('start 幂等 + stop 后 running=false（重启遥测窗口）', () => {
    const log = vi.fn()
    startEventLoopDelayTelemetry(log)
    startEventLoopDelayTelemetry(log) // 幂等：不重建直方图
    expect(getEventLoopDelaySnapshot().running).toBe(true)
    stopEventLoopDelayTelemetry()
    expect(getEventLoopDelaySnapshot().running).toBe(false)
    // 再 start 可恢复（stop 后重启窗口）
    startEventLoopDelayTelemetry(log)
    expect(getEventLoopDelaySnapshot().running).toBe(true)
  })

  it('不参与杀进程决策（RL11 前提）：模块导出面仅观测原语，无进程控制接口', async () => {
    const mod = await import('../infra/event-loop-telemetry.js')
    const exports = Object.keys(mod).sort()
    expect(exports).toEqual([
      '_resetEventLoopTelemetryForTest',
      'getEventLoopDelaySnapshot',
      'startEventLoopDelayTelemetry',
      'stopEventLoopDelayTelemetry',
    ].sort())
    // 无 process.exit / kill 类副作用导出；kill decision 链（supervisor/watchdog）
    // 不消费本模块——遥测纯观测（设计 §7.1「不参与杀进程决策，探针判据不变」）。
    expect(exports.join(' ')).not.toMatch(/exit|kill|terminate|restart/i)
  })
})
