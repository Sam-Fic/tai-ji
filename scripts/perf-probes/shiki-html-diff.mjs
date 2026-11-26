#!/usr/bin/env node
/**
 * 批3 真机探针 T2：高亮产物前后对拍（worker 路径 vs 主线程同源算法）。
 *
 * 判据 = 同一 fixture 代码块的最终 HTML，worker 路径产物与主线程路径产物归一化后
 * 逐字节一致。**两侧都在真实浏览器内采集**——早先版本在 Node 侧重算期望值，但
 * oniguruma-to-es 的 JS 正则引擎在 Node 22 与 Chromium 142 两个 V8 上对个别形态
 * （实测：空串字面量 ""）的 tokenize 结果不同，Node 侧重算会引入与本题无关的
 * V8 版本 skew（假红）。主线程路径即批3 前的算法（getHighlighter +
 * highlightShikiSync 原样抽入 shiki-highlight-core，两侧 import 同一导出）。
 *
 * **引擎 warmup 修正（实测发现）**：shiki JS 引擎每个实例的**首次** codeToHtml
 * 对个别形态（空串字面量 ""）的 tokenize 与后续调用不同（首调 warmup 效应，
 * 两条路径同源——批3 前的主线程路径同样受此影响，非本批引入）。直接对拍「流式
 * 全程的最后一帧」会因两侧 warmup 进度不同而假红。故每轮提取前先强制一次重渲染
 * （切走再切回目标 session），两侧都取 warmup 后的稳定产物再对拍。
 *
 * 流程（两轮流式，同页面两段生命周期）：
 *   ① 刷新页面（全新客户端）→ 发 prompt 到 sidA → complete → 轮询等高亮落 DOM →
 *      提取 .md-codeblock（lang + data-code + pre.shiki outerHTML）= worker 路径产物；
 *   ② 再刷新页面 → window.Worker 打桩（构造抛错 → degrade → 主线程同步回退）→ 发
 *      prompt 到 sidB → complete → 轮询等高亮 → 提取 = 主线程路径产物；
 *   ③ 归一化对拍（折叠标签间空白 + class 令牌排序 + HTML 实体解码——DOM outerHTML
 *      序列化会把 > 转义为 &gt;，纯序列化差异）。
 *
 * 形态：node_modules/.bin/tsx scripts/perf-probes/shiki-html-diff.mjs --data-dir <dir> --sid <sidA>
 *   （tsx = 仓库既有 dev 依赖；探针自身经 rt RPC 创建 sidB）
 *
 * 输出末行：RESULT shiki-html-identical:true|false PASS|FAIL；exit 0/1。
 */
import path from 'node:path'
import {
  connectRuntime,
  connectRendererCdp,
  ensureGuiOnSession,
  waitForSessionComplete,
  collectConsoleMessages,
  sleep,
} from './lib/harness.mjs'

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}

const dataDir = path.resolve(arg('data-dir', ''))
const sidA = arg('sid', '')
const timeoutMs = Number(arg('timeout-ms', '240000'))
const prompt = arg('text', '请给出性能优化实施方案')

if (!dataDir || !sidA) {
  console.error('usage: node_modules/.bin/tsx scripts/perf-probes/shiki-html-diff.mjs --data-dir <dir> --sid <sid>')
  process.exit(2)
}

const rt = await connectRuntime(dataDir)
const cdp = await connectRendererCdp(Number(arg('cdp-port', '9478')))
console.log('[probe] connected runtime + renderer CDP')
await collectConsoleMessages(cdp)
await cdp.send('Page.enable')

/** 刷新页面并等 app 就绪（侧栏在场） */
async function freshPage() {
  await cdp.send('Page.reload')
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.session-item').length > 0`,
      returnByValue: true,
    })
    if (r.result?.value === true) return true
    await sleep(500)
  }
  return false
}

/** 跑一轮流式并提取代码块 DOM（sid 由调用方给出；stubWorker = 打桩逼降级） */
async function runRound(sid, stubWorker) {
  if (!(await freshPage())) throw new Error('app not ready after reload')
  if (stubWorker) {
    await cdp.send('Runtime.evaluate', {
      expression: `window.__origWorker = window.Worker; window.Worker = class { constructor() { throw new Error('probe: worker unavailable') } }`,
    })
    console.log('[probe] window.Worker stubbed (main-thread fallback round)')
  }
  await ensureGuiOnSession(cdp, sid)
  await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid: crypto.randomUUID() }, 30000)
  const endFrame = await waitForSessionComplete(rt, sid, timeoutMs)
  if (!endFrame) throw new Error(`stream not complete for ${sid}`)
  console.log(`[probe] ${sid} stream complete: ${endFrame.type}`)
  // 强制重渲染（切走再切回）：取引擎 warmup 后的稳定产物——首调 warmup 效应会使
  // 「流式全程最后一帧」在两侧处于不同 warmup 进度（见头部注释）。
  await cdp.send('Runtime.evaluate', { expression: `document.querySelectorAll('.session-item')[1]?.click()` }).catch(() => {})
  await sleep(2500)
  await cdp.send('Runtime.evaluate', { expression: `document.querySelectorAll('.session-item')[0]?.click()` }).catch(() => {})
  await sleep(2500)
  // 轮询等高亮落 DOM（worker 异步回填可晚于 complete）
  const deadline = Date.now() + 120000
  let blocks = []
  let spans = 0
  while (Date.now() < deadline) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        blocks: [...document.querySelectorAll('.md-codeblock')].map((el) => ({
          lang: el.querySelector('.md-codeblock__lang')?.textContent ?? '',
          dataCode: el.querySelector('.md-codeblock__copy')?.getAttribute('data-code') ?? '',
          preHtml: el.querySelector('pre.shiki')?.outerHTML ?? null,
        })),
        spans: document.querySelectorAll('pre.shiki [style*="--shiki-dark"]').length,
      })`,
      returnByValue: true,
    })
    const state = JSON.parse(r.result?.value ?? '{}')
    blocks = state.blocks ?? []
    spans = state.spans ?? 0
    if (blocks.length > 0 && blocks.every((b) => b.preHtml) && spans > 0) break
    await sleep(500)
  }
  if (stubWorker) {
    await cdp.send('Runtime.evaluate', {
      expression: `if (window.__origWorker) { window.Worker = window.__origWorker; delete window.__origWorker }`,
    }).catch(() => {})
  }
  return blocks
}

/** 归一化：折叠标签间空白 + class 令牌排序 + HTML 实体解码（序列化差异） */
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

// ① worker 路径（sidA）
const blocksA = await runRound(sidA, false)
console.log(`[probe] worker-path round: ${blocksA.length} codeblock(s)`)
if (blocksA.length === 0) {
  console.error('[probe] worker 路径轮未见代码块——弃测')
  cdp.close()
  rt.ws.close()
  process.exit(3)
}

// ② 主线程路径（sidB，探针自建）
const sidB = (await rt.call('session.create', { cwd: process.cwd() })).session.id
console.log(`[probe] created sidB: ${sidB}`)
const blocksB = await runRound(sidB, true)
console.log(`[probe] main-thread-path round: ${blocksB.length} codeblock(s)`)
cdp.close()
rt.ws.close()

if (blocksB.length === 0) {
  console.error('[probe] 主线程路径轮未见代码块——弃测')
  process.exit(3)
}

// ③ 对拍：按序逐个代码块比（两侧 fixture 相同 → 同序同数）
let allSame = blocksA.length === blocksB.length
for (const [i, a] of blocksA.entries()) {
  const b = blocksB[i]
  if (!b) { allSame = false; continue }
  const na = normalizeHtml(a.preHtml ?? '')
  const nb = normalizeHtml(b.preHtml ?? '')
  const same = na === nb && a.dataCode === b.dataCode
  console.log(`[probe] block#${i} lang=${a.lang} codeChars=${Buffer.from(a.dataCode, 'base64').length} identical=${same}`)
  if (!same) {
    allSame = false
    let d = 0
    while (d < Math.min(na.length, nb.length) && na[d] === nb[d]) d++
    console.log(`[probe]   first diff at ${d}: worker=...${na.slice(Math.max(0, d - 50), d + 60)}... main=...${nb.slice(Math.max(0, d - 50), d + 60)}...`)
  }
}

console.log(`RESULT shiki-html-identical:${allSame} ${allSame ? 'PASS' : 'FAIL'}`)
process.exit(allSame ? 0 : 1)
