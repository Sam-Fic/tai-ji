/**
 * useProcessAggregate —— 过程卡（两段正文之间的过程段容器）状态与派生（chat-flow-v2）。
 *
 * 职责分工（括注 = 承载导出）：
 * - 展开态与入场动效一次性语义（useProcessAggregateState——展开态是组件本地 ref，D6：不落 store、
 *   不持久化，虚拟化卸载即重置回默认；D10/RL6 两条重放路径的压制形态见 entranceClass 注释）；
 * - 窗口滚动运行时（useTapeScroll——进行中贴底跟随、上滚停吸、卡头右侧滚动提示、两侧渐隐）。
 *
 * 时间机制红线（ADR-0190 / 时间平抑类逻辑红线）：展开态翻转、窗口贴底与提示更新全部由事件派生
 * （followedByText / turnWorking / 成员增量 / 内容尺寸变化 / 滚动事件），零 timer、零延迟判定。
 *
 * 段数据契约（core process-segment.ts SSOT）：members 按 flatIndex 升序、units 是窗口行序
 * 的唯一投影（渲染层禁止二次拼接）、counts 是失败计数的唯一口径——本文件只消费不重算。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProcessSegment } from '@taiji/core/domain/chat'
import type { ThinkingBlock } from '@taiji/shared'

/** 滚动位置容差（px）：scrollTop 取整与亚像素高度差会让「到达」差 1px */
const SCROLL_EPSILON = 1

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
    for (const row of Array.from(el.querySelectorAll('[data-testid^="agg-row-"]'))) {
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
