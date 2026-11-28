/**
 * 过程卡活动 chip 运行时单测（chat-flow-v2 tape-live）：「此刻在做什么 + 已持续多久」。
 *
 * 假时钟驱动：每秒刷新、活动切换立即对表、页面不可见停表 / 恢复可见补算、卸载清理。
 * 真实实例上的 chip 形态由 scripts/acceptance/tape-live.mjs 断言。
 */
import { mount } from '@vue/test-utils'
import { computed, defineComponent, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlatBlock, ProcessSegment } from '@taiji/core/domain/chat'
import type { ThinkingBlock, ToolCall } from '@taiji/shared'
import { useTapeActivity } from '../useProcessAggregate'

vi.mock('vue-i18n', async () => {
  const { i18nMock } = await import('../../../../__tests__/helpers/i18n-mock')
  return i18nMock({
    'panel.message.thinkingBlock': '思考',
    'panel.message.procChipThinking': '思考中',
    'panel.message.runGroupExec': '执行命令',
  })
})

const T0 = 1_000_000
const counts = { categoryCounts: { explore: 0, edit: 0, exec: 0 }, thinkingCount: 1, totalDurationMs: 0, failedCount: 0 }

const flat = (block: FlatBlock['block'], flatIndex: number): FlatBlock => ({ assistantId: 'a1', assistantStatus: 'streaming', block, flatIndex })
const segmentWith = (...blocks: FlatBlock[]): ProcessSegment => ({
  id: 'seg:0',
  members: blocks,
  groups: [],
  units: blocks.map((block) => ({ kind: 'member', block })),
  counts,
  followedByText: false,
})
const streamingThinking = (): FlatBlock =>
  flat({ kind: 'thinking', ref: { id: 'th1', content: '推理中', collapsed: true, startTime: T0 - 2000 } as ThinkingBlock }, 0)
const finishedThinking = (): FlatBlock =>
  flat({ kind: 'thinking', ref: { id: 'th1', content: '推理中', collapsed: true, startTime: T0 - 5000, endTime: T0 - 1000 } as ThinkingBlock }, 0)
const runningCommand = (): FlatBlock =>
  flat({ kind: 'tool', ref: { id: 'tc1', toolName: 'bash', input: { command: 'ls' }, status: 'running', startTime: T0 + 1000 } as ToolCall }, 1)

function setup() {
  const segment = ref<ProcessSegment>(segmentWith(streamingThinking()))
  const live = ref(true)
  let tape!: ReturnType<typeof useTapeActivity>
  const wrapper = mount(
    defineComponent({
      setup() {
        tape = useTapeActivity({ segment, live: computed(() => live.value) })
        return () => null
      },
    }),
  )
  return { wrapper, tape, segment, live }
}

/** 秒数文本 → 秒（3s → 3，1m02s → 62） */
function seconds(text: string): number {
  const min = /^(\d+)m(\d\d)s$/.exec(text)
  if (min) return Number(min[1]) * 60 + Number(min[2])
  return Number(/^(\d+)s$/.exec(text)?.[1] ?? Number.NaN)
}

describe('useTapeActivity：此刻在做什么 + 已持续多久', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('流式中的思考：类型词「思考」+ 计时，每秒刷新一次', async () => {
    const { wrapper, tape } = setup()
    expect(tape.activity.value?.label).toBe('思考')
    expect(tape.activity.value?.thinkingId).toBe('th1')
    expect(tape.elapsedText.value).toBe('2s')
    await vi.advanceTimersByTimeAsync(3000)
    expect(tape.elapsedText.value).toBe('5s')
    wrapper.unmount()
  })

  it('换成执行中的命令：类型词「执行命令」，计时从新活动的起点立即对表', async () => {
    const { wrapper, tape, segment } = setup()
    await vi.advanceTimersByTimeAsync(4000)
    expect(tape.elapsedText.value).toBe('6s')
    vi.setSystemTime(T0 + 5000)
    segment.value = segmentWith(finishedThinking(), runningCommand())
    await nextTick()
    expect(tape.activity.value?.label).toBe('执行命令')
    expect(tape.elapsedText.value).toBe('4s')
    await vi.advanceTimersByTimeAsync(2000)
    expect(tape.elapsedText.value).toBe('6s')
    wrapper.unmount()
  })

  it('最后一个步骤已结束、回合仍在进行：类型词「思考中」，自该步骤结束算起', async () => {
    const { wrapper, tape, segment } = setup()
    vi.setSystemTime(T0 + 4000)
    segment.value = segmentWith(finishedThinking())
    await nextTick()
    expect(tape.activity.value?.label).toBe('思考中')
    expect(seconds(tape.elapsedText.value)).toBe(5)
    wrapper.unmount()
  })

  it('页面不可见时停表，恢复可见立即补算', async () => {
    const { wrapper, tape } = setup()
    let hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    try {
      hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(5000)
      expect(tape.elapsedText.value).toBe('2s')
      hidden = false
      vi.setSystemTime(T0 + 9000)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(tape.elapsedText.value).toBe('11s')
      await vi.advanceTimersByTimeAsync(1000)
      expect(tape.elapsedText.value).toBe('12s')
    } finally {
      delete (document as { hidden?: boolean }).hidden
      wrapper.unmount()
    }
  })

  it('段不在进行中：没有 chip 也不留计时器；卸载清理计时器', async () => {
    const { wrapper, tape, live } = setup()
    expect(vi.getTimerCount()).toBe(1)
    live.value = false
    await nextTick()
    expect(tape.activity.value).toBeNull()
    expect(tape.elapsedText.value).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    live.value = true
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
