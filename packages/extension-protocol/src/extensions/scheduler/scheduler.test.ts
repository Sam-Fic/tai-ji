import { describe, expect, it } from 'vitest'
import {
  formatRelativeTime,
  formatSchedule,
  HISTORY_LIMIT,
  appendExecutionRecord,
  SCHEDULER_MODAL_VIEW_ID,
  type ScheduledTask,
} from '../../index'

// ── scheduler 段收缩后 barrel smoke：任务契约 + 记账 helper + 格式化器可从包入口取到
//（event sourcing 契约——TASK_ENTRY_TYPE / SchedulerEntryOp / replayFoldEntries——已随
//  任务库分离整体退役，store 契约经 ./scheduler-store 子出口，见 store.test.ts）──

describe('包入口导出 scheduler 段符号（barrel smoke）', () => {
  it('任务契约常量与记账 helper / 格式化器可从包入口导入', () => {
    expect(HISTORY_LIMIT).toBe(20)
    expect(typeof appendExecutionRecord).toBe('function')
    expect(typeof formatSchedule).toBe('function')
    expect(typeof formatRelativeTime).toBe('function')
    expect(SCHEDULER_MODAL_VIEW_ID).toBe('modal-scheduler-manager-scheduler-manager.panel')
  })

  it('appendExecutionRecord 追加并按 HISTORY_LIMIT 裁剪', () => {
    const task: ScheduledTask = {
      id: 'a1b2c3d4',
      name: 'check-build',
      prompt: 'check build',
      kind: 'recurring',
      schedule: { mode: 'interval', intervalMs: 1_800_000 },
      enabled: true,
      createdAt: 0,
      nextRunAt: 1_800_000,
      runCount: 0,
      history: [],
    }
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      appendExecutionRecord(task, i, 'success')
    }
    expect(task.history).toHaveLength(HISTORY_LIMIT)
    expect(task.history[0]).toEqual({ at: 5, status: 'success' })
  })

  it('formatSchedule / formatRelativeTime 输出形状（interval every / once in / 相对时间）', () => {
    expect(formatSchedule({ mode: 'interval', intervalMs: 1_800_000 }, 'recurring')).toBe('every 30m')
    expect(formatSchedule({ mode: 'interval', intervalMs: 300_000 }, 'once')).toBe('once in 5m')
    expect(formatSchedule({ mode: 'cron', cronExpression: '*/10 * * * *' })).toBe('*/10 * * * *')
    expect(formatRelativeTime(60_000, 0)).toBe('in 1m')
    expect(formatRelativeTime(-3_600_000, 0)).toBe('1h ago')
    expect(formatRelativeTime(1_000, 0)).toBe('now')
  })
})
