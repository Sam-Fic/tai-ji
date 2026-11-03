/**
 * useExtensionHostBridge-host-commands.test.ts —— 宿主薄命令分叉单测
 * （tray-panel-interact §3.3 D4 / U3 段 2；RL6 + RL2 落点）。
 *
 * 被测行为（commandExecutor 分叉 + 四条 taiji.* 薄命令登记）：
 * - RL6-A（四条逐一）：action-bar commandId 命中薄命令表 → 直调 session 域 RPC
 *   （session.subagentAction / session.workflowAction），参数映射 recordId→subagentId /
 *   slug+task / runId；不经 plugin.executeCommand（provider 链零帧）；成功后 info toast
 *   回执（目标 id 回显——终态交互样例 / V3/V4「toast 回执出现」）；
 * - 未命中：provider 插件命令照旧发 plugin.executeCommand 帧（scheduler-manager 形态，
 *   既有链零变化）；
 * - RL6-B：execute reject → 错误 toast 通道触发（失败原因 + 恢复指引 + 目标会话定位），
 *   且无行状态写入（不乐观翻转）；
 * - RL2：未注册 commandId 点击后 ERR6 error 事件出声（不静默失效）、不泄漏进 provider 链；
 *   且按钮本地置灰渲染禁用（E3 同款——impl-plan u-lifecycle-main 验收②「渲染禁用断言」），
 *   置灰后再击被 guard 拦下（零重复分派）。
 *
 * 渲染路径与生产同链：guiTree action-bar 条目 → GuiComponentRenderer（TrayWidgetPanel
 * 同款渲染器）→ Actionbar 原语 → 壳层 provide 的 ACTION_EXECUTOR_KEY（initExtensionHostBridge
 * 装配时捕获）→ commandRegistry.execute → commandExecutor 分叉。每条用例以用户可见 DOM
 * 断言（按钮存在 / 可点 / 文案）托底（三视角之使用者 + 观察者）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useExtensionHostBridge-host-commands.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { GuiComponent, GuiComponentProps } from '@zhushanwen/extension-protocol'
import { ACTION_EXECUTOR_KEY, GuiComponentRenderer, type ActionExecutor } from '@taiji/ui/rendering-protocol'
import { bindDrawerSessionId } from '@taiji/core/domain/drawer'
import type { SubagentRecord } from '@taiji/shared'
import { getExtensionBus, initExtensionHostBridge, HEADER_ACTIONS_SOURCE_KEY, __testing } from '@/composables/shell/useExtensionHostBridge'
import { useToast } from '@/composables/useToast'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'

// ── mock 区 ──────────────────────────────────────────────────────────────

// ws-client：spread actual 仅覆写 send（provider 链帧观测；真 connect/getState 保留——
// connected watcher 依赖真实状态机，测试态恒 disconnected、重放器不触发）
const transportSendSpy = vi.fn()
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    send: (...args: unknown[]) => transportSendSpy(...args),
  }
})

// @/api：spread actual 仅覆写 session 域两个生命周期 RPC——薄命令分叉的直调目标。
// 测试 env VITE_MOCK=true → actual.session 即 core mock 域；spread 保留其余成员，
// stores 经门面对它的消费不受截断。
const { subagentActionSpy, workflowActionSpy } = vi.hoisted(() => ({
  subagentActionSpy: vi.fn(),
  workflowActionSpy: vi.fn(),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    session: { ...actual.session, subagentAction: subagentActionSpy, workflowAction: workflowActionSpy },
  }
})

// commandStore：bridge 装配即调 useCommandStore()（依赖 getPlatform().storage），stub 判定输入
// （对齐 useExtensionHostBridge-plugin-replay.test.ts 同款 mock）
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({ getCommands: () => [] as Array<{ name: string }> }),
}))

// ── 夹具 ─────────────────────────────────────────────────────────────────

/** drawer 域绑定的焦点会话（托盘面板分区恒等于焦点会话——设计 D4）。 */
const FOCUS_SESSION = 'session-focus-1'

type ActionItems = GuiComponentProps['action-bar']['items']

/** 确定性微任务排空：execute 链（ensureActivated → executor → RPC）跨多轮 await，
 *  macrotask 边界保证全部微任务已 drain（禁 vi.waitFor 轮询——TEST-STRATEGY
 *  「异步等待写法」第 1 条：有完成信号即直接 await，微任务清空是事件循环构造性保证）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** provider 链帧（plugin.executeCommand）观测：薄命令路径必须零帧。 */
const providerFrames = (): Array<{ type: string; payload: { pluginId: string; commandId: string; args?: unknown } }> =>
  transportSendSpy.mock.calls
    .map((call) => call[0] as { type: string; payload: { pluginId: string; commandId: string; args?: unknown } })
    .filter((frame) => frame.type === 'plugin.executeCommand')

/** 装配桥并捕获 app.provide 键值对，取壳层真实命令执行器（action-bar 点击的生产入口）。 */
function initBridge(): ActionExecutor {
  const provided: Array<{ key: unknown; value: unknown }> = []
  const app = {
    provide(key: unknown, value: unknown) {
      provided.push({ key, value })
      return app
    },
  }
  initExtensionHostBridge(app as never)
  const executor = provided.find((p) => p.key === ACTION_EXECUTOR_KEY)?.value as ActionExecutor | undefined
  if (!executor) throw new Error('ACTION_EXECUTOR_KEY 未 provide')
  return executor
}

/** 装配桥并捕获 HEADER_ACTIONS_SOURCE_KEY（headerAction 点击的生产入口，E3 端口）。 */
function initHeaderActionsSource(): { executeCommand: (commandId: string) => boolean } {
  const provided: Array<{ key: unknown; value: unknown }> = []
  const app = {
    provide(key: unknown, value: unknown) {
      provided.push({ key, value })
      return app
    },
  }
  initExtensionHostBridge(app as never)
  const source = provided.find((p) => p.key === HEADER_ACTIONS_SOURCE_KEY)?.value as
    | { executeCommand: (commandId: string) => boolean }
    | undefined
  if (!source) throw new Error('HEADER_ACTIONS_SOURCE_KEY 未 provide')
  return source
}

/** 生产同链渲染：guiTree action-bar → GuiComponentRenderer → Actionbar（壳层执行器注入）。 */
function mountActionBar(items: ActionItems, executor: ActionExecutor) {
  return mount(GuiComponentRenderer, {
    props: {
      component: { type: 'action-bar', props: { items } } satisfies GuiComponent<'action-bar'>,
    },
    global: { provide: { [ACTION_EXECUTOR_KEY as symbol]: executor } },
  })
}

/** 末条 toast（模块单例跨用例共享，beforeEach 已清空在列）。 */
function lastToast(): { type: string; message: string; sessionId?: string } {
  const { toasts } = useToast()
  const last = toasts.value[toasts.value.length - 1]
  if (!last) throw new Error('无 toast 入列')
  return { type: last.type, message: last.message, ...(last.sessionId !== undefined ? { sessionId: last.sessionId } : {}) }
}

/** running 态 subagent 记录种子（断言失败路径不乐观翻转）。 */
function seedRunningRecord(subagentId: string): SubagentRecord {
  const record: SubagentRecord = {
    subagentId,
    sessionFile: null,
    agent: 'reviewer',
    slug: 'reviewer',
    task: '审一遍 PR #123',
    status: 'running',
    startedAt: 1,
  }
  useSubagentStore().applyRecords(FOCUS_SESSION, [record])
  return record
}

beforeEach(() => {
  setActivePinia(createPinia())
  bindDrawerSessionId(ref<string | null>(FOCUS_SESSION))
  const { toasts, remove } = useToast()
  while (toasts.value.length > 0) remove(toasts.value[0].id)
})

afterEach(() => {
  __testing.lastInitHandles?.dispose()
  __testing.lastInitHandles = null
  subagentActionSpy.mockReset()
  workflowActionSpy.mockReset()
  transportSendSpy.mockReset()
  // 解绑焦点会话（防跨用例残留）
  bindDrawerSessionId(ref<string | null>(null))
})

// ── RL6-A：taiji.* 命中直转 session 域 RPC（四条逐一）────────────────────

describe('RL6-A 宿主薄命令分叉：taiji.* 命中直转 session 域 RPC（四条逐一）', () => {
  it('taiji.subagentCancel：args.recordId → subagentId 映射，cancel RPC 直达、provider 链零帧', async () => {
    const executor = initBridge()
    const wrapper = mountActionBar(
      [{ id: 'cancel-1', label: '取消', commandId: 'taiji.subagentCancel', args: { recordId: 'sub-42' } }],
      executor,
    )
    // 用户可见 DOM：按钮在、可点（无 disabled 属性）、文案可见
    const btn = wrapper.find('[data-testid="gui-action-bar-item-cancel-1"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.text()).toContain('取消')

    await btn.trigger('click')
    await flush()

    expect(subagentActionSpy).toHaveBeenCalledTimes(1)
    expect(subagentActionSpy).toHaveBeenCalledWith(FOCUS_SESSION, 'cancel', { subagentId: 'sub-42' })
    expect(workflowActionSpy).not.toHaveBeenCalled()
    expect(providerFrames()).toHaveLength(0)
    // 成功回执（终态交互样例 / V3「toast 回执出现」）：info 档 + 目标 id 回显 + 会话定位
    expect(lastToast()).toEqual({ type: 'info', message: '已取消 sub-42', sessionId: FOCUS_SESSION })
    wrapper.unmount()
  })

  it('taiji.subagentRetry：slug+task 原样透传，start RPC 直达（同任务重派发新记录）', async () => {
    const executor = initBridge()
    const wrapper = mountActionBar(
      [{
        id: 'retry-1',
        label: '重试',
        commandId: 'taiji.subagentRetry',
        args: { slug: 'reviewer', task: '审一遍 PR #123' },
      }],
      executor,
    )
    const btn = wrapper.find('[data-testid="gui-action-bar-item-retry-1"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('重试')

    await btn.trigger('click')
    await flush()

    expect(subagentActionSpy).toHaveBeenCalledTimes(1)
    expect(subagentActionSpy).toHaveBeenCalledWith(FOCUS_SESSION, 'start', {
      slug: 'reviewer',
      task: '审一遍 PR #123',
    })
    expect(workflowActionSpy).not.toHaveBeenCalled()
    expect(providerFrames()).toHaveLength(0)
    expect(lastToast()).toEqual({ type: 'info', message: '已重新派发 reviewer', sessionId: FOCUS_SESSION })
    wrapper.unmount()
  })

  it('taiji.workflowAbort：args.runId 直达 abort RPC，provider 链零帧', async () => {
    const executor = initBridge()
    const wrapper = mountActionBar(
      [{ id: 'abort-1', label: '中止', commandId: 'taiji.workflowAbort', args: { runId: 'run-7' } }],
      executor,
    )
    const btn = wrapper.find('[data-testid="gui-action-bar-item-abort-1"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('中止')

    await btn.trigger('click')
    await flush()

    expect(workflowActionSpy).toHaveBeenCalledTimes(1)
    expect(workflowActionSpy).toHaveBeenCalledWith(FOCUS_SESSION, 'abort', 'run-7')
    expect(subagentActionSpy).not.toHaveBeenCalled()
    expect(providerFrames()).toHaveLength(0)
    expect(lastToast()).toEqual({ type: 'info', message: '已中止 run-7', sessionId: FOCUS_SESSION })
    wrapper.unmount()
  })

  it('taiji.workflowResume：args.runId 直达 resume RPC（interrupted 续跑）', async () => {
    const executor = initBridge()
    const wrapper = mountActionBar(
      [{ id: 'resume-1', label: '续跑', commandId: 'taiji.workflowResume', args: { runId: 'run-7' } }],
      executor,
    )
    const btn = wrapper.find('[data-testid="gui-action-bar-item-resume-1"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('续跑')

    await btn.trigger('click')
    await flush()

    expect(workflowActionSpy).toHaveBeenCalledTimes(1)
    expect(workflowActionSpy).toHaveBeenCalledWith(FOCUS_SESSION, 'resume', 'run-7')
    expect(subagentActionSpy).not.toHaveBeenCalled()
    expect(providerFrames()).toHaveLength(0)
    expect(lastToast()).toEqual({ type: 'info', message: '已续跑 run-7', sessionId: FOCUS_SESSION })
    wrapper.unmount()
  })
})

// ── 未命中：既有 provider 链零变化 ────────────────────────────────────────

describe('未命中走既有 provider 链（scheduler-manager 形态零变化）', () => {
  it('provider 插件命令点击照旧发 plugin.executeCommand 帧，零 session RPC', async () => {
    const executor = initBridge()
    const handles = __testing.lastInitHandles
    if (!handles) throw new Error('initExtensionHostBridge 未写入 __testing.lastInitHandles')
    // 经 external 声明 + plugin-status-change active 重放注册进 CommandRegistry（既有通路）
    handles.contributions.registerContribution({
      pluginId: 'scheduler-manager',
      contributionId: 'scheduler-manager.toggle',
      type: 'command',
      placement: 'panel.header',
      available: false,
      command: { title: '暂停/恢复定时任务' },
    })
    getExtensionBus().emit({ kind: 'plugin-status-change', pluginId: 'scheduler-manager', status: 'active' })

    const wrapper = mountActionBar(
      [{ id: 'toggle-1', label: '暂停', commandId: 'scheduler-manager.toggle', args: { id: 'job-9' } }],
      executor,
    )
    const btn = wrapper.find('[data-testid="gui-action-bar-item-toggle-1"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()

    await btn.trigger('click')
    await flush()

    expect(providerFrames()).toEqual([
      {
        type: 'plugin.executeCommand',
        payload: { pluginId: 'scheduler-manager', commandId: 'scheduler-manager.toggle', args: { id: 'job-9' } },
      },
    ])
    expect(subagentActionSpy).not.toHaveBeenCalled()
    expect(workflowActionSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

// ── RL2：未注册 commandId 不静默失效 ──────────────────────────────────────

describe('RL2 未注册 commandId 不静默失效', () => {
  it('点击未注册 commandId → ERR6 出声 + 按钮本地置灰渲染禁用（E3 同款）+ 不泄漏进 provider 链', async () => {
    const executor = initBridge()
    const errors: Array<{ source: string; message: string }> = []
    const off = getExtensionBus().on('error', (e) => errors.push({ source: e.source, message: e.message }))

    const wrapper = mountActionBar(
      [{ id: 'ghost-1', label: '幽灵按钮', commandId: 'taiji.notRegistered' }],
      executor,
    )
    const btn = wrapper.find('[data-testid="gui-action-bar-item-ghost-1"]')
    expect(btn.exists()).toBe(true)
    // 首击放行（置灰发生在命令回执之后）：点击前按钮为可点形态
    expect(btn.attributes('disabled')).toBeUndefined()

    await btn.trigger('click')
    await flush()

    // ERR6 出声（command-registry.ts execute 未命中分支）：误指/未注册不静默 no-op
    expect(errors).toEqual([
      { source: 'CommandRegistry', message: 'command not found: taiji.notRegistered' },
    ])
    // E3 同款本地置灰（RL2 渲染禁用断言，impl-plan u-lifecycle-main 验收②）：执行器回报
    // 命令缺失 → 按钮渲染禁用；零 RPC、零 provider 帧（误指 id 不泄漏进任何执行链）
    expect(wrapper.find('[data-testid="gui-action-bar-item-ghost-1"]').attributes('disabled')).toBeDefined()
    expect(subagentActionSpy).not.toHaveBeenCalled()
    expect(workflowActionSpy).not.toHaveBeenCalled()
    expect(providerFrames()).toHaveLength(0)

    // 置灰后再击：组件内 guard 拦截（与 disabled 属性双重一致），无重复分派、无重复 ERR6
    await wrapper.find('[data-testid="gui-action-bar-item-ghost-1"]').trigger('click')
    await flush()
    expect(errors).toHaveLength(1)
    expect(providerFrames()).toHaveLength(0)
    off()
    wrapper.unmount()
  })
})

// ── RL6-B：失败回执与无乐观翻转 ──────────────────────────────────────────

describe('RL6-B 失败回执：execute reject → 错误 toast，无行状态写入', () => {
  it('cancel RPC reject → 错误 toast（失败原因 + 恢复指引 + 会话定位），记录保持 running 不翻转', async () => {
    const executor = initBridge()
    seedRunningRecord('sub-42')
    subagentActionSpy.mockRejectedValue(new Error('runtime unavailable (ws not open)'))

    const wrapper = mountActionBar(
      [{ id: 'cancel-1', label: '取消', commandId: 'taiji.subagentCancel', args: { recordId: 'sub-42' } }],
      executor,
    )
    await wrapper.find('[data-testid="gui-action-bar-item-cancel-1"]').trigger('click')
    await flush()

    // 错误 toast 通道：失败原因 + 恢复指引 + 目标会话定位（定位行点击可跳转）
    expect(lastToast()).toEqual({
      type: 'error',
      message: '取消失败：runtime unavailable (ws not open)。请在该子代理所属的会话中重试',
      sessionId: FOCUS_SESSION,
    })
    // 无行状态写入：种子记录原样保持（不乐观翻转——事实源是扩展 RecordStore 重推）
    const records = useSubagentStore().getRecordsBySession(FOCUS_SESSION)
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('running')
    expect(records[0].subagentId).toBe('sub-42')
    // provider 链同样零帧（失败不回落重试）
    expect(providerFrames()).toHaveLength(0)
    wrapper.unmount()
  })

  it('abort RPC reject → 错误 toast（工作流专属恢复指引），workflow 记录零写入', async () => {
    const executor = initBridge()
    workflowActionSpy.mockRejectedValue(new Error('run not found'))

    const wrapper = mountActionBar(
      [{ id: 'abort-1', label: '中止', commandId: 'taiji.workflowAbort', args: { runId: 'run-7' } }],
      executor,
    )
    await wrapper.find('[data-testid="gui-action-bar-item-abort-1"]').trigger('click')
    await flush()

    expect(lastToast()).toEqual({
      type: 'error',
      message: '中止失败：run not found。请在该工作流所属的会话中重试',
      sessionId: FOCUS_SESSION,
    })
    expect(useWorkflowStore().getRecordsBySession(FOCUS_SESSION)).toEqual([])
    expect(providerFrames()).toHaveLength(0)
    wrapper.unmount()
  })

  it('按钮未声明参数 → fail-fast 出声（toast 指明缺失参数），不发空 RPC', async () => {
    const executor = initBridge()
    const wrapper = mountActionBar(
      [{ id: 'cancel-1', label: '取消', commandId: 'taiji.subagentCancel' }],
      executor,
    )
    await wrapper.find('[data-testid="gui-action-bar-item-cancel-1"]').trigger('click')
    await flush()

    expect(subagentActionSpy).not.toHaveBeenCalled()
    expect(lastToast().message).toContain('按钮未提供 recordId 参数（扩展声明缺失）')
    expect(lastToast().type).toBe('error')
    wrapper.unmount()
  })

  it('无焦点会话 → 操作未执行 toast（结构态失败自带恢复指引），不发 RPC', async () => {
    bindDrawerSessionId(ref<string | null>(null))
    const executor = initBridge()
    const wrapper = mountActionBar(
      [{ id: 'cancel-1', label: '取消', commandId: 'taiji.subagentCancel', args: { recordId: 'sub-42' } }],
      executor,
    )
    await wrapper.find('[data-testid="gui-action-bar-item-cancel-1"]').trigger('click')
    await flush()

    expect(subagentActionSpy).not.toHaveBeenCalled()
    expect(workflowActionSpy).not.toHaveBeenCalled()
    expect(lastToast()).toEqual({
      type: 'error',
      message: '操作未执行：未定位到目标会话，请先打开一个会话再试',
    })
    wrapper.unmount()
  })

  it('confirm 项再击后 RPC reject → 在途态复位 idle（转圈消失）+ 置灰，按钮脱离永久滞留', async () => {
    // WS 断连点击取消/中止即触发（D5 in-flight settle 的实测场景）：失败后无重推，
    // 修复前相位滞留 in-flight（转圈 + 禁用直到下次推送）；修复后回执 reject 落地即复位
    const executor = initBridge()
    seedRunningRecord('sub-42')
    subagentActionSpy.mockRejectedValue(new Error('runtime unavailable (ws not open)'))

    const wrapper = mountActionBar(
      [{
        id: 'cancel-1',
        label: '取消',
        commandId: 'taiji.subagentCancel',
        args: { recordId: 'sub-42' },
        confirm: '确认取消？',
      }],
      executor,
    )
    const btn = wrapper.find('[data-testid="gui-action-bar-item-cancel-1"]')
    await btn.trigger('click') // 首击 → 确认态
    expect(btn.attributes('data-confirm-phase')).toBe('confirming')
    await btn.trigger('click') // 再击 → 在途态 + 分派
    expect(btn.attributes('data-confirm-phase')).toBe('in-flight')
    await flush()

    // settle 失败 → 相位回 idle：转圈消失，不再滞留「执行中」形态
    expect(btn.attributes('data-confirm-phase')).toBe('idle')
    expect(wrapper.find('[data-testid="gui-action-bar-item-spinner"]').exists()).toBe(false)
    // RL2 置灰通道（render 禁用 + guard 拦再击）：失败反馈可见，零重复分派
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    await flush()
    expect(subagentActionSpy).toHaveBeenCalledTimes(1)
    expect(providerFrames()).toHaveLength(0)
    // 错误 toast 照旧（RL6 用户可见失败反馈不回退）
    expect(lastToast().type).toBe('error')
    wrapper.unmount()
  })

  it('headerAction 端口（E3）执行薄命令失败 → 拒绝在端口内收口，同步可用性回执不变', async () => {
    // 薄命令 RPC/参数失败时 commandRegistry.execute 以 reject 落地（失败信号双通道）；
    // 本端口只消费同步可用性回执、无在途态——拒绝必须在此 catch 收口，逸出即成未处理
    // 拒绝（vitest 红灯）
    const source = initHeaderActionsSource()
    await source.executeCommand('taiji.workflowAbort')
    await flush()

    // 可用性回执（已注册 → true）与失败 toast 照旧；provider 链零帧（薄命令不回落）
    expect(providerFrames()).toHaveLength(0)
    expect(lastToast().type).toBe('error')
  })
})
