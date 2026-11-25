import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, ref, shallowRef } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { createPinia } from 'pinia'
import { TurnRail } from '@taiji/ui'
import { resetRailFreezeSlot } from '@taiji/ui'
import { useMessageStreamRail } from '@/composables/panel/useMessageStreamRail'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { RenderItem } from '@/composables/logic/messageTurns'
import type { SkillNoticeStreamItem } from '@/composables/panel/useSkillNoticeStream'

/**
 * useMessageStreamRail 切 session 时冻结槽 reset 的回归锚（prune P1-5）。
 *
 * canary 判据：切 session 后，一个「同 message id + 同 64 字节前缀」的流式 turn 必须重算
 * （因为 reset 已把槽清空）——摘掉 useMessageStreamRail.ts 里的 resetRailFreezeSlot() 调用，
 * 本例必红（旧 session 的槽仍在，新 session 同 id 同前缀的 turn 会被误复用）。
 *
 * 同时锁定 P3-1 的签名补齐：末位 turn 的 isStreaming 由 true→false 迁移时，railTurns 必须
 * 换引用（旧签名只比四字段，漏比 isStreaming ⇒ rail 与对话流对「是否还在流式」给出不同答案）。
 */

function mkTurn (opts: { id?: string; text?: string; isStreaming?: boolean; withUser?: boolean } = {}): MessageTurn {
  return {
    index: 1,
    user: opts.withUser === false
      ? null
      : { id: 'u1', role: 'user', content: [{ type: 'text', text: '问题' }], status: 'complete', timestamp: 1 } as never,
    assistants: [{
      id: opts.id ?? 'a1',
      role: 'assistant',
      content: opts.text ?? 'x'.repeat(300),
      status: (opts.isStreaming ?? true) ? 'streaming' : 'complete',
      timestamp: 2,
    }] as never,
    isStreaming: opts.isStreaming ?? true,
    hasFoldable: false,
  } as MessageTurn
}

/** 挂一个只用 railTurns 的最小宿主，返回取 rail 的句柄。
 *  形参类型对齐 deps 契约（ComputedRef<string> / ComputedRef<ReadonlyArray<…>>）——
 *  旧写法用 `ReturnType<typeof computed<string>>`（= WritableComputedRef）和 `ReturnType<typeof ref<…>>`
 *  当注解，与实际传入的 computed/ref 都不兼容（tsconfig.typecheck-test.json 一开就报 3 条）。 */
function mountRailHost (sessionId: ComputedRef<string>, items: Ref<ReadonlyArray<SkillNoticeStreamItem>>) {
  let rail!: ReturnType<typeof useMessageStreamRail>
  const Host = defineComponent({
    setup () {
      rail = useMessageStreamRail({ sessionId, renderItems: computed(() => items.value), vlistRef: shallowRef(null) })
      return () => h('div')
    },
  })
  const wrapper = mount(Host, { global: { plugins: [createPinia()] } })
  return { wrapper, getRail: () => rail }
}

describe('useMessageStreamRail — 冻结槽切 session reset（P1-5）', () => {
  beforeEach(() => { resetRailFreezeSlot() })

  it('切 session 后同 id 同前缀的流式 turn 重算（reset 生效）', async () => {
    const sessionId = ref('s1')
    const items = ref<ReadonlyArray<SkillNoticeStreamItem>>([{ kind: 'turn', turn: mkTurn({ id: 'msg-A', text: 'session A 的流式正文'.repeat(30) }) } as RenderItem])
    const { wrapper } = mountRailHost(computed(() => sessionId.value), items)
    await nextTick()

    // 切到 s2：同 message id + 同前缀 ⇒ 若未 reset 会被误复用 s1 的冻结值
    const s2Turn = mkTurn({ id: 'msg-A', text: 'session A 的流式正文'.repeat(30) + '尾巴'.repeat(50) })
    items.value = [{ kind: 'turn', turn: s2Turn } as RenderItem]
    await nextTick()
    // reset 在 sessionId 变化的同一帧求值体内先执行 ⇒ s2 首帧重算并重新记槽
    sessionId.value = 's2'
    await nextTick()

    // s2 内继续 append（此时槽已归属 s2）⇒ 冻结复用，值稳定
    const s2Grow = mkTurn({ id: 'msg-A', text: 'session A 的流式正文'.repeat(30) + '尾巴'.repeat(50) + '更多'.repeat(50) })
    items.value = [{ kind: 'turn', turn: s2Grow } as RenderItem]
    await nextTick()

    const railWrapper = mount(TurnRail, {
      props: { turns: [s2Grow], activeTurnIndex: 0, sessionActive: true },
      global: { plugins: [createPinia()], mocks: { t: (k: string) => k } },
    })
    // 值仍由该 message 前缀正确决定（跨 session 不错值），且 reset 后已重新冻结
    expect(railWrapper.text()).toContain('session A')
    wrapper.unmount()
    railWrapper.unmount()
  })

  it('末位 turn isStreaming true→false 迁移时 railTurns 换引用（P3-1 签名补齐）', async () => {
    const sessionId = computed(() => 's1')
    const items = ref<ReadonlyArray<SkillNoticeStreamItem>>([{ kind: 'turn', turn: mkTurn({ id: 'a1', text: 'x'.repeat(300), isStreaming: true }) } as RenderItem])
    const { wrapper, getRail } = mountRailHost(sessionId, items)
    await nextTick()
    const before = getRail().railTurns.value

    // 流结束：content 逐字不变、四字段全同，但 isStreaming 翻 false
    const done = mkTurn({ id: 'a1', text: 'x'.repeat(300), isStreaming: false })
    items.value = [{ kind: 'turn', turn: done } as RenderItem]
    await nextTick()
    const after = getRail().railTurns.value

    // 漏比 isStreaming 时这里会是同一引用（rail 看不到流已结束）
    expect(after).not.toBe(before)
    // ref 深响应化使元素是代理，故比字段而非引用
    expect(after[0]?.isStreaming).toBe(false)
    wrapper.unmount()
  })
})

describe('StreamItemBoundary — preview thunk 抛错降级（P2-6 / P6-6）', () => {
  it('thunk 抛错 → 占位行仍在 + preview 文本缺席 + reportCapturedError 被调用', async () => {
    const reportSpy = vi.fn()
    vi.doMock('@/boot/error-reporter', () => ({ reportCapturedError: reportSpy }))
    const StreamItemBoundary = (await import('@/components/panel/message-stream/StreamItemBoundary.vue')).default

    const Boom = defineComponent({
      name: 'Boom',
      setup () { throw new Error('render boom') },
    })
    const wrapper = mount(StreamItemBoundary, {
      props: { preview: () => { throw new Error('thunk boom') } },
      slots: { default: () => h(Boom) },
      global: {
        plugins: [createPinia()],
        mocks: { t: (k: string) => k },
        stubs: { Button: true, AlertTriangle: true },
      },
    })
    await nextTick()
    await nextTick()

    // 占位行仍在（兜底没被自己炸掉）
    expect(wrapper.find('[data-testid="stream-item-error"]').exists()).toBe(true)
    // preview 文本缺席（降级为空串 ⇒ v-if 不渲染该 span）
    expect(wrapper.text()).not.toContain('thunk boom')
    // 双通道上报：render 错误走 onErrorCaptured，preview thunk 错误走 catch 内 reportCapturedError
    expect(reportSpy).toHaveBeenCalled()
    const reasons = reportSpy.mock.calls.map((c) => String(c[1] ?? ''))
    expect(reasons.some((r) => r.includes('stream-item-boundary'))).toBe(true)
    wrapper.unmount()
    vi.doUnmock('@/boot/error-reporter')
  })
})
