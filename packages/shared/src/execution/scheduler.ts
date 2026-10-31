/**
 * scheduler 小域任务契约（M0 契约层，G10——设计 §6.9.4 D12 范围扩展并入域）。
 *
 * 权威依据：
 * - 设计 G10 差距行消除步「M0（小域契约）」：任务清单权威 = runtime execution store 的
 *   scheduler 小域，任务事实写链从 v2 JSON 快照分片（plan B 现状，SC9）迁至小域执行日志。
 * - 设计 §5.1 U1 拆分内容第 5 项「scheduler 小域类型与 session 列表快照契约（G10/G11）」：
 *   所有层共用的唯一契约，先立可防双实现漂移——u-m1 小域数据结构随权威落地（不接生产
 *   写链）与 u-m5 存量导入共用本契约，schema 不在实现期现定。
 * - 设计信号-蕴涵表 SI8：任务到期触发语义（恰一次注入、`task.fired` 事实幂等防重、
 *   停机跨到期恢复扫描补触发一次）。
 * - 设计 §5.1 U6 拆分理由 + §3.4 M0 波次行「与 U6 存量导入源的字段映射在 M0 契约期
 *   定」：存量导入双源 = v2 快照分片（「schemaVersion=2 判形、tasks 字段即
 *   ScheduledTask[]」；plan B 后现役唯一活跃载体）+ plan B 前会话 JSONL `pi-scheduler:`
 *   历史条目（plan B 前历史存量，仅覆盖旧用户）——本文件即该定（两源 schema 与字段映射
 *   都在此，S13「存量定时任务导入后仍按期生效」双源验收的对账依据）。
 *
 * 域边界（防越权）：小域执行日志的事件词表、创建/启停命令词表与折叠机制 = u-m1 随权威
 * 落地（设计 §5.1 U2「scheduler 小域数据源」），本契约只立任务 schema、字段映射裁决、
 * v2 快照判形、JSONL 历史条目源 schema 与 task.fired 到期事实语义；session 列表快照
 * 契约（G11，U1 第 5 项另一半）定义权威在启动就绪设计文档（设计「范围对账锚点」D15
 * 协同条），不在本文件。
 *
 * 单源纪律：任务类型（ScheduledTask 族）与 v2 快照判形契约（schema 版本常量 / 文件形状
 * 类型 / 形状校验函数）直引 @zhushanwen/extension-protocol 主出口——现役唯一写者同源
 * （2026-10-30 plan B 裁决「任务库与会话事实分离」已收敛；判形三符号在零 node 依赖的
 * types.js，经主出口进入浏览器安全路径）。本文件不复制第二份字段定义，只立小域视图
 * 类型、映射裁决与到期事实语义——唯一例外：JSONL 历史条目源写链已随 plan B 提交
 * （73073b169）整体退役，现行仓内无单源可引（仅 session-records.ts 注释提及词形），
 * schema 按 git 历史原文在本文复立（历史冻结形态、独立声明，与小域视图的映射对等由
 * 契约测试双向键集锁定）。
 */

import type {
  ExecutionRecord,
  ScheduleSpec,
  ScheduledTask,
  TaskKind,
  TaskStatus,
} from '@zhushanwen/extension-protocol'
import {
  isSchedulerStoreFile,
  SCHEDULER_STORE_SCHEMA_VERSION,
} from '@zhushanwen/extension-protocol'

export { isSchedulerStoreFile, SCHEDULER_STORE_SCHEMA_VERSION } // oe-exempt:20261031:framework:U6 存量导入判形契约（u-m5 消费），单源 re-export 防双实现漂移

/**
 * 小域权威任务视图（scheduler 小域折叠态的对外只读形态；u-m1 数据结构随权威落地时的
 * schema 依据）。
 *
 * 字段映射裁决（设计 U6「与执行域小域 schema 的字段映射在 M0 契约期定」）：**与 v2 快照
 * 持久化形态逐字段同名直迁，唯一差异 = 剥离 pending**——
 * - `pending` 是运行时标记（到期待 dispatch），v2 写入口已统一剥离不持久化
 *   （extension-protocol store.ts toStoreTask）；小域侧同一事实由执行日志的 task.fired
 *   事实承载（重放重建），不入持久化 schema。
 * - 记账字段（nextRunAt / runCount / lastRunAt / lastStatus / lastError / history）在
 *   小域侧是**折叠派生的只读视图**：事实源 = 小域执行日志（创建/启停/fired 等事实），
 *   折叠重算；u-m5 导入时从 v2 分片直迁作折叠初值（S13「存量定时任务导入后仍按期生效」）。
 * - 设计 SI8 词形 `dueAt` 对应本 schema 的 `nextRunAt` 字段（同一时点，见
 *   isSchedulerTaskDueForCatchUp）。
 */
export type SchedulerDomainTask = Omit<ScheduledTask, 'pending'> // oe-exempt:20261031:framework:U1 scheduler 小域类型契约（u-m1 schema 依据 / u-m5 导入映射），实现随权威波次落地

/**
 * v2 快照持久化字段 → 小域字段的映射清单（与 SchedulerDomainTask 键集逐字段对等，
 * 契约测试锁定）。
 *
 * 顺序 = ScheduledTask 原始声明顺序（extension-protocol types.ts），仅作稳定遍历；
 * 映射语义 = 同名直迁（见 SchedulerDomainTask 注释，pending 剥离不在清单内）。
 */
export const SCHEDULER_DOMAIN_TASK_FIELDS = [
  'id', // 8 位 hex，自动生成
  'name', // 可读名称
  'prompt', // 到期时注入的 message
  'kind', // once | recurring
  'schedule', // cron | interval 调度规格
  'model', // 任务执行模型；undefined = 跟随会话当前模型
  'enabled', // 启用开关
  'createdAt', // 创建时点（epoch ms）
  'nextRunAt', // 下一次到期时点（epoch ms；SI8 词形 dueAt）
  'expiresAt', // 过期时点；undefined = 永不过期
  'runCount', // 已触发次数（折叠派生记账）
  'lastRunAt', // 最近触发时点（折叠派生记账）
  'lastStatus', // 最近触发结果 success | failed（折叠派生记账）
  'lastError', // 最近一次失败原因（折叠派生记账）
  'history', // 最近 HISTORY_LIMIT 条执行记录（折叠派生视图；事实源 = 小域执行日志）
] as const // oe-exempt:20261031:framework:U6 字段映射契约（设计「M0 契约期定」载体），u-m1/u-m5 消费

export type SchedulerDomainTaskField = (typeof SCHEDULER_DOMAIN_TASK_FIELDS)[number]

// ── JSONL 历史条目源（U6 存量导入双源的另一源：plan B 前会话 JSONL `pi-scheduler:`
// ── 历史条目；条目外层 = pi custom entry 信封 { type:'custom', customType: 下常量,
// ── data: SchedulerJsonlEntryOp }，信封属 pi 条目形态不在此声明）——

/**
 * plan B 前 owner session JSONL 内 scheduler 条目的 customType（设计 §5.1 U6「owner
 * session JSONL 内 `pi-scheduler:` custom entry 族——plan B 前历史存量，仅覆盖旧用户」）。
 *
 * 值的权威源 = plan B 提交（73073b169）删除的写链单源常量（extension-protocol
 * TASK_ENTRY_TYPE，写侧 appendEntry / replay 折叠过滤 / importer 三处共用）：现行仓内
 * 已无定义，本契约按 git 历史原文复立——schema 历史冻结，不随小域演进。
 */
export const SCHEDULER_JSONL_ENTRY_TYPE = 'pi-scheduler:task' as const // oe-exempt:20261031:framework:U6 双源导入 JSONL 源识别契约（u-m5 消费），词形按 git 历史复立

/**
 * JSONL 条目 op 词表（entry data 的 op 判别值；4 op 折叠语义 = 写链原文，u-m5 导入器
 * 折叠重放的实施依据）：
 * - `upsert`：全量任务快照落地（创建或覆盖，task = SchedulerJsonlTaskSnapshot）；
 * - `advance`：到期触发记账——nextRunAt 推进 + lastRunAt=at / runCount+1 /
 *   history 追加 {at,status} / lastStatus=status（status 唯一词形 'success'：失败
 *   dispatch 不落条目，transient 失败走重试语义）；
 * - `toggle`：启停（enabled 置位，可携 nextRunAt 同步调整）；
 * - `delete`：删除（折叠终态移除，不复活）。
 */
export const SCHEDULER_JSONL_OPS = ['upsert', 'advance', 'toggle', 'delete'] as const // oe-exempt:20261031:framework:U6 JSONL 源 op 词表契约（u-m5 折叠重放依据），历史冻结

export type SchedulerJsonlOp = (typeof SCHEDULER_JSONL_OPS)[number] // oe-exempt:20261031:framework:U6 JSONL 源 op 词表类型（SCHEDULER_JSONL_OPS 同源派生）

/**
 * upsert op 携带的全量任务快照（plan B 前 TaskSnapshot 词形，git 历史冻结）。
 *
 * 字段映射裁决（设计「与 U6 存量导入源的字段映射在 M0 契约期定」，与 v2 源共用同一份
 * 映射清单 SCHEDULER_DOMAIN_TASK_FIELDS）：历史快照 15 字段与小域视图**逐字段同名、
 * 全集直迁、零改写**——plan B 前 TaskSnapshot 与现行 ScheduledTask 的持久化字段集完全
 * 一致（plan B 同步删除的 ownerSessionFile 在 op 顶层不入快照，见 SchedulerJsonlEntryOp）。
 * 独立声明而非 alias SchedulerDomainTask：两者变化原因不同（小域 schema 随 u-m1+ 演进，
 * 本形态永不再变），双向键集对等由契约测试锁定，任一侧漂移即红。
 */
export interface SchedulerJsonlTaskSnapshot { // oe-exempt:20261031:framework:U6 JSONL 源快照 schema 契约（历史冻结形态，u-m5 导入映射依据）
  id: string
  name: string
  prompt: string
  kind: TaskKind
  schedule: ScheduleSpec
  model?: string
  enabled: boolean
  createdAt: number
  nextRunAt: number
  expiresAt?: number
  runCount: number
  lastRunAt?: number
  lastStatus?: TaskStatus
  lastError?: string
  history: ExecutionRecord[]
}

/**
 * JSONL 条目 op 联合形态（写链原文词形；判形与折叠实装归 u-m5 导入器，本契约只立
 * schema 与映射——与 v2 源判形经单源 re-export 的分工一致）。
 *
 * `ownerSessionFile` 在 op 顶层（不在 task 内）：记录任务创建所属 session，是 plan B
 * 已删除的字段、无小域对应物——导入时丢弃，任务归属由导入目标（小域任务清单）承载。
 */
export type SchedulerJsonlEntryOp = // oe-exempt:20261031:framework:U6 JSONL 源 op 联合契约（u-m5 判形/折叠 schema 依据），历史冻结
  | { op: 'upsert'; taskId: string; ownerSessionFile: string; task: SchedulerJsonlTaskSnapshot }
  | { op: 'advance'; taskId: string; nextRunAt: number; at: number; status: 'success' }
  | { op: 'toggle'; taskId: string; enabled: boolean; nextRunAt?: number }
  | { op: 'delete'; taskId: string }

/**
 * task.fired 到期事实名（设计 SI8 原文词形；小域执行日志中「该任务因 dueAt 到达而恰
 * 触发一次投递端口注入」这一事实的标识）。
 *
 * SI8 到期语义全貌（u-m1 折叠与到期执行的语义依据）：
 * - **恰一次**：dueAt 到达 ⇒ 恰触发一次投递端口注入，task.fired 事实落执行日志；
 * - **清单状态先行过滤**：到期判定读小域任务清单状态，取消/完成的任务不产生到期事件；
 * - **假阳性（重放判重）**：重放/恢复期间到期事件被再次消费——task.fired 事实已落日志，
 *   重放只重建状态不重新注入（与投递端口既有差集重放 `outbox − (ack ∪ delivered)`
 *   同构判重）；
 * - **假阴性（停机跨到期）**：runtime 不在线期间 dueAt 已过——恢复/startup-sweep 扫描
 *   发现「dueAt < now 且无 fired 事实」的任务补触发一次（isSchedulerTaskDueForCatchUp），
 *   补触发的 fired 事实落日志幂等防重，语义 = 「晚到但必达」，不静默跳过。
 */
export const SCHEDULER_FIRED_FACT = 'task.fired' as const // oe-exempt:20261031:framework:SI8 到期事实名契约（u-m1 小域执行日志词表依据），实现随权威波次落地

/** 停机跨到期补触发扫描的输入（SI8 假阴性判据的最小契约形态）。 */
export interface SchedulerCatchUpScanInput { // oe-exempt:20261031:framework:SI8 补触发判据契约（u-m1 恢复扫描实施依据），实现随权威波次落地
  /** 任务到期时点（epoch ms；schema 字段 = nextRunAt，SI8 原文词形 dueAt）。 */
  dueAt: number
  /** 执行日志中该任务在 dueAt 时点是否存在 task.fired 事实（小域折叠态供给）。 */
  hasFiredFact: boolean
  /** 扫描时点（epoch ms）。 */
  now: number
}

/**
 * 停机跨到期补触发判据（SI8 假阴性：恢复/startup-sweep 扫描谓词）。
 *
 * 返回 true = 该任务补触发一次（补触发的 fired 事实落日志幂等防重）；false = 不触发。
 * `dueAt < now` 为严格小于（SI8 原文判据形态）：dueAt === now 交由正常到期路径处理，
 * 不在补触发扫描重复触发。
 */
export function isSchedulerTaskDueForCatchUp(input: SchedulerCatchUpScanInput): boolean { // oe-exempt:20261031:framework:SI8 补触发谓词契约（u-m1 恢复扫描实施依据），实现随权威波次落地
  return input.dueAt < input.now && !input.hasFiredFact
}

// ── 仅类型 re-export：契约消费方（u-m1 折叠态 / u-m5 导入器）引用任务族类型的统一入口
// ── （类型编译期解析，运行时零残留；权威定义在 extension-protocol types.ts 单源）
export type {
  ExecutionRecord,
  ScheduleSpec,
  ScheduledTask,
  TaskKind,
  TaskStatus,
} from '@zhushanwen/extension-protocol' // oe-exempt:20261031:framework:任务族类型契约统一入口（u-m1/u-m5 消费），单源 re-export
