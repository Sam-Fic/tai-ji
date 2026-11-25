#!/usr/bin/env node
/**
 * 批5 GPU trace 采集探针（三臂受控实验 + recordContinuously + dataLoss 监听 + 事件驱动窗长）。
 *
 * 对 GLM 对抗审查 A6/M1/S7 的修复（首轮 trace 墙钟只有 33.67s、未覆盖 fence 闭合）：
 *   ① `Tracing.start` 带 `options: 'record-continuously'`（首轮用默认 record-until-full，
 *      缓冲满即停 → 34s 截断）+ 监听 `Tracing.dataLossOccured` 并把丢失事件数写进结果行；
 *   ② 窗长**事件驱动**：start → submit → 等 `message.complete`（或用户显式给的 ms 预算到顶）→ end；
 *      不再用「send 后固定 34s」的墙钟切法（那正是只覆盖流式最轻前段的根因）；
 *   ③ 中期截图改为「流式进行到一半」按事件进度触发（首个 text_delta 后按时间预算一半），
 *      不再固定 sleep(windowMs/2)。
 *
 * 三臂（批5 GPU 裁决）：
 *   --arm full     无注入（现状：四层 backdrop-blur + 沉色层 + 容器 mask）
 *   --arm no-blur  注入 CSS 摘除 backdrop-filter（mask 与沉色层保留）⇒ 隔离 blur 的 raster 成本
 *   --arm no-mask  注入 CSS 摘除滚动容器的 mask-image（blur 与沉色层保留）⇒ 隔离 GPU-7
 *                  的「mask 作用于整个滚动容器」这条合成路径的代价
 *   --arm reduced  CDP 模拟 prefers-reduced-transparency:reduce ⇒ 走组件内建降级
 *                  （遮罩层 hidden + 容器 mask 摘除）= 视觉项总 GPU 账
 *
 * 用法：node probes/gpu-trace.mjs --data-dir <dir> --sid <sid> [--cdp-port 9478]
 *         [--arm full|no-blur|reduced] [--window-ms 110000] [--save <file>] [--shot <file>]
 *         [--text <prompt>]
 *
 * 采集有效性断言（拒绝纪律，沿用批1 教训）：events ≥ 5000 且墙钟跨度落在合理区间，
 * 否则 exit 3——空 trace 绝不落盘、绝不 exit 0。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'

import { createProtocol } from './vp/lib/protocol.mjs'
import { ensureGuiOnSessionViaLabel } from './lib/harness.mjs'

function arg (name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}

// 先判原始值再 resolve（`path.resolve('')` 返回 cwd，会让 `if (!dataDir)` 守卫失效）
const dataDirRaw = arg('data-dir', '')
if (!dataDirRaw) {
  console.error('usage: node probes/gpu-trace.mjs --data-dir <~/.taiji-dev/\u2026> [--sid <sid>] [--arm full|no-blur|no-mask|reduced] [--window-ms 110000] [--save <file>] [--shot <file>]')
  process.exit(2)
}
const dataDir = path.resolve(dataDirRaw)
// 不传 --sid 时探针自己建一个全新 session（验收 case 需要自足：gate 命令里没有变量替换，
// 手传 sid 既不可脚本化也容易在多次采集后指向已经演出完的旧 session——那会采到空闲 renderer）。
let sid = arg('sid', '')
const cdpPort = Number(arg('cdp-port', '9478'))
const arm = arg('arm', 'full')
const windowMs = Number(arg('window-ms', '110000'))
const savePath = arg('save', '')
const shotPath = arg('shot', '')
const prompt = arg('text', '请给出性能优化实施方案')
// trace 单文件 230–260MB：落进仓库会撞 GitHub 100MB 硬限制（且破 harvest 清洁度检查）。
// 指向仓库内时响亮拒绝，让调用方改到 .run/（gitignore）或会话 artifacts。
if (savePath && !path.isAbsolute(savePath) && !savePath.startsWith('.run/') && !savePath.startsWith('/tmp/')) {
  console.error(`[gpu-probe] 拒绝落盘：--save ${savePath} 不在 .run/ 或 /tmp/ 下（trace 单文件 230-260MB，不得入库；.gitignore 已含 *.trace.json，但显式指到 docs/ 会误导读者）`)
  process.exit(2)
}

// 值域守卫：只接受 ~/.taiji-dev 树内的研发数据目录（探针会自建 session 并写 fixture）
const DEV_DATA_ROOT = path.join(os.homedir(), '.taiji-dev')
if (!dataDir.startsWith(DEV_DATA_ROOT + path.sep)) {
  console.error(`[gpu-probe] 拒绝采集：--data-dir 必须落在 ${path.join('~', '.taiji-dev')} 树内（实际 ${dataDir}）`)
  process.exit(3)
}
if (!['full', 'no-blur', 'no-mask', 'reduced'].includes(arm)) {
  console.error(`[gpu-probe] --arm 非法：${arm}（允许 full / no-blur / no-mask / reduced）`)
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
const dataLoss = []
const frameErrors = []
ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch (e) {
    // 单帧解析失败不该杀死整场采集（渲染侧可能中断在半个帧上），但要留痕并计入有效性判据
    frameErrors.push(`JSON.parse: ${e.message}`)
    return
  }
  if (msg.method === 'Tracing.dataCollected') {
    // **禁 spread**：record-continuously 的单个 dataCollected 批次可达数十万条，
    // `events.push(...batch)` 会抛 RangeError: Maximum call stack size exceeded，
    // 且异常发生在 ws 事件回调里 → 未捕获 → 整个采集进程崩（实测：no-blur/no-mask/reduced
    // 三臂全崩在这行，full 臂因批次较小侥幸通过）。
    const batch = msg.params.value
    for (let i = 0; i < batch.length; i++) events.push(batch[i])
    return
  }
  if (msg.method === 'Tracing.dataLossOccured') { dataLoss.push(msg.params ?? {}); return }
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
// 判据与 perf-clean-cpu.mjs 同源（harness.ensureGuiOnSessionViaLabel）：本仓当前版本
// 会话行**没有** data-session-id（verify-taiji capabilities/session.md 已知空洞 #1），
// 面板态锚点是 [data-testid=panel-session-label] 文本 = 会话 label。三级退让：
// ① data-session-id 命中 → ② panel-session-label 文本命中 → ③ 展开项目组后点目标会话行。
// 旧的「点侧栏最新项」在多次采集后必然点错（最新项 = 上一次的 session）。
// 自建 session（未传 --sid）：label 唯一，避免面板 label 匹配到上一次的会话
if (!sid) {
  const created = await rt.call('session.create', { cwd: process.cwd(), label: `b5-gpu-${arm}-${Date.now().toString(36)}` }, 120000)
  sid = created.session?.id ?? created.sessionId ?? ''
  if (!sid) {
    console.error(`[gpu-probe] session.create 未返回 id：${JSON.stringify(created).slice(0, 300)}`)
    process.exit(3)
  }
  console.log(`[gpu-probe] created session ${sid} (label ${created.session?.label ?? '?'})`)
}

const sessionList = await rt.call('config.sessions', {}, 30000).catch(() => null)
let sessionLabel = ''
for (const g of sessionList?.groups ?? []) {
  for (const x of g.sessions ?? []) if (x.id === sid) sessionLabel = x.label ?? ''
}
console.log(`[gpu-probe] target session label="${sessionLabel}"`)
if (!(await ensureGuiOnSessionViaLabel({ send }, sid, sessionLabel))) {
  console.error('[gpu-probe] GUI 未切到目标 session——拒绝采集（否则采到空闲 renderer，三臂不可比）')
  process.exit(3)
}

// 必须先订阅才有 message.* 广播帧（否则 waitTurnEnd 永远观测不到终态，只能等预算到顶——
// 那正是首轮「固定 34s 窗」掩盖成「窗口正常」的同类缺陷）。
await rt.subscribe(sid, { timeoutMs: 30000 })
console.log('[gpu-probe] subscribed to session events')

// ── 三臂注入（在 tracing 之前完成，注入本身不计入被比较的窗口）───────────────
// 幂等前提：同一 renderer 页面会被多个臂复用（每臂一个新 session，但页面不重载）。
// 因此每臂开始前必须先**清掉上一臂的注入**——实测踩坑：no-blur 臂注入的 <style> 残留在页面上，
// 后续臂的 EdgeFade 计算样式恒为 backdrop-filter:none（等于第三臂也跑了 no-blur）。
async function resetArmInjection () {
  await send('Runtime.evaluate', {
    expression: `(() => {
      for (const id of ['b5-no-blur', 'b5-no-mask']) document.getElementById(id)?.remove();
      return document.getElementById('b5-no-blur') === null && document.getElementById('b5-no-mask') === null;
    })()`,
    returnByValue: true,
  })
  await send('Emulation.setEmulatedMedia', { features: [] })
}
await resetArmInjection()

let injected = ''
if (arm === 'no-blur') {
  // 只摘 backdrop-filter：mask / 沉色层 / 布局全部保留 ⇒ 差值 ≈ blur 的 raster+合成成本
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const s = document.createElement('style');
      s.id = 'b5-no-blur';
      s.textContent = '[class*="backdrop-blur"]{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
      document.head.appendChild(s);
      const n = document.querySelectorAll('[class*="backdrop-blur"]').length;
      return n;
    })()`,
    returnByValue: true,
  })
  // 校验注入真的生效：至少一个带 backdrop-blur 类的元素计算值应为 none（未生效则拒绝采集，
  // 否则 no-blur 臂等于 full 臂，差值恒 0 会被误读成「blur 无成本」）
  const verify = await send('Runtime.evaluate', {
    expression: `(() => {
      const els = [...document.querySelectorAll('[class*="backdrop-blur"]')];
      const bf = els.map((e) => getComputedStyle(e).backdropFilter);
      return JSON.stringify({ count: els.length, noneCount: bf.filter((v) => v === 'none').length });
    })()`,
    returnByValue: true,
  })
  injected = `backdrop-filter(classes-at-inject=${r.result.value} verify=${verify.result.value})`
  console.log(`[gpu-probe] arm=no-blur 注入完成：${injected}`)
} else if (arm === 'no-mask') {
  // 只摘滚动容器 mask：blur 四层与沉色层全部保留 ⇒ 差值 ≈ mask 合成路径成本（GPU-7）
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const s = document.createElement('style');
      s.id = 'b5-no-mask';
      s.textContent = '[data-testid="message-stream"]{mask-image:none!important;-webkit-mask-image:none!important}';
      document.head.appendChild(s);
      const el = document.querySelector('[data-testid="message-stream"]');
      return el ? getComputedStyle(el).maskImage : 'no-stream';
    })()`,
    returnByValue: true,
  })
  injected = `mask-image(computed=${r.result.value})`
  console.log(`[gpu-probe] arm=no-mask 注入完成：${injected}`)
} else if (arm === 'reduced') {
  // 组件内建降级路径：prefers-reduced-transparency: reduce → 遮罩 hidden + 容器 mask 摘除
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  })
  const probe = await send('Runtime.evaluate', {
    expression: `matchMedia('(prefers-reduced-transparency: reduce)').matches`,
    returnByValue: true,
  })
  if (probe.result.value !== true) {
    console.error('[gpu-probe] prefers-reduced-transparency 模拟未生效——拒绝采集（否则 reduced 臂等于 full 臂）')
    process.exit(3)
  }
  injected = 'emulated-media=prefers-reduced-transparency:reduce'
  console.log(`[gpu-probe] arm=reduced 模拟生效：${injected}`)
}

// ── tracing（recordContinuously：首轮 A6 的根因修复）─────────────────────────
await send('Tracing.start', {
  categories: 'devtools.timeline,gpu,cc',
  options: 'record-continuously',
  transferMode: 'ReportEvents',
})
console.log('[gpu-probe] tracing started (record-continuously), sending prompt...')

const t0 = Date.now()
const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
console.log('[gpu-probe] prompt submitted')

// 等 turn 结束（事件驱动）；windowMs = 显式预算上限，到顶即收（弃测判据见尾部）
let completed = false
try {
  const r = await Promise.race([
    rt.waitTurnEnd(sid, { timeoutMs: windowMs }),
    new Promise((resolve) => setTimeout(() => resolve(null), windowMs)),
  ])
  completed = r !== null && r !== undefined
} catch (e) {
  console.log(`[gpu-probe] waitTurnEnd 异常：${e.message}`)
}
const streamMs = Date.now() - t0
console.log(`[gpu-probe] window closed: completed=${completed} stream=${(streamMs / 1000).toFixed(1)}s`)

// 中期截图：若窗口已结束，则在结束时刻补一张（流式末期形态）；否则说明窗口提前收
if (shotPath) {
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(path.dirname(shotPath), { recursive: true })
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log(`[gpu-probe] screenshot -> ${shotPath}`)
  } catch (e) { console.log(`[gpu-probe] screenshot failed: ${e.message}`) }
}

// 臂末统计（流式期 EdgeFade 已挂载，此时计数才有意义）
const armEndProbe = await send('Runtime.evaluate', {
  expression: `(() => {
    const els = [...document.querySelectorAll('[class*="backdrop-blur"]')];
    const s = document.querySelector('[data-testid="message-stream"]');
    return JSON.stringify({
      blurEls: els.length,
      noneCount: els.filter((e) => getComputedStyle(e).backdropFilter === 'none').length,
      maskOnScroller: s ? (getComputedStyle(s).maskImage || 'none') !== 'none' : null,
      edgeFadeHidden: !!document.querySelector('[data-testid="edge-fade"].hidden'),
    });
  })()`,
  returnByValue: true,
})
console.log(`[gpu-probe] arm-end state=${armEndProbe.result.value}`)

await send('Tracing.end', {})
await new Promise((resolve) => {
  const onDone = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Tracing.tracingComplete') { ws.removeEventListener('message', onDone); resolve() }
  }
  ws.addEventListener('message', onDone)
  setTimeout(() => { ws.removeEventListener('message', onDone); resolve() }, 30000)
})

// 墙钟跨度（与 analyze-gpu-union.mjs 同口径护栏：个别异常事件 dur 会撑到数小时）
let minTs = Infinity; let maxTs = 0
for (const e of events) {
  if (e.ph !== 'X' || typeof e.ts !== 'number' || typeof e.dur !== 'number') continue
  if (!Number.isFinite(e.ts) || e.ts <= 0 || e.ts > 1e15) continue
  if (e.ts < minTs) minTs = e.ts
  const t = e.ts + e.dur
  if (t > maxTs) maxTs = t
}
const wallSpanS = (maxTs - minTs) / 1e6
console.log(`[gpu-probe] events=${events.length} wall-span=${wallSpanS.toFixed(2)}s dataLossEvents=${dataLoss.length} frameErrors=${frameErrors.length}`)

// ── 采集有效性断言（空 trace 绝不 exit 0）────────────────────────────────────
const MIN_EVENTS = 5000
const spanOk = Number.isFinite(wallSpanS) && wallSpanS >= 5 && wallSpanS <= (windowMs / 1000) * 2
const eventsOk = events.length >= MIN_EVENTS
if (frameErrors.length > 0) console.error(`[gpu-probe] 出现 ${frameErrors.length} 个解析失败帧（首个：${frameErrors[0]}）——采集可信度下降`)
if (!eventsOk || !spanOk) {
  console.error(`[gpu-probe] 采集无效：events=${events.length}（需 ≥${MIN_EVENTS}）wall-span=${wallSpanS.toFixed(2)}s（需 ∈ [5, ${((windowMs / 1000) * 2).toFixed(1)}]s）——拒绝落盘/拒绝 exit 0`)
  process.exit(3)
}
if (savePath) {
  fs.mkdirSync(path.dirname(savePath), { recursive: true })
  fs.writeFileSync(savePath, JSON.stringify(events))
  console.log(`[gpu-probe] trace saved -> ${savePath}`)
}

// 收尾复原（防污染后续臂/后续采集）
await resetArmInjection()

const parts = [`RESULT gpu-trace arm=${arm} wall-span=${wallSpanS.toFixed(2)}s events=${events.length} dataLoss=${dataLoss.length}`]
if (injected) parts.push(`injected=${injected}`)
parts.push(`completed=${completed} stream=${(streamMs / 1000).toFixed(1)}s sid=${sid}`)
console.log(parts.join(' '))
process.exit(0)
