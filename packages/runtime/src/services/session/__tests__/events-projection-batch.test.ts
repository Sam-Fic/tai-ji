/**
 * U1-lite 批加载单测（startup-readiness 设计 §7.3 / D4 / D10；RL5 看守面）。
 *
 * 看守行为：
 * - 冷读批末一次发布：attach 冷读 N 个事件文件，onProjectionChange 恰好 1 次
 *   （A4 剧本「session.subagents 推送帧数 = 1」的单测形态——真机剧本归 D3 验收面）；
 * - 未变化零内容读（D4 最小检测）：重复 attach 对未变化文件 statSync 快路径零内容读
 *   （readEventTail 仍被调、events 恒空）、零新发布；
 * - 增量补读合批（D10）：applyJournalReport 缺口补读批末一次发布；
 * - 空批零发布；
 * - V1 对照计时：91 事件文件冷读（批末一次形态）毫秒级（设计 P1 实测锚点：同量级
 *   「抑制发布时 21 毫秒 / 不抑制 11-12 秒」——改前基线见 deviations 登记）。
 *
 * 测试框架：vitest；fixture 落 mkdtemp 临时目录（自建自删）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/events-projection-batch.test.ts
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordCreatedEvent, RecordSettledEvent } from '@zhushanwen/subagent-core'
import type { SubagentJournalReport, SubagentJournalEvent } from '@zhushanwen/extension-protocol'

// readEventTail 调用观测（D4「未变化零内容读」的断言面）：包装原语记录每次调用的
// offset 与返回事件数，不改变行为。文件级 mock 对本文件全部用例生效。
vi.mock('@zhushanwen/subagent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zhushanwen/subagent-core')>()
  const tailCalls: Array<{ path: string; offset: number; events: number }> = []
  return {
    ...actual,
    readEventTail: (filePath: string, offset: number, parseLine: (line: string) => unknown) => {
      const chunk = actual.readEventTail(filePath, offset, parseLine as never)
      tailCalls.push({ path: filePath, offset, events: chunk.events.length })
      return chunk
    },
    __readEventTailCallsForTest: tailCalls,
  }
})

import * as subagentCore from '@zhushanwen/subagent-core'
import { SessionEventProjection } from '../events-projection.js'

/** readEventTail 观测序列（经 mock 模块命名空间侧通道取）。 */
function tailCalls(): Array<{ path: string; offset: number; events: number }> {
  const mod = subagentCore as unknown as { __readEventTailCallsForTest?: Array<{ path: string; offset: number; events: number }> }
  return mod.__readEventTailCallsForTest ?? []
}

const SID = 's1'

function createdEvent(id: string, seq = 1, over: Partial<RecordCreatedEvent> = {}): RecordCreatedEvent {
  return {
    type: 'record-created',
    seq,
    ts: 1000 + seq,
    id,
    agent: 'worker',
    task: 'Do work',
    slug: 'work',
    origin: 'tool',
    rootSessionId: SID,
    depth: 0,
    mode: 'background',
    startedAt: 1000,
    ...over,
  }
}

function settledRecordEvent(seq = 2, over: Partial<RecordSettledEvent> = {}): RecordSettledEvent {
  return {
    type: 'record-settled',
    seq,
    ts: 3000,
    stopReason: 'completed',
    endedAt: 3000,
    turns: 1,
    totalTokens: 100,
    ...over,
  }
}

function journalReport(
  fileKey: string,
  events: ReadonlyArray<Record<string, unknown>>,
): SubagentJournalReport {
  return {
    domain: 'record',
    fileKey,
    events: events as SubagentJournalEvent[],
    sessionId: SID,
    emittedAt: 42,
  }
}

/** 写一个 record 事件文件（首行 header + 一条 created 事件，u0 契约形态）。 */
function writeRecordFile(recordsDir: string, id: string, events: ReadonlyArray<RecordCreatedEvent | RecordSettledEvent>): void {
  const lines = [
    JSON.stringify({ type: 'record-events', id }),
    ...events.map((e) => JSON.stringify(e)),
  ]
  writeFileSync(join(recordsDir, `${id}.events`), lines.join('\n') + '\n')
}

describe('SessionEventProjection 批加载（U1-lite / RL5）', () => {
  let dir: string
  let recordsDir: string
  let runJournalDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'u1lite-batch-'))
    recordsDir = join(dir, 'records')
    runJournalDir = join(dir, 'runs')
    mkdirSync(recordsDir, { recursive: true })
    mkdirSync(runJournalDir, { recursive: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function makeProjection(onChange: () => void): SessionEventProjection {
    return new SessionEventProjection({
      sessionId: SID,
      recordsDir,
      runJournalDir,
      onProjectionChange: onChange,
    })
  }

  it('冷读批末一次：N 个事件文件冷读，onProjectionChange 恰好 1 次（推送帧数 = 1）', () => {
    const N = 12
    for (let i = 0; i < N; i++) writeRecordFile(recordsDir, `sa-${i}`, [createdEvent(`sa-${i}`)])
    const onChange = vi.fn()
    const projection = makeProjection(onChange)
    try {
      expect(projection.isBatchLoading()).toBe(false) // 批外恒 false
      projection.applyEntryBatch([])
      expect(onChange).not.toHaveBeenCalled() // entry 批路径发布归调用方（既有语义不变）
      projection.attach()
      expect(projection.subagents.size).toBe(N)
      expect(onChange).toHaveBeenCalledTimes(1) // RL5：批末一次（改前形态 = N 次）
    } finally {
      projection.dispose()
    }
  })

  it('未变化零内容读（D4 最小检测）：重复 attach 零新发布，未变化文件 events 恒空', () => {
    writeRecordFile(recordsDir, 'sa-x', [createdEvent('sa-x')])
    const onChange = vi.fn()
    const projection = makeProjection(onChange)
    try {
      projection.attach()
      expect(onChange).toHaveBeenCalledTimes(1)
      onChange.mockClear()
      tailCalls().length = 0

      projection.attach() // 二次冷读：全部文件未变化
      expect(projection.subagents.size).toBe(1)
      expect(onChange).not.toHaveBeenCalled() // 零变化 = 零发布
      // readEventTail stat 快路径：未变化文件仍被逐个 stat（读到 size === offset 早退），
      // 返回 events 恒空（零内容读）
      const calls = tailCalls()
      expect(calls.length).toBe(1)
      expect(calls.every((c) => c.events === 0)).toBe(true)
    } finally {
      projection.dispose()
    }
  })

  it('只补 size 变化文件：单文件追加后 attach，仅该文件产生非零事件读', () => {
    writeRecordFile(recordsDir, 'sa-a', [createdEvent('sa-a')])
    writeRecordFile(recordsDir, 'sa-b', [createdEvent('sa-b')])
    const onChange = vi.fn()
    const projection = makeProjection(onChange)
    try {
      projection.attach()
      onChange.mockClear()
      tailCalls().length = 0

      // 仅 sa-a 追加终态事件（size 变化）；sa-b 未变
      appendFileSync(join(recordsDir, 'sa-a.events'), `${JSON.stringify(settledRecordEvent())}\n`)
      projection.attach()

      expect(onChange).toHaveBeenCalledTimes(1) // 有变化 → 批末一次
      expect(projection.subagents.get('sa-a')?.status).toBe('idle')
      const nonEmpty = tailCalls().filter((c) => c.events > 0)
      expect(nonEmpty).toHaveLength(1)
      expect(nonEmpty[0]?.path).toContain('sa-a')
    } finally {
      projection.dispose()
    }
  })

  it('增量补读合批（D10）：缺口补读发布一次（readFromOffset 补读链内不逐帧发布）', () => {
    writeRecordFile(recordsDir, 'sa-c', [createdEvent('sa-c', 1)])
    const onChange = vi.fn()
    const projection = makeProjection(onChange)
    try {
      projection.applyEntryBatch([])
      projection.attach()
      expect(onChange).toHaveBeenCalledTimes(1)
      onChange.mockClear()

      // 落盘追加 seq 2、3，报告只带 seq 3（seq 2 缺口）→ 缺口补读从字节偏移读到尾
      appendFileSync(join(recordsDir, 'sa-c.events'), `${JSON.stringify(settledRecordEvent(2))}\n`)
      const ev3 = { type: 'record-round-idle', seq: 3, ts: 3500, stopReason: 'completed', turns: 1 }
      appendFileSync(join(recordsDir, 'sa-c.events'), `${JSON.stringify(ev3)}\n`)
      const applied = projection.applyJournalReport(journalReport('sa-c', [ev3]))
      expect(applied).toBe(true)
      expect(projection.subagents.get('sa-c')?.status).toBe('idle')
      expect(onChange).toHaveBeenCalledTimes(1) // 补读批末一次（缺口分支整体一批）
    } finally {
      projection.dispose()
    }
  })

  it('空目录冷读：零发布（空批不补发）', () => {
    const onChange = vi.fn()
    const projection = makeProjection(onChange)
    try {
      projection.attach()
      expect(onChange).not.toHaveBeenCalled()
      expect(projection.subagents.size).toBe(0)
    } finally {
      projection.dispose()
    }
  })

  it('批内标志：attach 完成后 isBatchLoading=false（批外读点恒 false 语义）', () => {
    writeRecordFile(recordsDir, 'sa-d', [createdEvent('sa-d')])
    const seenDuringChange: boolean[] = []
    const projection = new SessionEventProjection({
      sessionId: SID,
      recordsDir,
      runJournalDir,
      onProjectionChange: () => {
        // 批末补发的发布回调在 endBatch 置位之后到达——读点恒批外
        seenDuringChange.push(projection.isBatchLoading())
      },
    })
    try {
      projection.attach()
      expect(seenDuringChange).toEqual([false])
      expect(projection.isBatchLoading()).toBe(false)
    } finally {
      projection.dispose()
    }
  })
})

describe('V1 对照计时（U1-lite：冷读批末一次形态的毫秒级读）', () => {
  it('91 个事件文件冷读（批末一次发布）为毫秒级（设计 P1 锚点：抑制形态 21ms；不抑制形态 11-12s）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'u1lite-v1-'))
    const recordsDir = join(dir, 'records')
    const runJournalDir = join(dir, 'runs')
    mkdirSync(recordsDir, { recursive: true })
    mkdirSync(runJournalDir, { recursive: true })
    try {
      // 91 个事件文件（设计 P1 实测的同量级），每文件 created + settled 两条事件
      for (let i = 0; i < 91; i++) {
        writeRecordFile(recordsDir, `sa-${i}`, [createdEvent(`sa-${i}`, 1), settledRecordEvent(2, { endedAt: 3000 })])
      }
      const onChange = vi.fn()
      const projection = new SessionEventProjection({
        sessionId: SID,
        recordsDir,
        runJournalDir,
        onProjectionChange: onChange,
      })
      try {
        const t0 = performance.now()
        projection.attach()
        const elapsedMs = performance.now() - t0
        expect(projection.subagents.size).toBe(91)
        expect(onChange).toHaveBeenCalledTimes(1)
        // 实测值打 stdout（对照记录；断言阈值 = 毫秒级上界 × 两个数量级余量，拦
        // 「不抑制的 11-12s 形态回潮」——该形态的量级特征是秒级）
        console.info(`[v1-timing] 91 files cold attach (batch end single publish): ${elapsedMs.toFixed(1)}ms`)
        expect(elapsedMs).toBeLessThan(1000)
      } finally {
        projection.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
