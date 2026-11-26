#!/usr/bin/env node
/** GPU trace union 口径分析：墙钟跨度 / 每线程顶层切片 union / Present 统计 / raster union。
 *  用法: node analyze-gpu-union.mjs <trace.json> [label]
 *  口径对齐 GLM 对抗审查 M1（嵌套子切片求和作废，一律按线程时间轴 union）。
 */
import fs from 'node:fs'

const file = process.argv[2]
const label = process.argv[3] || file
const events = JSON.parse(fs.readFileSync(file, 'utf8'))

const tnames = new Map(); const pnames = new Map()
for (const e of events) {
  if (e.ph === 'M' && e.name === 'thread_name') tnames.set(e.pid + ':' + e.tid, e.args.name)
  if (e.ph === 'M' && e.name === 'process_name') pnames.set(e.pid, e.args.name)
}
let minTs = Infinity; let maxTs = 0
for (const e of events) {
  if (e.ph !== 'X' || typeof e.dur !== 'number' || typeof e.ts !== 'number') continue
  if (!Number.isFinite(e.ts) || e.ts <= 0 || e.ts > 1e15) continue
  if (e.ts < minTs) minTs = e.ts
  const t = e.ts + e.dur
  if (t > maxTs) maxTs = t
}
const wallS = (maxTs - minTs) / 1e6
console.log(`[${label}] wall-span=${wallS.toFixed(2)}s events=${events.length}`)

// union：一组 [start,end) 区间的覆盖时长
function unionS (iv) {
  if (!iv.length) return 0
  iv.sort((a, b) => a[0] - b[0])
  let total = 0; let cs = iv[0][0]; let ce = iv[0][1]
  for (const [s, e] of iv.slice(1)) {
    if (s > ce) { total += ce - cs; cs = s; ce = e } else ce = Math.max(ce, e)
  }
  return (total + ce - cs) / 1e6
}

// 每线程：全部分片 union（顶层近似：不做嵌套剔除的 union 已消除嵌套重复）
const byThread = new Map()
for (const e of events) {
  if (e.ph !== 'X' || typeof e.dur !== 'number') continue
  const k = e.pid + ':' + e.tid
  if (!byThread.has(k)) byThread.set(k, [])
  byThread.get(k).push([e.ts, e.ts + e.dur])
}
console.log('per-thread union (top busy threads):')
for (const [k, iv] of [...byThread.entries()].map(([k, v]) => [k, unionS(v)]).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ${k} ${tnames.get(k) || '?'} [${pnames.get(Number(k.split(':')[0])) || '?'}] union=${iv.toFixed(2)}s (${((iv / wallS) * 100).toFixed(1)}%)`)
}

// 专项：Present / ApplyBackpressure / Raster / GPUTask
function sliceStat (pred) {
  const iv = []
  let n = 0
  const durs = []
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue
    if (pred(e)) { n++; iv.push([e.ts, e.ts + e.dur]); durs.push(e.dur / 1000) }
  }
  durs.sort((a, b) => a - b)
  const p = (q) => durs.length ? durs[Math.min(durs.length - 1, Math.floor(q * durs.length))].toFixed(2) : '-'
  return { n, union: unionS(iv), avg: durs.length ? (durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(2) : '-', p50: p(0.5), p95: p(0.95) }
}
const isGpuProc = (e) => (pnames.get(e.pid) || '').toLowerCase().includes('gpu')
for (const [name, pred] of [
  ['Present', (e) => e.name === 'Present'],
  ['ApplyBackpressure', (e) => e.name.includes('ApplyBackpressure')],
  ['Raster(CrGpuMain)', (e) => isGpuProc(e) && /raster/i.test(e.name)],
  ['GPUTask', (e) => e.name === 'GPUTask'],
  ['BeginMainFrame', (e) => e.name === 'BeginMainFrame'],
]) {
  const s = sliceStat(pred)
  console.log(`${name}: n=${s.n} union=${s.union.toFixed(2)}s avg=${s.avg}ms p50=${s.p50}ms p95=${s.p95}ms`)
}
