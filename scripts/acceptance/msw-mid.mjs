#!/usr/bin/env node
/**
 * AC-MSW-MID 真机探针：回合进行中切换模型，切换行出现在该回合内部、新模型内容之前（msw-ui 枝）。
 *
 * 断言（真机：开发实例 + 真 pi + faux 演员；工具执行中经 WS 切模型，CDP 读对话流 DOM）：
 *  - 切换行以回合内 trace 单元形态渲染（data-testid="turn-switch-notice"，在回合容器内）；
 *  - DOM 序：回合内过程块之后、新模型正文之前；
 *  - 重载后（会话文件回放）同形——行仍在回合内、新模型内容之前。
 */
import fs from 'node:fs'
import { boot, noticeRowTexts, reloadIntoSession, sleep, switchModel } from './harness.mjs'

const steps = [
  { thinking: '先跑个慢命令。', toolCalls: [{ name: 'bash', args: { command: 'sleep 4 && echo mid-done' } }], stopReason: 'toolUse' },
  { text: '新模型答复。', stopReason: 'stop' },
]

/** 回合容器的 DOM 断言（live 与重载共用同一函数）：行在回合内、过程块之后、新模型正文之前。 */
const probeDom = (page) =>
  page.evaluate(() => {
    const FOLLOWING = 4 // Node.DOCUMENT_POSITION_FOLLOWING
    const notice = document.querySelector('[data-testid="turn-switch-notice"]')
    if (!notice) {
      const staticRow = Array.from(document.querySelectorAll('.system-notice')).find((el) =>
        (el.textContent ?? '').includes('已切换模型'),
      )
      return { ok: false, why: staticRow ? '切换行渲染为回合外静态行（不在回合容器内）' : '对话流里没有切换行' }
    }
    // 回合根容器的 testid 形如 turn-<数字>（子元素锚点同族前缀，不能 closest 泛配——
    // 本行自身 testid turn-switch-notice 就以前缀命中）
    let ancestor = notice.parentElement
    while (ancestor && !/^turn-\d+$/.test(ancestor.getAttribute('data-testid') ?? '')) {
      ancestor = ancestor.parentElement
    }
    const turn = ancestor
    if (!turn) return { ok: false, why: '切换行不在回合容器内' }
    const rowText = (notice.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!rowText.includes('已切换模型')) return { ok: false, why: `切换行主体短语不对：「${rowText}」` }
    if (!/faux-1\s*→\s*faux-1-reasoning/.test(rowText)) return { ok: false, why: `切换行前后模型不对：「${rowText}」` }
    const texts = turn.querySelectorAll('[data-testid="block-text"]')
    const lastText = texts[texts.length - 1]
    if (!lastText) {
      const dump = Array.from(turn.querySelectorAll(':scope > *')).slice(0, 8)
        .map((c) => `${c.tagName.toLowerCase()}#${c.getAttribute('data-testid') ?? c.className.split(' ').slice(0, 2).join('.')}`)
        .join(' | ')
      return { ok: false, why: `回合内没有正文行（turn=${turn.getAttribute('data-testid')}，子结构 ${dump}）` }
    }
    if (!(lastText.textContent ?? '').includes('新模型答复')) {
      return { ok: false, why: `末位正文不是新模型答复：「${(lastText.textContent ?? '').trim()}」` }
    }
    if (!(notice.compareDocumentPosition(lastText) & FOLLOWING)) return { ok: false, why: '切换行不在新模型正文之前' }
    const agg = turn.querySelector('[data-testid="process-aggregate"]')
    if (agg && !(agg.compareDocumentPosition(notice) & FOLLOWING)) return { ok: false, why: '切换行不在回合过程块之后' }
    return { ok: true, rowText }
  })

const label = `tp-msw-mid-${Date.now()}`
const inst = await boot({ steps, label, tps: '60' })
const { ws, sessionId, page, dataDir, cleanup } = inst
const problems = []
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `（${extra}）` : ''}`)
  if (!ok) problems.push(name)
}
// 轮询式断言：markdown 正文经异步渲染增量到达（G2-5——首拍可能只剩行尾时刻，数秒内自愈），
// 单拍断言会撞空窗；15 秒内轮询到 ok 即通过，超时以末拍取证
const probeDomStable = async (timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  let last = await probeDom(page)
  while (Date.now() < deadline && !last.ok) {
    await sleep(500)
    last = await probeDom(page)
  }
  return last
}
try {
  // 回合进行中切换：先挂终态帧监听再发消息，工具（sleep 4）执行到一半时切模型——
  // 新模型答复（第二步）在切换之后才创建，时间序上切换行落在两者之间
  const turnEnded = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('回合未在限时内落成')), 90_000)
    const onMessage = (data) => {
      let m
      try {
        m = JSON.parse(data.toString())
      } catch {
        return
      }
      if (['message.complete', 'message.error', 'message.stream_error', 'session.exited'].includes(m.type) && m.payload?.sessionId === sessionId) {
        clearTimeout(to)
        ws.off('message', onMessage)
        resolve(m.type)
      }
    }
    ws.on('message', onMessage)
  })
  ws.send(JSON.stringify({ type: 'message.send', id: `send-${Date.now()}`, payload: { sessionId, content: '跑个慢命令。' } }))
  await sleep(2500)
  const sw = await switchModel(ws, sessionId, 'faux', 'faux-1-reasoning')
  check(
    '工具执行中切换：回执生效',
    sw?.modelId === 'faux-1-reasoning',
    `回执 ${sw?.provider}/${sw?.modelId}`,
  )
  const endType = await turnEnded
  check('切换后回合照常落成', endType === 'message.complete', `终态帧 ${endType}`)

  // ── 回合内部位置断言（DOM 序，轮询式防异步渲染空窗）──────────
  const live = await probeDomStable()
  check('实时：切换行在回合内部、过程块之后、新模型正文之前', live.ok, live.ok ? `行「${live.rowText}」` : live.why)

  // ── 重载后同形（会话文件回放 → 同一分组规则）──────────────────
  await reloadIntoSession(page)
  await page.getByText('新模型答复。').first().waitFor({ state: 'visible', timeout: 30_000 })
  const replay = await probeDomStable()
  check('重载后（回放）：切换行同形——仍在回合内、新模型正文之前', replay.ok, replay.ok ? `行「${replay.rowText}」` : replay.why)
  check('重载后对话流没有多余切换行', (await noticeRowTexts(page)).filter((t) => / → /.test(t)).length === 1)

  if (problems.length > 0) throw new Error(problems.join('；'))
  console.log('OK-MID 回合进行中切换：切换行在回合内部、新模型内容之前，重载后同形')
} catch (err) {
  console.error(`[probe] 失败：${err instanceof Error ? err.message : String(err)}`)
  try {
    console.error(`[probe] 末次对话流通知行：${JSON.stringify(await noticeRowTexts(page))}`)
  } catch {
    // 页面已断开
  }
  console.error(`[probe] 数据目录保留：${dataDir}`)
  process.exitCode = 1
} finally {
  try {
    ws.close()
  } catch {
    // 连接已断开属正常收尾
  }
  await cleanup()
  if (process.exitCode !== 1) fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(process.exitCode ?? 0)
}
