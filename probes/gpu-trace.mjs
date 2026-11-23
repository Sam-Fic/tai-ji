#!/usr/bin/env node
/**
 * 批1 真机探针 G1：GPU trace 采集（与基线 run2d 同 harness：devtools.timeline,gpu,cc，
 * send 时刻锚定 ~34s 窗——基线 trace 墙钟 33.67s 为流式最轻前段）。
 *
 * 形态：node probes/gpu-trace.mjs --data-dir <dir> --sid <sid> [--cdp-port 9478] [--window-ms 34000] [--save <file>] [--shot <file>]
 *
 * 动作：GUI 在场校验（[data-session-id] === 目标 sid，不等则点侧栏最新项）→
 *       CDP Tracing.start（ReportEvents 口径，与基线 run2d 一致）→ delivery.submit 发 prompt →
 *       窗口中点截屏（FPS/显存 overlay）→ Tracing.end → 落盘 trace JSON（裸事件数组，
 *       分析用 node probes/analyze-gpu-union.mjs <file>）。
 *
 * 两个口径纪律（否则前后对比不成立）：
 *  ① 不做预热轮——faux 脚本只有两条响应（首轮 45K 长响应、次轮 19 字符），预热会把长响应
 *     消耗掉，正式轮只剩短回复。基线 run2d 同是「新 session + 首条 prompt + 34s 窗」。
 *  ② 必须校验 GUI 真在目标 session——session.switch RPC 只广播激活信号，renderer 未必
 *     切过去（实测 RPC 成功而 [data-session-id] 仍指旧 session）。GUI 不在场则 34s 窗
 *     采到的是空闲 renderer（raster 32 次 vs 基线 10307 次），必须拒绝采集而非产出假数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { createProtocol } from './vp/lib/protocol.mjs'

function arg (name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}

const dataDir = path.resolve(arg('data-dir', ''))
const sid = arg('sid', '')
const cdpPort = Number(arg('cdp-port', '9478'))
const windowMs = Number(arg('window-ms', '34000'))
const savePath = arg('save', '')
const shotPath = arg('shot', '')
const prompt = arg('text', '请给出性能优化实施方案')

if (!dataDir || !sid) {
  console.error('usage: node probes/gpu-trace.mjs --data-dir <dir> --sid <sid> [--cdp-port 9478] [--window-ms 34000] [--save <file>] [--shot <file>]')
  process.exit(2)
}

// runtime 协议：复用 vp 库（已认证连接 + subscribe + waitTurnEnd，禁手搓第二份 WS 客户端）
const runtimePort = Number(fs.readFileSync(path.join(dataDir, 'runtime.port'), 'utf8').trim())
const rt = await createProtocol({ dataDir, runtimePort })

const page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json())
  .find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) { console.error('no renderer target'); process.exit(2) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const events = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Tracing.dataCollected') { events.push(...msg.params.value); return }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  }
})
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 10000) })
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq
  pending.set(id, { resolve: res, reject: rej })
  ws.send(JSON.stringify({ id, method, params }))
})

// ── GUI 在场校验（采集前提，不做就白采）──────────────────────────────────────
// session.switch RPC 只广播激活信号，renderer 未必真的切过去（实测：RPC 返回成功、
// [data-session-id] 仍指向旧 session，message-stream 空、rail 0 节点）。若 GUI 不在
// 目标 session，34s 窗采到的是空闲 renderer，与基线（流式前段）不同口径。
// 判据 = DOM 事实（[data-session-id] === 目标 sid），不靠时间推测。
//
// 为什么默认不做预热轮：faux 脚本只有两条响应——首轮 45K 长响应、次轮 19 字符。
// 预热会把长响应消耗掉，正式轮只采到 394 字符的短回复（GPU 近乎空闲，前后不可比）。
// 基线 run2d 同样是「新 session + 首条 prompt + send 锚定 34s 窗」，故本探针默认
// 不预热以对齐基线路径。
await send('Runtime.enable')
const guiReady = await ensureGuiOnSession()
if (!guiReady) {
  console.error('[gpu-probe] GUI 未切到目标 session——拒绝采集（否则采到空闲 renderer，前后不可比）')
  process.exit(3)
}

/** GUI 当前激活的 session id（DOM 事实判据）。 */
async function guiActiveSid() {
  const r = await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-session-id]')?.getAttribute('data-session-id') || ''`,
    returnByValue: true,
  })
  return String(r.result.value ?? '')
}

/** 先等 RPC 切换生效；不生效则点侧栏最新项（acceptance case 刚建/刚激活的目标 session 即最新项）。 */
async function ensureGuiOnSession() {
  for (let i = 0; i < 20; i++) { if (await guiActiveSid() === sid) return true; await new Promise((r) => setTimeout(r, 500)) }
  console.log('[gpu-probe] RPC 切换未生效，改走侧栏点击（最新项 = 刚激活的目标 session）')
  await send('Runtime.evaluate', {
    expression: `(() => { const items = [...document.querySelectorAll('.session-item')]; if (items[0]) items[0].click(); return items.length })()`,
    returnByValue: true,
  })
  for (let i = 0; i < 20; i++) { if (await guiActiveSid() === sid) return true; await new Promise((r) => setTimeout(r, 500)) }
  return false
}

await send('Tracing.start', {
  categories: 'devtools.timeline,gpu,cc',
  // ReportEvents（非 ReturnAsStream）：数据经 Tracing.dataCollected 事件回流，由上方监听器
  // 收进 events。ReturnAsStream 的 IO.read 流口径在本 Node 内建 WebSocket 下取回的是
  // Chrome trace 外壳对象而非裸数组（曾在此炸 "Spread syntax requires ...iterable"），
  // 且需额外管句柄生命周期——ReportEvents 与基线 run2d 采集口径一致（152K 事件无丢失）。
  transferMode: 'ReportEvents',
})
console.log('[gpu-probe] tracing started, sending prompt...')
const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
console.log('[gpu-probe] prompt submitted')

await new Promise((r) => setTimeout(r, Math.floor(windowMs / 2)))
if (shotPath) {
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(path.dirname(shotPath), { recursive: true })
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log(`[gpu-probe] midstream screenshot -> ${shotPath}`)
  } catch (e) { console.log(`[gpu-probe] screenshot failed: ${e.message}`) }
}
await new Promise((r) => setTimeout(r, Math.ceil(windowMs / 2)))

await send('Tracing.end')
// 等 tracingComplete（ReportEvents 模式下数据已全部经 dataCollected 到账，此处只做收尾同步）
await new Promise((resolve) => {
  const onDone = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Tracing.tracingComplete') {
      ws.removeEventListener('message', onDone)
      resolve()
    }
  }
  ws.addEventListener('message', onDone)
  setTimeout(() => { ws.removeEventListener('message', onDone); resolve() }, 30000)
})

console.log(`[gpu-probe] events: ${events.length}`)
// 墙钟跨度：与 analyze-gpu-union.mjs 同口径加护栏（ts 须有限且落在合理区间），
// 否则个别异常事件的 dur 会把跨度撑到数小时（曾输出 wall-span=208451s）。
let minTs = Infinity; let maxTs = 0
for (const e of events) {
  if (e.ph !== 'X' || typeof e.ts !== 'number' || typeof e.dur !== 'number') continue
  if (!Number.isFinite(e.ts) || e.ts <= 0 || e.ts > 1e15) continue
  if (e.ts < minTs) minTs = e.ts
  const t = e.ts + e.dur
  if (t > maxTs) maxTs = t
}
const wallSpanS = (maxTs - minTs) / 1e6
console.log(`GPU-TRACE wall-span=${wallSpanS.toFixed(2)}s events=${events.length} ${savePath ? `saved=${savePath}` : ''}`)

// ── 采集有效性断言（不做就等于允许「真空测量」全链绿灯）────────────────────
// 本批实测过一次空 trace 事故：CDP 未回数据 / ws 静默断连时，空 events 仍落盘并 exit 0，
// 而 analyze-gpu-union 对空数组输出 wall-span=-Infinitys events=0——acceptance 的
// contains:wall-span= 对该输出同样命中。故 exit 0 前必须验证「采集到了东西」。
const MIN_EVENTS = 5000
const spanOk = Number.isFinite(wallSpanS) && wallSpanS >= windowMs / 2000 / 2 && wallSpanS <= windowMs / 1000 * 2
const eventsOk = events.length >= MIN_EVENTS
if (!eventsOk || !spanOk) {
  console.error(`[gpu-probe] 采集无效：events=${events.length}（需 ≥${MIN_EVENTS}）wall-span=${wallSpanS.toFixed(2)}s（需 ∈ [${(windowMs / 2000).toFixed(1)}, ${(windowMs / 500).toFixed(1)}]s）——拒绝落盘/拒绝 exit 0`)
  process.exit(3)
}
if (savePath) {
  fs.mkdirSync(path.dirname(savePath), { recursive: true })
  fs.writeFileSync(savePath, JSON.stringify(events))
  console.log(`[gpu-probe] trace saved -> ${savePath}`)
}
process.exit(0)
