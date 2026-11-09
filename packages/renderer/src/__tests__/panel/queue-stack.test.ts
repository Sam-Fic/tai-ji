/**
 * QueueBubble 卡片堆叠相位机单测（OD QueuedSendStack 形态迁移，feat-queue-card-stack）。
 *
 * 覆盖（相位机与几何模型，行操作/状态映射/编辑态在 trace-inspector.test.ts 的
 * queue-bubble-s8 / queue-bubble-edit 节）：
 * - enter→ready 翻相：挂载/新增卡经强制 reflow 后脱离起始帧（DOM 断言终态 ready）
 * - exit 冻结深度：离场卡保持离场瞬间 depth 不跳位，存者按显示序重排 depth
 * - 复活边沿：exit 计时窗内条目回归 → 清计时器回 ready，不被误移除
 * - 离场移除：CLOSE_MS 后 exit 卡出 DOM，根门（rows 与 cards 双空）关闭
 * - 几何模型：收起态根高 = 卡高 + 至多两层偏移；展开视口高 = min(全高, 5.5 卡上限)
 *   （happy-dom 无布局：卡高走 MIN 兜底、消息流容器缺失跳过可用空间封顶）
 * - depth 钳制与 zIndex 梯队（>3 层钳 3；zIndex = max(1, 存量数 − depth)，exit 恒 0）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/queue-stack.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import QueueBubble from '@/components/panel/QueueBubble.vue'
import type { QueueRow } from '@/composables/panel/useQueueRows'

function row(clientUuid: string, preview: string, state: QueueRow['state'] = 'queued'): QueueRow {
  return { clientUuid, preview, state }
}

function mountQB(rows: QueueRow[]) {
  return mount(QueueBubble, { props: { rows, hint: '占用结束后发送' } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('QueueBubble · 堆叠相位机（enter/ready/exit）', () => {
  it('挂载即建卡（immediate）：首帧建卡并翻相到 ready（enter 起始帧不驻留 DOM）', async () => {
    const wrapper = mountQB([row('u-1', 'm1'), row('u-2', 'm2')])
    await nextTick()
    await nextTick() // post flush（翻相 watch）后再渲染一帧
    expect(wrapper.findAll('.qb-card').length).toBe(2)
    expect(wrapper.find('[data-testid="queue-item-u-1"]').attributes('data-phase')).toBe('ready')
    expect(wrapper.find('[data-testid="queue-item-u-2"]').attributes('data-phase')).toBe('ready')
  })

  it('exit 冻结深度：离场卡保持原 depth，存者按显示序重排（不跳位）', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountQB([
        row('u-1', 'm1'), row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4'), row('u-5', 'm5'),
      ])
      await nextTick()
      await wrapper.setProps({ rows: [row('u-1', 'm1'), row('u-2', 'm2'), row('u-4', 'm4'), row('u-5', 'm5')] })
      await nextTick()
      // u-3 离场：depth 冻结在 2；u-4/u-5 前移一位（3→2、4→3）
      const exited = wrapper.find('[data-testid="queue-item-u-3"]')
      expect(exited.attributes('data-phase')).toBe('exit')
      expect(exited.attributes('data-depth')).toBe('2')
      expect(wrapper.find('[data-testid="queue-item-u-4"]').attributes('data-depth')).toBe('2')
      expect(wrapper.find('[data-testid="queue-item-u-5"]').attributes('data-depth')).toBe('3')
    } finally {
      vi.useRealTimers()
    }
  })

  it('复活边沿：exit 计时窗内条目回归 → 清计时器回 ready，计时不把它移除', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountQB([row('u-1', 'm1'), row('u-2', 'm2')])
      await nextTick()
      await wrapper.setProps({ rows: [row('u-1', 'm1')] })
      await nextTick()
      expect(wrapper.find('[data-testid="queue-item-u-2"]').attributes('data-phase')).toBe('exit')
      // 计时到期前回归：相位翻回 ready
      await wrapper.setProps({ rows: [row('u-1', 'm1'), row('u-2', 'm2 归来')] })
      await nextTick()
      const returned = wrapper.find('[data-testid="queue-item-u-2"]')
      expect(returned.attributes('data-phase')).toBe('ready')
      expect(returned.text()).toContain('归来')
      // 推进过离场时长：不被误移除，且无重复卡
      vi.advanceTimersByTime(300)
      await nextTick()
      expect(wrapper.findAll('[data-testid="queue-item-u-2"]').length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('离场移除：CLOSE_MS 后 exit 卡出 DOM；rows 与 cards 双空 → 根门关闭', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountQB([row('u-1', 'm1')])
      await nextTick()
      await wrapper.setProps({ rows: [] })
      await nextTick()
      expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(true) // 离场窗内根还在
      vi.advanceTimersByTime(250)
      await nextTick()
      expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('QueueBubble · 堆叠几何模型（收起 reserve / 展开封顶 / depth 钳制）', () => {
  it('收起态根高 = 卡高 + 至多两层偏移（5 条 → 32 + 2×12 = 56px），层移钳 2', () => {
    const wrapper = mountQB([
      row('u-1', 'm1'), row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4'), row('u-5', 'm5'),
    ])
    const style = wrapper.find('.qb-stack').attributes('style') ?? ''
    expect(style).toContain('height: 56px')
    expect(style).toContain('--qb-banner-height: 32px')
  })

  it('展开视口高 = min(全高, 5.5 卡上限)（5 条 → 5×36−4 = 176px；happy-dom 无消息流容器跳过可用空间封顶）', async () => {
    const wrapper = mountQB([
      row('u-1', 'm1'), row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4'), row('u-5', 'm5'),
    ])
    await wrapper.find('.qb-stack').trigger('pointerenter', { pointerType: 'mouse' })
    await nextTick()
    const style = wrapper.find('.qb-stack').attributes('style') ?? ''
    expect(style).toContain('--qb-viewport-height: 176px')
  })

  it('depth 钳 3 + zIndex 梯队（存者 max(1, N−depth)，exit 恒 0）', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountQB([
        row('u-1', 'm1'), row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4'), row('u-5', 'm5'), row('u-6', 'm6'),
      ])
      await nextTick()
      const sixth = wrapper.find('[data-testid="queue-item-u-6"]')
      expect(sixth.attributes('data-depth')).toBe('3') // Math.min(5, 3)
      expect(wrapper.find('[data-testid="queue-item-u-1"]').attributes('style')).toContain('z-index: 6')
      // 离场卡 z 归 0（垫底，不遮存者）
      await wrapper.setProps({ rows: [row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4'), row('u-5', 'm5'), row('u-6', 'm6')] })
      await nextTick()
      expect(wrapper.find('[data-testid="queue-item-u-1"]').attributes('style')).toContain('z-index: 0')
    } finally {
      vi.useRealTimers()
    }
  })
})
