#!/usr/bin/env node
/**
 * 批3 真机探针 T3：降级路径（worker 不可用 → 回退主线程同步高亮，高亮不丢）。
 *
 * 前置（由验收流程保证）：dev 实例已起，session 已建且在 GUI 前台。
 *
 * 形态：node probes/shiki-fallback-probe.mjs --data-dir <dir> --sid <sid> [--timeout-ms 240000]
 *
 * 动作：CDP Runtime.evaluate 把 window.Worker 换成「构造即抛错」的桩（模拟 worker
 *       不可用——CSP 被外部策略拦 / 环境无 Worker；实测 Network.setBlockedURLs 不拦截
 *       worker 脚本加载，故用构造抛错桩触发同一 degrade 路径）→
 *       delivery.submit 发 prompt → 等 complete → 断言：
 *       ① 高亮保留（pre.shiki + token span 在场，非纯文本降级）；
 *       ② 内容完整（代码字符数在场）；
 *       ③ 降级出声（console 有 fallback 日志——不静默）。
 *
 * 输出末行：RESULT fallback-highlight-preserved:true highlighted:true fallback-logged:true PASS|FAIL；exit 0/1。
 */
import path from 'node:path'
import {
  connectRuntime,
  connectRendererCdp,
  ensureGuiOnSession,
  waitForSessionComplete,
  collectConsoleMessages,
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
  console.error('usage: node probes/shiki-fallback-probe.mjs --data-dir <dir> --sid <sid> [--timeout-ms 240000]')
  process.exit(2)
}

const rt = await connectRuntime(dataDir)
const cdp = await connectRendererCdp(Number(arg('cdp-port', '9478')))
console.log('[probe] connected runtime + renderer CDP')
const consoleMessages = await collectConsoleMessages(cdp)
await cdp.send('Runtime.enable')
// worker 不可用桩：构造即抛错（客户端 ensureWorker 的 catch → degrade → 主线程同步回退）。
// 在首个 fence job（fence 闭合，流式中途）之前打桩——客户端惰性建 worker，此刻尚未建。
await cdp.send('Runtime.evaluate', {
  expression: `window.Worker = class { constructor() { throw new Error('probe: worker unavailable') } }`,
})
console.log('[probe] window.Worker stubbed to throw (worker unavailable)')
await ensureGuiOnSession(cdp, sid)

const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
console.log('[probe] prompt submitted, streaming with blocked worker...')

const endFrame = await waitForSessionComplete(rt, sid, timeoutMs)
if (!endFrame) {
  console.error('[probe] 流式未在显式预算内完成——弃测')
  cdp.close()
  rt.ws.close()
  process.exit(3)
}
console.log(`[probe] stream complete: ${endFrame.type}`)

// finalize 渲染轮询（预算内事件驱动等待）
const deadline = Date.now() + 30000
let dom = { shikiPre: 0, shikiSpans: 0, codeChars: 0 }
while (Date.now() < deadline) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      shikiPre: document.querySelectorAll('pre.shiki').length,
      shikiSpans: document.querySelectorAll('pre.shiki [style*="--shiki-dark"]').length,
      codeChars: (document.querySelector('pre.shiki')?.textContent ?? '').length,
    })`,
    returnByValue: true,
  })
  dom = JSON.parse(r.result?.value ?? '{}')
  if (dom.shikiSpans >= 1) break
  await sleep(400)
}
console.log(`[probe] final DOM: pre.shiki=${dom.shikiPre} spans=${dom.shikiSpans} codeChars=${dom.codeChars}`)

cdp.close()
rt.ws.close()

// 降级出声：console 里出现 fallback 日志（不静默是硬要求）
const fallbackLogs = consoleMessages.filter((m) => /fallback|degrad|worker.*(unavailable|failed|error)/i.test(m.text))
for (const m of fallbackLogs) console.log(`[console:${m.type}] ${m.text}`)
const fallbackLogged = fallbackLogs.length > 0
const highlighted = dom.shikiPre >= 1 && dom.shikiSpans >= 1
const contentPreserved = dom.codeChars > 1000
const preserved = highlighted && contentPreserved
const pass = preserved && fallbackLogged
console.log(`RESULT fallback-highlight-preserved:${preserved} highlighted:${highlighted} fallback-logged:${fallbackLogged} ${pass ? 'PASS' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
