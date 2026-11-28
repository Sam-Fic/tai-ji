/**
 * 过程卡窗口滚动运行时单测（chat-flow-v2 tape-scroll）：贴底跟随只听用户的滚动意图。
 *
 * 伪滚动窗口（手工维护 scrollTop / scrollHeight / clientHeight，scrollTop 写入按真实浏览器钳位）
 * 驱动 useTapeScroll：断言挂载首帧的「未贴底」测量与程序贴底的回声都不改变跟随，
 * 只有滚轮上滚 / 用户滚动会停吸，滚到底或点「回到最新」恢复。真实像素几何由真机探针
 * scripts/acceptance/tape-scroll.mjs 断言。
 */
import { mount } from '@vue/test-utils'
import { computed, defineComponent, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessSegment } from '@taiji/core/domain/chat'
import { scrollOrigin, useTapeScroll } from '../useProcessAggregate'

vi.mock('vue-i18n', async () => {
  const { i18nMock } = await import('../../../../__tests__/helpers/i18n-mock')
  return i18nMock({
    'panel.message.scrollToBottom': '回到最新',
    'panel.message.procTapeEarlier': '更早 {count} 条',
    'panel.message.procTapeBelow': '下面还有 {count} 条',
    'panel.message.procTapeToTop': '回到开头',
  })
})

/** 伪滚动窗口：HTMLElement 之外带一份可变状态（内容高度 / 滚动位置 / 行在内容坐标里的位置） */
type FakeWindow = HTMLElement & {
  __state: { contentHeight: number; top: number; rows: Array<{ top: number; bottom: number }> }
}

/** 伪滚动窗口：scrollTop / scrollHeight 写入按真实浏览器钳位；行坐标随滚动进入/离开视口 */
function fakeWindow(contentHeight: number, viewport = 100): FakeWindow {
  const state: FakeWindow['__state'] = { contentHeight, top: 0, rows: [] }
  const el = {
    get scrollHeight() {
      return state.contentHeight
    },
    set scrollHeight(value: number) {
      state.contentHeight = value
    },
    clientHeight: viewport,
    get scrollTop() {
      return state.top
    },
    set scrollTop(value: number) {
      state.top = Math.max(0, Math.min(value, state.contentHeight - viewport))
    },
    getBoundingClientRect: () => new DOMRect(0, 0, 300, viewport),
    querySelectorAll: () =>
      state.rows.map((r) => ({ getBoundingClientRect: () => new DOMRect(0, r.top - state.top, 300, r.bottom - r.top) })) as unknown as NodeListOf<Element>,
    firstElementChild: null,
    scrollTo: vi.fn(),
    __state: state,
  }
  return el as unknown as FakeWindow
}

function emptySegment(): ProcessSegment {
  return {
    id: 'seg:0',
    members: [],
    groups: [],
    units: [],
    counts: { categoryCounts: { explore: 0, edit: 0, exec: 0 }, thinkingCount: 0, totalDurationMs: 0, failedCount: 0 },
    followedByText: false,
  }
}

/** 在组件 setup 里调用 useTapeScroll（useI18n 需要注入上下文） */
function setupTape(live: boolean) {
  const segment = ref<ProcessSegment>(emptySegment())
  const windowRef = ref<HTMLElement | null>(null)
  let tape!: ReturnType<typeof useTapeScroll>
  const wrapper = mount(
    defineComponent({
      setup() {
        tape = useTapeScroll({ window: windowRef, segment, live: computed(() => live) })
        return () => null
      },
    }),
  )
  return { wrapper, tape, windowRef, segment }
}

describe('scrollOrigin：scroll 事件归属', () => {
  it('没有程序滚动在途 → 用户滚动', () => {
    expect(scrollOrigin(0, null)).toBe('user')
  })

  it('程序滚动行程内（含到达终点）→ 回声', () => {
    const trip = { from: 0, to: 120 }
    expect(scrollOrigin(0, trip)).toBe('echo')
    expect(scrollOrigin(60, trip)).toBe('echo')
    expect(scrollOrigin(120, trip)).toBe('echo')
    expect(scrollOrigin(120.8, trip)).toBe('echo')
  })

  it('越过行程区间（用户反向或越过终点）→ 用户滚动', () => {
    const trip = { from: 0, to: 120 }
    expect(scrollOrigin(-2, trip)).toBe('user')
    expect(scrollOrigin(130, trip)).toBe('user')
  })
})

describe('useTapeScroll：贴底跟随只听用户滚动意图', () => {
  it('进行中：挂载首帧被量成未贴底（内容高于可视）——不停吸，不出现「回到最新」', async () => {
    const { wrapper, tape, windowRef } = setupTape(true)
    const win = fakeWindow(160) // 内容 160 / 可视 100：挂载首帧离底 60
    windowRef.value = win
    tape.attach(win)
    await nextTick()
    await nextTick()
    // 挂载即贴底：跟随没被首帧测量关掉，内容滚到底
    expect(win.scrollTop).toBe(60)
    expect(tape.hint.value).toBe('')
    wrapper.unmount()
  })

  it('进行中：内容增长且跟随时贴底；贴底的回声（scroll 事件）不停吸', async () => {
    const { wrapper, tape, windowRef, segment } = setupTape(true)
    const win = fakeWindow(100)
    windowRef.value = win
    tape.attach(win)
    await nextTick()
    await nextTick()
    win.__state.contentHeight = 180
    segment.value = { ...emptySegment(), members: [{}, {}] as never }
    await nextTick()
    await nextTick()
    expect(win.scrollTop).toBe(80)
    // 回声：贴底触发的 scroll 事件
    tape.onScroll()
    expect(tape.hint.value).toBe('')
    wrapper.unmount()
  })

  it('进行中：滚轮上滚即停吸并提示「回到最新」；之后内容增长不贴底', async () => {
    const { wrapper, tape, windowRef, segment } = setupTape(true)
    const win = fakeWindow(180)
    windowRef.value = win
    tape.attach(win)
    await nextTick()
    await nextTick()
    expect(win.scrollTop).toBe(80)
    tape.onWheel(new WheelEvent('wheel', { deltaY: -40 }))
    win.scrollTop = 40
    tape.onScroll()
    expect(tape.hint.value).toBe('回到最新')
    win.__state.contentHeight = 260
    segment.value = { ...emptySegment(), members: [{}, {}] as never }
    await nextTick()
    await nextTick()
    expect(win.scrollTop).toBe(40)
    expect(tape.hint.value).toBe('回到最新')
    wrapper.unmount()
  })

  it('进行中：停吸后用户滚到底 → 恢复跟随；点「回到最新」也恢复', async () => {
    const { wrapper, tape, windowRef } = setupTape(true)
    const win = fakeWindow(180)
    windowRef.value = win
    tape.attach(win)
    await nextTick()
    await nextTick()
    tape.onWheel(new WheelEvent('wheel', { deltaY: -40 }))
    win.scrollTop = 20
    tape.onScroll()
    expect(tape.hint.value).toBe('回到最新')
    // 用户滚到底
    win.scrollTop = 80
    tape.onScroll()
    expect(tape.hint.value).toBe('')
    // 再停吸，点提示恢复：行程终点 = 底部
    tape.onWheel(new WheelEvent('wheel', { deltaY: -40 }))
    win.scrollTop = 10
    tape.onScroll()
    tape.onHint()
    expect(win.scrollTo).toHaveBeenLastCalledWith({ top: 180, behavior: 'smooth' })
    win.scrollTop = 80
    tape.onScroll()
    expect(tape.hint.value).toBe('')
    wrapper.unmount()
  })

  it('落成后：不贴底，按位置给提示——顶部「下面还有 N 条」、到底「回到开头」', async () => {
    const { wrapper, tape, windowRef } = setupTape(false)
    const win = fakeWindow(240)
    // 行在内容坐标里的位置（随滚动进入/离开视口）：顶部 2 行、下部 3 行
    win.__state.rows = [
      { top: 10, bottom: 34 },
      { top: 34, bottom: 58 },
      { top: 150, bottom: 174 },
      { top: 174, bottom: 198 },
      { top: 198, bottom: 222 },
    ]
    windowRef.value = win
    tape.attach(win)
    await nextTick()
    await nextTick()
    expect(win.scrollTop).toBe(0)
    expect(tape.hint.value).toBe('下面还有 3 条')
    win.scrollTop = 140
    tape.onScroll()
    expect(tape.hint.value).toBe('回到开头')
    wrapper.unmount()
  })
})
