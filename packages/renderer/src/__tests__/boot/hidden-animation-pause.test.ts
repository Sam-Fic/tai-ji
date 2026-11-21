/**
 * installHiddenAnimationPause 单测（boot/hidden-animation-pause）。
 *
 * 覆盖点：挂载即同步一次（hidden=false → 无 .app-hidden）、visibilitychange 翻转
 * <html> 类（documentElement.classList.toggle 语义：hidden → 挂 / visible → 摘）、
 * style.css 的暂停规则与类名契约（.app-hidden 选择器存在——防改名漂移后 JS 与 CSS 脱钩）。
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

describe('installHiddenAnimationPause', () => {
  let cleanupFns: Array<() => void> = []

  beforeEach(() => {
    document.documentElement.classList.remove('app-hidden')
    // 记录原值以便恢复（happy-dom document 单例跨用例共享）
    const desc = Object.getOwnPropertyDescriptor(document, 'hidden')
    cleanupFns.push(() => {
      if (desc) Object.defineProperty(document, 'hidden', desc)
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

  it('style.css 的 .app-hidden 暂停规则与类名契约存在（防 JS/CSS 改名漂移）', () => {
    const css = readFileSync(join(__dirname, '../../style.css'), 'utf-8')
    expect(css).toContain('.app-hidden')
    expect(css).toContain('animation-play-state: paused')
  })
})
