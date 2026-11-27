/**
 * installHiddenAnimationPause 单测（boot/hidden-animation-pause）。
 *
 * 覆盖点：挂载即同步一次（可见 + 聚焦 → 无 .app-hidden）、visibilitychange 翻转
 * <html> 类、[perf:animation] window blur / focus 事件同样驱动暂停（失焦但窗口可见 =
 * 暂停；重新聚焦 = 恢复）、blur→hidden→visible 组合不误恢复（document.hidden 与
 * !hasFocus() 取并集）、style.css 的暂停规则与类名契约（.app-hidden 选择器存在 +
 * 同时覆盖 backdrop-filter——防改名/删规则后 JS 与 CSS 脱钩）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/boot/hidden-animation-pause.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installHiddenAnimationPause } from '@/boot/hidden-animation-pause'

/** happy-dom 的 visibilityState 可写（defineProperty 覆盖只读 getter）。 */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** happy-dom 的 document.hasFocus 可写（模拟窗口失焦/聚焦，仍可见）。 */
function setFocus(focused: boolean): void {
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused })
}

describe('installHiddenAnimationPause', () => {
  let cleanupFns: Array<() => void> = []

  beforeEach(() => {
    document.documentElement.classList.remove('app-hidden')
    // 记录原值以便恢复（happy-dom document 单例跨用例共享）
    const hiddenDesc = Object.getOwnPropertyDescriptor(document, 'hidden')
    const focusDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hasFocus')
      ?? Object.getOwnPropertyDescriptor(document, 'hasFocus')
    setFocus(true)
    cleanupFns.push(() => {
      if (hiddenDesc) Object.defineProperty(document, 'hidden', hiddenDesc)
      if (focusDesc) Object.defineProperty(document, 'hasFocus', focusDesc)
      document.documentElement.classList.remove('app-hidden')
    })
  })

  afterEach(() => {
    cleanupFns.forEach((fn) => fn())
    cleanupFns = []
  })

  it('挂载即按当前可见态同步（可见 → 无 .app-hidden）', () => {
    setHidden(false)
    installHiddenAnimationPause()
    expect(document.documentElement.classList.contains('app-hidden')).toBe(false)
  })

  it('挂载即按当前隐藏态同步（隐藏 → 挂 .app-hidden）', () => {
    setHidden(true)
    installHiddenAnimationPause()
    expect(document.documentElement.classList.contains('app-hidden')).toBe(true)
  })

  it('visibilitychange 翻转：<html> 类跟随 hidden 挂/摘（幂等重挂不重复注册）', () => {
    setHidden(false)
    installHiddenAnimationPause()
    installHiddenAnimationPause() // 幂等：重复安装不应造成类状态错乱
    setHidden(true)
    expect(document.documentElement.classList.contains('app-hidden')).toBe(true)
    setHidden(false)
    expect(document.documentElement.classList.contains('app-hidden')).toBe(false)
  })

  // [perf:animation] 2026-11 增补：失焦但窗口可见时也必须暂停
  // （原实现只认 document.hidden，切到别的 app 后动画照跑满帧——实测风扇照转）
  it('window blur → 暂停（即使 document.hidden === false）', () => {
    setHidden(false)
    installHiddenAnimationPause()
    setFocus(false)
    window.dispatchEvent(new Event('blur'))
    expect(document.documentElement.classList.contains('app-hidden')).toBe(true)
  })

  it('window focus → 恢复（可见前提）', () => {
    setHidden(false)
    setFocus(true)
    installHiddenAnimationPause()
    setFocus(false)
    window.dispatchEvent(new Event('blur'))
    expect(document.documentElement.classList.contains('app-hidden')).toBe(true)

    setFocus(true)
    window.dispatchEvent(new Event('focus'))
    expect(document.documentElement.classList.contains('app-hidden')).toBe(false)
  })

  it('blur → hidden → visible 后不误恢复（hidden 与 hasFocus 取并集）', () => {
    setHidden(false)
    setFocus(true)
    installHiddenAnimationPause()

    setFocus(false)
    window.dispatchEvent(new Event('blur'))
    expect(document.documentElement.classList.contains('app-hidden')).toBe(true)

    setHidden(true)
    expect(document.documentElement.classList.contains('app-hidden')).toBe(true)

    // 回 visible 但仍未聚焦 → 保持暂停（不因 visibilitychange 单独恢复）
    setHidden(false)
    expect(document.documentElement.classList.contains('app-hidden')).toBe(true)

    // 重新聚焦才恢复
    setFocus(true)
    window.dispatchEvent(new Event('focus'))
    expect(document.documentElement.classList.contains('app-hidden')).toBe(false)
  })

  it('style.css 的 .app-hidden 规则契约存在（暂停动画 + 关 backdrop-filter，防 JS/CSS 脱钩）', () => {
    const css = readFileSync(join(__dirname, '../../style.css'), 'utf-8')
    expect(css).toContain('.app-hidden')
    expect(css).toContain('animation-play-state: paused')
    expect(css).toContain('backdrop-filter: none')
  })
})
