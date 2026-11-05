// runtime-supervisor.test.ts —— supervisor 运行时行为测试（无自动重启语义版）。
// 共同被测业务模块：`supervisor/runtime-supervisor.ts`。mock 全文件生效：
// electron / ../supervisor/port-discoverer.js / ../supervisor/process-control.js /
// ../supervisor/port-file.js / ../logs/crash-journal.js。
//
// 内容分节：
//   - classifyRuntimeExit 判别式真值表（crash-forensics D1）
//   - onRuntimeExit 登记清单接线 + 失败广播（exit 事件驱动）
//   - stopping 复位与无自动重启语义
//   - 启动失败真因记录（RD-3#2）与手动重启失败广播

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RuntimeSupervisor, classifyRuntimeExit } from '../supervisor/runtime-supervisor'
import { spawnRuntimeProcess } from '../supervisor/process-control'
import { type BrowserWindow } from 'electron'

// 广播窗口桩：捕获 webContents.send（runtime-error / runtime-port / runtime-failed 断言范围）
const getAllWindowsMock = vi.hoisted(() => vi.fn((): unknown[] => []))
// 登记清单断言范围：捕获 append 调用（接线单测只断言「写了什么行」，不触文件系统）
const crashJournalAppend = vi.hoisted(() => vi.fn())
// mock 必须在 import 之前（vitest hoist）
vi.mock('electron', () => {
  return {
    BrowserWindow: Object.assign(vi.fn(), { getAllWindows: getAllWindowsMock }),
    app: { getPath: vi.fn(() => '/tmp'), getName: vi.fn(() => 'test') },
  }
})
vi.mock('../supervisor/port-discoverer.js', () => ({
  findAvailablePort: vi.fn(async () => 43110),
  getPortOffset: vi.fn(() => 0),
}))
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
vi.mock('../logs/crash-journal.js', () => ({
  crashJournal: { append: crashJournalAppend },
  initCrashJournal: vi.fn(),
  getCrashJournalDir: vi.fn(() => '/tmp/taiji-test/crashes'),
}))

/** 广播窗口桩捕获的 send sink（installCaptureWindow 重置）。 */
let captureSink: string[] = []

/** 当前广播窗口桩捕获的全部 channel（按序）。 */
function sentChannels(): string[] {
  return captureSink
}

/** 给广播窗口桩注入一个 send 捕获窗口（每个用例 beforeEach 重置）。 */
function installCaptureWindow(): void {
  captureSink = []
  getAllWindowsMock.mockReturnValue([
    {
      isDestroyed: () => false,
      webContents: { send: (channel: string) => { captureSink.push(channel) } },
    },
  ])
}

describe('runtime-supervisor exit 分类与失败广播', () => {
  const spawnMock = vi.mocked(spawnRuntimeProcess)

  /** 取第 n 次 spawn 时传入的 onExit 回调（模拟子进程退出事件） */
  function onExitOf(callIndex: number): (code: number | null) => void {
    const call = spawnMock.mock.calls[callIndex]
    if (!call?.[1]) throw new Error(`spawn call ${callIndex} has no onExit callback`)
    return call[1]
  }

  /** 取第 n 次 spawn 时传入的 onReady 回调（模拟 IPC runtime-ready 消息到达） */
  function onReadyOf(callIndex: number): () => void {
    const call = spawnMock.mock.calls[callIndex]
    if (!call?.[2]) throw new Error(`spawn call ${callIndex} has no onReady callback`)
    return call[2]
  }

  /** 登记清单 append 的全部事件行（断言辅助） */
  function journalEvents(): Array<Record<string, unknown>> {
    return crashJournalAppend.mock.calls.map((c) => c[0] as Record<string, unknown>)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    installCaptureWindow()
  })

  describe('classifyRuntimeExit 判别式真值表（D1：非 before-quit 且 stopping=false 才 crash）', () => {
    it('before-quit 上下文：恒 suppressed（app 级退出不记 crash）', () => {
      expect(classifyRuntimeExit({ stopping: false, appQuitting: true })).toBe('suppressed')
      expect(classifyRuntimeExit({ stopping: true, appQuitting: true })).toBe('suppressed')
    })

    it('非 before-quit：stopping=true suppressed（主动 stop 的 exit），stopping=false crash', () => {
      // 主动 stop（window-all-closed 非 darwin 先 stop）的 exit 形态
      expect(classifyRuntimeExit({ stopping: true, appQuitting: false })).toBe('suppressed')
      // 真崩溃：stopping=false 恒 crash（意外死亡 = 非 before-quit 且非 stopping）
      expect(classifyRuntimeExit({ stopping: false, appQuitting: false })).toBe('crash')
    })
  })

  describe('onRuntimeExit 登记清单接线与失败广播', () => {
    it('真崩溃（exit 137）→ crash 行 + runtime-failed 广播，不触发第二次 spawn', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()

      onExitOf(0)(137)

      expect(journalEvents()).toEqual([
        { layer: 'runtime', event: 'crash', reason: 'process_exit', exitCode: 137 },
      ])
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(sup.isRunning).toBe(false)
      expect(sentChannels()).toEqual(['runtime-failed'])
    })

    it('信号杀死（exit null，kill -9 / OOM kill）→ crash 行 exitCode=null（schema 可空语义）', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()

      onExitOf(0)(null)

      expect(journalEvents()).toEqual([
        { layer: 'runtime', event: 'crash', reason: 'process_exit', exitCode: null },
      ])
    })

    it('主动 stop() 后 exit → 零写入 + 零广播（stopping 早退分支）', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()
      const exit = onExitOf(0)
      await sup.stop()

      exit(0)
      exit(137)

      expect(crashJournalAppend).not.toHaveBeenCalled()
      expect(sentChannels()).toEqual([])
    })

    it('before-quit 上下文（markAppQuitting，stop 尚未置位 stopping）内 exit → 零写入 + 零广播', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()
      sup.markAppQuitting()

      onExitOf(0)(137)

      expect(crashJournalAppend).not.toHaveBeenCalled()
      expect(sentChannels()).toEqual([])
    })

    it('start() 复位 before-quit 与 stopping 标记（防御非常规编排）', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()
      sup.markAppQuitting()
      expect((sup as unknown as { appQuitting: boolean }).appQuitting).toBe(true)
      expect((sup as unknown as { stopping: boolean }).stopping).toBe(false)
      await sup.start() // 非常规编排的防御复位（生产时序 start 先于 before-quit）
      expect((sup as unknown as { appQuitting: boolean }).appQuitting).toBe(false)
      expect((sup as unknown as { stopping: boolean }).stopping).toBe(false)
    })

    it('isRunning 在场性（before-quit shutdown 行判据）：start 后 true；exit 清 child 后 false；未启动 false', async () => {
      const sup = new RuntimeSupervisor()
      expect(sup.isRunning).toBe(false)
      await sup.start()
      expect(sup.isRunning).toBe(true)
      onExitOf(0)(137)
      expect(sup.isRunning).toBe(false)
    })
  })
});

// ======== 手动重启与无自动重启语义 ========
describe('runtime-supervisor 手动重启（无自动重启语义）', () => {
  const spawnMock = vi.mocked(spawnRuntimeProcess)

  /** 取第 n 次 spawn 时传入的 onExit 回调（模拟子进程退出事件） */
  function onExitOf(callIndex: number): (code: number | null) => void {
    const call = spawnMock.mock.calls[callIndex]
    if (!call?.[1]) throw new Error(`spawn call ${callIndex} has no onExit callback`)
    return call[1]
  }

  /** 取第 n 次 spawn 时传入的 onReady 回调（模拟 IPC runtime-ready 消息到达） */
  function onReadyOf(callIndex: number): () => void {
    const call = spawnMock.mock.calls[callIndex]
    if (!call?.[2]) throw new Error(`spawn call ${callIndex} has no onReady callback`)
    return call[2]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    installCaptureWindow()
  })

  it('start() 成功后 stopping 复位为 false（stop 清场残留不吞后续崩溃广播）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    expect((sup as unknown as { stopping: boolean }).stopping).toBe(false)
  })

  it('运行期崩溃（kill -9 → exit 137）→ 只广播 runtime-failed，无自动重启', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    expect(spawnMock).toHaveBeenCalledTimes(1)

    onExitOf(0)(137)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(sentChannels()).toEqual(['runtime-failed'])
  })

  it('主动 stop() 后 exit 不广播、不重启（既有语义不回归）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    const exit = onExitOf(0)
    await sup.stop()

    exit(0)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(sentChannels()).toEqual([])
  })

  it('手动重试失败（restartRuntime → start 抛错）→ runtime-failed 广播 + startError 刷新，不 reject', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    expect(sup.startError).toBeNull()

    // 运行期崩溃清 child（exit 广播第 1 条 runtime-failed）→ 手动重试 spawn 二次失败
    onExitOf(0)(137)
    vi.mocked(spawnRuntimeProcess).mockImplementationOnce(() => {
      throw new Error('respawn failed')
    })
    await sup.restartRuntime()

    expect(sup.startError).toBe('respawn failed')
    expect(sentChannels()).toEqual(['runtime-failed', 'runtime-failed'])
    // 不向上抛（bridge handler 不消费 rejection）
  })

  it('手动重试成功 → listen-ready 后 runtime-port 广播 + startError 清除', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    onExitOf(0)(137)

    await sup.restartRuntime()

    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(sup.startError).toBeNull()
    // hotfix（2026-11-05）：快照广播从「start 返回即发」改为 listen-ready 信令驱动——
    // 重试 spawn 完成时快照未组装（targetSnapshot 为 null），renderer 拉取进等待态；
    // ready 到达才广播，保证 renderer 连接时端口必然已 listen
    expect(sup.targetSnapshot).toBeNull()
    expect(sentChannels()).toEqual(['runtime-failed'])
    onReadyOf(1)()
    expect(sentChannels()).toEqual(['runtime-failed', 'runtime-port'])
    expect(sup.targetSnapshot).toEqual({
      seq: 1,
      runtimeId: 'test-runtime-id',
      port: 43110,
      token: 'test-token',
    })
  })
});

// ======== 启动失败真因记录（RD-3#2）========
describe('runtime-supervisor-start-error', () => {
  const spawnMock = vi.mocked(spawnRuntimeProcess)

  /** 最小 fake 窗口：捕获 webContents.send（runtime-error / runtime-port 推送断言范围） */
  function fakeWin(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn()
    return { win: { webContents: { send } } as unknown as BrowserWindow, send }
  }

  /** 下一次 spawn 抛错（模拟 bundle 缺失 / 端口占用等启动失败） */
  function failNextSpawn(message: string): void {
    spawnMock.mockImplementationOnce(() => {
      throw new Error(message)
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    installCaptureWindow()
  })

  it('startAndNotify 失败 → startError 记录 message + runtime-error 推送 + 返回 0', async () => {
    failNextSpawn('runtime bundle missing')
    const sup = new RuntimeSupervisor()
    const { win, send } = fakeWin()

    const port = await sup.startAndNotify(win)

    expect(port).toBe(0)
    expect(sup.startError).toBe('runtime bundle missing')
    expect(send).toHaveBeenCalledWith('runtime-error', { message: 'runtime bundle missing' })
  })

  it('失败后 start() 成功 → startError 清除（null = 当前无已知失败）', async () => {
    failNextSpawn('port occupied')
    const sup = new RuntimeSupervisor()
    await sup.startAndNotify(fakeWin().win)
    expect(sup.startError).toBe('port occupied')

    const port = await sup.start()
    expect(port).toBe(43110)
    expect(sup.startError).toBeNull()
  })

  it('失败后再次 start() 复用串行队列独立执行（前序失败不毒化后序）', async () => {
    failNextSpawn('stale failure')
    const sup = new RuntimeSupervisor()
    await sup.startAndNotify(fakeWin().win)
    expect(sup.startError).toBe('stale failure')

    // spawn 二次成功：完整时序重走，失败记录不再是当前事实
    await sup.start()
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(sup.startError).toBeNull()
  })
});

// ======== listen-ready 信令驱动快照广播（2026-11-05 hotfix：启动竞争修复）========
// 修复形态：旧时序「spawn 成功即组装快照并广播」下 renderer 比 listen 就绪早 ~1.3s
// 连接被拒（runtime spawn→listen 含同步迁移约 1.2-2.5s），0.12.4 删除 ws 退避重连后
// 首败即 failed 终态。新时序：spawn 只暂存材料，IPC runtime-ready 到达才组装快照 +
// 广播；renderer 首连拉取为 null 进 waiting-runtime，ready 广播到达即连（端口必已
// listen）。本组锁定：ready 前零快照零广播、ready 后组装+广播、迟到 ready 丢弃、
// restartRuntime 幂等分支的 ready 门。
describe('runtime-supervisor listen-ready 快照广播时序', () => {
  const spawnMock = vi.mocked(spawnRuntimeProcess)

  function onReadyOf(callIndex: number): () => void {
    const call = spawnMock.mock.calls[callIndex]
    if (!call?.[2]) throw new Error(`spawn call ${callIndex} has no onReady callback`)
    return call[2]
  }

  function onExitOf(callIndex: number): (code: number | null) => void {
    const call = spawnMock.mock.calls[callIndex]
    if (!call?.[1]) throw new Error(`spawn call ${callIndex} has no onExit callback`)
    return call[1]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    installCaptureWindow()
  })

  it('spawn 后 ready 前：快照未组装（targetSnapshot null）、零广播（renderer 拉取进 waiting-runtime）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.startAndNotify({ webContents: { send: vi.fn() } } as unknown as BrowserWindow)
    expect(sup.targetSnapshot).toBeNull()
    expect(sentChannels()).toEqual([])
    // 端口已分配（spawn 成功）：isRunning 为真、幂等检查可判活
    expect(sup.isRunning).toBe(true)
    expect(sup.port).toBe(43110)
  })

  it('ready 到达：组装快照（seq=1 全字段）+ 广播 runtime-port', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    onReadyOf(0)()
    expect(sup.targetSnapshot).toEqual({
      seq: 1,
      runtimeId: 'test-runtime-id',
      port: 43110,
      token: 'test-token',
    })
    expect(sentChannels()).toEqual(['runtime-port'])
  })

  it('seq 代数：ready 前的 spawn 不消耗代数（exit 清场后重起从 seq 1 重新计）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    onExitOf(0)(137) // ready 前崩溃：不组装快照、不消耗代数
    await sup.restartRuntime()
    onReadyOf(1)()
    expect(sup.targetSnapshot?.seq).toBe(1)
  })

  it('exit 早于 ready：迟到 ready 信令被丢弃（零快照、零 port 广播，failed 已由 exit 发）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    onExitOf(0)(137)
    onReadyOf(0)() // 迟到：pendingSpawn 已随 exit 清空
    expect(sup.targetSnapshot).toBeNull()
    expect(sentChannels()).toEqual(['runtime-failed'])
  })

  it('restartRuntime 幂等分支：ready 前 no-op 不广播（等 ready 信令）；ready 后广播同快照', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    // ready 前点重试：进程活着但未就绪——不广播（快照未组装，currentSnapshot 会 throw），
    // ready 到达时 onRuntimeReady 自会广播
    await sup.restartRuntime()
    expect(sentChannels()).toEqual([])
    onReadyOf(0)()
    expect(sentChannels()).toEqual(['runtime-port'])
    // ready 后点重试：幂等广播当前快照（renderer failed 态豁免幂等 → 同 seq 也重连）
    await sup.restartRuntime()
    expect(sentChannels()).toEqual(['runtime-port', 'runtime-port'])
  })
})
