/**
 * useSessionSwitchVeil —— session 切换「幕布过渡」的共享状态机（模块级单例）。
 *
 * 职责（单一变化原因「切换过渡呈现」）：sidebar 点击 session 后、切换 promise settle 前，
 * 由消费方（SessionSwitchVeil.vue 幕布层 / PanelContainer header 乐观标题）读取本状态渲染
 * 过渡呈现。只管状态与显隐分档，不管切换编排——编排（driver 循环 / 失败 toast）在
 * useSidebarSessionActions.onSelectSession。
 *
 * 为什么模块级：useSidebar 非单例（每次调用新建实例，use-session.ts:225-227 注释），
 * 而幕布消费方横跨 sidebar（发起方）与 PanelContainer（呈现方），状态必须单实例共享——
 * 挂 composable 实例会分裂。
 *
 * 三态机（phase）：
 * - idle    无切换进行
 * - pending 切换进行中但未满 REVEAL_DELAY_MS——不出任何幕布 DOM（快切零闪烁，
 *           同 useLoadMoreHistory slowLine 的 150ms 防闪烁模式；真实热切常 <300ms，
 *           即出即隐的幕布是纯噪声）
 * - visible 幕布可见（压暗 + blur + chip + 顶部细进度线）；Transition 淡入由组件层承担，
 *           release 即回 idle、幕布经 leave 过渡揭走
 *
 * 等待中改投（用户幕布未揭时点另一个 session）：retarget 只换 targetId/targetLabel——
 * phase 不动（已 visible 的 chip 文案响应式换目标，不闪不跳）；编排层据此决定接续目标。
 */
import { reactive, readonly } from 'vue'

/**
 * 幕布显形延迟：切换启动后满该时长仍未 settle 才出幕布。取值对齐
 * useLoadMoreHistory.SLOW_LINE_DELAY_MS（150ms，spec chat/history-load-and-run-grouping §2.2
 * 同款防闪烁判据）。
 */
export const SESSION_SWITCH_VEIL_DELAY_MS = 150

export type SessionSwitchVeilPhase = 'idle' | 'pending' | 'visible'

interface SessionSwitchVeilState {  // oe-exempt:20261109:framework:内部 reactive 状态的形状描述（非 ports 契约），单实现即终态
  /**
   * 三态机唯一状态词表：非 idle 即「切换进行中」（编排 driver 的单飞判定同源——
   * switchWithVeil 与 driver 循环以 phase !== 'idle' 判定，不另持布尔防双写分叉）。
   */
  phase: SessionSwitchVeilPhase
  /** 本次过渡的目标 session（等待中改投即更新；idle 时为 null） */
  targetId: string | null
  /** 目标展示名（chip / header 乐观标题共用；rename 后的短窗过时不追） */
  targetLabel: string
}

// @data-owner #96 —— 会话切换幕布过渡态（data-source-registry #96）：本模块即权威源，
// 唯一写入口 = 下方 begin/retarget/release 三函数。
const state = reactive<SessionSwitchVeilState>({
  phase: 'idle',
  targetId: null,
  targetLabel: '',
})

/** 消费方只读投影（同一单例的 readonly 代理；写只经 begin/retarget/release 三入口，TS 层即拦直写） */
const readonlyState = readonly(state)

let revealTimer: ReturnType<typeof setTimeout> | null = null

function clearRevealTimer(): void {
  if (revealTimer !== null) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
}

/** 幕布状态（只读消费：SessionSwitchVeil.vue / PanelContainer / 编排判定读点） */
export function useSessionSwitchVeilState(): Readonly<SessionSwitchVeilState> {
  return readonlyState
}

/** 发起一次切换过渡：记录目标并进入 pending；满延迟未 settle 升 visible。 */
export function beginSessionSwitch(id: string, label: string): void {
  clearRevealTimer()
  state.targetId = id
  state.targetLabel = label
  state.phase = 'pending'
  revealTimer = setTimeout(() => {
    // 改投不影响本判定：切换仍在继续（目标已换），幕布按新目标呈现
    if (state.phase === 'pending') state.phase = 'visible'
  }, SESSION_SWITCH_VEIL_DELAY_MS)
}

/** 等待中改投：只换目标与文案，phase 与计时不动（不闪不跳）。 */
export function retargetSessionSwitch(id: string, label: string): void {
  state.targetId = id
  state.targetLabel = label
}

/** 切换 settle（成功或终败）后收场：幕布经组件层 leave 过渡揭走，状态回 idle。 */
export function releaseSessionSwitch(): void {
  clearRevealTimer()
  state.phase = 'idle'
  state.targetId = null
  state.targetLabel = ''
}
