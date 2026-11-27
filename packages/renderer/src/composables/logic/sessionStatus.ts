
/**
 * 会话状态图标 + 派生逻辑 re-export（R2 logic 层）。
 *
 * SessionItem（sidebar）、PanelHeader 共用同一 9 态 → 图标/颜色/动画映射，
 * 收敛到此避免多处复制粘贴漂移。语义色取自 design-tokens（CSS 变量），不硬编码十六进制色。
 *
 * deriveStatus（D6 → 方案 C 优化版 9 态）已迁 @taiji/core/domain/chat/derive-status.ts
 * （renderer-model M3，纯函数归 core 域）：本文件 re-export 转发，消费方 import 路径零改动。
 * DOT_CLASS / STATUS_ICON 等视觉映射（CSS 类属展示层）仍留 renderer（M3 §3.3.4）。
 */
import type { DerivedStatus } from '@taiji/core'
import type { SessionStatus } from '@taiji/shared'

export type { DerivedStatus }

/**
 * deriveStatus 纯函数（re-export 自 core，M3 搬迁）。
 * 签名与迁移前一致：
 * (sessionId, chat, isActive, isCompacting=false, hasBackgroundWork=false, metaStatus?, hasFormOverlayPending=false)
 */
export { deriveStatus } from '@taiji/core'

/**
 * 进程级 SessionStatus → 展示态 DerivedStatus（色语言 SSOT）。
 *
 * agent 派发的子会话通常未 hydrate，`deriveStatus` 对 status='active' 无消息会兜底 `done`
 * （见 core derive-status 的 terminalStatusWithoutMessages），无法表达运行中；托盘/侧栏
 * 需要展示态时以进程级真值为准，经此单一映射取 DOT_CLASS 色。
 *
 * active→streaming(accent) · error→error(danger) · stopped/dead→stopped(dim) ·
 * idle/done→done(绿)。
 */
export const DISPLAY_STATUS: Record<SessionStatus, DerivedStatus> = {
  active: 'streaming',
  idle: 'done',
  done: 'done',
  error: 'error',
  stopped: 'stopped',
  dead: 'stopped',
}

/**
 * 判据：session 是否「运行已完成」= 映射到绿点（done）态。
 *
 * 「绿点 = 运行已完成」的口径与侧栏/托盘的状态点色语言一致：DISPLAY_STATUS 映射到
 * `'done'` 的进程级 status（idle / done）即绿点，其余（active / error / stopped / dead）
 * 都算未完成。侧栏子会话徽标取 `!isSessionCompleted(status)` 汇总「未完成数」，故 error /
 * stopped / dead 子会话也会计入（判据是「非绿点」，不是「运行中」）。
 */
export function isSessionCompleted(status: SessionStatus): boolean {
  return DISPLAY_STATUS[status] === 'done'
}

/**
 * 判据：session 是否「生成中/在途」（session-archive D13 归档门 renderer 拦截层）。
 *
 * 六瞬态（derive-status 派生优先级段）：streaming（流式）/ pending（已提交待确认）/
 * compacting（上下文压缩中）/ waiting（工具执行/审批等待）/ retrying（自动重试中）/
 * working（后台 subagent/workflow 在途）——任一在途即归档钮禁用（生成中归档会丢
 * 尾部未落盘 entry 或泄漏在途后台任务；runtime session.archive 首门
 * archive_generating 兜底 RPC 直发路径）。done/stopped/error 三终态不在集合。
 */
const GENERATING_STATUSES: ReadonlySet<DerivedStatus> = new Set([
  'streaming', 'pending', 'compacting', 'waiting', 'retrying', 'working',
])

export function isSessionGenerating(status: DerivedStatus): boolean {
  return GENERATING_STATUSES.has(status)
}

/**
 * 状态点语义类：背景色（9 态）。
 * 活跃态在组件层改用语义图标 + 动画，圆点仅作为静态 fallback 等处的点状指示。
 */
export const DOT_CLASS: Record<DerivedStatus, string> = {
  streaming: 'bg-accent',
  pending: 'bg-accent',
  compacting: 'bg-accent',
  working: 'bg-accent',
  waiting: 'bg-warn',
  retrying: 'bg-warn',
  done: 'bg-success',
  stopped: 'bg-neutral-dim opacity-50',
  error: 'bg-danger',
}

/**
 * 状态 → 语义图标配置（方案 C 优化版 v3 + working）。
 * icon: lucide 图标名（与 @lucide/vue 导出同名）。
 * color: Tailwind 语义色类（text-*）。
 * animation: 动画类（'' 表示静态）。
 *
 * [perf:animation] working / compacting 两态改静态（2026-11 实测：打包版 workflow/subagent
 * 后台跑期间风扇狂转，GPU helper 54-60% + renderer 85%；dev 受控消融把 animate-spin 全停后
 * 掉到 1/6，单个 14px spinner 即 9.3%/4.2%）。这两态持续 = 整个后台任务生命周期（分钟-小时），
 * 且落到 lucide <svg> 根（Chromium 不合成 SVG transform，style.css 的 will-change 空转），
 * 是「一直有动画在跑」布尔事实的第一个来源。语义识别由静态字形 + accent 色承担。
 * streaming 保留旋转：真实流式是秒-分钟且用户预期在转。
 */
export const STATUS_ICON: Record<
  DerivedStatus,
  { icon: string; color: string; animation: string }
> = {
  streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' },
  // [perf:animation] steps(4) 量化：pulse-strong 动 opacity + transform:scale，挂在
  // <ArrowUpCircle> SVG 根（不可合成）；steps 把逐帧重建降到 4 段（实测 60fps→steps(8)
  // 掉 2/3，此处取更粗的 4 段）。pending = 上行未确认，秒级但可累积。
  pending: { icon: 'ArrowUpCircle', color: 'text-accent', animation: 'animate-pulse-strong-quantized' },
  // [perf:animation] compacting 亦为常驻态（threshold/overflow 自动压缩可持续分钟级），
  // 同 working 处理：静态 Hourglass 保留「压缩中」语义，不转。
  compacting: { icon: 'Hourglass', color: 'text-accent', animation: '' },
  // [perf:animation] working = 后台 subagent/workflow 运行中，持续整个任务生命周期（
  // 分钟-小时）。原 animate-spin 挂在 <RefreshCw> SVG 根，每帧主线程重绘 13px 矢量。
  // 改静态 Loader2（齿轮字形本身即「加载中」，与 streaming 的 RefreshCw / compacting 的
  // Hourglass 三态字形互异——静态化后状态可区分性靠字形而非动效承担），色仍 accent 表「活跃」。
  working: { icon: 'Loader2', color: 'text-accent', animation: '' },
  waiting: { icon: 'Wrench', color: 'text-warn', animation: '' },
  // [perf:animation] 同 pending：SVG 目标 + 量化 steps(4)。
  retrying: { icon: 'Zap', color: 'text-warn', animation: 'animate-pulse-strong-quantized' },
  done: { icon: 'Check', color: 'text-accent', animation: '' },
  stopped: { icon: 'Ban', color: 'text-neutral-mid', animation: '' },
  error: { icon: 'AlertCircle', color: 'text-danger', animation: '' },
}

/**
 * 取状态点 class（组件 dotClass computed 的纯函数等价物）。
 * 组件可直接 DOT_CLASS[status] 或经此 helper，二者等价；提供 helper 便于未来加 guard / fallback。
 */
export function statusDotClass(status: DerivedStatus): string {
  return DOT_CLASS[status]
}

// [HISTORICAL] 原 SPINNER_STATUSES / shouldShowSpinner / SPINNER_TEXT_CLASS / isSpinnerStatus /
// spinnerTextClass 兼容族已删（2026-11 动画降级分支审查 data-governance S8）：全仓零消费方，
// 且其 SPINNER_STATUSES 仍含 'working' 与 STATUS_ICON.working.animation='' 对同一问题
// （working 是否旋转）给出相反答案——「是否旋转」的派生只在 STATUS_ICON 一处。
