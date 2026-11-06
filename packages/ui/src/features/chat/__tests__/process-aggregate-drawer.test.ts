/**
 * 工具详情抽屉壳交互测试（chat-flow-process-aggregate u-drawer-shell / 设计 D4 + V5 抽屉断言）。
 *
 * 覆盖壳交互契约：开（Portal 渲染 + role=dialog + aria-modal + 420px 右贴边形态类 +
 * 打开即焦点入抽屉）/ 关（v-model:open 往返卸载）/ Esc 关闭 / 关闭后焦点归还触发行
 * （触发行已卸载 → 降级归还 fallback 容器）/ Tab 焦点循环（尾→首、首(shift)→尾）。
 *
 * 测试模式（设计 §5 U4 基建坑）：reka Dialog 经 Portal teleport 到 document.body，
 * mount attachTo body + flushPromises 后用 document.body.querySelector 断言
 * （primitives/dialog/__tests__/ConfirmDialog.test.ts 既有模式）；Esc/Tab 用原生
 * KeyboardEvent dispatchEvent（bubbles）冒泡到 DismissableLayer / FocusScope 容器触发。
 *
 * 运行：根目录 node scripts/run-domain-tests.mjs chat（本文件落 features/chat/__tests__/，
 * 经 chat 切片 glob 自动并入域触发收集）
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { ToolDetailDrawer } from '../../../primitives/dialog'
import {
  bindDrawerSessionId,
  drawerControl,
  useDrawerControl,
} from '@taiji/core/domain/drawer'
import type { FlatBlock, ProcessSegment, ProcessSegmentCounts, ProcessSegmentUnit } from '@taiji/core/domain/chat'
import type { ToolCall } from '@taiji/shared'
import AggregateExpandedBody from '../process-aggregate/AggregateExpandedBody.vue'
import { mockChatProvide } from './helpers'

/** 焦点陷阱容器（reka DismissableLayer 渲染的 role=dialog 面板，teleport 到 body） */
function drawerEl(): HTMLElement {
  const el = document.body.querySelector('[role="dialog"]')
  if (!(el instanceof HTMLElement)) throw new Error('抽屉面板未找到（role=dialog），现有：' + document.body.innerHTML.slice(0, 200))
  return el
}

function testidEl(testid: string): HTMLElement {
  const el = document.body.querySelector(`[data-testid="${testid}"]`)
  if (!(el instanceof HTMLElement)) throw new Error(`data-testid=${testid} 未找到`)
  return el
}

/** mountDrawer 入参（壳 props + 字符串模板插槽；类型化消解 slots 选项的 unknown 赋值） */
async function mountDrawer(props: {
  open?: boolean
  title?: string
  fallbackFocusTarget?: HTMLElement | null
  slots?: Record<string, string>
} = {}) {
  // slots 是 mount 选项（与 props 平级），从入参对象里拆出
  const { slots, ...rest } = props
  const wrapper = mount(ToolDetailDrawer, {
    props: { open: false, ...rest },
    slots,
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

/** 打开抽屉并断言焦点已进入抽屉（reka FocusScope 挂载自动聚焦首个可聚焦元素） */
async function openDrawer(wrapper: Awaited<ReturnType<typeof mountDrawer>>) {
  wrapper.setProps({ open: true })
  await flushPromises()
  const drawer = drawerEl()
  expect(drawer.contains(document.activeElement), '打开后焦点应自动进入抽屉').toBe(true)
  return drawer
}

/** 在元素上派发 Tab keydown（bubbles 冒泡到 FocusScope 容器触发循环） */
function dispatchTab(target: Element, shift = false): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

// u-detail-drawer 起装配组件（AggregateExpandedBody → SegmentToolRow/AggregateToolDetailDrawer）
// 与壳（ToolDetailDrawer 缺省标题）都消费 useI18n：字典模式（键命中出文案，
// process-aggregate-block.test.ts 同范式）。
vi.mock('vue-i18n', async () => {
  const { i18nMock } = await import('../../../__tests__/helpers/i18n-mock')
  return i18nMock({
    'panel.message.aggDetailTitle': '详情',
    'panel.message.aggRowFailed': '失败',
    'panel.message.aggGroupRunning': '进行中',
    'panel.message.aggStatusDone': '已完成',
    'panel.message.aggDetailStillRunning': '仍在执行',
    'panel.message.aggDetailParams': '参数',
    'panel.message.aggDetailOutput': '输出',
  })
})

describe('ToolDetailDrawer（工具详情抽屉壳）', () => {
  it('开：Portal 渲染 role=dialog + aria-modal + 420px 右贴边形态类 + 插槽内容上屏', async () => {
    await mountDrawer({
      open: true,
      title: 'bash · 详情',
      slots: { default: '<p>命令：pnpm test</p>' },
    })
    const drawer = drawerEl()
    // 可访问性契约：role=dialog 由 reka 承担、aria-modal 壳补齐
    expect(drawer.getAttribute('aria-modal')).toBe('true')
    expect(testidEl('tool-detail-drawer')).toBe(drawer)
    expect(document.body.textContent).toContain('bash · 详情')
    // 内容插槽承接（命令/参数/输出等由装配方经插槽传入）
    expect(document.body.textContent).toContain('命令：pnpm test')
    // 420px 右贴边形态在壳层定型（消费点直接用）：宽档 + 右贴边 + 全高
    const cls = drawer.getAttribute('class') ?? ''
    expect(cls).toContain('w-[420px]')
    expect(cls).toContain('right-0')
    expect(cls).toContain('inset-y-0')
  })

  it('关：open 翻转 false 后抽屉从 DOM 卸载（Portal 内容移除）', async () => {
    const wrapper = await mountDrawer({ open: true })
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    wrapper.setProps({ open: false })
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).toBeNull()
  })

  it('Esc 关闭：面板内 Escape keydown → emit update:open(false)', async () => {
    const wrapper = await mountDrawer({ open: true })
    drawerEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    const events = wrapper.emitted('update:open')
    expect(events).toBeTruthy()
    expect((events as unknown[][])[(events as unknown[]).length - 1][0]).toBe(false)
  })

  it('焦点归还：关闭后归还触发行（open 时刻的焦点元素）', async () => {
    const container = document.createElement('div')
    container.setAttribute('data-testid', 'chat-container')
    document.body.appendChild(container)
    const trigger = document.createElement('button')
    trigger.textContent = '工具行'
    container.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const wrapper = await mountDrawer()
    await openDrawer(wrapper)
    // 开启期间焦点在抽屉内，触发行不再持有焦点
    expect(document.activeElement).not.toBe(trigger)

    wrapper.setProps({ open: false })
    await flushPromises()
    expect(document.activeElement).toBe(trigger)
  })

  it('焦点归还降级：触发行已卸载 → 归还 fallbackFocusTarget（对话流容器）', async () => {
    const container = document.createElement('div')
    container.setAttribute('data-testid', 'chat-container')
    document.body.appendChild(container)
    const trigger = document.createElement('button')
    trigger.textContent = '工具行'
    container.appendChild(trigger)
    trigger.focus()

    const wrapper = await mountDrawer({ fallbackFocusTarget: container })
    await openDrawer(wrapper)
    // 触发行被虚拟滚动卸载（断连）
    trigger.remove()

    wrapper.setProps({ open: false })
    await flushPromises()
    expect(document.activeElement).toBe(container)
  })

  it('Tab 焦点循环：末位元素 Tab 回首位，首位元素 shift+Tab 到末位', async () => {
    await mountDrawer({
      open: true,
      slots: { default: '<div><button data-testid="slot-a">A</button><button data-testid="slot-b">B</button></div>' },
    })
    const drawer = drawerEl()
    const closeBtn = drawer.querySelector('header button')
    const slotA = testidEl('slot-a')
    const slotB = testidEl('slot-b')
    // DOM 序 tabbable 边缘：首位 = header 关闭钮，末位 = 插槽末按钮
    expect(closeBtn).not.toBeNull()

    // 末位 → Tab → 首位（closeAutoFocus 循环回卷）
    slotB.focus()
    dispatchTab(slotB)
    expect(document.activeElement).toBe(closeBtn)

    // 首位 → shift+Tab → 末位
    dispatchTab(closeBtn as HTMLElement, true)
    expect(document.activeElement).toBe(slotB)
  })
})

// ─── u-detail-drawer 接线：成员行点击 → 抽屉内容装配 ─────────────────────────────
// 装配链：AggregateExpandedBody（本地消费 open-detail，事件终结于此）→ SegmentToolRow
// 点击 → AggregateToolDetailDrawer（壳 = ToolDetailDrawer，teleport 到 body）。

let flatSeqNb = 0
function nbToolFlat(over: Partial<ToolCall> = {}): FlatBlock {
  const tc: ToolCall = {
    id: `nb-tc-${++flatSeqNb}`,
    toolName: 'bash',
    input: { command: 'pnpm vitest run --reporter=dot' },
    output: 'Test Files  2 passed (2)',
    status: 'completed',
    startTime: 1000,
    endTime: 5000,
    ...over,
  }
  return {
    assistantId: 'a1',
    assistantStatus: 'streaming',
    block: { kind: 'tool', ref: tc },
    flatIndex: flatSeqNb - 1,
  }
}

function nbCounts(): ProcessSegmentCounts {
  return {
    categoryCounts: { explore: 0, edit: 0, exec: 1 },
    thinkingCount: 0,
    totalDurationMs: 4000,
    failedCount: 0,
  }
}

function nbSegment(members: FlatBlock[]): ProcessSegment {
  return {
    id: `seg:nb-${members[0]?.flatIndex ?? 0}`,
    members,
    groups: [],
    units: members.map((b) => ({ kind: 'member', block: b })) as ProcessSegmentUnit[],
    counts: nbCounts(),
    followedByText: true,
  }
}

type ExpandedHostWrapper = ReturnType<typeof mount>

async function mountExpandedBody(members: FlatBlock[]): Promise<ExpandedHostWrapper> {
  const wrapper = mount(AggregateExpandedBody, {
    props: { segment: nbSegment(members), sessionId: 'sess-drawer-test' },
    attachTo: document.body,
    global: { provide: mockChatProvide() },
  })
  await flushPromises()
  return wrapper
}

async function openDetailViaRow(wrapper: ExpandedHostWrapper, rowSelector = '[data-testid="agg-tool-row"]'): Promise<void> {
  await wrapper.find(rowSelector).trigger('click')
  await flushPromises()
}

describe('工具详情抽屉接线（成员行点击 → 内容装配）', () => {
  it('点击成员行 → 抽屉开（teleport body）：元信息/完整参数/完整输出在抽屉内装配', async () => {
    const wrapper = await mountExpandedBody([nbToolFlat()])
    await openDetailViaRow(wrapper)
    const drawer = drawerEl()
    expect(drawer.textContent).toContain('bash')
    // 完整命令/参数（超宽省略的「看全」通道）与完整输出都落在抽屉面板内
    expect(drawer.querySelector('[data-testid="agg-detail-params"]')?.textContent).toContain('pnpm vitest run --reporter=dot')
    expect(drawer.querySelector('[data-testid="agg-detail-output"]')?.textContent).toContain('Test Files  2 passed (2)')
    // 元信息行：工具名 + 状态词（completed → 已完成）+ 耗时由 formatDuration 产出
    expect(drawer.querySelector('[data-testid="agg-detail-meta"]')?.textContent).toContain('已完成')
    // 输出区 240px 内滚：BlockScrollBox 限高令牌共用（desktop token 原值原串内联绑定）
    const viewport = drawer.querySelector('[data-testid="block-scroll-viewport"]')
    expect(viewport?.getAttribute('style')).toContain('var(--block-scroll-max-height)')
    // 关闭后抽屉卸载（v-model:open 往返）
    drawerEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).toBeNull()
  })

  it('运行中步骤打开时显示「仍在执行」注记；状态翻转 completed 后注记消失（事件驱动，零 timer）', async () => {
    const runningMembers = [nbToolFlat({ status: 'running', endTime: undefined, output: 'still streaming…' })]
    const wrapper = await mountExpandedBody(runningMembers)
    await openDetailViaRow(wrapper)
    const drawer = drawerEl()
    expect(drawer.querySelector('[data-testid="agg-detail-running"]')?.textContent).toBe('仍在执行')

    // 锚定工具状态翻转（running→completed，reload 后补收终态的事件形态）：
    // 换新 segment prop 驱动重渲染——抽屉保持开启，注记消失、状态词跟随翻转
    const toolRef = runningMembers[0].block as { ref: ToolCall }
    toolRef.ref = { ...toolRef.ref, status: 'completed', endTime: 9000 }
    await wrapper.setProps({ segment: nbSegment(runningMembers) })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="agg-detail-running"]')).toBeNull()
    expect(drawerEl().querySelector('[data-testid="agg-detail-meta"]')?.textContent).toContain('已完成')
  })

  it('修改类按增删着色：edit 的 unified patch（details.patch）行首 +/-/@@ 分色渲染', async () => {
    const wrapper = await mountExpandedBody([
      nbToolFlat({
        toolName: 'edit',
        input: { path: '/tmp/foo.ts' },
        output: 'File edited',
        details: { patch: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,2 +1,2 @@\n-const old = 1\n+const next = 2\n context line' },
      }),
    ])
    await openDetailViaRow(wrapper)
    const output = drawerEl().querySelector('[data-testid="agg-detail-output"]')
    expect(output).not.toBeNull()
    // 增行 accent / 删行 danger（修改类增删着色——缺壳兜底通道按行首结构信号分色）
    const plusLine = output!.querySelector('span.text-accent')
    const minusLine = output!.querySelector('span.text-danger')
    expect(plusLine?.textContent).toBe('+const next = 2')
    expect(minusLine?.textContent).toBe('-const old = 1')
    // hunk 头与文件头 dim（不在增删分色内）
    expect(output!.querySelector('span.text-neutral-dim')?.textContent).toBe('--- a/foo.ts')
  })

  it('失败步骤打开时 error 文本显式在场（替换空 output 的内容位）', async () => {
    const wrapper = await mountExpandedBody([
      nbToolFlat({ status: 'error', output: undefined, error: 'exit code 1: command not found' }),
    ])
    await openDetailViaRow(wrapper)
    const drawer = drawerEl()
    expect(drawer.querySelector('[data-testid="agg-detail-error"]')?.textContent).toContain('exit code 1: command not found')
    // 失败词入元信息行（状态位）
    expect(drawer.querySelector('[data-testid="agg-detail-meta"]')?.textContent).toContain('失败')
  })
})

// ─── 邻居不变量（V5 步骤 6）：工具详情抽屉与右抽屉通道并存互不干扰 ─────────────────
// 右抽屉通道 = core domain/drawer 控制态（{isOpen, activeTab} per-session 分区，真实模块
// 不 mock——工具详情抽屉若错误写入控制态（共享开合态回归形态），控制态信号断言即红）。
// D4 选型：工具详情抽屉是自有开合态的模态通道，不接 tab 注册制——本组用例是它的回归网。

/** 右抽屉 tab 内容模拟：内部计数状态，实例被卸载重挂即归零（「内容状态无损」的探针） */
const NbTabContent = defineComponent({
  name: 'NbTabContent',
  setup() {
    const count = ref(0)
    return () =>
      h('button', { 'data-testid': 'nb-tab-count', onClick: () => { count.value++ } }, `count:${count.value}`)
  },
})

/** 邻居宿主：右抽屉控制态信号 + isOpen 时挂载的 tab 内容 + 工具详情接线（展开平铺区） */
const NbNeighborHost = defineComponent({
  name: 'NbNeighborHost',
  setup() {
    const ctrl = useDrawerControl()
    return () =>
      h('div', { 'data-testid': 'nb-host' }, [
        h('div', { 'data-testid': 'nb-drawer-signal' }, `open:${ctrl.isOpen.value} tab:${ctrl.activeTab.value}`),
        ctrl.isOpen.value ? h(NbTabContent) : null,
        h(AggregateExpandedBody, { segment: nbSegment([nbToolFlat()]), sessionId: 'sess-nb' }),
      ])
  }
})

let sidSeq = 0

async function mountNeighborHost() {
  // 每用例独立 sid 分区（per-session 分区 Map 模块级单例——新 sid 即新分区，用例间零泄漏）
  bindDrawerSessionId(ref(`nb-sid-${++sidSeq}`))
  const wrapper = mount(NbNeighborHost, {
    attachTo: document.body,
    global: { provide: mockChatProvide() },
  })
  await flushPromises()
  return wrapper
}

function drawerSignal(wrapper: ExpandedHostWrapper): string {
  return wrapper.find('[data-testid="nb-drawer-signal"]').text()
}

describe('邻居不变量（V5 步骤 6）：与右抽屉通道并存互不干扰', () => {
  it('先开右抽屉（detail tab）再点成员行开工具详情：两通道并存，右抽屉开合态与 activeTab 不变', async () => {
    const wrapper = await mountNeighborHost()
    drawerControl.open('detail')
    await flushPromises()
    expect(drawerSignal(wrapper)).toBe('open:true tab:detail')

    await openDetailViaRow(wrapper)
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).not.toBeNull()
    // 工具详情抽屉（自有开合态）未触碰右抽屉控制态（D4：两通道无共享开合态）
    expect(drawerSignal(wrapper)).toBe('open:true tab:detail')

    // Esc 关闭工具详情抽屉 → 右抽屉仍开着、tab 不丢
    drawerEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).toBeNull()
    expect(drawerSignal(wrapper)).toBe('open:true tab:detail')
  })

  it('Esc 关闭工具详情后右抽屉 tab 内容状态无损（内容实例未被卸载重挂）', async () => {
    const wrapper = await mountNeighborHost()
    drawerControl.open('detail')
    await flushPromises()
    const tabCount = (): HTMLElement => {
      const el = document.body.querySelector('[data-testid="nb-tab-count"]')
      if (!(el instanceof HTMLElement)) throw new Error('右抽屉 tab 内容探针未找到（isOpen 应为 true）')
      return el
    }
    // 原生 click 后 DOM 文本经 Vue 渲染 flush 才更新（响应式 DOM patch 在微任务）
    tabCount().click()
    await flushPromises()
    tabCount().click()
    await flushPromises()
    expect(tabCount().textContent).toBe('count:2')

    await openDetailViaRow(wrapper)
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).not.toBeNull()
    drawerEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).toBeNull()
    // 计数保留 = tab 内容实例存活（若工具详情抽屉错误写 isOpen=false，本实例卸载重挂即归零）
    expect(tabCount().textContent).toBe('count:2')
  })

  it('反向：先点成员行开工具详情再开右抽屉——工具详情不被关闭，Esc 后右抽屉态无损', async () => {
    const wrapper = await mountNeighborHost()
    await openDetailViaRow(wrapper)
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).not.toBeNull()

    drawerControl.open('git')
    await flushPromises()
    // 右抽屉正常打开，工具详情（模态自有开合态）不被右抽屉关闭
    expect(drawerSignal(wrapper)).toBe('open:true tab:git')
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).not.toBeNull()

    // Esc 关工具详情（DismissableLayer 捕获面板内 Escape）→ 右抽屉开合态与 activeTab 不变
    drawerEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).toBeNull()
    expect(drawerSignal(wrapper)).toBe('open:true tab:git')
  })
})
