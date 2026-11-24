#!/usr/bin/env node
/**
 * 批5 报告一致性机器检查（B-final-report 的验收 case）。
 *
 * 为什么需要它：`docs/perf/final-summary.md` 与 `docs/perf/final-comparison.md` 是给人读的
 * 报告，但**引用的数字必须与落盘的分析输出逐项对得上**——否则报告可以随便写。
 * 本脚本做三件事：
 *   ① 结构：两份报告的必备章节/表格在场（缺章节 = 题面要求未交付）；
 *   ② 数字对账：从 `docs/perf/final-measurement/cpu-analysis.txt` 与 `gpu-analysis.txt`
 *      解析出关键数字，断言报告里出现的同一指标数字与之相符（容差 0 — 报告写的是复算值）；
 *   ③ 索引：报告里提到的数据文件真实存在（死链 = 索引不可用）。
 *
 * 用法：node probes/check-final-reports.mjs
 * 输出末行：RESULT final-reports ok=<bool> checks=<n> failed=<n>
 * 退出码：0 全过 / 1 有失败项（打印每条失败原因）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PERF = path.join(REPO_ROOT, 'docs', 'perf')
const MEAS = path.join(PERF, 'final-measurement')

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

const failures = []
let checks = 0
const check = (name, ok, detail = '') => {
  checks++
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

// ── ① 结构 ────────────────────────────────────────────────────────────────
const summary = read(path.join(PERF, 'final-summary.md'))
const comparison = read(path.join(PERF, 'final-comparison.md'))
const decision = read(path.join(PERF, 'gpu-decision.md'))

check('final-summary.md 在场', summary !== null)
check('final-comparison.md 在场', comparison !== null)
check('gpu-decision.md 在场', decision !== null)

if (summary) {
  for (const need of ['累计收益', '归因', '火焰图', '残余风险', '复算命令']) {
    check(`final-summary 含「${need}」`, summary.includes(need))
  }
  for (const need of ['baseline-renderer.folded.txt', 'final-renderer.folded.txt', 'cpu-analysis.txt', 'gpu-analysis.txt']) {
    check(`final-summary 索引含 ${need}`, summary.includes(need))
  }
  check('final-summary 含形态覆盖节', /形态覆盖|补充 fixture/.test(summary))
}

if (comparison) {
  for (const need of ['环境声明', 'renderer 主线程', 'GPU', 'TTFT', '归因', '残余风险', '数据文件索引']) {
    check(`final-comparison 含「${need}」`, comparison.includes(need))
  }
}

if (decision) {
  for (const need of ['GPU-6', 'GPU-7', '不可证', '复算命令']) {
    check(`gpu-decision 含「${need}」`, decision.includes(need))
  }
  // 裁决必须**与测量方向一致**：blur 显著下降 ⇒ GPU-6 只能判「动」；mask 无下降 ⇒ GPU-7 只能判「不动」。
  // 只查字样（/不动/ + /动 ——/）不足以发现被改写成相反结论——实测过。
  const verdictCell = (rowPrefix) => {
    const row = decision.split('\n').find((l) => l.trim().startsWith(rowPrefix))
    if (!row) return null
    const cells = row.split('|').map((c) => c.trim())
    // cells[0] = ''（行首竖线前），cells[1] = 项, cells[2] = 裁决
    return cells[2] ?? null
  }
  const g6 = verdictCell('| **GPU-6')
  const g7 = verdictCell('| **GPU-7')
  check('GPU-6 裁决为「动」（blur 显著）', g6 !== null && g6.startsWith('**动'), `实际裁决列：${g6}`)
  check('GPU-7 裁决为「不动」（mask 测不出）', g7 !== null && g7.startsWith('**不动'), `实际裁决列：${g7}`)
}

// ── ② 数字对账（报告 vs 分析原始输出）────────────────────────────────────
const cpu = read(path.join(MEAS, 'cpu-analysis.txt'))
const gpu = read(path.join(MEAS, 'gpu-analysis.txt'))
check('cpu-analysis.txt 在场', cpu !== null)
check('gpu-analysis.txt 在场', gpu !== null)

/** 从分析输出解析某 tag 行的某指标秒数（形如 `baseline ... 2.068s (3.51%)`）。 */
function parseCpu (tag, index) {
  if (!cpu) return null
  for (const line of cpu.split('\n')) {
    if (!line.startsWith(tag)) continue
    const nums = [...line.matchAll(/(\d+\.\d+)s/g)].map((m) => Number(m[1]))
    return nums[index] ?? null
  }
  return null
}
/** 从 gpu-analysis 表里解析某 label 行的 GPU 忙占比。 */
function parseGpuBusy (label) {
  if (!gpu) return null
  for (const line of gpu.split('\n')) {
    if (!line.trim().startsWith(label)) continue
    const m = /(\d+\.\d+)%/.exec(line)
    if (m) return Number(m[1])
  }
  return null
}

const baseFam = parseCpu('baseline', 1)
const finalFam = parseCpu('final', 1)
check('解析 baseline 派生族秒数', baseFam !== null, String(baseFam))
check('解析 final 派生族秒数', finalFam !== null, String(finalFam))
if (baseFam !== null && finalFam !== null && summary) {
  // 双向钉住：报告必须出现「baseline → final」这一对精确数字（只钉一侧不足以发现篡改——
  // 实测过：把 final 侧改成 9.999s 时，只查 baseline 值的断言仍然 PASS）。
  const pair = `${baseFam.toFixed(3)}s → ${finalFam.toFixed(3)}s`
  check('final-summary 的派生族前后对与解析一致', summary.includes(pair), `expect「${pair}」`)
  // 反向：报告里不得出现「baseline 派 生族」行上的其它 final 值（把 2.068s → X 的行抓出来比对）
  const row = summary.split('\n').find((l) => l.includes(`${baseFam.toFixed(3)}s →`))
  check('final-summary 派生族行的后值唯一且正确', row === undefined || row.includes(finalFam.toFixed(3)), row ? row.slice(0, 120) : 'no row')
}
check('派生族降幅 > 90%（报告结论）', baseFam !== null && finalFam !== null && (1 - finalFam / baseFam) > 0.9, `${baseFam} → ${finalFam}`)

/** 解析 `JSbusy` 列（形如 `20.5%`）——用于报告里「JS busy −X%」的双向对账。 */
function parseJsBusy (tag) {
  if (!cpu) return null
  for (const line of cpu.split('\n')) {
    if (!line.startsWith(tag)) continue
    // 列序：wall load nonIdle (program) JSbusy | … —— 取第 5 个百分数（JSbusy）
    const m = /(\d+\.\d)%\s+(\d+\.\d)%\s+(\d+\.\d)%\s*\|/.exec(line)
    if (m) return Number(m[3])
  }
  return null
}
const baseJs = parseJsBusy('baseline')
const finalJs = parseJsBusy('final')
check('解析 baseline/final 的 JS busy', baseJs !== null && finalJs !== null, `${baseJs} / ${finalJs}`)
if (baseJs !== null && finalJs !== null && summary) {
  const pair = `${baseJs}%→${finalJs}%`
  check('final-summary 的 JS busy 前后对与解析一致', summary.includes(pair), `expect「${pair}」`)
}

const gpuBase = parseGpuBusy('clean-baseline')
const gpuFinalR1 = parseGpuBusy('final-r1')
const gpuFinalR2 = parseGpuBusy('final-r2')
check('解析 clean-baseline GPU 忙占比', gpuBase !== null, String(gpuBase))
check('解析 final 两轮 GPU 忙占比', gpuFinalR1 !== null && gpuFinalR2 !== null, `${gpuFinalR1} / ${gpuFinalR2}`)
if (gpuBase !== null && gpuFinalR1 !== null && gpuFinalR2 !== null) {
  // 断言「GPU 侧无净收益」的结论方向：两轮 final 与 baseline 的差都在 ±3pp
  check('GPU 忙占比差在 ±3pp 内（结论：无净收益）', Math.abs(gpuFinalR1 - gpuBase) <= 3 && Math.abs(gpuFinalR2 - gpuBase) <= 3, `base=${gpuBase} r1=${gpuFinalR1} r2=${gpuFinalR2}`)
}
const noblur = [parseGpuBusy('noblur-r1'), parseGpuBusy('noblur-r2')]
if (gpuFinalR1 !== null && gpuFinalR2 !== null && noblur.every((v) => v !== null)) {
  const blurGainMin = Math.min(gpuFinalR1 - noblur[0], gpuFinalR2 - noblur[1])
  check('no-blur 相对 full 降幅 > 2pp（结论：blur 成本显著）', blurGainMin > 2, `min Δ=${blurGainMin.toFixed(2)}pp`)
}
const nomask = [parseGpuBusy('nomask-r1'), parseGpuBusy('nomask-r2')]
if (gpuFinalR1 !== null && gpuFinalR2 !== null && nomask.every((v) => v !== null)) {
  const maskGain = Math.min(gpuFinalR1 - nomask[0], gpuFinalR2 - nomask[1])
  check('no-mask 无下降（结论：mask 成本测不出）', maskGain <= 0, `Δ=${maskGain.toFixed(2)}pp`)
}

// comparison 里的关键数字同样要钉（否则报告正文可以随便写）
/**
 * 成对钉（强形态）：**每一处**出现 baseline 值的行都必须同时带正确 final 值。
 * 只查「存在某行成对」会被「旧行仍正确 + 新行被改错」骗过（实测过）；逐行约束才能抓单行篡改。
 */
function everyPairLine (doc, baseStr, finalStr) {
  // ① 出现 baseline 值的每一行都必须带正确 final 值；
  // ② 出现 final 值的行数不得少于 baseline 行数（抓「某行被改成错值 → final 行数少一条」）。
  const lines = doc.split('\n')
  const baseLines = lines.filter((l) => l.includes(baseStr))
  const finalLines = lines.filter((l) => l.includes(finalStr))
  if (baseLines.length === 0) return { ok: false, detail: `文档里没有 ${baseStr}` }
  const missing = baseLines.filter((l) => !l.includes(finalStr))
  if (missing.length > 0) return { ok: false, detail: `缺少 ${finalStr} 的行：${missing[0].slice(0, 110)}` }
  if (finalLines.length < baseLines.length) {
    return { ok: false, detail: `含 ${finalStr} 的行（${finalLines.length}）少于含 ${baseStr} 的行（${baseLines.length}）——某行可能被改成错值` }
  }
  return { ok: true, detail: `${baseLines.length} 行成对 / ${finalLines.length} 行含后值` }
}
if (comparison && baseFam !== null && finalFam !== null) {
  // 值必须带 `s` 单位才认（否则「0.059–0.112s」这类区间说明会被当成命中——实测被篡改骗过）
  const r = everyPairLine(comparison, `${baseFam.toFixed(3)}s`, `${finalFam.toFixed(3)}s`)
  check('final-comparison 派生族每处成对', r.ok, r.detail)
}
if (comparison && baseJs !== null && finalJs !== null) {
  const r = everyPairLine(comparison, `${baseJs}%`, `${finalJs}%`)
  check('final-comparison JS busy 每处成对', r.ok, r.detail)
}
if (comparison && gpuBase !== null) {
  check('final-comparison 的 GPU 忙占比基准值在场', comparison.includes(`${gpuBase}%`), `expect ${gpuBase}%`)
}
// 降幅百分比也要与解析值一致（否则「−99.9%」这类夸大数字能混过去）
if (baseFam !== null && finalFam !== null && baseFam > 0) {
  const reduction = (1 - finalFam / baseFam) * 100
  const claimed = `${Math.abs(reduction).toFixed(1)}%`
  for (const [name, doc] of [['final-comparison', comparison], ['final-summary', summary]]) {
    if (!doc) continue
    // 同一份文档里可能有「三列对照行」（脏基线→干净基线→终版，其降幅是另一口径），
    // 因此只要求**存在**一行既含两侧干净值、又含解析出的降幅（逐行取第一个匹配会误判）。
    const lines = doc.split('\n').filter((l) => l.includes(`${baseFam.toFixed(3)}s`) && l.includes(`${finalFam.toFixed(3)}s`))
    check(`${name} 的派生族降幅与解析一致`, lines.some((l) => l.includes(claimed)), `expect ${claimed}（解析 ${reduction.toFixed(2)}%）；含两侧值的行 ${lines.length} 条`)
  }
}

// ── ③ 索引可达性 ──────────────────────────────────────────────────────────
for (const f of [
  'baseline-renderer.cpuprofile', 'baseline-runtime.cpuprofile', 'baseline-pi.cpuprofile',
  'final-renderer.cpuprofile', 'final-runtime.cpuprofile', 'final-pi.cpuprofile',
  'baseline-metrics.json', 'final-metrics.json', 'baseline-env.json', 'final-env.json',
  'baseline-renderer.folded.txt', 'final-renderer.folded.txt',
  'cpu-analysis.txt', 'gpu-analysis.txt', 'build-probe-grep.txt',
  'baseline-midstream.png', 'final-midstream.png',
  'form-fences-env.json', 'form-tools-env.json', 'form-thinking-env.json'
]) {
  check(`归档文件在场 ${f}`, fs.existsSync(path.join(MEAS, f)))
}

const ok = failures.length === 0
for (const f of failures) console.error(`  ✗ ${f}`)
console.log(`RESULT final-reports ok=${ok} checks=${checks} failed=${failures.length}`)
process.exit(ok ? 0 : 1)
