/**
 * xterm 渲染选项解析（TerminalView 用，自组件 script setup 提取以收敛行数）。
 *
 * 配置未加载 / 字段为空时逐项回落默认值——「用户没配字体」与「配了空串」都走默认，
 * 不把空串当有效字体族传给 xterm（空 fontFamily 会让 canvas 回退浏览器默认非等宽字体）。
 */

/**
 * 终端默认等宽栈（独立常量，刻意不与 style.css 强行统一——同一串 mmmmmmmmmm @100px
 * 实测本栈与 style.css 构建期栈均为 602.05px，均命中 Menlo；改默认栈会改变既有终端渲染，
 * font-system D7）。用户字体非空时仍把本栈拼在后面，因为 xterm canvas 不吃 CSS 回落链。
 */
export const DEFAULT_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace'
export const DEFAULT_FONT_SIZE = 13
export const DEFAULT_SCROLLBACK = 5000

/** settings store terminalConfig 的结构性子集（禁 any；只取本模块消费的四个字段）。 */
export interface TerminalFontConfigSource {
  fontFamily?: string
  fontSize?: number
  scrollback?: number
  cursorStyle?: 'bar' | 'block' | 'underline'
}

/** 从 settings store 的 terminalConfig 解析 xterm 渲染选项；config 未加载时用默认值。 */
export function resolveXtermFontOptions(cfg: TerminalFontConfigSource | undefined): {
  fontFamily: string
  fontSize: number
  scrollback: number
  cursorStyle: 'bar' | 'block' | 'underline'
} {
  return {
    fontFamily: cfg?.fontFamily?.trim()
      ? `${cfg.fontFamily.trim()}, ${DEFAULT_FONT_FAMILY}`
      : DEFAULT_FONT_FAMILY,
    fontSize: cfg?.fontSize ?? DEFAULT_FONT_SIZE,
    scrollback: cfg?.scrollback ?? DEFAULT_SCROLLBACK,
    cursorStyle: cfg?.cursorStyle ?? 'bar',
  }
}
