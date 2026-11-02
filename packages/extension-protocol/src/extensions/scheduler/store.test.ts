import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  readSchedulerStore,
  SCHEDULER_STORE_SCHEMA_VERSION,
  schedulerStoreFilePath,
  writeSchedulerStore,
} from './store.js'
import type { ScheduledTask } from './types.js'

// 任务库快照文件行为单测（scheduler-redesign 方案 B）：
// 路径推导（sessionId 分片 + workspace 隔离 + 非法 sessionId fail-fast）、
// 原子替换写（tmp 不残留 / 快照剥离 pending）、读三分支（ok / missing / corrupt 留证）。

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-store-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'a1b2c3d4',
    name: 'check-build',
    prompt: 'check build',
    kind: 'recurring',
    schedule: { mode: 'interval', intervalMs: 3_600_000 },
    enabled: true,
    createdAt: 1_000,
    nextRunAt: 3_600_000,
    runCount: 2,
    history: [{ at: 1, status: 'success' }],
    ...overrides,
  }
}

describe('schedulerStoreFilePath', () => {
  it('按 sessionId 分片 + cwd segments 隔离（POSIX 根归一为 root 段，与旧 store 推导同构）', () => {
    const p = schedulerStoreFilePath('/agent', '/w/proj', 'sess-1')
    expect(p).toBe(path.join('/agent', 'scheduler', 'root', 'w', 'proj', 'sess-1.json'))
  })

  it('不同 cwd 互不干扰（workspace 隔离层）', () => {
    expect(schedulerStoreFilePath('/agent', '/w/a', 's1'))
      .not.toBe(schedulerStoreFilePath('/agent', '/w/b', 's1'))
  })

  it('不同 sessionId 不同分片（fork → 不同文件天然不共享）', () => {
    expect(schedulerStoreFilePath('/agent', '/w', 's1'))
      .not.toBe(schedulerStoreFilePath('/agent', '/w', 's2'))
  })

  it('根路径 cwd 的 root 段推导', () => {
    const p = schedulerStoreFilePath('/agent', '/', 's1')
    expect(p).toBe(path.join('/agent', 'scheduler', 'root', 's1.json'))
  })

  it('非法 sessionId（空 / 路径穿越 / 特殊字符）fail-fast', () => {
    expect(() => schedulerStoreFilePath('/agent', '/w', '')).toThrow()
    expect(() => schedulerStoreFilePath('/agent', '/w', '../escape')).toThrow()
    expect(() => schedulerStoreFilePath('/agent', '/w', 'a/b')).toThrow()
    expect(() => schedulerStoreFilePath('/agent', '/w', 'ok_id-1')).not.toThrow()
  })
})

describe('writeSchedulerStore / readSchedulerStore', () => {
  it('写后读回：任务集等值、快照带 schemaVersion、目录自动创建', () => {
    const file = schedulerStoreFilePath(dir, '/w/proj', 'sess-1')
    const tasks = [makeTask(), makeTask({ id: 'ffff0000', pending: true })]
    writeSchedulerStore(file, { sessionFile: '/sessions/s.jsonl', tasks })

    const read = readSchedulerStore(file)
    expect(read).toMatchObject({ kind: 'ok' })
    if (read.kind !== 'ok') return
    expect(read.tasks).toHaveLength(2)
    expect(read.tasks[0]).toEqual(makeTask())
    // pending 运行时标记被写入口剥离
    expect(read.tasks[1]!.pending).toBeUndefined()

    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { schemaVersion: number; sessionFile?: string }
    expect(raw.schemaVersion).toBe(SCHEDULER_STORE_SCHEMA_VERSION)
    expect(raw.sessionFile).toBe('/sessions/s.jsonl')
  })

  it('history 逐项拷贝：写后原任务 history 变异不污染快照', () => {
    const file = schedulerStoreFilePath(dir, '/w', 'sess-1')
    const task = makeTask()
    writeSchedulerStore(file, { tasks: [task] })
    task.history.push({ at: 2, status: 'failed' })

    const read = readSchedulerStore(file)
    if (read.kind !== 'ok') throw new Error('expected ok')
    expect(read.tasks[0]!.history).toEqual([{ at: 1, status: 'success' }])
  })

  it('原子替换写：覆盖旧快照、无 tmp 残留', () => {
    const file = schedulerStoreFilePath(dir, '/w', 'sess-1')
    writeSchedulerStore(file, { tasks: [makeTask()] })
    writeSchedulerStore(file, { tasks: [makeTask({ id: 'deadbeef' })] })

    const read = readSchedulerStore(file)
    if (read.kind !== 'ok') throw new Error('expected ok')
    expect(read.tasks.map(t => t.id)).toEqual(['deadbeef'])

    const residues = fs.readdirSync(path.dirname(file)).filter(f => f.includes('.tmp-'))
    expect(residues).toEqual([])
  })

  it('sessionFile 缺省时字段整体省略（--no-session 形态）', () => {
    const file = schedulerStoreFilePath(dir, '/w', 'sess-1')
    writeSchedulerStore(file, { tasks: [] })
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
    expect('sessionFile' in raw).toBe(false)
  })
})

describe('readSchedulerStore 失败语义', () => {
  it('文件不存在 → missing（空任务集正常路径）', () => {
    const read = readSchedulerStore(path.join(dir, 'nope', 'sess-9.json'))
    expect(read).toEqual({ kind: 'missing' })
  })

  it('JSON 损坏 → corrupt：改名 .corrupt-<ts> 留证 + warn 注入', () => {
    const file = schedulerStoreFilePath(dir, '/w', 'sess-1')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json', 'utf-8')
    const warn = vi.fn()

    const read = readSchedulerStore(file, { warn })
    expect(read.kind).toBe('corrupt')
    if (read.kind !== 'corrupt') return
    expect(fs.existsSync(read.renamedTo)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    // 二次读同路径 → missing（原文件已被改名走）
    expect(readSchedulerStore(file)).toEqual({ kind: 'missing' })
  })

  it('schema 版本不符 → corrupt（v1 旧 store 词表不互读）', () => {
    const file = schedulerStoreFilePath(dir, '/w', 'sess-1')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, tasks: [] }), 'utf-8')
    expect(readSchedulerStore(file).kind).toBe('corrupt')
  })

  it('tasks 非数组 → corrupt', () => {
    const file = schedulerStoreFilePath(dir, '/w', 'sess-1')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, tasks: 'nope' }), 'utf-8')
    expect(readSchedulerStore(file).kind).toBe('corrupt')
  })
})
