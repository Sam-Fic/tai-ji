/**
 * G10 M0 契约测试：scheduler 小域任务契约（scheduler.ts）。
 *
 * 对账方式双保险（同 fields.test.ts 先例）：
 * - 运行级：构造样例对象，断言 Object.keys 与映射清单逐项相等（防运行时多字段）；
 * - 类型级：ExactKeys 编译锁（防实现悄悄扩字段却漏登记映射清单）。
 *
 * 覆盖四组契约：
 * - 字段映射（设计 U6「与执行域小域 schema 的字段映射在 M0 契约期定」）：同名直迁 +
 *   pending 剥离；
 * - v2 快照判形（schemaVersion=2，设计 U6「schemaVersion=2 判形」）——经 shared 单源
 *   re-export 的 extension-protocol 判形函数验证（防 re-export 链断与语义漂移）；
 * - JSONL 历史条目源（U6 双源导入另一源：plan B 前会话 JSONL `pi-scheduler:` 历史
 *   条目，写链已随 73073b169 退役）：customType 与 op 词表按 git 历史原文锁定 + 历史快照
 *   与小域视图双向键集对等（两源共用 SCHEDULER_DOMAIN_TASK_FIELDS 映射清单）；
 * - SI8 到期事实语义：task.fired 事实名 + 停机跨到期补触发谓词。
 */

import { describe, expect, it } from 'vitest'

import type { ScheduledTask } from '@zhushanwen/extension-protocol'

import {
  isSchedulerStoreFile,
  isSchedulerTaskDueForCatchUp,
  SCHEDULER_DOMAIN_TASK_FIELDS,
  SCHEDULER_FIRED_FACT,
  SCHEDULER_JSONL_ENTRY_TYPE,
  SCHEDULER_JSONL_OPS,
  SCHEDULER_STORE_SCHEMA_VERSION,
  type SchedulerDomainTask,
  type SchedulerJsonlEntryOp,
  type SchedulerJsonlTaskSnapshot,
} from '../scheduler'

type ExactKeys<T, U extends keyof T> = Exclude<keyof T, U> extends never ? true : never

/** v2 快照持久化任务（写入口剥离 pending 后的形态；可选字段全量给值，供运行级键集对账）。 */
function makeStoreTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'a1b2c3d4',
    name: '示例任务',
    prompt: '到期注入的 message',
    kind: 'once',
    schedule: { mode: 'interval', intervalMs: 60_000 },
    model: 'provider/model-a',
    enabled: true,
    createdAt: 1_000,
    nextRunAt: 2_000,
    expiresAt: 9_000,
    runCount: 3,
    lastRunAt: 1_800,
    lastStatus: 'success',
    lastError: '',
    history: [{ at: 1_800, status: 'success' }],
    ...overrides,
  }
}

// ── 类型级编译锁（此文件编译通过 = 锁成立）──

// SchedulerDomainTask 键集与映射清单逐字段对等（多字段 / 少登记都红）。
const _exactDomainKeys: ExactKeys<SchedulerDomainTask, (typeof SCHEDULER_DOMAIN_TASK_FIELDS)[number]> = true

// pending 剥离锁：运行时标记不入小域持久化 schema（'pending' ∈ 键集时该类型为 never，赋值红）。
const _pendingExcluded: 'pending' extends keyof SchedulerDomainTask ? never : true = true

// 同名直迁锁：映射清单每项都是 v2 ScheduledTask 的同名字段（差集为空 = 无改名映射）。
const _identityMapping: Exclude<(typeof SCHEDULER_DOMAIN_TASK_FIELDS)[number], keyof ScheduledTask> extends never ? true : never = true

// JSONL 历史快照键集 ⊆ 映射清单（源多字段红——两源共用同一映射清单的对等前提之一）。
const _jsonlSnapshotKeys: Exclude<keyof SchedulerJsonlTaskSnapshot, (typeof SCHEDULER_DOMAIN_TASK_FIELDS)[number]> extends never ? true : never = true

// 映射清单 ⊆ JSONL 历史快照键集（源少字段红——对等前提之二，与上一锁合成双向 exact）。
const _jsonlFieldNames: Exclude<(typeof SCHEDULER_DOMAIN_TASK_FIELDS)[number], keyof SchedulerJsonlTaskSnapshot> extends never ? true : never = true

// advance op status 唯一词形 'success'（写链原文：失败 dispatch 不落条目，transient 重试语义）。
const _jsonlAdvanceStatus: Extract<SchedulerJsonlEntryOp, { op: 'advance' }> extends {
  op: 'advance'
  taskId: string
  nextRunAt: number
  at: number
  status: 'success'
} ? true : never = true

void _exactDomainKeys
void _pendingExcluded
void _identityMapping
void _jsonlSnapshotKeys
void _jsonlFieldNames
void _jsonlAdvanceStatus

describe('scheduler 小域任务契约：字段映射（U6 M0 契约期定）', () => {
  it('映射清单逐字段 = SchedulerDomainTask 键集（运行级样例对账）', () => {
    const task: SchedulerDomainTask = makeStoreTask()
    expect(Object.keys(task).sort()).toEqual([...SCHEDULER_DOMAIN_TASK_FIELDS].sort())
  })

  it('映射清单不含 pending（运行时标记不入持久化 schema）', () => {
    expect(SCHEDULER_DOMAIN_TASK_FIELDS).not.toContain('pending')
  })

  it('记账字段在清单内（折叠派生视图的字段承载）', () => {
    const derivedFields = ['nextRunAt', 'runCount', 'lastRunAt', 'lastStatus', 'lastError', 'history']
    for (const field of derivedFields) {
      expect(SCHEDULER_DOMAIN_TASK_FIELDS).toContain(field)
    }
  })
})

describe('scheduler 小域任务契约：v2 快照判形（schemaVersion=2，单源 re-export）', () => {
  it('schema 版本常量 = 2（值单源：与 extension-protocol 同一常量）', () => {
    expect(SCHEDULER_STORE_SCHEMA_VERSION).toBe(2)
  })

  it('合法 v2 形态判 ok（含或不含 sessionFile；tasks 可为空数组）', () => {
    const withSessionFile = { schemaVersion: 2, sessionFile: '/tmp/x.jsonl', tasks: [makeStoreTask()] }
    const withoutSessionFile = { schemaVersion: 2, tasks: [] }
    expect(isSchedulerStoreFile(withSessionFile)).toBe(true)
    expect(isSchedulerStoreFile(withoutSessionFile)).toBe(true)
  })

  it('schemaVersion ≠ 2 判不 ok（v1 旧 store 文件名不同不互读）', () => {
    expect(isSchedulerStoreFile({ schemaVersion: 1, tasks: [] })).toBe(false)
    expect(isSchedulerStoreFile({ tasks: [] })).toBe(false)
  })

  it('tasks 非数组 / 顶层非对象判不 ok', () => {
    expect(isSchedulerStoreFile({ schemaVersion: 2, tasks: 'nope' })).toBe(false)
    expect(isSchedulerStoreFile(null)).toBe(false)
    expect(isSchedulerStoreFile('str')).toBe(false)
    expect(isSchedulerStoreFile([1, 2])).toBe(false)
  })

  it('tasks 项非对象判不 ok', () => {
    expect(isSchedulerStoreFile({ schemaVersion: 2, tasks: [null] })).toBe(false)
    expect(isSchedulerStoreFile({ schemaVersion: 2, tasks: ['x'] })).toBe(false)
  })

  it('字段级信任唯一写者：tasks 项缺字段也判 ok（判形不逐字段校验）', () => {
    expect(isSchedulerStoreFile({ schemaVersion: 2, tasks: [{}] })).toBe(true)
  })
})

describe('scheduler 小域任务契约：JSONL 历史条目源（U6 双源导入另一源，写链已随 73073b169 退役）', () => {
  it('customType = plan B 前写链原文词形（git 历史 73073b169^ extension-protocol TASK_ENTRY_TYPE）', () => {
    expect(SCHEDULER_JSONL_ENTRY_TYPE).toBe('pi-scheduler:task')
  })

  it('op 词表 = 4 op（upsert/advance/toggle/delete，历史冻结不随小域演进）', () => {
    expect([...SCHEDULER_JSONL_OPS].sort()).toEqual(['advance', 'delete', 'toggle', 'upsert'])
  })

  it('upsert 快照键集与映射清单逐字段对等（运行级样例对账；两源共用 SCHEDULER_DOMAIN_TASK_FIELDS）', () => {
    const snapshot: SchedulerJsonlTaskSnapshot = makeStoreTask()
    expect(Object.keys(snapshot).sort()).toEqual([...SCHEDULER_DOMAIN_TASK_FIELDS].sort())
  })

  it('4 op 形态样例可赋值 SchedulerJsonlEntryOp（判别联合编译锁的运行级佐证；ownerSessionFile 在 op 顶层）', () => {
    const ops: SchedulerJsonlEntryOp[] = [
      { op: 'upsert', taskId: 'a1b2c3d4', ownerSessionFile: '/s.json', task: makeStoreTask() },
      { op: 'advance', taskId: 'a1b2c3d4', nextRunAt: 2_000, at: 1_800, status: 'success' },
      { op: 'toggle', taskId: 'a1b2c3d4', enabled: false },
      { op: 'toggle', taskId: 'a1b2c3d4', enabled: true, nextRunAt: 3_000 },
      { op: 'delete', taskId: 'a1b2c3d4' },
    ]
    expect(ops).toHaveLength(5)
    expect(ops.every(op => op.taskId === 'a1b2c3d4')).toBe(true)
  })
})

describe('scheduler 小域任务契约：SI8 到期事实语义', () => {
  it('task.fired 事实名 = 设计原文词形', () => {
    expect(SCHEDULER_FIRED_FACT).toBe('task.fired')
  })

  it('停机跨到期：dueAt < now 且无 fired 事实 → 补触发', () => {
    expect(isSchedulerTaskDueForCatchUp({ dueAt: 1_000, hasFiredFact: false, now: 2_000 })).toBe(true)
  })

  it('fired 事实已落日志 → 不补触发（重放只重建状态不重复注入）', () => {
    expect(isSchedulerTaskDueForCatchUp({ dueAt: 1_000, hasFiredFact: true, now: 2_000 })).toBe(false)
  })

  it('dueAt >= now → 不补触发（正常到期路径处理；dueAt === now 为严格小于边界）', () => {
    expect(isSchedulerTaskDueForCatchUp({ dueAt: 2_000, hasFiredFact: false, now: 2_000 })).toBe(false)
    expect(isSchedulerTaskDueForCatchUp({ dueAt: 3_000, hasFiredFact: false, now: 2_000 })).toBe(false)
  })
})
