#!/usr/bin/env node
/**
 * 批3 离线复算脚本：cpuprofile 窗内 shiki 族 self-time（前后对比表同口径复算入口）。
 *
 * 形态：node probes/shiki-family.mjs <profile.json> <relFromS> <relToS>
 *
 * 口径与 probes/perf-shiki-worker.mjs 的窗内聚合逐字同源（同一 SHIKI_FAMILY_RE、
 * 同一 selfTimeByLabel）：窗口 = profile 相对秒（timeDeltas 累加），半开区间。
 */
import fs from 'node:fs'
import { selfTimeByLabel } from './lib/harness.mjs'

const [profilePath, fromArg, toArg] = process.argv.slice(2)
if (!profilePath) {
  console.error('usage: node probes/shiki-family.mjs <profile.json> <relFromS> <relToS>')
  process.exit(2)
}
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
const relFromS = Number(fromArg ?? 0)
const relToS = toArg === undefined ? undefined : Number(toArg)

const SHIKI_FAMILY_RE = /findNextMatchSync|#execCore|codeToHtml|shiki|collectExternalReferences|Oniguruma|createJavaScriptRegexEngine|tokenizeAnsiWithTheme/i

const map = selfTimeByLabel(profile, relFromS, relToS, SHIKI_FAMILY_RE)
const rows = [...map.entries()].sort((a, b) => b[1] - a[1])
let total = 0
for (const [, v] of rows) total += v
for (const [k, v] of rows) console.log(`${v.toFixed(3)}s  ${k}`)
console.log(`RESULT shiki-family-self-time=${total.toFixed(3)}s window=${relFromS}..${relToS ?? 'end'} frames=${rows.length}`)
