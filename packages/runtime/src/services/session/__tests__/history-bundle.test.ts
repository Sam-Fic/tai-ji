import type { IProcessManager } from '../../ports/pi-engine.js';
import type { ISessionStore } from '../../ports/session.js';
import { SessionHistoryReader, selectIndexWindow } from '../history-reader.js';
import { SessionEntryRemovalOrchestrator, type SessionEntryRemovalDeps } from '../session-entry-removal.js';
import { countSessionMessagesInFile } from '../session-message-count.js';
import type { IManagedSessionView } from '../types.js';
import { HISTORY_BUDGET, type CrashJournalEvent, type Message, type SessionSummary } from '@taiji/shared';
import type { TurnIndexSnapshot } from '../../../infra/pi/turn-index-types.js';
import { scanTurnBoundariesForward, verifyTurnBoundaries } from '../../../infra/pi/turn-index-scanner.js';
import { createZcodeEngine, registerZcodeEngine, routeEngine } from '@zhushanwen/subagent-core';
import { CONTROL_ENV_ROOT_SESSION_ID, CONTROL_ENV_SOCKET } from '@zhushanwen/subagent-engine-sdk';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/session/__tests__/history-budget-window.test.ts
//   （turn-boundary-index 重写：预算窗口语义改在索引快照上断言——退役纯函数
//   applyHistoryBudgetWindow 的语义由 history-reader selectIndexWindow 承载，
//   快照 turns 手工构造，逐条对应原断言①-④与病态兜底）
// ======================================================================

// ── fixture 工厂（索引窗口纯函数段：turn 记录手工构造）──────────────

let seq = 0

/** 一条索引 turn 记录（entryId/偏移/预算字节按测试语义给定）。 */
function turnRecord(entryId: string, budgetBytes: number): { entryId: string; byteOffset: number; byteLength: number; budgetBytes: number } {
  seq += 1
  return { entryId, byteOffset: seq * 1000, byteLength: budgetBytes + 1, budgetBytes }
}

/** 手工索引快照（只含窗口选择消费的字段：turns）。 */
function snapshotOf(turns: Array<ReturnType<typeof turnRecord>>): TurnIndexSnapshot {
  return { fileSize: 0, mtimeMs: 0, scannedOffset: 0, turns }
}

/** 波浪线口径对齐断言辅助：窗口内 budgetBytes 合计。 */
function windowBytes(turns: Array<ReturnType<typeof turnRecord>>, start: number, end: number): number {
  return turns.slice(start, end).reduce((acc, t) => acc + t.budgetBytes, 0)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('history-budget-window（索引窗口选择语义）', () => {
describe('断言①：预算内不截断（truncated:false，A6 回归）', () => {
  it('5 turns 全部入窗（<20 turns 且 <640KB）→ 窗口含全部、loadedTurns=5、truncated=false', () => {
    const turns = Array.from({ length: 5 }, (_, i) => turnRecord(`t${i}`, 100))

    const selected = selectIndexWindow(snapshotOf(turns), undefined)

    expect(selected.truncated).toBe(false)
    expect(selected.windowTurns).toEqual(turns) // 全量入选（窗口 = turns.slice(0)）
    expect(selected.loadedTurns).toBe(5)
  })

  it('恰好 20 turns 且字节未超 → 仍不截断（边界内）', () => {
    const turns = Array.from({ length: HISTORY_BUDGET.RECENT_TURNS }, (_, i) => turnRecord(`t${i}`, 100))

    const selected = selectIndexWindow(snapshotOf(turns), undefined)

    expect(selected.truncated).toBe(false)
    expect(selected.windowTurns).toHaveLength(HISTORY_BUDGET.RECENT_TURNS)
    expect(selected.loadedTurns).toBe(HISTORY_BUDGET.RECENT_TURNS)
  })
})
describe('断言②：超预算截断（truncated:true + loadedTurns 正确）', () => {
  it('30 turns（turn 数超 20）→ 最近 20 turns、truncated:true（窗口起点 = 从尾数第 20 个边界）', () => {
    const turns = Array.from({ length: 30 }, (_, i) => turnRecord(`t${i}`, 100))

    const selected = selectIndexWindow(snapshotOf(turns), undefined)

    expect(selected.truncated).toBe(true)
    expect(selected.loadedTurns).toBe(20)
    // 窗口 = 最新 20 个 turn（t10..t29），恒含最新 turn（尾部不丢）
    expect(selected.windowTurns[0].entryId).toBe('t10')
    expect(selected.windowTurns.at(-1)?.entryId).toBe('t29')
  })

  it('字节预算截断：12 turns 每条 ~100KB → 只放最近 6 turns（640KB 帽）', () => {
    const big = 100 * 1024
    const turns = Array.from({ length: 12 }, (_, i) => turnRecord(`big-${i}`, big))

    const selected = selectIndexWindow(snapshotOf(turns), undefined)

    expect(selected.truncated).toBe(true)
    // 从新到旧累加：每 turn ≈ 100KB，640KB 帽容纳 6 个 turn（第 7 个超）
    expect(selected.loadedTurns).toBe(6)
    // 窗口字节 ≤ 预算（实现精确逐 turn 计入 budgetBytes）
    expect(windowBytes(turns, turns.length - selected.loadedTurns, turns.length)).toBeLessThanOrEqual(HISTORY_BUDGET.MAX_BYTES)
    // 窗口 = 最新 6 个 turn（big-6..big-11）
    expect(selected.windowTurns[0].entryId).toBe('big-6')
  })

  it('40 turns → loadedTurns=20（窗口选择恒从尾向前）', () => {
    const turns = Array.from({ length: 40 }, (_, i) => turnRecord(`t${i}`, 100))
    const selected = selectIndexWindow(snapshotOf(turns), undefined)
    expect(selected.loadedTurns).toBe(20)
    expect(selected.truncated).toBe(true)
  })
})
describe('断言③：单 turn 超预算完整放行', () => {
  it('唯一 turn 自身超 640KB → 完整放行、truncated:false（首 turn 豁免）', () => {
    const turn = [turnRecord('huge', 700 * 1024)]

    const selected = selectIndexWindow(snapshotOf(turn), undefined)

    expect(selected.windowTurns).toEqual(turn)
    expect(selected.truncated).toBe(false)
    expect(selected.loadedTurns).toBe(1)
  })

  it('最新 turn 超预算 + 更早 2 个小 turn → 窗口只含大 turn、truncated:true（字节如实超出）', () => {
    const turns = [turnRecord('old-1', 100), turnRecord('old-2', 100), turnRecord('huge', 700 * 1024)]

    const selected = selectIndexWindow(snapshotOf(turns), undefined)

    expect(selected.truncated).toBe(true)
    expect(selected.loadedTurns).toBe(1)
    expect(selected.windowTurns.map((t) => t.entryId)).toEqual(['huge'])
    // 字节统计如实反映超出：窗口 budgetBytes > 预算（首 turn 豁免）
    expect(windowBytes(turns, turns.length - selected.loadedTurns, turns.length)).toBeGreaterThan(HISTORY_BUDGET.MAX_BYTES)
  })
})
describe('断言④：窗口起点恒在 turn 边界（entry 原子性）', () => {
  it('窗口 = 完整 turn 记录切片：字节读区间由边界偏移围成（含首条 turn 时从 byte 0 读前导段）', () => {
    const turns = Array.from({ length: 25 }, (_, i) => turnRecord(`t${i}`, 100))

    const selected = selectIndexWindow(snapshotOf(turns), undefined)

    expect(selected.truncated).toBe(true)
    expect(selected.windowTurns).toHaveLength(20)
    // 窗口起点 = turn 边界记录（非 turn 中间切片）；首条 turn 窗口才从 byte 0 读
    expect(selected.startByte).toBe(turns[5].byteOffset)
    // cursor 窗口：endByte = cursor turn 起点（cursor turn 只进校验集合）
    const cursorSelected = selectIndexWindow(snapshotOf(turns), 10, { limitTurns: 2 })
    expect(cursorSelected.windowTurns.map((t) => t.entryId)).toEqual(['t8', 't9'])
    expect(cursorSelected.cursorTurn?.entryId).toBe('t10')
    expect(cursorSelected.endByte).toBe(turns[10].byteOffset)
    expect(cursorSelected.truncated).toBe(true)
  })

  it('cursor 为最早 turn → 锚前无 turn（loadedTurns=0，调用方按翻页到头返回空页）', () => {
    const turns = [turnRecord('t0', 100), turnRecord('t1', 100)]
    const selected = selectIndexWindow(snapshotOf(turns), 0, { limitTurns: 2 })
    expect(selected.loadedTurns).toBe(0)
    expect(selected.windowTurns).toEqual([])
    expect(selected.truncated).toBe(false)
  })
})
describe('病态输入兜底', () => {
  it('空 turns → 全零结果（零 turn 走尾读兼容分支的索引侧形态）', () => {
    const selected = selectIndexWindow(snapshotOf([]), undefined)
    expect(selected.windowTurns).toEqual([])
    expect(selected.truncated).toBe(false)
    expect(selected.loadedTurns).toBe(0)
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/history-rebuild.test.ts
//   （turn-boundary-index 重写：旧三分支重建/缓存/后台任务测试随 D4 退役；本段改载
//   SessionHistoryReader 索引窗口编排测试——真实 JSONL fixture 驱动，索引落共享 tmp
//   dataDir 的 history-index 域（fs-guard 白名单内），sessionId 每用例唯一防 store
//   内存态跨用例污染）
// ======================================================================

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** pi message entry JSONL 行（turn 边界 = role:'user'）。 */
function entryLine(id: string, role: 'user' | 'assistant' | 'toolResult', text: string): string {
  const message = role === 'toolResult'
    ? { role, toolCallId: `tc-${id}`, toolName: 'bash', content: [{ type: 'text', text }] }
    : { role, content: [{ type: 'text', text }] }
  return JSON.stringify({ type: 'message', id, parentId: null, timestamp: '2026-11-03T00:00:00.000Z', message })
}

function headerLine(sid: string): string {
  return JSON.stringify({ type: 'session', id: sid, version: 3 })
}

/** 测试用 fake convertHistory：entry.message 体 → Message（text 拼接），供内容断言。 */
function fakeConvertHistory(raw: unknown[]): Message[] {
  return raw.map((m, i) => {
    const body = m as { role?: string; content?: unknown }
    const text = Array.isArray(body.content)
      ? body.content
          .map((c) => (typeof c === 'object' && c !== null && (c as { text?: unknown }).text != null ? String((c as { text: unknown }).text) : ''))
          .join('')
      : String(body.content ?? '')
    return { id: `m-${i}`, role: body.role, content: text, status: 'complete', timestamp: 1 } as Message
  })
}

let fixtureSeq = 0

/** 唯一 sessionId（防共享 tmp dataDir 上 store 内存态/磁盘索引的跨用例污染）。 */
function uniqueSid(prefix: string): string {
  return `${prefix}-${++fixtureSeq}`
}

/**
 * 索引编排直构环境：主会话文件经 scanSessions mock 定位（同生产定位语义），sessionStore
 * 带 fake convertHistory（entry 内容断言）。TurnIndexStore 由 reader 构造时自持（组合接线
 * 裁定），索引落盘走缺省推导（getSessionHistoryIndexFile → vitest 固定 tmp dataDir）。
 */
function makeIndexReader(files: Record<string, string>, opts?: { clientPresent?: boolean }) {
  const sessionStore = {
    scanSessions: vi.fn(() => Object.entries(files).map(([id, filePath]) => ({ id, filePath }))),
    convertHistory: vi.fn((raw: unknown[]) => fakeConvertHistory(raw)),
  } as unknown as ISessionStore
  const client = { getEntries: vi.fn(async () => { throw new Error('get_entries must not be called in index orchestration') }) }
  const pm = {
    getClient: vi.fn(() => (opts?.clientPresent ? client : undefined)),
  } as unknown as IProcessManager
  const reader = new SessionHistoryReader({ pm, sessionStore, scanner: { scanTurnBoundariesForward, verifyTurnBoundaries } })
  return { reader, sessionStore, client }
}

/** 写会话 JSONL（header + 各 turn 的 user/assistant 行）。 */
const readerFixtureDirs: string[] = []

function writeSessionFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'history-reader-'))
  readerFixtureDirs.push(dir)
  const filePath = join(dir, 'session.jsonl')
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
  return filePath
}

/** 标准 fixture：3 turns（每 turn = user + assistant），返回行集合。 */
function threeTurnLines(sid: string): string[] {
  return [
    headerLine(sid),
    entryLine('u1', 'user', 'q1'),
    entryLine('a1', 'assistant', 'r1'),
    entryLine('u2', 'user', 'q2'),
    entryLine('a2', 'assistant', 'r2'),
    entryLine('u3', 'user', 'q3'),
    entryLine('a3', 'assistant', 'r3'),
  ]
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('history-reader 索引窗口编排', () => {
afterEach(() => {
  while (readerFixtureDirs.length > 0) {
    const dir = readerFixtureDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
describe('索引就绪读取（单一数据路径，AX4）', () => {
  it('首次读取建索引并返回最近窗口（20 turn 预算内全量），totalTurnsEstimate=完整索引 turn 总数', async () => {
    const sid = uniqueSid('idx')
    const filePath = writeSessionFile(threeTurnLines(sid))
    const { reader, client } = makeIndexReader({ [sid]: filePath }, { clientPresent: true })

    const result = await reader.getHistory(sid)

    // 单一数据路径：pi client 在场也零 RPC（读取分派与进程解耦，AX4；验收③ get_entries 零引用）
    expect(client.getEntries).not.toHaveBeenCalled()
    expect(result.messages.map((m) => m.content)).toEqual(['q1', 'r1', 'q2', 'r2', 'q3', 'r3'])
    expect(result.truncated).toBe(false)
    expect(result.loadedTurns).toBe(3)
    expect(result.totalTurnsEstimate).toBe(3)
    // 第二次读取：索引就绪后直接按偏移读窗（内容一致 = stat 线索命中复用）
    const again = await reader.getHistory(sid)
    expect(again.messages.map((m) => m.content)).toEqual(['q1', 'r1', 'q2', 'r2', 'q3', 'r3'])
  })

  it('turn 数超预算：窗口只含最近 20 turns，truncated=true（窗口起点 = turn 边界）', async () => {
    const sid = uniqueSid('budget')
    const lines: string[] = [headerLine(sid)]
    const turns = 25
    for (let i = 1; i <= turns; i++) {
      lines.push(entryLine(`u${i}`, 'user', `q${i}`))
      lines.push(entryLine(`a${i}`, 'assistant', `r${i}`))
    }
    const filePath = writeSessionFile(lines)
    const { reader } = makeIndexReader({ [sid]: filePath })

    const result = await reader.getHistory(sid)

    expect(result.truncated).toBe(true)
    expect(result.loadedTurns).toBe(20)
    expect(result.totalTurnsEstimate).toBe(turns)
    // 窗口起点 = 从尾数第 20 个 turn 边界（q6），窗口内每 turn 的 user/assistant 相邻完整
    expect(result.messages[0].content).toBe('q6')
    expect(result.messages).toHaveLength(40)
    expect(result.messages.at(-1)?.content).toBe('r25')
  })

  it('字节预算截断：大 turn 后超预算的更早 turn 不入窗（单 turn 超限自身完整放行）', async () => {
    const sid = uniqueSid('bytes')
    const big = 'x'.repeat(700 * 1024) // 单 turn ~700KB > 640KB 预算（首 turn 豁免）
    const lines = [
      headerLine(sid),
      entryLine('u1', 'user', 'old'),
      entryLine('a1', 'assistant', 'old-reply'),
      entryLine('u2', 'user', big),
      entryLine('a2', 'assistant', 'big-reply'),
    ]
    const filePath = writeSessionFile(lines)
    const { reader } = makeIndexReader({ [sid]: filePath })

    const result = await reader.getHistory(sid)

    expect(result.truncated).toBe(true)
    expect(result.loadedTurns).toBe(1)
    expect(result.messages.map((m) => m.content)).toEqual([big, 'big-reply'])
    expect(result.totalTurnsEstimate).toBe(2)
  })

  it('主会话文件未被 scanSessions 定位（含 subagent 虚拟 id）：静默空页（现状语义）', async () => {
    const { reader } = makeIndexReader({})
    const result = await reader.getHistory('subagent:main-1:sub-1')
    expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
  })
})

describe('cursor 游标翻页（索引路径）', () => {
  it('cursor 命中：返回锚点前最近 limitTurns turns，cursor turn 只进校验集合不返回', async () => {
    const sid = uniqueSid('cursor')
    const filePath = writeSessionFile(threeTurnLines(sid))
    const { reader } = makeIndexReader({ [sid]: filePath })

    const page = await reader.getHistory(sid, { cursor: 'u3', limitTurns: 2 })

    // 锚点（u3 所在 turn 3）之前最近 2 turns = turn1+turn2；锚所在 turn 不返回
    expect(page.messages.map((m) => m.content)).toEqual(['q1', 'r1', 'q2', 'r2'])
    expect(page.truncated).toBe(false) // 锚前窗口含首条 turn（无更早历史）
    expect(page.loadedTurns).toBe(2)
    expect(page.totalTurnsEstimate).toBe(3) // 完整索引精确总数（不再随窗口退化为前缀计数）
  })

  it('cursor 为最早 turn → 空页 + truncated=false（翻页到头，D4 空游标边界）', async () => {
    const sid = uniqueSid('cursor-head')
    const filePath = writeSessionFile(threeTurnLines(sid))
    const { reader } = makeIndexReader({ [sid]: filePath })

    const page = await reader.getHistory(sid, { cursor: 'u1' })

    expect(page.messages).toEqual([])
    expect(page.truncated).toBe(false)
    expect(page.loadedTurns).toBe(0)
  })

  it('cursor 未命中 turns → 尾读 cursor 兼容链：真正未知 cursor 返回空页 truncated=false', async () => {
    const sid = uniqueSid('cursor-miss')
    const filePath = writeSessionFile(threeTurnLines(sid))
    const { reader } = makeIndexReader({ [sid]: filePath })
    await reader.getHistory(sid) // 先建索引

    // 未知 cursor（不在索引也不在文件）：兼容链定位失败 → 空页（不报错）
    const page = await reader.getHistory(sid, { cursor: 'gone-entry' })
    expect(page.messages).toEqual([])
    expect(page.truncated).toBe(false)
  })

  it('cursor 为合法非边界 entryId（assistant 行）→ 尾读 cursor 兼容链定位（现状行级语义）', async () => {
    const sid = uniqueSid('cursor-mid')
    const filePath = writeSessionFile(threeTurnLines(sid))
    const { reader } = makeIndexReader({ [sid]: filePath })
    await reader.getHistory(sid) // 先建索引

    // 'a2' 是 turn 2 内的非边界 entryId：索引未命中 → 兼容链按行定位。现状语义（AS4：正常
    // 翻页 cursor 恒为 turn 边界，非边界形态是防御路径）= 丢弃锚行及其更新侧，返回锚行之前
    // 的全部行（含锚所在 turn 的边界行 u2——兼容链不做「所在 turn 整体回退」）。
    const page = await reader.getHistory(sid, { cursor: 'a2', limitTurns: 2 })
    expect(page.messages.map((m) => m.content)).toEqual(['q1', 'r1', 'q2'])
    expect(page.truncated).toBe(false)
    expect(page.loadedTurns).toBe(2)
  })
})

describe('零 turn 兼容分支与重写失配重建', () => {
  it('无 user turn 的文件（纯 assistant 行）→ 零 turn 索引走尾读兼容分支（保持现有计数 0）', async () => {
    const sid = uniqueSid('zero')
    const filePath = writeSessionFile([headerLine(sid), entryLine('a1', 'assistant', 'only-reply')])
    const { reader } = makeIndexReader({ [sid]: filePath })

    const result = await reader.getHistory(sid)

    // 兼容分支 = 现有 tailReadHistory 语义：无 user turn 文件的计数保持现状（0，不视作 1 turn）
    expect(result.messages.map((m) => m.content)).toEqual(['only-reply'])
    expect(result.truncated).toBe(false)
    expect(result.loadedTurns).toBe(0)
    expect(result.totalTurnsEstimate).toBe(0)
  })

  it('同尺寸重写且保留 mtime（V4 攻击形态）→ 边界不变时读窗如实反映新内容（无旧拼接）', async () => {
    const sid = uniqueSid('rewrite')
    const oldLines = threeTurnLines(sid)
    const filePath = writeSessionFile(oldLines)
    const { reader } = makeIndexReader({ [sid]: filePath })
    await reader.getHistory(sid) // 建索引（旧内容）
    // stat 伪装：等长替换 turn 正文 + 恢复原 mtime（stat 线索完全不变 → 复用旧索引快照）
    const newLines = threeTurnLines(sid).map((l) => l.replaceAll('"r1"', '"z1"').replaceAll('"r2"', '"z2"'))
    expect(Buffer.byteLength(newLines.join('\n') + '\n')).toBe(Buffer.byteLength(oldLines.join('\n') + '\n')) // 同尺寸前提成立
    const prevMtime = fs.statSync(filePath).mtime
    writeFileSync(filePath, newLines.join('\n') + '\n', 'utf-8')
    fs.utimesSync(filePath, prevMtime, prevMtime)

    const result = await reader.getHistory(sid)

    // 边界 entryId 未变 → 校验通过 → 读出的窗口 = 当前文件字节（不出现旧正文残留）
    expect(result.messages.map((m) => m.content)).toEqual(['q1', 'z1', 'q2', 'z2', 'q3', 'r3'])
    expect(result.truncated).toBe(false)
  })

  it('同尺寸重写且换掉边界 entryId → 校验失配 → 重建后返回新内容（不静默拼接旧历史）', async () => {
    const sid = uniqueSid('rewrite-id')
    const oldLines = threeTurnLines(sid)
    const filePath = writeSessionFile(oldLines)
    const { reader } = makeIndexReader({ [sid]: filePath })
    await reader.getHistory(sid)
    const newLines = threeTurnLines(sid).map((l) => l.replaceAll('"u1"', '"X1"').replaceAll('"u2"', '"X2"').replaceAll('"u3"', '"X3"'))
    expect(Buffer.byteLength(newLines.join('\n') + '\n')).toBe(Buffer.byteLength(oldLines.join('\n') + '\n'))
    const prevMtime = fs.statSync(filePath).mtime
    writeFileSync(filePath, newLines.join('\n') + '\n', 'utf-8')
    fs.utimesSync(filePath, prevMtime, prevMtime)

    const result = await reader.getHistory(sid)

    // 旧索引的 entryId（u1..）在新文件中不存在 → verify 失配 → 全量重建 → 新边界内容
    expect(result.messages.map((m) => m.content)).toEqual(['q1', 'r1', 'q2', 'r2', 'q3', 'r3'])
    expect(result.truncated).toBe(false)
    // 失配重建后 cursor 按新索引解析：新 entryId X3 = 最新 turn 边界，锚前最近 1 turn = turn 2
    const page = await reader.getHistory(sid, { cursor: 'X3', limitTurns: 1 })
    expect(page.messages.map((m) => m.content)).toEqual(['q2', 'r2'])
  })

  it('追加新 turn → 索引续扫纳入（S 之后追加不进本次读取，下一次请求可见）', async () => {
    const sid = uniqueSid('append')
    const filePath = writeSessionFile(threeTurnLines(sid))
    const { reader } = makeIndexReader({ [sid]: filePath })
    const first = await reader.getHistory(sid)
    expect(first.totalTurnsEstimate).toBe(3)
    // 真实追加（pi append 形态：文件尾补一行）
    fs.appendFileSync(filePath, entryLine('u4', 'user', 'q4') + '\n')
    fs.appendFileSync(filePath, entryLine('a4', 'assistant', 'r4') + '\n')

    const second = await reader.getHistory(sid)

    expect(second.messages.map((m) => m.content)).toEqual(['q1', 'r1', 'q2', 'r2', 'q3', 'r3', 'q4', 'r4'])
    expect(second.totalTurnsEstimate).toBe(4)
    expect(second.truncated).toBe(false)
  })
})

describe('inflight 合并与生命周期挂点', () => {
  it('并发 getHistory 同 session 共享同一 promise（W20 Fix-5 保留）；完成后 inflight 清槽', async () => {
    const sid = uniqueSid('inflight')
    const filePath = writeSessionFile(threeTurnLines(sid))
    const { reader, sessionStore } = makeIndexReader({ [sid]: filePath })
    // 并发两调：第二个在第一个的同步段（定位 + ensureFresh 启动）后命中 inflight——
    // scanSessions 定位只执行 1 次（分派合并），两结果一致（无交错写）
    const [r1, r2] = await Promise.all([reader.getHistory(sid), reader.getHistory(sid)])
    expect(r1).toEqual(r2)
    expect(sessionStore.scanSessions).toHaveBeenCalledTimes(1)
    // inflight 完成后清槽：第三次调用重新走完整分派
    const third = await reader.getHistory(sid)
    expect(third.messages.map((m) => m.content)).toEqual(['q1', 'r1', 'q2', 'r2', 'q3', 'r3'])
    expect(sessionStore.scanSessions).toHaveBeenCalledTimes(2)
  })

  it('onSessionDisposed：只清内存索引（幂等 no-op），不取消文件读取——后续读取仍正常', async () => {
    const sid = uniqueSid('disposed')
    const filePath = writeSessionFile(threeTurnLines(sid))
    const { reader } = makeIndexReader({ [sid]: filePath })
    await reader.getHistory(sid)
    expect(() => reader.onSessionDisposed(sid)).not.toThrow()
    expect(() => reader.onSessionDisposed('s-none')).not.toThrow() // 未缓存 session 幂等
    const again = await reader.getHistory(sid) // 文件读取不被取消：内容照常返回
    expect(again.messages.map((m) => m.content)).toEqual(['q1', 'r1', 'q2', 'r2', 'q3', 'r3'])
  })

  it('onSessionDeleted（真删除专属转发）：后续读取按 ENOENT 空页语义收尾（挂点转发到自持 store）', async () => {
    const sid = uniqueSid('deleted')
    const filePath = writeSessionFile(threeTurnLines(sid))
    const { reader } = makeIndexReader({ [sid]: filePath })
    await reader.getHistory(sid)
    reader.onSessionDeleted(sid)
    // 真删除后读取：取消标记 → ensureFresh null → 空页（被取消请求语义，D5）
    const result = await reader.getHistory(sid)
    expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
  })

  it('主会话文件被删（ENOENT）→ 空页（现有空页语义，非 ENOENT IO 错误显式上抛由 store 分级）', async () => {
    const sid = uniqueSid('enoent')
    const filePath = writeSessionFile(threeTurnLines(sid))
    const { reader } = makeIndexReader({ [sid]: filePath })
    await reader.getHistory(sid) // 建索引
    fs.rmSync(filePath, { force: true })
    const result = await reader.getHistory(sid)
    expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-message-count.test.ts
// ======================================================================

let base: string | null = null


function fixturePath(name: string): string {
  if (!base) base = mkdtempSync(join(tmpdir(), 'taiji-session-message-count-'))
  return join(base, name)
}


/** pi 1.0 FileEntry 形态的最小 JSONL 行构造（SessionHeader / SessionEntry 联合各成员） */
const lines = {
  header: { type: 'session', version: 3, id: 'sess-1', timestamp: '2026-10-12T00:00:00Z', cwd: '/p' },
  userMessage: { type: 'message', id: 'e1', parentId: null, timestamp: 't', message: { role: 'user', content: '你好', timestamp: 1 } },
  assistantMessage: { type: 'message', id: 'e2', parentId: 'e1', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: '回复' }], model: 'm', provider: 'p', usage: {}, timestamp: 2 } },
  toolResultMessage: { type: 'message', id: 'e3', parentId: 'e2', timestamp: 't', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 } },
  systemMessage: { type: 'message', id: 'e4', parentId: 'e2', timestamp: 't', message: { role: 'system', content: 'sys', timestamp: 4 } },
  thinkingLevelChange: { type: 'thinking_level_change', id: 'e5', parentId: 'e2', timestamp: 't', thinkingLevel: 'high' },
  modelChange: { type: 'model_change', id: 'e6', parentId: 'e2', timestamp: 't', provider: 'p', modelId: 'm2' },
  usage: { type: 'usage', id: 'e7', parentId: 'e2', timestamp: 't', kind: 'cache_warm', provider: 'p', model: 'm', usage: {} },
  compaction: { type: 'compaction', id: 'e8', parentId: 'e2', timestamp: 't', summary: '摘要', firstKeptEntryId: 'e1', tokensBefore: 100 },
  sessionInfo: { type: 'session_info', id: 'e9', parentId: null, timestamp: 't', name: '我的会话' },
  custom: { type: 'custom', id: 'e10', parentId: 'e2', timestamp: 't', customType: 'x', data: {} },
  customMessage: { type: 'custom_message', id: 'e11', parentId: 'e2', timestamp: 't', customType: 'x', content: 'ctx', display: false },
  contextEdit: { type: 'context_edit', id: 'e12', parentId: 'e2', timestamp: 't', targetId: 'e1', replacement: null },
  label: { type: 'label', id: 'e13', parentId: null, timestamp: 't', targetId: 'e1', label: '书签' },
} as const


function jsonlOf(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-message-count', () => {
afterEach(() => {
  if (base) {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    base = null
  }
})
describe('countSessionMessagesInFile 计数口径', () => {
  it('混合条目：只计 user/assistant message entry（header/toolResult/system/其余 entry 类型不计）', async () => {
    const file = fixturePath('mixed.jsonl')
    writeFileSync(file, jsonlOf(
      lines.header,
      lines.userMessage,
      lines.assistantMessage,
      lines.toolResultMessage,
      lines.systemMessage,
      lines.thinkingLevelChange,
      lines.modelChange,
      lines.usage,
      lines.compaction,
      lines.sessionInfo,
      lines.custom,
      lines.customMessage,
      lines.contextEdit,
      lines.label,
    ))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(2)
  })

  it('多轮交替消息：每条 user/assistant 各计 1', async () => {
    const file = fixturePath('turns.jsonl')
    writeFileSync(file, jsonlOf(
      lines.header,
      lines.userMessage,
      lines.toolResultMessage,
      lines.assistantMessage,
      lines.userMessage,
      lines.assistantMessage,
    ))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(4)
  })

  it('损坏行（非法 JSON / 半写尾行）跳过不中断计数', async () => {
    const file = fixturePath('corrupted.jsonl')
    writeFileSync(file, jsonlOf(lines.header, lines.userMessage) + '{"type":"message","id":"half",\n' + jsonlOf(lines.assistantMessage))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(2)
  })

  it('空行与空白行不计（合法 JSONL 形态容忍）', async () => {
    const file = fixturePath('blank-lines.jsonl')
    writeFileSync(file, '\n' + JSON.stringify(lines.userMessage) + '\n\n   \n' + JSON.stringify(lines.assistantMessage) + '\n')

    await expect(countSessionMessagesInFile(file)).resolves.toBe(2)
  })

  it('纯 header 文件（pi 延迟写入后未产生消息的合法形态）→ 0', async () => {
    const file = fixturePath('header-only.jsonl')
    writeFileSync(file, jsonlOf(lines.header))

    await expect(countSessionMessagesInFile(file)).resolves.toBe(0)
  })
})
describe('countSessionMessagesInFile 失败语义', () => {
  it('文件不存在（pi 延迟写入窗口）→ 0 不报错', async () => {
    const file = fixturePath('not-exist.jsonl')
    rmSync(file, { force: true }) // 确保不存在

    await expect(countSessionMessagesInFile(file)).resolves.toBe(0)
  })

  it('目录路径（EISDIR 读失败）→ 上抛（错误回传 renderer 占位，非 ENOENT 归 0）', async () => {
    const dir = fixturePath('a-dir.jsonl')
    mkdirSync(dir, { recursive: true })

    await expect(countSessionMessagesInFile(dir)).rejects.toThrow()
  })
})
describe('countSessionMessagesInFile 大文件流式读', () => {
  it('多行 fixture（6000 entry）流式计数正确（实现侧 createReadStream+readline 恒定内存）', async () => {
    const file = fixturePath('large.jsonl')
    const parts: string[] = [JSON.stringify(lines.header)]
    // 2000 轮对话 = 4000 条计数消息 + 2000 条 toolResult（不计）+ header
    for (let i = 0; i < 2000; i++) {
      parts.push(JSON.stringify(lines.userMessage))
      parts.push(JSON.stringify(lines.toolResultMessage))
      parts.push(JSON.stringify(lines.assistantMessage))
    }
    writeFileSync(file, parts.join('\n') + '\n')

    await expect(countSessionMessagesInFile(file)).resolves.toBe(4000)
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-entry-removal.test.ts
// ======================================================================

// ── Mocks（路径相对本测试文件，解析后与被测模块的 import 同一文件）──

const journalAppends: CrashJournalEvent[] = []

vi.mock('../../../infra/crash-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/crash-journal.js')>()
  return { ...actual, getCrashJournal: () => ({ append: (e: CrashJournalEvent) => { journalAppends.push(e) } }), }
})


vi.mock('../background-task-reaper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../background-task-reaper.js')>()
  return {
    ...actual,
    reapSessionBackgroundTasks: vi.fn(async () => undefined),
  }
})


vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => '/mock/pi-agent-dir', }
})


function makeSession(id: string): IManagedSessionView {
  return {
    id,
    cwd: '/test',
    label: id,
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
  } as unknown as IManagedSessionView
}


function makeDeps(overrides: Partial<SessionEntryRemovalDeps> = {}): SessionEntryRemovalDeps & {
  calls: string[]
  destroyedHandler: ReturnType<typeof vi.fn>
} {
  const sessions = new Map<string, IManagedSessionView>([
    ['s1', makeSession('s1')],
    ['s2', makeSession('s2')],
  ])
  const calls: string[] = []
  const destroyedHandler = vi.fn((summary: SessionSummary) => { calls.push(`destroyed:${summary.id}`) })
  const deps: SessionEntryRemovalDeps = {
    getSession: (id) => sessions.get(id),
    removeEntry: (id) => { sessions.delete(id); calls.push(`removeEntry:${id}`) },
    toSummary: (session) => { calls.push(`toSummary:${session.id}`); return { id: session.id } as unknown as SessionSummary },
    cancelRespawn: (id) => { calls.push(`cancelRespawn:${id}`) },
    clearSessionViewed: (id) => { calls.push(`clearViewed:${id}`) },
    fireOnSessionDelete: (id) => { calls.push(`onDelete:${id}`) },
    getOnSessionDestroyedHandlers: () => [destroyedHandler],
    unwatchBackgroundTasks: (id) => { calls.push(`unwatch:${id}`) },
    disposeHistoryReader: (id) => { calls.push(`disposeHistory:${id}`) },
    disposeTraceSync: (id) => { calls.push(`disposeTrace:${id}`) },
    disposeProjection: (id) => { calls.push(`disposeProjection:${id}`) },
    disposeRecords: (id) => { calls.push(`disposeRecords:${id}`) },
    clearMessageBusSession: (id) => { calls.push(`clearBus:${id}`) },
    ...overrides,
  }
  return { ...deps, calls, destroyedHandler }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-entry-removal', () => {
describe('SessionEntryRemovalOrchestrator 销毁链单步隔离（RT-4#1）', () => {
  beforeEach(() => {
    journalAppends.length = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('mock 门禁：reaper 必须被 vi.mock 拦截（hermetic 前提，防路径写错静默失效）', async () => {
    const reaperModule = await import('../background-task-reaper.js')
    expect(vi.isMockFunction(reaperModule.reapSessionBackgroundTasks)).toBe(true)
  })

  it('dispose 抛错：该步降级日志+journal，后续步骤继续收敛（removeEntry / 其余 dispose / bus 清理必达）', () => {
    const deps = makeDeps({
      disposeProjection: () => { throw new Error('projection dispose exploded') },
    })
    const orchestrator = new SessionEntryRemovalOrchestrator(deps)

    expect(() => orchestrator.remove('s1')).not.toThrow()

    // 抛错步之前的步骤全部完成
    expect(deps.calls).toContain('toSummary:s1')
    expect(deps.calls).toContain('removeEntry:s1')
    // 抛错步之后的步骤不被打断（终态必达）
    expect(deps.calls).toContain('disposeRecords:s1')
    expect(deps.calls).toContain('clearBus:s1')
    expect(deps.destroyedHandler).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
    // 失败落 crash journal（RT-4#1：失败记 journal）
    expect(journalAppends).toContainEqual(expect.objectContaining({
      layer: 'runtime',
      event: 'crash',
      reason: 'destroy-chain-step-failed',
      sessionId: 's1',
    }))
  })

  it('其余 session 不受累：s1 链抛错后，s2 的 remove 全链正常完成', () => {
    const s2Trace: string[] = []
    const deps = makeDeps({
      disposeTraceSync: (id) => {
        if (id === 's1') throw new Error('trace dispose exploded for s1')
        s2Trace.push(id)
      },
    })
    const orchestrator = new SessionEntryRemovalOrchestrator(deps)

    orchestrator.remove('s1')
    orchestrator.remove('s2')

    // s2 全链完成（含抛错步之后的全部步骤）
    expect(s2Trace).toEqual(['s2'])
    expect(deps.calls).toContain('disposeProjection:s2')
    expect(deps.calls).toContain('disposeRecords:s2')
    expect(deps.calls).toContain('clearBus:s2')
    expect(deps.calls).toContain('removeEntry:s2')
    expect(deps.destroyedHandler).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }))
  })

  it('toSummary 抛错：destroyedSummary 降级最小形状，条目删除与销毁扇出不被打断', () => {
    const deps = makeDeps({
      toSummary: () => { throw new Error('git reader exploded') },
    })
    const orchestrator = new SessionEntryRemovalOrchestrator(deps)

    expect(() => orchestrator.remove('s1')).not.toThrow()

    expect(deps.calls).toContain('removeEntry:s1')
    // 销毁通知仍发出（最小形状：id + dead 兜底字段，宁发少知不发错）
    expect(deps.destroyedHandler).toHaveBeenCalledWith(expect.objectContaining({
      id: 's1',
      status: 'dead',
      label: 's1',
    }))
    expect(journalAppends).toContainEqual(expect.objectContaining({
      reason: 'destroy-chain-step-failed',
      sessionId: 's1',
    }))
  })

  it('全链无异常：零隔离 journal 行（deleted journal 照常，隔离路径不产生噪音事件）', () => {
    const orchestrator = new SessionEntryRemovalOrchestrator(makeDeps())
    orchestrator.remove('s1')
    // 第 1 步 deleted journal 行恒在（D1 唯一挂点）；无任何 destroy-chain-step-failed 行
    expect(journalAppends).toEqual([
      expect.objectContaining({ layer: 'pi', event: 'deleted', sessionId: 's1' }),
    ])
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/d8-compat.test.ts
// ======================================================================

const FIXTURE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-engine-cli.mjs')


let tmpDir: string

let dataDir: string

const savedEnv = new Map<string, string | undefined>()


function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}


/** fake CLI 直跑（协议往返真实；envEcho 白名单回显供透传断言）。 */
function fakeCliEnvEcho(opts: {
  cliPath?: string
  processEnv?: Record<string, string | undefined>
  engineDataDir: string
}): Promise<Record<string, string | undefined>> {
  const cliPath = opts.cliPath ?? FIXTURE_CLI
  const engine = createZcodeEngine({
    engineDataDir: () => opts.engineDataDir,
    ...(opts.cliPath !== undefined ? { cliPath } : {}),
    ...(opts.processEnv !== undefined ? { processEnv: opts.processEnv } : {}),
  })
  // RemoteEngine.read 的应答是 SessionView 结构断言——fixture 在 read 应答里附
  // envEcho 白名单摘要（initialize 应答与 read 应答共享同一进程 env）。
  // read 前置 ensureConnected → initialize；此处直接取 view 上的 envEcho 附加字段。
  return engine
    .read({ data: { v: 1, engineId: 'zcode', sessionRef: { sessionId: 's-d8' }, adapterVersion: 'd8-test' } })
    .then((view) => (view as unknown as { envEcho?: Record<string, string | undefined> }).envEcho ?? {})
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('d8-compat', () => {
afterEach(() => {
  setEnv('FAKE_READ_MODE', 'ok')
})
// [密闭化] 宿主注入的引擎执行器/发现根（打包态 TaiJi 会话 env：TAIJI_AGENT_ENGINE_NODE
// 指向 Electron 主二进制）会把 hostKindOf 嗅探到 pi-extension 分支——用主二进制当
// node 执行器 spawn fake CLI，进程立即 exit 0 → engine_crashed。测试恒用 standalone
// 语义（PATH node），剥这两个 env（afterAll 经 savedEnv 恢复）。
// 托管态隔离：TaiJi 托管 env（runtime 注入的 control env）下跑测会让协议客户端误选
// runtime transport——引擎改由外层 runtime spawn，L0 注入发生在 runtime 进程（其自身
// 数据根），deps.engineDataDir 的显式值到不了子进程 env，envEcho 断言必失败。本套件
// 锚定本地 spawn 语义（fake 引擎由测试进程直启），剥除 control env（键名 = SDK 单源
// 常量）；standalone 态剥除为 no-op。
beforeAll(() => {
  setEnv('TAIJI_AGENT_ENGINE_NODE', undefined)
  setEnv('TAIJI_AGENT_ENGINE_ROOTS', undefined)
  setEnv(CONTROL_ENV_SOCKET, undefined)
  setEnv(CONTROL_ENV_ROOT_SESSION_ID, undefined)
})
// cliPath 直接以文件形态被 EngineClient spawn——需要可执行位（运行时自愈，
// 不改 repo 内文件 mode；协议测试文件的拷贝路径已单独 chmod）。
beforeAll(() => {
  fs.chmodSync(FIXTURE_CLI, 0o755)
})
afterAll(async () => {
  for (const [key, value] of savedEnv) setEnv(key, value)
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('W8 D8 兼容公共部分薄壳', () => {
  it('createZcodeEngine 返回 RemoteEngine(zcode)：read 走协议（cliPath 指向 fake CLI）', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('TAIJI_AGENT_DATA_DIR', dataDir)
    const engine = createZcodeEngine({ engineDataDir: () => dataDir, cliPath: FIXTURE_CLI })
    expect(engine.id).toBe('zcode')
    const view = await engine.read({
      data: { v: 1, engineId: 'zcode', sessionRef: { sessionId: 's-1' }, adapterVersion: 'd8-test' },
    })
    expect(view.turns[0]?.text).toBe('fake turn') // 协议 read 生效（非 inproc / 非降级）
    expect(view.source).toBe('native')
  }, 20_000)

  it('registerZcodeEngine 薄壳：确保 zcode descriptor 注册（routeEngine 行为范围断言）', async () => {
    tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = dataDir ?? path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('TAIJI_AGENT_DATA_DIR', dataDir)
    registerZcodeEngine()
    // routeEngine 注入 probe stub（注册断言只看 has 校验与 get 装配，不 spawn）。
    const result = await routeEngine({
      routing: { callEngine: 'zcode' },
      probe: async () => ({ ok: true, engineVersion: 'stub', checks: [] }),
    })
    expect(result.engineId).toBe('zcode')
  }, 20_000)

  it('deps.sources 不跨进程：传入被忽略不抛（协议不变量 5）', () => {
    const engine = createZcodeEngine({
      engineDataDir: () => '/tmp/w8-d8-sources',
      cliPath: FIXTURE_CLI,
      sources: { configPath: '/should/not/cross' } as unknown as never,
    })
    expect(engine.id).toBe('zcode')
  })

  it('createZcodeEngine 携带部署形态翻译面：vendored manifest modelTranslation → translateModelRef 查表改写', () => {
    // 不传 cliPath：走 vendored 相对定位读 packages/zcode-subagent-cli/package.json
    // （manifest 声明 modelTranslation）；构造同步不 spawn，翻译面为纯查表。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-translation-'))
    try {
      const engine = createZcodeEngine({ engineDataDir: () => dir })
      expect(typeof engine.translateModelRef).toBe('function')
      // vendored 包声明的目标段（ADR-0142 D1 已发布形态）
      expect(engine.translateModelRef!('zai-coding-cn/glm-5.3-flash')).toBe(
        'account:bigmodel-individual-coding-plan/glm-5.3-flash',
      )
      // 表外 provider / 无 provider 段 → 恒等透传（幂等）
      expect(engine.translateModelRef!('deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat')
      expect(engine.translateModelRef!('glm-5.3-flash')).toBe('glm-5.3-flash')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
describe('W8 D8 引擎子进程 L0 env 注入', () => {
  it('数据根经 L0 显式注入（deps.engineDataDir → TAIJI_AGENT_DATA_DIR）', async () => {
    tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'w8-d8-compat-'))
    dataDir = dataDir ?? path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    setEnv('TAIJI_AGENT_DATA_DIR', dataDir)
    const envEcho = await fakeCliEnvEcho({ engineDataDir: dataDir, cliPath: FIXTURE_CLI })
    expect(envEcho['TAIJI_AGENT_DATA_DIR']).toBe(dataDir)
  }, 20_000)
})
});
