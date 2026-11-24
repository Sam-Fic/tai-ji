#!/usr/bin/env node
/**
 * AC-CHIP / AC-RUN 真机探针：进行中的过程卡（tape-live 枝）。
 *
 * 断言（真机 DOM）：
 *  思考流式期间：卡头活动 chip =「思考」+ 计时，计时随时间增长；窗口里没有别的实时计时；
 *                点 chip 点开该段思考，再点收回。
 *  命令执行期间：chip =「执行命令」+ 计时，计时随时间增长；
 *                执行中的命令行行尾显示最新一行输出（随命令的输出前进）与光标，不显示耗时、不带工具名。
 *  落成后：chip 消失。
 *
 * faux 脚本：一段 40 行的思考（流式约 10 秒）+ 一条每 2 秒输出一行的命令（12 秒）+ 收尾文本。
 */
import fs from 'node:fs'
import { boot, sleep } from './harness.mjs'

const OUTPUT_LINES = 6
const THINKING = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 步：先看一下目录里有什么，再决定下一步做什么。`).join('\n')
const steps = [
  {
    thinking: THINKING,
    toolCalls: [{ name: 'bash', args: { command: `for i in $(seq 1 ${OUTPUT_LINES}); do echo "tp-out-$i"; sleep 2; done` } }],
    stopReason: 'toolUse',
  },
  { text: '跑完了。', stopReason: 'stop' },
]

/** 进行中形态：chip 的类型词与计时、窗口内各类计时节点、执行中命令行的行尾 */
const liveState = (page) =>
  page.evaluate(() => {
    const last = (selector) => {
      const nodes = document.querySelectorAll(selector)
      return nodes[nodes.length - 1] ?? null
    }
    const chip = last('[data-testid="agg-activity-chip"]')
    const win = last('[data-testid="agg-tape-scroll"]')
    const row = last('[data-testid="agg-tool-row"]')
    const meta = document.querySelector('[data-testid^="turn-meta-"]')
    return {
      chip: !!chip,
      chipLabel: (chip?.querySelector('[data-testid="agg-activity-label"]')?.textContent ?? '').trim(),
      chipDuration: (chip?.querySelector('[data-testid="agg-activity-duration"]')?.textContent ?? '').trim(),
      // 窗口内的计时节点（行内历史耗时）：进行中它们只能属于已结束的步骤
      windowTimers: win
        ? Array.from(win.querySelectorAll('[data-testid="agg-thinking-duration"], [data-testid="agg-tool-duration"]')).map((n) => (n.textContent ?? '').trim())
        : null,
      runningRow: !!row && !!row.querySelector('.agg-cursor'),
      rowText: (row?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      tail: (row?.querySelector('[data-testid="agg-tool-tail"]')?.textContent ?? '').trim(),
      rowDuration: !!row?.querySelector('[data-testid="agg-tool-duration"]'),
      thinkingToggle: !!win?.querySelector('[data-testid="agg-thinking-toggle"]'),
      settled: (meta?.textContent ?? '').includes('已工作'),
    }
  })

/** 计时文本 → 秒（3s → 3，1m02s → 62）；不是计时格式 → NaN */
const seconds = (text) => {
  const min = /^(\d+)m(\d\d)s$/.exec(text)
  if (min) return Number(min[1]) * 60 + Number(min[2])
  return Number(/^(\d+)s$/.exec(text)?.[1] ?? Number.NaN)
}

const inst = await boot({ steps, label: `tp-chip-${Date.now()}`, tps: '30' })
const { ws, sessionId, page, cleanup } = inst
const problems = []
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `（${extra}）` : ''}`)
  if (!ok) problems.push(name)
}
try {
  await ws.send(JSON.stringify({ type: 'message.send', id: 'chip-send', payload: { sessionId, content: '帮我看看目录。' } }))
  await page.locator('[data-testid="agg-activity-chip"]').last().waitFor({ state: 'visible', timeout: 60_000 })

  // ── 思考流式期间 ─────────────────────────────────────────────
  const thinkSamples = []
  const thinkDeadline = Date.now() + 40_000
  while (Date.now() < thinkDeadline) {
    const s = await liveState(page)
    if (s.settled || s.chipLabel !== '思考') break
    thinkSamples.push(s)
    // 采够就停：chip 只在思考流式期间可点，要赶在它结束前做点开/收回
    if (thinkSamples.length >= 14 && seconds(s.chipDuration) - seconds(thinkSamples[0].chipDuration) >= 2) break
    await sleep(200)
  }
  const firstThink = thinkSamples[0]
  const lastThink = thinkSamples.at(-1)
  const grew = seconds(lastThink?.chipDuration) - seconds(firstThink?.chipDuration)
  check('思考中：卡头 chip =「思考」+ 计时', thinkSamples.length >= 3 && thinkSamples.every((s) => s.chip && s.chipLabel === '思考' && !Number.isNaN(seconds(s.chipDuration))), `${thinkSamples.length} 个样本，计时「${firstThink?.chipDuration}」→「${lastThink?.chipDuration}」`)
  check('思考中：计时随时间增长', grew >= 2, `增长 ${grew} 秒`)
  check('思考中：窗口里没有别的计时（流式中的思考行不带时长）', thinkSamples.every((s) => Array.isArray(s.windowTimers) && s.windowTimers.length === 0), `窗口内计时节点 ${lastThink?.windowTimers?.length ?? '?'} 个`)

  // ── 点 chip：点开 / 收回该段思考 ─────────────────────────────
  const chip = page.locator('[data-testid="agg-activity-chip"]').last()
  await chip.click()
  await sleep(300)
  const opened = await liveState(page)
  check('思考中：点 chip 点开该段思考（出现标签行）', opened.thinkingToggle === true && !opened.settled, '')
  if (!opened.settled) {
    await chip.click()
    await sleep(300)
    check('思考中：再点 chip 收回（标签行隐去）', (await liveState(page)).thinkingToggle === false, '')
  }

  // ── 命令执行期间 ─────────────────────────────────────────────
  const runSamples = []
  const runDeadline = Date.now() + 40_000
  while (Date.now() < runDeadline) {
    const s = await liveState(page)
    if (s.settled) break
    if (s.chipLabel === '执行命令' && s.runningRow) {
      runSamples.push(s)
      // 等到输出至少前进过一次再收尾
      if (runSamples.length >= 8 && /tp-out-[3-9]/.test(s.tail)) break
      await sleep(250)
      continue
    }
    if (runSamples.length > 0) break
    await sleep(150)
  }
  const firstRun = runSamples[0]
  const lastRun = runSamples.at(-1)
  const tailNo = (s) => Number(/tp-out-(\d+)/.exec(s?.tail ?? '')?.[1] ?? 0)
  const runGrew = seconds(lastRun?.chipDuration) - seconds(firstRun?.chipDuration)
  check('执行命令中：chip =「执行命令」+ 计时，计时增长', runSamples.length >= 4 && runSamples.every((s) => s.chipLabel === '执行命令' && !Number.isNaN(seconds(s.chipDuration))) && runGrew >= 2, `${runSamples.length} 个样本，计时「${firstRun?.chipDuration}」→「${lastRun?.chipDuration}」`)
  check('执行命令中：命令行行尾显示最新一行输出，且随命令的输出前进', tailNo(lastRun) >= tailNo(firstRun) + 1 && tailNo(lastRun) >= 2, `输出尾行「${firstRun?.tail}」→「${lastRun?.tail}」`)
  check('执行命令中：命令行带光标、不显示耗时、不带工具名', runSamples.every((s) => s.runningRow && !s.rowDuration && !/\bbash\b/.test(s.rowText)), lastRun?.rowText.slice(0, 90))
  check('执行命令中：chip 是窗口外唯一的实时计时', runSamples.every((s) => Array.isArray(s.windowTimers) && s.windowTimers.length === 1), `窗口内计时节点 ${lastRun?.windowTimers?.length ?? '?'} 个（已结束的思考行）`)

  // ── 落成后：chip 消失 ─────────────────────────────────────────
  const turnMeta = page.locator('[data-testid^="turn-meta-"]').first()
  const settledDeadline = Date.now() + 90_000
  while (Date.now() < settledDeadline) {
    if (((await turnMeta.textContent()) ?? '').includes('已工作')) break
    await sleep(500)
  }
  await turnMeta.click()
  await sleep(400)
  check('落成后：chip 消失', (await page.locator('[data-testid="agg-activity-chip"]').count()) === 0, '')

  if (problems.length > 0) throw new Error(problems.join('；'))
  console.log('OK-CHIP 卡头活动 chip = 此刻在做什么 + 计时（每秒增长、卡内唯一实时计时、可点开思考、落成后消失）')
  console.log('OK-RUN 执行中的命令行行尾显示最新一行输出与光标（随输出前进、不显示耗时、不带工具名）')
} catch (err) {
  console.error(`[probe] 失败：${err instanceof Error ? err.message : String(err)}`)
  try {
    console.error(`[probe] 末次状态：${JSON.stringify(await liveState(page))}`)
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
