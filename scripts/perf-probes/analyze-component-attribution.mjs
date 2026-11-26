#!/usr/bin/env node
/**
 * 批6 R4：prod bundle 里的组件级 inclusive 归因（零依赖）。
 *
 * 背景（批5 R4 登记）：「组件级 inclusive 在 prod bundle 不可测（_sfc_render 匿名）」。
 * 本探针推翻这个「不可测」：`vite build --minify false` 保留 Vue 的 `__name: "X"` 编译标记，
 * 而 SFC 的渲染闭包就排布在所属组件标记之后、下一个标记之前——按「采样行号 → 最近前驱
 * __name」即可把匿名帧归回组件；inclusive 沿 parent 链上行，每条采样栈内同一组件只记一次。
 *
 * 口径纪律：
 *   ① 只统计窗口内（env.rendererWindow）样本；
 *   ② self = 采样落点帧；inclusive = 该采样栈上出现的组件（一次一计）；
 *   ③ bundle 必须与 profile 同源（--bundle 指定 chunk 文件名；错了行号映射整体漂移）；
 *   ④ 结论只承载相对占比（组件间的分摊），不承载绝对成本（dev/prod、minify 都会变）。
 *
 * 用法：node scripts/perf-probes/analyze-component-attribution.mjs --profile <cpuprofile> --env <env.json> --bundle <chunk.js>
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseFlags } from './lib/harness.mjs'

const flags = parseFlags()
const profileFile = flags.profile
const envFile = flags.env
const bundleName = flags.bundle
if (!profileFile || !envFile || !bundleName) {
  console.error('usage: node scripts/perf-probes/analyze-component-attribution.mjs --profile <cpuprofile> --env <env.json> --bundle <main-xxx.js> [--assets-dir apps/electron/renderer/dist/assets]')
  process.exit(2)
}
const assetsDir = flags['assets-dir'] ?? 'apps/electron/renderer/dist/assets'

// ── ① bundle 行号 → 组件名映射 ──
const lines = fs.readFileSync(path.join(assetsDir, bundleName), 'utf8').split('\n')
const marks = []
lines.forEach((l, i) => { const m = /__name:\s*"([A-Za-z0-9_$]+)"/.exec(l); if (m) marks.push({ line: i + 1, name: m[1] }) })
if (marks.length < 10) {
  console.error(`[r4] ${bundleName} 里 __name 标记只有 ${marks.length} 个——bundle 与 profile 不同源或非 --minify false 产物`)
  process.exit(3)
}
const compAt = (line) => {
  let lo = 0, hi = marks.length - 1, ans = null
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (marks[mid].line <= line) { ans = marks[mid]; lo = mid + 1 } else hi = mid - 1 }
  return ans?.name ?? null
}

// ── ② profile 窗口内 self + inclusive ──
const p = JSON.parse(fs.readFileSync(profileFile, 'utf8'))
const env = JSON.parse(fs.readFileSync(envFile, 'utf8'))
const { relFromS: from, relToS: to } = env.rendererWindow
const byId = new Map(p.nodes.map(n => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
let cum = 0
const times = p.timeDeltas.map(d => { const t = p.startTime + cum; cum += d; return t })
const t0 = p.startTime + from * 1e6, t1 = p.startTime + to * 1e6
const selfByComp = new Map()
const inclByComp = new Map()
let mapped = 0
let unmapped = 0
for (let i = 0; i < p.samples.length; i++) {
  const t = times[i]
  if (t < t0 || t > t1) continue
  const node = byId.get(p.samples[i])
  const cf = node?.callFrame
  if (!cf) continue
  const dt = (p.timeDeltas[i] ?? 0) / 1e6
  // self：采样落点帧
  if ((cf.url ?? '').includes('main-') && cf.functionName === '') {
    const comp = compAt(cf.lineNumber + 1)
    if (comp) { selfByComp.set(comp, (selfByComp.get(comp) ?? 0) + dt); mapped++ } else unmapped++
  }
  // inclusive：整条栈上的组件帧（一次一计）
  const seen = new Set()
  let cur = node.id
  while (cur !== undefined) {
    const f = byId.get(cur)?.callFrame
    if (f && (f.url ?? '').includes('main-') && f.functionName === '') {
      const comp = compAt(f.lineNumber + 1)
      if (comp && !seen.has(comp)) { seen.add(comp); inclByComp.set(comp, (inclByComp.get(comp) ?? 0) + dt) }
    }
    cur = parent.get(cur)
  }
}
const fmt = (m, total) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([k, v]) => `  ${v.toFixed(3).padStart(8)}s (${((v / total) * 100).toFixed(1)}%)  ${k}`).join('\n')
const selfTotal = [...selfByComp.values()].reduce((a, b) => a + b, 0)
const inclTotal = [...inclByComp.values()].reduce((a, b) => a + b, 0)
console.log(`bundle=${bundleName} __name=${marks.length} 窗口 ${from.toFixed(1)}..${to.toFixed(1)}s`)
console.log(`匿名帧可归因样本 ${mapped}（未映射 ${unmapped}）`)
console.log(`\n组件 self 合计 ${selfTotal.toFixed(2)}s:\n${fmt(selfByComp, selfTotal)}`)
console.log(`\n组件 inclusive 合计 ${inclTotal.toFixed(2)}s:\n${fmt(inclByComp, inclTotal)}`)
console.log(`RESULT component-attribution bundle=${bundleName} marks=${marks.length} selfTotal=${selfTotal.toFixed(3)} inclTotal=${inclTotal.toFixed(3)}`)
