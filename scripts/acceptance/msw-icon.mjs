#!/usr/bin/env node
/**
 * AC-MSW-ICON 真机探针：模型切换行行首图标为 box（msw-ui 枝，G8 原型裁决「用 box」）。
 *
 * 断言（真机：开发实例 + 真 pi + faux 演员；回合落成后切换，CDP 读对话流 DOM）：
 *  - 切换行渲染为横线分隔行族（.system-notice），主体短语「已切换模型」+ 钉右 meta「前 → 后」；
 *  - 行内图标 svg 的 lucide 类名是 lucide-box（非兜底 Info / 交接双箭头 / 压缩 Layers）。
 */
import fs from 'node:fs'
import { boot, isSwitchRow, noticeRowTexts, sendAndWaitTurn, switchModel, waitForSwitchRows } from './harness.mjs'

const steps = [
  { thinking: '先看一下。', toolCalls: [{ name: 'bash', args: { command: 'echo icon-1' } }], stopReason: 'toolUse' },
  { text: '第一轮答复。', stopReason: 'stop' },
]

/** 切换行图标 svg 的类名与行文本（一次 evaluate 全取）。 */
const iconProbe = (page) =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.system-notice'))
    const row = rows.find((el) => (el.textContent ?? '').includes('已切换模型'))
    if (!row) return { ok: false, why: '没有「已切换模型」切换行' }
    const svg = row.querySelector('svg')
    const cls = svg?.getAttribute('class') ?? ''
    const rowText = (row.textContent ?? '').replace(/\s+/g, ' ').trim()
    return { ok: true, cls, rowText }
  })

const label = `tp-msw-icon-${Date.now()}`
const inst = await boot({ steps, label, tps: '60' })
const { ws, sessionId, page, dataDir, cleanup } = inst
const problems = []
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `（${extra}）` : ''}`)
  if (!ok) problems.push(name)
}
try {
  await sendAndWaitTurn(ws, sessionId, '看一下。')
  await switchModel(ws, sessionId, 'faux', 'faux-1-reasoning')
  const rows = await waitForSwitchRows(page, 'faux-1', 'faux-1-reasoning')
  check('回合落成后切换：切换行出行且前后模型正确', rows.some((t) => isSwitchRow(t, 'faux-1', 'faux-1-reasoning')), `行「${rows.join(' | ')}」`)

  const probe = await iconProbe(page)
  check('切换行主体短语为「已切换模型」', probe.ok && probe.rowText.includes('已切换模型'), probe.ok ? probe.rowText : probe.why)
  check(
    '切换行 meta 为前 → 后模型 id',
    probe.ok && /faux-1\s*→\s*faux-1-reasoning/.test(probe.rowText),
    probe.ok ? probe.rowText : probe.why,
  )
  check(
    '行首图标为 box（lucide-box），非兜底 Info / 双箭头 / 压缩 Layers',
    probe.ok && probe.cls.includes('lucide-box') && !probe.cls.includes('lucide-info') && !probe.cls.includes('lucide-arrow-left-right') && !probe.cls.includes('lucide-layers'),
    `svg class「${probe.ok ? probe.cls : probe.why}」`,
  )

  if (problems.length > 0) throw new Error(problems.join('；'))
  console.log('OK-ICON 切换行图标为 box（非兜底/双箭头），主体短语与前后模型 meta 正确')
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
