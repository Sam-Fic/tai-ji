#!/usr/bin/env node
/**
 * AC-MSW-REPLAY / AC-MSW-DEDUPE 真机探针：模型切换行的回放派生（msw-replay 枝）。
 *
 * 断言（真机：开发实例 + 真 pi + faux 演员；WS 切模型让 pi 把 model_change 落盘，重载页面后
 * 对话流由会话文件回放）：
 *  AC-MSW-REPLAY：真实会话文件经 reducer 派生出切换行，前后模型正确。
 *                场景故意超过历史窗口（最近 20 个回合）：窗口不含文件头那条初始记录，
 *                切换行靠「窗口起点处的生效模型」补基线才出得来。
 *  AC-MSW-DEDUPE：会话首条 model_change（初始模型）与同模型重复写入的 model_change 不出行。
 *  实时与回放是否一致由 msw-live 探针验证（实时链路属于那一枝）；本探针只看回放。
 *
 * faux 脚本每项相同：首轮之后标题生成等扩展调用也走同一个假模型队列，会消耗若干项，
 * 应答文本相同就不怕错位。回合落成以订阅后的终态帧为准（长会话的早期回合会被虚拟列表卸载）。
 */
import fs from 'node:fs'
import {
  boot,
  historyWindow,
  isSwitchRow,
  noticeRowTexts,
  reloadIntoSession,
  sendAndWaitTurn,
  sleep,
  switchModel,
  waitForSessionEntries,
} from './harness.mjs'

/** 回合数超过历史窗口（HISTORY_BUDGET.RECENT_TURNS = 20）：窗口 = 最近 20 个回合 */
const TOTAL_TURNS = 25
const SWITCH_AFTER = 21
const WINDOW_FIRST_TURN = TOTAL_TURNS - 19

const steps = Array.from({ length: 40 }, () => [{ text: '答复。', stopReason: 'stop' }]).flat()

const switchRowsOf = async (page) => (await noticeRowTexts(page)).filter((t) => / → /.test(t))

const label = `tp-msw-replay-${Date.now()}`
const inst = await boot({ steps, label, tps: '0' })
const { ws, sessionId, page, dataDir, cleanup } = inst
const problems = []
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `（${extra}）` : ''}`)
  if (!ok) problems.push(name)
}
try {
  for (let n = 1; n <= SWITCH_AFTER; n += 1) await sendAndWaitTurn(ws, sessionId, `第${n}轮`)
  await switchModel(ws, sessionId, 'faux', 'faux-1-reasoning')
  // 同模型再切一次：pi 照样落一条 model_change，但不是一次真实切换
  await switchModel(ws, sessionId, 'faux', 'faux-1-reasoning')
  for (let n = SWITCH_AFTER + 1; n <= TOTAL_TURNS; n += 1) await sendAndWaitTurn(ws, sessionId, `第${n}轮`)

  const modelIds = (entries) => entries.filter((e) => e.type === 'model_change').map((e) => e.modelId)
  const userCount = (entries) => entries.filter((e) => e.type === 'message' && e.message?.role === 'user').length
  const entries = await waitForSessionEntries(
    dataDir,
    sessionId,
    (list) => modelIds(list).length >= 3 && userCount(list) >= TOTAL_TURNS,
  )
  check(
    `会话文件：${TOTAL_TURNS} 个回合、3 条模型记录（初始、切换、同模型重复）`,
    modelIds(entries).join(',') === 'faux-1,faux-1-reasoning,faux-1-reasoning' && userCount(entries) === TOTAL_TURNS,
    `回合 ${userCount(entries)}，模型记录 ${modelIds(entries).join(',')}`,
  )

  // ── 前提自证：runtime 按窗口读会话文件，窗口不含文件头 ───────────────
  const history = await historyWindow(ws, sessionId)
  const windowTurns = TOTAL_TURNS - WINDOW_FIRST_TURN + 1
  const replayedRows = history.messages.filter((m) => m.modelSwitch !== undefined)
  check(
    `历史接口：只返回最近 ${windowTurns} 个回合，窗口外还有更早内容`,
    history.truncated === true && history.loadedTurns === windowTurns,
    `loadedTurns ${history.loadedTurns}，truncated ${history.truncated}`,
  )
  check(
    '回放（runtime 产物）：窗口里一条切换行，前后模型正确',
    replayedRows.length === 1 &&
      replayedRows[0].modelSwitch.previousModelId === 'faux-1' &&
      replayedRows[0].modelSwitch.modelId === 'faux-1-reasoning',
    `行「${replayedRows.map((m) => m.content).join(' | ')}」`,
  )

  // ── 重载：界面由会话文件回放 ───────────────────────────────────────
  await reloadIntoSession(page)
  await page.getByText(`第${TOTAL_TURNS}轮`, { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 })
  await sleep(1500)
  check('重载后：对话流不含窗口外的第 1 个回合', (await page.getByText('第1轮', { exact: true }).count()) === 0, '')

  // ── AC-MSW-REPLAY：窗口内首条切换记录靠补上的基线出行 ──────────────
  const afterReload = (await switchRowsOf(page)).slice().sort()
  check(
    '回放：切换行在窗口里出行，前后模型正确',
    afterReload.length === 1 && isSwitchRow(afterReload[0], 'faux-1', 'faux-1-reasoning'),
    `行「${afterReload.join(' | ')}」`,
  )

  // ── AC-MSW-DEDUPE：初始记录与同模型重复记录不出行 ──────────────────
  check(
    '回放：初始记录与同模型重复记录都不出行（没有「faux-1-reasoning → faux-1-reasoning」）',
    !afterReload.some((t) => isSwitchRow(t, 'faux-1-reasoning', 'faux-1-reasoning')),
    `行「${afterReload.join(' | ')}」`,
  )

  if (problems.length > 0) throw new Error(problems.join('；'))
  console.log(`OK-REPLAY 真实会话文件回放出行，前后模型正确；会话超过历史窗口（${TOTAL_TURNS} 个回合）时靠窗口起点处的生效模型补基线`)
  console.log('OK-DEDUPE 初始记录与同模型重复记录不出行')
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
