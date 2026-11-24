#!/usr/bin/env node
/**
 * AC-LIVE 真机探针：过程卡窗口的滚动跟随与提示（tape-scroll 枝）。
 *
 * 断言（真机 DOM + 真实指针）：
 *  进行中：内容不满 12 行时全程没有滚动提示；超过 12 行后持续贴底跟随，提示「更早 N 条」；
 *          上沿渐隐在场；上滚后停吸并提示「回到最新」，新行到来也不被拉回；点提示恢复贴底。
 *  落成后：打开窗口从第一条读起，提示「下面还有 N 条」；点它滚到底 →「回到开头」；点它回顶部。
 *
 * faux 脚本分两轮，每轮末尾一条长命令把回合按在进行中：
 *  第一轮：首条 2 秒（留出「内容不满 12 行」的观察窗）+ 11 条即时命令（堆到超过 12 行）+ 14 秒长命令；
 *  第二轮：思考 + 5 条即时命令 + 8 秒长命令——给「上滚停吸后新行到来」提供新行，并留出点提示的时间。
 */
import fs from 'node:fs'
import { boot, sleep } from './harness.mjs'

const sh = (command) => ({ name: 'bash', args: { command } })
const steps = [
  {
    thinking: '跑一串命令，把进行中窗口拉长，验证跟随与提示。',
    toolCalls: [
      sh('sleep 2 && echo tp-step-1'),
      ...Array.from({ length: 11 }, (_, i) => sh(`echo tp-step-${i + 2}`)),
      sh('sleep 14 && echo tp-hold-1'),
    ],
    stopReason: 'toolUse',
  },
  {
    thinking: '再来几条。',
    toolCalls: [...Array.from({ length: 5 }, (_, i) => sh(`echo tp-more-${i + 1}`)), sh('sleep 8 && echo tp-hold-2')],
    stopReason: 'toolUse',
  },
  { text: '跑完了。', stopReason: 'stop' },
]

/** 同一帧内读取「最后一个窗口的几何 + 行数 + 提示」 */
const snapshot = (page) =>
  page.evaluate(() => {
    const tapes = document.querySelectorAll('[data-testid="agg-tape-scroll"]')
    const el = tapes[tapes.length - 1]
    const hints = document.querySelectorAll('[data-testid="agg-tape-hint"]')
    const meta = document.querySelector('[data-testid^="turn-meta-"]')
    return {
      rows: el ? el.querySelectorAll('[data-testid^="agg-row-"]').length : 0,
      top: el ? Math.round(el.scrollTop) : -1,
      max: el ? Math.round(el.scrollHeight - el.clientHeight) : -1,
      mask: el ? getComputedStyle(el).maskImage : '',
      hint: (hints[hints.length - 1]?.textContent ?? '').trim(),
      settled: ((meta?.textContent ?? '').includes('已工作')),
    }
  })
const atBottom = (s) => s.max - s.top <= 2
const hintIs = (s, re) => re.test(s.hint)
const lastHint = (page) => page.locator('[data-testid="agg-tape-hint"]').last()

const inst = await boot({ steps, label: `tp-live-${Date.now()}`, tps: '50' })
const { ws, sessionId, page, cleanup } = inst
const problems = []
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `（${extra}）` : ''}`)
  if (!ok) problems.push(name)
}
try {
  await ws.send(JSON.stringify({ type: 'message.send', id: 'live-send', payload: { sessionId, content: '跑一遍这条每秒一步的长命令链。' } }))
  await page.locator('[data-testid="agg-tape-scroll"]').last().waitFor({ state: 'visible', timeout: 60_000 })

  // ── 进行中：采样到内容超过 12 行为止 ───────────────────────────
  const underSamples = []
  const overSamples = []
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const s = await snapshot(page)
    if (s.settled) break
    if (s.rows < 13) underSamples.push(s)
    else {
      overSamples.push(s)
      if (overSamples.length >= 6) break
      await sleep(350)
      continue
    }
    await sleep(120)
  }
  const wrongUnder = underSamples.filter((s) => s.hint !== '')
  check('进行中：内容不满 12 行时全程没有滚动提示', underSamples.length >= 3 && wrongUnder.length === 0, `采样 ${underSamples.length} 次${wrongUnder.length ? `，出现「${wrongUnder[0].hint}」` : ''}`)
  check('进行中：超过 12 行后持续贴底跟随', overSamples.length >= 4 && overSamples.every(atBottom), overSamples.map((s) => `${s.top}/${s.max}`).join(' '))
  check('进行中：贴底时提示「更早 N 条」', overSamples.length >= 4 && overSamples.every((s) => hintIs(s, /^更早 \d+ 条$/)), overSamples.at(-1)?.hint ?? '未到 12 行')
  check('进行中：上沿渐隐在场', !!overSamples.at(-1) && overSamples.at(-1).mask !== 'none' && overSamples.at(-1).mask !== '', overSamples.at(-1)?.mask?.slice(0, 40) ?? '')

  // ── 进行中：上滚停吸 ───────────────────────────────────────────
  const tape = page.locator('[data-testid="agg-tape-scroll"]').last()
  await tape.hover()
  await page.mouse.wheel(0, -240)
  await sleep(400)
  const afterWheel = await snapshot(page)
  check('上滚后提示「回到最新」', hintIs(afterWheel, /^回到最新$/), afterWheel.hint)
  check('上滚后不再贴底', !atBottom(afterWheel), `${afterWheel.top}/${afterWheel.max}`)
  // 等第二轮的新行到来（第一条长命令结束后才有），期间窗口不应被拉回底部
  let grown = null
  const growDeadline = Date.now() + 40_000
  while (Date.now() < growDeadline) {
    const s = await snapshot(page)
    if (s.settled) break
    if (s.rows >= afterWheel.rows + 3) {
      grown = s
      break
    }
    await sleep(200)
  }
  check('上滚后新行到来也不被拉回底部', !!grown && !atBottom(grown), grown ? `行数 ${afterWheel.rows}→${grown.rows}，位置 ${grown.top}/${grown.max}` : `未等到新行（停在 ${afterWheel.rows} 行）`)
  await lastHint(page).click()
  await sleep(900)
  const resumed = await snapshot(page)
  check('点「回到最新」后恢复贴底', atBottom(resumed), `${resumed.top}/${resumed.max}`)

  // ── 落成后：展开回合 → 打开窗口 ─────────────────────────────────
  const turnMeta = page.locator('[data-testid^="turn-meta-"]').first()
  const settledDeadline = Date.now() + 120_000
  while (Date.now() < settledDeadline) {
    if (((await turnMeta.textContent()) ?? '').includes('已工作')) break
    await sleep(500)
  }
  if (!((await turnMeta.textContent()) ?? '').includes('已工作')) throw new Error('回合未在限时内落成（轮头仍显示工作中）')
  await sleep(300)
  await turnMeta.click()
  const card = page.locator('[data-testid="agg-tape"]').first()
  await card.waitFor({ state: 'visible', timeout: 20_000 })
  if ((await page.locator('[data-testid="agg-tape-scroll"]').count()) === 0) await card.locator('[data-testid="agg-summary-row"]').click()
  await page.locator('[data-testid="agg-tape-scroll"]').first().waitFor({ state: 'visible', timeout: 20_000 })
  await sleep(700)

  const opened = await snapshot(page)
  check('落成后打开窗口：停在第 1 条', opened.top === 0, `top=${opened.top}`)
  check('落成后打开窗口：提示「下面还有 N 条」', hintIs(opened, /^下面还有 \d+ 条$/), opened.hint)
  check('落成后打开窗口：下沿渐隐在场', opened.mask !== 'none' && opened.mask !== '', opened.mask.slice(0, 40))
  await lastHint(page).click()
  await sleep(1200)
  const bottom = await snapshot(page)
  check('点「下面还有」后滚到底', atBottom(bottom), `${bottom.top}/${bottom.max}`)
  check('滚到底后提示「回到开头」', hintIs(bottom, /^回到开头$/), bottom.hint)
  await lastHint(page).click()
  await sleep(1200)
  const backTop = await snapshot(page)
  check('点「回到开头」后回到顶部', backTop.top === 0, `top=${backTop.top}`)
  check('回顶部后提示回到「下面还有 N 条」', hintIs(backTop, /^下面还有 \d+ 条$/), backTop.hint)

  if (problems.length > 0) throw new Error(problems.join('；'))
  console.log('OK-LIVE 无多余提示 / 贴底跟随 / 更早 N 条 / 上沿渐隐 / 上滚停吸 / 回到最新 / 下面还有 / 回到开头 全部通过')
} catch (err) {
  console.error(`[probe] 失败：${err instanceof Error ? err.message : String(err)}`)
  try {
    console.error(`[probe] 末次快照：${JSON.stringify(await snapshot(page))}`)
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
