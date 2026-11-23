#!/usr/bin/env node
/**
 * 批2 真机探针 T5：强制布局 self-time 阈值断言（b-layout：EdgeFade IO 哨兵消除 scroll 回调
 * 的 scrollTop 强制布局读；跟底 gap 修复减少滚动 churn）。
 *
 * 前置（验收流程保证，探针不起实例）：dev 实例运行中（faux 长流式），session 已建；
 *   --baseline 为只读基线 cpuprofile（流式窗 +10..+73s）。
 *
 * 形态：node probes/perf-forced-layout.mjs --data-dir <dir> --sid <sid> --baseline <cpuprofile>
 *        [--cdp-port 9478] [--window-ms 80000] [--text <prompt>] [--save <path>]
 *
 * 动作：采 after profile → 对强制布局族算 after self-time → 同函数对基线窗复算 → 比值断言。
 *
 * 强制布局族（self-time）：
 *   - EdgeFade.vue 任意帧（baseline = sync 读 scrollTop 的 2.5ms/次强制同步布局；IO 哨兵化后
 *     该几何读消失，self-time 应归零）；
 *   - scrollTo（原生滚动前强制布局，gap 修复减少滚动 churn 后次数下降）。
 * self-time ≈ 次数 × 单次成本；成本恒定下 self-time 下降 ∝ 强制布局次数下降。
 *
 * 输出：每函数 forced-layout <fn>: after=<s>s baseline=<s>s；汇总行；
 *       末行 RESULT forced-layout PASS|FAIL。exit 0/1；测量无效 exit 3。
 */
import fs from 'node:fs'
import { captureStreamingProfile, selfTimeByLabel, windowStats, parseFlags } from './lib/harness.mjs'

const flags = parseFlags()
const dataDir = flags['data-dir']
const sid = flags.sid
const baselinePath = flags.baseline
const cdpPort = Number(flags['cdp-port'] ?? 9478)
const windowMs = Number(flags['window-ms'] ?? 80000)
const prompt = flags.text ?? '请给出性能优化实施方案'
const savePath = flags.save // 默认不 save（T2 已存 after profile，避免重复落盘）

if (!dataDir || !sid || !baselinePath) {
  console.error('usage: node probes/perf-forced-layout.mjs --data-dir <dir> --sid <sid> --baseline <cpuprofile> [--cdp-port 9478] [--window-ms 80000] [--save <path>]')
  process.exit(2)
}

// 强制布局族：EdgeFade.vue 任意帧 + 原生 scrollTo。label = `<fn> @ <url末段>:<line+1>`。
const FAMILY = [
  { name: 'EdgeFade', re: / @ EdgeFade\.vue:\d+$/ },
  { name: 'scrollTo', re: /^scrollTo @ / },
]
const BASELINE_FROM_S = 10
const BASELINE_TO_S = 73
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0)

const { profile, relFromS, relToS, sampledS } = await captureStreamingProfile({
  dataDir, sid, cdpPort, prompt, windowMs, savePath,
})

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
const baselineStats = windowStats(baseline, BASELINE_FROM_S, BASELINE_TO_S)
if (baselineStats.sampledS <= 0) {
  console.error(`[probe] 基线无效：${baselinePath} 在 +${BASELINE_FROM_S}s..+${BASELINE_TO_S}s 窗无采样——无法判定`)
  process.exit(3)
}

const after = new Map()
const base = new Map()
for (const f of FAMILY) {
  after.set(f.name, sum(selfTimeByLabel(profile, relFromS, relToS, f.re)))
  base.set(f.name, sum(selfTimeByLabel(baseline, BASELINE_FROM_S, BASELINE_TO_S, f.re)))
}
for (const f of FAMILY) {
  console.log(`forced-layout ${f.name}: after=${after.get(f.name).toFixed(3)}s baseline=${base.get(f.name).toFixed(3)}s`)
}

const afterTotal = FAMILY.reduce((a, f) => a + after.get(f.name), 0)
const baseTotal = FAMILY.reduce((a, f) => a + base.get(f.name), 0)
if (baseTotal <= 0) {
  console.error(`[probe] 基线无效：强制布局族在基线窗 self-time=0.000s——拒绝判定（否则空数据 PASS）`)
  process.exit(3)
}
const ratio = afterTotal / baseTotal
console.log(`forced-layout EdgeFade+scrollTo: after=${afterTotal.toFixed(3)}s baseline=${baseTotal.toFixed(3)}s ratio=${ratio.toFixed(3)} (after window ${sampledS.toFixed(1)}s / baseline window ${baselineStats.sampledS.toFixed(1)}s)`)

// 阈值 0.8：EdgeFade（baseline 主要项，IO 哨兵后归零）单项即贡献 ~28% 降幅；跟底 gap 修复
// 进一步削减 scrollTo churn。after 窗与基线窗不对齐留裕度，0.8 为宽松下限。
const pass = afterTotal < baseTotal * 0.8
console.log(`RESULT forced-layout ${pass ? 'PASS' : `FAIL ratio=${ratio.toFixed(3)}`}`)
process.exit(pass ? 0 : 1)
