/**
 * ComposerTray 外壳壳层测试（tray-panel-interact 设计 §3.3 D6 / D8 / D11；§4.2 RL4 / RL8 / RL9）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：hover 预览态点不到行内操作按钮（降级为纯展示文本），pin 后才可点；
 *   导航行（hostAction）两种态都可点（导航是安全操作不门控）；按钮悬停 title 文案；
 *   任何容器（右抽屉）从关到打开时托盘面板让位收起；
 * - 构建者（白盒）：pinned 经 TrayPanelSurface provide → TrayWidgetPanel 子树原语 inject 的
 *   传递链（响应式源：pin 翻转即时联动）；开合态 watch 只动边沿（关→开收起一次，
 *   开→开不动作）；
 * - 观察者（形态）：title 分段矩阵（badge 有×无 × progress 有×无 × meta 有×无 + viewId
 *   封闭集合判别）——集合内输出「运行中」段、集合外（todo/goal 形态）不输出，任何缺字段
 *   分支不出 undefined 字面。
 *
 * 与 components/panel/tray/__tests__/tray-widget-bundle.test.ts 的分工：那文件覆盖外壳既有
 * 状态机全族（三态 / hover 时序 / pin / 互斥 / 聚合 / 依赖追踪），本文件只收 tray-panel-interact
 * 新增的壳层行为（pin 门控传递链 / D11 边沿 watch / title 分段），不重复其既有族。
 *
 * mock 策略（与 bundle 同源）：
 * - useTrayCounts partial mock（计数/行集替身；面板 inject 消费外壳单例的契约不动）；
 * - useBackgroundTasks / @taiji/core/transport/api(command) / useSidebar 替身（防真实 RPC）；
 * - `@taiji/core/transport/ws-client` getState 替身为 connected（断连条由
 *   tray-widget-panel-disconnect.test.ts 专项覆盖，本文件保持连接态避免干扰）；
 * - widget 区数据源经 VIEW_HOST_SOURCE_KEY provide 响应式 mock（tray-view-host-mock）；
 * - vue-i18n 走全局 setup（zh-CN 取值）。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/panel/tray/composer-tray-shell.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { computed, nextTick, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import { ACTION_EXECUTOR_KEY, CONTAINER_NAVIGATION_KEY } from '@taiji/ui/rendering-protocol'
import { ansiLine, makeEntry, makeWidgetSource } from './tray-view-host-mock'
import type { MockWidgetSource } from './tray-view-host-mock'
import { makeTrayCountsStub } from './tray-counts-stub'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import ComposerTray from '@/components/panel/tray/ComposerTray.vue'
import TrayWidgetButton from '@/components/panel/tray/TrayWidgetButton.vue'
import type { UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { GuiComponent, WidgetMeta } from '@zhushanwen/extension-protocol'
import {
  bindDrawerSessionId,
  closeDrawer,
  getDrawerControlState,
  openDrawerTab,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import zhTray from '@/i18n/locales/zh-CN/tray'

const SID = 's-tray-shell-polish'

// ── mock：数据范围（三件计数/行集；useTrayCounts partial，TRAY_COUNTS_KEY 等真实成员保留）──
type TrayState = {
  bashRunning: BackgroundTaskEntry[]
  bashEnded: BackgroundTaskEntry[]
  bashLoaded: boolean
}

function createTrayState(): TrayState {
  return { bashRunning: [], bashEnded: [], bashLoaded: true }
}

const trayState = reactive<TrayState>(createTrayState())

vi.mock('@/components/panel/tray/useTrayCounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/panel/tray/useTrayCounts')>()
  return {
    ...actual,
    // 固定数据范围替身（计数/行集由 trayState 注入）；口径测试在 useTrayCounts.test.ts
    useTrayCounts: (_sessionIdRef: Ref<string | null | undefined>): UseTrayCountsReturn =>
      createTrayFixture(),
  }
})

function createTrayFixture(): UseTrayCountsReturn {
  return {
    ...makeTrayCountsStub(trayState),
    bashPartition: computed(() => ({
      tasks: [],
      loaded: trayState.bashLoaded,
      corrupted: false,
      fetchFailed: false,
    })),
  }
}

vi.mock('@/composables/features/sidebar/useBackgroundTasks', () => ({
  useBackgroundTasks: () => ({
    current: computed(() => ({
      tasks: [] as BackgroundTaskEntry[],
      loaded: true,
      corrupted: false,
      fetchFailed: false,
    })),
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}))

const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock }
})

const selectSessionMock = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>())
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ selectSession: selectSessionMock }),
}))

// ── mock：ws 连接态（本文件恒 connected——断连条由专项文件覆盖）──
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  const { ref: makeRef } = await import('vue')
  return { ...actual, getState: () => makeRef<string>('connected') }
})

// ── 挂载与查询工具 ──

let wrapper: VueWrapper | null = null

function mountTray(mock: MockWidgetSource): VueWrapper {
  wrapper = mount(ComposerTray, {
    props: { sessionId: SID },
    global: {
      provide: {
        [VIEW_HOST_SOURCE_KEY as symbol]: mock.source,
        // 交互执行器替身（宿主壳层真实 provide 的是 core commandRegistry / 容器导航执行器；
        // 本文件只断言 pin 门控的 DOM 形态，点击路径不执行——替身消「执行器缺位」告警噪音）
        [ACTION_EXECUTOR_KEY as symbol]: { execute: vi.fn() },
        [CONTAINER_NAVIGATION_KEY as symbol]: { navigate: vi.fn() },
      },
    },
    attachTo: document.body,
  })
  return wrapper
}

/** 浮层内的面板节点（Popover portal → document.body） */
function panelNodes(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="tray-panel"]'))
}

/** 当前打开面板的键集合 */
function panelKeys(): string[] {
  return panelNodes().map((n) => n.dataset.panelKey ?? '')
}

/** 推进假时钟并让 Vue 完成重渲染 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}

/** 真实点击序列（pointerdown → click）：reka 的「层外」判定在 pointerdown，pin 切换在 click */
async function realClick(selector: string): Promise<void> {
  const node = wrapper!.find(selector)
  node.element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  await flushPromises()
  await node.trigger('click')
  await flushPromises()
  await advance(0)
}

/** widget 区按钮（按 viewId 定位） */
function widgetButton(viewId: string) {
  return wrapper!.find(`[data-testid="tray-widget-button"][data-widget-key="${viewId}"]`)
}

/** 面板内的 action-bar item 节点（portal 内容不在 wrapper 树内，走原生查询） */
function actionBarItem(id: string): HTMLElement | null {
  const panel = panelNodes()[0]
  return panel?.querySelector<HTMLElement>(`[data-testid="gui-action-bar-item-${id}"]`) ?? null
}

/** 面板内的 list-tree 可点行节点 */
function listTreeActionRow(index: number): HTMLElement | null {
  const panel = panelNodes()[0]
  return panel?.querySelector<HTMLElement>(`[data-testid="gui-list-tree-action-${index}"]`) ?? null
}

/** 推送一条带行内操作按钮的 subagent 形态 widget entry（D6/D8 断言的载体） */
function pushInteractiveWidget(mock: MockWidgetSource): void {
  const tree: GuiComponent[] = [
    {
      type: 'list-tree',
      props: {
        items: [
          {
            label: 'reviewer · rev',
            status: 'running',
            depth: 0,
            action: { hostAction: { kind: 'drawer', tabId: 'ui.subagent', params: { recordId: 'r-1' } } },
          },
        ],
      },
    },
    {
      type: 'action-bar',
      props: {
        items: [{ id: 'cancel-r-1', label: '取消', kind: 'danger', commandId: 'taiji.subagentCancel', args: { recordId: 'r-1' } }],
      },
    },
    ansiLine('body'),
  ]
  mock.push(makeEntry('subagent', tree, { title: '子代理', status: 'running', badge: '1', progress: { current: 1, total: 2, label: '1' } }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  Object.assign(trayState, createTrayState())
  commandMock.mockReset()
  commandMock.mockResolvedValue({})
  vi.useFakeTimers({ now: new Date(2026, 8, 16, 10, 30, 0).getTime() })
  _resetDrawerForTest()
  bindDrawerSessionId(ref(SID))
  closeDrawer()
})

afterEach(() => {
  vi.useRealTimers()
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  __clearSessionCleanupRegistryForTest()
})

// ── ① pin 门控传递链（D6 / RL4：外壳 pinned → 面板子树原语）──

describe('ComposerTray pin 门控传递链（D6）', () => {
  it('hover 预览态（未 pin）：行内操作按钮降级纯展示 span（点不到），导航行仍可点', async () => {
    const mock = makeWidgetSource(SID)
    pushInteractiveWidget(mock)
    mountTray(mock)
    await flushPromises()

    // hover 160ms 开面板（未 pin）
    await widgetButton('subagent').trigger('pointerenter')
    await advance(160)
    expect(panelKeys()).toEqual(['widget:subagent'])

    // 操作按钮 = span 纯展示（无按钮语义，天然不可点）
    const item = actionBarItem('cancel-r-1')
    expect(item).not.toBeNull()
    expect(item!.tagName).toBe('SPAN')
    // 导航行（hostAction）不门控：仍是原生 button
    const navRow = listTreeActionRow(0)
    expect(navRow).not.toBeNull()
    expect(navRow!.tagName).toBe('BUTTON')
  })

  it('pin 态：同一按钮变为可点 button（响应式联动——provide 的是 computed 而非静态布尔）', async () => {
    const mock = makeWidgetSource(SID)
    pushInteractiveWidget(mock)
    mountTray(mock)
    await flushPromises()

    // 点击 icon = pin（不等 hover 延时）
    await realClick('[data-testid="tray-widget-button"][data-widget-key="subagent"]')
    expect(panelKeys()).toEqual(['widget:subagent'])
    const pinnedPanel = panelNodes()[0]
    expect(pinnedPanel.dataset.pinned).toBe('true')

    const item = actionBarItem('cancel-r-1')
    expect(item).not.toBeNull()
    expect(item!.tagName).toBe('BUTTON')
  })

  it('pin → 再点解除：按钮回到纯展示 span（pin 翻转双向联动）', async () => {
    const mock = makeWidgetSource(SID)
    pushInteractiveWidget(mock)
    mountTray(mock)
    await flushPromises()

    await realClick('[data-testid="tray-widget-button"][data-widget-key="subagent"]')
    expect(actionBarItem('cancel-r-1')!.tagName).toBe('BUTTON')

    await realClick('[data-testid="tray-widget-button"][data-widget-key="subagent"]')
    await flushPromises()
    expect(panelKeys()).toEqual([])
  })
})

// ── ② D11 导航后面板收起联动（RL8：开合态边沿 watch）──

describe('ComposerTray 容器开合态边沿 watch（D11 / RL8）', () => {
  it('关→开边沿：pin 住的托盘面板收起一次且 pin 清除', async () => {
    const mock = makeWidgetSource(SID)
    pushInteractiveWidget(mock)
    mountTray(mock)
    await flushPromises()

    await realClick('[data-testid="tray-widget-button"][data-widget-key="subagent"]')
    expect(panelKeys()).toEqual(['widget:subagent'])

    // 右抽屉从关到开（容器导航的公开状态写口）
    expect(getDrawerControlState().isOpen).toBe(false)
    openDrawerTab('subagent')
    await flushPromises()
    expect(getDrawerControlState().isOpen).toBe(true)
    // 托盘让位：面板摘除 + pin 清除
    expect(panelKeys()).toEqual([])
    expect(widgetButton('subagent').attributes('aria-pressed')).toBe('false')
  })

  it('开→开不动作：容器已开时再导航到另一目标，托盘面板不被反复收起', async () => {
    const mock = makeWidgetSource(SID)
    pushInteractiveWidget(mock)
    mountTray(mock)
    await flushPromises()

    // 容器先开（第一次边沿：此时托盘还没开，无面板可收）
    openDrawerTab('subagent')
    await flushPromises()
    expect(getDrawerControlState().isOpen).toBe(true)

    // 容器已开期间 pin 托盘面板：watch 不动作（无新边沿），面板保持
    await realClick('[data-testid="tray-widget-button"][data-widget-key="subagent"]')
    expect(panelKeys()).toEqual(['widget:subagent'])

    // 容器内再导航到另一目标（isOpen 恒 true，无新边沿）→ 托盘面板不被收起
    openDrawerTab('doc')
    await flushPromises()
    expect(getDrawerControlState().isOpen).toBe(true)
    expect(panelKeys()).toEqual(['widget:subagent'])
    expect(widgetButton('subagent').attributes('aria-pressed')).toBe('true')
  })

  it('关→开只收一次：连续两次导航（各一次边沿）不产生额外动作或异常', async () => {
    const mock = makeWidgetSource(SID)
    pushInteractiveWidget(mock)
    mountTray(mock)
    await flushPromises()

    await realClick('[data-testid="tray-widget-button"][data-widget-key="subagent"]')
    openDrawerTab('subagent')
    await flushPromises()
    expect(panelKeys()).toEqual([])

    // 关闭容器 → 再开（新边沿）：托盘仍无面板，无异常、无误触发
    closeDrawer()
    await flushPromises()
    openDrawerTab('doc')
    await flushPromises()
    expect(panelKeys()).toEqual([])
    expect(widgetButton('subagent').exists()).toBe(true)
  })
})

// ── ③ TrayWidgetButton title 分段矩阵（D8 / RL9）──

describe('TrayWidgetButton title 分段矩阵（D8：分段省略规则 + viewId 封闭集合）', () => {
  it('locale 模板锚点：zh-CN 两模板的占位符集合（防文案漂移改坏分段形态）', () => {
    expect(zhTray.tray.widgetTitle.running).toBe('{title} · {badge} 运行中 / {total}')
    expect(zhTray.tray.widgetTitle.plain).toBe('{title} · {badge}')
  })

  function mountButton(props: { viewId: string; meta?: WidgetMeta }): VueWrapper {
    return mount(TrayWidgetButton, { props })
  }

  /** title 属性值（宿主模板拼接产物） */
  function titleOf(w: VueWrapper): string | undefined {
    return w.find('[data-testid="tray-widget-button"]').attributes('title')
  }

  it('集合内（subagent / workflow）+ badge 有 × progress 有 → 输出「运行中」段', () => {
    for (const viewId of ['subagent', 'workflow']) {
      const w = mountButton({
        viewId,
        meta: { title: '标题', status: 'running', badge: '1', progress: { current: 1, total: 3, label: '1' } },
      })
      expect(titleOf(w)).toBe('标题 · 1 运行中 / 3')
      w.unmount()
    }
  })

  it('集合外（todo / goal 形态）badge 有 × progress 有 → 不输出「运行中」段（同形态不同期望，判别输入是 viewId）', () => {
    for (const viewId of ['todo', 'goal']) {
      const w = mountButton({
        viewId,
        meta: { title: '标题', badge: '2/5', progress: { current: 2, total: 5, label: '2/5' } },
      })
      expect(titleOf(w)).toBe('标题 · 2/5')
      expect(titleOf(w)).not.toContain('运行中')
      w.unmount()
    }
  })

  it('集合内但 progress 缺 → 回落 plain 分支（不出 undefined 段）', () => {
    const w = mountButton({ viewId: 'subagent', meta: { title: '标题', badge: '1' } })
    expect(titleOf(w)).toBe('标题 · 1')
    w.unmount()
  })

  it('badge 与 progress 均无 → 第二段整段略去（title 仅标题）', () => {
    const w = mountButton({ viewId: 'todo', meta: { title: '标题', status: 'idle' } })
    expect(titleOf(w)).toBe('标题')
    w.unmount()
  })

  it('集合外 + progress 有但 badge 无 → badge 回落链取 progress.label', () => {
    const w = mountButton({
      viewId: 'goal',
      meta: { title: '目标', progress: { current: 42, total: 100, label: '42%' } },
    })
    expect(titleOf(w)).toBe('目标 · 42%')
    expect(titleOf(w)).not.toContain('运行中')
    w.unmount()
  })

  it('meta 整体缺（v1 旧 extension）→ title 仅 viewId 兜底（与 aria-label 同源）', () => {
    const w = mountButton({ viewId: 'legacy-widget' })
    expect(titleOf(w)).toBe('legacy-widget')
    w.unmount()
  })

  it('任何分支都不输出 undefined 字面（缺字段矩阵全扫描）', () => {
    const cases: Array<{ viewId: string; meta?: WidgetMeta }> = [
      { viewId: 'subagent' },
      { viewId: 'subagent', meta: { title: 't' } },
      { viewId: 'subagent', meta: { title: 't', progress: { current: 0, total: 0 } } },
      { viewId: 'subagent', meta: { title: 't', badge: '', progress: { current: 1, total: 2 } } },
      { viewId: 'workflow', meta: { title: 't', badge: '0' } },
      { viewId: 'todo', meta: { title: 't', badge: '2/5' } },
      { viewId: 'goal', meta: { title: 't', progress: { current: 1, total: 4 } } },
      // meta.title 缺省的 v1 旧 extension 形态：契约上 title 必填，这里以断言显式建模该漂移，
      // 覆盖 TrayWidgetButton.vue displayTitle 的 viewId 回落分支（补 title 会与其他行重复）
      { viewId: 'unknown-key', meta: { progress: { current: 1, total: 4 } } as WidgetMeta },
    ]
    for (const c of cases) {
      const w = mountButton(c)
      const title = titleOf(w)
      expect(title).toBeDefined()
      expect(title!).not.toContain('undefined')
      expect(title!).not.toContain('NaN')
      expect(title!.length).toBeGreaterThan(0)
      w.unmount()
    }
  })

  it('aria-label 契约保留：badge 全文进括注（title 与 aria-label 并存，通道不同不互斥）', () => {
    const w = mountButton({
      viewId: 'subagent',
      meta: { title: '子代理', badge: '1234567890', progress: { current: 1, total: 3, label: '1' } },
    })
    const button = w.find('[data-testid="tray-widget-button"]')
    expect(button.attributes('aria-label')).toBe('子代理（1234567890）')
    // title 用截断前的 badge 回落链取值（badge 优先），进度段照常输出
    expect(titleOf(w)).toContain('1234567890 运行中 / 3')
    // badge 元素自身仍 truncate 至 6 字符
    expect(w.find('[data-testid="tray-widget-badge"]').text()).toBe('123456')
    w.unmount()
  })
})
