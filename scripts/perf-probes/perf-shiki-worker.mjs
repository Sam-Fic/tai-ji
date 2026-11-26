#!/usr/bin/env node
/**
 * 批3 真机探针 T1：fence 闭合窗口主线程 shiki self-time 归零断言（Worker 化验收）。
 *
 * 前置（由验收流程保证，探针不负责起实例）：
 *   - dev 实例已按 verify-taiji 技能启动（faux 72KB 脚本，200TPS），session 已建；
 *   - --data-dir 指向该实例数据目录；--sid 为待测 session。
 *
 * 形态：node scripts/perf-probes/perf-shiki-worker.mjs --data-dir <dir> --sid <sid> [--threshold-s 0.3]
 *       [--timeout-ms 240000] [--save <profile>]
 *
 * 动作：CDP Profiler（无 tracing）+ console 采集 → delivery.submit 发 prompt →
 *       等 message.complete（显式预算）→ 轮询等高亮落 DOM（worker 异步回填可晚于
 *       complete——流水线设计使然，轮询预算内等待）→ Profiler.stop → 双口径聚合
 *       shiki 族 self-time：① 整条流式窗（send→profiler stop）；② fence 闭合窗口
 *       （pre.shiki 首次出现的墙钟 ±窗）。
 *       在场有效性双断言：高亮确实发生（DOM pre.shiki 带 --shiki-dark span）+ worker 成本日志在场。
 *
 * 输出末行：RESULT shiki-family-self-time=<s> threshold=<s> PASS|FAIL；exit 0/1。
 * 附打印 worker-init-ms / worker-job-ms 行（成本登记用）。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  connectRuntime,
  connectRendererCdp,
  ensureGuiOnSession,
  waitForSessionComplete,
  collectConsoleMessages,
  selfTimeByLabel,
  windowStats,
  sleep,
} from './lib/harness.mjs'

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}

const dataDir = path.resolve(arg('data-dir', ''))
const sid = arg('sid', '')
const thresholdS = Number(arg('threshold-s', '0.3'))
const timeoutMs = Number(arg('timeout-ms', '240000'))
const prompt = arg('text', '请给出性能优化实施方案')
const savePath = arg('save', '')

if (!dataDir || !sid) {
  console.error('usage: node scripts/perf-probes/perf-shiki-worker.mjs --data-dir <dir> --sid <sid> [--threshold-s 0.3] [--timeout-ms 240000] [--save <profile>]')
  process.exit(2)
}

// shiki 族 = 高亮相关全部主线程帧（函数名或所在文件命中）。
// 覆盖基线突发的 findNextMatchSync / #execCore / shiki_core / RegExp: shiki 规则 /
// collectExternalReferences*，以及主线程回退路径上的 createHighlighterCore /
// codeToHtml / getLoadedLanguages（dev 下 shiki 相关模块 URL 或文件名含 shiki）。
const SHIKI_FAMILY_RE = /findNextMatchSync|#execCore|codeToHtml|shiki|collectExternalReferences|Oniguruma|createJavaScriptRegexEngine|tokenizeAnsiWithTheme/i

const rt = await connectRuntime(dataDir)
const cdp = await connectRendererCdp(Number(arg('cdp-port', '9478')))
console.log('[probe] connected runtime + renderer CDP')
const consoleMessages = await collectConsoleMessages(cdp)
await cdp.send('Page.enable')

// 刷新页面拿全新客户端状态：worker 客户端 degraded 是页生命周期永久的（T3 降级探针
// 打过桩后，同页面后续渲染全部落主线程回退 → shiki self-time 反弹 → 误报「冻结仍在」）。
// 刷新在 Profiler.start 之前，测量窗只含本次流式。
await cdp.send('Page.reload')
console.log('[probe] page reloaded (fresh client state)')
const readyDeadline = Date.now() + 60000
let ready = false
while (Date.now() < readyDeadline) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `document.querySelectorAll('.session-item').length > 0`,
    returnByValue: true,
  })
  if (r.result?.value === true) { ready = true; break }
  await sleep(500)
}
if (!ready) {
  console.error('[probe] 页面刷新后 app 未就绪（60s 预算内未见侧栏）——弃测')
  cdp.close()
  rt.ws.close()
  process.exit(3)
}
console.log('[probe] app ready after reload')

await cdp.send('Profiler.enable')
await cdp.send('Profiler.start')
const profilerStartWall = Date.now()
console.log('[probe] profiler started, sending prompt...')

const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
const sendWall = Date.now()
console.log('[probe] prompt submitted, streaming window running...')

await ensureGuiOnSession(cdp, sid)

// ① 等流式结束（先等 complete：closure 轮询若先烧完预算，complete 帧已过扫描游标 → 误弃测）
const endFrame = await waitForSessionComplete(rt, sid, Math.max(1000, timeoutMs - (Date.now() - sendWall)))
if (!endFrame) {
  console.error('[probe] 流式未在显式预算内完成——弃测（不产 PASS/FAIL，不杀任何进程）')
  cdp.close()
  rt.ws.close()
  process.exit(3)
}
const completeWall = Date.now()
console.log(`[probe] stream complete: ${endFrame.type} (${((completeWall - sendWall) / 1000).toFixed(1)}s after send)`)

// ② 轮询等高亮落 DOM：worker 异步回填可晚于 complete（流水线设计使然），轮询预算内等待。
//    fixture 全文仅一个代码块 → pre.shiki 首现即 fence 闭合 + 高亮回填的墙钟。
let fenceClosureWall = null
let dom = { shikiPre: 0, shikiSpans: 0, codeChars: 0, sid: '', ph: 0 }
const hlDeadline = Date.now() + 120000
let hlPolls = 0
while (Date.now() < hlDeadline) {
  hlPolls++
  const r = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      sid: document.querySelector('[data-session-id]')?.getAttribute('data-session-id') || '',
      shikiPre: document.querySelectorAll('pre.shiki').length,
      shikiSpans: document.querySelectorAll('pre.shiki [style*="--shiki-dark"]').length,
      codeChars: (document.querySelector('pre.shiki')?.textContent ?? '').length,
      ph: document.querySelectorAll('[data-testid="md-streaming-fence"]').length,
    })`,
    returnByValue: true,
  })
  dom = JSON.parse(r.result?.value ?? '{}')
  if (dom.shikiSpans >= 1) { fenceClosureWall = Date.now(); break }
  if (hlPolls % 10 === 1) console.log(`[probe] highlight poll #${hlPolls}: ${JSON.stringify(dom)}`)
  await sleep(500)
}
console.log(`[probe] DOM presence: pre.shiki=${dom.shikiPre} spans=${dom.shikiSpans} codeChars=${dom.codeChars} (polls=${hlPolls})`)
// 在场有效性断言（防「0 因为什么都没渲染」假 PASS）
const presenceOk = dom.shikiPre >= 1 && dom.shikiSpans >= 1 && dom.codeChars > 1000
if (!presenceOk) {
  console.error('[probe] 在场有效性失败：轮询预算内未见高亮代码块（pre.shiki 缺失或无 token span）——拒绝判定')
  cdp.close()
  rt.ws.close()
  process.exit(3)
}
if (fenceClosureWall !== null) {
  console.log(`[probe] fence highlight applied at ${((fenceClosureWall - sendWall) / 1000).toFixed(1)}s after send`)
}

const stopped = await cdp.send('Profiler.stop')
const profile = stopped.profile
cdp.close()
rt.ws.close()
console.log(`[probe] profile captured: ${profile.samples.length} samples`)

const relFromS = (sendWall - profilerStartWall) / 1000
const relToS = (Date.now() - profilerStartWall) / 1000
console.log(`[probe] streaming window ${relFromS.toFixed(1)}s..${relToS.toFixed(1)}s (send-relative, until profiler stop)`)
if (fenceClosureWall !== null) {
  console.log(`[probe] fence closure at ${((fenceClosureWall - profilerStartWall) / 1000).toFixed(1)}s after profiler start`)
}

// 测量有效性：采样量 + 窗内渲染活动（同 harness captureStreamingProfile 口径）
const { sampledS, nonIdleRatio } = windowStats(profile, relFromS, relToS)
const spanS = relToS - relFromS
const sampledOk = sampledS >= spanS * 0.5
const activeOk = nonIdleRatio >= 0.02
if (!sampledOk || !activeOk) {
  console.error(`[probe] 测量无效：sampled=${sampledS.toFixed(1)}s（需 ≥${(spanS * 0.5).toFixed(1)}s）nonIdle=${(nonIdleRatio * 100).toFixed(1)}%（需 ≥2%）——拒绝判定`)
  process.exit(3)
}
console.log(`[probe] measurement valid: sampled=${sampledS.toFixed(1)}s nonIdle=${(nonIdleRatio * 100).toFixed(1)}%`)

// shiki 族 self-time：整条流式窗 + fence 闭合窗口（±5s，墙钟转 profile 相对）
const whole = sumMap(selfTimeByLabel(profile, relFromS, relToS, SHIKI_FAMILY_RE))
const detail = selfTimeByLabel(profile, relFromS, relToS, SHIKI_FAMILY_RE)
let closureS = null
if (fenceClosureWall !== null) {
  const cRel = (fenceClosureWall - profilerStartWall) / 1000
  const from = Math.max(relFromS, cRel - 5)
  const to = Math.min(relToS, cRel + 5)
  closureS = sumMap(selfTimeByLabel(profile, from, to, SHIKI_FAMILY_RE))
  console.log(`[probe] fence-closure window ${from.toFixed(1)}s..${to.toFixed(1)}s shiki-family self-time=${closureS.toFixed(3)}s`)
}
const topShiki = [...detail.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
console.log(`[probe] shiki-family top frames (whole window): ${topShiki.map(([k, v]) => `${k}=${v.toFixed(3)}s`).join(', ') || '<none>'}`)

// worker 侧成本日志（init / 每 job 耗时）——经 console 转发采集
const workerLogs = consoleMessages.filter((m) => /\[shiki-worker\]/.test(m.text))
for (const m of workerLogs) console.log(`[worker] ${m.text}`)
const initLog = workerLogs.find((m) => /init/.test(m.text))
const jobLogs = workerLogs.filter((m) => /job/.test(m.text))
if (initLog) console.log(`worker-init-ms=${(/init\s+(\d+)ms/.exec(initLog.text) ?? [])[1] ?? '?'}`)
if (jobLogs.length) {
  const total = jobLogs.reduce((a, m) => a + Number((/job\s+\d+\s+\([^)]*\)\s+(\d+)ms/.exec(m.text) ?? [])[1] ?? 0), 0)
  console.log(`worker-job-ms=${total} (jobs=${jobLogs.length})`)
}

// 断言：主线程 shiki 族 self-time 低于阈值
const pass = whole < thresholdS
console.log(`RESULT shiki-family-self-time=${whole.toFixed(3)}s threshold=${thresholdS}s window=${relFromS.toFixed(1)}..${relToS.toFixed(1)}s sampled=${sampledS.toFixed(1)}s ${pass ? 'PASS' : 'FAIL'}`)

if (savePath && pass) {
  fs.mkdirSync(path.dirname(savePath), { recursive: true })
  fs.writeFileSync(savePath, JSON.stringify(profile))
  console.log(`[probe] profile saved -> ${savePath}`)
}
process.exit(pass ? 0 : 1)

function sumMap(map) {
  let s = 0
  for (const v of map.values()) s += v
  return s
}
