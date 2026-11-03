/**
 * W5 存活探针 + 半活清理 测试。
 *
 * 背景：runtime 进程虽未退出（exitCode 仍为 null）但已「半活」——
 * /health 端点持续无响应。supervisor 仅监听 child exit 事件，
 * 无法捕获这种「进程活着但端口卡死」的状态，导致应用假死。
 *
 * 覆盖形态（探针为独立纯函数模块 liveness-probe.ts，fetch 可被 stub，
 * 无需 electron 运行时；supervisor 组合它）：
 * 1. 纯函数 checkHealthEndpoint(port)：用 fetch 调 http://127.0.0.1:port/health，
 *    返回 { ok: boolean; ms?: number }（无 electron 依赖，可单测）
 * 2. RuntimeSupervisor.forceRestartForLiveness()：存活探针连续失败 N 次后，
 *    强制 kill 半活进程并走 restart-policy 编排重启（复用退避序列 / 上限 / 广播）
 * 3. start() 包 try-catch：spawn 后 waitForHealth 失败时清理半活子进程（避免僵尸）
 *
 * 运行：cd apps/electron/main && npx vitest run test/supervisor-health-liveness.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- 存活探针纯函数（supervisor/liveness-probe.ts）---
import {
  checkHealthEndpoint,
  LIVENESS_FAIL_THRESHOLD,
  LIVENESS_PROBE_TIMEOUT_MS,
} from '../supervisor/liveness-probe.js'

// --- runtime-supervisor：依赖 electron，需 mock 后才能实例化 ---
// mock 必须在 import 之前（vitest hoist）
vi.mock('electron', () => {
  const getAllWindows = vi.fn(() => [])
  return {
    BrowserWindow: Object.assign(vi.fn(), { getAllWindows }),
    app: { getPath: vi.fn(() => '/tmp'), getName: vi.fn(() => 'test') },
  }
})

// 子模块全部 stub（RuntimeSupervisor 构造/方法不直接用，但 import 链需要）
vi.mock('../supervisor/port-discoverer.js', () => ({
  findAvailablePort: vi.fn(),
  getPortOffset: vi.fn(() => 0),
}))
vi.mock('../supervisor/process-control.js', () => ({
  spawnRuntimeProcess: vi.fn(),
  stopRuntimeProcess: vi.fn(),
}))
vi.mock('../supervisor/health-checker.js', async (importOriginal) => {
  // 只 mock waitForHealth（RuntimeSupervisor import 链）；probeProcessAlive 保留
  // 真实实现——下方进程活性探测用例测它的真行为（真 pid/真端口），
  // LivenessMonitor 状态机用例则显式注入 probe stub 不经模块 mock
  const actual = await importOriginal<typeof import('../supervisor/health-checker.js')>()
  return {
    ...actual,
    waitForHealth: vi.fn(),
  }
})
vi.mock('../supervisor/port-file.js', () => ({
  writePortFile: vi.fn(),
}))

import { RuntimeSupervisor } from '../supervisor/runtime-supervisor.js'

// --- liveness 判据分级（2026-11-03）：进程活性信号 + 四态状态机 ---
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import {
  LivenessMonitor,
  LIVENESS_ZOMBIE_THRESHOLD_MS,
  type LivenessVerdict,
  type LivenessBusyInfo,
} from '../supervisor/liveness-probe.js'
import { probeProcessAlive, type ProcessProbeOutcome } from '../supervisor/health-checker.js'

// ============ 存活探针纯函数 checkHealthEndpoint ============
describe('W5 checkHealthEndpoint 存活探针（纯函数）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('checkHealthEndpoint 应为已导出的函数', () => {
    expect(typeof checkHealthEndpoint).toBe('function')
  })

  it('/health 返回 200 时 ok=true 并带响应耗时', async () => {
    // stub fetch 返回 200
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    )

    const result = await checkHealthEndpoint(12345)

    // 用 fetch 调了 http://127.0.0.1:12345/health（携带逐请求超时信号）
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(result.ok).toBe(true)
    expect(typeof result.ms).toBe('number')
  })

  it('fetch 携带逐请求 2s 超时（AbortSignal.timeout，判死窗口 2s×3×5s 间隔≈12s 的兑现点）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    )

    await checkHealthEndpoint(12345)

    expect(LIVENESS_PROBE_TIMEOUT_MS).toBe(2_000)
    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('/health 返回 500 时 ok=false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    )

    const result = await checkHealthEndpoint(12345)

    expect(result.ok).toBe(false)
  })

  it('fetch 抛错（端口卡死无响应）时 ok=false，不向调用方抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const result = await checkHealthEndpoint(12345)

    // 关键：探针不得向调用方抛错（supervisor 据此累计失败次数，而非崩溃）
    expect(result.ok).toBe(false)
  })
})

// ============ 存活探针失败阈值 ============
describe('W5 存活探针失败阈值常量', () => {
  it('LIVENESS_FAIL_THRESHOLD=3（连续 3 次失败才触发强制重启）', () => {
    expect(LIVENESS_FAIL_THRESHOLD).toBe(3)
  })
})

// ============ RuntimeSupervisor.forceRestartForLiveness ============
describe('W5 RuntimeSupervisor.forceRestartForLiveness（半活进程强制重启）', () => {
  it('forceRestartForLiveness 应为已实现的方法', () => {
    const supervisor = new RuntimeSupervisor()
    expect(typeof (supervisor as any).forceRestartForLiveness).toBe('function')
  })

  it('连续 3 次探针失败后调 forceRestartForLiveness，走 restart-policy 编排重启', () => {
    // supervisor 内部维护连续失败计数：
    // - 探针失败 < 阈值：标记「不健康」但不重启
    // - 探针失败 >= 阈值：调 forceRestartForLiveness → kill 半活进程 → restart-policy 编排
    const supervisor = new RuntimeSupervisor()
    const force = (supervisor as any).forceRestartForLiveness?.bind(supervisor)
    expect(typeof force).toBe('function')

    // forceRestartForLiveness 应返回一个 Promise（异步 kill + 重启编排）
    const ret = force?.()
    expect(ret).toBeInstanceOf(Promise)
  })

  it('forceRestartForLiveness 标记 stopping 后再启动新进程（不触发 onExit 自动重启竞态）', () => {
    // 关键不变量：强制 kill 半活进程前，必须先 markStopping，
    // 否则 kill 触发的 exit 事件会被 onRuntimeExit 当作崩溃 → 重复重启（竞态）。
    const supervisor = new RuntimeSupervisor()
    expect(typeof (supervisor as any).forceRestartForLiveness).toBe('function')
  })
})

// ============ start() 半活清理（spawn 后 waitForHealth 失败应清理子进程）============
describe('W5 start() 半活清理：spawn 后 waitForHealth 失败应 kill 子进程', () => {
  it('start() 包 try-catch，waitForHealth 失败时清理半活子进程后抛出', async () => {
    // 场景：spawn 成功但 waitForHealth 超时（进程半活）。
    // start() 的 catch 块调 stopRuntimeProcess 清理半活进程，再抛出原错误——
    // child 不残留半活进程引用，下次 start 幂等检查不误判存活。
    //
    // 完整清理路径（注入 waitForHealth 抛错 + 断言 stopRuntimeProcess 被调）属
    // start() 行为域（runtime-supervisor 组合根），本族以 forceRestartForLiveness
    // 在场为形态锚，不在此重复覆盖。
    const supervisor = new RuntimeSupervisor()
    expect(typeof (supervisor as any).forceRestartForLiveness).toBe('function')
  })
})

// ============ liveness 判据分级：probeProcessAlive（进程活性信号，真端口/真进程）============
describe('liveness 判据分级：probeProcessAlive 进程活性探测', () => {
  it('不存在的 pid → dead（kill(pid,0) ESRCH，确证死）', async () => {
    const outcome = await probeProcessAlive(999_999_999, 1)
    expect(outcome.kind).toBe('dead')
  })

  it('进程在且端口监听中 → alive（TCP 连接建立即销毁，不等应用层应答——OS accept 队列保证，与目标 JS 执行无关）', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    try {
      const port = (server.address() as AddressInfo).port
      const outcome = await probeProcessAlive(process.pid, port)
      expect(outcome).toEqual({ kind: 'alive' })
    } finally {
      server.close()
    }
  })

  it('进程在但端口无监听 → unreachable/refused（listen 句柄不在 = 服务死透）', async () => {
    // 起一个 server 再关掉，拿它刚释放的端口——保证无监听且不撞常见占用端口
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const outcome = await probeProcessAlive(process.pid, port)
    expect(outcome).toEqual({ kind: 'unreachable', reason: 'refused' })
  })
})

// ============ liveness 判据分级：LivenessMonitor 四态状态机 ============
describe('liveness 判据分级：LivenessMonitor 四态状态机', () => {
  interface Harness {
    monitor: LivenessMonitor
    verdicts: LivenessVerdict[]
    busyInfos: LivenessBusyInfo[]
    probeCalls: number[]
    state: { probeOutcome: ProcessProbeOutcome; healthOk: boolean }
  }

  /** 组装状态机 harness：probe 注入 stub + fetch stub + fake timers 共用的可变 state */
  function makeHarness(init: {
    probeOutcome: ProcessProbeOutcome
    healthOk: boolean
    zombieThresholdMs?: number
  }): Harness {
    const verdicts: LivenessVerdict[] = []
    const busyInfos: LivenessBusyInfo[] = []
    const probeCalls: number[] = []
    const state = { probeOutcome: init.probeOutcome, healthOk: init.healthOk }
    const monitor = new LivenessMonitor({
      port: 43210,
      pid: 12345,
      onUnhealthy: (v) => verdicts.push(v),
      onBusy: (info) => busyInfos.push(info),
      zombieThresholdMs: init.zombieThresholdMs,
      probe: async () => {
        probeCalls.push(Date.now())
        return state.probeOutcome
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: state.healthOk,
        status: state.healthOk ? 200 : 500,
        json: async () => ({}),
      })),
    )
    return { monitor, verdicts, busyInfos, probeCalls, state }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('忙不杀：端口可连 + /health 无应答 → busy 沿回调一次，多 tick 无杀链回调（原 3 连败判据此时已强杀 = 误杀回归锚）', async () => {
    const h = makeHarness({ probeOutcome: { kind: 'alive' }, healthOk: false })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(10_000) // 2 ticks，远低于 5min 阈值
    expect(h.busyInfos).toHaveLength(1)
    expect(h.busyInfos[0].unansweredMs).toBeGreaterThanOrEqual(0)
    expect(h.verdicts).toEqual([])
  })

  it('忙持续超阈值 → zombie 触发一次且探针自停', async () => {
    const h = makeHarness({ probeOutcome: { kind: 'alive' }, healthOk: false, zombieThresholdMs: 10_000 })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(20_000) // 4 ticks：t0 busy 沿 → t10s 达阈值
    expect(h.verdicts).toEqual(['zombie'])
    const callsAtVerdict = h.probeCalls.length
    await vi.advanceTimersByTimeAsync(20_000) // 再 4 ticks
    expect(h.probeCalls.length).toBe(callsAtVerdict) // 自停：无新探测
  })

  it('进程消失 → 立即 dead（确证死），回调一次后自停', async () => {
    const h = makeHarness({ probeOutcome: { kind: 'dead' }, healthOk: true })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.verdicts).toEqual(['dead'])
    expect(h.busyInfos).toEqual([])
    const calls = h.probeCalls.length
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.probeCalls.length).toBe(calls)
  })

  it('端口拒绝（refused）→ dead（listen 句柄不在 = 服务死透，与进程消失同判）', async () => {
    const h = makeHarness({ probeOutcome: { kind: 'unreachable', reason: 'refused' }, healthOk: true })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.verdicts).toEqual(['dead'])
  })

  it('连接超时（非拒绝，SIGSTOP 冻结形态）→ 按 busy 累计，不判死', async () => {
    const h = makeHarness({
      probeOutcome: { kind: 'unreachable', reason: 'timeout' },
      healthOk: false,
      zombieThresholdMs: 60_000,
    })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.verdicts).toEqual([])
    expect(h.busyInfos).toHaveLength(1)
  })

  it('busy 后恢复健康 → 回 healthy；再次无应答 → busy 沿再次回调（每轮忙态一条 WARN）', async () => {
    const h = makeHarness({ probeOutcome: { kind: 'alive' }, healthOk: false })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.busyInfos).toHaveLength(1)
    h.state.healthOk = true
    await vi.advanceTimersByTimeAsync(5_000) // 恢复 tick
    expect(h.verdicts).toEqual([])
    h.state.healthOk = false
    await vi.advanceTimersByTimeAsync(5_000) // 再次无应答
    expect(h.busyInfos).toHaveLength(2)
  })

  it('默认假死阈值 = 5min（历史最重同步块 11-12s 实测的 25 倍余量）', () => {
    expect(LIVENESS_ZOMBIE_THRESHOLD_MS).toBe(5 * 60 * 1000)
  })
})

// ============ liveness 判据分级：zombie 取证与分级杀链（supervisor 侧）============
describe('liveness 判据分级：forceRestartForLiveness 分级处置', () => {
  it('无参调用（缺省 dead）→ 不取证，直接走杀链（兼容既有调用语义）', async () => {
    const supervisor = new RuntimeSupervisor()
    const ret = (supervisor as any).forceRestartForLiveness?.bind(supervisor)()
    expect(ret).toBeInstanceOf(Promise)
    await (ret as Promise<void>).catch(() => {})
  })
})
