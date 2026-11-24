#!/usr/bin/env node
/**
 * AC-SETTLE / AC-DETAIL 真机探针：落成后的过程卡（tape-settle 枝）。
 *
 * 断言（真机 DOM + 真实指针）：
 *  AC-SETTLE：回合落成后过程卡随回合收起（不占对话流）；展开回合后卡 = 一行 28px（没有窗口）；
 *             点卡头展开窗口并从第一条读起；再点收起。
 *  AC-DETAIL：窗口里点一条工具行 → 右侧详情抽屉打开（role=dialog、带工具参数）；Esc 关闭。
 *
 * faux 脚本：一段思考 + 三条命令 + 收尾文本。
 */
import fs from 'node:fs'
import { boot, sleep } from './harness.mjs'

const steps = [
  {
    thinking: '先看一下目录里有什么。',
    toolCalls: [
      { name: 'bash', args: { command: 'pwd' } },
      { name: 'bash', args: { command: 'ls -la' } },
      { name: 'read', args: { path: 'README.md' } },
    ],
    stopReason: 'toolUse',
  },
  { text: '目录看完了。', stopReason: 'stop' },
]

const cardState = (page) =>
  page.evaluate(() => {
    const card = document.querySelector('[data-testid="agg-tape"]')
    const win = document.querySelector('[data-testid="agg-tape-scroll"]')
    const meta = document.querySelector('[data-testid^="turn-meta-"]')
    return {
      card: card ? Math.round(card.getBoundingClientRect().height * 10) / 10 : null,
      window: !!win,
      rows: win ? win.querySelectorAll('[data-testid^="agg-row-"]').length : 0,
      top: win ? Math.round(win.scrollTop) : -1,
      meta: (meta?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
    }
  })

const inst = await boot({ steps, label: `tp-settle-${Date.now()}`, tps: '40' })
const { ws, sessionId, page, cleanup } = inst
const problems = []
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `（${extra}）` : ''}`)
  if (!ok) problems.push(name)
}
try {
  await ws.send(JSON.stringify({ type: 'message.send', id: 'settle-send', payload: { sessionId, content: '看看目录。' } }))
  const turnMeta = page.locator('[data-testid^="turn-meta-"]').first()
  await turnMeta.waitFor({ state: 'visible', timeout: 60_000 })
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (((await turnMeta.textContent()) ?? '').includes('已工作')) break
    await sleep(500)
  }
  if (!((await turnMeta.textContent()) ?? '').includes('已工作')) throw new Error('回合未在限时内落成（轮头仍显示工作中）')

  // ── 落成后：过程卡随回合收起 ──────────────────────────────────
  await sleep(500)
  const folded = await cardState(page)
  check('落成后：过程卡随回合收起（不占对话流）', folded.card === null && folded.meta.includes('已工作'), folded.meta)

  // ── 展开回合：卡只剩一行 ───────────────────────────────────────
  await turnMeta.click()
  await sleep(500)
  const oneLine = await cardState(page)
  check('展开回合：过程卡 = 一行 28px（没有窗口）', oneLine.card !== null && Math.abs(oneLine.card - 28) <= 1 && !oneLine.window, `卡片 ${oneLine.card}px，窗口${oneLine.window ? '在场' : '不在场'}`)

  // ── 点卡头：展开窗口、从第一条读起；再点收起 ──────────────────
  const head = page.locator('[data-testid="agg-summary-row"]').first()
  await head.click()
  await sleep(700)
  const opened = await cardState(page)
  check('点卡头：窗口展开、从第一条读起', opened.window && opened.rows >= 4 && opened.top === 0, `行 ${opened.rows}、位置 ${opened.top}`)
  await head.click()
  await sleep(400)
  const closed = await cardState(page)
  check('再点卡头：收成一行', !closed.window && Math.abs(closed.card - 28) <= 1, `卡片 ${closed.card}px`)

  // ── AC-DETAIL：点工具行 → 右侧抽屉 ────────────────────────────
  await head.click()
  await sleep(600)
  const toolRow = page.locator('[data-testid="agg-tool-row"]').first()
  await toolRow.click()
  const drawer = page.locator('[data-testid="tool-detail-drawer"]').first()
  await drawer.waitFor({ state: 'visible', timeout: 15_000 })
  const detail = await drawer.evaluate((el) => ({
    role: el.getAttribute('role'),
    modal: el.getAttribute('aria-modal'),
    params: (el.querySelector('[data-testid="agg-detail-params"]')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }))
  check('点工具行：右侧详情抽屉打开', detail.role === 'dialog' && detail.modal === 'true' && /\bpwd\b/.test(detail.params), `role=${detail.role} 参数「${detail.params}」`)
  await page.keyboard.press('Escape')
  await sleep(600)
  check('Esc：抽屉关闭', (await page.locator('[data-testid="tool-detail-drawer"]').count()) === 0, '')

  if (problems.length > 0) throw new Error(problems.join('；'))
  console.log('OK-SETTLE 落成收起 / 展开一行 28px / 点开窗口从第一条读起 / 再点收成一行')
  console.log('OK-DETAIL 点工具行打开右侧详情抽屉（Esc 关闭）')
} catch (err) {
  console.error(`[probe] 失败：${err instanceof Error ? err.message : String(err)}`)
  try {
    console.error(`[probe] 末次卡片状态：${JSON.stringify(await cardState(page))}`)
  } catch {
    // 页面已断开
  }
  console.error(`[probe] 数据目录保留：${inst.dataDir}`)
  process.exitCode = 1
} finally {
  try {
    ws.close()
  } catch {
    // 连接已断开属正常收尾
  }
  await cleanup()
  if (process.exitCode !== 1) fs.rmSync(inst.dataDir, { recursive: true, force: true })
  process.exit(process.exitCode ?? 0)
}
