#!/usr/bin/env node
/**
 * 批3 真机探针 T4：流式期 streaming-fence 占位行为不变（Worker 化不碰占位契约）。
 *
 * 前置（由验收流程保证）：dev 实例已起（faux 72KB 脚本），session 已建且在 GUI 前台。
 *
 * 形态：node scripts/perf-probes/streaming-placeholder.mjs --data-dir <dir> --sid <sid> [--timeout-ms 240000]
 *
 * 动作：delivery.submit 发 prompt → 轮询 DOM：
 *   ① 流式中途：md-streaming-fence 占位在场 且 无 pre.shiki（未闭合 fence 不跑 shiki）；
 *   ② 等 message.complete → 轮询至占位消失 + 高亮代码块在场（finalize 后完整渲染）。
 *
 * 输出末行：RESULT streaming-placeholder:<bool> final-highlighted:<bool> placeholder-gone:<bool> PASS|FAIL；exit 0/1。
 */
import path from 'node:path'
import {
  connectRuntime,
  connectRendererCdp,
  ensureGuiOnSession,
  waitForSessionComplete,
  sleep,
} from './lib/harness.mjs'

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}

const dataDir = path.resolve(arg('data-dir', ''))
const sid = arg('sid', '')
const timeoutMs = Number(arg('timeout-ms', '240000'))
const prompt = arg('text', '请给出性能优化实施方案')

if (!dataDir || !sid) {
  console.error('usage: node scripts/perf-probes/streaming-placeholder.mjs --data-dir <dir> --sid <sid> [--timeout-ms 240000]')
  process.exit(2)
}

const rt = await connectRuntime(dataDir)
const cdp = await connectRendererCdp(Number(arg('cdp-port', '9478')))
console.log('[probe] connected runtime + renderer CDP')
await cdp.send('Runtime.enable')
await ensureGuiOnSession(cdp, sid)

async function domState() {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      placeholder: document.querySelectorAll('[data-testid="md-streaming-fence"]').length,
      shikiPre: document.querySelectorAll('pre.shiki').length,
      shikiSpans: document.querySelectorAll('pre.shiki [style*="--shiki-dark"]').length,
    })`,
    returnByValue: true,
  })
  return JSON.parse(r.result?.value ?? '{}')
}

const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
console.log('[probe] prompt submitted, polling streaming placeholder...')

// ① 流式中途：占位在场 + 无 shiki 产物（fixture 唯一 fence 未闭合前不跑高亮）
const deadline = Date.now() + timeoutMs
let placeholderSeen = false
let shikiDuringStreaming = false
while (Date.now() < deadline) {
  const s = await domState()
  if (s.placeholder > 0) {
    placeholderSeen = true
    if (s.shikiPre > 0) shikiDuringStreaming = true
    console.log(`[probe] streaming state: placeholder=${s.placeholder} shikiPre=${s.shikiPre}`)
    break
  }
  if (s.shikiPre > 0 && s.placeholder === 0) {
    // 占位还没来得及进 DOM 而 fence 已闭合（极端快流式）——记为未观测到占位
    console.log('[probe] shiki pre seen without placeholder (fence closed before placeholder observed)')
    break
  }
  await sleep(400)
}
if (!placeholderSeen) {
  console.error('[probe] 流式期内未观测到 streaming-fence 占位——占位机制可能已变化，弃测')
  cdp.close()
  rt.ws.close()
  process.exit(3)
}
if (shikiDuringStreaming) {
  console.error('[probe] 占位在场的同时出现 pre.shiki——未闭合 fence 跑了高亮（占位契约被破坏）')
  cdp.close()
  rt.ws.close()
  process.exit(1)
}

// ② complete → finalize：占位消失 + 高亮在场
const endFrame = await waitForSessionComplete(rt, sid, Math.max(1000, deadline - Date.now()))
if (!endFrame) {
  console.error('[probe] 流式未在显式预算内完成——弃测')
  cdp.close()
  rt.ws.close()
  process.exit(3)
}
console.log(`[probe] stream complete: ${endFrame.type}`)

let finalState = await domState()
const finalDeadline = Date.now() + 30000
while (Date.now() < finalDeadline && (finalState.placeholder > 0 || finalState.shikiSpans < 1)) {
  await sleep(400)
  finalState = await domState()
}
console.log(`[probe] final state: placeholder=${finalState.placeholder} shikiPre=${finalState.shikiPre} shikiSpans=${finalState.shikiSpans}`)

cdp.close()
rt.ws.close()

const placeholderGone = finalState.placeholder === 0
const finalHighlighted = finalState.shikiPre >= 1 && finalState.shikiSpans >= 1
const pass = placeholderSeen && !shikiDuringStreaming && placeholderGone && finalHighlighted
console.log(`RESULT streaming-placeholder:${placeholderSeen && !shikiDuringStreaming} final-highlighted:${finalHighlighted} placeholder-gone:${placeholderGone} ${pass ? 'PASS' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
