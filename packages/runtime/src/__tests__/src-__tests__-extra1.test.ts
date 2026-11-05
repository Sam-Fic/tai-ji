import { translate } from '../infra/pi/event-adapter.js';
import type { PiEvent, PiSessionEntry } from '../infra/pi/pi-protocol.js';
import { ProcessManager } from '../infra/pi/process-manager.js';
import type { IMessageBroker, ISessionService } from '../interfaces.js';
import { IProcessManager, type IPiEngine } from '../services/ports/pi-engine.js';
import { EventInterpreter } from '../services/session/event-interpreter.js';
import { createSessionDeliveryRegistry } from '../services/session/session-delivery-registry.js';
import { SessionManagerHandler } from '../transport/session-manager-handler.js';
import type { SegmentsMetadataFile, ServerMessage } from '@taiji/shared';
import { SESSION_MANAGER_MARKER, type SessionManagerAction } from '@zhushanwen/extension-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/__tests__/process-manager-exit.test.ts
// ======================================================================

// ── Mocks（与 rpc-client-bash.test.ts 同构）──────────────────────

const procExitHandlers: Array<(code: number | null) => void> = []


const fakeProc = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  once: vi.fn(),
  stdout: { on: vi.fn(), resume: vi.fn(), destroy: vi.fn() },
  stderr: { on: vi.fn() },
  stdin: {
    write: vi.fn(() => true),
    once: vi.fn(),
    // RT-2#1 起 rpc-client 在源头接线 stdin 流错误（stdin.on('error')），mock 面同步补齐
    on: vi.fn(),
  },
  // 模拟真实进程：收到 SIGTERM/SIGKILL 后异步死亡（信号致死 → exit code null）。
  // 让 destroySession 的 kill() 快速收尾（不必等 2s SIGKILL 兜底超时）。
  kill: vi.fn((signal?: string) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      queueMicrotask(() => {
        for (const h of [...procExitHandlers]) h(null)
      })
    }
    return true
  }),
  pid: 12345,
}


vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: () => fakeProc,
  // findPiExecutable 的 PATH 探测（execSync('which pi')）：抛错走 fallback，不执行真实命令
  execSync: () => {
    throw new Error('execSync mocked: not found')
  } }
})


vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  // findPiExecutable 所有探测点（dev resources / nvm / common locations）均未命中 → 走 'pi' fallback
  return { ...actual, existsSync: () => false, readdirSync: () => [] }
})


vi.mock('@taiji/shared', async (importOriginal) => {
  // U3 起 rpc-client/process-manager 链路经 infra/spawn-env 门面消费 shared 的
  // buildOutboundChildEnv；mock 需保留真实导出，仅收窄白名单前缀获得可控基座
  const actual = await importOriginal<typeof import('@taiji/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})


vi.mock('@taiji/shared/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared/paths')>()
  return { ...actual, getDataDir: () => '/mock/home/.taiji' }
})


vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})


vi.mock('../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.taiji/sessions',
    getPiAgentDir: () => '/mock/home/.taiji/agent',
  }
})


vi.mock('../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})


vi.mock('../infra/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/logger.js')>()
  return { ...actual, createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  // 7b17e240f：retargetSessionLog（rekey 迁 tee）的 import 面同步——no-op 即可，
  // 本测试不校验迁移行为
  migratePiSessionLogTree: () => {},
  // u5b D6-④：rpc-client 新增 import 的内存快照采集（mock 面随源码 import 面同步）
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
  isPiCrashLogEnabled: () => false,
  // 族③根因修复（W3.5）：withEphemeralPi finally 的 ephemeral 树回收——mock 面随
  // process-manager import 面同步（本测试不走该路径，no-op 即可）
  EPHEMERAL_SESSION_ID_PREFIX: 'ephemeral-',
  removeEphemeralSessionTree: () => {}, }
})


// ── Helpers ──────────────────────────────────────────────────────

/** 模拟 pi 进程异常死亡：OS 发出 exit 事件（kill -9 → code null） */
function emitProcExit(code: number | null = null): void {
  for (const h of [...procExitHandlers]) h(code)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('process-manager-exit', () => {
// ── Tests ────────────────────────────────────────────────────────

describe('ProcessManager onExit 死亡通知', () => {
  let pm: ProcessManager

  beforeEach(async () => {
    // R3 隔离：本测试的 hermetic 前提是 findPiExecutable 走 'pi' fallback，但该函数
    // 先读 process.env.TAIJI_AGENT_PACKAGED 判打包分支（find-pi-executable.ts:26），
    // 打包版太极的 agent 会话内执行 vitest 时该变量泄入测试进程（P1 同款机制）→
    // findPackagedPi throw。显式压平为非打包态，维持设计意图。
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '')
    procExitHandlers.length = 0
    fakeProc.kill.mockClear()
    pm = new ProcessManager('/mock/project-root')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rekey 后进程异常退出：清理两个 Map，onSessionExit 收到 rekey 后的 id（非 tempId）', async () => {
    const exitEvents: Array<{ sessionId: string; code: number | null; stderr: string }> = []
    pm.onSessionExit((sessionId, code, stderr) => exitEvents.push({ sessionId, code, stderr }))

    // create 路径：tempId spawn → pi 返回真实 sessionId 后 rekey 改键
    await pm.createSession('temp-id-1', '/project')
    pm.rekey('temp-id-1', 'pi-session-id-real')
    expect(pm.hasClient('pi-session-id-real')).toBe(true)

    emitProcExit(null) // 模拟 kill -9

    // Map 清理：按当前 id（rekey 后）删除，无残留
    expect(pm.getClient('pi-session-id-real')).toBeUndefined()
    expect(pm.hasClient('pi-session-id-real')).toBe(false)
    expect(pm.getClient('temp-id-1')).toBeUndefined()
    expect(pm.size).toBe(0)

    // 死亡通知必须带真实 id——闭包捕获的 tempId 正是僵尸 session 根因
    expect(exitEvents).toEqual([{ sessionId: 'pi-session-id-real', code: null, stderr: '' }])
  })

  it('intentional destroy：destroySession 后的 exit 事件不触发 onSessionExit', async () => {
    const exitEvents: Array<{ sessionId: string; code: number | null; stderr: string }> = []
    pm.onSessionExit((sessionId, code, stderr) => exitEvents.push({ sessionId, code, stderr }))

    await pm.createSession('s1', '/project')
    expect(pm.hasClient('s1')).toBe(true)

    // destroySession：先删 Map 再 kill（kill mock 异步触发 exit，属主动清理路径）
    await pm.destroySession('s1')
    expect(pm.hasClient('s1')).toBe(false)

    // 主动 kill 的 exit（异步已触发）+ 迟到的重复 exit 均不得通知上层
    await Promise.resolve() // 排空 kill mock 的 queueMicrotask
    emitProcExit(null)
    emitProcExit(1)

    expect(exitEvents).toEqual([])
  })

  it('exit 回调逐个隔离：单 listener 抛错不阻断其余 listener（code-harden RT-4#1）', async () => {
    const received: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 上层多播：listener A 抛错（模拟收敛链异常）不得连坐 listener B 的死亡通知
      pm.onSessionExit(() => { throw new Error('listener A exploded') })
      pm.onSessionExit((sessionId) => { received.push(sessionId) })

      await pm.createSession('s1', '/project')
      emitProcExit(null)

      expect(received).toEqual(['s1'])
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('exit callback failed'), expect.any(String))
    } finally {
      errorSpy.mockRestore()
    }
  })
})
});
// ← src/__tests__/session-history-incremental.test.ts
//   （turn-boundary-index 重写：缓存容量帽/增量合并/后台全量任务/reclaim 驱逐随 D4
//   一次退役；本段改载 SessionHistoryReader 索引路径集成——真实 JSONL fixture +
//   PiSessionStore 真实 convertHistory 转换链，定位经 scanSessions mock 指向 fixture）
// ======================================================================

import type { ISessionStore } from '../services/ports/session.js'
const { SessionHistoryReader } = await import('../services/session/history-reader.js')
const { PiSessionStore } = await import('../infra/pi/session-store.js')
const { scanTurnBoundariesForward, verifyTurnBoundaries } = await import('../infra/pi/turn-index-scanner.js')
const fsExtra = await import('node:fs')
const osExtra = await import('node:os')
const fsPath = await import('node:path')

/** 唯一 sessionId（防共享 tmp dataDir 上磁盘索引/内存态的跨用例污染）。 */
let idxSeq = 0
function uniqueIdxSid(prefix: string): string {
  return `${prefix}-idx-${++idxSeq}`
}

/** 写会话 JSONL 行（pi message entry 形态，message 体透传）。 */
function idxEntryLine(id: string, message: unknown): string {
  return JSON.stringify({ type: 'message', id, parentId: null, timestamp: '2026-11-03T00:00:00.000Z', message })
}

/**
 * 索引路径集成直构环境：定位经 scanSessions mock 指向 mkdtemp fixture（fs-guard 白名单
 * 内），转换链 = PiSessionStore.convertHistory 真实实装（消息语义断言不落 mock）。
 */
function makeIdxReader(sessionId: string, filePath: string) {
  const realStore = new PiSessionStore()
  const sessionStore = {
    scanSessions: vi.fn(() => [{ id: sessionId, filePath }]),
    convertHistory: realStore.convertHistory.bind(realStore),
  } as unknown as ISessionStore
  const reader = new SessionHistoryReader({
    pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
    sessionStore,
    scanner: { scanTurnBoundariesForward, verifyTurnBoundaries },
  })
  return { reader, sessionStore }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-history-reader-index（索引路径集成，真实转换链）', () => {
const fixtureDirs: string[] = []
afterEach(() => {
  while (fixtureDirs.length > 0) {
    const dir = fixtureDirs.pop()
    if (dir !== undefined) fsExtra.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

it('全类型窗口回放：user/assistant(toolCall)/toolResult/compaction/custom 经索引窗口 + 真实 convertHistory 还原（原 Fix-1/Fix-7 转换语义的文件链等价覆盖）', async () => {
  const sessionId = uniqueIdxSid('types')
  const dir = fsExtra.mkdtempSync(fsPath.join(osExtra.tmpdir(), 'history-reader-idx-'))
  fixtureDirs.push(dir)
  const filePath = fsPath.join(dir, `${sessionId}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'session', id: sessionId, version: 3 }),
    idxEntryLine('u1', { role: 'user', content: [{ type: 'text', text: 'question' }], timestamp: 1 }),
    idxEntryLine('c1', { type: 'custom', customType: 'taiji.client-msg-id', data: { clientUuid: 'u-1', userEntryId: 'u1' } }),
    idxEntryLine('e2', { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }], timestamp: 2 }),
    idxEntryLine('e3', { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'RESULT-OUTPUT' }], timestamp: 3 }),
    idxEntryLine('e4', { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 4 }),
    idxEntryLine('e5', { role: 'user', content: [{ type: 'text', text: 'second' }], timestamp: 5 }),
    JSON.stringify({ type: 'compaction', id: 'e6', parentId: 'e5', timestamp: '2026-11-03T00:00:01.000Z', summary: 'compacted-history', tokensBefore: 1000 }),
  ]
  fsExtra.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
  const { reader } = makeIdxReader(sessionId, filePath)

  const result = await reader.getHistory(sessionId)

  // 窗口从 user 边界开始（AX5：正常 assistant 与对应 toolResult 同 turn，无需跨窗口补读）
  expect(result.truncated).toBe(false)
  expect(result.loadedTurns).toBe(2)
  expect(result.totalTurnsEstimate).toBe(2)
  // 工具配对：toolCall 输出回填（同 turn 内 toolResult，无孤儿）
  const assistant = result.messages.find((m) => m.toolCalls?.length)
  expect(assistant?.toolCalls?.[0]).toMatchObject({ id: 't1', output: 'RESULT-OUTPUT' })
  // compaction entry 并入：system 消息语义保持（原 Fix-7 的文件链形态）
  const compactionMsg = result.messages.find((m) => m.compactionSummary !== undefined)
  expect(compactionMsg?.role).toBe('system')
  expect(compactionMsg?.content).toBe('compacted-history')
  expect(compactionMsg?.compactionSummary?.tokensBefore).toBe(1000)
})

it('cursor 翻页：锚前窗口 + cursor turn 只进校验集合；锚为最早 turn → 空页（翻页到头）', async () => {
  const sessionId = uniqueIdxSid('cursor')
  const dir = fsExtra.mkdtempSync(fsPath.join(osExtra.tmpdir(), 'history-reader-idx-'))
  fixtureDirs.push(dir)
  const filePath = fsPath.join(dir, `${sessionId}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'session', id: sessionId, version: 3 }),
    idxEntryLine('u1', { role: 'user', content: [{ type: 'text', text: 'q1' }], timestamp: 1 }),
    idxEntryLine('e2', { role: 'assistant', content: [{ type: 'text', text: 'r1' }], timestamp: 2 }),
    idxEntryLine('u2', { role: 'user', content: [{ type: 'text', text: 'q2' }], timestamp: 3 }),
    idxEntryLine('e4', { role: 'assistant', content: [{ type: 'text', text: 'r2' }], timestamp: 4 }),
  ]
  fsExtra.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
  const { reader } = makeIdxReader(sessionId, filePath)
  await reader.getHistory(sessionId) // 先建索引

  const page = await reader.getHistory(sessionId, { cursor: 'u2', limitTurns: 2 })
  // 真实 convertHistory 保留结构化 content（不拼接 text parts），按 text part 提取断言
  const textOf = (m: { content: unknown }): string =>
    Array.isArray(m.content) ? m.content.map((c) => (typeof c === 'object' && c !== null && 'text' in c ? String((c as { text: unknown }).text) : '')).join('') : String(m.content)
  expect(page.messages.map(textOf)).toEqual(['q1', 'r1'])
  expect(page.truncated).toBe(false)
  expect(page.loadedTurns).toBe(1)
  expect(page.totalTurnsEstimate).toBe(2) // 索引精确总数（不再随窗口退化为前缀计数）

  const head = await reader.getHistory(sessionId, { cursor: 'u1' })
  expect(head.messages).toEqual([])
  expect(head.truncated).toBe(false)
})
});


// ======================================================================
// ← src/__tests__/session-manager-e2e-probe.test.ts
// ======================================================================

/** pi stdout JSONL 行的边界解析形态（与 rpc-client 的行解析边界一致，窄化到本探针实际用到的子集） */
interface UiResponseWireLine {  // oe-exempt:20261027:test:
  type: string
  id: string
  value?: string
  cancelled?: boolean
}


/**
 * 模拟 pi 子进程 IO 层。stdinLines 是 runtime 回写 pi stdin 的 JSONL 行缓冲；
 * sendExtensionUiResponse 的 wire 映射与真实 rpc-client（rpc-client.ts）一致——
 * 本探针只覆盖 handler 会走到的两个分支：null → cancelled / select → value。
 */
class FakePiProcessIo {
  readonly stdinLines: string[] = []

  sendExtensionUiResponse(id: string, response: unknown, _method?: string): void {
    const payload: UiResponseWireLine = response === null
      ? { type: 'extension_ui_response', id, cancelled: true }
      : { type: 'extension_ui_response', id, value: String(response) }
    this.stdinLines.push(JSON.stringify(payload))
  }
}


function makeSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    label: 'fake-session',
    cwd: '/test/cwd',
    status: 'active',
    lastActiveAt: 1_755_000_000_000,
    // 归属校验默认材料：发起方一律 'sid-parent'，目标 s1 默认是其 managed child
    spawnSource: 'agent',
    parentAgentSessionId: 'sid-parent',
    ...overrides,
  }
}


/** fake pi client：delivery port.send 的终点（ensureActive 返回值） */
function makeFakeClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}


/** fake session 运行时视图：delivery isIdle 判定 + D7 置位副作用的落点 */
function makeFakeSessionView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    cwd: '/test/cwd',
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    lastActiveAt: 1_755_000_000_000,
    // W3：handler 的 modelId 读点从 summary 改到注册表记录（IManagedSessionView.modelId
    // 双写缓存），fake 记录带同值缓存。
    modelId: 'openai/gpt-4',
    ...overrides,
  }
}


/** SessionService 数据层 fake：管理 action 服务方法的默认返回值（形状对齐
 * ISessionService 契约；create 为裸 vi.fn() 无默认返回，由用例侧 mockReturnValue 提供） */
function makeFakeSessionService(overrides: Partial<ISessionService> = {}): ISessionService {
  return {
    create: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ blocked: false, rejected: false }),
    ensureActive: vi.fn().mockResolvedValue(makeFakeClient()),
    getSession: vi.fn().mockReturnValue(makeFakeSessionView()),
    getHistory: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      truncated: false,
    }),
    getSummary: vi.fn().mockReturnValue(makeSummary()),
    listPersistedSessions: vi.fn().mockReturnValue([
      { cwd: '/test/cwd', sessions: [makeSummary({ id: 'agent-1', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }), makeSummary({ id: 'user-1', spawnSource: 'user' })] },
    ]),
    abort: vi.fn().mockResolvedValue(undefined),
    // 受理成功后清旧终态 sidecar（session-manager-send-sidecar-stale）
    clearSessionOutcome: vi.fn(),
    getRpcClient: vi.fn(),
    getActiveSessionIds: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as ISessionService
}


/** 构造 pi stdout 上的 extension_ui_request JSONL 行（session-manager extension 的序列化形态） */
function buildUiRequestLine(requestId: string, action: string, params: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'extension_ui_request',
    id: requestId,
    method: 'select',
    title: SESSION_MANAGER_MARKER,
    options: [JSON.stringify({ action, params })],
  })
}


/** 构造 malformed 请求行：options[0] 不是合法 JSON（U4-E3 场景） */
function buildMalformedUiRequestLine(requestId: string): string {
  return JSON.stringify({
    type: 'extension_ui_request',
    id: requestId,
    method: 'select',
    title: SESSION_MANAGER_MARKER,
    options: ['invalid json'],
  })
}


interface E2ePipeline {  // oe-exempt:20261027:test:
  pi: FakePiProcessIo
  /** dispatch 单条 pi stdout JSONL 行：解析 → 真实 translate → 真实 interpret → 等 handler 完成 */
  dispatch(piStdoutLine: string): Promise<void>
  /** 前端 UI 超时注册入口（session-manager 路径不应触发——「不弹前端对话框」断言用） */
  onExtensionUIRequest: ReturnType<typeof vi.fn>
}


/**
 * 组装 e2e 链路。接线与组合根一致（server.ts 的 SessionManagerHandler 构造 +
 * handleSessionManagerRequest fire-and-forget 委托 + EventInterpreter opts 注入），
 * 只把 pi 子进程 IO 与 SessionService 换成 fake。sd-u5 起 delivery 用真实 registry
 * 装配（fake sessionService 提供 getSession/ensureActive 材料层）。
 */
function makeE2ePipeline(sessionService: ISessionService): E2ePipeline {
  const pi = new FakePiProcessIo()
  const onExtensionUIRequest = vi.fn()
  const delivery = createSessionDeliveryRegistry({
    getSession: (sid) => sessionService.getSession(sid),
    ensureActive: (sid) => sessionService.ensureActive(sid),
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () => null,
  })
  const handler = new SessionManagerHandler({
    sessionService,
    delivery,
    sendExtensionUiResponse: (sessionId, requestId, response, method) =>
      pi.sendExtensionUiResponse(requestId, response, method),
    broadcastSessionList: () => {},
  })
  let handling: Promise<void> = Promise.resolve()
  const interpreter = new EventInterpreter('sid-parent', {
    send: () => {},
    onExtensionUIRequest,
    onSessionManagerRequest: (requestId, sessionId, action, params) => {
      // fire-and-forget 委托（与 server.handleSessionManagerRequest 一致）；promise 暴露给测试 await
      handling = handler.handle(requestId, sessionId, action as SessionManagerAction | '__malformed__', params)
    },
  })
  return {
    pi,
    onExtensionUIRequest,
    async dispatch(piStdoutLine: string): Promise<void> {
      const event = JSON.parse(piStdoutLine) as PiEvent
      interpreter.interpret(translate(event, 'sid-parent'))
      await handling
    },
  }
}


/** 读取 runtime 回写的唯一一条 extension_ui_response 行并解析（多于一条即 fail） */
function readSingleResponse(pi: FakePiProcessIo): UiResponseWireLine {
  expect(pi.stdinLines, `expected exactly 1 response line, got: ${JSON.stringify(pi.stdinLines)}`).toHaveLength(1)
  const parsed = JSON.parse(pi.stdinLines[0]) as UiResponseWireLine
  expect(parsed.type).toBe('extension_ui_response')
  return parsed
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-manager-e2e-probe', () => {
describe('U4-E1 create e2e probe', () => {
  it('create 全链路：marker request → 真实 handler 创建 session + 直投初始 prompt + 回写 sessionId', async () => {
    const client = makeFakeClient()
    const sessionService = makeFakeSessionService({
      create: vi.fn().mockResolvedValue(makeSummary({ id: 'child-1', spawnSource: 'agent' })),
      ensureActive: vi.fn().mockResolvedValue(client),
    })
    const pipeline = makeE2ePipeline(sessionService)

    await pipeline.dispatch(buildUiRequestLine('req-create', 'create', {
      cwd: '/test/cwd', label: 'E2E 测试执行', prompt: 'run the suite',
    }))

    // create 以 spawnSource='agent' + parentAgentSessionId=父 session 调用（服务端注入，不信任请求侧）
    expect(sessionService.create).toHaveBeenCalledWith('/test/cwd', 'E2E 测试执行', expect.objectContaining({
      spawnSource: 'agent',
      parentAgentSessionId: 'sid-parent',
    }))
    // 初始 prompt 直投到新 session（sd-u5：delivery.sendDirect → ensureActive + prompt，不走内核队列）
    expect(sessionService.ensureActive).toHaveBeenCalledWith('child-1')
    expect(client.prompt).toHaveBeenCalledWith('run the suite', undefined, undefined)
    // 回写 select value 通道，结果 JSON 含 sessionId/status
    const resp = readSingleResponse(pipeline.pi)
    expect(resp.cancelled).toBeUndefined()
    expect(JSON.parse(resp.value as string)).toEqual(expect.objectContaining({ sessionId: 'child-1', status: 'created' }))
    // 不触发前端 UI（不经 renderer 对话框）
    expect(pipeline.onExtensionUIRequest).not.toHaveBeenCalled()
  })
})
describe('U4-E2 manage e2e probe', () => {
  it('marker 翻译：select+SESSION_MANAGER_MARKER → session-manager-ui kind（强类型 action/params）', () => {
    const events = translate(
      JSON.parse(buildUiRequestLine('req-send', 'send', { sessionId: 's1', prompt: 'hello' })) as PiEvent,
      'sid-parent',
    )
    const uiEvent = events.find((e) => e.kind === 'session-manager-ui')
    expect(uiEvent).toBeDefined()
    if (uiEvent?.kind !== 'session-manager-ui') return
    expect(uiEvent.action).toBe('send')
    expect(uiEvent.params).toEqual({ sessionId: 's1', prompt: 'hello' })
    // 不发前端广播：session-manager 请求由 handler 内部消化，extension.ui_request 广播
    // 会被前端 CompanionBand 渲染成无 options 的空壳对话框（2026-08-22 修复回归锁）
    expect(events.some((e) => e.kind === 'message')).toBe(false)
  })

  it.each([
    {
      action: 'send',
      params: { sessionId: 's1', prompt: 'hello' },
      // sd-u5：send 走 delivery.sendChecked——idle 直投受理即回，busy 入队也回 queued；
      // notify-once：probe 未带 notifyId → willNotify:false
      expected: { queued: true, willNotify: false },
    },
    {
      action: 'history',
      params: { sessionId: 's1' },
      expected: {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
        truncated: false,
      },
    },
    {
      action: 'status',
      params: { sessionId: 's1' },
      expected: { status: 'active', modelId: 'openai/gpt-4', undeliveredResults: 0 },
    },
    {
      action: 'list',
      params: {},
      expected: {
        sessions: [
          {
            id: 'agent-1',
            label: 'fake-session',
            cwd: '/test/cwd',
            status: 'active',
            spawnSource: 'agent',
            parentAgentSessionId: 'sid-parent',
          },
        ],
        undeliveredResults: 0,
      },
    },
    {
      action: 'abort',
      params: { sessionId: 's1' },
      expected: { success: true },
    },
  ] as const)('$action 全链路：pi stdout 行 → 真实 handler → extension_ui_response 回写 pi stdin', async ({ action, params, expected }) => {
    const sessionService = makeFakeSessionService()
    const pipeline = makeE2ePipeline(sessionService)

    await pipeline.dispatch(buildUiRequestLine(`req-${action}`, action, params))

    // 1. 回写唯一一条 response，value 是 action 结果 JSON（真实 handler 的 respond 序列化）
    const resp = readSingleResponse(pipeline.pi)
    expect(resp.id).toBe(`req-${action}`)
    expect(resp.cancelled).toBeUndefined()
    expect(JSON.parse(resp.value ?? 'null')).toEqual(expected)

    // 2. 路由正确：走 onSessionManagerRequest（handler 直接回写），不注册前端 UI 超时
    expect(pipeline.onExtensionUIRequest).not.toHaveBeenCalled()
  })

  it('history tailTurns 截断：只保留最后一个 user turn 起的消息（真实 handler 逻辑）', async () => {
    const messages = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'reply2' },
    ]
    const pipeline = makeE2ePipeline(makeFakeSessionService({
      getHistory: vi.fn().mockResolvedValue({ messages, truncated: false }),
    }))

    await pipeline.dispatch(buildUiRequestLine('req-history-tail', 'history', { sessionId: 's1', tailTurns: 1 }))

    const resp = readSingleResponse(pipeline.pi)
    expect(JSON.parse(resp.value ?? 'null')).toEqual({
      messages: [
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
      ],
      truncated: true,
    })
  })
})
describe('U4-E3 malformed e2e probe', () => {
  it('options[0] 非法 JSON → translate 标记 __malformed__ → handler 回 cancelled，不走正常 switch', async () => {
    const sessionService = makeFakeSessionService()
    const pipeline = makeE2ePipeline(sessionService)

    await pipeline.dispatch(buildMalformedUiRequestLine('req-malformed'))

    // 1. 回写 cancelled（真实 handler malformed 兜底：sendExtensionUiResponse(null, 'select')）
    const resp = readSingleResponse(pipeline.pi)
    expect(resp.id).toBe('req-malformed')
    expect(resp.cancelled).toBe(true)
    expect(resp.value).toBeUndefined()

    // 2. 不触发任何 SessionService 调用（malformed 在 switch 之前兜底返回）
    expect(sessionService.sendMessage).not.toHaveBeenCalled()
    expect(sessionService.getHistory).not.toHaveBeenCalled()
    expect(sessionService.getSummary).not.toHaveBeenCalled()
    expect(sessionService.listPersistedSessions).not.toHaveBeenCalled()
    expect(sessionService.abort).not.toHaveBeenCalled()

    // 3. 不弹前端 UI（onSessionManagerRequest 直接消化，不注册前端超时）
    expect(pipeline.onExtensionUIRequest).not.toHaveBeenCalled()
  })

  it('marker 翻译：options[0] 非法 JSON 时 action 仍为 __malformed__（不 fall-through 普通分支）', () => {
    const events = translate(JSON.parse(buildMalformedUiRequestLine('req-m')) as PiEvent, 'sid-parent')
    const uiEvent = events.find((e) => e.kind === 'session-manager-ui')
    expect(uiEvent).toBeDefined()
    if (uiEvent?.kind !== 'session-manager-ui') return
    expect(uiEvent.action).toBe('__malformed__')
    expect(uiEvent.params).toEqual({})
  })

  it('marker 翻译：action 不在 SESSION_MANAGER_ACTIONS 枚举 → 折叠 __malformed__ 哨兵（枚举检查）', () => {
    // JSON 合法但 action 是非枚举值——与上一条（JSON 解析失败）不同的 malformed 输入维度
    const events = translate(JSON.parse(buildUiRequestLine('req-enum-guard', 'evil', {})) as PiEvent, 'sid-parent')
    const uiEvent = events.find((e) => e.kind === 'session-manager-ui')
    expect(uiEvent).toBeDefined()
    if (uiEvent?.kind !== 'session-manager-ui') return
    expect(uiEvent.action).toBe('__malformed__')
    expect(uiEvent.params).toEqual({})
  })
})
});

// ======================================================================
// ← src/__tests__/session-history-four-state.test.ts
//   （turn-boundary-index 重写：四态分派/后台全量任务/缓存就绪通知帧/快照对账
//   随 D4 一次退役；验收② fixture 对拍改载「索引窗口读取 vs 尾读兼容链」逐条一致
//   ——两条链共用 convertWindowEntries + segments sidecar 回填，对照防任一侧漏注入）
// ======================================================================

const fs4 = await import('node:fs')
const os4 = await import('node:os')
const path4 = await import('node:path')
const { tailReadHistory: tailReadHistoryReal } = await import('../services/session-history.js')
const { getAttachmentsDir: getAttachmentsDir4 } = await import('@taiji/shared/paths')
const { HISTORY_BUDGET: HISTORY_BUDGET4 } = await import('@taiji/shared')

describe('SessionHistoryReader —— 验收② fixture 对拍（索引窗口 vs 尾读兼容链）', () => {
  it('索引窗口读取（含 segments sidecar 回填）与尾读链逐条一致，图片/技能 badge 不丢', async () => {
    const dir = fs4.mkdtempSync(path4.join(os4.tmpdir(), 'taiji-u1-fixture-'))
    const sessionId = 'fixture-session-01'
    // sidecar 落共享 tmp dataDir（readSegmentsMetadataFile 缺省推导 = getAttachmentsDir(sessionId)，
    // vitest 防线固定 tmp、fs-guard 白名单内）；session 文件在 mkdtemp fixture 目录
    const sidecarPath = path4.join(getAttachmentsDir4(sessionId), 'segments.json')
    let existsSpy: ReturnType<typeof vi.spyOn> | undefined
    try {
      // ── 组装 fixture：user(+image sidecar) → assistant → user(+skill sidecar) → assistant(toolCall) → toolResult ──
      const userMsg = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 })
      const assistantMsg = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 })
      const mkEntry = (id: string, parentId: string | null, message: unknown) =>
        ({ type: 'message', id, parentId, timestamp: '2026-10-29T00:00:00.000Z', message }) as unknown as PiSessionEntry
      const mkCustom = (id: string, parentId: string | null, clientUuid: string, userEntryId: string) =>
        ({ type: 'custom', id, parentId, timestamp: '2026-10-29T00:00:01.000Z', customType: 'taiji.client-msg-id', data: { clientUuid, userEntryId } }) as unknown as PiSessionEntry

      // parentId 链 = 线性 append 链（pi 真实树形：每条 entry 的 parent = 前一条，
      // custom entry 嵌在链中间）——活跃路径单链回溯（computeActivePathEntries）才能
      // 保住 custom entry（clientUuid 映射源）；分叉形态会被裁剪滤掉致回填失效。
      const entries: PiSessionEntry[] = [
        mkEntry('e1', null, userMsg('hello with image')),
        mkCustom('c1', 'e1', 'u-fix-1', 'e1'),
        mkEntry('e2', 'c1', assistantMsg('reply one')),
        mkEntry('e3', 'e2', userMsg('second with skill')),
        mkCustom('c2', 'e3', 'u-fix-2', 'e3'),
        mkEntry('e4', 'c2', { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }], timestamp: 3 }),
        mkEntry('e5', 'e4', { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'OUT' }], timestamp: 4 }),
      ]
      const lines = [
        JSON.stringify({ type: 'session', id: sessionId, version: 1 }), // session header（转换链剥除）
        ...entries.map((e) => JSON.stringify(e)),
      ]
      const filePath = path4.join(dir, `${sessionId}.jsonl`)
      fs4.writeFileSync(filePath, lines.join('\n') + '\n')

      const segments = {
        version: 1,
        entries: [
          { clientUuid: 'u-fix-1', segments: [{ type: 'text', text: 'hello ' }, { type: 'image', id: 'img-1', path: '/tmp/shot.png', fileName: 'shot.png', displayName: '截图.png' }], timestamp: 1 },
          { clientUuid: 'u-fix-2', segments: [{ type: 'text', text: 'second ' }, { type: 'skill', name: 'review' }], timestamp: 2 },
        ],
      }
      fs4.mkdirSync(getAttachmentsDir4(sessionId), { recursive: true })
      fs4.writeFileSync(sidecarPath, JSON.stringify(segments))
      const metadata = JSON.parse(fs4.readFileSync(sidecarPath, 'utf-8')) as SegmentsMetadataFile
      // 本文件 process-manager-exit 段注入的文件级 vi.mock('node:fs') 把 existsSync 钉成
      // 恒 false——reader 的 sidecar 存在性检查会被拦（旧对拍两侧手动传 metadata 绕开，
      // 新对拍走 reader 内部读取）。用例内恢复真实 existsSync，finally 复原不影响他段。
      const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
      existsSpy = vi.spyOn(fs4, 'existsSync').mockImplementation(realFs.existsSync)

      // ── 侧 1：索引窗口读取（真实 PiSessionStore.convertHistory + scanSessions mock 指向 fixture）──
      const { PiSessionStore } = await import('../infra/pi/session-store.js')
      const realStore = new PiSessionStore()
      const reader = new SessionHistoryReader({
        pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
        sessionStore: {
          scanSessions: vi.fn(() => [{ id: sessionId, filePath }]),
          convertHistory: realStore.convertHistory.bind(realStore),
        } as unknown as ISessionStore,
        scanner: { scanTurnBoundariesForward, verifyTurnBoundaries },
      })
      const viaIndex = await reader.getHistory(sessionId)

      // ── 侧 2：尾读兼容链（真实 tailReadHistory + 同一 sidecar 回填）──
      const viaTail = await tailReadHistoryReal(
        filePath, realStore, HISTORY_BUDGET4.RECENT_TURNS, undefined, { segmentsMetadata: metadata },
      )

      // 逐条一致（含 segments 回填后的结构化 content——两条链同一转换出口的构造性对照）
      expect(viaIndex.messages).toEqual(viaTail.messages)
      // 回填生效的正面断言（防「双方同错」的空等价）：图片/技能 badge 从 sidecar 还原
      const user1 = viaIndex.messages.find((m) => m.piEntryId === 'e1')
      expect(user1?.content).toEqual(segments.entries[0]?.segments)
      const user2 = viaIndex.messages.find((m) => m.piEntryId === 'e3')
      expect(user2?.content).toEqual(segments.entries[1]?.segments)
    } finally {
      existsSpy?.mockRestore()
      fs4.rmSync(dir, { recursive: true, force: true })
      fs4.rmSync(sidecarPath, { force: true })
    }
  })
});

