import type { SchedulerBackend } from '../backend.js'
import type { ScheduledTask } from '../types.js'

// 测试专用 mock（ext-simplify-08 L9：从 backend.ts 迁出——导出范围即测试范围的收敛，
// 生产模块不再携带测试脚手架；MockSchedulerBackend/SentMessage 零生产引用）。

export interface SentMessage {
  msg: { content: string; customType: string; display: boolean }
  opts?: { deliverAs?: 'steer'; triggerTurn?: boolean }
  /** deliverDispatch 的幂等键（unified-delivery 迁移；sendMessage 直发路径恒缺省）。 */
  idempotencyKey?: string
}

/**
 * Mock 后端：零 FS 副作用，记录 deliverDispatch/persistTasks 调用，支持注入固定时间。
 *
 * 能力：
 * - sentMessages: 每次 deliverDispatch 的 {msg, opts, idempotencyKey} 记录
 * - persistedSnapshots: 每次 persistTasks 收到的任务集快照（测各 mutation 的落盘断言）
 * - nowValue: now() 返回固定值，缺省 Date.now()
 * - persistError: 注入后 persistTasks 抛该错（测落盘失败降级路径）
 */
export class MockSchedulerBackend implements SchedulerBackend {
  sentMessages: SentMessage[] = []
  persistedSnapshots: ScheduledTask[][] = []
  nowValue: number | undefined
  persistError: Error | null = null

  /** 到期 dispatch 投递入口的 mock 记录（unified-delivery 迁移）。 */
  async deliverDispatch(
    msg: { content: string; customType: string; display: boolean },
    opts: { deliverAs?: 'steer'; triggerTurn?: boolean } | undefined,
    idempotencyKey: string,
  ): Promise<void> {
    this.sentMessages.push({ msg, opts, idempotencyKey })
  }

  persistTasks(tasks: ScheduledTask[]): void {
    if (this.persistError) throw this.persistError
    this.persistedSnapshots.push(tasks)
  }

  /** 最近一次落盘快照（未落盘时 undefined）。 */
  get persistedTasks(): ScheduledTask[] | undefined {
    return this.persistedSnapshots.at(-1)
  }

  now(): number {
    return this.nowValue ?? Date.now()
  }
}
