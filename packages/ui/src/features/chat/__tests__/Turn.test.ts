/**
 * Turn.vue trace 区单测（chat-flow-process-aggregate U3 聚合块形态）。
 *
 * 覆盖：
 * 1. D5 折叠形态：折叠态 / 完成态 / 历史手动展开同形态——全部聚合块摘要行 + 末位正文
 * 2. 工作态聚合形态（D2）：全部正文原生渲染 + 聚合块三态接线（双窗 / 摘要 / 失败标记）
 * 3. turn-attribution W4：trigger 起点行 + turn 内 notice 渲染
 * 4. 聚合块键稳定性（AX1 两方向）+ v-memo deps 完整性（S-3 非末位成员翻转）
 * 5. [actions-anchor] 操作栏插槽只挂 trace 末单元为正文的块
 * 6. 正文颜色逐消息派生（chat-flow-text-color D1）
 *
 * 用真实 flattenTurnBlocks / splitProcessSegments（RC-1，不 mock core）。
 * 并入计数摘要行 / 接管态（展开全部）已随 D1/D9 退役，旧窗口切片断言组随之删除；
 * 旧「run 组接线」断言改造为聚合块单元断言（组形态归聚合块组件族，U2 测试承载）。
 *
 * 运行：node scripts/run-domain-tests.mjs chat（域触发收集；本文件在 chat 域切片清单内）
 */
import { describe, it, expect, vi } from 'vitest'

// mock vue-i18n 的 useI18n：自包含 t（vue-i18n v10 的 createI18n 返回对象作 test-utils plugin 时报
// 「must be a function or object with install」，直接 mock useI18n 最可靠）。
// 聚合块摘要行 / 组条目文案键（traceFailed / runGroup* / aggProcessLabel）由本文件按断言需要
// 注入字典；trigger 行聚合文案键（turnTriggerBgNotify*）沿用既有口径。
// 共享 mock 口径见 helpers/i18n-mock（g9-F5）。
vi.mock('vue-i18n', async () => {
  const { i18nMock } = await import('../../../__tests__/helpers/i18n-mock')
  return i18nMock({
    'panel.message.traceFailed': '含 {count} 次失败',
    'panel.message.aggProcessLabel': '过程',
    'panel.message.aggGroupRunning': '进行中',
    'panel.message.aggStatusDone': '已完成',
    'panel.message.runGroupSteps': '{count} 步',
    'panel.message.turnTriggerBgNotifySummary': '{count} 个后台任务完成',
    'panel.message.turnTriggerBgNotifyContinued': '已继续处理',
    // 边界行失败分句专用键（D5「· M 失败」）：与聚合块的 traceFailed 不同键，
    // 文案按设计字面（无「含…次」句式）
    'panel.message.turnTriggerBgNotifyFailed': '{count} 失败',
  })
})

import { mount } from '@vue/test-utils'
import { Bell, CheckCircle2, TriangleAlert } from '@lucide/vue'
import { Turn } from '@taiji/ui'
import UserBubble from '../UserBubble.vue'
import type { MessageTurn, NotifySummary } from '@taiji/core/domain/chat'
import type { ContentBlock, Message, ToolCall } from '@taiji/shared'
import { mockChatProvide } from './helpers'

const NOW = 1_700_000_000_000
const SID = 'sess-trace-window-test'

// ─── fixture 构造 ───────────────────────────────────────────────

/** 基础 turn（fallback 路径产出 [text, thinking, tool]——无 contentBlocks 的降级时序）。 */
function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  const assistant: Message = {
    id: 'a1',
    role: 'assistant',
    content: '最终回复',
    status: 'complete',
    timestamp: NOW,
    thinking: [{ id: 'th1', content: '推理过程', collapsed: true }],
    toolCalls: [{ id: 'tc1', toolName: 'read', input: { path: '/tmp/x' }, status: 'completed', startTime: NOW }],
  }
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
    assistants: [assistant],
    isStreaming: false,
    hasFoldable: true,
    ...over,
  }
}

/** contentBlocks 序列规格：正文 / 工具 / 思考按声明顺序产出真实时序分支。 */
type BlockSpec =
  | { kind: 'text'; content?: string }
  | { kind: 'tool'; toolName: string; status?: ToolCall['status']; id?: string; error?: string }
  | { kind: 'thinking'; content?: string; id?: string }

/**
 * 按块规格构造单 assistant turn（contentBlocks 显式时序，走 expandAssistantBlocks 真实分支）。
 * 工具名在 RUN_GROUP_TOOLS 类型表内的连续同类型块在切段时归入同组（core 单点，口径归 U1 单测）。
 */
function makeSeqTurn(
  specs: BlockSpec[],
  opts: { assistantStatus?: Message['status']; isStreaming?: boolean; textFinalized?: boolean } = {},
): MessageTurn {
  const status = opts.assistantStatus ?? 'complete'
  const toolCalls: ToolCall[] = []
  const thinking: Array<{ id: string; content: string; collapsed: boolean }> = []
  const contentBlocks: ContentBlock[] = []
  let toolSeq = 0
  let thinkSeq = 0
  let textSeq = 0
  for (const spec of specs) {
    if (spec.kind === 'text') {
      const refId = `text-${textSeq++}`
      contentBlocks.push({ type: 'text', refId })
    } else if (spec.kind === 'thinking') {
      const id = spec.id ?? `th-${thinkSeq}`
      thinking.push({ id, content: spec.content ?? '推理过程', collapsed: true })
      contentBlocks.push({ type: 'thinking', refId: id })
      thinkSeq += 1
    } else {
      const id = spec.id ?? `tc-${toolSeq}`
      toolCalls.push({
        id,
        toolName: spec.toolName,
        input: { path: `/tmp/f${toolSeq}` },
        status: spec.status ?? 'completed',
        startTime: NOW + toolSeq,
        ...(spec.status === 'error' ? { error: spec.error ?? 'exit 1', endTime: NOW + toolSeq + 100 } : {}),
        ...(spec.status === 'running' ? {} : { endTime: NOW + toolSeq + 100 }),
      })
      contentBlocks.push({ type: 'toolCall', refId: id })
      toolSeq += 1
    }
  }
  const assistant: Message = {
    id: 'a1',
    role: 'assistant',
    content: specs.filter((s) => s.kind === 'text').map((s) => (s as { content?: string }).content ?? '正文').join('\n') || '最终回复',
    status,
    timestamp: NOW,
    ...(thinking.length > 0 ? { thinking } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    contentBlocks,
    ...(opts.textFinalized !== undefined ? { textFinalized: opts.textFinalized } : {}),
  }
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
    assistants: [assistant],
    isStreaming: opts.isStreaming ?? status === 'streaming',
    hasFoldable: specs.length > 0,
  }
}

// ─── mount helper ───────────────────────────────────────────────

/** 正文 stub：TextRow 渲染链含异步 shiki，stub 后 text() 可断言正文（md-stub）。 */
const MdInlineStub = {
  props: ['content', 'variant'],
  template: '<div class="md-stub">{{ content }}</div>',
}

function mountTurn(opts: {
  turn?: MessageTurn
  isSessionActive?: boolean
  isLastTurn?: boolean
  isExpanded?: (key: string) => boolean
} = {}) {
  return mount(Turn, {
    props: {
      turn: opts.turn ?? makeTurn(),
      sessionId: SID,
      ...(opts.isSessionActive !== undefined ? { isSessionActive: opts.isSessionActive } : {}),
      ...(opts.isLastTurn !== undefined ? { isLastTurn: opts.isLastTurn } : {}),
    },
    global: {
      provide: mockChatProvide({
        isExpanded: opts.isExpanded ?? (() => false),
      }),
      stubs: {
        UserBubble: true,
        TurnMeta: true,
        TurnSummary: true,
        ChangeSetCard: true,
        MarkdownRenderer: MdInlineStub,
      },
    },
  })
}

// trace 区顶层单元（.trace > .trace-blk wrapper）取样单源：块数口径一律指顶层单元数
// （正文 wrapper / 聚合块 wrapper 各计 1；聚合块内部行非 .trace 直子不误计）。
/** wrapper 最小形态（DOMWrapper 的本用例消费子集；显式接口替代 unknown 避免 TS2571）。 */
interface UnitWrapperLike {
  classes: () => string[]
  text: () => string
  element: Element
  find: (selector: string) => { exists: () => boolean; text: () => string; element: Element }
}
const traceTopBlocks = (wrapper: { findAll: (s: string) => UnitWrapperLike[] }) =>
  wrapper.findAll('.trace > .trace-blk')

// ═════════════════════════════════════════════════════════════════
// describe 1：D5 折叠形态（scope wave 回归改造——折叠 / 手动展开同形态）
// ═════════════════════════════════════════════════════════════════

describe('chat-flow-process-aggregate D5: 折叠形态（摘要行 + 末位正文）', () => {
  it('非末位 turn（isLastTurn=false）→ 折叠形态：聚合块摘要行 + 末位正文，过程细节不渲染', () => {
    const wrapper = mountTurn({ isSessionActive: true, isLastTurn: false })
    // 顶层 2 单元：聚合块（thinking+tool 段，fallback 时序 [text, thinking, tool]）
    const blocks = traceTopBlocks(wrapper)
    expect(blocks.length).toBe(2)
    // 首单元 = 聚合块摘要行（非工作态 isLive=false）
    expect(blocks[0].find('[data-testid="agg-summary-row"]').exists()).toBe(true)
    expect(blocks[0].find('[data-testid="agg-live-windows"]').exists()).toBe(false)
    // 末单元 = 末位正文（.trace-blk--text wrapper 契约 + 正文内容在场）
    expect(blocks[1].classes()).toContain('trace-blk--text')
    expect(blocks[1].text()).toContain('最终回复')
    // 过程细节不在场（思考行 / 工具行只在聚合块展开态渲染）
    expect(wrapper.find('.trace-think').exists()).toBe(false)
    expect(wrapper.find('.trace-tool').exists()).toBe(false)
  })

  it('末位工作 turn（isLastTurn=true, sessionActive）→ 展开形态：正文 + 聚合块双窗（进行中）', () => {
    const wrapper = mountTurn({
      turn: makeSeqTurn(
        [{ kind: 'thinking' }, { kind: 'tool', toolName: 'read', status: 'running' }],
        { assistantStatus: 'streaming' },
      ),
      isSessionActive: true,
      isLastTurn: true,
    })
    const blocks = traceTopBlocks(wrapper)
    // fallback makeTurn 无后继 text（段开放）→ 双窗进行中；本 fixture 段后无 text，同型
    expect(blocks.length).toBe(1)
    expect(blocks[0].find('[data-testid="agg-live-windows"]').exists()).toBe(true)
    expect(blocks[0].find('[data-testid="agg-summary-row"]').exists()).toBe(false)
    // 思考窗 + 聚合窗双窗在场（段内已有思考与工具步骤）
    expect(blocks[0].find('[data-testid="agg-think-window"]').exists()).toBe(true)
    expect(blocks[0].find('[data-testid="agg-window"]').exists()).toBe(true)
  })

  it('正文块入场动效挂点（D10）：工作态正文 wrapper 携带 agg-text-enter，历史/折叠形态不携带（重挂不重放）', () => {
    // 工作态挂载：正文单元 wrapper 携带入场动画类（首次插入播放一次，300ms 形态在
    // aggregate-motion.css；同块内容增长经 :key 保活元素复用，happy-dom 下不重启动画）
    const working = mountTurn({
      turn: makeSeqTurn([{ kind: 'text', content: '流式正文' }], { assistantStatus: 'streaming' }),
      isSessionActive: true,
      isLastTurn: true,
    })
    expect(working.find('.trace-blk--text').classes()).toContain('agg-text-enter')
    // 历史回合挂载（virtua 卸载重挂载形态）：turnWorking=false 快照 → 无动画类，不重放
    const settled = mountTurn({ isSessionActive: false, isLastTurn: false })
    expect(settled.find('.trace-blk--text').classes()).not.toContain('agg-text-enter')
  })

  it('手动展开（isExpanded=true）与折叠态同形态（D5：展开的语义是显式意图，不改默认形态）', () => {
    const wrapper = mountTurn({
      isSessionActive: true,
      isLastTurn: false,
      isExpanded: () => true,
    })
    const blocks = traceTopBlocks(wrapper)
    expect(blocks.length).toBe(2)
    expect(blocks[0].find('[data-testid="agg-summary-row"]').exists()).toBe(true)
    expect(blocks[1].classes()).toContain('trace-blk--text')
    // 点摘要行展开该段（回合级展开不展开段——每段一个入口，D9 收敛后唯一路径）
    expect(wrapper.find('.trace-think').exists()).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════
// describe 2：工作态聚合形态（D2 正文原生 + 段计数 / 失败标记）
// ═════════════════════════════════════════════════════════════════
describe('chat-flow-process-aggregate 工作态: D2 正文原生 + 段摘要', () => {
  /** 交替形态 fixture：过程 → 正文 → 过程 → 正文 → 过程（三段两正文） */
  const alternatingTurn = () =>
    makeSeqTurn([
      { kind: 'tool', toolName: 'read' },
      { kind: 'text', content: '中间结论一' },
      { kind: 'tool', toolName: 'bash' },
      { kind: 'text', content: '中间结论二' },
      { kind: 'tool', toolName: 'edit' },
    ], { assistantStatus: 'streaming' })

  it('D2: 多正文交替回合工作态 → 每条正文原生渲染（不并入计数摘要），聚合块按段在场', () => {
    const wrapper = mountTurn({
      turn: alternatingTurn(),
      isSessionActive: true,
      isLastTurn: true,
    })
    // 顶层 5 单元：[agg1, text1, agg2, text2, agg3]（末段开放无后继正文）
    const blocks = traceTopBlocks(wrapper)
    expect(blocks.map((b) => b.classes().includes('trace-blk--text'))).toEqual([
      false,
      true,
      false,
      true,
      false,
    ])
    // 正文块 3 条…本 fixture 只声明 2 条正文（末段过程块收尾）——2 条全在场
    const textBlocks = wrapper.findAll('.trace-blk--text')
    expect(textBlocks.length).toBe(2)
    expect(textBlocks[0].text()).toContain('中间结论一')
    expect(textBlocks[1].text()).toContain('中间结论二')
  })

  it('已完成段在工作态显摘要行（followedByText 封闭），末段双窗进行中', () => {
    const wrapper = mountTurn({
      turn: alternatingTurn(),
      isSessionActive: true,
      isLastTurn: true,
    })
    const blocks = traceTopBlocks(wrapper)
    // 段 1/2 已被后继正文封闭 → 摘要行；段 3 开放且回合进行中 → 双窗
    expect(blocks[0].find('[data-testid="agg-summary-row"]').exists()).toBe(true)
    expect(blocks[2].find('[data-testid="agg-summary-row"]').exists()).toBe(true)
    expect(blocks[4].find('[data-testid="agg-live-windows"]').exists()).toBe(true)
  })

  it('收编行 / 接管态 chrome 已退役：trace 区无 trace-compactor 锚点（D1/D9）', () => {
    const wrapper = mountTurn({
      turn: makeSeqTurn([
        { kind: 'tool', toolName: 'bash' },
        { kind: 'tool', toolName: 'bash' },
        { kind: 'tool', toolName: 'bash' },
        { kind: 'tool', toolName: 'bash' },
        { kind: 'tool', toolName: 'bash' },
        { kind: 'text', content: '结论' },
      ], { assistantStatus: 'streaming' }),
      isSessionActive: true,
      isLastTurn: true,
    })
    // 窗口切片与收编行随聚合块形态退役：5 过程块收 1 个聚合块 + 1 正文（占位与步骤数解耦）
    expect(traceTopBlocks(wrapper).length).toBe(2)
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(false)
  })

  it('D3/G4: 含失败工具 → 摘要行失败标记在场（「含 N 次失败」，不需接管态）', () => {
    const wrapper = mountTurn({
      turn: makeSeqTurn([
        { kind: 'tool', toolName: 'bash', status: 'error' },
        { kind: 'tool', toolName: 'bash', status: 'error' },
        { kind: 'tool', toolName: 'bash', status: 'error' },
        { kind: 'text', content: '结论' },
      ]),
      isSessionActive: true,
      isLastTurn: false,
    })
    // 折叠形态：聚合块摘要行失败标记（口径 = 段内已完成失败块数，core counts 单源）
    const failed = wrapper.find('[data-testid="agg-summary-failed"]')
    expect(failed.exists()).toBe(true)
    expect(failed.text()).toContain('含 3 次失败')
  })
})

// ═════════════════════════════════════════════════════════════════
// describe 3：turn-attribution W4 —— trigger 起点行 + turn 内 notice 渲染
//
// 固化 D3/D4 渲染契约（conversation-turn-attribution §3.1 / §3.3）：
// - trigger==='bg-notify' && user===null 的 turn 渲染轻量起点行（非 user 气泡）；
// - turn.notices 在 turn 内部末尾渲染：bashExecution → BashOutputBlock（复用既有消费点）、
//   liveOnly → SystemNotice 弱化行；wrapper testid = turn-inline-bash / turn-inline-notice。
// ═════════════════════════════════════════════════════════════════
describe('turn-attribution W4: trigger 起点行 + turn 内 notice', () => {
  /** bg-notify 续跑 turn：user:null + trigger + assistant 结果（无 notice 的基础形态） */
  function makeTriggerTurn(over: Partial<MessageTurn> = {}): MessageTurn {
    return {
      index: 1,
      user: null,
      trigger: 'bg-notify',
      assistants: [
        { id: 'a-bg1', role: 'assistant', content: '后台任务结果已处理', status: 'complete', timestamp: NOW },
      ],
      isStreaming: false,
      hasFoldable: false,
      ...over,
    }
  }

  /** turn 内 bash notice（role:'system' + bashExecution，分组规则 4 inline 归 turn） */
  function bashNotice(id: string): Message {
    return {
      id,
      role: 'system',
      content: '',
      status: 'complete',
      bashExecution: {
        command: 'npm test',
        output: 'all passed',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: NOW,
      },
      timestamp: NOW,
    } as Message
  }

  /** turn 内 liveOnly 健康警告（stream_warn，无 entry 无 replay 对应物） */
  function liveOnlyNotice(id: string): Message {
    return {
      id,
      role: 'system',
      content: '上下文长度接近上限，请注意',
      status: 'complete',
      liveOnly: true,
      timestamp: NOW,
    } as Message
  }

  it('W4-T1: trigger turn（user:null + trigger:bg-notify）工作态 → 起点行渲染且含从文案，UserBubble 不渲染；落成态起点行退役（数据收进轮头行）', () => {
    const wrapper = mountTurn({ turn: makeTriggerTurn(), isSessionActive: true, isLastTurn: true })
    const row = wrapper.find('[data-testid="turn-trigger-bgnotify"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('已继续处理')
    // 非 user 气泡：起点行是弱化元信息行，不冒充用户发言
    expect(wrapper.findComponent(UserBubble).exists()).toBe(false)
    // 落成态（settle）：聚合行摘除，收纳数据改道 TurnMeta 折叠标签
    const settled = mountTurn({ turn: makeTriggerTurn(), isSessionActive: false, isLastTurn: true })
    expect(settled.find('[data-testid="turn-trigger-bgnotify"]').exists()).toBe(false)
  })

  it('W4-T2: 普通 user turn → 无 trigger 起点行（UserBubble 正常渲染）', () => {
    const wrapper = mountTurn({ turn: makeTurn() })
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify"]').exists()).toBe(false)
    expect(wrapper.findComponent(UserBubble).exists()).toBe(true)
  })

  it('W4-T3: assistant 自启 turn（user:null 无 trigger）→ 起点行与 UserBubble 都不渲染（首条 assistant 边缘形态不变）', () => {
    const wrapper = mountTurn({ turn: makeTriggerTurn({ trigger: undefined }) })
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify"]').exists()).toBe(false)
    expect(wrapper.findComponent(UserBubble).exists()).toBe(false)
  })

  it('W4-N1: turn.notices 渲染在 turn 内部末尾——bash 复用 BashOutputBlock、liveOnly 走 SystemNotice 弱化行', () => {
    const wrapper = mountTurn({
      turn: makeTurn({ notices: [bashNotice('bash-n1'), liveOnlyNotice('warn-n1')] }),
    })
    // bash notice：wrapper testid + 内部复用 BashOutputBlock（真组件，含 bash-output-block 根 testid）
    const bashWrap = wrapper.find('[data-testid="turn-inline-bash"]')
    expect(bashWrap.exists()).toBe(true)
    expect(bashWrap.find('[data-testid="bash-output-block"]').exists()).toBe(true)
    expect(bashWrap.text()).toContain('npm test')
    // liveOnly notice：wrapper testid + SystemNotice 弱化行（兜底分支渲染 content 文本）
    const noticeWrap = wrapper.find('[data-testid="turn-inline-notice"]')
    expect(noticeWrap.exists()).toBe(true)
    expect(noticeWrap.text()).toContain('上下文长度接近上限')
    // 到达序忠实：bash（先到）在 notice（后到）之前（DOM 顺序）
    const bashEl = bashWrap.element as HTMLElement
    const warnEl = noticeWrap.element as HTMLElement
    expect(bashEl.compareDocumentPosition(warnEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('W4-N2: turn.notices 为空/undefined → 不渲染任何 inline notice wrapper（历史 turn 形态不变）', () => {
    const wrapper = mountTurn({ turn: makeTurn() })
    expect(wrapper.find('[data-testid="turn-inline-bash"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-inline-notice"]').exists()).toBe(false)
  })

  it('W4-N3: trigger turn 也可携带 notices（后台续跑期间跑过 `!` 命令）——起点行与 notice 共存', () => {
    const wrapper = mountTurn({
      turn: makeTriggerTurn({ notices: [bashNotice('bash-t1')] }),
      isSessionActive: true,
      isLastTurn: true,
    })
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="turn-inline-bash"]').exists()).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════
// describe 4：U6 D5 —— trigger 起点行聚合渲染（图标三态 / 计数 / 失败分句 / 点列 / 耗时）
//
// 聚合值（NotifySummary）由 core 分组层派生（message-turns R2 分支，单测在 core 侧），
// 本套只锁展示映射：数字 → 图标色 / 文案 / 点列 / meta。i18n 键值由顶部 mock 注入。
// ═════════════════════════════════════════════════════════════════
describe('U6 D5: trigger 起点行聚合渲染', () => {
  /** D5 聚合 fixture：trigger turn + 指定 NotifySummary（其余字段取 W4 基础形态） */
  function makeSummaryTurn(summary: NotifySummary | undefined): MessageTurn {
    return {
      index: 1,
      user: null,
      trigger: 'bg-notify',
      assistants: [
        { id: 'a-bg1', role: 'assistant', content: '后台任务结果已处理', status: 'complete', timestamp: NOW },
      ],
      isStreaming: false,
      hasFoldable: false,
      notifySummary: summary,
    }
  }

  /** 聚合值构造 helper：outcomes 逐点三态，count 默认 = outcomes.length */
  function summaryOf(
    outcomes: NotifySummary['outcomes'],
    over: Partial<NotifySummary> = {},
  ): NotifySummary {
    const failedCount = outcomes.filter((o) => o === 'failed').length
    const neutralCount = outcomes.filter((o) => o === 'neutral').length
    return { count: outcomes.length, failedCount, neutralCount, outcomes, ...over }
  }

  it('D5-ICON1: failedCount>0 → 图标 warn（TriangleAlert）且失败分句渲染', () => {
    const wrapper = mountTurn({ turn: makeSummaryTurn(summaryOf(['success', 'failed'], { count: 3, failedCount: 1 })), isSessionActive: true, isLastTurn: true })
    const icon = wrapper.find('[data-testid="turn-trigger-bgnotify-icon"]')
    expect(icon.classes()).toContain('text-warn')
    expect(wrapper.findComponent(TriangleAlert).exists()).toBe(true)
    const failed = wrapper.find('[data-testid="turn-trigger-bgnotify-failed"]')
    expect(failed.text()).toContain('1 失败')
  })

  it('D5-ICON2: failedCount===0 且 neutralCount>0 → 图标中性（Bell，不冒充成功）', () => {
    const wrapper = mountTurn({ turn: makeSummaryTurn(summaryOf(['success', 'neutral'], { count: 2, neutralCount: 1 })), isSessionActive: true, isLastTurn: true })
    const icon = wrapper.find('[data-testid="turn-trigger-bgnotify-icon"]')
    expect(icon.classes()).toContain('text-neutral-mid')
    expect(wrapper.findComponent(Bell).exists()).toBe(true)
    // 无失败 → 失败分句不渲染
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify-failed"]').exists()).toBe(false)
  })

  it('D5-ICON3: 全成功 → 图标 success（CheckCircle2）', () => {
    const wrapper = mountTurn({ turn: makeSummaryTurn(summaryOf(['success', 'success'])), isSessionActive: true, isLastTurn: true })
    const icon = wrapper.find('[data-testid="turn-trigger-bgnotify-icon"]')
    expect(icon.classes()).toContain('text-success')
    expect(wrapper.findComponent(CheckCircle2).exists()).toBe(true)
  })

  it('D5-COUNT: 计数段 + 状态点列三色 + 耗时 meta（「N 个后台任务完成 · M 失败 ●●● · 已继续处理 · 26m03s」）', () => {
    const wrapper = mountTurn({
      turn: makeSummaryTurn(
        summaryOf(['success', 'failed', 'neutral'], { count: 3, durationMs: 1_563_000 }),
      ),
      isSessionActive: true,
      isLastTurn: true,
    })
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify-count"]').text()).toBe('3 个后台任务完成')
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify-failed"]').text()).toBe('1 失败')
    const dots = wrapper.findAll('[data-testid="turn-trigger-bgnotify-dot"]')
    expect(dots.map((d) => d.classes().filter((c) => c.startsWith('bg-'))[0])).toEqual([
      'bg-success',
      'bg-warn',
      'bg-neutral-dim',
    ])
    const duration = wrapper.find('[data-testid="turn-trigger-bgnotify-duration"]')
    expect(duration.text()).toBe('26m03s')
    // meta 规格（D3）：mono + tabular-nums + dim 钉右
    expect(duration.classes()).toEqual(
      expect.arrayContaining(['font-mono', 'tabular-nums', 'text-neutral-dim']),
    )
    // 段间分隔点：失败分句 / 从文案 / 耗时 各一（有主文案 → 从文案带前导点）
    expect(wrapper.findAll('[data-testid="turn-trigger-bgnotify-sep"]')).toHaveLength(3)
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify-continued"]').text()).toBe('已继续处理')
  })

  it('D5-EMPTY: count===0（全解析失败/中性）→ 不渲染计数段与点列，从文案不带前导点', () => {
    const wrapper = mountTurn({
      turn: makeSummaryTurn({ count: 0, failedCount: 0, neutralCount: 2, outcomes: [] }),
      isSessionActive: true,
      isLastTurn: true,
    })
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify-dots"]').exists()).toBe(false)
    const icon = wrapper.find('[data-testid="turn-trigger-bgnotify-icon"]')
    expect(icon.classes()).toContain('text-neutral-mid') // 未判定不冒充成功
    // 无主文案 → 无前导点：行内仅图标 + 从文案，无任何分隔点
    expect(wrapper.findAll('[data-testid="turn-trigger-bgnotify-sep"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify"]').text()).toBe('已继续处理')
  })

  it('D5-DOTS: >8 条去重记录只显计数（点列不渲染）', () => {
    const outcomes: NotifySummary['outcomes'] = new Array(9).fill('success')
    const wrapper = mountTurn({ turn: makeSummaryTurn(summaryOf(outcomes)), isSessionActive: true, isLastTurn: true })
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify-dots"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify-count"]').text()).toBe('9 个后台任务完成')
  })

  it('D5-DURATION: 无含值记录不渲染耗时 meta；秒级/时级格式与设计样本一致', () => {
    const noDuration = mountTurn({ turn: makeSummaryTurn(summaryOf(['success'])), isSessionActive: true, isLastTurn: true })
    expect(noDuration.find('[data-testid="turn-trigger-bgnotify-duration"]').exists()).toBe(false)
    const seconds = mountTurn({ turn: makeSummaryTurn(summaryOf(['success'], { durationMs: 45_000 })), isSessionActive: true, isLastTurn: true })
    expect(seconds.find('[data-testid="turn-trigger-bgnotify-duration"]').text()).toBe('45s')
    const hours = mountTurn({ turn: makeSummaryTurn(summaryOf(['success'], { durationMs: 3_723_000 })), isSessionActive: true, isLastTurn: true })
    expect(hours.find('[data-testid="turn-trigger-bgnotify-duration"]').text()).toBe('1h02m03s')
  })

  it('D5-NOSUMMARY: 无 notifySummary（历史 turn / 空载体）→ 行形态回到无聚合态（只有图标 + 从文案）', () => {
    const wrapper = mountTurn({ turn: makeSummaryTurn(undefined), isSessionActive: true, isLastTurn: true })
    // 无聚合值：行仍渲染（trigger 语义），但不带任何聚合段
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify-duration"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify-icon"]').exists()).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════
// 聚合块接线：键稳定性（AX1 两方向）+ v-memo deps 完整性（S-3）
// - 方向① 段尾延长（live 段成员追加）：聚合块 DOM 节点不变（isSameNode，键 = 段 id
//   结构定位，成员追加不触键变化）；
// - 方向② 段封闭（新正文到达使 followedByText 翻转 + 新段出现）：聚合块键不变 → 同一
//   组件实例原地转摘要（旧「窗口右滑出窗」方向在窗口化退役后由段封闭承接键稳定性验证）；
// - S-3：段内非末位成员 running→error（无 endTime）→ 摘要失败标记与成员行即时更新
//   （v-memo deps 缺 counts.failedCount / 逐成员 ref 指纹时滞旧）。
// ═════════════════════════════════════════════════════════════════

/** bash 链 fixture：completed 个已完成连续 bash + 可选尾部 running bash + 可选收尾正文。
 *  trailingText=false 时段开放（无后继正文）——工作态双窗进行中的真实形态。 */
function makeBashChainTurn(opts: { completed?: number; running?: boolean; trailingText?: boolean; assistantStatus?: Message['status'] } = {}) {
  const completed = opts.completed ?? 3
  const status = opts.assistantStatus ?? 'streaming'
  const specs: BlockSpec[] = Array.from({ length: completed }, () => ({ kind: 'tool' as const, toolName: 'bash' }))
  if (opts.running) specs.push({ kind: 'tool', toolName: 'bash', status: 'running' })
  if (opts.trailingText !== false) specs.push({ kind: 'text', content: '最终回复' })
  return makeSeqTurn(specs, { assistantStatus: status })
}

describe('聚合块接线: 键稳定性两方向 + v-memo 完整性', () => {
  it('方向①（段尾延长）：live 段成员追加 → 聚合块 DOM 节点不变（isSameNode），双窗内容增长', async () => {
    // 开放段（无收尾正文）：工作态双窗进行中
    const wrapper = mountTurn({
      turn: makeBashChainTurn({ completed: 3, running: true, trailingText: false }),
      isSessionActive: true,
      isLastTurn: true,
    })
    const agg1 = wrapper.find('[data-testid="process-aggregate"]')
    expect(agg1.exists()).toBe(true)
    expect(agg1.find('[data-testid="agg-live-windows"]').exists()).toBe(true)
    const node1 = agg1.element
    // 段尾延长：b3 完成、新 running 启动（members 4→5，段首位置不变 → 段 id 不变 → key 稳定）
    await wrapper.setProps({ turn: makeBashChainTurn({ completed: 4, running: true, trailingText: false }) })
    const agg2 = wrapper.find('[data-testid="process-aggregate"]')
    expect(agg2.exists()).toBe(true)
    expect(agg2.element).toBe(node1)
    // 顶层单元数不变（成员追加不新增单元，正文 0 条）
    expect(traceTopBlocks(wrapper).length).toBe(1)
  })

  it('方向②（段封闭）：新正文到达使段转完成 → 聚合块节点不变（键段首定位），原地双窗转摘要行', async () => {
    const wrapper = mountTurn({
      turn: makeBashChainTurn({ completed: 3, running: true, trailingText: false }),
      isSessionActive: true,
      isLastTurn: true,
    })
    const agg1 = wrapper.find('[data-testid="process-aggregate"]')
    const node1 = agg1.element
    expect(agg1.find('[data-testid="agg-live-windows"]').exists()).toBe(true)
    expect(agg1.find('[data-testid="agg-summary-row"]').exists()).toBe(false)
    // 收尾正文到达：段被 text 封闭（followedByText 翻转），段首位置不变 → 键不变 → 不 remount
    await wrapper.setProps({ turn: makeBashChainTurn({ completed: 3, running: true }) })
    const agg2 = wrapper.find('[data-testid="process-aggregate"]')
    expect(agg2.element).toBe(node1)
    // 同实例原地三态翻转：双窗 → 摘要行（RL2 事件驱动）
    expect(agg2.find('[data-testid="agg-live-windows"]').exists()).toBe(false)
    expect(agg2.find('[data-testid="agg-summary-row"]').exists()).toBe(true)
  })

  it('新段出现：既有聚合块键稳定（前段节点不变），新段以新键追加单元', async () => {
    const wrapper = mountTurn({
      turn: makeSeqTurn([{ kind: 'tool', toolName: 'bash' }, { kind: 'text', content: '一段' }], { assistantStatus: 'streaming' }),
      isSessionActive: true,
      isLastTurn: true,
    })
    const first = wrapper.find('[data-testid="process-aggregate"]').element
    // 追加第二段过程块 + 收尾正文：新段 seg:<后位> 以新键出现，首段 seg:0 键不变
    await wrapper.setProps({
      turn: makeSeqTurn(
        [
          { kind: 'tool', toolName: 'bash' },
          { kind: 'text', content: '一段' },
          { kind: 'tool', toolName: 'bash' },
          { kind: 'text', content: '二段' },
        ],
        { assistantStatus: 'streaming' },
      ),
    })
    const aggs = wrapper.findAll('[data-testid="process-aggregate"]')
    expect(aggs.length).toBe(2)
    expect(aggs[0].element).toBe(first)
  })

  it('S-3 v-memo deps 完整性：段内非末位成员 running→error（无 endTime）→ 摘要失败标记与成员行即时更新', async () => {
    // 同段 3 成员 [b0(已完成), r1(running→error), r2(末位 running 保持)]；未变化成员
    // （b0/r2）跨两次 turn 复用同一对象引用（immutable 更新纪律：只替换 r1 的 ToolCall 对象）。
    const b0: ToolCall = { id: 'b0', toolName: 'bash', input: { command: 'cmd-0' }, status: 'completed', startTime: NOW, endTime: NOW + 500 }
    const r2: ToolCall = { id: 'r2', toolName: 'bash', input: { command: 'cmd-r2' }, status: 'completed', startTime: NOW + 2000, endTime: NOW + 2500 }
    // r1 无 endTime（end_not_received 形态）：running→error 前后耗时均按 0 计
    const r1Of = (status: ToolCall['status']): ToolCall => ({
      id: 'r1', toolName: 'bash', input: { command: 'cmd-r1' }, status, startTime: NOW + 1000,
    })
    const makeDoneTurn = (r1: ToolCall): MessageTurn => {
      const assistant: Message = {
        id: 'a1', role: 'assistant', content: '最终回复', status: 'complete', timestamp: NOW,
        toolCalls: [b0, r1, r2],
        contentBlocks: [
          { type: 'toolCall', refId: 'b0' },
          { type: 'toolCall', refId: 'r1' },
          { type: 'toolCall', refId: 'r2' },
          { type: 'text', refId: 'text' },
        ],
      }
      return {
        index: 1,
        user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
        assistants: [assistant],
        isStreaming: false,
        hasFoldable: true,
      }
    }
    const wrapper = mountTurn({ turn: makeDoneTurn(r1Of('completed')), isSessionActive: false })
    // 完成段默认摘要行：初始 0 失败 → 失败标记不渲染
    expect(wrapper.find('[data-testid="agg-summary-row"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agg-summary-failed"]').exists()).toBe(false)
    // 展开段让成员行进 DOM（成员行状态由逐成员 ref 指纹覆盖，失败标记由 counts.failedCount 覆盖）
    await wrapper.find('[data-testid="agg-summary-row"]').trigger('click')
    const memberRow = (i: number) => wrapper.findAll('[data-testid="agg-tool-row"]')[i]
    expect(memberRow(1)).toBeTruthy()
    expect(memberRow(1).text()).toContain('cmd-r1')
    // 非末位成员 r1 running→error（无 endTime），b0/r2 保持同引用
    await wrapper.setProps({ turn: makeDoneTurn(r1Of('error')) })
    // 摘要行失败标记出现且计数正确（键组缺 counts.failedCount 时此处滞旧）
    const chip = wrapper.find('[data-testid="agg-summary-failed"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('含 1 次失败')
    // 成员行 r1 状态翻转（键组缺逐成员 ref 指纹时此处滞旧）：失败行在场（行不消失）且失败标记渲染
    const rows = wrapper.findAll('[data-testid="agg-tool-row"]')
    expect(rows.length).toBe(3)
    expect(rows[1].find('[data-testid="agg-tool-failed"]').exists()).toBe(true)
    // 展开区未 remount（键稳定）：失败标记出现 = 同实例增量重渲染
    expect(wrapper.find('[data-testid="agg-expanded"]').exists()).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════
// describe：[actions-anchor] 操作栏插槽只挂 trace 末单元为正文的块
// （真实组件渲染——锚块断言需真实 text 分支；显隐是 CSS group-hover 行为，jsdom 不可断言，
// 本层只验挂载点存在性、唯一性与归属。锚判定 = traceUnits 末单元存在且是 text 型：
// 正文后跟了任何块（聚合块）就不得有占位行，末单元非 text 时操作栏无挂载点、不渲染）
// ═════════════════════════════════════════════════════════════════
describe('[actions-anchor] 操作栏只挂 trace 末单元为正文的块', () => {
  function mountWithRealComponents(turn: MessageTurn, opts: { isExpanded?: boolean } = {}) {
    return mount(Turn, {
      props: { turn, sessionId: SID, isLastTurn: false },
      global: {
        provide: mockChatProvide({
          isExpanded: () => opts.isExpanded ?? false,
        }),
        stubs: {
          UserBubble: true,
          TurnMeta: true,
          TurnSummary: true,
          ChangeSetCard: true,
          MarkdownRenderer: MdInlineStub,
        },
      },
    })
  }

  it('折叠态：锚块包装层挂在唯一可见的末位正文块行内', () => {
    const wrapper = mountWithRealComponents(makeTurn())
    const textBlocks = wrapper.findAll('.trace-blk--text')
    expect(textBlocks.length).toBe(1)
    const anchors = wrapper.findAll('[data-testid="turn-actions-anchor"]')
    expect(anchors.length).toBe(1)
    expect(textBlocks[0].element.contains(anchors[0].element)).toBe(true)
  })

  it('历史展开形态多 text 块：锚全 turn 唯一，挂时序最后的 text 块（D5 同形态：中间正文收敛，末位正文殿后）', () => {
    const twoTexts = makeTurn()
    twoTexts.assistants = [
      { id: 'a1', role: 'assistant', content: '第一段', status: 'complete', timestamp: NOW },
      { id: 'a2', role: 'assistant', content: '最终回复', status: 'complete', timestamp: NOW },
    ]
    const wrapper = mountWithRealComponents(twoTexts, { isExpanded: true })
    const textBlocks = wrapper.findAll('.trace-blk--text')
    // D5 折叠形态：两条历史正文收敛到末位一条（a1「第一段」不渲染）
    expect(textBlocks.length).toBe(1)
    expect(textBlocks[0].text()).toContain('最终回复')
    const anchors = wrapper.findAll('[data-testid="turn-actions-anchor"]')
    expect(anchors.length).toBe(1)
    expect(textBlocks[0].element.contains(anchors[0].element)).toBe(true)
  })

  it('正文后跟聚合块（末单元是聚合块）：无锚块，操作栏不渲染', () => {
    // 流式「正文→过程段」场景：text 之后跟了聚合块，占位行若挂在 text 下部会夹在正文与
    // 聚合块之间撑出空洞——锚判定要求末单元是 text，此处必须 0 锚
    const textThenTool = makeSeqTurn(
      [
        { kind: 'text', content: '我先查一下' },
        { kind: 'tool', toolName: 'read' },
      ],
      { assistantStatus: 'streaming' },
    )
    const wrapper = mountWithRealComponents(textThenTool)
    expect(wrapper.findAll('.trace-blk--text').length).toBe(1)
    expect(wrapper.findAll('[data-testid="turn-actions-anchor"]').length).toBe(0)
  })

  it('工作态交替回合：锚只在时序最后的正文块（其后的聚合块不携带锚）', () => {
    const mixed = makeSeqTurn(
      [
        { kind: 'text', content: '第一段' },
        { kind: 'tool', toolName: 'read' },
        { kind: 'text', content: '最终回复' },
      ],
      { assistantStatus: 'streaming' },
    )
    const wrapper = mountWithRealComponents(mixed, { isExpanded: true })
    const textBlocks = wrapper.findAll('.trace-blk--text')
    expect(textBlocks.length).toBe(2)
    const anchors = wrapper.findAll('[data-testid="turn-actions-anchor"]')
    expect(anchors.length).toBe(1)
    expect(textBlocks[0].element.contains(anchors[0].element)).toBe(false)
    expect(textBlocks[textBlocks.length - 1].element.contains(anchors[0].element)).toBe(true)
  })

  it('无 text 块（纯过程 turn）无锚块，操作栏不渲染', () => {
    const toolsOnly = makeSeqTurn([{ kind: 'tool', toolName: 'read' }], { assistantStatus: 'streaming' })
    const wrapper = mountWithRealComponents(toolsOnly, { isExpanded: true })
    expect(wrapper.findAll('[data-testid="turn-actions-anchor"]').length).toBe(0)
  })
})

// ─── 正文颜色逐消息派生（chat-flow-text-color D1）─────────────────────────────
// pi 回合 =「assistant 消息 → 工具 → assistant 消息 → …」循环，mid-turn 气泡的 status
// 要到回合级 message.complete 才收尾；streaming prop 若直接跟 status，长工具回合中已
// 写完的正文一直滞留 streaming 灰。此处断言 Turn 的派生：streaming = status streaming
// 且未 textFinalized（事实源 = core message_end 定稿重建打标：effects/finalized-rebuild
// 的 rebuildAssistantOnFinalize 在 registry message_end assistant 分支调用，textFinalized
// 在该重建内写入——C2 统一后的唯一写入点）。断言锚 = TextRow 根颜色类（正文 wrapper 直渲染）。
describe('正文颜色逐消息派生（chat-flow-text-color D1）', () => {
  function makeTextTurn(status: Message['status'], textFinalized?: boolean): MessageTurn {
    const assistant: Message = {
      id: 'a1',
      role: 'assistant',
      content: '分析正文',
      status,
      timestamp: NOW,
      ...(textFinalized !== undefined && { textFinalized }),
    }
    return {
      index: 1,
      user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
      assistants: [assistant],
      isStreaming: status === 'streaming',
      hasFoldable: false,
    }
  }
  const mountAndProbe = (turn: MessageTurn) =>
    mount(Turn, {
      props: { turn, sessionId: SID, isLastTurn: true },
      global: {
        provide: mockChatProvide({}),
        stubs: { UserBubble: true, TurnMeta: true, TurnSummary: true, ChangeSetCard: true, MarkdownRenderer: MdInlineStub },
      },
    })

  it('streaming 且未定稿 → streaming=true（写作中的灰：TextRow 根 text-neutral-mid）', () => {
    const wrapper = mountAndProbe(makeTextTurn('streaming'))
    expect(wrapper.find('[data-testid="block-text"]').classes()).toContain('text-neutral-mid')
  })

  it('streaming 但已 textFinalized → streaming=false（mid-turn 定稿翻白）', () => {
    const wrapper = mountAndProbe(makeTextTurn('streaming', true))
    expect(wrapper.find('[data-testid="block-text"]').classes()).toContain('text-neutral-fg')
  })

  it('complete 回归锚 → streaming=false', () => {
    const wrapper = mountAndProbe(makeTextTurn('complete'))
    expect(wrapper.find('[data-testid="block-text"]').classes()).toContain('text-neutral-fg')
  })
})
