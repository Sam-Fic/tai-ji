#!/usr/bin/env node
/**
 * 批6 R1 A/B 计数探针（零几何读）：只数 DOM scrollTo 调用与目标值，不读 scrollTop/scrollHeight
 * ——批5 的教训是「写前读几何会把 pending 布局 flush 从 scrollTo 帧挪到 getter 帧」，任何
 * 几何读都会扭曲被测成本。本探针只保留「调用次数 + 目标 top」，扰动面最小。
 *
 * 用法：node probes/scroll-count.mjs --data-dir <dir> --sid <sid> [--cdp-port 9488]
 * 输出末行：RESULT scroll-count calls=<n> distinctTargets=<n>
 */
import fs from "node:fs"
import { connectRuntime, connectRendererCdp, ensureGuiOnSession, waitForSessionComplete, parseFlags, sleep } from './lib/harness.mjs'

const flags = parseFlags()
const dataDir = flags['data-dir']
const sid = flags.sid
const cdpPort = Number(flags['cdp-port'] ?? 9488)
const timeoutMs = Number(flags.timeout ?? 240000)
const prompt = flags.text ?? '请给出性能优化实施方案'
if (!dataDir || !sid) {
  console.error('usage: node probes/scroll-count.mjs --data-dir <dir> --sid <sid> [--cdp-port 9488]')
  process.exit(2)
}

const INJECT = `(() => {
  if (window.__scrollCount) return 'already'
  const rec = window.__scrollCount = { calls: [], t0: performance.now() }
  const orig = Element.prototype.scrollTo
  Element.prototype.scrollTo = function (...args) {
    const a0 = args[0]
    const top = a0 && typeof a0 === 'object' ? (a0.top === undefined ? null : a0.top) : (typeof a0 === 'number' ? a0 : null)
    rec.calls.push({ t0: performance.now() - rec.t0, top })
    return orig.apply(this, args)
  }
  return 'ok'
})()`

const rt = await connectRuntime(dataDir)
const cdp = await connectRendererCdp(cdpPort)
await ensureGuiOnSession(cdp, sid)
const injected = await cdp.send('Runtime.evaluate', { expression: INJECT, returnByValue: true })
console.log(`[count] inject: ${injected.result?.value}`)
if (flags.profile) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.start')
}
await rt.call('session.subscribe', { sessionId: sid }, 30000)
const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
console.log('[count] prompt submitted')
// 流中抽样（可选）：--mid-check <秒> 在流式进行中读一次滚动位置（单次几何读，不扰动计数口径）
if (flags['mid-check']) {
  await sleep(Number(flags['mid-check']) * 1000)
  const mid = await cdp.send('Runtime.evaluate', { expression: `(() => {
    let best=null
    for (const e of document.querySelectorAll('*')) {
      if (e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'visible') {
        if (!best || e.scrollHeight > best.scrollHeight) best = e
      }
    }
    return best ? { top: best.scrollTop, max: best.scrollHeight - best.clientHeight } : null
  })()`, returnByValue: true })
  console.log(`[count] mid-stream(${flags['mid-check']}s):`, JSON.stringify(mid.result?.value))
}
await waitForSessionComplete(rt, sid, timeoutMs)
await sleep(2500)
if (flags.profile) {
  const st = await cdp.send('Profiler.stop')
  fs.writeFileSync(flags.profile, JSON.stringify(st.profile))
  console.log(`[count] profile saved -> ${flags.profile}`)
}
const got = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    const c = (window.__scrollCount || {}).calls || []
    const tops = new Set(c.map(x => String(x.top)))
    const buckets = {}
    for (const x of c) { const k = Math.floor(x.t0 / 10000) * 10; buckets[k] = (buckets[k] || 0) + 1 }
    return { total: c.length, distinctTargets: tops.size, spanS: (performance.now() - (window.__scrollCount?.t0 ?? 0)) / 1000, buckets }
  })()`,
  returnByValue: true,
})
const s = got.result?.value ?? { total: 0, distinctTargets: 0, spanS: 0 }
// 收敛事实：流结束后滚动容器必须贴底（gap ≤ 4px，与 pin-bottom-guard 同阈值）——
// 这是守卫不得破坏的正确性红线，比计数本身更重要。
const end = await cdp.send('Runtime.evaluate', { expression: `(() => {
  let best=null
  for (const e of document.querySelectorAll('*')) {
    if (e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'visible') {
      if (!best || e.scrollHeight > best.scrollHeight) best = e
    }
  }
  return best ? { gap: +(best.scrollHeight - best.clientHeight - best.scrollTop).toFixed(2), top: best.scrollTop, max: best.scrollHeight - best.clientHeight } : null
})()`, returnByValue: true })
const bottom = end.result?.value
console.log(`[count] end-of-stream bottom:`, JSON.stringify(bottom))
if (!bottom || bottom.gap > 4) {
  console.error(`[count] FAIL: 流结束未贴底（gap=${bottom?.gap}）——跟随被破坏，守卫/改动不可交付`)
  rt.ws.close(); cdp.close()
  process.exit(5)
}
console.log(`span=${s.spanS.toFixed(1)}s calls=${s.total} (${(s.total / Math.max(1, s.spanS)).toFixed(1)}/s) distinctTargets=${s.distinctTargets}`)
console.log('per-10s buckets:', JSON.stringify(s.buckets))
console.log(`RESULT scroll-count calls=${s.total} distinctTargets=${s.distinctTargets} endGap=${bottom?.gap}`)
rt.ws.close()
cdp.close()
process.exit(0)
