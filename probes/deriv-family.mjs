#!/usr/bin/env node
/** 派生族 self-time 聚合（probes/perf-derivatives.mjs 的 analyze 同口径，纯离线复算）。
 *  用法: node probes/deriv-family.mjs <profile.cpuprofile> [relFromS relToS]
 *  用途：批1 前后对比表——对基线（只读归档）与 after 侧 profile 用同一函数名单与
 *        同一窗口口径复算，保证可比（不重测基线，只读复算）。
 */
import fs from 'node:fs'

const file = process.argv[2]
const relFrom = Number(process.argv[3] ?? 10)
const relTo = Number(process.argv[4] ?? 73)
const profile = JSON.parse(fs.readFileSync(file, 'utf8'))

const FAMILY = [
  'railMemoFor', 'summarizeTurnForRail', 'summarizeAssistantForRail', 'stripMarkdown', 'truncate',
  'previewText', 'turnPreview', 'buildStreamViewItems', 'streamingRailAnchor',
]

const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const st = profile.startTime / 1000
let acc = st
const starts = new Array(profile.samples.length)
for (let i = 0; i < profile.timeDeltas.length; i++) { starts[i] = acc; acc += profile.timeDeltas[i] / 1000 }
const fromMs = st + relFrom * 1000
const toMs = st + relTo * 1000
const selfUs = new Map()
const top10 = new Map()
let total = 0
for (let i = 0; i < profile.samples.length; i++) {
  if (starts[i] < fromMs || starts[i] >= toMs) continue
  const node = byId.get(profile.samples[i])
  if (!node) continue
  total += profile.timeDeltas[i]
  const cf = node.callFrame
  const key = `${cf.functionName || '(anonymous)'} @ ${(cf.url || '').replace(/^.*\//, '')}:${cf.lineNumber}`
  top10.set(key, (top10.get(key) ?? 0) + profile.timeDeltas[i])
  if (FAMILY.includes(cf.functionName || '')) {
    const k = `${cf.functionName} @ ${(cf.url || '').replace(/^.*\//, '')}`
    selfUs.set(k, (selfUs.get(k) ?? 0) + profile.timeDeltas[i])
  }
}
let familyMs = 0
const rows = []
for (const [k, us] of [...selfUs.entries()].sort((a, b) => b[1] - a[1])) {
  familyMs += us / 1000
  rows.push(`${k}=${(us / 1000).toFixed(3)}ms`)
}
console.log(`file=${file}`)
console.log(`window=+${relFrom}s..+${relTo}s (sampled ${(total / 1e6).toFixed(1)}s)`)
console.log(`deriv-family breakdown: ${rows.join(' ') || '(none)'}`)
console.log(`RESULT deriv-family-self-time=${(familyMs / 1000).toFixed(3)}s`)
console.log('TOP10 self (window):')
for (const [k, us] of [...top10.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${(us / 1e6).toFixed(3)}s ${k}`)
}
