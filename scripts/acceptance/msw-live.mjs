#!/usr/bin/env node
/**
 * AC-MSW-LIVE / AC-CORE-EQUIV 真机探针：模型切换行的实时链路与重载同形（msw-live 枝）。
 *
 * 断言（真机：开发实例 + 真 pi + faux 演员；WS 切模型，CDP 读对话流）：
 *  AC-MSW-LIVE：新会话的第一次切换不重载页面就出行（pi → 扩展 → runtime 帧 → 前端合成 entry）；
 *               切到另一模型再出一条；切到当前模型不出行。
 *  AC-CORE-EQUIV：重载页面后对话流来自会话文件回放，切换行的条数与前后模型与重载前一致。
 */
import fs from 'node:fs'
import {
  boot,
  isSwitchRow,
  noticeRowTexts,
  reloadIntoSession,
  sendAndWaitTurn,
  sleep,
  switchModel,
  waitForSessionEntries,
  waitForSwitchRows,
} from './harness.mjs'

const steps = [
  { thinking: '先看一下目录。', toolCalls: [{ name: 'bash', args: { command: 'echo msw-1' } }], stopReason: 'toolUse' },
  { text: '第一轮答复。', stopReason: 'stop' },
  { thinking: '再看一次。', toolCalls: [{ name: 'bash', args: { command: 'echo msw-2' } }], stopReason: 'toolUse' },
  { text: '第二轮答复。', stopReason: 'stop' },
]

/** 对话流里的切换行文本（按出现序） */
const switchRowList = async (page) => (await noticeRowTexts(page)).filter((t) => / → /.test(t))

const label = `tp-msw-live-${Date.now()}`
const inst = await boot({ steps, label, tps: '60' })
const { ws, sessionId, page, dataDir, cleanup } = inst
const problems = []
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `（${extra}）` : ''}`)
  if (!ok) problems.push(name)
}
try {
  await sendAndWaitTurn(ws, sessionId, '看看目录。')
  check('切换前：对话流没有切换行', (await switchRowList(page)).length === 0)

  // ── AC-MSW-LIVE：新会话第一次切换，不重载即出行 ─────────────────
  // 会话的初始模型记录只在新建会话时落盘、不发事件，实时侧没有它：这条行靠切换帧携带的
  // 切换前模型补基线才出得来
  const first = await switchModel(ws, sessionId, 'faux', 'faux-1-reasoning')
  const rowsAfterFirst = await waitForSwitchRows(page, 'faux-1', 'faux-1-reasoning')
  check(
    '新会话第一次切换：不重载页面就出现切换行',
    rowsAfterFirst.some((t) => isSwitchRow(t, 'faux-1', 'faux-1-reasoning')),
    `回执 ${first?.provider}/${first?.modelId}，行「${rowsAfterFirst.join(' | ')}」`,
  )

  await sendAndWaitTurn(ws, sessionId, '再看一次。')
  const afterTurn = await switchRowList(page)
  check('切换后对话照常进行，切换行仍在', afterTurn.some((t) => isSwitchRow(t, 'faux-1', 'faux-1-reasoning')), `行「${afterTurn.join(' | ')}」`)

  // ── 切到当前模型：pi 照样落盘一条记录，但不出行 ─────────────────
  await switchModel(ws, sessionId, 'faux', 'faux-1-reasoning')
  await sleep(1500)
  const afterSame = await switchRowList(page)
  check('切到当前模型：不出行', afterSame.length === afterTurn.length, `切换行 ${afterSame.length} 条`)

  // ── 切到另一模型：再出一条 ──────────────────────────────────────
  await switchModel(ws, sessionId, 'faux', 'faux-1-b')
  const rowsAfterSecond = await waitForSwitchRows(page, 'faux-1-reasoning', 'faux-1-b')
  check(
    '切到另一模型：再出一条，前后模型正确',
    rowsAfterSecond.some((t) => isSwitchRow(t, 'faux-1-reasoning', 'faux-1-b')) && rowsAfterSecond.filter((t) => / → /.test(t)).length === 2,
    `行「${rowsAfterSecond.join(' | ')}」`,
  )

  // ── 会话文件：pi 落盘 4 条模型记录（初始、切换、同模型重复、切换）──
  const modelIds = (entries) => entries.filter((e) => e.type === 'model_change').map((e) => e.modelId)
  const entries = await waitForSessionEntries(dataDir, sessionId, (list) => modelIds(list).length >= 4)
  check(
    '会话文件落了 4 条模型记录（初始、切换、同模型重复、切换）',
    modelIds(entries).join(',') === 'faux-1,faux-1-reasoning,faux-1-reasoning,faux-1-b',
    modelIds(entries).join(','),
  )

  // ── AC-CORE-EQUIV：重载后由会话文件回放，切换行同形 ──────────────
  const beforeReload = (await switchRowList(page)).slice().sort()
  await reloadIntoSession(page)
  // 同一段答复在页面上出现在两处（对话流与底部 Trace 面板），取第一处即可
  await page.getByText('第一轮答复。').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByText('第二轮答复。').first().waitFor({ state: 'visible', timeout: 30_000 })
  const afterReload = (await switchRowList(page)).slice().sort()
  check(
    '重载后（会话文件回放）：切换行的条数与前后模型与重载前一致',
    afterReload.length === 2 && JSON.stringify(afterReload) === JSON.stringify(beforeReload),
    `重载前「${beforeReload.join(' | ')}」重载后「${afterReload.join(' | ')}」`,
  )

  if (problems.length > 0) throw new Error(problems.join('；'))
  console.log('OK-LIVE-MSW 新会话第一次切换不重载即出行 / 切到另一模型再出一条 / 切到当前模型不出行')
  console.log('OK-EQUIV 重载后切换行的条数与前后模型与重载前一致')
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
