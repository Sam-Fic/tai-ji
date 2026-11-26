#!/usr/bin/env node
/**
 * 首轮「脏基线」数据集复算（只读，不改首轮资产）。
 *
 * 为什么单独一支脚本：首轮权威 CPU 数据集（run-notrace-renderer.cpuprofile）的窗口口径是
 * **+10..+73s**（GLM 审查 A1 定位的流式段），与批5 干净测量的 send 相对窗不同源；两队数字
 * 不可混算，必须由各自的窗口定义复算后并列（final-summary §2.1 的两列就是这么来的）。
 *
 * 用法：node scripts/perf-probes/analyze-original-baseline.mjs [--profile <path>] [--from 10] [--to 73]
 * 缺省 profile = 首轮会话 artifacts 下的 run-notrace-renderer.cpuprofile。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { selfTimeByLabel, inclusiveByLabel } from './lib/harness.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const profilePath = flag('profile', path.join(
  os.homedir(),
  '.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data/run-notrace-renderer.cpuprofile'
))
const from = Number(flag('from', '10'))
const to = Number(flag('to', '73'))

const p = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
const sum = (re) => {
  const m = selfTimeByLabel(p, from, to, re)
  let s = 0
  for (const [, v] of m) s += v
  return s
}
const inc = (re) => {
  const m = inclusiveByLabel(p, from, to, re)
  let s = 0
  for (const [, v] of m) s += v
  return s
}
const all = selfTimeByLabel(p, from, to, /.*/)
let idle = 0
let prog = 0
let tot = 0
for (const [k, v] of all) {
  tot += v
  if (k.startsWith('(idle)')) idle += v
  if (k.startsWith('(program)')) prog += v
}

console.log(`# original dirty baseline: ${profilePath}`)
console.log(`# window +${from}..+${to}s = ${(to - from).toFixed(1)}s`)
console.log(`RESULT original-baseline nonIdle=${((1 - idle / tot) * 100).toFixed(1)}% program=${((prog / tot) * 100).toFixed(1)}% jsBusy=${(((tot - idle - prog) / tot) * 100).toFixed(1)}%`)
console.log(`  derived-family=${sum(/railMemoFor|summarizeTurnForRail|summarizeAssistantForRail|stripMarkdown|truncate|turnPreview|previewText|buildStreamViewItems/).toFixed(3)}s`)
console.log(`  shiki=${sum(/findNextMatchSync|#execCore|codeToHtml|shiki_core|collectExternalReferences/).toFixed(3)}s`)
console.log(`  EdgeFade.sync=${sum(/^sync @ EdgeFade/).toFixed(3)}s  scrollTo=${sum(/^scrollTo @ /).toFixed(3)}s`)
console.log(`  flushJobs=${inc(/flushJobs/).toFixed(2)}s  componentUpdateFn=${inc(/componentUpdateFn/).toFixed(2)}s  renderMarkdown=${inc(/renderMarkdown/).toFixed(2)}s  DOMPurify=${inc(/DOMPurify\.sanitize/).toFixed(2)}s`)
console.log(`  UserBubble=${inc(/UserBubble/).toFixed(3)}s  TurnSummary=${inc(/TurnSummary/).toFixed(3)}s  MessageStream=${inc(/MessageStream/).toFixed(3)}s`)
