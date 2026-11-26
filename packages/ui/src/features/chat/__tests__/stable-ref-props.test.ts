/**
 * 批2 F2 稳定引用 props 单测：Turn→UserBubble/TurnSummary 传稳定引用 + 标量，
 * shouldUpdateComponent 整体跳过流式期每 delta 重渲染。
 *
 * 覆盖：
 * 1. UserBubble：父组件每 tick 重建（模拟流式 turn 重建）但传给它的 user 引用稳定 →
 *    UserBubble 不重渲染（t 渲染期函数 spy 不再被调）；反向对照：user prop 变 → 重渲染。
 * 2. TurnSummary：新契约（lastAssistantId + isStreaming + resolveLastAssistant）渲染正确；
 *    isStreaming 驱动 speakDisabled（原 turn.isStreaming）；aiCopyKey 用 lastAssistantId（N2）。
 *
 * 运行：node scripts/run-domain-tests.mjs chat
 */
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'

// i18n mock：useI18n 的 t 做成 spy——UserBubble/TurnSummary 的 render 期调 t（按钮 title），
// 重渲染 ⇔ t 再被调；shouldUpdateComponent 跳过更新 ⇔ t 不被调。vi.hoisted 保证工厂可引用。
const { tSpy } = vi.hoisted(() => ({ tSpy: vi.fn((k) => k) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: tSpy }) }))

import UserBubble from '../UserBubble.vue'
import TurnSummary from '../TurnSummary.vue'
import { mockChatProvide } from './helpers'
import type { Message } from '@taiji/shared'

const NOW = 1_700_000_000_000
const mkUser = (over = {}): Message => ({ id: 'u-1', role: 'user', content: 'hello', status: 'complete', timestamp: NOW, ...over } as Message)
const mkAssistant = (over = {}): Message => ({ id: 'a-1', role: 'assistant', content: 'reply', status: 'complete', timestamp: NOW, ...over } as Message)

describe('F2 UserBubble 稳定引用 props', () => {
  it('父组件每 tick 重建但 user 引用稳定 → UserBubble 不重渲染（shouldUpdateComponent 跳过）', async () => {
    const user = mkUser()
    const Parent = defineComponent({
      setup() {
        const n = ref(0)
        return () => h('div', [
          h('button', { class: 'bump', onClick: () => { n.value++ } }, 'bump'),
          h('span', String(n.value)),
          h(UserBubble, { user, sessionId: 's1', canEdit: false, isSessionEditable: false }),
        ])
      },
    })
    const wrapper = mount(Parent, {
      global: { provide: mockChatProvide(), stubs: { MarkdownRenderer: true, ImageThumb: true } },
    })
    expect(tSpy).toHaveBeenCalled() // 初次渲染 UserBubble 调了 t（按钮 title）
    tSpy.mockClear()
    await wrapper.find('button.bump').trigger('click') // 父重渲染；UserBubble 的 user/sessionId 等 props 未变
    expect(tSpy).not.toHaveBeenCalled() // 整组件更新被跳过 → 渲染期 t 不再被调
  })

  it('反向对照：user prop 引用变（content 变）→ UserBubble 重渲染', async () => {
    const wrapper = mount(UserBubble, {
      props: { user: mkUser(), sessionId: 's1' },
      global: { provide: mockChatProvide(), stubs: { MarkdownRenderer: true, ImageThumb: true } },
    })
    tSpy.mockClear()
    await wrapper.setProps({ user: mkUser({ content: 'changed' }) })
    expect(tSpy).toHaveBeenCalled()
  })
})

describe('F2/N2 TurnSummary 新契约', () => {
  it('lastAssistantId + isStreaming + resolveLastAssistant 驱动渲染；isStreaming → speakDisabled', async () => {
    const msg = mkAssistant()
    const mountSummary = (isStreaming: boolean) => mount(TurnSummary, {
      props: { lastAssistantId: msg.id, isStreaming, sessionId: 's1', resolveLastAssistant: () => msg },
      global: { provide: mockChatProvide({ speakStateOf: () => 'idle' }), stubs: { MarkdownRenderer: true } },
    })
    const idle = mountSummary(false)
    expect(idle.find('.turn-summary').exists()).toBe(true)
    expect(idle.find('[data-testid="copy-btn"]').exists()).toBe(true)
    // 非流式：朗读按钮可点（speakDisabled=false → 无 disabled）
    expect(idle.find('[data-testid="speak-btn"]').attributes('disabled')).toBeUndefined()

    const streaming = mountSummary(true)
    // 流式：朗读按钮 disabled（speakDisabled = props.isStreaming，原 turn.isStreaming）
    expect(streaming.find('[data-testid="speak-btn"]').attributes('disabled')).toBeDefined()
  })

  it('lastAssistantId=null → 操作栏不渲染（根 v-if）', () => {
    const wrapper = mount(TurnSummary, {
      props: { lastAssistantId: null, isStreaming: false, sessionId: 's1', resolveLastAssistant: () => null },
      global: { provide: mockChatProvide(), stubs: { MarkdownRenderer: true } },
    })
    expect(wrapper.find('.turn-summary').exists()).toBe(false)
  })
})
