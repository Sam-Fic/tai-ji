// scheduler 任务契约（scheduler-redesign 方案 B：任务库与会话事实分离）：
// 任务类型与记账 helper 在此单源，pi 扩展（唯一写者）与 taiji plugin（面板只读者）
// 同源消费。任务定义不再写 pi 会话 JSONL（custom entry event sourcing 已退役），
// 持久化载体 = 独立快照文件（形态与读写见同目录 store.ts）。本分组零 pi 依赖、
// 零 node 依赖——纯类型 + 纯函数（store.ts 含 node:fs，走独立子出口）。

// ── 快照文件判形契约（零 node 依赖，供包外消费方单源复用；读写实装在同目录 store.ts）──

/** 快照 schema 版本（v2 = 任务库分离形态；v1 是 npm 0.1.1 旧 store，文件名不同不互读）。 */
export const SCHEDULER_STORE_SCHEMA_VERSION = 2

/**
 * 快照文件形状（v2 任务库分离 schema；方案 B 设计原文未归档，裁决内容与背景
 * 以 commit 73073b169 message 为溯源锚——同 store.ts 头注口径）。
 * tasks 为内存任务集的全量快照：写入口统一剥离运行时标记（pending）并拷贝 history，
 * 读方拿到的即干净的持久化形态。
 */
export type SchedulerStoreFile = {
  schemaVersion: typeof SCHEDULER_STORE_SCHEMA_VERSION
  /** owner session 的 JSONL 路径（冗余记录，供排障与对账；--no-session 时可缺省） */
  sessionFile?: string
  tasks: ScheduledTask[]
}

/**
 * 快照文件形状校验（M0 契约期由 @taiji/shared/execution 的 scheduler 小域契约单源
 * re-export，U6 存量导入消费）：顶层 schemaVersion=2 + tasks 数组且逐项为对象
 * （字段级信任唯一写者，不逐字段校验）。
 */
export function isSchedulerStoreFile(data: unknown): data is SchedulerStoreFile {
  if (!data || typeof data !== 'object') return false
  const record = data as Record<string, unknown>
  if (record.schemaVersion !== SCHEDULER_STORE_SCHEMA_VERSION) return false
  if (!Array.isArray(record.tasks)) return false
  return record.tasks.every(t => t !== null && typeof t === 'object')
}

// ── 调度规格 ──

export type ScheduleSpec =
  | { mode: 'cron'; cronExpression: string }
  | { mode: 'interval'; intervalMs: number }

// ── 任务 ──

export type TaskKind = 'once' | 'recurring'
export type TaskStatus = 'success' | 'failed'

export type ScheduledTask = {
  id: string                        // 8 位 hex，自动生成
  name: string                      // 可读名称（用户指定或从 prompt 自动截取前 30 字）
  prompt: string                    // 到期时注入的 message
  kind: TaskKind
  schedule: ScheduleSpec            // once 时 intervalMs = delayMs
  model?: string                    // 任务执行模型（scoped model id，provider/model）；undefined = 跟随会话当前模型
  enabled: boolean
  createdAt: number
  nextRunAt: number
  expiresAt?: number                // undefined = 永不过期
  runCount: number
  lastRunAt?: number
  lastStatus?: TaskStatus
  lastError?: string                // 最近一次失败原因（cron 失效 / 投递拒收）
  history: ExecutionRecord[]        // 最近 HISTORY_LIMIT 条
  pending?: boolean                 // 运行时标记：到期待 dispatch（快照写入口统一剥离，不持久化；勿与 TaskStatus 混淆）
}

export type ExecutionRecord = {
  at: number
  status: TaskStatus
}

/**
 * history 裁剪上限（单点）：由 `appendExecutionRecord` 在 runtime 记账侧执行裁剪；
 * 快照写入口不裁剪（只逐项拷贝）——上限字面量只此一处，多处各持会漂移。
 */
export const HISTORY_LIMIT = 20

/**
 * 追加执行记录并按 HISTORY_LIMIT 裁剪（单点）：runtime 侧 dispatch 累积的
 * push+trim——内联时与上限字面量同源存在「漏改一处」漂移风险，随上限一并收敛。
 */
export function appendExecutionRecord(task: ScheduledTask, at: number, status: TaskStatus): void {
  task.history.push({ at, status })
  if (task.history.length > HISTORY_LIMIT) task.history.shift()
}

// ── taiji 宿主面板视图 id ──

/**
 * scheduler-manager 插件推树的 overlay 定时任务 tab ViewHost 分区键（历史命名
 * modal-<pluginId>-<modalId>，modal 链退役后原值保留）：插件 views.update 推树与
 * taiji renderer ViewHost 消费跨包共用本单源——双端各持字面量时任一端漂移即
 * ViewHost per-session 分区静默 miss（tab 空白无报错），收敛到本文件单点导出。
 */
export const SCHEDULER_MODAL_VIEW_ID = 'modal-scheduler-manager-scheduler-manager.panel'
