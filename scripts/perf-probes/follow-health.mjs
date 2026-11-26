#!/usr/bin/env node
/**
 * 批2 真机探针 T4：贴底收敛 + RO 循环（b-layout：跟底 endOffset += headOffset 修 gap=29.5px；
 * wrap RO 回调业务侧几何读清理）。驱动流式 → 读 renderer 日志 delta 判定。
 *
 * 前置（验收流程保证，探针不起实例）：dev 实例运行中（faux 长流式），session 已建。
 *
 * 形态：node scripts/perf-probes/follow-health.mjs --data-dir <dir> --sid <sid> [--cdp-port 9478] [--timeout 150000]
 *
 * 动作：连 runtime WS → GUI 在场校验 → 快照日志（gap 警告 / RO loop 计数）→ 发 prompt 起流式
 *       → 等本 session message.complete → 再等 2500ms（pin-bottom-guard 的 500ms 收敛窗 +
 *         200ms 复采跑完，gap 警告写进日志）→ 复测日志 → 判 delta。
 *
 * 判定：
 *   - gap_warnings delta === 0（贴底收敛修复生效：稳态 follow 落点 = 真实底部，guard 不再发声）；
 *   - RO loop delta 仅报数不断言归零（virtua 库内部「测量-写 spacer」反馈环为主体，本批业务侧
 *     射程内已做尽，docs/todo/resize-observer-loop-noise.md 已登记归因，不承诺清零）。
 *
 * 输出：gap_warnings=<delta> 与 ro_loop_delta=<delta>（附 before/after 绝对值）。
 *       PASS→exit 0 且输出含 gap_warnings=0。FAIL→exit 1。GUI 缺席/流式超时→exit 3。
 */
import { connectRuntime, connectRendererCdp, ensureGuiOnSession, waitForSessionComplete, countLogLines, parseFlags, sleep } from './lib/harness.mjs'

const flags = parseFlags()
const dataDir = flags['data-dir']
const sid = flags.sid
const cdpPort = Number(flags['cdp-port'] ?? 9478)
const timeoutMs = Number(flags.timeout ?? 150000)
const prompt = flags.text ?? '请给出性能优化实施方案'

if (!dataDir || !sid) {
  console.error('usage: node scripts/perf-probes/follow-health.mjs --data-dir <dir> --sid <sid> [--cdp-port 9478] [--timeout 150000]')
  process.exit(2)
}

// pin-bottom-guard gap 警告在 renderer-console（console.warn）；RO loop 错误在 renderer-error。
// gap 警告用 /pin-bottom-guard.*gap=/ 精确匹配（区别于同组件的 P-no-loop 频率警告，后者无 gap=）。
const GAP_RE = /pin-bottom-guard.*gap=/
const RO_RE = /ResizeObserver loop/

const rt = await connectRuntime(dataDir)
const cdp = await connectRendererCdp(cdpPort)
await ensureGuiOnSession(cdp, sid)

const gapBefore = countLogLines(dataDir, 'renderer-console', GAP_RE)
const roBefore = countLogLines(dataDir, 'renderer-error', RO_RE)
console.log(`[probe] snapshot before: gap=${gapBefore} ro=${roBefore}`)

const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
console.log('[probe] prompt submitted, waiting for message.complete...')

const done = await waitForSessionComplete(rt, sid, timeoutMs)
if (!done) {
  console.error(`[probe] 流式未在 ${timeoutMs}ms 内 complete——测量无效，拒绝判定`)
  cdp.close(); rt.ws.close(); process.exit(3)
}
// 收敛窗 + 双采样落地：complete 后 guard 才在稳态采样，留 >500+200ms 让警告（若有）落盘。
await sleep(2500)

const gapAfter = countLogLines(dataDir, 'renderer-console', GAP_RE)
const roAfter = countLogLines(dataDir, 'renderer-error', RO_RE)
const gapDelta = gapAfter - gapBefore
const roDelta = roAfter - roBefore
console.log(`[probe] snapshot after: gap=${gapAfter} ro=${roAfter}`)

cdp.close(); rt.ws.close()

console.log(`gap_warnings=${gapDelta} (before ${gapBefore} → after ${gapAfter})`)
console.log(`ro_loop_delta=${roDelta} (before ${roBefore} → after ${roAfter})`)

const pass = gapDelta === 0
console.log(pass ? 'RESULT follow-health PASS' : `RESULT follow-health FAIL gap_warnings=${gapDelta}`)
process.exit(pass ? 0 : 1)
