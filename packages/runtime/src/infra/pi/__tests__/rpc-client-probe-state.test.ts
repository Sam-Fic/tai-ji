/**
 * RpcClient probeState 观测通道测试（pi-stall-detection D1 / ADR-0122 白名单口径扩展）。
 *
 * 锁定（覆盖文件级增量门槛暴露的新增行——probeState + sendCommandInternal 观测
 * 超时分支）：
 * - 响应在窗内到达：pending 配对 resolve → probeState 返回 data（窗口 timer 摘除）；
 * - 窗满（探测超时）：pendingRegistry.cancel 摘表 + reject（探测失败计失败），
 *   迟到响应查无表项返回 false，无副作用无 throw（AS8/RL8）；
 * - 业务通道（sendCommand）不携带超时窗（RL1 契约：probeState 是全类唯一携带
 *   超时的出站通道）。
 *
 * 策略：沿用 rpc-client-observability.test.ts 的 mock 骨架（node:child_process
 * + logger 模块）；stdin.write 捕获出站帧（id 配对）、stdout fake stream 注入
 * response 帧驱动 pending 配对。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/rpc-client-probe-state.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient } from '../rpc-client.js'

// ── Mocks ────────────────────────────────────────────────────────

type DataHandler = (data: Buffer) => void

/** fake stdout/stderr stream：捕获 'data' / 'error' handler，测试可 emitData 驱动 */
function makeFakeStream() {
  const dataHandlers: DataHandler[] = []
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data') dataHandlers.push(handler as DataHandler)
    }),
    resume: vi.fn(),
    destroy: vi.fn(),
    reset(): void {
      dataHandlers.length = 0
    },
    emitData(text: string): void {
      for (const h of [...dataHandlers]) h(Buffer.from(text, 'utf8'))
    },
  }
}

const stdoutStream = makeFakeStream()
const stderrStream = makeFakeStream()
let procExitHandlers: Array<(code: number | null) => void> = []

const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  once: vi.fn(),
  stdout: stdoutStream,
  stderr: stderrStream,
  stdin: {
    write: vi.fn((_line: string) => true),
    on: vi.fn(),
    once: vi.fn(),
  },
  kill: vi.fn(() => {
    queueMicrotask(() => {
      if (procExitHandlers.length === 0) return
      const handlers = procExitHandlers
      procExitHandlers = []
      handlers.forEach((h) => h(0))
    })
    return true
  }),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: () => fakeProc,
}))

vi.mock('@taiji/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})

vi.mock('@taiji/shared/paths', () => ({ getDataDir: () => '/mock/home/.taiji' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.taiji/sessions',
    getPiAgentDir: () => '/mock/home/.taiji/agent',
  }
})

vi.mock('../pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../../logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
  isPiCrashLogEnabled: () => false,
  writePiCrashLog: vi.fn(),
}))

// ── Helpers ──────────────────────────────────────────────────────

async function startClient(options: Record<string, unknown> = {}): Promise<RpcClient> {
  const { RpcClient } = await import('../rpc-client.js')
  const client = new RpcClient({ cwd: '/project', sessionId: 'sid-probe-1', ...options })
  await client.start()
  return client
}

/** 从 stdin 写入的出站帧解析 RPC id（配对 response 帧用）。 */
function lastSentId(): string {
  const frame = fakeProc.stdin.write.mock.calls.at(-1)![0] as string
  return (JSON.parse(frame) as { id: string }).id
}

/** 经 stdout 注入一条 pi response 帧（驱动 pendingRegistry.resolveResponse 配对）。 */
function emitResponse(id: string, data: Record<string, unknown>, success = true): void {
  stdoutStream.emitData(JSON.stringify({ type: 'response', id, success, data }) + '\n')
}

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient probeState 观测通道（ADR-0122 白名单：唯一携带超时的出站通道）', () => {
  beforeEach(() => {
    procExitHandlers.length = 0
    fakeProc.kill.mockClear()
    fakeProc.stdin.write.mockClear()
    stdoutStream.reset()
    stderrStream.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('响应在窗内到达：probeState 返回 get_state data（resolve 摘除窗口 timer）', async () => {
    vi.useFakeTimers()
    const client = await startClient()
    const promise = client.probeState(1_000)

    const id = lastSentId()
    emitResponse(id, { sessionFile: '/x/s.jsonl', model: 'm' })
    // 迟到窗不触发（timer 已在 resolve 分支摘除）；advance 让残余 timer 若有则点火暴露
    await vi.advanceTimersByTimeAsync(1_500)

    await expect(promise).resolves.toEqual({ sessionFile: '/x/s.jsonl', model: 'm' })
  })

  it('窗满（探测超时）：cancel 摘表 + reject；迟到响应无副作用无 throw', async () => {
    vi.useFakeTimers()
    const client = await startClient()
    const promise = client.probeState(20)
    const id = lastSentId()

    // 捕获 reject 防 unhandled rejection（迟到响应到达时 promise 已 settled）
    const settled = promise.then(
      () => 'resolved',
      (err: unknown) => (err as Error).message,
    )
    await vi.advanceTimersByTimeAsync(20)

    expect(await settled).toBe('get_state probe observation timeout (20ms)')

    // 迟到响应：pendingRegistry 已 cancel（查无表项返回 false，无副作用无 throw）
    expect(() => emitResponse(id, { sessionFile: '/late.jsonl' })).not.toThrow()
  })

  it('业务通道 sendCommand 无超时窗：正常响应 resolve，无 timer 悬挂（RL1 契约）', async () => {
    vi.useFakeTimers()
    const client = await startClient()
    const promise = client.sendCommand('abort')

    const id = lastSentId()
    emitResponse(id, {})
    await expect(promise).resolves.toMatchObject({ type: 'response', id })
    // 业务通道未注册任何 timer（窗值载体仅 probeState）
    expect(vi.getTimerCount()).toBe(0)
  })

  it('在途 probeState 遇进程退出：exit 链 rejectAll 走 pending reject 分支（窗口 timer 摘除）', async () => {
    vi.useFakeTimers()
    const client = await startClient()
    const settled = client.probeState(20).then(
      () => 'resolved',
      (err: unknown) => (err as Error).message,
    )
    // 探测在途（timer 已注册）→ 进程异常退出：exit handler rejectAll
    for (const h of [...procExitHandlers]) h(1)

    expect(await settled).toBe('pi process exited with code 1')
    // reject 分支已 clearTimeout：无悬挂 timer（迟到窗不再点火）
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stdin 写抛错（EPIPE）：cancel 摘表 + reject，窗口 timer 摘除', async () => {
    vi.useFakeTimers()
    const client = await startClient()
    fakeProc.stdin.write.mockImplementationOnce(() => {
      throw new Error('write EPIPE')
    })
    const settled = client.probeState(20).then(
      () => 'resolved',
      (err: unknown) => (err as Error).message,
    )

    expect(await settled).toContain('Failed to write to pi stdin')
    expect(vi.getTimerCount()).toBe(0)
  })
})
