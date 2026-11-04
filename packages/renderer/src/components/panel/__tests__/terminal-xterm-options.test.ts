import { describe, expect, it } from 'vitest'
import { DEFAULT_FONT_FAMILY, resolveXtermFontOptions } from '../terminal-xterm-options'

describe('resolveXtermFontOptions 终端字体栈', () => {
  it('cfg.fontFamily 非空 → 用户家族 + DEFAULT_FONT_FAMILY 完整回落栈', () => {
    const options = resolveXtermFontOptions({ fontFamily: 'Maple Mono' })
    expect(options.fontFamily).toContain('Maple Mono')
    expect(options.fontFamily).toContain('Menlo')
    expect(options.fontFamily).toBe(`Maple Mono, ${DEFAULT_FONT_FAMILY}`)
  })

  it('cfg.fontFamily 空白 → 返回 DEFAULT_FONT_FAMILY 原值', () => {
    expect(resolveXtermFontOptions({ fontFamily: '' }).fontFamily).toBe(DEFAULT_FONT_FAMILY)
    expect(resolveXtermFontOptions({ fontFamily: '   ' }).fontFamily).toBe(DEFAULT_FONT_FAMILY)
    expect(resolveXtermFontOptions(undefined).fontFamily).toBe(DEFAULT_FONT_FAMILY)
  })
})
