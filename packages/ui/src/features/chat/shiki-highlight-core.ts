/**
 * shiki 高亮配置单源（批3 B-worker：fence 闭合高亮移出主线程）。
 *
 * 本模块是 shiki 装配的**唯一事实源**：主线程降级路径（markdown.ts 的 getHighlighter /
 * highlightShikiSync）与 Web Worker（shiki-highlight-worker.ts）import 同一导出——
 * 两侧同配置 + 同高亮函数 ⟹ 产物逐字节一致（worker 路径与降级路径无视觉漂移）。
 * 无 DOM 依赖（shiki core + JS 正则引擎 + 静态 grammar/theme，见
 * docs/tp-fact-check-batch3.md F3 探针：Node 无 document/window 实跑成功）。
 *
 * 从 markdown.ts 原样抽出（2026-09 fine-grained 改造 + MF-1-27 扁平三色档的历史
 * 注释随迁）：不走 shiki full bundle（死语言 chunk），core + 显式 import；
 * **必须 JS 正则引擎，禁回落 Oniguruma WASM**——index.html CSP 是 script-src 'self'，
 * WebAssembly.instantiate 会被拦（CompileError）→ 全部 markdown 渲染静默降级纯文本
 * （2026-08-21 v0.9.3 起线上事故）。防护：.githooks/check_csp_compatibility.py 源码级
 * 拦 WebAssembly 用法；产物级扫描见 scripts/postbuild-validate.sh。
 */
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { HighlighterCore, ThemeRegistration } from 'shiki/core'
// fine-grained 静态 grammar import（release 附件体积优化批三 §3.2.1）：解析依赖扁平
// node_modules（node-linker=hoisted，ADR-0032）。禁止 import bash.mjs / shell.mjs——
// 它们只是 shellscript 的别名 re-export；bash/shell 由 shellscript grammar 自带
// aliases=["bash","sh","shell","zsh"] 自动注册（getLoadedLanguages 天然含 alias 键）。
// vue 单模块默认导出内嵌全部派生 grammar，跨语言嵌入由 13 语言全注册满足。
import typescript from '@shikijs/langs/typescript'
import javascript from '@shikijs/langs/javascript'
import vue from '@shikijs/langs/vue'
import json from '@shikijs/langs/json'
import shellscript from '@shikijs/langs/shellscript'
import markdown from '@shikijs/langs/markdown'
import css from '@shikijs/langs/css'
import html from '@shikijs/langs/html'
import yaml from '@shikijs/langs/yaml'
import python from '@shikijs/langs/python'
import go from '@shikijs/langs/go'
import rust from '@shikijs/langs/rust'
import minDark from '@shikijs/themes/min-dark'
import minLight from '@shikijs/themes/min-light'

/**
 * 代码块高亮覆盖的语言清单（按 wave review 要点：ts/vue/json/bash/md + 常见派生）。
 * fine-grained 后不再作为 createHighlighter 入参（grammar 改静态 import，见
 * createShikiHighlighter），语义 = 高亮覆盖范围 SSOT：highlightWithHighlighter 的
 * fallback 判定走 getLoadedLanguages()（其返回值天然含 bash/shell 等 alias 键——
 * shellscript grammar aliases 自动注册），本清单导出供单测驱动「13 语言逐个高亮」
 * 断言，防清单与注册清单漂移。
 */
export const SHIKI_LANGS = ['typescript', 'javascript', 'vue', 'json', 'bash', 'shell', 'markdown', 'css', 'html', 'yaml', 'python', 'go', 'rust']

/**
 * 双主题：min-dark / min-light（透明底，v6 代码块底色走 token 体系）。
 * [HISTORICAL] 曾用 dark-plus/light-plus（VSCode 级高亮但底色硬编码 #1e1e1e/#fff，
 * 不随 6 套太极主题 token 变化：暖墨面板嵌冷灰块、皓/青墨米白面板嵌纯白块）。
 * min 系列背景透明（--shiki-dark-bg/--shiki-light-bg 为透明），代码块容器底色由
 * MarkdownRenderer/CodeBlock 的 var(--bg-input) 提供——跟随全部主题/preset。
 * 语法 token 色：内置 min 系彩色档已经 toTaijiFlatCodeTheme 收敛为 demo 扁平三色档
 * （见该函数注释），双主题结构保留（defaultColor:false 机制不变），两变量值恒等当前
 * 主题令牌。
 */
export const SHIKI_DARK = 'min-dark'
export const SHIKI_LIGHT = 'min-light'

/**
 * [MF-1-27] demo 扁平三色档（workbench.css .codeblock pre/.cm/.val，471-479）：代码块
 * 语法色收敛三档——正文 fg-2（--neutral-fg-2）、注释 dim（--neutral-dim）、值
 * md-code-fg（--md-code-fg）。shiki 内置 min 系全语法彩色档（默认 token 紫 #b392f0、
 * keyword 粉红、constant 蓝）与 demo 近单色 + 暖值档明显偏离，按 demo 权威收敛。
 * 色值经 var() 引用 real 语义令牌而非静态 hex：① 六主题（含亮色切换）自动跟随；②
 * --md-code-fg 是 color-mix 动态公式，唯 var 可表达。defaultColor:false 下 shiki 把
 * token 色写进 --shiki-dark/--shiki-light 变量，var() 嵌套引用在 CSS 层合法解析
 * （MarkdownRenderer .shiki span 的 color 消费变量），亮/暗两变量同令牌 → 双主题
 * 机制保持结构、值恒等当前主题令牌。
 * scope 分档：无 scope 匹配的默认档 = 正文色；comment（含 docstring，min-dark 原本
 * 同档）= 注释档；string/constant 前缀 = 值档（shiki scope 前缀匹配覆盖
 * string.quoted / constant.numeric / constant.language 等）。italic/bold 字形档 demo
 * 无权威，一并收敛（扁平化）。
 * 影响面：本单例消费方（对话流 MarkdownRenderer + drawer CodeBlock / DiffView）同步
 * 三档——demo drawers.css 代码块与 workbench.css 同规格，方向一致。
 */
const TAIJI_FLAT_CODE_TOKEN_COLORS: NonNullable<ThemeRegistration['tokenColors']> = [
  { settings: { foreground: 'var(--neutral-fg-2)' } },
  { scope: ['comment', 'string.quoted.docstring.multi'], settings: { foreground: 'var(--neutral-dim)' } },
  { scope: ['string', 'constant'], settings: { foreground: 'var(--md-code-fg)' } },
]

/** 主题扁平化：保留 name/colors（主题名匹配与透明底机制不变），仅替换 tokenColors。 */
export function toTaijiFlatCodeTheme(base: ThemeRegistration): ThemeRegistration {
  return { ...base, tokenColors: TAIJI_FLAT_CODE_TOKEN_COLORS }
}

/**
 * 创建 shiki highlighter（fine-grained core 版，无 DOM 依赖）。
 * 主线程降级路径与 worker 各自持一份（worker 内一次初始化后常驻复用）。
 */
export async function createShikiHighlighter(): Promise<HighlighterCore> {
  return createHighlighterCore({
    // 静态 import 的 theme 对象经扁平化（MF-1-27 三色色阶，name 不变与 SHIKI_DARK/
    // SHIKI_LIGHT 主题名匹配保持）
    themes: [toTaijiFlatCodeTheme(minDark), toTaijiFlatCodeTheme(minLight)],
    // 静态 import 的 grammar 对象（SHIKI_LANGS 的 13 项：bash/shell 由 shellscript 的
    // grammar aliases 覆盖，无需单独 import，见 import 区注释）
    langs: [typescript, javascript, vue, json, shellscript, markdown, css, html, yaml, python, go, rust],
    engine: createJavaScriptRegexEngine(),
  })
}

/**
 * 用给定 highlighter 同步高亮一段代码，返回双主题 HTML（带 --shiki-dark/--shiki-light
 * 变量的 span）。未知语言 fallback typescript；解析失败返回空串（调用方降级为
 * <pre><code> 纯文本）。**worker 与主线程共用同一函数**——产物一致性由此构造性保证。
 */
export function highlightWithHighlighter(hl: HighlighterCore, code: string, lang: string): string {
  const resolved = hl.getLoadedLanguages().includes(lang) ? lang : 'typescript'
  try {
    return hl.codeToHtml(code, {
      lang: resolved,
      themes: { dark: SHIKI_DARK, light: SHIKI_LIGHT },
      defaultColor: false,
    })
  } catch {
    // 未知语言/解析失败：返回空串，调用方降级为 <pre><code> 纯文本
    return ''
  }
}

// ── worker 高亮协议（主线程客户端与 worker 共用的消息类型 SSOT）───────────────

/** 单个高亮 job（id 由主线程客户端分配，用于结果关联与取消） */
export interface HighlightJob {
  id: number
  code: string
  lang: string
}

/** 主线程 → worker */
export type HighlightWorkerInbound =
  | { type: 'jobs'; jobs: HighlightJob[] }
  | { type: 'cancel'; ids: number[] }

/** worker → 主线程 */
export type HighlightWorkerOutbound =
  | { type: 'result'; id: number; html: string }
  | { type: 'jobError'; id: number; message: string }
  | { type: 'log'; level: 'log' | 'warn' | 'error'; msg: string }
