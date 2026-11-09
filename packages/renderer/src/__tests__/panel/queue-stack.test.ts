/**
 * QueueBubble 卡片堆叠相位机单测（OD QueuedSendStack 形态迁移，feat-queue-card-stack）。
 *
 * 覆盖（相位机与几何模型，行操作/状态映射/编辑态在 trace-inspector.test.ts 的
 * queue-bubble-s8 / queue-bubble-edit 节）：
 * - enter→ready 翻相：挂载/新增卡经强制 reflow 后脱离起始帧（DOM 断言终态 ready）
 * - 状态转移重排：queued→failed 改变显示序（failed 置顶），深度渲染期查表即时重排——
 *   失败行移到最浅层不滞留被裁剪隐藏层（重试/撤销入口可达，§3.4）
 * - exit 冻结深度：离场卡保持离场瞬间 depth 不跳位，存者按显示序重排 depth
 * - 复活边沿：exit 计时窗内条目回归 → 清计时器回 ready，不被误移除
 * - 会话切换边沿（全量换血）：旧会话卡直接移除不设 exit 相位（无跨会话残影）
 * - 离场移除：CLOSE_MS 后 exit 卡出 DOM，根门（rows 与 cards 双空）关闭
 * - 恒可见豁免：failed≥4 挤出可见窗的失败行收起态不落被裁剪层（overflow/inert 豁免），
 *   +N 角标只计非 failed 行
 * - 几何模型：收起态根高 = 卡高 + 至多两层偏移；展开视口高 = min(全高, 5.5 卡上限)
 *   （happy-dom 无布局：卡高走 MIN 兜底、消息流容器缺失跳过可用空间封顶）
 * - 卡高测量触发面：delivery.edit 同 id 换 preview 经内容签名重测（ids 不变也重测）
 * - message-stream 契约锚：measure 按 data-testid 定位消息流滚动容器封顶展开视口
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

  it('queued→failed 状态转移即时重排：失败行移到最浅层 depth 0，不滞留旧深度隐藏层（§3.4）', async () => {
    const wrapper = mountQB([
      row('u-1', 'm1'), row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4'),
    ])
    await nextTick()
    // 前置：u-4 在帧序尾 = depth 3（收起态被裁剪层）
    expect(wrapper.find('[data-testid="queue-item-u-4"]').attributes('data-depth')).toBe('3')
    // u-4 投递失败：ids 不变（重建 watch 不触发），显示序 failed 置顶——深度渲染期查表
    // 即时重排到最浅层，重试/撤销入口不被旧深度的收起态裁剪吞掉
    await wrapper.setProps({
      rows: [row('u-1', 'm1'), row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4', 'failed')],
    })
    await nextTick()
    expect(wrapper.find('[data-testid="queue-item-u-4"]').attributes('data-depth')).toBe('0')
    expect(wrapper.find('[data-testid="queue-item-u-4"]').attributes('data-overflow')).toBe('false')
    // 其余行按新显示序顺移一位（原 0..2 → 1..3）
    expect(wrapper.find('[data-testid="queue-item-u-1"]').attributes('data-depth')).toBe('1')
    expect(wrapper.find('[data-testid="queue-item-u-2"]').attributes('data-depth')).toBe('2')
    expect(wrapper.find('[data-testid="queue-item-u-3"]').attributes('data-depth')).toBe('3')
  })

  it('会话切换边沿（全量换血）：旧会话卡直接移除不设 exit 相位（无 200ms 跨会话残影），新卡正常 enter', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountQB([row('u-1', 'm1'), row('u-2', 'm2')])
      await nextTick()
      await nextTick()
      await wrapper.setProps({ rows: [row('v-1', 'n1'), row('v-2', 'n2')] })
      await nextTick()
      await nextTick()
      // 旧会话卡无 exit 尾巴，直接出 DOM
      expect(wrapper.find('[data-testid="queue-item-u-1"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="queue-item-u-2"]').exists()).toBe(false)
      // 新会话卡正常进场翻相
      expect(wrapper.find('[data-testid="queue-item-v-1"]').attributes('data-phase')).toBe('ready')
      expect(wrapper.find('[data-testid="queue-item-v-2"]').attributes('data-phase')).toBe('ready')
      // 推进过离场时长：无遗留计时器副作用，无重复卡
      vi.advanceTimersByTime(300)
      await nextTick()
      expect(wrapper.findAll('.qb-card').length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
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

  it('failed≥4 收起态恒可见（§3.4）：第 4+ 失败行不落被裁剪层（overflow/inert 豁免），+N 只计非 failed', async () => {
    const wrapper = mountQB([
      row('f1', 'm1', 'failed'), row('f2', 'm2', 'failed'), row('f3', 'm3', 'failed'), row('f4', 'm4', 'failed'),
      row('q1', 'm5'), row('q2', 'm6'),
    ])
    await nextTick()
    // 第 4 条失败行 depth 3（超可见窗），但 failed 豁免裁剪：不隐藏、不 inert（重试/撤销入口可达）
    const f4 = wrapper.find('[data-testid="queue-item-f4"]')
    expect(f4.attributes('data-depth')).toBe('3')
    expect(f4.attributes('data-overflow')).toBe('false')
    expect(f4.attributes('inert')).toBeUndefined()
    // 非 failed 行照常按位置裁剪：q1 depth 4 → overflow + inert
    const q1 = wrapper.find('[data-testid="queue-item-q1"]')
    expect(q1.attributes('data-overflow')).toBe('true')
    expect(q1.attributes('inert')).toBeDefined()
    // +N 只计被裁剪的非 failed 行：可见窗 3 层全被 failed 占 → 2 条 queued 全溢出
    expect(wrapper.find('[data-testid="queue-overflow-badge"]').text()).toBe('+2')
  })

  it('delivery.edit 同 id 换 preview → 卡高测量重测（内容签名进触发面，ids 不变也重测）', async () => {
    const wrapper = mountQB([row('u-1', '短预览')])
    await nextTick()
    // measure 内部经 document.querySelector 定位消息流容器——以其调用为测量触发的探针
    const probe = vi.spyOn(document, 'querySelector')
    try {
      await wrapper.setProps({ rows: [row('u-1', '同 id 原位编辑后长出多行的预览内容\n第二行')] })
      await nextTick()
      expect(probe).toHaveBeenCalled()
    } finally {
      probe.mockRestore()
    }
  })

  it('展开封顶按 message-stream 契约锚测可用空间（data-testid 定位，纯样式 class 仅兜底）', async () => {
    // happy-dom 无布局：stream 矩形全 0 → availableHeight = max(MIN, 0−0−4) = MIN，
    // 视口高被封顶到 MIN（对照组：无 stream 容器 → 跳过封顶 = 5.5 卡上限 176px）
    const stream = document.createElement('div')
    stream.setAttribute('data-testid', 'message-stream')
    document.body.appendChild(stream)
    try {
      const wrapper = mountQB([
        row('u-1', 'm1'), row('u-2', 'm2'), row('u-3', 'm3'), row('u-4', 'm4'), row('u-5', 'm5'),
      ])
      await wrapper.find('.qb-stack').trigger('pointerenter', { pointerType: 'mouse' })
      await nextTick()
      const style = wrapper.find('.qb-stack').attributes('style') ?? ''
      expect(style).toContain('--qb-viewport-height: 32px')
    } finally {
      stream.remove()
    }
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
