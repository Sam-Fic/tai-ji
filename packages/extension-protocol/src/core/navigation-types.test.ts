import { describe, it, expect } from 'vitest'
import { PROTOCOL_VERSION, type GuiComponent, type GuiComponentProps, type TreeItem, type HostContainerAction } from './types'

type ActionBarItem = GuiComponentProps['action-bar']['items'][number]

/**
 * 容器导航原语契约（容器扩展点统一 §6.4）：action-bar item 增 hostAction、TreeItem 增
 * action——插件首次能表达「点击请求宿主打开某个容器的某个标签页」。params 限标量与
 * action-bar args 同一校验口径（禁嵌套对象防无 schema 结构化旁路）；负向断言由本包
 * typecheck（tsc --noEmit，include 覆盖 src 测试）承载 @ts-expect-error 的真伪验证。
 */
describe('容器导航原语（§6.4：action-bar hostAction + TreeItem.action）', () => {
  it('action-bar item 可声明 hostAction（overlay/drawer + tabId + 标量 params），纯展示项维持旧行为', () => {
    const bar: GuiComponent<'action-bar'> = {
      type: 'action-bar',
      props: {
        items: [
          {
            id: 'open-doc',
            label: '打开报告',
            hostAction: { kind: 'drawer', tabId: 'ui.doc', params: { filePath: '/tmp/report.md' } },
          },
          { id: 'plain', label: '纯展示' },
        ],
      },
    }
    expect(bar.props.items[0].hostAction?.kind).toBe('drawer')
    expect(bar.props.items[0].hostAction?.tabId).toBe('ui.doc')
    expect(bar.props.items[0].hostAction?.params).toEqual({ filePath: '/tmp/report.md' })
    expect(bar.props.items[1].hostAction).toBeUndefined()
  })

  it('TreeItem.action 承载行点击（hostAction 或 commandId），缺省 = 纯展示行不变', () => {
    const items: TreeItem[] = [
      { label: 'run-1', status: 'done', action: { hostAction: { kind: 'overlay', tabId: 'ui.runs' } } },
      { label: 'rerun', action: { commandId: 'wf.rerun' } },
      { label: 'plain' },
    ]
    expect(items[0].action?.hostAction?.tabId).toBe('ui.runs')
    expect(items[1].action?.commandId).toBe('wf.rerun')
    expect(items[2].action).toBeUndefined()
  })

  it('params 限标量：字符串/数字/布尔合法；嵌套对象在类型层被拒（@ts-expect-error，tsc 承载）', () => {
    const scalar: HostContainerAction = { kind: 'drawer', tabId: 'x.y', params: { s: 'a', n: 1, b: false } }
    expect(Object.values(scalar.params ?? {})).toEqual(['a', 1, false])
    // 嵌套对象字面量不可赋给 params（Record<string, string | number | boolean>）
    const nested = { kind: 'drawer', tabId: 'x.y', params: { deep: { inner: 1 } } }
    // @ts-expect-error params 值限标量：嵌套对象形状必须被类型层拒绝
    const rejected: HostContainerAction = nested
    expect(rejected.tabId).toBe('x.y')
  })
})

/** 去掉 confirm 字段后的 action-bar item 形状 = 旧宿主视角（忽略该字段后的等价输入）。 */
const stripConfirm = (item: ActionBarItem): Record<string, unknown> => {
  const { confirm: _confirm, ...rest } = item as ActionBarItem & { confirm?: string }
  return rest
}

describe('action-bar confirm 字段降级矩阵（tray-panel-interact §3.3 D5 / RL3）', () => {
  it('confirm 可选：不声明时 item 形状与旧协议全等（无 confirm 键，旧宿主零差异）', () => {
    const plain: ActionBarItem = { id: 'cancel-1', label: '取消', kind: 'danger', commandId: 'taiji.subagentCancel' }
    expect('confirm' in plain).toBe(false)
    expect(stripConfirm(plain)).toStrictEqual({
      id: 'cancel-1',
      label: '取消',
      kind: 'danger',
      commandId: 'taiji.subagentCancel',
    })
  })

  it('声明 confirm 的 item 去掉该字段后仍是合法 item（旧宿主忽略 confirm = 按钮照常渲染可点）', () => {
    const confirmed: ActionBarItem = {
      id: 'abort-1',
      label: '中止',
      kind: 'danger',
      commandId: 'taiji.workflowAbort',
      args: { runId: 'wf-1' },
      confirm: '确认中止？',
    }
    expect(confirmed.confirm).toBe('确认中止？')
    // 旧宿主（不认识 confirm）眼中的输入：字段被忽略后 id/label/commandId/args 全在，
    // 点击即走既有命令链执行——降级语义 = 中止无确认直接执行
    expect(stripConfirm(confirmed)).toStrictEqual({
      id: 'abort-1',
      label: '中止',
      kind: 'danger',
      commandId: 'taiji.workflowAbort',
      args: { runId: 'wf-1' },
    })
    const bar: GuiComponent<'action-bar'> = { type: 'action-bar', props: { items: [confirmed] } }
    expect(bar.props.items[0]).toBe(confirmed)
  })

  it('abort 按钮声明行：confirm 必须与 abort 按钮同波交付（D5 判定表——abort 产物不可恢复）', () => {
    // 逐按钮可恢复性判定表（D5）：cancel 可恢复 / retry 重派发本体 / abort 不可恢复 /
    // resume 恢复本体。abort 的 confirm 是四按钮中唯一「必须声明」项——旧宿主降级窗口内
    // 中止无确认直接执行的代价不可接受，补偿形态 = 同波交付（无独立暴露窗口）。
    const abort: ActionBarItem = {
      id: 'abort-1',
      label: '中止',
      kind: 'danger',
      commandId: 'taiji.workflowAbort',
      args: { runId: 'wf-1' },
      confirm: '确认中止？',
    }
    const resume: ActionBarItem = {
      id: 'resume-1',
      label: '续跑',
      commandId: 'taiji.workflowResume',
      args: { runId: 'wf-1' },
      confirm: '确认续跑？',
    }
    const items: ActionBarItem[] = [abort, resume]
    expect(items.every((i) => typeof i.confirm === 'string' && i.confirm !== '')).toBe(true)
    expect(items.every((i) => i.kind === 'danger' || i.confirm !== undefined)).toBe(true)
  })

  it('confirm 与 kind/disabled/args 各字段正交（可组合，不互相排斥）', () => {
    const combined: ActionBarItem = {
      id: 'x',
      label: 'x',
      kind: 'danger',
      disabled: true,
      commandId: 'c',
      args: { k: 'v' },
      confirm: 'c?',
    }
    expect(combined.kind).toBe('danger')
    expect(combined.disabled).toBe(true)
    expect(combined.args).toStrictEqual({ k: 'v' })
    expect(combined.confirm).toBe('c?')
  })

  it('PROTOCOL_VERSION 不因 confirm 新增可选字段而 bump（既有 action-bar 降级先例同款）', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })
})

/** 去掉富行三字段后的 TreeItem 形状 = 旧宿主视角（忽略新字段后的等价输入）。 */
const stripRichRowFields = (item: TreeItem): Record<string, unknown> => {
  const { subLabel: _subLabel, statusLabel: _statusLabel, actions: _actions, ...rest } = item as TreeItem & {
    subLabel?: string
    statusLabel?: string
    actions?: ActionBarItem[]
  }
  return rest
}

/**
 * TreeItem 富行三字段降级矩阵（composer-tray-protocol D2 / RL3，confirm 字段同款锁定）：
 * 旧宿主遇已知 type（list-tree）上的新可选字段按字段忽略——退回单行 label 渲染 + 行内
 * 操作不显示，非错误状态。ansi-text 序列化降级只适用于未知组件 type，不适用本字段族。
 */
describe('TreeItem 富行三字段降级矩阵（composer-tray-protocol D2 / RL3）', () => {
  it('subLabel 可选：不声明时行形状与旧协议全等（无新键，旧宿主零差异）', () => {
    const plain: TreeItem = { label: 'agent-1', status: 'running' }
    expect('subLabel' in plain).toBe(false)
    expect(stripRichRowFields(plain)).toStrictEqual({ label: 'agent-1', status: 'running' })
  })

  it('声明 subLabel/statusLabel 的行去掉新字段后仍是合法行（旧宿主忽略 = 单行 label 照常渲染，非错误状态）', () => {
    const rich: TreeItem = {
      label: 'agent-1',
      status: 'failed',
      subLabel: 'wf-42 · 上游工具超时',
      statusLabel: '已中断（可续跑）',
    }
    expect(rich.subLabel).toBe('wf-42 · 上游工具超时')
    expect(rich.statusLabel).toBe('已中断（可续跑）')
    // 旧宿主（不认识新字段）眼中的输入：字段被忽略后 label/status/icon/action 全在，
    // 按 status 枚举渲染状态点——降级语义 = 富信息退化为单行文本，浏览与行点击导航不受影响
    expect(stripRichRowFields(rich)).toStrictEqual({ label: 'agent-1', status: 'failed' })
  })

  it('actions 条目与 action-bar items 同构（ActionBarItem 类型引用），忽略该字段 = 行内操作不显示', () => {
    const withActions: TreeItem = {
      label: 'agent-1',
      status: 'running',
      actions: [
        { id: 'cancel-1', label: '取消', kind: 'danger', commandId: 'taiji.subagentCancel', confirm: '确认取消？' },
      ],
    }
    // 条目形状 = action-bar item 全字段（id/label/kind/commandId/args/confirm 同构——
    // GuiComponentProps['action-bar']['items'] 元素类型即 ActionBarItem）
    const barItem: ActionBarItem = withActions.actions![0]
    expect(barItem.confirm).toBe('确认取消？')
    expect(stripRichRowFields(withActions)).toStrictEqual({ label: 'agent-1', status: 'running' })
  })

  it('PROTOCOL_VERSION 不因富行三字段新增而 bump（confirm 降级先例同款）', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })
})
