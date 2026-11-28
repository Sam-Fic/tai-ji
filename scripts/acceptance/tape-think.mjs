#!/usr/bin/env node
/**
 * AC-THINK 真机探针：思考行三态（tape-think 枝）。
 *
 * 断言（真机 DOM）：
 *  进行中的思考：不显示标签，只露最新一行（行高 24px，内容被裁、末尾一行可见）带光标；
 *  思考结束：变成一行标签（灯泡 + 思考 + 时长 + 箭头），高 24px，不带正文；
 *  点标签：全文区在场、行高超过一行；再点：收回一行。
 *
 * faux 脚本：一段 40 行的思考（流式输出要持续几秒才采得到样本）+ 两条命令 + 收尾文本。
 */
import fs from 'node:fs'
import { boot, sleep } from './harness.mjs'

const THINKING_LINES = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 步：先看一下目录里有什么，再决定下一步做什么。`)
const steps = [
  {
    thinking: THINKING_LINES.join('\n'),
    toolCalls: [
      { name: 'bash', args: { command: 'sleep 4 && echo tp-think-1' } },
      { name: 'bash', args: { command: 'echo tp-think-2' } },
    ],
    stopReason: 'toolUse',
  },
  { text: '看完了。', stopReason: 'stop' },
]

/** 思考行的当前形态 */
const thinkState = (page) =>
  page.evaluate(() => {
    const rows = document.querySelectorAll('[data-testid="agg-thinking-row"]')
    const row = rows[rows.length - 1]
    if (!row) return null
    const text = row.querySelector('[data-testid="agg-thinking-text"]')
    const toggle = row.querySelector('[data-testid="agg-thinking-toggle"]')
    const meta = document.querySelector('[data-testid^="turn-meta-"]')
    return {
      rowH: row.getBoundingClientRect().height,
      hasToggle: !!toggle,
      duration: (row.querySelector('[data-testid="agg-thinking-duration"]')?.textContent ?? '').trim(),
      hasText: !!text,
      tail: text?.classList.contains('is-tail') ?? false,
      textH: text ? text.getBoundingClientRect().height : 0,
      textScrollH: text?.scrollHeight ?? 0,
      textClientH: text?.clientHeight ?? 0,
      cursor: !!text?.querySelector('.agg-cursor'),
      // 文字块的高度（保持内容高度：超过一行 = 最新一行之外的文字都在它里面）
      blockH: text?.querySelector('.agg-think-in')?.getBoundingClientRect().height ?? 0,
      // 最新一行露出来 ⇔ 行尾光标落在正文区的可视范围内；光标与最后一个字符同一行时，该字符也在范围内
      // （文本以换行结尾时，光标在下面的空行上——那一行就是最新一行。
      //   贴底对齐时多出的文字在上方，不进 scrollHeight，不能拿内容高度判断）
      tailInView: (() => {
        const block = text?.querySelector('.agg-think-in')
        const cursorEl = text?.querySelector('.agg-cursor')
        if (!text || !block || !cursorEl || !block.firstChild) return false
        const node = block.firstChild
        if (node.textContent.length < 6) return false
        const box = text.getBoundingClientRect()
        const range = document.createRange()
        // 只取最后一个字符：取多个字符时它们可能跨行折行，量出来的范围不代表「最新一行」
        range.setStart(node, node.textContent.length - 1)
        range.setEnd(node, node.textContent.length)
        const lastText = range.getBoundingClientRect()
        const caret = cursorEl.getBoundingClientRect()
        const inside = (r) => r.height > 0 && r.bottom <= box.bottom + 1 && r.top >= box.top - 1
        const sameLine = lastText.top < caret.bottom && caret.top < lastText.bottom
        if (inside(caret) && (!sameLine || inside(lastText))) return true
        return `box ${box.top.toFixed(0)}..${box.bottom.toFixed(0)} text ${lastText.top.toFixed(0)}..${lastText.bottom.toFixed(0)} caret ${caret.top.toFixed(0)}..${caret.bottom.toFixed(0)} 尾「${node.textContent.slice(-4)}」`
      })(),
      settled: (meta?.textContent ?? '').includes('已工作'),
    }
  })

const inst = await boot({ steps, label: `tp-think-${Date.now()}`, tps: '30' })
const { ws, sessionId, page, cleanup } = inst
const problems = []
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `（${extra}）` : ''}`)
  if (!ok) problems.push(name)
}
try {
  await ws.send(JSON.stringify({ type: 'message.send', id: 'think-send', payload: { sessionId, content: '帮我看看目录。' } }))
  await page.locator('[data-testid="agg-tape-scroll"]').last().waitFor({ state: 'visible', timeout: 60_000 })

  // ── 进行中的思考：只露最新一行 ────────────────────────────────
  const tailSamples = []
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    const s = await thinkState(page)
    if (!s) {
      await sleep(100)
      continue
    }
    if (s.hasToggle) break
    tailSamples.push(s)
    await sleep(150)
  }
  const tail = tailSamples.at(-1)
  check('进行中的思考：全程不显示标签', tailSamples.length >= 3 && tailSamples.every((s) => !s.hasToggle), `采样 ${tailSamples.length} 次`)
  check('进行中的思考：行高 24px', !!tail && Math.abs(tail.rowH - 24) <= 0.5, `${tail?.rowH.toFixed(1)}px`)
  const clipped = tailSamples.filter((s) => s.tail && s.hasText && Math.abs(s.textH - 24) <= 0.5 && s.blockH > 24)
  check('进行中的思考：正文区恒为一行高，文字块保持完整高度（超过一行）', clipped.length >= 2, clipped.length ? `超过一行的样本 ${clipped.length} 次，末次正文区 ${tail?.textH.toFixed(1)}px / 文字块 ${tail?.blockH.toFixed(1)}px` : '未采到内容超过一行的样本')
  const outOfView = clipped.filter((s) => s.tailInView !== true)
  check('进行中的思考：最新一行在场（行尾光标落在可视范围内）', clipped.length >= 2 && outOfView.length === 0, outOfView.length ? `${outOfView.length} 个样本不在可视范围，例：${outOfView[0].tailInView}` : '')

  // ── 思考结束：一行标签 ─────────────────────────────────────────
  const label = await thinkState(page)
  check('思考结束：一行标签（带时长），不带正文', !!label && label.hasToggle && label.duration !== '' && !label.hasText, label ? `行高 ${label.rowH.toFixed(1)}px，时长「${label.duration}」` : '无思考行')
  check('思考结束：行高 24px', !!label && Math.abs(label.rowH - 24) <= 0.5, `${label?.rowH.toFixed(1)}px`)

  // ── 点开全文 → 再点收回 ──────────────────────────────────────
  const toggle = page.locator('[data-testid="agg-thinking-toggle"]').last()
  await toggle.click()
  await sleep(400)
  const opened = await thinkState(page)
  check('点标签：全文区在场，行高超过一行', !!opened && opened.hasText && !opened.tail && opened.rowH > 24 && opened.rowH <= 24 + 2 + 244, `行高 ${opened?.rowH.toFixed(1)}px`)
  await toggle.click()
  await sleep(300)
  const closed = await thinkState(page)
  check('再点：收回一行', !!closed && !closed.hasText && Math.abs(closed.rowH - 24) <= 0.5, `行高 ${closed?.rowH.toFixed(1)}px`)

  if (problems.length > 0) throw new Error(problems.join('；'))
  console.log('OK-THINK 进行中只露最新一行 / 结束后一行标签 / 点开全文 / 再点收回 全部通过')
} catch (err) {
  console.error(`[probe] 失败：${err instanceof Error ? err.message : String(err)}`)
  try {
    console.error(`[probe] 末次思考行状态：${JSON.stringify(await thinkState(page))}`)
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
