#!/usr/bin/env node
/**
 * 批3 真机探针 T3：降级路径（worker 不可用 → 回退主线程同步高亮，高亮不丢）。
 *
 * 前置（由验收流程保证）：dev 实例已起，session 已建。
 *
 * 形态：node probes/shiki-fallback-probe.mjs --data-dir <dir> --sid <sid> [--timeout-ms 240000]
 *
 * 动作：
 *   ① Page.reload（刷新页面 = 客户端模块状态重置，确保无既有 worker 单例——客户端惰性
 *      建 worker，长生命期页面里前几次渲染可能已建，直接打桩会落空）；
 *   ② 等 app 就绪（侧栏在场）→ Runtime.evaluate 把 window.Worker 换成「构造即抛错」的桩
 *      （模拟 worker 不可用：CSP 被外部策略拦 / 环境无 Worker。实测本 Electron 版本
 *      Network.setBlockedURLs 不拦截 worker 脚本加载，故用构造抛错桩触发同一 degrade
 *      路径；error 事件路径由单测 shiki-highlight.test.ts 覆盖）；
 *   ③ delivery.submit 发 prompt → 等 complete → 断言：高亮保留（pre.shiki + token span
 *      在场，非纯文本降级）、内容完整、降级出声（console 有 fallback 日志——不静默）。
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
await cdp.send('Page.enable')

// ① 刷新页面：重置渲染进程模块状态（客户端 worker 单例惰性创建，长生命期页面里前几次
//    渲染可能已建成——直接打桩会因 `worker !== null` 复用而落空）。刷新后 app 自动重连。
await cdp.send('Page.reload')
console.log('[probe] page reloaded (fresh module state)')

// ② 等 app 就绪：侧栏会话项在场（事件驱动轮询，预算内等待）
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

// ③ worker 不可用桩：构造即抛错（客户端 ensureWorker catch → degrade → 主线程同步回退）
await cdp.send('Runtime.evaluate', {
  expression: `window.Worker = class { constructor() { throw new Error('probe: worker unavailable') } }`,
})
console.log('[probe] window.Worker stubbed to throw (worker unavailable)')

await ensureGuiOnSession(cdp, sid)

const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
console.log('[probe] prompt submitted, streaming with unavailable worker...')

const endFrame = await waitForSessionComplete(rt, sid, timeoutMs)
if (!endFrame) {
  console.error('[probe] 流式未在显式预算内完成——弃测')
  cdp.close()
  rt.ws.close()
  process.exit(3)
}
console.log(`[probe] stream complete: ${endFrame.type}`)

// finalize + 回填轮询（预算内事件驱动等待）。轮询带 GUI sid 与 rAF 存活诊断：
// 页面刷新后若 GUI 漂移或 rAF 停摆，回填会迟到——诊断字段让失败可归因。
const deadline = Date.now() + 60000
let dom = { shikiPre: 0, shikiSpans: 0, codeChars: 0, sid: '', mdRenders: 0, rafFired: false }
let polls = 0
while (Date.now() < deadline) {
  polls++
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const rafFired = await new Promise((res) => { let done = false; requestAnimationFrame(() => { if (!done) { done = true; res(true) } }); setTimeout(() => { if (!done) { done = true; res(false) } }, 800) })
      return JSON.stringify({
        sid: document.querySelector('[data-session-id]')?.getAttribute('data-session-id') || '',
        mdRenders: document.querySelectorAll('.md-render').length,
        shikiPre: document.querySelectorAll('pre.shiki').length,
        shikiSpans: document.querySelectorAll('pre.shiki [style*="--shiki-dark"]').length,
        codeChars: (document.querySelector('pre.shiki')?.textContent ?? '').length,
        rafFired,
      })
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  dom = JSON.parse(r.result?.value ?? '{}')
  if (dom.shikiSpans >= 1) break
  await sleep(500)
}
console.log(`[probe] final DOM (polls=${polls}): sid=${dom.sid} mdRenders=${dom.mdRenders} pre.shiki=${dom.shikiPre} spans=${dom.shikiSpans} codeChars=${dom.codeChars} rafFired=${dom.rafFired}`)

cdp.close()
rt.ws.close()

// 降级出声：console 里出现 degrade 日志（不静默是硬要求）。
// 精确匹配 [shiki-highlight] 前缀——宽松 /degrad/ 会误中 user-delivery 的
// 「degraded into stream」噪声警告。
const fallbackLogs = consoleMessages.filter((m) => /\[shiki-highlight\].*(unavailable|fallback)/i.test(m.text))
for (const m of fallbackLogs) console.log(`[console:${m.type}] ${m.text}`)
const fallbackLogged = fallbackLogs.length > 0
const highlighted = dom.shikiPre >= 1 && dom.shikiSpans >= 1
const contentPreserved = dom.codeChars > 1000
const preserved = highlighted && contentPreserved
const pass = preserved && fallbackLogged
console.log(`RESULT fallback-highlight-preserved:${preserved} highlighted:${highlighted} fallback-logged:${fallbackLogged} ${pass ? 'PASS' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
