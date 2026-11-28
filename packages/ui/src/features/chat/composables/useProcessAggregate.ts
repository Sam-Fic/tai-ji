/**
 * useProcessAggregate —— 过程卡（两段正文之间的过程段容器）状态与派生（chat-flow-v2）。
 *
 * 职责分工（括注 = 承载导出）：
 * - 展开态与入场动效一次性语义（useProcessAggregateState——展开态是组件本地 ref，D6：不落 store、
 *   不持久化，虚拟化卸载即重置回默认；D10/RL6 两条重放路径的压制形态见 entranceClass 注释）；
 * - 窗口滚动运行时（useTapeScroll——进行中贴底跟随、上滚停吸、卡头右侧滚动提示、两侧渐隐）；
 * - 卡头活动 chip（useTapeActivity——「此刻在做什么 + 已持续多久」，段进行中才有）。
 *
 * 时间机制红线（ADR-0190 / 时间平抑类逻辑红线）：展开态翻转、窗口贴底与提示更新全部由事件派生
 * （followedByText / turnWorking / 成员增量 / 内容尺寸变化 / 滚动事件），零 timer、零延迟判定。
 *
 * 段数据契约（core process-segment.ts SSOT）：members 按 flatIndex 升序、units 是窗口行序
 * 的唯一投影（渲染层禁止二次拼接）、counts 是失败计数的唯一口径——本文件只消费不重算。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RunningIconKind } from '../block-icon'
import { RUN_GROUP_TOOLS, type ProcessSegment, type RunGroupBase } from '@taiji/core/domain/chat'
import type { ThinkingBlock, ToolCall } from '@taiji/shared'
import { formatDurationHms } from '../format-utils'

/**
 * 过程卡窗口行锚点属性（生产契约）：行 div 与 useTapeScroll.measure() 行计数之间的双端约定——
 * AggregateExpandedBody 行元素按本常量发射该 data 属性，measure() 按本常量派生选择器数视口外行。
 * data-testid（agg-row-N）保留测试钩子单一职责，不参与生产行为。
 */
export const AGG_ROW_ANCHOR = 'data-agg-row'
/** 行锚点选择器：由常量派生（属性名调整时查询端同步生效） */
const AGG_ROW_SELECTOR = `[${AGG_ROW_ANCHOR}]`

/** 滚动位置容差（px）：scrollTop 取整与亚像素高度差会让「到达」差 1px */
const SCROLL_EPSILON = 1
/** 活动计时的刷新间隔 */
const ACTIVITY_TICK_MS = 1000
/** 活动类型 → 卡头类型词的 i18n 键 */
const RUN_GROUP_LABEL_KEY: Record<RunGroupBase, string> = {
  explore: 'panel.message.runGroupExplore',
  edit: 'panel.message.runGroupEdit',
  exec: 'panel.message.runGroupExec',
}
/** 工具类型 → 执行中的图标种类（类型词旁的进行中信号） */
const RUN_GROUP_RUNNING_ICON: Record<RunGroupBase, RunningIconKind> = {
  explore: 'tool-read',
  edit: 'tool-edit',
  exec: 'tool-bash',
}

/** toolName → 工具类型（RUN_GROUP_TOOLS 类型表反查，与 core 分组同一判定源）；表外工具为 null */
function runBaseOf(toolName: string): RunGroupBase | null {
  for (const base of Object.keys(RUN_GROUP_TOOLS) as RunGroupBase[]) {
    if (RUN_GROUP_TOOLS[base].includes(toolName)) return base
  }
  return null
}

/**
 * 思考块流式中谓词（chat 域唯一实现点）：有 start 无 end = 流式中。
 * 双时间戳缺失（持久化重载链路 thinking part 无时间戳数据源）→ false，历史块恒静态。
 */
export function isThinkingStreaming(block: Pick<ThinkingBlock, 'startTime' | 'endTime'>): boolean {
  return typeof block.startTime === 'number' && typeof block.endTime !== 'number'
}

/**
 * 过程卡展开态（容器级）。
 *
 * 入参：segment = 段数据（core 切段纯函数输出）；turnWorking = 回合工作态（Turn.vue isWorkingTurn
 * 同源信号，fixture 测试经 prop 注入）。
 *
 * 三态判定（core 契约「调用方合成」条款的落地）：进行中 ⇔ 回合工作态在 ∧ 段后无 text；
 * 完成态 ⇔ followedByText=true ∨ 回合工作态落下。两者都是确定性事件信号，零时间推测。
 *
 * 入场动画一次性（D10/RL6）：entranceClass 在组件挂载时求值一次、此后恒定（非响应式），
 * CSS animation 单次播放后停在元素常态帧。判据的「真实到达」信号 = turnStreaming（回合级
 * isStreaming）：流式回合不存在卸载重挂载，其内部挂载即新段真实到达；不流式的挂载均为
 * 重挂/历史，无动画类。v-memo 失效重渲染（同实例）：类恒定 → DOM class 无变化 → animation 不重启。
 */
export function useProcessAggregateState(params: {
  segment: Ref<ProcessSegment>
  turnWorking: Ref<boolean>
  /** 回合级流式（Turn isStreaming 同源）：入场判据的「真实到达」信号，仅挂载期消费 */
  turnStreaming: Ref<boolean>
}) {
  const isLive = computed(() => params.turnWorking.value && !params.segment.value.followedByText)
  /** 展开/收起态（D6 组件本地 ref，不落 store 不持久化）。
   *  进行中的段默认展开成 12 行窗口（用户裁决：进行中要看得到过程）；用户手动收起/展开过
   *  之后不再随段状态自动翻转（落成时自动收成一行，手动开着的保持）。 */
  const userToggled = ref(false)
  const expanded = ref(params.turnWorking.value && !params.segment.value.followedByText)
  function toggleExpanded(): void {
    userToggled.value = true
    expanded.value = !expanded.value
  }
  watch(isLive, (live) => {
    if (!live && !userToggled.value) expanded.value = false
  })
  const entranceClass =
    params.turnWorking.value &&
    params.turnStreaming.value &&
    !params.segment.value.followedByText &&
    params.segment.value.members.length === 1
      ? 'agg-enter'
      : ''
  return { isLive, expanded, toggleExpanded, entranceClass }
}

/** 程序滚动（贴底或点提示）的行程：从 from 走到 to；行程内到达的 scroll 事件是它的回声 */
interface ScrollTrip {
  from: number
  to: number
}

/**
 * scroll 事件的归属：'echo' = 程序滚动的回声（位置仍在行程区间内），'user' = 用户滚动
 * （越过了行程区间，或当时没有程序滚动）。
 *
 * 区分两者是跟随开关正确性的前提：程序贴底触发的 scroll 事件不代表用户意图，据此改跟随会把
 * 贴底判成「用户上滚」；平滑滚动中途的事件同理。
 */
export function scrollOrigin(top: number, trip: ScrollTrip | null): 'echo' | 'user' {
  if (!trip) return 'user'
  const low = Math.min(trip.from, trip.to) - SCROLL_EPSILON
  const high = Math.max(trip.from, trip.to) + SCROLL_EPSILON
  return top >= low && top <= high ? 'echo' : 'user'
}

/**
 * 过程卡窗口滚动运行时（AggregateTape 消费）。
 *
 * 贴底跟随：进行中，窗口内容每有变化就滚到底，最新一行始终可见。
 * 跟随开关（follow）只有用户的滚动意图能改变——上滚即停吸，滚到底或点「回到最新」恢复。
 * 窗口挂载首帧与内容变化期间，窗口会被量成「未贴底」（流式中的行高度处在过渡态）；
 * 这些测量不改变跟随，否则卡头会留下不该有的「回到最新」，新行也不再跟随。
 *
 * 提示文案按「进行中 / 落成后」两态裁定：
 *   进行中：停吸中 → 回到最新；跟随中且上面有行 → 更早 N 条；否则无提示。
 *   落成后：下面有行 → 下面还有 N 条；滚到底 → 回到开头；否则无提示。
 * 两侧渐隐：上沿/下沿有内容被裁时各 16px。
 */
export function useTapeScroll(params: {
  /** 窗口滚动容器（null = 收起态，不测量） */
  window: Ref<HTMLElement | null>
  /** 段数据（成员增量 = 内容增长信号之一） */
  segment: Ref<ProcessSegment>
  /** 段进行中（容器 isLive 透传） */
  live: Ref<boolean>
}) {
  const { t } = useI18n()
  const hint = ref('')
  const hintAct = ref<'up' | 'down'>('up')
  /** 窗口上沿 / 下沿是否有内容被裁在外面（驱动两侧的渐隐） */
  const overTop = ref(false)
  const overBottom = ref(false)
  /** 进行中的贴底跟随开关：只有用户的滚动意图能改变它 */
  const follow = ref(true)
  /** 未走完的程序滚动行程；为空表示当前没有程序滚动在途 */
  let trip: ScrollTrip | null = null
  let resizeObserver: ResizeObserver | null = null

  function measure(): void {
    const el = params.window.value
    if (!el || !el.clientHeight) return
    const top = el.scrollTop
    overTop.value = top > SCROLL_EPSILON
    overBottom.value = el.scrollHeight - el.clientHeight - top > SCROLL_EPSILON
    // 整条在视口外的行数：按行元素与窗口视口的矩形比对
    const view = el.getBoundingClientRect()
    let above = 0
    let below = 0
    for (const row of Array.from(el.querySelectorAll(AGG_ROW_SELECTOR))) {
      const r = row.getBoundingClientRect()
      if (r.height <= 0) continue
      if (r.bottom <= view.top + SCROLL_EPSILON) above += 1
      else if (r.top >= view.bottom - SCROLL_EPSILON) below += 1
    }
    let text = ''
    let act: 'up' | 'down' = 'up'
    if (params.live.value) {
      if (!follow.value) {
        text = t('panel.message.scrollToBottom')
        act = 'down'
      } else if (above > 0) {
        text = t('panel.message.procTapeEarlier', { count: above })
        act = 'up'
      }
    } else if (below > 0) {
      text = t('panel.message.procTapeBelow', { count: below })
      act = 'down'
    } else if (overTop.value) {
      text = t('panel.message.procTapeToTop')
      act = 'up'
    }
    hint.value = text
    hintAct.value = act
  }

  /** 滚到底并记下行程：随后的 scroll 事件是这次贴底的回声 */
  function stickToBottom(): void {
    const el = params.window.value
    if (!el) return
    const from = el.scrollTop
    el.scrollTop = el.scrollHeight
    const to = el.scrollTop
    trip = Math.abs(to - from) <= SCROLL_EPSILON ? null : { from, to }
    // 贴底后立即重算提示：scrollTop 未变化时不触发 scroll 事件，提示会停在旧值
    measure()
  }

  function onScroll(): void {
    const el = params.window.value
    if (!el) return
    const top = el.scrollTop
    if (scrollOrigin(top, trip) === 'echo') {
      // 回声：到达目的地后这次程序滚动就算走完
      if (Math.abs(top - (trip as ScrollTrip).to) <= SCROLL_EPSILON) trip = null
    } else {
      trip = null
      if (params.live.value) follow.value = el.scrollHeight - el.clientHeight - top <= SCROLL_EPSILON
    }
    measure()
  }

  /** 滚动停止（含被中断的平滑滚动）：在途的程序滚动作废 */
  function onScrollEnd(): void {
    trip = null
  }

  /** 滚轮手势先于 scroll 事件到达：手势发生即接管（作废在途的程序滚动），上滚同步停吸 */
  function onWheel(e: WheelEvent): void {
    trip = null
    if (e.deltaY < 0 && params.live.value) follow.value = false
  }

  function onHint(): void {
    const el = params.window.value
    if (!el) return
    const down = hintAct.value === 'down'
    if (down) follow.value = true
    else if (params.live.value) follow.value = false
    trip = { from: el.scrollTop, to: down ? el.scrollHeight - el.clientHeight : 0 }
    el.scrollTo({ top: down ? el.scrollHeight : 0, behavior: 'smooth' })
  }

  /**
   * 窗口挂载 / 卸载时接入：挂载后观察内容尺寸——行数变化之外的增高（流式中的行、展开的全文区）
   * 也要重新贴底并更新提示；卸载即停止观察。
   */
  function attach(el: HTMLElement | null): void {
    resizeObserver?.disconnect()
    resizeObserver = null
    if (!el) return
    const content = el.firstElementChild
    if (content && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (params.live.value && follow.value) stickToBottom()
        else measure()
      })
      resizeObserver.observe(content)
    }
    void nextTick(() => {
      if (params.live.value && follow.value) stickToBottom()
      else measure()
    })
  }
  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
  })

  /* 内容增长（成员增量）：进行中且跟随时贴底；落成后打开窗口时停在用户该看的位置（从第一条起）。
     与尺寸观察互补：没有 ResizeObserver 的环境（测试 DOM）靠这条信号。 */
  watch(
    () => params.segment.value.members.length,
    () => {
      if (params.live.value && follow.value) void nextTick(stickToBottom)
    },
  )

  return { hint, overTop, overBottom, onScroll, onScrollEnd, onWheel, onHint, attach }
}

/** 卡头活动 chip 的数据：此刻在做什么、从什么时候开始 */
type TapeActivity = {
  /** 类型词（已求值） */
  label: string
  /** 进行中图标种类（RunningBlockIcon 的 kind） */
  icon: RunningIconKind
  /** 该活动开始的时间戳；缺省 = 没有可用的时间戳，不显示计时 */
  since?: number
  /** 当前活动是流式中的思考时：该块的 id（点 chip 可点开它的全文） */
  thinkingId?: string
}

/**
 * 卡头活动 chip（AggregateTape 消费）：进行中在卡头右侧常驻「此刻在做什么 + 已持续多久」。
 *
 * 取段内最后一个成员判定：
 *   流式中的思考 → 思考（可点开）；执行中的工具 → 该类工具的类型词（类型表外工具显示工具名）；
 *   最后一个成员已结束而回合仍在进行 → 思考中（等模型响应），自该成员结束算起。
 * 段不在进行中 → 没有 chip。
 *
 * 计时是卡内唯一的实时计时（行内只有已结束步骤的历史耗时）。每秒刷新一次、只更新 chip 文本；
 * 页面不可见时停表、恢复可见立即补算（轮头耗时同款范式）；卸载即清理。
 */
export function useTapeActivity(params: {
  /** 段数据 */
  segment: Ref<ProcessSegment>
  /** 段进行中 */
  live: Ref<boolean>
}) {
  const { t } = useI18n()
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null

  /** 页面是否不可见（浏览器可见性接口，与会话的 hidden 状态无关；收在一处便于同名登记） */
  function pageHidden(): boolean {
    return document.hidden
  }

  /** 计时器只在「有活动且带起始时间、页面可见」时运行 */
  function syncTimer(needed: boolean): void {
    if (needed && !pageHidden()) {
      if (timer === null) timer = setInterval(() => (now.value = Date.now()), ACTIVITY_TICK_MS)
    } else if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function onVisibilityChange(): void {
    if (!pageHidden()) now.value = Date.now()
    syncTimer(params.live.value && activity.value?.since !== undefined)
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  onBeforeUnmount(() => {
    syncTimer(false)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  function waiting(since: number | undefined): TapeActivity {
    return { label: t('panel.message.procChipThinking'), icon: 'thinking', since }
  }

  const activity = computed<TapeActivity | null>(() => {
    if (!params.live.value) return null
    const members = params.segment.value.members
    const last = members[members.length - 1]
    if (!last) return null
    if (last.block.kind === 'thinking') {
      const thinking = last.block.ref as ThinkingBlock
      if (isThinkingStreaming(thinking)) {
        return { label: t('panel.message.thinkingBlock'), icon: 'thinking', since: thinking.startTime, thinkingId: thinking.id }
      }
      return waiting(thinking.endTime)
    }
    const tool = last.block.ref as ToolCall
    if (tool.status === 'running') {
      const base = runBaseOf(tool.toolName)
      const icon: RunningIconKind = base ? RUN_GROUP_RUNNING_ICON[base] : 'tool-other'
      return { label: base ? t(RUN_GROUP_LABEL_KEY[base]) : tool.toolName, icon, since: tool.startTime }
    }
    return waiting(tool.endTime)
  })

  /* 活动或其起始时间变化：立即对表并按需启停计时器（新活动从 0 秒起算，不沿用上一次的对表时刻） */
  watch(
    () => [params.live.value, activity.value?.since] as const,
    ([live, since]) => {
      now.value = Date.now()
      syncTimer(live && since !== undefined)
    },
    { immediate: true },
  )

  /** 已持续时长的文本（整秒；没有起始时间时不显示） */
  const elapsedText = computed(() => {
    const since = activity.value?.since
    if (since === undefined) return ''
    return formatDurationHms(Math.max(0, now.value - since))
  })

  return { activity, elapsedText }
}
