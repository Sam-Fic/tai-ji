#!/usr/bin/env node
/**
 * AC-LIVE 真机探针：过程卡窗口的滚动跟随与提示（tape-scroll 枝）。
 *
 * 断言（真机 DOM + 真实指针）：
 *  进行中：窗口贴底跟随；提示「更早 N 条」；上滚后停吸并提示「回到最新」；点它恢复贴底
 *  落成后：打开窗口从第一条读起，提示「下面还有 N 条」；点它滚到底 →「回到开头」；点它回顶部
 *
 * faux 脚本：14 条各约 1 秒的命令（sleep 1 && echo）拉长进行中窗口，足够完成跟随类断言。
 */
import fs from 'node:fs'
import { boot, sleep } from './harness.mjs'

const hintOf = async (page) => {
  const hint = page.locator('[data-testid="agg-tape-hint"]').last()
  if ((await hint.count()) === 0) return ''
  return ((await hint.textContent()) ?? '').trim()
}
const scrollState = (page) =>
  page.evaluate(() => {
    const els = document.querySelectorAll('[data-testid="agg-tape-scroll"]')
    const el = els[els.length - 1]
    return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) }
  })
const atBottom = async (page) => {
  const s = await scrollState(page)
  return s.max - s.top <= 2
}
/** 同一帧内原子读取「最后一个窗口的几何 + 最后一个提示文案」——避免两次读取之间内容增长造成的读差 */
const snapshot = (page) =>
  page.evaluate(() => {
    const els = document.querySelectorAll('[data-testid="agg-tape-scroll"]')
    const el = els[els.length - 1]
    const hints = document.querySelectorAll('[data-testid="agg-tape-hint"]')
    const hint = hints[hints.length - 1]
    return {
      top: Math.round(el.scrollTop),
      max: Math.round(el.scrollHeight - el.clientHeight),
      hint: (hint?.textContent ?? '').trim(),
    }
  })
const clickHint = (page) => page.locator('[data-testid="agg-tape-hint"]').last().click()

const steps = [
  {
    thinking: '跑一串每条一秒的命令，把进行中窗口拉长，验证跟随与提示。',
    toolCalls: Array.from({ length: 14 }, (_, i) => ({ name: 'bash', args: { command: `sleep 1 && echo tp-step-${i + 1}` } })),
    stopReason: 'toolUse',
  },
  { text: '跑完了。', stopReason: 'stop' },
]

const inst = await boot({ steps, label: `tp-live-${Date.now()}`, tps: '50' })
const { ws, sessionId, page, cleanup } = inst
const problems = []
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `（${extra}）` : ''}`)
  if (!ok) problems.push(name)
}
try {
  await ws.send(JSON.stringify({ type: 'message.send', id: 'live-send', payload: { sessionId, content: '跑一遍这条每秒一步的长命令链。' } }))

  // ── 进行中：窗口默认展开、贴底跟随 ─────────────────────────────
  const tape = page.locator('[data-testid="agg-tape-scroll"]').last()
  await tape.waitFor({ state: 'visible', timeout: 60_000 })
  // 等内容长过窗口高度（>12 行）再断言（否则没有「更早」可言）
  const growDeadline = Date.now() + 60_000
  while (Date.now() < growDeadline) {
    const st = await scrollState(page)
    if (st.max > 0) break
    await sleep(400)
  }
  await sleep(300)
  check('进行中：窗口贴底跟随', await atBottom(page))
  const hintLive = await hintOf(page)
  const m2 = hintLive.match(/更早 (\d+) 条/)
  check('进行中贴底时提示「更早 N 条」', !!m2 && Number(m2[1]) > 0, hintLive)

  await tape.hover()
  await page.mouse.wheel(0, -240)
  await sleep(400)
  check('上滚后提示「回到最新」', (await hintOf(page)) === '回到最新', await hintOf(page))
  check('上滚后不再贴底', !(await atBottom(page)))
  await clickHint(page)
  await sleep(700)
  check('点「回到最新」后恢复贴底', await atBottom(page))

  // ── 落成后：收一行 → 展开回合 → 开窗口 ─────────────────────────
  const turnMeta = page.locator('[data-testid^="turn-meta-"]').first()
  const settledDeadline = Date.now() + 120_000
  while (Date.now() < settledDeadline) {
    if (((await turnMeta.textContent()) ?? '').includes('已工作')) break
    await sleep(500)
  }
  if (!((await turnMeta.textContent()) ?? '').includes('已工作')) throw new Error('回合未在限时内落成（轮头仍显示工作中）')
  await sleep(300)
  await turnMeta.click()
  const card = page.locator('[data-testid="process-aggregate"]').first()
  await card.waitFor({ state: 'visible', timeout: 20_000 })
  if ((await page.locator('[data-testid="agg-tape-scroll"]').count()) === 0) await card.locator('[data-testid="agg-summary-row"]').click()
  await page.locator('[data-testid="agg-tape-scroll"]').first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('[data-testid="agg-tape-hint"]').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})

  const hintBelow = await hintOf(page)
  const m = hintBelow.match(/下面还有 (\d+) 条/)
  check('落成后打开窗口：提示「下面还有 N 条」', !!m && Number(m[1]) > 0, hintBelow)
  check('落成后打开窗口：停在第 1 条（未贴底）', !(await atBottom(page)))

  await clickHint(page)
  await sleep(600)
  check('点「下面还有」后滚到底', await atBottom(page))
  check('滚到底后提示「回到开头」', (await hintOf(page)) === '回到开头', await hintOf(page))
  await clickHint(page)
  await sleep(600)
  const s = await scrollState(page)
  check('点「回到开头」后回到顶部', s.top === 0, `top=${s.top}`)
  check('回顶部后提示回到「下面还有 N 条」', /下面还有 \d+ 条/.test(await hintOf(page)), await hintOf(page))

  if (problems.length > 0) throw new Error(problems.join('；'))
  console.log('OK-LIVE 跟随 / 暂停 / 更早 / 下面还有 / 回到最新 / 回到开头 全部通过')
} catch (err) {
  console.error(`[probe] 失败：${err instanceof Error ? err.message : String(err)}`)
  try {
    const dump = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid'))
      const el = document.querySelector('[data-testid="agg-tape-scroll"]')
      return JSON.stringify({
        metaIds: ids.filter((i) => i && i.startsWith('turn-meta-')),
        cards: ids.filter((i) => i === 'process-aggregate').length,
        geo: el ? { ch: el.clientHeight, sh: el.scrollHeight, top: Math.round(el.scrollTop) } : null,
        streamTail: (document.body.textContent ?? '').slice(-300),
      })
    })
    console.error(`[probe] DOM 取证：${dump}`)
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
}
