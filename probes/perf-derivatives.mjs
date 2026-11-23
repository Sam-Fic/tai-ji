#!/usr/bin/env node
/**
 * 批1 真机探针 T1：流式窗派生族成本阈值断言。
 *
 * 前置（由验收流程保证，探针不负责起实例）：
 *   - dev 实例已按 verify-taiji 技能启动（faux 72KB 脚本，200TPS），session 已建；
 *   - --data-dir 指向该实例数据目录；--sid 为待测 session。
 *
 * 形态：node probes/perf-derivatives.mjs --data-dir <dir> --sid <sid> [--threshold-s 0.3] [--window-ms 80000] [--cdp-port 9478]
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
  console.error('usage: node probes/perf-derivatives.mjs --data-dir <dir> --sid <sid> [--threshold-s 0.3] [--window-ms 80000] [--cdp-port 9478]')
  process.exit(2)
}

// ── runtime WS 协议（零依赖，Node ≥22 全局 WebSocket）──────────────────────
const runtimePort = Number(fs.readFileSync(path.join(dataDir, 'runtime.port'), 'utf8').trim())
const token = fs.readFileSync(path.join(dataDir, 'runtime-token'), 'utf8').trim()

function connectRuntime () {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${runtimePort}`)
    let seq = 0
    const pending = new Map()
    const events = []
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(ev.data)
      if (frame.type === 'auth.result') return
      if (frame.id !== undefined && pending.has(frame.id)) {
        const p = pending.get(frame.id)
        pending.delete(frame.id)
        frame.type === 'error' ? p.reject(new Error(JSON.stringify(frame.payload))) : p.resolve(frame.payload)
        return
      }
      events.push(frame)
    })
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
      setTimeout(() => resolve({
        call (type, payload, timeoutMs = 60000) {
          return new Promise((res, rej) => {
            const id = `probe-${++seq}`
            pending.set(id, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id, type, payload }))
            setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`rpc ${type} timeout`)) } }, timeoutMs)
          })
        },
        events,
      }), 300)
    })
    ws.addEventListener('error', () => reject(new Error('runtime ws error')))
    setTimeout(() => reject(new Error('runtime ws open timeout')), 10000)
  })
}

// ── CDP Profiler（renderer target，无 tracing）─────────────────────────────
function connectRendererProfiler () {
  return new Promise((resolve, reject) => {
    fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      .then((r) => r.json())
      .then((list) => {
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (!page) throw new Error('no renderer target')
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        let seq = 0
        const pending = new Map()
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(ev.data)
          if (msg.id !== undefined && pending.has(msg.id)) {
            const p = pending.get(msg.id)
            pending.delete(msg.id)
            msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
          }
        })
        ws.addEventListener('open', () => resolve({
          send (method, params = {}) {
            return new Promise((res, rej) => {
              const id = ++seq
              pending.set(id, { resolve: res, reject: rej })
              ws.send(JSON.stringify({ id, method, params }))
            })
          },
          close: () => ws.close(),
        }))
        ws.addEventListener('error', () => reject(new Error('cdp ws error')))
      })
      .catch(reject)
  })
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

function analyze (profile, relFromS, relToS) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const st = profile.startTime / 1000
  let acc = st
  const starts = new Array(profile.samples.length)
  for (let i = 0; i < profile.timeDeltas.length; i++) { starts[i] = acc; acc += profile.timeDeltas[i] / 1000 }
  const fromMs = st + relFromS * 1000
  const toMs = st + relToS * 1000
  const selfUs = new Map()
  let total = 0
  for (let i = 0; i < profile.samples.length; i++) {
    if (starts[i] < fromMs || starts[i] >= toMs) continue
    const node = byId.get(profile.samples[i])
    if (!node) continue
    total += profile.timeDeltas[i]
    const cf = node.callFrame
    for (const f of FAMILY) {
      if ((cf.functionName || '') === f.name) {
        const key = `${f.name} @ ${(cf.url || '').replace(/^.*\//, '')}`
        selfUs.set(key, (selfUs.get(key) ?? 0) + profile.timeDeltas[i])
      }
    }
  }
  const top10All = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    if (starts[i] < fromMs || starts[i] >= toMs) continue
    const node = byId.get(profile.samples[i])
    if (!node) continue
    const cf = node.callFrame
    const key = `${cf.functionName || '(anonymous)'} @ ${(cf.url || '').replace(/^.*\//, '')}:${cf.lineNumber}`
    top10All.set(key, (top10All.get(key) ?? 0) + profile.timeDeltas[i])
  }
  return { selfUs, totalMs: total / 1000, top10: top10All }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const rt = await connectRuntime()
const cdp = await connectRendererProfiler()
console.log('[probe] connected runtime + renderer CDP')

await cdp.send('Profiler.enable')
await cdp.send('Profiler.start')
const profilerStartWall = Date.now()
console.log('[probe] profiler started, sending prompt...')

const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
const sendWall = Date.now()
console.log('[probe] prompt submitted, streaming window running...')

// ── GUI 在场校验（P4-1/P5-3：否则「没测到东西」也 PASS）──────────────────────
// session.switch RPC 只广播激活信号，renderer 未必真切过去（实测：RPC 成功而
// [data-session-id] 仍指旧 session）。若 GUI 不在目标 session，目标 session 的流式不渲染
// 进任何可见窗 ⇒ 族成本 0 ⇒ 与「优化生效」产出同一行 RESULT PASS。
// 判据 = DOM 事实，不靠时间推测。
await cdp.send('Runtime.enable')
{
  // 轮询而非单次断言：session.switch 的 renderer 生效 + 首帧渲染是异步的，冷启动 GUI
  // 甚至可能还没挂出 [data-session-id]（harvest 首例实测：单次断言拿到空串误判）。
  // 判据仍是 DOM 事实（[data-session-id] === sid），只是给它到达的时间。
  let active = ''
  for (let i = 0; i < 40; i++) {
    const guiSid = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('[data-session-id]')?.getAttribute('data-session-id') || ''`,
      returnByValue: true,
    })
    active = String(guiSid.result?.value ?? '')
    if (active === sid) break
    await new Promise((r) => setTimeout(r, 500))
  }
  // RPC 切换未生效（实测：session.switch 返回成功而 [data-session-id] 仍指旧 session）⇒
  // 点侧栏最新项（acceptance case 刚建/刚激活的目标 session 即最新项）。侧栏项文本是
  // 「项目名 + 时间」不含 sid，按 sid 匹配恒失败，故不能按 sid 找项。
  if (active !== sid) {
    console.log(`[probe] RPC 切换未生效（当前 ${active || '<空>'}），改走侧栏点击`)
    await cdp.send('Runtime.evaluate', {
      expression: `(() => { const items = [...document.querySelectorAll('.session-item')]; if (items[0]) items[0].click(); return items.length })()`,
      returnByValue: true,
    })
    for (let i = 0; i < 40; i++) {
      const guiSid = await cdp.send('Runtime.evaluate', {
        expression: `document.querySelector('[data-session-id]')?.getAttribute('data-session-id') || ''`,
        returnByValue: true,
      })
      active = String(guiSid.result?.value ?? '')
      if (active === sid) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  if (active !== sid) {
    console.error(`[probe] GUI 未切到目标 session ${sid}（当前 ${active || '<空>'}）——拒绝采集（否则真空 PASS）`)
    process.exit(3)
  }
  console.log(`[probe] GUI on target session: ${active}`)
}

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
