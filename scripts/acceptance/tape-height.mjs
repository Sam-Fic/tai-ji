#!/usr/bin/env node
/**
 * AC-H12 真机探针：过程卡窗口 12 行上限（trunk case）。
 * 装配：开发实例 + faux 演员（14 条 bash 调用的长回合）；落成后打开窗口，断言
 * 卡片 ≤316px、窗口 ≤288px、工具行行高 24px 且行间无间隙、前 12 个工具步合计正好 288px、
 * 窗口内工具步数 > 12 且内容溢出被裁剪。装配细节见 harness.mjs。
 */
import fs from 'node:fs'
import path from 'node:path'
import { boot, longChainSteps, sleep, wsRoundTrip } from './harness.mjs'

const CARD_MAX_PX = 316
const WINDOW_MAX_PX = 288
const TOLERANCE_PX = 2
const MIN_ROWS = 13

const inst = await boot({ steps: longChainSteps(14), label: `tp-h12-${Date.now()}` })
const { ws, sessionId, page, cleanup } = inst
try {
  await wsRoundTrip(ws, { type: 'message.send', id: 'h12-send', payload: { sessionId, content: '跑一遍这条长命令链，然后收尾。' } }, 'h12-send')

  // 回合落成后默认折叠（只留末位正文）：先点轮头展开回合，过程卡才挂载
  const turnMeta = page.locator('[data-testid^="turn-meta-"]').first()
  await turnMeta.waitFor({ state: 'visible', timeout: 60_000 })
  const settledDeadline = Date.now() + 120_000
  while (Date.now() < settledDeadline) {
    if (((await turnMeta.textContent()) ?? '').includes('已工作')) break
    await sleep(500)
  }
  if (!((await turnMeta.textContent()) ?? '').includes('已工作')) throw new Error('回合未在限时内落成（轮头仍显示工作中）')
  await turnMeta.click()

  const card = page.locator('[data-testid="agg-tape"]').first()
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  const tape = page.locator('[data-testid="agg-tape-scroll"]').first()
  if ((await tape.count()) === 0) await card.locator('[data-testid="agg-summary-row"]').click()
  await tape.waitFor({ state: 'visible', timeout: 15_000 })
  await sleep(900) // 等行入场动效结束再量

  const dims = await card.evaluate((el) => {
    const scroll = el.querySelector('[data-testid="agg-tape-scroll"]')
    const rows = Array.from(el.querySelectorAll('[data-testid="agg-tool-row"]')).map((row) => row.getBoundingClientRect())
    return {
      card: el.getBoundingClientRect().height,
      window: scroll.getBoundingClientRect().height,
      windowClient: scroll.clientHeight,
      windowScroll: scroll.scrollHeight,
      rows: rows.length,
      rowHeights: rows.map((r) => r.height),
      // 相邻工具行的顶边差（行间无间隙时恒等于行高）
      rowGaps: rows.slice(1).map((r, i) => r.top - rows[i].top),
      // 前 12 个工具步合计高度（12 行 × 24px = 288px）
      first12: rows.length >= 12 ? rows[11].bottom - rows[0].top : 0,
    }
  })
  console.log(`[probe] 量得：卡片 ${dims.card}px / 窗口 ${dims.window}px / 工具行 ${dims.rows} / 行高 ${[...new Set(dims.rowHeights.map((h) => h.toFixed(1)))].join(',')} / 行距 ${[...new Set(dims.rowGaps.map((g) => g.toFixed(1)))].join(',')} / 前 12 行 ${dims.first12.toFixed(1)}px`)

  const problems = []
  if (dims.card > CARD_MAX_PX + TOLERANCE_PX) problems.push(`卡片高度 ${dims.card}px > ${CARD_MAX_PX}px`)
  if (dims.window > WINDOW_MAX_PX + TOLERANCE_PX) problems.push(`窗口高度 ${dims.window}px > ${WINDOW_MAX_PX}px`)
  if (dims.rows < MIN_ROWS) problems.push(`窗口内工具行 ${dims.rows} < ${MIN_ROWS}（长回合未造出 12 行以上的内容）`)
  if (dims.windowScroll <= dims.windowClient) problems.push('窗口内容未溢出（12 行上限没有被行使）')
  if (!dims.rowHeights.every((h) => Math.abs(h - 24) <= 0.5)) problems.push(`行高不是 24px：${dims.rowHeights.map((h) => h.toFixed(1)).join(', ')}`)
  if (!dims.rowGaps.every((g) => Math.abs(g - 24) <= 0.5)) problems.push(`行间有间隙：${dims.rowGaps.map((g) => g.toFixed(1)).join(', ')}`)
  if (Math.abs(dims.first12 - WINDOW_MAX_PX) > 0.5) problems.push(`前 12 行合计 ${dims.first12.toFixed(1)}px ≠ ${WINDOW_MAX_PX}px（窗口内放不下 12 整行）`)
  if (problems.length > 0) throw new Error(problems.join('；'))

  const shotsDir = path.join(process.cwd(), '.run', 'shots')
  fs.mkdirSync(shotsDir, { recursive: true })
  await card.screenshot({ path: path.join(shotsDir, 'h12-card.png') })
  console.log(`OK-H12 卡片 ${dims.card}px / 窗口 ${dims.window}px / 工具行 ${dims.rows} / 行高 24px 无间隙`)
} catch (err) {
  console.error(`[probe] 失败：${err instanceof Error ? err.message : String(err)}`)
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
