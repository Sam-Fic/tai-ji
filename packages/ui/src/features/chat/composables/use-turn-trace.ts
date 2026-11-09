/**
 * useTurnTrace —— Turn 的 trace 区渲染单元派生（聚合块形态，chat-flow-process-aggregate U3）。
 *
 * 职责（turn 内一维块序列 → trace 区「正文块 + 聚合块」两型单元列表，core 纯函数在本
 * composable 内接线，渲染层零解析 AX7）：
 * - flatBlocks：拍平（flattenTurnBlocks，跨 assistant 连续 flatIndex）。
 * - segments：切段（splitProcessSegments，core 单点算好段边界 / 组分组 / 计数口径）。
 * - traceUnits：三态矩阵汇合的单元列表（工作态全显 / 非工作折叠仅末位正文 / 非工作展开
 *   全显，见 traceUnits 注释）。
 *   旧四层折叠编排（窗口切片 / 并入计数摘要行 / run 组 / 接管态 takeover）的 UI 消费路径
 *   随聚合块形态退役（D1/D9）；core 既有三符号语义不动，其去留按死代码纪律单独处置。
 * - isActionsAnchor / unitKey / unitMemoDeps / textUnitProps：单层 v-for 的锚单元判定、
 *   两型键（正文 flatIndex / 聚合段 id，键空间不相交）、v-memo deps 二型、TextRow props
 *   收敛（v-memo 与 v-for 同元素挂载，正文/聚合两分支收敛在同一 wrapper 内）。
 *
 * showTrace 已退役（trace 容器恒渲染）；非工作 turn 的折叠/展开两形态经 turnExpanded 入参
 * 区分（chat-turn-fold-redesign：折叠 = 仅末位正文，展开 = 全部正文 + 全部聚合块摘要行），
 * isExpanded 的 store 侧消费（TurnMeta chevron / TurnRail 指示）不经本 composable。
 */
import { computed } from 'vue'
import { flattenTurnBlocks, splitProcessSegments } from '@taiji/core/domain/chat'
import type { FlatBlock, MessageTurn, ProcessSegment } from '@taiji/core/domain/chat'
import type { Message, ToolCall } from '@taiji/shared'

/** TextRow props（正文单元直渲染；定义随单元派生逻辑内聚于本文件）。 */
export interface TextUnitProps {
  content: string
  /** streaming 态（所属 assistant 文本仍在写）：驱动正文颜色（chat-flow-text-color D1
   *  逐消息派生，事实源 = core message_end 写入的 textFinalized）。 */
  streaming: boolean
  /** 正文入场动效判据（chat-flow-process-aggregate D10 一次性语义）=「真实到达」信号：
   *  回合流式 ∧ 文本未定稿。TextRow setup 期捕获一次、此后不随 prop 变化——钉挂集合只含
   *  isStreaming 回合（useStreamingPin），流式回合不卸载、挂载即首次插入；等待态工作回合
   *  （ask-user/compacting，不流式不入集合）滚出视口卸载、滚回重挂时判据已翻 false，
   *  不重放。判据在本处单点求值（Turn 侧持回合级 streaming 信号），挂点形态见 TextRow
   *  entrance prop 注释。 */
  entrance: boolean
  /** 所属 assistant 消息终态（error 追加形态判定） */
  status?: Message['status']
  error?: string
  messageTimestamp?: number
}

/** trace 区渲染单元（两型）：正文块（TextRow 直渲染）与聚合块（ProcessAggregateBlock）。 */
export type TraceUnit =
  | { kind: 'text'; block: FlatBlock }
  | { kind: 'aggregate'; segment: ProcessSegment }

/**
 * 拍平块序列 + 段列表 → 单元列表（正文与聚合块按真实发生顺序交错）。
 *
 * 走查单 pass：text 块直接成正文单元；过程块遇到「段首成员」时 emit 其所属段（段成员
 * 连续、段首即入列位置，后续成员跳过）。folded=true 时只产末位正文单元（用户裁决
 * chat-turn-fold-redesign：折叠态只展示最后一段 text，中间正文与聚合块全部不渲染——
 * 聚合块的 push 与展开态共用同一行，折叠态以 !folded 门控跳过，不无条件删）。
 */
function buildTraceUnits(blocks: FlatBlock[], segs: ProcessSegment[], folded: boolean): TraceUnit[] {
  const segmentHead = new Map<number, ProcessSegment>()
  for (const seg of segs) segmentHead.set(seg.members[0].flatIndex, seg)
  const units: TraceUnit[] = []
  let lastText: FlatBlock | undefined
  for (const fb of blocks) {
    if (fb.block.kind === 'text') {
      // 正文原生展示（D2）：展开态每条正文都直接渲染；折叠态收敛到末位一条、循环后殿后
      if (!folded) units.push({ kind: 'text', block: fb })
      lastText = fb
      continue
    }
    const seg = segmentHead.get(fb.flatIndex)
    if (seg && !folded) units.push({ kind: 'aggregate', segment: seg })
  }
  if (folded && lastText) units.push({ kind: 'text', block: lastText })
  return units
}

/**
 * trace 区渲染单元派生。
 *
 * @param turn 当前 MessageTurn getter（props.turn；computed 内经 getter 读，保持响应式追踪）
 * @param isWorkingTurn 工作 turn 判定 getter（Turn.vue isWorkingTurn：sessionActive ∧
 *   (isLastTurn ∨ turn.isStreaming)，[chat-flow-consistency D2] 放宽后双工作态并存）
 * @param turnStreaming 回合级流式 getter（Turn.vue isStreaming）：正文入场判据的「真实到达」
 *   信号（钉挂集合只含 isStreaming 回合，流式回合不卸载、挂载即首插；不流式挂载 = 重挂/
 *   历史，无入场——D10 一次性语义，见 TextUnitProps.entrance 注释）
 * @param turnExpanded 回合展开态 getter（deps.isExpanded(turnStableId(turn))，store 派生）：
 *   仅作用于非工作态折叠/展开切换，工作态不受其影响
 */
export function useTurnTrace(
  turn: () => MessageTurn,
  isWorkingTurn: () => boolean,
  turnStreaming: () => boolean,
  turnExpanded: () => boolean,
) {
  /**
   * trace 拍平 + 切段（chat-flow-process-aggregate U1 契约）。
   * - flatBlocks：turn 内所有 assistant 块按真实时序拍平为一维（跨 assistant 连续 flatIndex）。
   * - segments：按 text 边界切段（core splitProcessSegments 单点；段 id 结构定位 seg:<段首
   *   flatIndex>，流式生长稳定——AX1）。切段每次增量重建段对象，v-memo 键禁止用段对象引用
   *   （SI4 约束），必须用段 id + 段内可变信号。
   */
  const flatBlocks = computed<FlatBlock[]>(() => flattenTurnBlocks(turn().assistants))
  const segments = computed<ProcessSegment[]>(() => splitProcessSegments(flatBlocks.value))

  /**
   * trace 区单元列表（三态矩阵，chat-turn-fold-redesign §1）：
   * - 工作态（isWorkingTurn）：全部正文 + 全部聚合块（聚合块三态由组件按 turnWorking +
   *   followedByText 自判——段后无 text 的开放段双窗进行中，已封闭段摘要行），不受折叠开关影响。
   * - 非工作态折叠（默认，!isWorkingTurn ∧ !turnExpanded）：仅末位一条正文；中间全部正文
   *   与全部聚合块不渲染（用户裁决「折叠只展示最后一段 text」）；纯工具无正文 turn 的
   *   trace 区为空。
   * - 非工作态展开（!isWorkingTurn ∧ turnExpanded）：全部正文 + 全部聚合块摘要行 + 末位
   *   正文（真实时序交错）；聚合块内部平铺由组件本地展开态控制（D6 不落 store）。
   */
  const traceUnits = computed<TraceUnit[]>(() => {
    const folded = !isWorkingTurn() && !turnExpanded()
    return buildTraceUnits(flatBlocks.value, segments.value, folded)
  })

  /**
   * [actions-anchor] hover actions 锚单元 = trace 末单元且是 text 型：正文后面跟了任何块
   * （聚合块）就不得有占位行（流式「正文→聚合块」场景占位行夹在正文与聚合块之间会把块间距
   * 撑出空洞，2026-10-17 用户裁决）。操作栏（TurnSummary）经 #turn-actions 插槽只挂在该正文
   * 单元上：悬停区收窄到 text 块本身，悬浮位随块定位。turn 以聚合块结尾（无末尾正文）或无
   * text 块时操作栏无挂载点、不渲染——复制/fork/handoff 服务于正文回复，无正文可悬停属预期
   * 形态。折叠态唯一单元是末位正文 → 锚恒在；展开态按真实时序交错，以聚合块结尾时无锚
   * （与工作态同构，不改锚判定——见 chat-turn-fold-redesign §3.1）。
   */
  const actionsAnchorFlatIndex = computed<number | null>(() => {
    const units = traceUnits.value
    const last = units.length > 0 ? units[units.length - 1] : undefined
    if (!last || last.kind !== 'text') return null
    return last.block.flatIndex
  })

  /** 锚单元判定（模板插槽 v-if 与 v-memo deps 共用单点）；聚合单元永不命中。 */
  function isActionsAnchor(unit: TraceUnit): boolean {
    return unit.kind === 'text' && unit.block.flatIndex === actionsAnchorFlatIndex.value
  }

  /**
   * 渲染单元 key：正文单元 = flatIndex（数字）；聚合单元 = 段 id（`seg:<n>` 字符串）。
   * 非数字前缀使两型键空间不相交（ProcessSegment.id 契约条款），同层 v-for 键不撞。
   * 段 id 结构定位（派生源只有段首位置）：流式成员追加 / 新段出现都不改变既有段 id——
   * 键抖 = remount = 组件本地展开态丢 + 滚动锚点跳（AX1 / 旧 PR-6 同因）。
   */
  function unitKey(unit: TraceUnit): string | number {
    return unit.kind === 'aggregate' ? unit.segment.id : unit.block.flatIndex
  }

  /**
   * v-memo deps（按单元类型二选一，见模板注释）。
   * 聚合单元键 = [members.length, 逐成员 block.ref（map 展开）, counts 三类步数 / 思考数 /
   * 总耗时 / 失败数, followedByText, turnWorking]：段内成员 ref 即「身份+内容」（D-1 不可变
   * 替换语义，引用同 ⇒ 内容同；成员中途改状态是常态，逐成员展开入键即全段内容指纹，不假设
   * 「只有末成员会变」——0c81f904c 教训）；length 覆盖成员增减；counts 各字段覆盖摘要行 /
   * 聚合条 / 组头的计数显示（ProcessSegmentCounts 契约：三处计数唯一口径，字段值是原始类型，
   * 逐项入键——段对象与 counts 对象每次切段都重建，引用入键 memo 永远失效）；followedByText
   * 覆盖段完成翻转（双窗 → 摘要行的三态切换）；turnWorking 覆盖回合落成瞬间全部开放段同时
   * 转摘要的渲染批次（RL2 边沿）。组级信号（durationMs / failedCount / hasRunning）由成员
   * ref 指纹覆盖（派生自成员，成员不变即不变）；units 平铺序由 members 覆盖（同源派生）。
   * 正文单元键 = [块 ref, assistant 状态, assistant error, timestamp, textFinalized, 锚标记]：
   * text 的 ref 是 normalizeContent 字符串（按值比较），error/timestamp/textFinalized 来自
   * assistantById 查表（streaming 灰 → 定稿翻白 / error 追加行的驱动源）；锚标记覆盖操作栏
   * 插槽挂载点切换——流式追加使锚在正文块间移动时旧块摘插槽、新块挂插槽，漏了它被缓存的
   * vnode 不重渲染。刻意不含 TextRow 本地状态（无）与聚合块本地展开 ref（组件实例经 :key
   * 保活，v-memo 不 gate 子组件内部更新）。sessionId 不入键：跨 session 时 renderKey 不同
   * → Turn 实例整体重建，不存在同实例跨 session 复用。deps 在父组件渲染作用域求值
   * （assistantById 为 computed，此处取 .value）。
   */
  function unitMemoDeps(unit: TraceUnit): unknown[] {
    if (unit.kind === 'aggregate') {
      const seg = unit.segment
      return [
        seg.members.length,
        ...seg.members.map((m) => m.block.ref),
        seg.counts.categoryCounts.explore,
        seg.counts.categoryCounts.edit,
        seg.counts.categoryCounts.exec,
        seg.counts.thinkingCount,
        seg.counts.totalDurationMs,
        seg.counts.failedCount,
        seg.followedByText,
        isWorkingTurn(),
      ]
    }
    const assistant = assistantById.value.get(unit.block.assistantId)
    return [
      unit.block.block.ref,
      unit.block.assistantStatus,
      assistant?.error,
      assistant?.timestamp,
      assistant?.textFinalized,
      isActionsAnchor(unit),
    ]
  }

  /**
   * TextRow props（正文单元直渲染）：从 FlatBlock 解出 content + 所属 assistant 的
   * streaming/error/timestamp。streaming 按「该消息文本是否仍在写」逐消息派生，不直接跟
   * assistantStatus——pi 回合 =「assistant 消息 → 工具 → assistant 消息 → …」循环，mid-turn
   * 气泡的 status 要到回合级 message.complete 才收尾，直接跟 status 会让长工具回合中已写完
   * 的正文一直处于 streaming 灰（chat-flow-text-color D1，事实源 = core message_end 写入的
   * textFinalized 确定性事件边沿）。
   * entrance = 回合流式 ∧ 文本未定稿（D10 入场一次性判据的「真实到达」信号，TextRow setup
   * 期捕获一次；判据细节见 TextUnitProps.entrance 注释）。
   */
  function textUnitProps(block: FlatBlock): TextUnitProps {
    const assistant = assistantById.value.get(block.assistantId)
    const textLive = block.assistantStatus === 'streaming' && !assistant?.textFinalized
    return {
      content: block.block.ref as string,
      streaming: textLive,
      entrance: turnStreaming() && !assistant?.textFinalized,
      status: block.assistantStatus,
      error: assistant?.error,
      messageTimestamp: assistant?.timestamp,
    }
  }

  /** assistantId → Message 映射（取 error/timestamp/textFinalized 透传给 TextRow）。 */
  const assistantById = computed(() => {
    const m = new Map<string, Message>()
    for (const a of turn().assistants) m.set(a.id, a)
    return m
  })

  /**
   * streaming-tail 光标显隐的末单元判定：isStreaming && 末单元不是「进行中的工具活动」。
   * 末单元是聚合块时看段内末成员——kind 为 tool/agentgraph 且 ref.status === 'running' →
   * 隐藏（聚合窗自带进行中信号，避免光标与聚合条流光并存）；其余（含末单元是正文 / 无单元
   * 的防御性兜底 ES1）→ 显示。
   */
  function lastUnitIsRunningTool(): boolean {
    const units = traceUnits.value
    const last = units.length > 0 ? units[units.length - 1] : undefined
    if (!last || last.kind !== 'aggregate') return false
    const members = last.segment.members
    const lastMember = members.length > 0 ? members[members.length - 1] : undefined
    if (!lastMember) return false
    if (lastMember.block.kind === 'tool' || lastMember.block.kind === 'agentgraph') {
      return (lastMember.block.ref as ToolCall).status === 'running'
    }
    return false
  }

  return {
    traceUnits,
    isActionsAnchor,
    unitKey,
    unitMemoDeps,
    textUnitProps,
    lastUnitIsRunningTool,
  }
}
