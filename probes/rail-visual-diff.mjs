#!/usr/bin/env node
/**
 * 批1 真机探针 T2：rail 终态视觉不变 + 流式期 fence 泄漏修复断言。
 *
 * 前置（**调用方责任，本探针不等待 turn 结束**）：dev 实例运行中（faux 脚本），session 已建
 * 且本轮 turn 已结束（message.complete）。原因：流式期 rail 摘要是冻结前缀（见
 * rail-turn-memo.ts 冻结语义），中途提取会把瞬时值对拍/烧进 golden。acceptance.md 的 T2
 * 行用 `vp chat.wait` 承担该前置；直接单跑本探针前必须自行保证。
 *
 * 形态：node probes/rail-visual-diff.mjs --data-dir <dir> --sid <sid> [--cdp-port 9478] [--golden probes/golden/rail-texts.json]
 *
 * 动作：CDP 连 renderer → GUI 在场校验 → 轮询等 TurnRail 节点就绪 → 提取各节点可见文本 →
 *       与 golden 对拍（终态逐字相等）→ 断言无节点文本含 fence 标记泄漏。
 *
 * session 切换由 acceptance case 的 session.switch RPC 发起；本探针校验 GUI 真的切过去了
 * （[data-session-id] === 目标 sid），未生效则点侧栏最新项——侧栏项文本是「项目名 + 时间」
 * 不含 sid，按 sid 匹配恒失败，故不能按 sid 找项。
 *
 * 拒绝纪律（exit 3，与 GUI 在场校验同源）：rail 节点提取为空时不判定、不写 golden——
 * 「0 节点 vs 空 golden」会被判 identical=true，那是零证据满足「零视觉变化」。
 *
 * 输出：rail-identical:true|false leak-free:true|false；exit 0/1/3。
 */
import fs from 'node:fs'
import path from 'node:path'

function arg (name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}

const dataDir = path.resolve(arg('data-dir', ''))
const sid = arg('sid', '')
const cdpPort = Number(arg('cdp-port', '9478'))
const goldenPath = path.resolve(arg('golden', 'probes/golden/rail-texts.json'))

if (!dataDir || !sid) {
  console.error('usage: node probes/rail-visual-diff.mjs --data-dir <dir> --sid <sid> [--cdp-port 9478] [--golden <file>]')
  process.exit(2)
}

const target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json())
  .find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!target) { console.error('no renderer target'); process.exit(2) }
const ws = new WebSocket(target.webSocketDebuggerUrl)
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
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 10000) })
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq
  pending.set(id, { resolve: res, reject: rej })
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
// GUI 在场校验：session.switch RPC 只广播激活信号，renderer 未必真的切过去
// （实测：RPC 成功而 [data-session-id] 仍指旧 session，rail 0 节点）。判据 = DOM 事实。
// 侧栏项文本是「项目名 + 时间」不含 sid，按 sid 匹配恒失败——故不按 sid 找项，
// 而是先等 RPC 生效，不生效则点最新项（acceptance case 刚建/刚激活的目标 session）。
const RAIL_NODE_SELECTOR = '[data-testid="rail-node"], [data-testid^="rail-turn"], .rail-turn, [class*="railTurn"], [class*="rail-turn"]'
async function guiActiveSid() {
  const r = await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-session-id]')?.getAttribute('data-session-id') || ''`,
    returnByValue: true,
  })
  return String(r.result.value ?? '')
}
for (let i = 0; i < 20; i++) { if (await guiActiveSid() === sid) break; await new Promise((r) => setTimeout(r, 500)) }
if (await guiActiveSid() !== sid) {
  console.log('[probe] RPC 切换未生效，改走侧栏点击（最新项 = 刚激活的目标 session）')
  await send('Runtime.evaluate', {
    expression: `(() => { const items = [...document.querySelectorAll('.session-item')]; if (items[0]) items[0].click(); return items.length })()`,
    returnByValue: true,
  })
  for (let i = 0; i < 20; i++) { if (await guiActiveSid() === sid) break; await new Promise((r) => setTimeout(r, 500)) }
}
if (await guiActiveSid() !== sid) {
  console.error(`[probe] GUI 未切到目标 session ${sid}（当前 ${await guiActiveSid()}）`)
  process.exit(3)
}

// 轮询等 rail 节点就绪：切 session 后历史装载 + 渲染是异步的，固定 sleep 在重会话下不足
const deadline = Date.now() + 20000
let nodeCount = 0
for (;;) {
  const probe = await send('Runtime.evaluate', {
    expression: `document.querySelectorAll(${JSON.stringify(RAIL_NODE_SELECTOR)}).length`,
    returnByValue: true,
  })
  nodeCount = Number(probe.result.value ?? 0)
  if (nodeCount > 0) break
  if (Date.now() >= deadline) break
  await new Promise((r) => setTimeout(r, 500))
}
console.log(`[probe] rail nodes ready: ${nodeCount}`)

// 提取 TurnRail 节点文本（rail 容器 + 节点文本的稳定形态：data-testid 优先，类名兜底）
const extracted = await send('Runtime.evaluate', { expression: `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="rail-node"], [data-testid^="rail-turn"], .rail-turn, [class*="railTurn"], [class*="rail-turn"]')]
  const texts = nodes.map(n => (n.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
  return JSON.stringify(texts)
})()`, returnByValue: true })
const texts = JSON.parse(extracted.result.value || '[]')
console.log(`[probe] rail nodes extracted: ${texts.length}`)

// 空提取一律拒绝（不论 golden 在不在）：rail 从未渲染时「0 节点 vs 空 golden」会被判
// identical=true 并 exit 0，且捕获模式会把「空」烧成基线——那是零证据满足「零视觉变化」。
// 与 GUI 在场校验同纪律（exit 3）。
if (texts.length === 0) {
  console.error('[probe] rail 节点提取为空（GUI 未渲染目标 session 的 rail）——拒绝判定/拒绝写 golden')
  process.exit(3)
}

const goldenExists = fs.existsSync(goldenPath)
let identical = null
if (goldenExists) {
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'))
  identical = JSON.stringify(golden) === JSON.stringify(texts)
  console.log(`[probe] golden compare: ${identical ? 'identical' : 'DIFFERENT'}`)
  if (!identical) {
    console.log('[probe] golden:', JSON.stringify(golden))
    console.log('[probe] current:', JSON.stringify(texts))
  }
} else {
  fs.mkdirSync(path.dirname(goldenPath), { recursive: true })
  fs.writeFileSync(goldenPath, JSON.stringify(texts, null, 2))
  console.log(`[probe] golden captured -> ${goldenPath}（首次运行捕获模式；已确认非空）`)
  identical = true
}

const leak = texts.filter((t) => t.includes('```'))
const leakFree = leak.length === 0
if (!leakFree) console.log('[probe] fence leak nodes:', JSON.stringify(leak))

console.log(`rail-identical:${identical} leak-free:${leakFree}`)
process.exit(identical && leakFree ? 0 : 1)
