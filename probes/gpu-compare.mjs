#!/usr/bin/env node
/** GPU union 对比（可指定子窗口）：对两份 trace 用同一口径算 union，消除「窗内冷启动占比不同」的
 *  组成差异。用法: node probes/gpu-compare.mjs <before.json> <after.json> [beforeFrom beforeTo afterFrom afterTo]
 *  默认全窗；子窗口单位秒（相对各自 trace 的起点）。
 */
import fs from 'node:fs'

function load (file, fromS, toS) {
  const events = JSON.parse(fs.readFileSync(file, 'utf8'))
  const threadNames = new Map()
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args.name)
  }
  const xs = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number' && typeof e.ts === 'number'
    && Number.isFinite(e.ts) && e.ts > 0 && e.ts < 1e15)
  const t0 = xs.reduce((m, e) => Math.min(m, e.ts), Infinity)
  const t1 = xs.reduce((m, e) => Math.max(m, e.ts + e.dur), 0)
  const from = fromS === undefined ? t0 : t0 + fromS * 1e6
  const to = toS === undefined ? t1 : t0 + toS * 1e6
  const keep = (e) => e.ph === 'X' && typeof e.dur === 'number' && typeof e.ts === 'number'
    && Number.isFinite(e.ts) && e.ts > 0 && e.ts < 1e15 && e.ts >= from && e.ts + e.dur <= to + 1e6
  const kept = events.filter(keep).map((e) => ({ ...e, ts: e.ts - t0 }))
  return [kept, (to - from) / 1e6, threadNames]
}

function unionS (iv) {
  if (!iv.length) return 0
  iv.sort((a, b) => a[0] - b[0])
  let total = 0; let cs = iv[0][0]; let ce = iv[0][1]
  for (const [s, e] of iv.slice(1)) {
    if (s > ce) { total += ce - cs; cs = s; ce = e } else ce = Math.max(ce, e)
  }
  return (total + ce - cs) / 1e6
}

function stat (evs, threadNames) {
  const byThread = new Map()
  for (const e of evs) {
    const k = `${e.pid}:${e.tid}`
    if (!byThread.has(k)) byThread.set(k, [])
    byThread.get(k).push([e.ts, e.ts + e.dur])
  }
  const ranked = [...byThread.entries()].map(([k, v]) => [k, unionS(v), threadNames.get(k) || '?'])
    .sort((a, b) => b[1] - a[1])
  // 显式按名字取 GPU 主线程 / renderer 主线程 / compositor（不能拿 ranked[0] 冒充——
  // before 的最忙线程是 CrGpuMain、after 是 CrRendererMain，名字不同）
  const pick = (re) => ranked.find(([, , n]) => re.test(n))
  const gpuMain = pick(/CrGpuMain/)
  const rendererMain = pick(/CrRendererMain/)
  const compositor = pick(/Compositor/)
  const pred = (p) => evs.filter(p)
  return {
    n: evs.length,
    ranked: ranked.slice(0, 3),
    gpuMain: gpuMain ? gpuMain[1] : 0,
    rendererMain: rendererMain ? rendererMain[1] : 0,
    compositor: compositor ? compositor[1] : 0,
    raster: (() => { const v = pred((e) => /raster/i.test(e.name)); return { n: v.length, union: unionS(v.map((e) => [e.ts, e.ts + e.dur])) } })(),
    backpressure: (() => { const v = pred((e) => e.name.includes('ApplyBackpressure')); return { n: v.length, union: unionS(v.map((e) => [e.ts, e.ts + e.dur])) } })(),
    displayLink: pred((e) => e.name === 'CVDisplayLinkCallback').length,
  }
}

const [bf, af] = [process.argv[2], process.argv[3]]
const [bFrom, bTo, aFrom, aTo] = process.argv.slice(4).map((v) => (v === undefined ? undefined : Number(v)))
const [bev, bwin, bn] = load(bf, bFrom, bTo)
const [aev, awin, an] = load(af, aFrom, aTo)
const b = stat(bev, bn); const a = stat(aev, an)

const row = (label, bv, av, unit = 's') => {
  const fmt = (v) => typeof v === 'number' ? v.toFixed(2) : String(v)
  const d = (typeof bv === 'number' && typeof av === 'number' && bv > 0) ? ` (${((av / bv - 1) * 100).toFixed(0)}%)` : ''
  console.log(`  ${label.padEnd(26)} before=${fmt(bv)}${unit}  after=${fmt(av)}${unit}${d}`)
}
console.log(`BEFORE ${bf} window=${bwin.toFixed(2)}s events=${b.n}`)
console.log(`AFTER  ${af} window=${awin.toFixed(2)}s events=${a.n}`)
row('CrGpuMain union', b.gpuMain, a.gpuMain)
row('  as % of window', (b.gpuMain / bwin) * 100, (a.gpuMain / awin) * 100, '%')
row('CrRendererMain union', b.rendererMain, a.rendererMain)
row('Compositor union', b.compositor, a.compositor)
row('Raster union', b.raster.union, a.raster.union)
row('Raster count', b.raster.n, a.raster.n, '')
row('ApplyBackpressure union', b.backpressure.union, a.backpressure.union)
row('ApplyBackpressure count', b.backpressure.n, a.backpressure.n, '')
row('CVDisplayLink (frames)', b.displayLink, a.displayLink, '')
