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

  it('家族名含双引号 → 按字符串转义包裹，防 font-family 声明被破坏静默回落', () => {
    const options = resolveXtermFontOptions({ fontFamily: 'My "Font" Pro' })
    expect(options.fontFamily).toBe(`"My \\"Font\\" Pro", ${DEFAULT_FONT_FAMILY}`)
  })

  it('家族名含反斜杠 → 转义包裹', () => {
    const options = resolveXtermFontOptions({ fontFamily: 'Foo\\Bar' })
    expect(options.fontFamily).toBe(`"Foo\\\\Bar", ${DEFAULT_FONT_FAMILY}`)
  })

  it('家族名不含引号/反斜杠 → 保持裸拼形态不变', () => {
    expect(resolveXtermFontOptions({ fontFamily: 'Maple Mono' }).fontFamily).toBe(
      `Maple Mono, ${DEFAULT_FONT_FAMILY}`,
    )
  })
})
