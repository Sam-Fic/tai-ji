#!/usr/bin/env node
/**
 * 批5 CPU 分析：从 perf-clean-cpu.mjs 落盘的三进程 profile + metrics 复算对比表（零依赖）。
 *
 * 口径纪律：
 *   ① 窗口 = 各 run 自己的 `*-env.json` 的 `rendererWindow`（send 相对窗，由探针记录），
 *      不手写数字——跨运行窗长不同（48–64s），任何固定窗口都会引入偏差；
 *   ② self-time = 采样落点帧；inclusive = 沿 parent 链上行（一栈内同一匹配帧只计一次），
 *      与 probes/lib/harness.mjs 同源实装（批1-4 口径）；
 *   ③ **(program) 交叉验证**：V8 profile 的 non-idle 占比 vs CDP `Performance.getMetrics`
 *      的 TaskDuration / wall——两者对齐（±2pp）才说明「非 idle 时间」口径可信、且
 *      (program) 不是 profile 的伪影（首轮报告未做此验证，13.1s 未归因）；
 *   ④ 函数名依赖 `--minify false` 的 production bundle（minified 产物名被 mangle，见
 *      docs/perf/final-measurement/build-probe-grep.txt）。
 *
 * 用法：node probes/analyze-clean-cpu.mjs <tag>=<dir> [<tag>=<dir> ...]
 *   例：node probes/analyze-clean-cpu.mjs baseline=docs/perf/final-measurement final=docs/perf/final-measurement
 * 输出：人读表 + （--json 时）机器可读 JSON
 */
import fs from 'node:fs'
import path from 'node:path'

import { selfTimeByLabel, inclusiveByLabel } from './lib/harness.mjs'

const FAMILY = /railMemoFor|summarizeTurnForRail|summarizeAssistantForRail|stripMarkdown|truncate|turnPreview|previewText|buildStreamViewItems/
const MARKDOWN_SCAN = /scanMarkdownBlocks|closesFence/
const SHIKI = /findNextMatchSync|#execCore|codeToHtml|shiki_core|collectExternalReferences/
const SCROLL = /^scrollTo/

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sumMap (m) {
  let s = 0
  for (const [, v] of m) s += v
  return s
}

function analyse (dir, tag) {
  const env = readJson(path.join(dir, `${tag}-env.json`))
  const profile = readJson(path.join(dir, `${tag}-renderer.cpuprofile`))
  const metrics = readJson(path.join(dir, `${tag}-metrics.json`))
  const w = env.rendererWindow
  const from = w.relFromS
  const to = w.relToS
  const wall = to - from

  const all = selfTimeByLabel(profile, from, to, /.*/)
  let idle = 0
  let program = 0
  let sampled = 0
  for (const [label, v] of all) {
    sampled += v
    if (label.startsWith('(idle)')) idle += v
    if (label.startsWith('(program)')) program += v
  }

  const self = (re) => sumMap(selfTimeByLabel(profile, from, to, re))
  const incl = (re) => sumMap(inclusiveByLabel(profile, from, to, re))

  const s = metrics.samples
  const delta = (k) => (s.length > 1 ? (s[s.length - 1][k] ?? 0) - (s[0][k] ?? 0) : 0)

  const nonIdle = 1 - idle / sampled
  const taskRatio = delta('TaskDuration') / wall
  return {
    tag,
    dir,
    head: env.head,
    load1m: env.load?.m1 ?? null,
    fixture: env.fixture?.path ?? null,
    wall,
    sampled,
    idle,
    program,
    jsBusy: sampled - idle - program,
    nonIdlePct: nonIdle * 100,
    programPct: (program / sampled) * 100,
    jsBusyPct: ((sampled - idle - program) / sampled) * 100,
    familyS: self(FAMILY),
    markdownScanS: self(MARKDOWN_SCAN),
    shikiS: self(SHIKI),
    scrollS: self(SCROLL),
    patchInclS: incl(/^patch$/),
    flushJobsInclS: incl(/flushJobs/),
    componentUpdateInclS: incl(/componentUpdateFn/),
    dompurifyInclS: incl(/DOMPurify\.sanitize/),
    renderMarkdownInclS: incl(/renderMarkdown/),
    userBubbleInclS: incl(/UserBubble/),
    turnSummaryInclS: incl(/TurnSummary/),
    messageStreamInclS: incl(/MessageStream/),
    metrics: {
      samples: s.length,
      task: delta('TaskDuration'),
      script: delta('ScriptDuration'),
      layout: delta('LayoutDuration'),
      style: delta('RecalcStyleDuration'),
      taskRatioPct: taskRatio * 100
    },
    xvalGapPp: (nonIdle - taskRatio) * 100
  }
}

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const rows = argv
  .filter((a) => !a.startsWith('--'))
  .map((spec) => {
    const i = spec.indexOf('=')
    return analyse(spec.slice(i + 1), spec.slice(0, i))
  })

if (asJson) {
  console.log(JSON.stringify(rows, null, 1))
} else {
  const pct = (v, wall) => `${v.toFixed(3)}s (${((v / wall) * 100).toFixed(2)}%)`
  console.log('tag'.padEnd(14) + 'wall   load  ' + 'nonIdle   (program)  JSbusy  |  派生族        markdown扫描   shiki         scrollTo      |  ' + 'patch        flushJobs    compUpdateFn  DOMPurify    renderMarkdown')
  for (const r of rows) {
    console.log(
      r.tag.padEnd(14) +
      `${r.wall.toFixed(1)}s  ${String(r.load1m).padEnd(4)}  ` +
      `${r.nonIdlePct.toFixed(1)}%    ${r.programPct.toFixed(1)}%     ${r.jsBusyPct.toFixed(1)}%  |  ` +
      `${pct(r.familyS, r.wall).padEnd(14)}${pct(r.markdownScanS, r.wall).padEnd(14)}${pct(r.shikiS, r.wall).padEnd(14)}${pct(r.scrollS, r.wall).padEnd(14)}|  ` +
      `${pct(r.patchInclS, r.wall).padEnd(13)}${pct(r.flushJobsInclS, r.wall).padEnd(13)}` +
      `${pct(r.componentUpdateInclS, r.wall).padEnd(14)}${pct(r.dompurifyInclS, r.wall).padEnd(13)}${pct(r.renderMarkdownInclS, r.wall)}`
    )
  }
  console.log('\n(program) 交叉验证（V8 profile non-idle vs CDP TaskDuration/wall）：')
  for (const r of rows) {
    console.log(`  ${r.tag.padEnd(14)} profile=${r.nonIdlePct.toFixed(1)}%  metrics Task=${r.metrics.task.toFixed(1)}s → ${r.metrics.taskRatioPct.toFixed(1)}%   Δ=${r.xvalGapPp >= 0 ? '+' : ''}${r.xvalGapPp.toFixed(1)}pp  (metrics 采样 ${r.metrics.samples} 次)`)
  }
  console.log('\nCDP metrics 明细（窗内增量）：')
  for (const r of rows) {
    console.log(`  ${r.tag.padEnd(14)} Task=${r.metrics.task.toFixed(2)}s Script=${r.metrics.script.toFixed(2)}s Layout=${r.metrics.layout.toFixed(2)}s Style=${r.metrics.style.toFixed(2)}s`)
  }
  console.log('\n组件 inclusive：')
  for (const r of rows) {
    console.log(`  ${r.tag.padEnd(14)} UserBubble=${r.userBubbleInclS.toFixed(3)}s TurnSummary=${r.turnSummaryInclS.toFixed(3)}s MessageStream=${r.messageStreamInclS.toFixed(3)}s`)
  }
}
