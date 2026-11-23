#!/usr/bin/env node
/**
 * 批2 真机探针 T6：EdgeFade mask 常量等价（b-polish：N1 mask 串提取为模块级常量；叠加 b-layout
 * 的 IO 哨兵驱动 on）。滚离顶激活渐焦 → scroller maskImage = active 常量（非空 linear-gradient）；
 * 贴顶 → maskImage 空。
 *
 * 前置（验收流程保证，探针不起实例）：dev 实例运行中（faux 长流式），session 已建。
 *
 * 形态：node probes/edge-fade-mask.mjs --data-dir <dir> --sid <sid> [--cdp-port 9478] [--timeout 150000]
 *
 * 动作：GUI 校验 → 发 prompt 起流式（需可滚动内容）→ 等 message.complete →
 *       ① scrollTop=0 等 300ms 读 maskImage（期望空，贴顶不渐焦）；
 *       ② scrollTop=200 等 400ms（IO 哨兵布局后投递）读 maskImage（期望含 linear-gradient，滚离顶激活）；
 *       ③ 断言两态 + [data-testid=edge-fade] 元素存在。
 *
 * 输出：edge-fade-mask top='<...>' scrolled=linear-gradient:<yes/no>；PASS→RESULT edge-fade-mask PASS。
 *       exit 0/1；GUI 缺席/流式超时→exit 3。
 */
import { connectRuntime, connectRendererCdp, ensureGuiOnSession, waitForSessionComplete, parseFlags, sleep } from './lib/harness.mjs'

const flags = parseFlags()
const dataDir = flags['data-dir']
const sid = flags.sid
const cdpPort = Number(flags['cdp-port'] ?? 9478)
const timeoutMs = Number(flags.timeout ?? 150000)
const prompt = flags.text ?? '请给出性能优化实施方案'

if (!dataDir || !sid) {
  console.error('usage: node probes/edge-fade-mask.mjs --data-dir <dir> --sid <sid> [--cdp-port 9478] [--timeout 150000]')
  process.exit(2)
}

const rt = await connectRuntime(dataDir)
const cdp = await connectRendererCdp(cdpPort)
await ensureGuiOnSession(cdp, sid)

const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
console.log('[probe] prompt submitted, waiting for message.complete...')
const done = await waitForSessionComplete(rt, sid, timeoutMs)
if (!done) {
  console.error(`[probe] 流式未在 ${timeoutMs}ms 内 complete——拒绝判定`)
  cdp.close(); rt.ws.close(); process.exit(3)
}

const evalExpr = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
  return r.result?.value
}

// edge-fade 元素在场（IO 哨兵化后仍是 sticky 渐焦带，fragment 多一个绝对哨兵节点）。
const fadePresent = await evalExpr(`!!document.querySelector('[data-testid="edge-fade"]')`)

// 滚离顶（scrollTop > 阈值）→ 渐焦激活 + mask = active 常量（linear-gradient 且含 13px 软 stop）。
// 注：「贴顶 mask 空」态在跟底会话不可达（follow 拉回底部、哨兵恒滚离视口顶），由单测
// edge-fade-sentinel 覆盖（stubGlobal IO trigger isIntersecting=true → on=false → mask ''）；
// 本真机 case 只验 N1 mask 常量在真实 DOM 生效（对齐设计意图「滚离顶 → active 常量」）。
await evalExpr(`(() => { const el = document.querySelector('[data-testid="message-stream"]'); if (el) el.scrollTop = 200; return true })()`)
await sleep(400)
const scrolledMask = String(await evalExpr(`document.querySelector('[data-testid="message-stream"]')?.style.maskImage || ''`) ?? '')

cdp.close(); rt.ws.close()

const scrolledActive = scrolledMask.includes('linear-gradient') && scrolledMask.includes('13px')
console.log(`edge-fade-mask scrolled mask='${scrolledMask.slice(0, 60)}' active=${scrolledActive} (present=${fadePresent})`)

const pass = fadePresent && scrolledActive
console.log(pass ? 'RESULT edge-fade-mask PASS' : `RESULT edge-fade-mask FAIL present=${fadePresent} scrolledActive=${scrolledActive}`)
process.exit(pass ? 0 : 1)
