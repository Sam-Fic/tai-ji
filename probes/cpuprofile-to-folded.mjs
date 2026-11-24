#!/usr/bin/env node
/**
 * .cpuprofile → 折叠栈（folded stacks，flamegraph.pl / speedscope / 各种火焰图工具的标准输入）。
 *
 * 用法：node probes/cpuprofile-to-folded.mjs <profile.cpuprofile> [--from <s>] [--to <s>] > out.folded
 *   --from/--to 为相对 profile 起点的秒数窗（缺省全窗）。
 *
 * 口径：每个采样点沿 parent 链生成一条栈（root → leaf），按 timeDeltas 累加权重（微秒）。
 * 与 probes/lib/harness.mjs 的 self/inclusive 口径同源（同一条 samples/timeDeltas 时间轴）。
 * 渲染：flamegraph.pl --title "x" out.folded > chart.svg；或 chrome://tracing / DevTools
 *      Performance 面板直接加载 .cpuprofile 看火焰图。
 */
import fs from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node probes/cpuprofile-to-folded.mjs <profile.cpuprofile> [--from <s>] [--to <s>]')
  process.exit(2)
}
const argv = process.argv.slice(3)
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : d
}
const from = flag('from', 0)
const to = flag('to', Infinity)

const profile = JSON.parse(fs.readFileSync(file, 'utf8'))
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)

const label = (n) => {
  const cf = n.callFrame
  const fn = cf.functionName || '(anonymous)'
  const shortUrl = (cf.url || '').split('/').pop().split('?')[0]
  return shortUrl ? `${fn} (${shortUrl}:${cf.lineNumber + 1})` : fn
}

const folded = new Map()
let acc = 0
for (let i = 0; i < profile.samples.length; i++) {
  const delta = profile.timeDeltas[i] ?? 0
  const sec = acc / 1e6
  acc += delta
  if (sec < from || sec >= to) continue
  const node = byId.get(profile.samples[i])
  if (!node) continue
  const stack = []
  let cur = node.id
  while (cur !== undefined) {
    const nd = byId.get(cur)
    if (!nd) break
    stack.push(label(nd))
    cur = parent.get(cur)
  }
  stack.reverse()
  const key = stack.join(';')
  folded.set(key, (folded.get(key) ?? 0) + delta)
}
const lines = [...folded].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v)}`)
process.stdout.write(`${lines.join('\n')}\n`)
