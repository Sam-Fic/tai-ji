/**
 * PanelContainer 懒加载双面板失败态集成测试（W31 D-8 major-2 回归防护改造）。
 *
 * 自动重试已删（时间机制删除裁决：300ms×n 退避退役）——装载失败直接进错误态
 * （AsyncErrorFallback，无重试按钮）；出路 = 关闭后重新打开（宿主 v-if 重挂 = 全新一轮
 * fresh load，恢复指引文案保留）。
 *
 * 被测行为：
 * - detail（抽屉 detail tab）失败 → 立即错误占位（无自动重试、无重试按钮）。
 * - 关闭后重新打开（drawer 重开 = 宿主重挂）→ fresh load 成功恢复渲染（手动出路保留）。
 * - terminal（底抽屉）持续失败 → 同样直接错误态；双挂载点互不串线（旧「按 tab 路由」
 *   串线形态的回归防护，机制演变后断言范围保留）。
 *
 * mock 策略（探针验证过的运行时事实，AGENTS.md 规则 13）：
 * - vi.mock 工厂失败结果不缓存、成功结果会缓存——失败注入场景按每文件用例控制计数。
 * - 工厂返回必须带 [Symbol.toStringTag]:'Module'，defineAsyncComponent 的 load() 依此
 *   unwrap .default（与 vite 动态 import 真实产物一致）。
 * - 禁用 vi.resetModules()：它会拆散模块身份（测试的静态 import 与 PanelContainer 重新导入的
 *   模块图变成不同实例，pinia store / drawer 单例分裂，drawer 打不开）。
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=panel npx vitest run src/__tests__/panel/panel-container-lazy-retry.test.ts（本文件登记在 domain-map.json panel 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { computed, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import {
  bindDrawerSessionId,
  openDrawerTab,
  closeDrawer,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import {
  bindBottomDrawerSessionId,
  openBottomDrawer,
  _resetBottomDrawerForTest,
} from '@taiji/core/domain/bottom-drawer'

// ── flaky 懒加载面板 mock：工厂按 hoisted 计数决定失败/成功（vi.hoisted 使工厂可引用）──
const lazy = vi.hoisted(() => ({
  detailFailures: 0,
  detailLoads: 0,
  terminalFailures: 0,
  terminalLoads: 0,
}))

vi.mock('@/components/panel/DetailPane.vue', () => {
  lazy.detailLoads++
  if (lazy.detailFailures > 0) {
    lazy.detailFailures--
    throw new Error('Failed to fetch dynamically imported module')
  }
  return {
    default: { name: 'DetailPane', template: '<div data-testid="detail-loaded">detail</div>' },
    [Symbol.toStringTag]: 'Module',
  }
})
vi.mock('@/components/panel/TerminalView.vue', () => {
  lazy.terminalLoads++
  if (lazy.terminalFailures > 0) {
    lazy.terminalFailures--
    throw new Error('Failed to fetch dynamically imported module')
  }
  return {
    default: { name: 'TerminalView', template: '<div data-testid="terminal-loaded">terminal</div>' },
    [Symbol.toStringTag]: 'Module',
  }
})

// ── 静态重面板 + 壳层组件 vi.mock（import 期替换，砍掉 PanelContainer 整图 transform；本文件
// 只开 detail/terminal tab，以下占位组件均无断言观测范围，形态对齐 drawer-mode 测试。
// 来自 @taiji/ui/extension-host，mock 路径须与 PanelContainer 的 import 说明符一致）──
vi.mock('@/components/panel/GitPanel.vue', () => ({
  default: { name: 'GitPanel', template: '<div data-testid="git-panel" />' },
}))
vi.mock('@/components/panel/CommandDocPanel.vue', () => ({
  default: { name: 'CommandDocPanel', template: '<div data-testid="doc-panel" />' },
}))
vi.mock('@/components/extension/BackgroundTaskDetailPanel.vue', () => ({
  default: { name: 'BackgroundTaskDetailPanel', template: '<div data-testid="bash-task-detail-panel" />' },
}))
vi.mock('@/components/panel/plan/PlanDocsPanel.vue', () => ({
  default: { name: 'PlanDocsPanel', template: '<div data-testid="plan-docs-panel" />' },
}))
vi.mock('@/components/panel/BtwPanel.vue', () => ({
  default: { name: 'BtwPanel', template: '<div data-testid="btw-panel" />' },
}))
vi.mock('@/components/panel/Panel.vue', () => ({
  default: {
    name: 'Panel',
    props: { panelId: String, sessionId: { type: String, default: null } },
    template: '<div data-testid="panel" :data-panel-id="panelId" />',
  },
}))
vi.mock('@/components/panel/PanelHeader.vue', () => ({
  default: { name: 'PanelHeader', template: '<div />' },
}))
vi.mock('@/components/ui/ToastContainer.vue', () => ({
  default: { name: 'ToastContainer', template: '<div />' },
}))
vi.mock('@/components/panel/trace/TraceInspector.vue', () => ({
  default: { name: 'TraceInspector', template: '<div />' },
}))
vi.mock('@/components/panel/SubagentTab.vue', () => ({
  default: { name: 'SubagentTab', template: '<div />' },
}))
vi.mock('@taiji/ui/extension-host', () => ({
}))

// ── 壳层依赖 mock（对齐 panel-container-drawer-mode.test.ts）──
vi.mock('@/composables/features/file-tree/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))

// chatStore mock：unread watch 的消息数读取转发到响应式 Map（对齐 drawer-mode 测试）
const chatMock = vi.hoisted(() => {
  let readFn: ((sid: string) => unknown[]) | null = null
  return {
    registerReader(fn: (sid: string) => unknown[]): void {
      readFn = fn
    },
    read(sid: string): unknown[] {
      return readFn ? readFn(sid) : []
    },
  }
})
const reactiveMessages = reactive(new Map<string, unknown[]>())
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    getMessages: (sid: string) => chatMock.read(sid),
  }),
}))
chatMock.registerReader((sid) => reactiveMessages.get(sid) ?? [])

async function mountContainer() {
  // 动态 import 让 vi.mock 先生效；不 mock/stub DetailPane/TerminalView 的渲染范围（本测试的被测对象，
  // 两者的 vi.mock 工厂在文件头控制失败/成功）
  const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
  return mount(PanelContainer)
}

beforeEach(() => {
  setActivePinia(createPinia())
  bindDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
  bindBottomDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
  _resetDrawerForTest()
  _resetBottomDrawerForTest()
  reactiveMessages.clear()
  lazy.detailFailures = 0
  lazy.detailLoads = 0
  lazy.terminalFailures = 0
  lazy.terminalLoads = 0
})

// [HISTORICAL] 用例间 wrapper 必须自动 unmount（原因见 panel-container-drawer-mode.test.ts 同注释）
enableAutoUnmount(afterEach)

describe('PanelContainer 懒加载失败态（自动重试已删：失败即错误态，重开恢复）', () => {
  it('装载失败立即进错误态（无自动重试无按钮）；关闭重开 fresh load 恢复；双挂载点互不串线', async () => {
    lazy.detailFailures = 1
    lazy.terminalFailures = 999
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-lazy')
    openDrawerTab('detail')
    openBottomDrawer()
    const wrapper = await mountContainer()
    await flushPromises()

    // ① 双失败：直接错误占位（无自动重试等待窗），无重试按钮
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="async-error-fallback"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-drawer"] [data-testid="async-error-fallback"]').exists()).toBe(true)
    // 各只 load 一次（无退避重试轮）
    expect(lazy.detailLoads).toBe(1)
    expect(lazy.terminalLoads).toBe(1)
    // 指引文案（自动重试措辞已随机制删除）
    expect(wrapper.text()).toContain('加载失败')
    expect(wrapper.text()).toContain('关闭后重新打开可恢复')

    // ② 关闭后重新打开（手动出路保留）：宿主 v-if 重挂 = fresh load，detail 恢复渲染
    closeDrawer()
    await flushPromises()
    openDrawerTab('detail')
    await flushPromises()
    expect(lazy.detailLoads).toBe(2)
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="detail-loaded"]').exists()).toBe(true)

    // ③ 隔离：detail 恢复路径未触碰 terminal 的 loader（挂载点独立，回归防护）
    expect(lazy.terminalLoads).toBe(1)
    expect(wrapper.find('[data-testid="bottom-drawer"] [data-testid="async-error-fallback"]').exists()).toBe(true)
  })
})
