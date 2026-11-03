/**
 * TrayWidgetPanel 断连提示条 + 挂载语义（tray-panel-interact 设计 §3.3 D7 / §4.2 RL5）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：ws 断连时面板顶部出现「连接已断开，内容可能过期」提示条，重连后
 *   自动消失（计数冻结不虚报——断连期间显示的是上一帧推送）；
 * - 构建者（白盒）：判据只有连接态一项——「面板打开」由挂载本身承载（零帧 = 图标不存在 =
 *   面板不可开，AX3），故无加载态 / 首帧骨架分支（走查修正：原「首帧骨架」已撤销）；
 * - 观察者（形态）：guiTree 为空 → 整体零 DOM（不出空壳；「无 entry 无图标」的宿主侧
 *   表达 = 空树连面板都不渲染，图标随首帧出现）。
 *
 * mock 策略：
 * - `@taiji/core/transport/ws-client` 的 getState 替身为可控 ref（断连条唯一驱动源；其余
 *   导出走真实现）——与 tray-native-bundle.test.ts 的 ws mock 同款形态；
 * - vue-i18n 走全局 setup（从 zh-CN locale 取值）：断言真实中文文案。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/panel/tray/tray-widget-panel-disconnect.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import TrayWidgetPanel from '@/components/panel/tray/TrayWidgetPanel.vue'
import { ansiLine } from './tray-view-host-mock'
import zhTray from '@/i18n/locales/zh-CN/tray'

// ── mock：ws 连接态（断连提示条驱动；getState 返回的 ref 由用例切换 value）──
const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  const { ref: makeRef } = await import('vue')
  const stateRef = makeRef<string>('connected')
  wsMock.ref = stateRef
  return { ...actual, getState: () => stateRef }
})

/** 面板挂载（props 驱动，无数据源；viewId 取协议集合外条目 todo 形态） */
function mountPanel(guiTree = [ansiLine('body line')]): VueWrapper {
  return mount(TrayWidgetPanel, {
    props: {
      viewId: 'todo',
      meta: { title: 'Todo', status: 'running', progress: { current: 2, total: 5, label: '2/5' } },
      guiTree,
    },
  })
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  wsMock.ref!.value = 'connected'
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  wsMock.ref!.value = 'connected'
})

describe('TrayWidgetPanel 断连提示条（D7 / RL5）', () => {
  it('connected → 无提示条，head 与正文照常渲染', async () => {
    wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-widget-disconnect-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-widget-panel-title"]').text()).toBe('Todo')
    expect(wrapper.find('[data-testid="tray-widget-panel-label"]').text()).toBe('2/5')
    expect(wrapper.find('[data-testid="ansi-text"]').text()).toContain('body line')
  })

  it('断连（disconnected）→ 顶部提示条出现且文案为「连接已断开，内容可能过期」', async () => {
    wsMock.ref!.value = 'disconnected'
    wrapper = mountPanel()
    await flushPromises()

    const banner = wrapper.find('[data-testid="tray-widget-disconnect-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toBe(zhTray.tray.widgetDisconnectBanner)
    // 提示条在 head 之前（面板顶部）：面板根的第一个子节点即提示条，head 状态点排其后
    const panel = wrapper.find('[data-testid="tray-widget-panel"]')
    expect(panel.element.children[0]?.getAttribute('data-testid')).toBe('tray-widget-disconnect-banner')
    const dotEl = wrapper.find('[data-testid="tray-widget-panel-dot"]').element
    expect(banner.element.compareDocumentPosition(dotEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(wrapper.find('[data-testid="tray-widget-panel-title"]').text()).toBe('Todo')
    // 断连不抹掉已推送内容（内容可能过期，不是消失）
    expect(wrapper.find('[data-testid="ansi-text"]').text()).toContain('body line')
  })

  it('重启态（restarting，非 connected）同样提示；重连边沿自动消失', async () => {
    wsMock.ref!.value = 'restarting'
    wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-widget-disconnect-banner"]').exists()).toBe(true)

    wsMock.ref!.value = 'connected'
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-widget-disconnect-banner"]').exists()).toBe(false)
  })

  it('运行中断连 → 重连后提示条消失且 head/正文不重建丢状态', async () => {
    wrapper = mountPanel()
    await flushPromises()
    const titleBefore = wrapper.find('[data-testid="tray-widget-panel-title"]').text()

    wsMock.ref!.value = 'disconnected'
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-widget-disconnect-banner"]').exists()).toBe(true)

    wsMock.ref!.value = 'connected'
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-widget-disconnect-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-widget-panel-title"]').text()).toBe(titleBefore)
  })
})

describe('TrayWidgetPanel 挂载语义（AX3：无 entry 无图标 / 空树零 DOM）', () => {
  it('guiTree 为空 → 整体零 DOM（不出空壳；宿主侧「图标出现即有树」）', async () => {
    wrapper = mountPanel([])
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-widget-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-widget-disconnect-banner"]').exists()).toBe(false)
    // 零 DOM（v-if 全假 → 根为注释占位，无任何子节点）
    expect(wrapper.element.childNodes.length).toBe(0)
  })

  it('无 meta（v1 旧 extension）→ 标题回退 viewId、无进度区；断连条仍可出现', async () => {
    wsMock.ref!.value = 'disconnected'
    wrapper = mount(TrayWidgetPanel, {
      props: { viewId: 'legacy-widget', guiTree: [ansiLine('x')] },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-widget-panel-title"]').text()).toBe('legacy-widget')
    expect(wrapper.find('[data-testid="tray-widget-panel-label"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-widget-disconnect-banner"]').exists()).toBe(true)
  })
})
