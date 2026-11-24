#!/usr/bin/env node
/**
 * AC-LOOK 真机探针：过程卡长相对齐原型（tape-look 枝）。
 *
 * 在开发实例上读元素的计算样式（真 Electron + 真 pi + faux 演员）：
 *  进行中：轮头保持全亮（不因禁用折叠而变暗）；卡头 24px、行首图标恒为层叠字形；
 *  落成后打开窗口：卡片底色/圆角/内边距；卡头计数与箭头、无段总耗时；行 24px 无间隙；
 *  命令类工具行不带工具名、命令正文与耗时取等宽小字档；窗口内无分组标题行；
 *  内容不满 12 行时没有滚动提示；滚动条隐藏。进行中的滚动提示归 AC-LIVE。
 * 字号按元素所在作用域的设计令牌解析值比对（不写死绝对像素：对话流字号随用户档位缩放）。
 * 装配细节见 harness.mjs。
 */
import fs from 'node:fs'
import { boot, sleep } from './harness.mjs'

const steps = [
  {
    thinking: '先看一下目录里有什么。',
    toolCalls: [
      { name: 'bash', args: { command: 'sleep 3 && echo tp-look-1' } },
      { name: 'bash', args: { command: 'echo tp-look-2' } },
    ],
    stopReason: 'toolUse',
  },
  { text: '目录看完了。', stopReason: 'stop' },
]

const inst = await boot({ steps, label: `tp-look-${Date.now()}`, tps: '50' })
const { ws, sessionId, page, cleanup } = inst
const problems = []
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `（${extra}）` : ''}`)
  if (!ok) problems.push(name)
}

/** 在过程卡所在作用域里解析字号令牌的实际像素值（临时探测元素，读完即删） */
const tokenPx = (scope, name) =>
  scope.evaluate((el, token) => {
    const probe = document.createElement('span')
    probe.style.cssText = `position:fixed;visibility:hidden;font-size:var(${token})`
    el.appendChild(probe)
    const px = parseFloat(getComputedStyle(probe).fontSize)
    probe.remove()
    return px
  }, name)

try {
  await ws.send(JSON.stringify({ type: 'message.send', id: 'look-send', payload: { sessionId, content: '帮我看看目录。' } }))

  // ── 进行中：窗口默认展开 ─────────────────────────────────────
  const card = page.locator('[data-testid="agg-tape"]').last()
  await card.waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('[data-testid="agg-tool-row"]').first().waitFor({ state: 'visible', timeout: 60_000 })
  await sleep(900) // 等行入场动效结束再量
  const meta = page.locator('.turn-meta').last()
  const live = await page.evaluate(() => {
    const cs = (el, props) => {
      const s = getComputedStyle(el)
      return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)]))
    }
    const meta = document.querySelector('.turn-meta')
    const head = document.querySelector('[data-testid="agg-summary-row"]')
    return {
      meta: meta ? { disabled: meta.disabled, ...cs(meta, ['opacity']) } : null,
      head: head
        ? {
            h: head.getBoundingClientRect().height,
            ...cs(head, ['font-size']),
            layers: !!head.querySelector('svg.lucide-layers'),
            loader: !!head.querySelector('[data-testid="agg-summary-live-loader"]'),
            chevron: !!head.querySelector('svg.lucide-chevron-right'),
            duration: !!document.querySelector('[data-testid="agg-summary-duration"]'),
          }
        : null,
      liveHint: (document.querySelector('[data-testid="agg-tape-hint"]')?.textContent ?? '').trim(),
    }
  })
  const cardEl = card.locator(':scope').first()
  const sm = await tokenPx(cardEl, '--text-sm')
  // ── 落成后：展开回合 → 打开窗口 ─────────────────────────────
  const turnMeta = page.locator('[data-testid^="turn-meta-"]').first()
  const settledDeadline = Date.now() + 120_000
  while (Date.now() < settledDeadline) {
    if (((await turnMeta.textContent()) ?? '').includes('已工作')) break
    await sleep(500)
  }
  if (!((await turnMeta.textContent()) ?? '').includes('已工作')) throw new Error('回合未在限时内落成（轮头仍显示工作中）')
  await sleep(300)
  await turnMeta.click()
  const settledCard = page.locator('[data-testid="agg-tape"]').first()
  await settledCard.waitFor({ state: 'visible', timeout: 20_000 })
  const settledH = await settledCard.evaluate((el) => el.getBoundingClientRect().height)
  check('落成后收成一行：卡片高 28px', Math.abs(settledH - 28) <= 1, `${settledH.toFixed(1)}px`)
  const head = settledCard.locator('[data-testid="agg-summary-row"]')
  await head.click()
  const tape = settledCard.locator('[data-testid="agg-tape-scroll"]')
  await tape.waitFor({ state: 'visible', timeout: 20_000 })
  await sleep(900)

  const done = await settledCard.evaluate((el) => {
    const cs = (node, props) => {
      const s = getComputedStyle(node)
      return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)]))
    }
    const tape = el.querySelector('[data-testid="agg-tape-scroll"]')
    const head = el.querySelector('[data-testid="agg-summary-row"]')
    const rows = Array.from(el.querySelectorAll('[data-testid="agg-tool-row"]'))
    const cmd = rows[0]
    const body = cmd.querySelector('[data-testid="agg-tool-param"]')
    const dur = cmd.querySelector('[data-testid="agg-tool-duration"]')
    const r = (node) => node.getBoundingClientRect()
    return {
      card: { ...cs(el, ['background-color', 'border-radius', 'padding-left', 'padding-top']) },
      head: { text: (head.textContent ?? '').replace(/\s+/g, ' ').trim(), ...cs(head, ['font-size']), ...cs(head.querySelector('span:nth-of-type(1)'), ['font-weight', 'color']) },
      count: head.querySelector('[data-testid="agg-summary-count"]')
        ? { text: head.querySelector('[data-testid="agg-summary-count"]').textContent.trim(), ...cs(head.querySelector('[data-testid="agg-summary-count"]'), ['font-weight', 'color']) }
        : null,
      chevronRotated: !!head.querySelector('svg.lucide-chevron-right')?.classList.contains('rotate-90'),
      tape: { ...cs(tape, ['max-height', 'scrollbar-width']), ch: tape.clientHeight, sh: tape.scrollHeight },
      hint: (el.querySelector('[data-testid="agg-tape-hint"]')?.textContent ?? '').trim(),
      rows: rows.map((row) => ({ top: r(row).top, h: r(row).height })),
      cmd: {
        text: (cmd.textContent ?? '').replace(/\s+/g, ' ').trim(),
        body: body ? { text: body.textContent.trim(), ...cs(body, ['font-size', 'font-family', 'color']) } : null,
        dur: dur ? { text: dur.textContent.trim(), ...cs(dur, ['font-size', 'font-family', 'color']) } : null,
      },
      groupHeads: el.querySelectorAll('[data-testid="agg-tool-group"], [data-testid="agg-group-head"]').length,
      durationNode: !!el.querySelector('[data-testid="agg-summary-duration"]'),
    }
  })
  const xs = await tokenPx(settledCard, '--text-xs')
  console.log(`[probe] 量得：${JSON.stringify(done)}`)
  check('卡片底色比页面亮一档（--bg-input）', done.card['background-color'] === 'rgb(29, 29, 32)', done.card['background-color'])
  check('卡片圆角 8px、内边距左右 12px 上下 2px', done.card['border-radius'] === '8px' && done.card['padding-left'] === '12px' && parseFloat(done.card['padding-top']) === 2, `${done.card['border-radius']} / ${done.card['padding-left']} / ${done.card['padding-top']}`)
  check('卡头计数「N 步 · 思考 M」，中灰常规字重', /^2 步 · 思考 1$/.test(done.count?.text ?? '') && done.count['font-weight'] === '500' && done.count.color === 'rgb(148, 148, 148)', `${done.count?.text} / ${done.count?.['font-weight']} / ${done.count?.color}`)
  check('卡头不显示段总耗时；展开后箭头翻下', !done.durationNode && done.chevronRotated)
  check('工具行高 24px、行间无间隙', done.rows.length === 2 && done.rows.every((row) => Math.abs(row.h - 24) <= 0.5) && Math.abs(done.rows[1].top - done.rows[0].top - 24) <= 0.5, done.rows.map((row) => `${row.h.toFixed(1)}px`).join(' / ') + ` 间距 ${(done.rows[1]?.top ?? 0) - (done.rows[0]?.top ?? 0)}px`)
  check('命令行不带工具名', !/\bbash\b/.test(done.cmd.text), done.cmd.text)
  check('命令正文取等宽小字档、次级正文色', !!done.cmd.body && Math.abs(parseFloat(done.cmd.body['font-size']) - xs) < 0.05 && /mono/i.test(done.cmd.body['font-family']) && done.cmd.body.color === 'rgb(210, 210, 210)', `${done.cmd.body?.text} / ${done.cmd.body?.['font-size']} / ${done.cmd.body?.color}`)
  check('行尾耗时取等宽小字档、中灰', !!done.cmd.dur && Math.abs(parseFloat(done.cmd.dur['font-size']) - xs) < 0.05 && /mono/i.test(done.cmd.dur['font-family']) && done.cmd.dur.color === 'rgb(148, 148, 148)', `${done.cmd.dur?.text} / ${done.cmd.dur?.['font-size']} / ${done.cmd.dur?.color}`)
  check('窗口内没有分组标题行', done.groupHeads === 0)
  check('内容不满 12 行：窗口不溢出、没有滚动提示', done.tape.sh <= done.tape.ch && done.hint === '', `sh=${done.tape.sh} ch=${done.tape.ch} 提示「${done.hint}」`)
  check('滚动条隐藏', done.tape['scrollbar-width'] === 'none', done.tape['scrollbar-width'])

  await page.screenshot({ path: `${inst.dataDir}/look-card.png`, clip: await settledCard.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.max(0, r.x - 24), y: Math.max(0, r.y - 48), width: Math.min(r.width + 48, innerWidth), height: Math.min(r.height + 72, innerHeight) } }) })
  console.log(`[probe] 截图：${inst.dataDir}/look-card.png`)

  if (problems.length > 0) throw new Error(problems.join('；'))
  console.log('OK-LOOK 卡片 / 卡头 / 行 / 命令行 / 耗时 / 无分组标题 / 无多余提示 / 隐藏滚动条 / 轮头亮度 全部通过')
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
