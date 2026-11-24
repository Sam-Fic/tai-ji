#!/usr/bin/env node
/**
 * 批3 真机探针 T2：高亮产物前后对拍（worker 路径 vs 主线程同源算法）。
 *
 * 判据 = 「worker 回填的 HTML」与「同一 shiki 配置模块在主线程（Node）重放的 HTML」
 * 归一化后逐字节一致。主线程路径即批3 前的算法（getHighlighter + highlightShikiSync
 * 原样抽入 shiki-highlight-core.ts，两侧 import 同一导出），故一致 ⟺ 视觉零变化。
 *
 * 前置（由验收流程保证）：dev 实例已起，session 已建；调用前消息已 complete
 * （acceptance 命令先 chat.send + chat.wait）。
 *
 * 形态：node_modules/.bin/tsx probes/shiki-html-diff.mjs --data-dir <dir> --sid <sid>
 *   （tsx = 仓库既有 dev 依赖；探针需 import ui 包 shiki 配置模块做同源重算）
 *
 * 输出末行：RESULT shiki-html-identical:true|false PASS|FAIL；exit 0/1。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  connectRuntime,
  connectRendererCdp,
  ensureGuiOnSession,
} from './lib/harness.mjs'

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}

const dataDir = path.resolve(arg('data-dir', ''))
const sid = arg('sid', '')
if (!dataDir || !sid) {
  console.error('usage: node_modules/.bin/tsx probes/shiki-html-diff.mjs --data-dir <dir> --sid <sid>')
  process.exit(2)
}

// 同源配置模块（worker 与主线程共用的同一导出）
const configUrl = pathToFileURL(path.resolve('packages/ui/src/features/chat/shiki-highlight-core.ts')).href
const { createShikiHighlighter, highlightWithHighlighter } = await import(configUrl)

const rt = await connectRuntime(dataDir)
const cdp = await connectRendererCdp(Number(arg('cdp-port', '9478')))
console.log('[probe] connected runtime + renderer CDP')
await cdp.send('Runtime.enable')
await ensureGuiOnSession(cdp, sid)

// DOM 提取：每个 .md-codeblock → lang 标签 + data-code（base64 源码）+ pre.shiki outerHTML
// worker 高亮异步回填：轮询等 pre.shiki 出现（消息 complete 时 worker 可能在途），
// 上限 30s（事件驱动轮询微任务 + 墙钟混合，非固定 sleep）。
const EXTRACT_EXPR = `JSON.stringify([...document.querySelectorAll('.md-codeblock')].map((el) => ({
  lang: el.querySelector('.md-codeblock__lang')?.textContent ?? '',
  dataCode: el.querySelector('.md-codeblock__copy')?.getAttribute('data-code') ?? '',
  preHtml: el.querySelector('pre.shiki')?.outerHTML ?? null,
})))`
let blocks = []
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  const extracted = await cdp.send('Runtime.evaluate', { expression: EXTRACT_EXPR, returnByValue: true })
  blocks = JSON.parse(extracted.result?.value ?? '[]')
  if (blocks.length > 0 && blocks.every((b) => b.preHtml)) break
  await new Promise((r) => setTimeout(r, 500))
}
cdp.close()
rt.ws.close()
console.log(`[probe] extracted ${blocks.length} codeblock(s) from DOM (highlighted: ${blocks.filter((b) => b.preHtml).length})`)

if (blocks.length === 0) {
  console.error('[probe] DOM 无 .md-codeblock——消息未完成或未渲染，弃测')
  process.exit(3)
}

/** base64 → UTF-8 文本（浏览器 atob + TextDecoder 对偶实现） */
function decodeBase64Utf8(b64) {
  const binary = Buffer.from(b64, 'base64').toString('binary')
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * 归一化：折叠标签间空白 + class 属性内令牌排序（允许 class 序差）+
 * HTML 实体解码（DOM outerHTML 序列化会把 > 转成 &gt;，shiki 原串是字面 >——
 * 纯序列化差异，解码后两侧同一文本）。
 */
function normalizeHtml(html) {
  return html
    .replace(/>\s+</g, '><')
    .replace(/class="([^"]*)"/g, (_m, cls) => `class="${cls.split(/\s+/).filter(Boolean).sort().join(' ')}"`)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

const hl = await createShikiHighlighter()
let allSame = true
for (const [i, b] of blocks.entries()) {
  if (!b.preHtml) {
    console.log(`[probe] block#${i} 无 pre.shiki（降级纯文本？）——对拍失败`)
    allSame = false
    continue
  }
  const code = decodeBase64Utf8(b.dataCode)
  const expected = highlightWithHighlighter(hl, code, b.lang)
  const same = normalizeHtml(expected) === normalizeHtml(b.preHtml)
  console.log(`[probe] block#${i} lang=${b.lang} codeChars=${code.length} preChars=${b.preHtml.length} identical=${same}`)
  if (!same) {
    allSame = false
    // 定位首个差异字符，便于诊断
    const a = normalizeHtml(expected)
    const c = normalizeHtml(b.preHtml)
    let d = 0
    while (d < Math.min(a.length, c.length) && a[d] === c[d]) d++
    console.log(`[probe]   first diff at ${d}: expected=...${a.slice(Math.max(0, d - 40), d + 40)}... actual=...${c.slice(Math.max(0, d - 40), d + 40)}...`)
  }
}

console.log(`RESULT shiki-html-identical:${allSame} ${allSame ? 'PASS' : 'FAIL'}`)
process.exit(allSame ? 0 : 1)
