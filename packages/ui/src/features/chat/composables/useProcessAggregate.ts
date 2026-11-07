/**
 * useProcessAggregate —— 聚合块（过程段容器）状态与派生（chat-flow-process-aggregate U2）。
 *
 * 职责分工（设计 §5.1 U2；括注 = 承载导出）：三态本地状态与入场类动效一次性语义
 * （useProcessAggregateState——展开态组件本地 ref，D6：不落 store、不持久化，虚拟化卸载
 * 即重置回默认收起；D10/RL6 两条重放路径的压制形态见 entranceClass 注释）+ 双窗可见性
 * 纯派生（D7：窗口出现由段内已开始步骤类型决定，无独立可见性状态、无空态占位）+ 双窗
 * 跟底与聚合条自动滚动（useAggregateWindows——用户上滚停吸、回底恢复，BlockScrollBox
 * 同范式）。
 *
 * 时间机制红线（ADR-0190 / 时间平抑类逻辑红线）：三态翻转与窗口挂载全部由事件派生
 * （followedByText / turnWorking / members 增量边沿），零 timer、零延迟判定——「聚合窗立即
 * 挂载 + 300ms 上浮淡入」的「立即」= v-if 条件满足即挂载，300ms 只是 CSS 动画时长。
 *
 * 段数据契约（core process-segment.ts SSOT）：members 按 flatIndex 升序、units 是展开平铺序
 * 的唯一投影（渲染层禁止二次拼接）、counts 是三处失败计数的唯一口径——本文件只消费不重算。
 */
import { computed, nextTick, ref, watch, type Ref } from 'vue'
import type { ProcessSegment, ProcessSegmentUnit } from '@taiji/core/domain/chat'
import type { ThinkingBlock } from '@taiji/shared'

/** 距底容差（px）：与 BlockScrollBox 同值——scrollTop 取整与亚像素高度差会让「贴底」差 1px */
const BOTTOM_EPSILON = 1

/**
 * 聚合块三态状态（容器级）。
 *
 * 入参：segment = 段数据（core 切段纯函数输出）；turnWorking = 回合工作态
 * （Turn.vue isWorkingTurn 同源信号，fixture 测试经 prop 注入）。单一调用点
 * （ProcessAggregateBlock.vue）故入参类型内联不立接口，出现第 2 个真实变体
 * 再按 Rule of Three 收敛命名。
 *
 * 三态判定（core 契约「调用方合成」条款的落地）：进行中 ⇔ 回合工作态在 ∧ 段后无 text；
 * 完成态 ⇔ followedByText=true ∨ 回合工作态落下（回合落下时全部未完成段同时完成）。
 * 两者都是确定性事件信号，零时间推测。
 *
 * 入场动画一次性（D10/RL6）：entranceClass 在组件挂载时求值一次、此后恒定（非响应式），
 * CSS animation 单次播放后停在元素常态帧，类恒挂不构成重放。判据的「真实到达」信号 =
 * turnStreaming（回合级 isStreaming）：钉挂集合只含 isStreaming 回合（useStreamingPin
 * streamingTurnIdxs），流式回合不存在卸载重挂载，其内部挂载即新段真实到达；不流式的挂载
 * 均为重挂/历史，无动画类——含等待态工作回合（ask-user/compacting：sessionActive ∧
 * isLastTurn 而 isStreaming=false，不入钉挂集合）滚出视口卸载、滚回重挂的形态（D10：
 * 虚拟化卸载重挂载不得重放——该形态正是「卸载重挂载只发生在历史回合」旧前提的漏网路径）。
 * 重放路径的压制：
 * - virtua 卸载重挂载：非流式挂载判据恒 false（见上）；
 * - 键抖动重挂载：流式中重挂载时段成员已增量（members>1），无动画类；单成员起步窗口内
 *   的抖动、与流式中断复流瞬间的重挂，在该判据下与「新段起步」不可区分（无播放记录状态
 *   前提的语义边界），由键稳定性契约兜住（段 id 结构定位 + 50 次增量无重挂载用例，RL6/AX1）。
 * v-memo 失效重渲染（同实例）：类恒定 → DOM class 无变化 → animation 不重启。
 */
export function useProcessAggregateState(params: {
  segment: Ref<ProcessSegment>
  turnWorking: Ref<boolean>
  /** 回合级流式（Turn isStreaming 同源）：入场判据的「真实到达」信号，仅挂载期消费 */
  turnStreaming: Ref<boolean>
}) {
  const isLive = computed(
    () => params.turnWorking.value && !params.segment.value.followedByText,
  )
  /** 展开/收起态（D6 组件本地 ref，不落 store 不持久化；aria-expanded 同步由消费模板承担） */
  const expanded = ref(false)
  function toggleExpanded(): void {
    expanded.value = !expanded.value
  }
  const entranceClass =
    params.turnWorking.value &&
    params.turnStreaming.value &&
    !params.segment.value.followedByText &&
    params.segment.value.members.length === 1
      ? 'agg-enter'
      : ''
  return { isLive, expanded, toggleExpanded, entranceClass }
}

/**
 * 双窗运行时（AggregateLiveWindows 消费）：思考窗内容源 + 双窗跟底 + 聚合条自动滚动。
 *
 * 跟底范式（BlockScrollBox 同款）：内容增长且用户未上滚时 scrollTop=scrollHeight；
 * scroll 事件维护贴底判定，上滚停吸、回底恢复。思考窗「思考结束停住」由事实自然成立
 * （思考结束后内容不再变化，无 watcher 触发），「下一段思考开始切换内容」= 最新思考块
 * 切换即内容源切换（computed 派生，无状态）。
 */
export function useAggregateWindows(segment: Ref<ProcessSegment>) {
  /**
   * 双窗可见性纯派生（D7，唯一派生源）：思考窗 = 段内已有 thinking 成员；聚合窗 = 段内
   * 已有 tool / agentgraph 成员（「首个工具步骤开始」——agentgraph 结构上同是工具调用，
   * 独立成行但同样触发聚合窗，与 core members 契约注释同口径）。纯思考段聚合窗全程不出现。
   */
  const hasThinking = computed(() =>
    segment.value.members.some((m) => m.block.kind === 'thinking'),
  )
  const hasToolCall = computed(() =>
    segment.value.members.some((m) => m.block.kind === 'tool' || m.block.kind === 'agentgraph'),
  )

  /** 最新思考块（flatIndex 最大的 thinking 成员）：思考窗内容源，「下一段思考开始」即切换 */
  const latestThinking = computed(() => {
    let latest: (typeof segment.value.members)[number] | undefined
    for (const m of segment.value.members) {
      if (m.block.kind === 'thinking') latest = m
    }
    return latest
  })
  const thinkingContent = computed(() => {
    const fb = latestThinking.value
    return fb ? ((fb.block.ref as ThinkingBlock).content ?? '') : ''
  })
  /** 思考进行中（跟底强化 + 流式态判定）：有 start 无 end = 进行中（ThinkingRow 同判据；
   *  重载链路双时间戳缺失 → false，历史段恒静态） */
  const thinkingStreaming = computed(() => {
    const fb = latestThinking.value
    if (!fb) return false
    const th = fb.block.ref as ThinkingBlock
    return typeof th.startTime === 'number' && typeof th.endTime !== 'number'
  })

  /**
   * 聚合窗挂载动画边沿（300ms 上浮淡入的一次性载体）：false→true 边沿（首个工具步骤
   * 增量开始）才置 true 挂动画类；挂载时聚合窗条件已满足（virtua 重挂载 / 键抖动重挂载）
   * 则 watch 不触发、恒 false、无动画类——「重挂载全量渲染不带动画」不引入播放记录状态。
   */
  const aggregateWindowEntered = ref(false)
  watch(hasToolCall, (now) => {
    if (now) aggregateWindowEntered.value = true
  })

  /* ── 思考窗跟底 ── */
  const thinkViewport = ref<HTMLElement | null>(null)
  const thinkAtBottom = ref(true)
  const thinkCanScrollUp = ref(false)

  function measureThink(): void {
    const el = thinkViewport.value
    if (!el) return
    thinkAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_EPSILON
    thinkCanScrollUp.value = el.scrollTop > BOTTOM_EPSILON
  }

  /** 内容增长：未上滚时跟底到最新（happy-dom 无布局引擎时 scrollHeight/scrollTop 恒 0，写入无害） */
  function followThink(): void {
    const el = thinkViewport.value
    if (!el) return
    if (thinkAtBottom.value) el.scrollTop = el.scrollHeight
    measureThink()
  }

  /** 最新思考内容变化（含首段思考挂载）→ 下一帧跟底；用户上滚经 scroll 事件停吸 */
  watch(thinkingContent, () => {
    void nextTick(followThink)
  })
  watch(hasThinking, (now) => {
    if (now) void nextTick(followThink)
  })

  /* ── 聚合窗自动滚到最新 ── */
  const aggregateViewport = ref<HTMLElement | null>(null)
  const aggregateAtBottom = ref(true)

  function measureAggregate(): void {
    const el = aggregateViewport.value
    if (!el) return
    aggregateAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_EPSILON
  }

  function followAggregate(): void {
    const el = aggregateViewport.value
    if (!el) return
    if (aggregateAtBottom.value) el.scrollTop = el.scrollHeight
    measureAggregate()
  }

  /**
   * 聚合条条目序：units 过滤思考成员（思考在思考窗呈现），组行与独立行按真实发生顺序
   * 交替——与展开区同源 units 投影，禁止二次拼接（core units 契约条款）。
   */
  const stripUnits = computed<ProcessSegmentUnit[]>(() =>
    segment.value.units.filter(
      (u) => u.kind !== 'member' || u.block.block.kind !== 'thinking',
    ),
  )

  /** 条目步数（组按成员数计）：聚合条内容量变化信号，驱动自动滚到最新（含首个条目挂载） */
  const stripStepCount = computed(() =>
    stripUnits.value.reduce((n, u) => n + (u.kind === 'group' ? u.group.members.length : 1), 0),
  )
  watch(stripStepCount, () => {
    void nextTick(followAggregate)
  })
  watch(hasToolCall, (now) => {
    if (now) void nextTick(followAggregate)
  })

  return {
    hasThinking,
    hasToolCall,
    thinkingContent,
    thinkingStreaming,
    aggregateWindowEntered,
    thinkViewport,
    thinkAtBottom,
    thinkCanScrollUp,
    onThinkScroll: measureThink,
    aggregateViewport,
    onAggregateScroll: measureAggregate,
    stripUnits,
  }
}
