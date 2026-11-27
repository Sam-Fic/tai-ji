#!/usr/bin/env node
/**
 * 批1 真机探针 T1：流式窗派生族成本阈值断言。
 *
 * 前置（由验收流程保证，探针不负责起实例）：
 *   - dev 实例已按 verify-taiji 技能启动（faux 72KB 脚本，200TPS），session 已建；
 *   - --data-dir 指向该实例数据目录；--sid 为待测 session。
 *
 * 形态：node scripts/perf-probes/perf-derivatives.mjs --data-dir <dir> --sid <sid> [--threshold-s 0.3] [--window-ms 80000] [--cdp-port 9478]
 *
 * 动作：CDP Profiler（无 tracing）→ delivery.submit 发 prompt → 窗口等待 → Profiler.stop
 *       → 在流式窗（send 时刻起）聚合派生族 self-time → 阈值断言。
 *
 * 派生族 = railMemoFor 链（summarizeTurnForRail/summarizeAssistantForRail/stripMarkdown/truncate）
 *          + turnPreview/previewText + buildStreamViewItems。
 *
 * 输出末行：RESULT deriv-family-self-time=<s> threshold=<s> PASS|FAIL；exit 0/1。
 */
import fs from 'node:fs'
import path from 'node:path'

// 连接与 GUI 校验原语单源（branch-review dmg-r1-4 收编：本文件曾是参照实装，共享化后回改为
// 消费方，消除 connect 第三份拷贝；拒绝纪律见 lib/harness.mjs 头注）。
import { connectRuntime, connectRendererCdp, ensureGuiOnSession } from './lib/harness.mjs'

function arg (name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}

const dataDir = path.resolve(arg('data-dir', ''))
const sid = arg('sid', '')
const thresholdS = Number(arg('threshold-s', '0.3'))
const windowMs = Number(arg('window-ms', '80000'))
const cdpPort = Number(arg('cdp-port', '9478'))
const prompt = arg('text', '请给出性能优化实施方案')
const savePath = arg('save', '')

if (!dataDir || !sid) {
  console.error('usage: node scripts/perf-probes/perf-derivatives.mjs --data-dir <dir> --sid <sid> [--threshold-s 0.3] [--window-ms 80000] [--cdp-port 9478]')
  process.exit(2)
}

// ── 派生族匹配 ────────────────────────────────────────────────────────────
const FAMILY = [
  { name: 'railMemoFor', any: true },
  { name: 'summarizeTurnForRail', any: true },
  { name: 'summarizeAssistantForRail', any: true },
  { name: 'stripMarkdown', any: true },
  { name: 'truncate', any: true },
  { name: 'previewText', any: true },
  { name: 'turnPreview', any: true },
  { name: 'buildStreamViewItems', any: true },
]

/** 全量采样起点表（ms）：samples[i] 的起始时刻 = 累加 timeDeltas。 */
function sampleStarts(profile) {
  const st = profile.startTime / 1000
  const starts = new Array(profile.samples.length)
  let acc = st
  for (let i = 0; i < profile.timeDeltas.length; i++) { starts[i] = acc; acc += profile.timeDeltas[i] / 1000 }
  return { starts, st }
}

/** 窗口内采样聚合：node → 合计 timeDeltas（µs）；返回 [node, delta] 对（窗口过滤后）。 */
function windowedSamplePairs(profile, starts, fromMs, toMs) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const pairs = []
  let total = 0
  for (let i = 0; i < profile.samples.length; i++) {
    if (starts[i] < fromMs || starts[i] >= toMs) continue
    const node = byId.get(profile.samples[i])
    if (!node) continue
    total += profile.timeDeltas[i]
    pairs.push([node, profile.timeDeltas[i]])
  }
  return { pairs, total }
}

/** callFrame 的归组 key（函数名 + URL 文件名 [+ 行号]）。 */
function frameKey(cf, withLine) {
  const url = (cf.url || '').replace(/^.*\//, '')
  const name = cf.functionName || '(anonymous)'
  return withLine ? `${name} @ ${url}:${cf.lineNumber}` : `${name} @ ${url}`
}

function analyze (profile, relFromS, relToS) {
  const { starts, st } = sampleStarts(profile)
  const fromMs = st + relFromS * 1000
  const toMs = st + relToS * 1000
  const { pairs, total } = windowedSamplePairs(profile, starts, fromMs, toMs)

  const selfUs = new Map()
  for (const [node, delta] of pairs) {
    const cf = node.callFrame
    for (const f of FAMILY) {
      if ((cf.functionName || '') === f.name) {
        const key = frameKey(cf, false)
        selfUs.set(key, (selfUs.get(key) ?? 0) + delta)
      }
    }
  }

  const top10All = new Map()
  for (const [node, delta] of pairs) {
    const key = frameKey(node.callFrame, true)
    top10All.set(key, (top10All.get(key) ?? 0) + delta)
  }
  return { selfUs, totalMs: total / 1000, top10: top10All }
}
// ── 主流程 ────────────────────────────────────────────────────────────────
const rt = await connectRuntime(dataDir)
const cdp = await connectRendererCdp(cdpPort)
console.log('[probe] connected runtime + renderer CDP')

await cdp.send('Profiler.enable')
await cdp.send('Profiler.start')
const profilerStartWall = Date.now()
console.log('[probe] profiler started, sending prompt...')

const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
const sendWall = Date.now()
console.log('[probe] prompt submitted, streaming window running...')

// ── GUI 在场校验（P4-1/P5-3：否则「没测到东西」也 PASS；单源 ensureGuiOnSession）──
await ensureGuiOnSession(cdp, sid)

await new Promise((r) => setTimeout(r, windowMs))

const stopped = await cdp.send('Profiler.stop')
const profile = stopped.profile
cdp.close()
console.log(`[probe] profile captured: ${profile.samples.length} samples, ${(profile.timeDeltas.reduce((a, b) => a + b, 0) / 1e6).toFixed(1)}s sampled`)

const relFrom = (sendWall - profilerStartWall) / 1000
const relTo = relFrom + windowMs / 1000
const { selfUs, totalMs, top10 } = analyze(profile, relFrom, relTo)
let familyMs = 0
const rows = []
for (const [k, us] of [...selfUs.entries()].sort((a, b) => b[1] - a[1])) {
  familyMs += us / 1000
  rows.push(`${k}=${(us / 1000).toFixed(3)}ms`)
}
console.log(`[probe] streaming window ${relFrom.toFixed(1)}s..${relTo.toFixed(1)}s (sampled ${(totalMs / 1000).toFixed(1)}s)`)
console.log(`[probe] derivative family breakdown: ${rows.join(' ') || '(none)'}`
)
const familyS = familyMs / 1000
// 测量有效性断言（P4-1：只有上界阈值时，「窗内什么都没发生」与「优化生效」同为 0.000s PASS）。
// 判据取两组事实：① 采样量足够（profile 真的在记录）；② 窗内确有渲染活动（非 idle 样本
// 占比下限）——流式期主线程不可能全 idle。
// 单位对齐：top10 的值与 totalMs 同为微秒累计（timeDeltas 单位），勿混 ms/µs
const idleUs = top10.get('(idle) @ :-1') ?? 0
const totalUs = totalMs * 1000
const nonIdleRatio = totalUs > 0 ? 1 - idleUs / totalUs : 0
const sampledOk = totalMs >= windowMs * 0.5
const activeOk = nonIdleRatio >= 0.02
if (!sampledOk || !activeOk) {
  console.error(`[probe] 测量无效：sampled=${(totalMs / 1000).toFixed(1)}s（需 ≥${(windowMs / 2000).toFixed(1)}s）nonIdle=${(nonIdleRatio * 100).toFixed(1)}%（需 ≥2%）——窗内无流式活动，拒绝判定`)
  process.exit(3)
}
console.log(`[probe] measurement valid: sampled=${(totalMs / 1000).toFixed(1)}s nonIdle=${(nonIdleRatio * 100).toFixed(1)}%`)
const pass = familyS <= thresholdS
const top10Rows = [...top10.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .map(([k, us]) => `${k}=${(us / 1e6).toFixed(3)}s`)
console.log('[probe] TOP10 self (window):')
for (const r of top10Rows) console.log(`  ${r}`)
if (savePath) {
  fs.mkdirSync(path.dirname(savePath), { recursive: true })
  fs.writeFileSync(savePath, JSON.stringify(profile))
  console.log(`[probe] profile saved -> ${savePath}`)
}
console.log(`RESULT deriv-family-self-time=${familyS.toFixed(3)}s threshold=${thresholdS}s ${pass ? 'PASS' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
