#!/usr/bin/env node
/**
 * 批2 真机探针 T2：组件 render inclusive 成本阈值断言（b-props：turn.user 稳定引用 +
 * shouldUpdateComponent 跳过，UserBubble/TurnSummary 流式期不再重渲染）。
 *
 * 前置（由验收流程保证，探针不负责起实例）：
 *   - dev 实例已按 verify-taiji 技能启动（faux 长流式），session 已建；
 *   - --data-dir 指向该实例数据目录；--sid 为待测 session；
 *   - --baseline 为只读基线 cpuprofile（流式窗 +10..+73s）。
 *
 * 形态：node scripts/perf-probes/perf-component-render.mjs --data-dir <dir> --sid <sid> --baseline <cpuprofile>
 *        [--cdp-port 9478] [--window-ms 80000] [--text <prompt>] [--save <path>]
 *
 * 动作：harness captureStreamingProfile 采 after profile（CDP Profiler，无 tracing）
 *       → 对 5 个组件各算 after inclusive → 同函数对基线流式窗（+10..+73s）复算 → 比值断言。
 *
 * inclusive = 沿 parent 链上行、每样本对匹配 label 去重、累加 timeDeltas（= 该组件渲染子树总耗时）。
 * label 形如 `_sfc_render @ UserBubble.vue:NNN`；按 url 末段精确匹配，避免 Turn.vue 误伤
 * TurnSummary.vue / TurnMeta 等同前缀文件。
 *
 * 输出：每组件一行 component <Name>: after=<s>s (window <s>s) baseline=<s>s (window <s>s)；
 *       汇总行 component-render UserBubble+TurnSummary: after=<s>s baseline=<s>s ratio=<x>；
 *       末行 RESULT component-render PASS|FAIL。exit 0/1；测量无效 exit 3。
 */
import fs from 'node:fs'
import {
  captureStreamingProfile, inclusiveByLabel, parseFlags, windowStats,
} from './lib/harness.mjs'

const flags = parseFlags()
const dataDir = flags['data-dir']
const sid = flags.sid
const baselinePath = flags.baseline
const cdpPort = Number(flags['cdp-port'] ?? 9478)
const windowMs = Number(flags['window-ms'] ?? 80000)
const prompt = flags.text ?? '请给出性能优化实施方案'
const savePath = flags.save ?? '.run/b2-after-renderer.cpuprofile'

if (!dataDir || !sid || !baselinePath) {
  console.error('usage: node scripts/perf-probes/perf-component-render.mjs --data-dir <dir> --sid <sid> --baseline <cpuprofile> [--cdp-port 9478] [--window-ms 80000] [--text <prompt>] [--save <path>]')
  process.exit(2)
}

// ── 组件族：url 末段精确匹配（Turn.vue 不可写成 /Turn/ 前缀，会吞 TurnSummary.vue）──────
const COMPONENTS = [
  { name: 'UserBubble', re: / @ UserBubble\.vue:\d+$/ },
  { name: 'TurnSummary', re: / @ TurnSummary\.vue:\d+$/ },
  { name: 'Turn', re: / @ Turn\.vue:\d+$/ },
  { name: 'MarkdownRenderer', re: / @ MarkdownRenderer\.vue:\d+$/ },
  { name: 'MessageStream', re: / @ MessageStream\.vue:\d+$/ },
]
/** 断言族 = 流式期每 token 都该被跳过的两个组件（稳定引用 props 的收益主体）。 */
const ASSERT_FAMILY = ['UserBubble', 'TurnSummary']

/** 基线流式窗（run-notrace 已知流式窗，硬编码）：基线是一次性归档探针，窗由其自身 run 决定，
 *  与 after 侧窗（自发送时刻起算）不可能字节对齐，故不试图推导、按已知窗复算保证可比。 */
const BASELINE_FROM_S = 10
const BASELINE_TO_S = 73

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0)

// ── after 侧采集 ─────────────────────────────────────────────────────────────
const { profile, relFromS, relToS, sampledS } = await captureStreamingProfile({
  dataDir, sid, cdpPort, prompt, windowMs, savePath,
})

// ── 基线侧离线复算（只读归档，不重测）────────────────────────────────────────
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
const baselineStats = windowStats(baseline, BASELINE_FROM_S, BASELINE_TO_S)
if (baselineStats.sampledS <= 0) {
  console.error(`[probe] 基线无效：${baselinePath} 在 +${BASELINE_FROM_S}s..+${BASELINE_TO_S}s 窗无采样——无法判定`)
  process.exit(3)
}

const after = new Map()
const base = new Map()
for (const c of COMPONENTS) {
  after.set(c.name, sum(inclusiveByLabel(profile, relFromS, relToS, c.re)))
  base.set(c.name, sum(inclusiveByLabel(baseline, BASELINE_FROM_S, BASELINE_TO_S, c.re)))
}

for (const c of COMPONENTS) {
  console.log(`component ${c.name}: after=${after.get(c.name).toFixed(3)}s (window ${sampledS.toFixed(1)}s) baseline=${base.get(c.name).toFixed(3)}s (window ${baselineStats.sampledS.toFixed(1)}s)`)
}

const afterFamily = ASSERT_FAMILY.reduce((a, n) => a + after.get(n), 0)
const baseFamily = ASSERT_FAMILY.reduce((a, n) => a + base.get(n), 0)
if (baseFamily <= 0) {
  console.error(`[probe] 基线无效：${ASSERT_FAMILY.join('+')} 在基线流式窗 inclusive=0.000s——基线未覆盖流式窗，拒绝判定（否则空数据 PASS）`)
  process.exit(3)
}
const ratio = afterFamily / baseFamily
console.log(`component-render ${ASSERT_FAMILY.join('+')}: after=${afterFamily.toFixed(3)}s baseline=${baseFamily.toFixed(3)}s ratio=${ratio.toFixed(3)}`)

// 阈值取 1/2（而非更紧）：after 窗与基线窗不可能字节对齐（采集起点/时长/负载均有差），
// 留窗口差异裕度；稳定引用 props 应让 shouldUpdateComponent 整体跳过这两个组件，
// 期望 after 远小于基线，故 0.5 是宽松下限而非收益预期。
const pass = afterFamily < baseFamily * 0.5
console.log(`RESULT component-render ${pass ? 'PASS' : `FAIL ratio=${ratio.toFixed(3)}`}`)
process.exit(pass ? 0 : 1)
