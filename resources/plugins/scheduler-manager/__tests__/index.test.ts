/**
 * scheduler-manager 插件行为范围单测。
 *
 * 构建者白盒 + 使用者黑盒：经 plugin-sdk createMockAgentAPI mock 驱动 activate()
 * 与注册的 command handlers，覆盖：
 * ① handleWrite 回执分支矩阵（accepted/command-missing/其余（hook-blocked/error）
 *    + 无效 id + TASK_NOT_FOUND 自愈；accepted 后写后主动重拉）
 * ② 快照直读数据链（sessions.get 取 cwd → 任务库分片文件读取 → 镜像任务集）
 * ③ 读失败态（sessions.get 抛错 / cwd 缺失 → 失败提示，hidden 保持上次值）
 * ④ 生命周期拆镜（onDidDestroySession → teardownMirror 后不再有任何该会话的读取）
 * ⑥ onDidActivateSession 焦点切换（focusSessionId → 写命令链指向新会话 +
 *    ensureMirror 为新 sid 补挂 + 读失败态的激活时重新拉取自愈）
 * ⑦ 展示层三态分支（已过期「即将触发」两态文案 / 上次成败标记 + 失败原因行 /
 *    成功标记且无原因行——经首次拉取推树断言）
 * ⑧ hidden 入口可见性（空清单 true / 有任务 false；读失败态保持上次值）
 * ⑨ onDidCreateSession 新会话即建镜像（didCreate 即首拉，非等 didActivate）；
 *    任务集变化经 didActivate 信号收敛（周期轮询已退役）
 *
 * 数据源形态（2026-10-30 任务库分离改线）：任务数据在独立快照文件
 * `<piAgentDir>/scheduler/<root>/<segments>/<sessionId>.json`（真实 FS 写入 fixture，
 * 走与插件同源的 extension-protocol store 模块——路径推导构造性一致），
 * sessions.get 提供会话 cwd；不再有 readEntries 游标/折叠/失效订阅链。
 *
 * 隔离：被测模块持有模块级状态（mirrors Map / focusSessionId），每条用例
 * vi.resetModules() 后动态 import 取 fresh 模块。刷新为事件触发的 async 链
 * （无 timer），用例经 flushRefresh 推微任务落地。
 *
 * 相对路径 import 的理由见 vitest.config.ts 头注（resources/plugins 不在 workspace，
 * 裸包名解析不到；type-only import 运行时被剥离，.js 后缀仅 typecheck 期解析）。
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockAgentAPI } from '../../../../packages/plugin-sdk/src/index.ts'
import type { SessionInfo } from '../../../../packages/plugin-sdk/src/index.ts'
import type { PluginContext } from '../../../../packages/runtime/src/services/plugin-service/plugin-types.js'
import type { GuiComponent, ScheduledTask, TreeItem } from '../../../../packages/extension-protocol/src/index.ts'
import {
  schedulerStoreFilePath,
  writeSchedulerStore,
} from '../../../../packages/extension-protocol/src/extensions/scheduler/store.ts'

/** sendMessage 回执 reason 词表（与 SDK sendMessage 签名的闭集同源 = SendPromptReason 三值；
 *  busy/compacting/bash 退役值已删，运行态不再产出，mock 不得注入） */
type SendReceipt = {
  accepted: boolean
  reason?: 'command-missing' | 'hook-blocked' | 'error'
}

type PluginModule = typeof import('../index.ts')

// ── 常量 ────────────────────────────────────────────────────────

const SESSION_CWD = '/w/proj'
/** 插件宿主 env 契约键（与 index.ts resolveAgentDir 同键；生产值由 runtime 注入） */
const PI_AGENT_DIR_ENV_KEY = 'PI_CODING_AGENT_DIR'
/** 测试固定的 agentDir（tmp 下，与 global-setup 钉的 TAIJI_AGENT_DATA_DIR 同域隔离） */
const TEST_AGENT_DIR = join(tmpdir(), 'scheduler-manager-test-agent')

// ── fixture 构造 ─────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's-1',
    label: 'test-session',
    cwd: SESSION_CWD,
    status: 'idle',
    createdAt: 1,
    lastActiveAt: 100,
    ...overrides,
  }
}

/** 构造 base 任务（快照文件 fixture 用）。 */
function makeTask(
  taskId: string,
  enabled: boolean,
  overrides: Partial<ScheduledTask> = {},
): ScheduledTask {
  return {
    id: taskId,
    name: `task-${taskId}`,
    prompt: 'do it',
    kind: 'recurring',
    schedule: { mode: 'interval', intervalMs: 60_000 },
    enabled,
    createdAt: 1,
    nextRunAt: Date.now() + 3_600_000,
    runCount: 0,
    history: [],
    ...overrides,
  }
}

/** 写任务库快照 fixture（与插件读取同源：store 模块路径推导 + 原子写）。 */
function writeStore(sessionId: string, cwd: string, tasks: ScheduledTask[]): void {
  writeSchedulerStore(schedulerStoreFilePath(TEST_AGENT_DIR, cwd, sessionId), { tasks })
}

/**
 * 刷新链落点等待：刷新为事件触发的 async 链（sessions.get → 快照读 → 推树/徽标），
 * 无 timer 可推进——数轮 fake-timer 微任务 flush 让链完整落地。每轮小幅推进 fake
 * 时钟（合计 250ms，对齐原防抖窗口量级）：formatRelativeTime 对天级差值做 floor，
 * 零推进会让 nextRunAt = now + 2d 的 fixture 显示 "in 2d" 而非 "in 1d"。
 */
async function flushRefresh(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(50)
  }
}

/** ansi-text 节点判别（GuiComponent 是泛型接口非 union，narrow 用显式 guard） */
function isAnsiNode(node: GuiComponent): node is GuiComponent & { props: { lines: string[] } } {
  return node.type === 'ansi-text'
}

interface Harness {
  mod: PluginModule
  api: ReturnType<typeof createMockAgentAPI>
  /** activate() 注册的 command handlers（id → handler） */
  handlers: Map<string, (args?: unknown) => unknown>
  /** sessions.get 调用记录（快照直读的会话元信息查询） */
  getCalls: string[]
  /** sendMessage 调用记录 */
  sendCalls: Array<{
    sessionId: string
    role: string
    content: string
    requireCommand?: string
  }>
  /** onDidDestroySession 捕获的回调（会话销毁信号注入口） */
  destroySession: (session: SessionInfo) => void
  /** onDidActivateSession 捕获的回调（会话激活/焦点切换信号注入口） */
  activateSession: (session: SessionInfo) => void
  /** onDidCreateSession 捕获的回调（会话创建信号注入口） */
  createSession: (session: SessionInfo) => void
  /** views.update 收到的最新树（modal 内容断言入口） */
  lastTree: () => GuiComponent[]
}

/**
 * 装配被测插件：fresh 模块 + mock API + activate()。
 * 快照 fixture 由用例经 writeStore 落盘（真实 FS，走 TAIJI_AGENT_DATA_DIR 固定 tmp）。
 */
async function setup(opts: {
  session?: SessionInfo
  /** 冷启动 list() 返回值（空数组 → 无焦点会话分支） */
  sessions?: SessionInfo[]
  sendMessageReceipt?: SendReceipt
  sendMessageError?: Error
  /** sessions.get 抛错（读失败态注入） */
  getError?: Error
  /** sessions.get 返回值覆写（undefined 模拟元信息缺失） */
  getOverride?: SessionInfo | undefined
}): Promise<Harness> {
  vi.resetModules()
  const mod = await import('../index.ts')
  const api = createMockAgentAPI()

  // 会话表（sessions.get 按 sessionId 查表——cwd 是快照分片键，会话间必须互异）
  const sessionTable = new Map(
    (opts.sessions ?? [opts.session ?? makeSession()]).map((s) => [s.id, s]),
  )
  const getCalls: Harness['getCalls'] = []
  api.sessions.get = vi.fn(async (sessionId: string): Promise<SessionInfo | undefined> => {
    getCalls.push(sessionId)
    if (opts.getError) throw opts.getError
    if ('getOverride' in opts) return opts.getOverride
    return sessionTable.get(sessionId)
  })

  const sendCalls: Harness['sendCalls'] = []
  api.sessions.sendMessage = vi.fn(
    async (params: {
      sessionId: string
      role: 'user' | 'system'
      content: string
      requireCommand?: string
    }): Promise<SendReceipt> => {
      sendCalls.push(params)
      if (opts.sendMessageError) throw opts.sendMessageError
      return opts.sendMessageReceipt ?? { accepted: true }
    },
  )

  api.sessions.list = vi.fn(async () => opts.sessions ?? [opts.session ?? makeSession()])
  // getCommands 返回空 → E13 判定 disabled: true（按钮灰置不是本组用例焦点，固定即可）
  api.sessions.getCommands = vi.fn(async () => [])

  const handlers = new Map<string, (args?: unknown) => unknown>()
  api.commands.register = vi.fn(
    async (
      cmd: { id: string },
      handler: (args?: unknown) => unknown | Promise<unknown>,
    ): Promise<{ dispose: () => void }> => {
      handlers.set(cmd.id, handler)
      return { dispose: () => {} }
    },
  )

  const trees: GuiComponent[][] = []
  api.views.update = vi.fn(
    async (_viewId: string, tree: GuiComponent[], _opts: { sessionId: string }): Promise<void> => {
      trees.push(tree)
    },
  )
  api.ui.updateHeaderAction = vi.fn(async () => ({ updated: true }))

  let destroyHandler: ((session: SessionInfo) => void) | null = null
  api.sessions.onDidDestroySession = vi.fn(
    (handler: (session: SessionInfo) => void): { dispose: () => void } => {
      destroyHandler = handler
      return { dispose: () => {} }
    },
  )

  let activateHandler: ((session: SessionInfo) => void) | null = null
  api.sessions.onDidActivateSession = vi.fn(
    (handler: (session: SessionInfo) => void): { dispose: () => void } => {
      activateHandler = handler
      return { dispose: () => {} }
    },
  )

  let createHandler: ((session: SessionInfo) => void) | null = null
  api.sessions.onDidCreateSession = vi.fn(
    (handler: (session: SessionInfo) => void): { dispose: () => void } => {
      createHandler = handler
      return { dispose: () => {} }
    },
  )

  const context = { api, subscriptions: [] } as unknown as PluginContext
  await mod.activate(context)

  return {
    mod,
    api,
    handlers,
    getCalls,
    sendCalls,
    destroySession: (session: SessionInfo) => destroyHandler?.(session),
    activateSession: (session: SessionInfo) => activateHandler?.(session),
    createSession: (session: SessionInfo) => createHandler?.(session),
    lastTree: () => trees[trees.length - 1] ?? [],
  }
}

/** 收集一棵树里全部 ansi-text 行文案（notice/空态提示/失败态提示都在这） */
function ansiLines(tree: GuiComponent[]): string[] {
  const out: string[] = []
  for (const node of tree) {
    if (isAnsiNode(node)) out.push(...node.props.lines)
  }
  return out
}

/** list-tree 节点判别（与 isAnsiNode 同形态：泛型接口 narrow 用显式 guard） */
function isListNode(node: GuiComponent): node is GuiComponent & { props: { items: TreeItem[] } } {
  return node.type === 'list-tree'
}

/** 收集一棵树里全部 list-tree 行文案（任务行展示断言入口） */
function treeLabels(tree: GuiComponent[]): string[] {
  const out: string[] = []
  for (const node of tree) {
    if (isListNode(node)) out.push(...node.props.items.map((item) => item.label))
  }
  return out
}

/** 最后一次 updateHeaderAction 调用参数 */
function lastHeaderAction(api: ReturnType<typeof createMockAgentAPI>): {
  sessionId: string
  badge?: string
  disabled?: boolean
  hidden?: boolean
} {
  const calls = vi.mocked(api.ui.updateHeaderAction).mock.calls
  return calls[calls.length - 1]?.[1] ?? { sessionId: '' }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  // 插件经 env 契约键取 agentDir（生产值由 runtime 的 pluginHostPiAgentDirEnv 注入）；
  // 测试固定到 tmp 下的独立目录，先清残留再设键（宿主机 shell 若泄漏同键会被覆盖）
  rmSync(TEST_AGENT_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  vi.stubEnv(PI_AGENT_DIR_ENV_KEY, TEST_AGENT_DIR)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  // 快照 fixture 清理：TEST_AGENT_DIR 固定 tmp 在同次运行内跨用例共享，
  // 不清则前序用例写入的分片会污染后续「快照不存在」类用例
  rmSync(join(TEST_AGENT_DIR, 'scheduler'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── 激活链 + 首次快照读取（其余用例的前置语义，独立断言）──────────────────────

describe('activate: 冷启动兜底 + 首次快照读取 + 徽标', () => {
  it('list() 兜底焦点会话，镜像挂点立即快照直读，徽标 = 启用任务数', async () => {
    writeStore('s-1', SESSION_CWD, [makeTask('aaaabbbb', true), makeTask('ccccdddd', false)])
    const h = await setup({})

    await flushRefresh()

    expect(h.getCalls).toEqual(['s-1'])
    // 徽标只数 enabled
    expect(lastHeaderAction(h.api).badge).toBe('1')
    // 树含统计行与两个任务的操作条（每任务 list-tree + action-bar 一对）
    const tree = h.lastTree()
    expect(tree.find((n) => n.type === 'stats-line')).toBeDefined()
    expect(tree.filter((n) => n.type === 'action-bar')).toHaveLength(2)
  })

  it('快照不存在（新会话零任务）→ 空态提示 + hidden=true', async () => {
    const h = await setup({})
    await flushRefresh()

    expect(lastHeaderAction(h.api).hidden).toBe(true)
    expect(ansiLines(h.lastTree())).toContain(
      '本会话还没有定时任务 —— 在对话里说，或手敲 /schedule <排期> <内容> 创建。',
    )
  })

})

// ── 读失败态（快照直读链路错误 → 失败提示，不显示假空态）─────────────────────

describe('doRefresh: 读失败态', () => {
  it('sessions.get 抛错 → 失败提示（不渲染陈旧行、不显示假空态），hidden 保持上次值', async () => {
    writeStore('s-1', SESSION_CWD, [makeTask('aaaabbbb', true)])
    const h = await setup({})
    await flushRefresh()
    expect(lastHeaderAction(h.api).hidden).toBe(false)

    // 元信息查询失败注入 + 写路径触发重拉（E5：TASK_NOT_FOUND 分支 scheduleRefresh，
    // 重拉命中失败 → 失败提示覆盖原 notice 行）
    vi.mocked(h.api.sessions.get).mockRejectedValue(new Error('session store scan failed'))
    await h.handlers.get('scheduler-manager.run')?.({ id: 'deadbeef' })
    await flushRefresh()

    const lines = ansiLines(h.lastTree())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('任务库读取失败')
    // hidden 保持上次值（不误判为「无任务」）
    expect(lastHeaderAction(h.api).hidden).toBe(false)

    // 恢复：查询正常后（激活信号重拉——失败态镜像的激活自愈通道）任务列表回归。
    // E5 分支设置的 notice 是常驻语义（停留到下一次写操作），恢复后该行保留
    vi.mocked(h.api.sessions.get).mockResolvedValue(makeSession())
    h.activateSession(makeSession())
    await flushRefresh()
    expect(lastHeaderAction(h.api).badge).toBe('1')
    expect(ansiLines(h.lastTree())).toEqual(['任务已不存在，列表已刷新'])
  })

  it('会话元信息缺失（get → undefined）→ 失败提示，不静默当空集', async () => {
    const h = await setup({ getOverride: undefined })
    await flushRefresh()
    expect(ansiLines(h.lastTree())[0]).toContain('任务库读取失败')
  })
})

// ── ① handleWrite 回执分支矩阵（guidance MF-1-7 第 1 块）────────────────────

describe('handleWrite: 回执分支矩阵', () => {
  const TASK = 'aaaabbbb'

  async function writeSetup(receipt: SendReceipt): Promise<Harness> {
    writeStore('s-1', SESSION_CWD, [makeTask(TASK, true)])
    return setup({ sendMessageReceipt: receipt })
  }

  it('reason=error → 命令已发出 + 通用重试文案', async () => {
    const h = await writeSetup({ accepted: false, reason: 'error' })
    await flushRefresh()

    await h.handlers.get('scheduler-manager.toggle')?.({ id: TASK, enabled: false })

    // 白名单子命令 + requireCommand 原子校验双断言
    expect(h.sendCalls).toEqual([
      {
        sessionId: 's-1',
        role: 'user',
        content: `/schedule off ${TASK}`,
        requireCommand: 'schedule',
      },
    ])
    expect(ansiLines(h.lastTree())).toContain('操作未生效，请重试')
  })

  it('reason=command-missing → 扩展检查指引文案', async () => {
    const h = await writeSetup({ accepted: false, reason: 'command-missing' })
    await flushRefresh()

    await h.handlers.get('scheduler-manager.toggle')?.({ id: TASK, enabled: false })

    expect(ansiLines(h.lastTree())).toContain(
      '命令不可用，操作未生效 —— 若持续失败，请到 设置 → 扩展检查 该会话的 scheduler 扩展',
    )
  })

  it('reason=其余（hook-blocked）→ 通用重试文案', async () => {
    const h = await writeSetup({ accepted: false, reason: 'hook-blocked' })
    await flushRefresh()

    await h.handlers.get('scheduler-manager.toggle')?.({ id: TASK, enabled: false })

    expect(ansiLines(h.lastTree())).toContain('操作未生效，请重试')
  })

  it('accepted=true → 清除 notice（树无 ansi-text）', async () => {
    const h = await writeSetup({ accepted: true })
    await flushRefresh()

    await h.handlers.get('scheduler-manager.run')?.({ id: TASK })

    expect(h.sendCalls).toHaveLength(1)
    expect(ansiLines(h.lastTree())).toEqual([])
  })

  it('sendMessage 抛错 → 错误提示携带手敲恢复动作', async () => {
    writeStore('s-1', SESSION_CWD, [makeTask(TASK, true)])
    const h = await setup({ sendMessageError: new Error('channel closed') })
    await flushRefresh()

    await h.handlers.get('scheduler-manager.delete')?.({ id: TASK })

    expect(ansiLines(h.lastTree())).toEqual([
      `操作未生效：channel closed（可手敲 /schedule rm ${TASK} 重试）`,
    ])
  })

  it('无效 id → 不发命令 + 无效标识提示', async () => {
    const h = await writeSetup({ accepted: true })
    await flushRefresh()

    await h.handlers.get('scheduler-manager.toggle')?.({ id: 'not-hex!' })

    expect(h.sendCalls).toHaveLength(0)
    expect(ansiLines(h.lastTree())[0]).toContain('无效的任务标识')
  })

  it('TASK_NOT_FOUND：快照无该 id → 不发命令 + 刷新自愈', async () => {
    writeStore('s-1', SESSION_CWD, [makeTask(TASK, true)])
    const h = await setup({ sendMessageReceipt: { accepted: true } })
    await flushRefresh()

    await h.handlers.get('scheduler-manager.run')?.({ id: 'deadbeef' })

    expect(h.sendCalls).toHaveLength(0)
    expect(ansiLines(h.lastTree())).toContain('任务已不存在，列表已刷新')
    // 自愈：E5 重拉已触发（立即语义），get 第二次
    await flushRefresh()
    expect(h.getCalls.length).toBeGreaterThanOrEqual(2)
  })
})

// ── ④ 生命周期拆镜（拆镜后不再有任何该会话的读取）───────────────────────────

describe('onDidDestroySession: 生命周期拆镜', () => {
  const TASK = 'aaaabbbb'

  it('会话销毁 → 清镜像；其后无任何刷新触发源，读取次数冻结', async () => {
    writeStore('s-1', SESSION_CWD, [makeTask(TASK, true)])
    const h = await setup({})
    await flushRefresh()
    expect(h.getCalls).toHaveLength(1)

    h.destroySession(makeSession())
    await flushRefresh()
    // 镜像已删：本模块无周期刷新（事件触发源随镜像消失），读取次数冻结
    expect(h.getCalls).toHaveLength(1)
  })
})

// ── ⑥ onDidActivateSession 焦点切换 + ensureMirror 补挂（MF-3-5）──────────────

describe('onDidActivateSession: 焦点切换 + ensureMirror 补挂', () => {
  it('激活另一会话 → 焦点切换，写命令链与新会话镜像均指向新 sid', async () => {
    writeStore('s-1', SESSION_CWD, [makeTask('aaaa1111', true)])
    writeStore('s-2', '/w/other', [makeTask('aaaa1111', true)])
    const h = await setup({ sessions: [makeSession(), makeSession({ id: 's-2', label: 'other-session', cwd: '/w/other' })] })
    await flushRefresh()

    // 前置：冷启动兜底焦点 = s-1，写命令链指向 s-1
    await h.handlers.get('scheduler-manager.toggle')?.({ id: 'aaaa1111', enabled: false })
    expect(h.sendCalls).toEqual([
      { sessionId: 's-1', role: 'user', content: '/schedule off aaaa1111', requireCommand: 'schedule' },
    ])

    // 用户激活另一会话 s-2：焦点切换 + ensureMirror 为新 sid 补挂（立即首拉）
    h.activateSession(makeSession({ id: 's-2', label: 'other-session', cwd: '/w/other' }))
    await flushRefresh()

    // 补挂证明：s-2 的快照读取发生（新会话镜像首拉）
    expect(h.getCalls).toContain('s-2')
    // 新会话树 + 徽标推到 s-2（快照 1 个启用任务）
    expect(lastHeaderAction(h.api)).toMatchObject({ sessionId: 's-2', badge: '1' })
    expect(h.lastTree().filter((n) => n.type === 'action-bar')).toHaveLength(1)

    // 焦点已切换：写命令链指向 s-2
    await h.handlers.get('scheduler-manager.toggle')?.({ id: 'aaaa1111', enabled: false })
    expect(h.sendCalls.at(-1)?.sessionId).toBe('s-2')
  })

  it('读失败态后 didActivate：激活信号立即重拉成功，任务列表回归', async () => {
    writeStore('s-1', SESSION_CWD, [makeTask('aaaabbbb', true)])
    const h = await setup({ getError: new Error('scan unavailable') })
    // 冷启动兜底建镜：首拉失败（前置自证）
    await flushRefresh()
    expect(ansiLines(h.lastTree())[0]).toContain('任务库读取失败')

    // 用户切走再切回 → didActivate（会话激活完成后投递）+ 查询已恢复
    vi.mocked(h.api.sessions.get).mockResolvedValue(makeSession())
    h.activateSession(makeSession())
    await flushRefresh()

    // 失败态镜像重拉成功：失败文案清除，任务列表/徽标回归
    expect(ansiLines(h.lastTree())).toEqual([])
    expect(lastHeaderAction(h.api).badge).toBe('1')
  })
})

// ── ⑦ 展示层三态分支（经首次拉取推树断言）──────────────────────────────

describe('buildTaskRows: 展示层三态', () => {
  it('已过期 → 即将触发；失败 → 成败标记 + 独立原因行；成功 → 标记且无原因行', async () => {
    writeStore('s-1', SESSION_CWD, [
      // ① 已过期 enabled 任务：nextRunAt 在过去 → 「即将触发」两态文案
      makeTask('aaaa1111', true, { nextRunAt: Date.now() - 60_000 }),
      // ② 失败任务：lastRunAt + lastStatus='failed' + lastError → 「· 失败」标记 + 独立原因行。
      //    nextRunAt 加分钟级缓冲：刷新即时化后格式化时机提前，floor(差值/天) 对
      //    「恰好 2d 减去推进量」的边界敏感，缓冲使 "in 2d" 判定稳定
      makeTask('bbbb2222', true, {
        nextRunAt: Date.now() + 2 * 86_400_000 + 60_000,
        runCount: 3,
        lastRunAt: Date.now() - 120_000,
        lastStatus: 'failed',
        lastError: 'boom',
      }),
      // ③ 成功任务：lastStatus='success' → 「· 成功」标记、无原因行（缓冲理由同上）
      makeTask('cccc3333', true, {
        nextRunAt: Date.now() + 2 * 86_400_000 + 60_000,
        runCount: 2,
        lastRunAt: Date.now() - 86_400_000,
        lastStatus: 'success',
      }),
    ])
    const h = await setup({})
    await flushRefresh()

    // 启用按 nextRunAt 升序：过期任务最前；b/c nextRunAt 相等 → 稳定排序保持插入序。
    // 相对时间值均留单位边界裕度（推进 200ms 不翻转：2m/1d/in 1d）。
    // toEqual 全量补全断言同时证明③「成功无原因行」（boom 仅出现一次且只属失败任务）。
    expect(treeLabels(h.lastTree())).toEqual([
      'task-aaaa1111',
      'every 1m · 即将触发',
      '已执行 0 次',
      'task-bbbb2222',
      'every 1m · 下次 in 2d',
      '已执行 3 次 · 上次 2m ago · 失败',
      'boom',
      'task-cccc3333',
      'every 1m · 下次 in 2d',
      '已执行 2 次 · 上次 1d ago · 成功',
    ])
  })
})

// ── ⑨ onDidCreateSession 补挂点（ADR-0097 拉为主配套：新建会话即建镜像）──────

describe('onDidCreateSession: 新会话即建镜像（didCreate 即首拉，非等 didActivate）', () => {
  it('新建会话 didCreate → 首拉推 hidden=true（新会话零任务）', async () => {
    const h = await setup({ sessions: [makeSession(), makeSession({ id: 's-2', label: 'fresh-session', cwd: '/w/fresh' })] })
    await flushRefresh()

    // 新建会话 s-2（session.create 不触发 didActivate——runtime handleSessionCreate 只
    // reply + 广播会话列表）：didCreate 即建镜像，首拉推 hidden=true（零任务不显示）。
    // 后续任务集变化的收敛 = didActivate 信号（⑥ 组已覆盖）。
    h.createSession(makeSession({ id: 's-2', label: 'fresh-session', cwd: '/w/fresh' }))
    await flushRefresh()

    expect(h.getCalls).toContain('s-2')
    expect(lastHeaderAction(h.api)).toMatchObject({ sessionId: 's-2', hidden: true })
  })
})
