/**
 * RuntimeSupervisor start() 并发串行化回归测试（AM2：TOCTOU 双 spawn 从根源修复）。
 *
 * 背景：start() 原实现幂等检查后 `await this.stop()` 再 spawn——toggle 入口
 * （restartForConfigChange）与手动启动链并发时双方都通过检查 →
 * 双 spawn 抢端口。修复 = promise 链串行队列（join 会让 toggle 拿到旧配置的
 * 启动结果，故串行而非共享）。
 *
 * 第二组 describe 覆盖 restartForConfigChange 本体（toggle 重启编排收敛进
 * supervisor）：广播时序（restarting 先于 stop）、队列并发不双 spawn、
 * 失败补 runtime-failed 终态广播后 reject 上抛。
 *
 * Mock 策略：stub 全链（spawn/stop/port/port-file/main-logger），spawnRuntimeProcess
 * 返回恒活 fake child。
 *
 * 运行：cd apps/electron/main && npx vitest run test/runtime-supervisor-start-concurrency.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock 必须在 import 之前（vitest hoist）
// 返回类型放宽为 unknown[]（对齐 remote-access-handlers.test.ts 先例）：
// 广播窗口桩（makeEventWindow）作为广播目标注入，不满足完整 BrowserWindow 形状
const getAllWindowsMock = vi.hoisted(() => vi.fn((): unknown[] => []))

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: getAllWindowsMock }),
  app: { getPath: vi.fn(() => '/tmp'), getName: vi.fn(() => 'test') },
}))

vi.mock('../supervisor/port-discoverer.js', () => ({
  findAvailablePort: vi.fn(async () => 43110),
  getPortOffset: vi.fn(() => 0),
}))

// spawnRuntimeProcess：返回恒活 fake child（exitCode 恒 null，幂等检查判活）
vi.mock('../supervisor/process-control.js', () => ({
  spawnRuntimeProcess: vi.fn(() => ({
    child: { exitCode: null, pid: 12345, on: vi.fn(), kill: vi.fn() },
    token: 'test-token',
    runtimeId: 'test-runtime-id',
  })),
  stopRuntimeProcess: vi.fn(async () => undefined),
}))

vi.mock('../supervisor/port-file.js', () => ({
  writePortFile: vi.fn(),
}))

// main-logger stub（真实现经 initMainLogger 落盘；本测试不触文件 IO）
vi.mock('../logs/main-logger.js', () => ({
  mainLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  readMainLogMaxBytes: vi.fn(() => 50 * 1024 * 1024),
  initMainLogger: vi.fn(),
  closeMainLogger: vi.fn(async () => undefined),
}))

import { RuntimeSupervisor } from '../supervisor/runtime-supervisor.js'
import { spawnRuntimeProcess, stopRuntimeProcess } from '../supervisor/process-control.js'

const spawnMock = vi.mocked(spawnRuntimeProcess)

/** 取第 n 次 spawn 时传入的 onReady 回调（模拟 IPC runtime-ready 消息到达） */
function onReadyOf(callIndex: number): () => void {
  const call = spawnMock.mock.calls[callIndex]
  if (!call?.[2]) throw new Error(`spawn call ${callIndex} has no onReady callback`)
  return call[2]
}

describe('RuntimeSupervisor start() 并发串行化（AM2）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    // 广播窗口桩恢复空集（防跨用例泄漏——clearAllMocks 不清 mockReturnValue）
    getAllWindowsMock.mockReturnValue([])
  })

  it('两个 start() 同时发起：spawnRuntimeProcess 只被调一次，两端拿到同一端口', async () => {
    const sup = new RuntimeSupervisor()
    const [p1, p2] = await Promise.all([sup.start(), sup.start()])
    expect(p1).toBe(43110)
    expect(p2).toBe(43110)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('前序 start 失败不毒化队列：后序 start 独立执行并成功 spawn', async () => {
    vi.mocked(spawnRuntimeProcess).mockImplementationOnce(() => {
      throw new Error('spawn failed: runtime bundle missing')
    })
    const sup = new RuntimeSupervisor()
    const first = sup.start()
    const second = sup.start()
    await expect(first).rejects.toThrow('runtime bundle missing')
    await expect(second).resolves.toBe(43110)
    // 前序失败后，后序 start 独立走完整时序（串行不跳过、失败不阻塞）
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})

describe('RuntimeSupervisor restartForConfigChange（toggle 重启编排收敛）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    getAllWindowsMock.mockReturnValue([])
  })

  /** 窗口桩：send 与 stopRuntimeProcess 都记入同一事件序列，断言广播时序。 */
  function makeEventWindow(events: string[]): { isDestroyed: () => boolean; webContents: { send: (channel: string) => void } } {
    return {
      isDestroyed: () => false,
      webContents: { send: (channel: string) => { events.push(`send:${channel}`) } },
    }
  }

  it('广播顺序：runtime-restarting 先于 stop，runtime-port 在 listen-ready 后（renderer 即时进等待态）', async () => {
    const events: string[] = []
    getAllWindowsMock.mockReturnValue([makeEventWindow(events)])
    vi.mocked(stopRuntimeProcess).mockImplementation(async () => { events.push('stop') })
    const sup = new RuntimeSupervisor()
    await sup.start()
    onReadyOf(0)()
    events.length = 0
    await sup.restartForConfigChange()
    // restarting 必须先于任何 stop（原 bridge 编排广播晚于动作，本用例锁定修复后的时序）
    expect(events[0]).toBe('send:runtime-restarting')
    expect(events.indexOf('send:runtime-restarting')).toBeLessThan(events.indexOf('stop'))
    // hotfix（2026-11-05 启动竞争）：成功广播从「restart 返回即发」改为 listen-ready
    // 信令驱动——restart 返回时只 spawn 完成（快照未组装），renderer 拉取进
    // waiting-runtime 等待态；ready 到达才广播 runtime-port，保证连接时端口已 listen
    expect(events).not.toContain('send:runtime-port')
    onReadyOf(1)()
    expect(events.at(-1)).toBe('send:runtime-port')
    // 真重启语义：stop 杀旧后必然重新 spawn（第二次），而非幂等短路复用旧实例
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('与手动 start 同窗口并发：经同一串行队列各走完整时序，不双 spawn', async () => {
    const sup = new RuntimeSupervisor()
    // start 先排队（真 spawn #1）→ restartForConfigChange 排队后执行（stop 杀旧 + 真spawn #2）
    const [startPort, restartPort] = await Promise.all([sup.start(), sup.restartForConfigChange()])
    expect(startPort).toBe(43110)
    expect(restartPort).toBe(43110)
    // 每任务恰好一次 spawn；第三次 spawn = 队列失效交错的双 spawn 回归信号
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('失败：reject 上抛且补 runtime-failed 终态广播，队列不被毒化', async () => {
    vi.mocked(spawnRuntimeProcess).mockImplementationOnce(() => {
      throw new Error('spawn failed: runtime bundle missing')
    })
    const channels: string[] = []
    getAllWindowsMock.mockReturnValue([{
      isDestroyed: () => false,
      webContents: { send: (channel: string) => { channels.push(channel) } },
    }])
    const sup = new RuntimeSupervisor()
    await expect(sup.restartForConfigChange()).rejects.toThrow('runtime bundle missing')
    // 协议完成：restarting 必有终态广播——失败落 runtime-failed（renderer 经既有
    // failed 态拿重试按钮），runtime-port 是成功专属；无第二次 restarting
    expect(channels).toEqual(['runtime-restarting', 'runtime-failed'])
    // 前序失败不毒化队列：后续 start 独立执行成功
    await expect(sup.start()).resolves.toBe(43110)
  })

  it('失败后 startError 记录真因（get-runtime-start-error 拉取兜底通道不落空）', async () => {
    vi.mocked(spawnRuntimeProcess).mockImplementationOnce(() => {
      throw new Error('spawn failed: runtime bundle missing')
    })
    const sup = new RuntimeSupervisor()
    await expect(sup.restartForConfigChange()).rejects.toThrow('runtime bundle missing')
    // toggle 失败刷新真因：renderer 错过 runtime-failed 广播窗口（boot 竞态 / 无窗口在场）
    // 时，startError 读侧（IPC get-runtime-start-error 的数据源）仍能拉到失败原因
    expect(sup.startError).toBe('spawn failed: runtime bundle missing')
    // 后续 start 成功 → 清除（startError 语义 = 最近一次失败，成功即非当前事实）
    await expect(sup.start()).resolves.toBe(43110)
    expect(sup.startError).toBeNull()
  })
})
