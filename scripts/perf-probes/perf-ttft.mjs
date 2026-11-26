#!/usr/bin/env node
/**
 * 批4 真机探针 T1：TTFT（首 token 延迟）分解测量 + .gitignore 编译次数对账。
 *
 * 问题（GLM 审查 A5/S9）：runtime +10..15s 32% busy 突发
 * （ruleMatchesPath 0.50 + readdir 0.37 + writev 0.13 + parseJsonl 0.05），
 * dev 实例日志显示 send: type=prompt 后紧跟 .gitignore 读取/编译、每次 prompt 两次
 * 编译（file.tree 与 file.search 各一次、同一文件重复编译）——声称阻塞 runtime
 * 事件循环使首 token 转发被顶后 ~0.9s。本探针用真机测量验证/证伪该机制并分解 TTFT。
 *
 * 三模式（同 fixture 同实例）：
 *   warm  —— 新 session + 预热 prompt（pi 就绪）→ 测第二条 prompt 的 TTFT：
 *            pi 热、无并发文件请求 = 转发地板
 *   walk  —— 同 warm，但测量 prompt 前先发 file.tree + file.search（复刻 GUI 挂载
 *            时的两个请求 → runtime 两次全树 ignore 匹配）：隔离文件行走的 TTFT 贡献
 *   fresh —— 新 session → GUI 切过去（挂载触发 file.tree/file.search）→ 立即 prompt：
 *            真实用户流 TTFT（含 pi 冷启动段）
 *
 * TTFT 口径：delivery.submit 发出（探针墙钟 t0）→ 本 session 首个
 * message.message_start 广播帧到达（t1）。同时记录首个 message.text_delta。
 * 对账：窗口内 runtime 日志 .gitignore 编译次数（file-service debug 行）。
 *
 * 用法：node scripts/perf-probes/perf-ttft.mjs --data-dir <dir> [--cdp-port 9478] [--mode warm|walk|fresh]
 *       [--runs 2] [--text <prompt>]
 * 输出末行：RESULT mode=<m> ttft-ms=<n> first-delta-ms=<n> gitignore-compiles=<n>
 */
import fs from 'node:fs'
import path from 'node:path'
import { connectRuntime, connectRendererCdp, ensureGuiOnSession, sleep } from './lib/harness.mjs'

function arg (name, dflt) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const argv = process.argv.slice(2)
const dataDir = path.resolve(arg('data-dir', ''))
const cdpPort = Number(arg('cdp-port', '9478'))
const mode = arg('mode', 'warm')
const runs = Number(arg('runs', '2'))
const walkLeadMs = Number(arg('walk-lead-ms', '50'))
const walkStress = Number(arg('walk-stress', '0'))
const sessionCwd = arg('cwd', process.cwd()) // 对齐原始实测场景：session cwd = worktree 根
const prompt = arg('text', '请给出性能优化实施方案')

if (!dataDir) {
  console.error('usage: node scripts/perf-probes/perf-ttft.mjs --data-dir <dir> [--cdp-port 9478] [--mode warm|walk|fresh] [--runs 2]')
  process.exit(2)
}

const runtimeLogDir = path.join(dataDir, 'logs')
function countGitignoreCompiles () {
  let files = []
  try {
    files = fs.readdirSync(runtimeLogDir).filter((f) => f.startsWith('runtime-') && f.endsWith('.log'))
  } catch { return 0 }
  let n = 0
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(runtimeLogDir, f), 'utf8')
      n += text.split('\n').filter((l) => l.includes('.gitignore 读取/编译')).length
    } catch { /* skip */ }
  }
  return n
}

async function waitTurnEnd (rt, sid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let scanned = rt.events.length
  const endTypes = new Set(['message.complete', 'message.error', 'message.stream_error', 'session.exited'])
  while (Date.now() < deadline) {
    for (let i = scanned; i < rt.events.length; i++) {
      const f = rt.events[i]
      if (endTypes.has(f.type) && f.payload?.sessionId === sid) return f
    }
    scanned = rt.events.length
    await sleep(100)
  }
  return null
}

/** 等本 session 首帧（message_start / text_delta），返回相对 t0 的毫秒。
 *  TTFT = 首个 message_start；first_delta 在 start 后最多再等 DELTA_GRACE_MS（faux 短响应可能
 *  无 text_delta——不为它空耗，超窗记 null，不影响 TTFT 口径）。 */
async function waitFirstFrame (rt, sid, t0, timeoutMs) {
  const DELTA_GRACE_MS = 3000
  const deadline = Date.now() + timeoutMs
  let firstStart = null
  let firstDelta = null
  let startSeenAt = null
  let scanned = rt.events.length
  while (Date.now() < deadline) {
    for (let i = scanned; i < rt.events.length; i++) {
      const f = rt.events[i]
      if (f.payload?.sessionId !== sid) continue
      if (firstStart === null && f.type === 'message.message_start') { firstStart = f.receivedAt ?? Date.now(); startSeenAt = Date.now() }
      if (firstDelta === null && f.type === 'message.text_delta') firstDelta = f.receivedAt ?? Date.now()
    }
    scanned = rt.events.length
    if (firstStart !== null && firstDelta !== null) break
    if (startSeenAt !== null && Date.now() - startSeenAt > DELTA_GRACE_MS) break
    await sleep(2)
  }
  return { firstStart, firstDelta }
}

/** 单次 TTFT 测量：subscribe → （可选 walk 前置）→ delivery.submit → 首帧 */
async function measureOnce (rt, sid, { walk, walkLeadMs, walkStress }) {
  await rt.call('session.subscribe', { sessionId: sid }, 30000)
  await sleep(300) // 等订阅生效
  const before = countGitignoreCompiles()
  if (walk) {
    // 复刻 GUI 会话挂载时的两个文件请求（file.tree + file.search），
    // fire-and-forget（renderer 侧同形态：不 await 结果）
    void rt.call('file.tree', { sessionId: sid }, 120_000).catch(() => {})
    void rt.call('file.search', { sessionId: sid }, 120_000).catch(() => {})
    // walkStress：机制压测——prompt 在途时并发 N 个全树 search.cwd（worktree 根，
    // 实测单次 ~341ms / 5000 文件截断）。若「walk CPU 阻塞首 token 转发」机制成立，
    // TTFT 应随 N 显著劣化；不成立则 TTFT 保持地板值。
    for (let i = 0; i < walkStress; i++) {
      void rt.call('file.search.cwd', { cwd: sessionCwd }, 120_000).catch(() => {})
    }
    // walkLeadMs = 模拟「GUI 挂载 → 用户打字 → 发送」的时延：
    // 全树 walk ~0.9s，lead=0 时 bulk 落在首帧之后；lead≈700ms 时 walk 峰值与 prompt 重叠
    if (walkLeadMs > 0) await sleep(walkLeadMs)
  }
  const t0 = Date.now()
  await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid: crypto.randomUUID() }, 30000)
  const sendWall = Date.now()
  const { firstStart, firstDelta } = await waitFirstFrame(rt, sid, t0, 180_000)
  const after = countGitignoreCompiles()
  return {
    ttftMs: firstStart === null ? null : firstStart - t0,
    firstDeltaMs: firstDelta === null ? null : firstDelta - t0,
    submitMs: sendWall - t0,
    gitignoreCompiles: after - before,
  }
}

const rt = await connectRuntime(dataDir)
console.log('[probe] runtime connected')

const results = []
for (let i = 0; i < runs; i++) {
  // 每轮一个全新 session（pi 进程级冷启动 + faux 脚本重置）
  const reply = await rt.call('session.create', { cwd: sessionCwd }, 180_000)
  const sid = reply.sessionId ?? reply.session?.id
  console.log(`[probe] run${i + 1}: session created: ${sid}`)

  if (mode === 'fresh') {
    const cdp = await connectRendererCdp(cdpPort)
    await ensureGuiOnSession(cdp, sid)
    cdp.close()
    const r = await measureOnce(rt, sid, { walk: false })
    results.push(r)
    console.log(`[probe] run${i + 1} (fresh): ttft=${r.ttftMs}ms first-delta=${r.firstDeltaMs}ms submit-rtt=${r.submitMs}ms gitignore-compiles=${r.gitignoreCompiles}`)
    await waitTurnEnd(rt, sid, 180_000)
  } else {
    // warm/walk：先发预热 prompt（pi 冷启动 + 首条流式），等 complete 后测第二条
    await measureOnce(rt, sid, { walk: false })
    const warmEnd = await waitTurnEnd(rt, sid, 180_000)
    if (!warmEnd) { console.error(`[probe] run${i + 1} 预热轮未在预算内结束——弃测`); process.exit(3) }
    await sleep(500)
    const r = await measureOnce(rt, sid, { walk: mode === 'walk', walkLeadMs, walkStress })
    results.push(r)
    console.log(`[probe] run${i + 1} (${mode}): ttft=${r.ttftMs}ms first-delta=${r.firstDeltaMs}ms submit-rtt=${r.submitMs}ms gitignore-compiles=${r.gitignoreCompiles}`)
    await waitTurnEnd(rt, sid, 180_000)
  }
}

const med = (arr) => {
  const valid = arr.filter((n) => typeof n === 'number').sort((a, b) => a - b)
  return valid.length ? valid[Math.floor(valid.length / 2)] : null
}
const ttft = med(results.map((r) => r.ttftMs))
const delta = med(results.map((r) => r.firstDeltaMs))
const compiles = med(results.map((r) => r.gitignoreCompiles))
console.log(`RESULT mode=${mode} ttft-ms=${ttft} first-delta-ms=${delta} gitignore-compiles=${compiles} runs=${runs}`)
rt.ws.close()
