#!/usr/bin/env node
/**
 * CDP renderer CPU 采样剖析工具（开发期性能分析，非 CI 资产）。
 *
 * 用法：
 *   node scripts/perf/cdp-profile.mjs <CDP 端口> <页面 target id> [采样秒数=10]
 * 例：
 *   node scripts/perf/cdp-profile.mjs 9458 48FA2486... 15
 *
 * target id 从 `curl -s http://localhost:<port>/json` 取（dev 实例 CDP 端口见
 * dev-instance 启动横幅；打包版未开 CDP）。输出按 self-time 降序的函数热点
 * （百分比 = 主线程采样占比；(idle) 高占比 = 热点在 raster/compositor 线程，
 * 去看 GPU 进程 CPU 与动画/合成层，而不是 JS）。
 *
 * 配套方法（2026-11 性能优化实践，详见 ~/Code/vue-performance/ 与 docs）：
 * - 动画审计：Runtime.evaluate "document.getAnimations().filter(a=>a.playState==='running')"
 * - A/B 暂停全部动画再对比 CPU：document.getAnimations().forEach(a=>a.pause())
 * - 进程级数据：ps aux（GPU 进程 = '...Helper (GPU)'，renderer = '...Helper (Renderer)'）
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const port = Number(process.argv[2])
const target = process.argv[3]
const durationSec = Number(process.argv[4] ?? 10)

if (!port || !target) {
  console.error('用法: node scripts/perf/cdp-profile.mjs <CDP 端口> <页面 target id> [秒数]')
  process.exit(1)
}

const pages = await (await fetch(`http://localhost:${port}/json`)).json()
const page = pages.find((t) => t.id === target)
if (!page) {
  console.error(`target ${target} 不存在；可用：${pages.map((t) => t.id).join(', ')}`)
  process.exit(1)
}

const sock = new WebSocket(page.webSocketDebuggerUrl, [], {})
let msgId = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, resolve)
    sock.send(JSON.stringify({ id, method, params }))
  })
sock.on('message', (d) => {
  const m = JSON.parse(d)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((r) => sock.on('open', r))

await send('Profiler.enable')
await send('Profiler.setSamplingInterval', { interval: 1000 })
await send('Profiler.start')
await new Promise((r) => setTimeout(r, durationSec * 1000))
const { result: { profile } } = await send('Profiler.stop')

const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map()
const total = profile.samples.length
for (const s of profile.samples) self.set(s, (self.get(s) ?? 0) + 1)
const agg = new Map()
for (const [nid, cnt] of self) {
  const f = nodes.get(nid)?.callFrame
  const fn = f
    ? `${f.functionName || '(anon)'}@${(f.url || '').split('/').slice(-2).join('/')}:${f.lineNumber + 1}`
    : '?'
  agg.set(fn, (agg.get(fn) ?? 0) + cnt)
}
for (const [fn, c] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`${((c / total) * 100).toFixed(1)}% ${fn}`)
}
process.exit(0)
