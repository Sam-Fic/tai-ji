/**
 * Actionbar.test.ts —— confirm 两段式回执 settle 单测（tray-panel-interact §3.3 D5）。
 *
 * 独立成文件的原因（同 TextInput.test.ts 先例）：本节原属 primitives.test.ts 机械合并
 * 产物；该合并文件已登记 domain-map.json 挂载排除（shell 域，默认档不跑）。回执 settle
 * 是 D5 的失败复位路径（RPC reject / resolve false → 在途态相位回 idle），组件源码的
 * 新增分支需要默认档（含 pr-cr-fix 覆盖率门禁）执行覆盖，故拆回独立文件；归属不变
 * （shell 域 tests glob `packages/ui/src/rendering-protocol/__tests__/**` 覆盖）。
 *
 * 覆盖（回执 settle 契约，壳层 execute 透传 RPC Promise 后的原语侧行为）：
 * - RPC reject（WS 断连即触发）→ 在途态相位回 idle（转圈消失）+ RL2 置灰通道给可见
 *   反馈（渲染禁用 + guard 拦再击）；脱离「永久滞留转圈 + 禁用」；
 * - 异步 resolve false（命令缺失）→ 同走置灰通道 + 相位回 idle；
 * - resolve（命令已执行）→ 留在 in-flight 直至记录重推（防重复 RPC 语义不变）；
 * - 同步 void 执行器（settings 插件 fork 直发形态）→ 旧行为零变化；
 * - reject 后随推送重建恢复可点（自愈：连接恢复 / 命令重注册的重推复位置灰）。
 */
import type { GuiComponentProps } from '@zhushanwen/extension-protocol'
import { ACTION_EXECUTOR_KEY, type ActionExecutor } from '../action-executor-key'
import Actionbar from '../primitives/Actionbar.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

type Items = GuiComponentProps['action-bar']['items']

/** confirm 声明项：abort 按钮（不可恢复，D5 判定表必须带 confirm；WS 断连点击即触发）。 */
const confirmItem = (): Items => [
  {
    id: 'abort-1',
    label: '中止',
    kind: 'danger',
    commandId: 'taiji.workflowAbort',
    args: { runId: 'wf-1' },
    confirm: '确认中止？',
  },
]

const mountConfirm = (execute: ActionExecutor['execute']) => {
  const executor: ActionExecutor = { execute: vi.fn(execute) }
  const wrapper = mount(Actionbar, {
    props: { items: confirmItem() },
    global: { provide: { [ACTION_EXECUTOR_KEY as symbol]: executor } },
  })
  return { executor, wrapper }
}

/** 两段式再击（首击确认态 → 再击执行）后等到回执 settle + DOM 更新。 */
const secondClickAndSettle = async (
  executor: ActionExecutor,
  wrapper: Awaited<ReturnType<typeof mountConfirm>>['wrapper'],
) => {
  const btn = wrapper.find('[data-testid="gui-action-bar-item-abort-1"]')
  await btn.trigger('click')
  await btn.trigger('click')
  await flushPromises()
  return btn
}

describe('Actionbar confirm 回执 settle（D5：失败复位在途态，防永久滞留转圈）', () => {
  it('RPC reject → 相位回 idle（转圈消失）+ RL2 置灰（渲染禁用 + guard 拦再击）', async () => {
    const { executor, wrapper } = mountConfirm(() =>
      Promise.reject(new Error('transport unavailable (ws not open)')),
    )
    const btn = await secondClickAndSettle(executor, wrapper)

    // 在途态已进过（再击即执行）：执行器收到一次分派
    expect(executor.execute).toHaveBeenCalledTimes(1)
    // settle 失败 → 相位回 idle：转圈指示消失，不再滞留「执行中」形态
    expect(btn.attributes('data-confirm-phase')).toBe('idle')
    expect(wrapper.find('[data-testid="gui-action-bar-item-spinner"]').exists()).toBe(false)
    // 失败走 RL2 置灰通道给可见反馈：渲染禁用（commandMissing）
    expect(btn.attributes('disabled')).toBeDefined()
    // 置灰后再击被 guard 拦下：零重复分派（ERR6 已出声过，不重复）
    await btn.trigger('click')
    await flushPromises()
    expect(executor.execute).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('异步 resolve false（命令缺失）→ 相位回 idle + 置灰（与同步 false 同通道）', async () => {
    const { executor, wrapper } = mountConfirm(() => Promise.resolve(false))
    const btn = await secondClickAndSettle(executor, wrapper)

    expect(btn.attributes('data-confirm-phase')).toBe('idle')
    expect(wrapper.find('[data-testid="gui-action-bar-item-spinner"]').exists()).toBe(false)
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    await flushPromises()
    expect(executor.execute).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('resolve（命令已执行）→ 留在 in-flight 直至记录重推（防重复 RPC 语义不变）', async () => {
    const { executor, wrapper } = mountConfirm(() => Promise.resolve(true))
    const btn = await secondClickAndSettle(executor, wrapper)

    // 成功路径不自行复位：在途态防重复 RPC，终态由记录重推重建承担（设计 D5 原语义）
    expect(btn.attributes('data-confirm-phase')).toBe('in-flight')
    expect(wrapper.find('[data-testid="gui-action-bar-item-spinner"]').exists()).toBe(true)
    await btn.trigger('click')
    await flushPromises()
    expect(executor.execute).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('同步 void 执行器（settings 插件 fork 直发形态）→ 旧行为零变化（停在 in-flight）', async () => {
    const { executor, wrapper } = mountConfirm(() => undefined)
    const btn = await secondClickAndSettle(executor, wrapper)

    // 执行器不回报可用性：不进 settle 路径，停在在途态等重推（修复前行为不变）
    expect(btn.attributes('data-confirm-phase')).toBe('in-flight')
    expect(executor.execute).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('reject 后随推送重建恢复可点（自愈：连接恢复 / 命令重注册的重推复位置灰与相位）', async () => {
    const { executor, wrapper } = mountConfirm(() =>
      Promise.reject(new Error('transport unavailable (ws not open)')),
    )
    const btn = await secondClickAndSettle(executor, wrapper)
    expect(btn.attributes('data-confirm-phase')).toBe('idle')
    expect(btn.attributes('disabled')).toBeDefined()

    // 扩展重推同 id 项（WS 重连后的快照重放即此形态）：置灰与确认态随新树复位
    await wrapper.setProps({ items: confirmItem() })
    const btn2 = wrapper.find('[data-testid="gui-action-bar-item-abort-1"]')
    expect(btn2.attributes('data-confirm-phase')).toBe('idle')
    expect(btn2.attributes('disabled')).toBeUndefined()
    // 恢复可点：首击重新进确认态（两段式未被失败破坏）
    await btn2.trigger('click')
    expect(btn2.attributes('data-confirm-phase')).toBe('confirming')
    expect(executor.execute).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('非 confirm 项异步 reject → 同样走置灰通道（不静默失效，RL2 覆盖面扩到执行失败）', async () => {
    const executor: ActionExecutor = {
      execute: vi.fn(() => Promise.reject(new Error('ws not open'))),
    }
    const wrapper = mount(Actionbar, {
      props: { items: [{ id: 'run-1', label: '立即执行', commandId: 'sched.run' }] },
      global: { provide: { [ACTION_EXECUTOR_KEY as symbol]: executor } },
    })
    await wrapper.find('[data-testid="gui-action-bar-item-run-1"]').trigger('click')
    await flushPromises()

    const btn = wrapper.find('[data-testid="gui-action-bar-item-run-1"]')
    expect(btn.attributes('disabled')).toBeDefined()
    // 无 confirm = 无两段式：无相位属性、无转圈（置灰是唯一失败反馈）
    expect(btn.attributes('data-confirm-phase')).toBe('idle')
    expect(wrapper.find('[data-testid="gui-action-bar-item-spinner"]').exists()).toBe(false)
    await btn.trigger('click')
    await flushPromises()
    expect(executor.execute).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('同步 false（命令缺失，RL2）→ 非 confirm 项立即置灰 + guard 拦再击', async () => {
    const executor: ActionExecutor = { execute: vi.fn(() => false) }
    const wrapper = mount(Actionbar, {
      props: { items: [{ id: 'run-1', label: '立即执行', commandId: 'sched.run' }] },
      global: { provide: { [ACTION_EXECUTOR_KEY as symbol]: executor } },
    })
    await wrapper.find('[data-testid="gui-action-bar-item-run-1"]').trigger('click')

    // 同步回执立即置灰（无需等 flush）：渲染禁用 + guard 拦再击
    const btn = wrapper.find('[data-testid="gui-action-bar-item-run-1"]')
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    expect(executor.execute).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('同步 false + confirm 项 → 在途态复位 idle + 置灰（同步失败同样不留转圈）', async () => {
    const { executor, wrapper } = mountConfirm(() => false)
    const btn = wrapper.find('[data-testid="gui-action-bar-item-abort-1"]')
    await btn.trigger('click')
    await btn.trigger('click')

    // 再击即同步回报 false：相位回 idle、转圈消失、走置灰通道
    expect(btn.attributes('data-confirm-phase')).toBe('idle')
    expect(wrapper.find('[data-testid="gui-action-bar-item-spinner"]').exists()).toBe(false)
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    await flushPromises()
    expect(executor.execute).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
