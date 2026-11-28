/**
 * 窗口后台化 / 失焦动画暂停（2026-11 性能优化）。
 *
 * 背景：window-factory 设 backgroundThrottling:false（[HISTORICAL] W16 UC-2 裁决，
 * 保住 setTimeout 基础设施不被 chromium 拉到 ~1s——用户发消息后切窗口是核心场景）。
 * 代价是后台窗口的 CSS 无限动画（旋转 loader / 扫光 / 呼吸弧）照跑满帧，GPU 合成空转
 * ——用户切走窗口后风扇照转。rAF 本身会被 chromium 对隐藏窗口降频，但纯 CSS 动画
 * 在 backgroundThrottling:false 下不降。
 *
 * 机制：给 <html> 挂/摘 .app-hidden，style.css 全局规则暂停全部动画
 * （animation-play-state: paused）并临时关掉 backdrop-filter。恢复时原地续播（动画计时
 * 冻结在暂停帧，无跳变）。
 *
 * [perf:animation] 暂停判据 = 单一布尔 document.hidden ∨ !document.hasFocus()（2026-11 增补）：
 * 原实现只监听 visibilitychange + document.hidden，**窗口失焦但仍可见时**（切到别的 app、
 * 副屏前台、被系统弹窗遮挡）动画照跑——代码级确证且实测与「风扇照转」一致。现补 window
 * blur / focus 两个事件，仍走同一 sync()，与 document.hidden 取并集：
 * blur 后若窗口再被隐藏（visibilitychange 到 hidden）仍是暂停态，回 visible 时 hasFocus
 * 仍为 false 也继续暂停——不会出现「blur 后被 visible 事件误恢复」。
 *
 * 事件驱动、零定时器（ADR-0190：禁止时间推测类判死/等待）：只在 visibilitychange /
 * blur / focus 发生的那一刻重算一次，不做轮询。
 * 启动期安全：install 时同步算一次；Electron 主窗口创建后即聚焦（dev 下真实启动实测
 * hasFocus()=true），若某次在窗口还没聚焦前安装则下一次 focus 事件即恢复，不会永久卡在
 * 暂停态（无计时依赖）。
 *
 * 安全性：全仓无 animationend/animationcancel 宿主监听（2026-11 核实，grep 零命中；
 * mobile-renderer 测试里的 dispatch 是测试自造事件，非运行时监听），暂停不影响任何
 * 计时语义；transition 不受影响。
 *
 * 安装幂等（2026-11 分支审查 arch-boundary S1）：与同目录 resize-observer-probe 同款
 * `installed` 早返——HMR / 测试重复调用不再重复注册 listener；uninstall 仅供测试清场
 * （生产入口 main.ts 单点安装、页面生命周期内常驻）。
 */
let installed = false

/** 仅供测试清场：摘除三个监听并清 installed，使下个用例从干净态安装。 */
export function uninstallHiddenAnimationPause(): void {
  if (!installed) return
  document.removeEventListener('visibilitychange', sync)
  window.removeEventListener('blur', sync)
  window.removeEventListener('focus', sync)
  installed = false
}

const shouldPause = (): boolean => document.hidden || !document.hasFocus()
const sync = (): void => {
  document.documentElement.classList.toggle('app-hidden', shouldPause())
}

export function installHiddenAnimationPause(): void {
  if (installed) return
  installed = true
  document.addEventListener('visibilitychange', sync)
  window.addEventListener('blur', sync)
  window.addEventListener('focus', sync)
  sync()
}
