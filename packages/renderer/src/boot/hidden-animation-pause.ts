/**
 * 窗口后台化动画暂停（2026-11 性能优化）。
 *
 * 背景：window-factory 设 backgroundThrottling:false（[HISTORICAL] W16 UC-2 裁决，
 * 保住 setTimeout 基础设施不被 chromium 拉到 ~1s——用户发消息后切窗口是核心场景）。
 * 代价是后台窗口的 CSS 无限动画（旋转 loader / 扫光 / 呼吸弧）照跑满帧，GPU 合成空转
 * ——用户切走窗口后风扇照转。rAF 本身会被 chromium 对隐藏窗口降频，但纯 CSS 动画
 * 在 backgroundThrottling:false 下不降。
 *
 * 机制：visibilitychange（含 macOS occlusion 归并）时给 <html> 挂/摘 .app-hidden，
 * style.css 全局规则暂停全部动画（animation-play-state: paused）。恢复可见时原地
 * 续播（动画计时冻结在暂停帧，无跳变）。
 *
 * 安全性：全仓无 animationend/animationcancel 监听（2026-11 核实，grep 零命中），
 * 暂停不影响任何计时语义；transition 不受影响。
 */
export function installHiddenAnimationPause(): void {
  const sync = () => {
    document.documentElement.classList.toggle('app-hidden', document.hidden)
  }
  document.addEventListener('visibilitychange', sync)
  sync()
}
