/**
 * applySystemToDom —— 把 SystemSettings 的外观偏好写入 DOM 槽位（data-* 属性）。
 *
 * 从 renderer stores/settings.ts 的 applySystemToDom 提取为 ui 包纯函数（W3 · TC2/IF2）。
 * core 零 DOM 铁律要求此逻辑下沉 ui（非 core），W4 壳侧 watch store.system.theme 调用本函数
 * + 挂/卸 matchMedia listener（theme=system 时 OS 深浅色实时切换）。
 *
 * 槽位（与 style.css 的 [data-theme] / [data-theme-preset] / [data-font-size] 规则对齐）：
 * - theme → <html data-theme>（:root 暗默认 / [data-theme=light] 亮色槽位）
 *   theme='system' 时按 prefers-color-scheme 解析为 light/dark（避免 CSS 再叠一层 media query，统一走 data-theme 单一通道）
 * - themePreset → <html data-theme-preset>（[data-theme-preset] 规则覆盖 --accent；空串与 :root 默认一致）
 * - fontSize → <html data-font-size>（[data-font-size] 规则调整基础字号，D17）
 * - fontScales → <html data-fs-sidebar/chat/drawer>（[data-fs-*] 规则映射 --font-scale-<region>，
 *   区域根节点 [data-fs-scope] 槽位重声明 --text-* 链实现分区缩放；chat scope 的语义挂点
 *   = MessageStream 根 + btw composer 带，drawer 内嵌对话流随之跟 chat 档）
 * - fonts.ui / fonts.mono → <html> 内联 CSS 自定义属性槽位 --font-ui / --font-mono-ui
 *   （font-system D8）；**绝不写终值变量** --font-sans / --font-mono
 * - locale → 经 deps.setLocale 注入（ui 不持有 i18n 全局实例，W4 壳传入真实 setLocale）
 *
 * SSR 检查：typeof document === 'undefined' 时早返（不抛错），保证同构安全。
 */
import type { SystemSettings } from '@taiji/core'
import { DEFAULT_FONT_SCALES } from '@taiji/core'

export interface ApplySystemToDomDeps {
  /** i18n 实例的 locale 切换函数（W4 壳注入）。缺省不切换 locale。 */
  setLocale?: (locale: string) => void
}

/**
 * 解析 theme='system' 为具体 light/dark。
 * 抽出便于单测：不依赖 DOM 时可直接断言映射逻辑。
 */
export function resolveTheme(theme: SystemSettings['theme']): 'light' | 'dark' {
  if (theme !== 'system') return theme
  // matchMedia 可能在老环境/SSR 缺失，兜底暗色（与应用暗默认一致）
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * 把家族名安全嵌入单引号 CSS 字符串。
 *
 * 未转义的 ' " \ 与换行都会让字符串 token 非法（bad-string）→ 整条槽位声明无效 →
 * var(--slot, 构建期栈) 取缺省参数回落，选中字体静默不生效。含引号的合法文件名
 * （it's a font.ttf）经导入链直通此处——上游 suggestFontFamily / confirmImport 均只
 * trim 不处理引号，且 FontFace 注册名保持原文，故必须在写入点转义（不能剥离）：
 * 剥离后槽位名与注册名不一致，字体同样匹配不上。
 *
 * 转义按 CSS 字符串规则（CSS Syntax L3 §3.3）：
 * - `\` → `\\`（最先处理，防后续转义的 `\` 被二次转义）；
 * - `'` / `"` → `\'` / `\"`（非 hex 转义形式，后随字符不被吞并）；
 * - 换行（含 CRLF，算一个换行）→ `\A `（hex escape + 空格终结符，防吞并后续
 *   十六进制字符；裸换行在 CSS 字符串中直接判 bad-string）。
 */
function escapeCssString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/['"]/g, '\\$&')
    .replace(/\r\n?|\n/g, '\\A ')
}

/**
 * 字体槽位写入/清除（font-system D8）。
 *
 * 三条硬约束：
 * 1. 值必须带引号（家族名可含空格，如 `Maple Mono`），且特殊字符经 escapeCssString
 *    转义（含引号/反斜杠的家族名不转义 = 声明非法，静默回落）；
 * 2. 清除走 `removeProperty`——`setProperty(name, '')` 留下的是「已声明但值为空 token 流」，
 *    会让 `var(--slot, 构建期栈)` 的缺省参数失效（默认态即击穿全站字体栈，实测）。
 *    removeProperty 回到「未声明」，回落链才生效。
 */
function applyFontSlot(
  style: CSSStyleDeclaration,
  property: '--font-ui' | '--font-mono-ui',
  family: string | undefined,
): void {
  const value = typeof family === 'string' ? family.trim() : ''
  if (value) {
    style.setProperty(property, `'${escapeCssString(value)}'`)
  } else {
    style.removeProperty(property)
  }
}

/**
 * 把 SystemSettings 外观偏好同步到 DOM。纯副作用，无返回值。
 */
export function applySystemToDom(
  s: SystemSettings,
  deps?: ApplySystemToDomDeps,
): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement

  root.setAttribute('data-theme', resolveTheme(s.theme))

  // themePreset：缺省空串（与 DEFAULT_SYSTEM 一致，保证老数据无 themePreset 时回落默认主题）。
  root.setAttribute('data-theme-preset', s.themePreset ?? '')

  // fontSize：缺省 medium（D17，与 DEFAULT_SYSTEM 一致）。
  root.dataset.fontSize = s.fontSize ?? 'medium'

  // fontScales：分区字号档位，逐区域回落 DEFAULT_FONT_SCALES（sidebar/drawer=medium、
  // chat=small；SSOT 在 core，getSystem 浅合并可能产生部分缺省对象，不可假设区域 key 完整）。
  // 档位→倍率映射在 renderer style.css [data-fs-*] 规则。
  root.dataset.fsSidebar = s.fontScales?.sidebar ?? DEFAULT_FONT_SCALES.sidebar
  root.dataset.fsChat = s.fontScales?.chat ?? DEFAULT_FONT_SCALES.chat
  root.dataset.fsDrawer = s.fontScales?.drawer ?? DEFAULT_FONT_SCALES.drawer

  if (s.locale && deps?.setLocale) {
    deps.setLocale(s.locale)
  }

  // 字体槽位（font-system D8）：只写槽位，绝不写终值 --font-sans / --font-mono——
  // 写终值会以内联样式击穿样式表里的回落链声明。
  applyFontSlot(root.style, '--font-ui', s.fonts?.ui)
  applyFontSlot(root.style, '--font-mono-ui', s.fonts?.mono)
}
