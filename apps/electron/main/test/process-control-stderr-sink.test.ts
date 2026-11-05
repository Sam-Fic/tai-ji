/**
 * 打包态 stderr 兜底通道可观测性回归测试（code-harden 修复 1/2）。
 *
 * 覆盖两条此前无留痕的失败路径：
 * - 建流失败（getStderrSink catch）：logs 目录不可写（只读卷 / 权限）时 runtime 原生
 *   崩溃期 stderr 文件取证通道整体失效——console.error 必须留痕（含目标文件路径 +
 *   影响说明），spawn 生命周期不受影响；
 * - 背压超限丢弃（spawnRuntimeProcess stderr data handler）：首丢 warn 一条 + 累计
 *   计数，exit（spawn 收尾）汇总丢弃总数一行（可观测形态对齐轮转通道
 *   stderrRotationDropped 的「窗口结束合并 warn」）；零丢弃不留汇总行。
 *
 * Mock 策略（对齐 remote-access-spawn-args.test.ts 全链形态）：partial mock node:fs
 * （importOriginal 透传，仅 existsSync 可控——runtimeDist 判存在 true、sink 日志文件
 * 判不存在 false 跳过 stat 轮转分支）+ node:child_process spawn 返回 EventEmitter
 * fake child（stderr 可 emit data）+ main-logger stub；数据目录经 TAIJI_AGENT_DATA_DIR
 * 注入 mkdtemp tmp 自建自删（红线：禁触真实数据目录）。
 * 模块级单例（stderrSink/stderrSinkFile/stderrSinkBytes）经 vi.resetModules + 动态
 * import 在用例间隔离——sink 建流失败用例不得被前序用例已建成的 sink 污染。
 *
 * 运行：cd apps/electron/main && npx vitest run test/process-control-stderr-sink.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 与 process-control.ts 打包分支的背压上限同值（模块内局部常量，未导出） */
const WRITE_BUFFER_LIMIT = 1024 * 1024

const spawnMock = vi.hoisted(() => vi.fn())

const electronMock = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getAppPath: () => '/fake/app-path',
  },
}))

// existsSync 可控桩：runtimeDist 判存在（spawn 打包分支要求），
// sink 日志文件判不存在（跳过 getStderrSink 的 stat 超帽轮转分支，不属本测试）
const existsSyncMock = vi.hoisted(() =>
  vi.fn((path: string) => !String(path).endsWith('electron-runtime-stderr.log')),
)

vi.mock('electron', () => ({ app: electronMock.app }))

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFileSync: vi.fn(() => ''),
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsSyncMock,
}))

vi.mock('../logs/main-logger.js', () => ({
  mainLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  readMainLogMaxBytes: vi.fn(() => 50 * 1024 * 1024),
  initMainLogger: vi.fn(),
  closeMainLogger: vi.fn(async () => undefined),
}))

/** fake child：EventEmitter 形态（stdout/stderr 可 emit data、可 emit exit 触发收尾汇总） */
type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  exitCode: number | null
  killed: boolean
  kill: (signal?: string) => boolean
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 42424
  child.exitCode = null
  child.killed = false
  child.kill = () => true
  return child
}

// 动态 import：确保 mock 先于模块加载生效；配合 vi.resetModules 隔离模块级单例
async function loadModule() {
  return await import('../supervisor/process-control.js')
}

describe('打包态 stderr 兜底通道可观测性（spawnRuntimeProcess 全链，打包分支）', () => {
  let tmpDataDir: string
  let originalResourcesPath: PropertyDescriptor | undefined
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'stderr-sink-obs-'))
    // getDataDir()（真实实现）经该 env 动态推导到 tmp（禁触真实数据目录）
    process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir
    // 打包分支 runtimeDist 存在性检查与 resources 路径推导依赖该属性（Electron 注入，Node 测试环境缺省）
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { value: '/res', configurable: true })
    electronMock.app.isPackaged = true
    existsSyncMock.mockImplementation(
      (path: string) => !String(path).endsWith('electron-runtime-stderr.log'),
    )
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeFakeChild())
    vi.resetModules()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    } else {
      // 测试环境原本无该属性（Node 无 Electron 注入），删除恢复原状
      delete (process as unknown as Record<string, unknown>).resourcesPath
    }
    delete process.env.TAIJI_AGENT_DATA_DIR
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    await Promise.resolve()
  })

  it('建流失败（logs 路径为普通文件，目录建不出来）：console.error 留痕含文件路径与影响说明，spawn 不受影响', async () => {
    // 模拟 logs 目录不可写：在 <dataDir>/logs 位置放普通文件 → mkdirSync(recursive) 抛 EEXIST
    writeFileSync(join(tmpDataDir, 'logs'), 'not a directory', 'utf-8')
    const { spawnRuntimeProcess } = await loadModule()
    const onExit = vi.fn()
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const spawned = spawnRuntimeProcess(3310, onExit)

    // spawn 正常返回：sink 失败不影响 supervisor 生命周期编排（onExit 未被消费）
    expect(spawned.child).toBe(child)
    child.stderr.emit('data', Buffer.from('native crash evidence'))
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const line = String(errorSpy.mock.calls[0]?.[0])
    expect(line).toContain('electron-runtime-stderr.log')
    expect(line).toContain('stderr 文件取证不可用，仅进程控制台可见')
    expect(onExit).not.toHaveBeenCalled()
  })

  it('背压超限：首丢 warn 一条 + 后续静默，exit 汇总丢弃总数', async () => {
    const { spawnRuntimeProcess, flushStderrSink } = await loadModule()
    const onExit = vi.fn()
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    spawnRuntimeProcess(3310, onExit)

    // 第一块 1MB+1 字节：照常写入（超限判定在累加之前，本块自身不触发丢弃）
    child.stderr.emit('data', Buffer.alloc(WRITE_BUFFER_LIMIT + 1, 0x61))
    expect(warnSpy).not.toHaveBeenCalled()
    // 第二、三块：超限丢弃——首丢 warn 一条，后续逐 chunk 静默（热路径不刷屏）
    child.stderr.emit('data', Buffer.from('late-1'))
    child.stderr.emit('data', Buffer.from('late-2'))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('dropping further stderr')

    // spawn 收尾（exit）：丢弃总数汇总一行
    child.emit('exit', 1)
    expect(onExit).toHaveBeenCalledWith(1)
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(String(warnSpy.mock.calls[1]?.[0])).toContain('dropped 2 stderr chunk(s)')

    // flush 为 best-effort 不等待 IO 排空（时间机制删除裁决：end+destroy 即返回），
    // 缓冲数据不保证落盘——「丢弃块未落盘 / 首块落盘字节数」不再构成可断言的同步性质，
    // 磁盘字节数断言随之退役。flush 仅卫生收尾（流关闭、无 fd 悬挂），不抛错即符合契约。
    await flushStderrSink()
  })

  it('未超限：无背压 warn，exit 无汇总行（零丢弃不留痕）', async () => {
    const { spawnRuntimeProcess, flushStderrSink } = await loadModule()
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    spawnRuntimeProcess(3310)

    child.stderr.emit('data', Buffer.from('small chunk'))
    child.emit('exit', 0)

    expect(warnSpy).not.toHaveBeenCalled()
    // 卫生收尾：真实 WriteStream 已建成，flush 关闭防 fd 悬挂
    await flushStderrSink()
  })
})

// ── listen-ready 信令透传（2026-11-05 hotfix：启动竞争修复）──────────
// runtime 在 WS listen 成功后经 IPC 发 {type:'runtime-ready'}；spawnRuntimeProcess
// 挂 child 'message' 监听，仅透传该类型给 onReady 回调（supervisor 收齐才组装快照 +
// 广播）。本组锁定：透传行为、非 ready 消息忽略、stdio 第 4 项 ipc 通道开设。
describe('spawnRuntimeProcess listen-ready 信令透传', () => {
  let tmpDataDir: string
  let originalResourcesPath: PropertyDescriptor | undefined
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'ready-signal-'))
    process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { value: '/res', configurable: true })
    electronMock.app.isPackaged = true
    existsSyncMock.mockImplementation(
      (path: string) => !String(path).endsWith('electron-runtime-stderr.log'),
    )
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeFakeChild())
    vi.resetModules()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    } else {
      delete (process as unknown as Record<string, unknown>).resourcesPath
    }
    delete process.env.TAIJI_AGENT_DATA_DIR
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    await Promise.resolve()
  })

  it('IPC runtime-ready 消息 → onReady 回调触发；非 ready 消息忽略', async () => {
    const { spawnRuntimeProcess, flushStderrSink } = await loadModule()
    const onReady = vi.fn()
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    spawnRuntimeProcess(3310, vi.fn(), onReady)

    child.emit('message', { type: 'runtime-ready' })
    expect(onReady).toHaveBeenCalledTimes(1)
    // 非 ready 类型（含畸形消息）不触发
    child.emit('message', { type: 'other' })
    child.emit('message', null)
    child.emit('message', 'plain string')
    expect(onReady).toHaveBeenCalledTimes(1)

    await flushStderrSink()
  })

  it('stdio 开设 ipc 通道（第 4 项）——ready 信令的传输前提', async () => {
    const { spawnRuntimeProcess, flushStderrSink } = await loadModule()
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    spawnRuntimeProcess(3310)

    const stdio = spawnMock.mock.calls[0]?.[2]?.stdio
    expect(stdio).toEqual(['pipe', 'pipe', 'pipe', 'ipc'])

    await flushStderrSink()
  })
})
