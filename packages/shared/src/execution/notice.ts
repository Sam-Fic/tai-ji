/**
 * 通知契约（NoticeIntent 单状态机 + 派生通知缓存，M0 契约层）。
 *
 * 权威依据：
 * - 设计 §3.1 领域模型：NoticeIntent = 一条待投递通知，只记录提醒意图，不决定执行状态。
 * - 契约级终态裁决第 1 项（D16）：只保留一个状态机——`pending → delivered → collected`
 *   链式 + `pending → abandoned`；abandoned 合法起点仅为 pending（投递重试耗尽后放弃）；
 *   collected 是 delivered 的后继而非并列终态（通知必须先投递送达才可能被 agent 收集）；
 *   本域判重一律靠通知 id 幂等。
 * - 执行 API `notice.collect` 行：通知内容快照读取通道 = 经执行事件流订阅派生通知缓存
 *   （按 NoticeQueued / NoticeDelivered / NoticeCollected / NoticeAbandoned 折叠），
 *   派生态非事实源，不新增通知查询命令、ExecutionSnapshot 外层不设 notices 字段。
 *
 * 字段级单一权威（设计 §5.2）：通知六个字段 = `noticeId/type/refId/consumer/status/attempt`。
 */

import type { NoticeId, RunId, MemberId } from './ids'

/**
 * 通知状态（四值封闭词表）。状态机链式，见 NOTICE_STATUS_TRANSITIONS。
 *
 * abandoned 的合法起点只有 pending：投递失败保留重试，重试耗尽才放弃；delivered 之后
 * 的通知不因收集失败而 abandoned（结果工件始终可查，收集确认可重试）。
 */
export const NOTICE_STATUSES = ['pending', 'delivered', 'collected', 'abandoned'] as const

export type NoticeStatus = (typeof NOTICE_STATUSES)[number]

/**
 * 通知状态机合法转移表。
 *
 * 关键约束：collected 只能由 delivered 进入（不存在 pending → collected 的跳跃）；
 * collected / abandoned 无自环、无后继——已收集通知再 collect 命中领域层幂等，
 * **不落事件**（见 collect-results.ts 的两层幂等拍板）。
 */
export const NOTICE_STATUS_TRANSITIONS: Readonly<Record<NoticeStatus, readonly NoticeStatus[]>> = {
  pending: ['delivered', 'abandoned'],
  delivered: ['collected'],
  collected: [],
  abandoned: [],
}

/** 通知类型（执行域当前只产生两类结果通知；扩位须同批更新契约与折叠逻辑）。 */
export const NOTICE_TYPES = ['run_settled', 'member_result'] as const

export type NoticeType = (typeof NOTICE_TYPES)[number]

/**
 * 通知消费方（当前唯一消费方 = 父 agent：结果到达后经 delivery port 注入主 agent）。
 * 扩位前必须补消费方与投递通道契约，禁止同名复用。
 */
export const NOTICE_CONSUMERS = ['agent'] as const

export type NoticeConsumer = (typeof NOTICE_CONSUMERS)[number]

/**
 * 通知内容（快照读取通道的载荷）。
 *
 * 内容决定权在执行域：NoticeQueued 事件必须自带 content，否则事件重放无法重建通知
 * 缓存（派生态可重建是「缓存非事实源」的前提）。`text` 是投递给 agent 的正文；
 * `resultId` 指向结果工件（正文不重复塞进通知）。
 */
export interface NoticeContent { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 投递给 agent 的通知正文（摘要级，不承载完整结果）。 */
  text: string
  /** 结果工件引用（存在时 collect_results 据此返回完整结果）。 */
  resultId?: string
  /** 域内补充信息（只读展示，不参与任何状态判定）。 */
  details?: unknown
}

/**
 * NoticeIntent 实体（发件箱行）。
 *
 * 外键约束：type = run_settled 时 refId 必须是 RunId；type = member_result 时 refId
 * 必须是 MemberId。实体只记录提醒意图与投递进度，不承载执行状态。
 */
export interface NoticeIntent { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 通知唯一 id（领域层幂等键：同一 noticeId 再 collect 不重复注入）。 */
  noticeId: NoticeId
  /** 通知类型（run_settled / member_result）。 */
  type: NoticeType
  /** 通知对象 id（runId 或 memberId，与事件 aggregateId 一致）。 */
  refId: RunId | MemberId
  /** 消费方（当前仅 agent）。 */
  consumer: NoticeConsumer
  /** 通知状态（四值封闭词表，见 NOTICE_STATUS_TRANSITIONS）。 */
  status: NoticeStatus
  /**
   * 已尝试投递次数（0 = 尚未投递；每次 NoticeDelivered 转移 +1）。
   * 语义 = 投递进度计数，不是重试上限；上限策略属 M3 投递适配实现。
   */
  attempt: number
}

/**
 * 派生通知缓存条目（执行事件流折叠结果，**非事实源**）。
 *
 * 崩溃后从事件重放即可重建；缓存承载两件事：
 * ① collect_results 的 already-collected 幂等快照返回（S15 ③）；
 * ② delivered 未 collected 集合判定（等待集读取）。
 */
export interface NoticeCacheEntry extends NoticeIntent { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  content: NoticeContent
}

/**
 * 通知缓存折叠的输入事件类型（封闭四值，顺序无关）。
 *
 * 消费方不得用其他事件推断通知状态——事件流是唯一事实源，折叠规则 = 本状态机的转移表。
 */
export const NOTICE_CACHE_FOLD_EVENT_TYPES = [
  'NoticeQueued',
  'NoticeDelivered',
  'NoticeCollected',
  'NoticeAbandoned',
] as const

export type NoticeCacheFoldEventType = (typeof NOTICE_CACHE_FOLD_EVENT_TYPES)[number]

/** 转移合法性判定（表驱动）。 */
export function canTransitionNotice(from: NoticeStatus, to: NoticeStatus): boolean {
  return NOTICE_STATUS_TRANSITIONS[from].includes(to)
}

/** 通知是否终局（collected / abandoned；pending/delivered 仍在处理中）。 */
export function isTerminalNoticeStatus(status: NoticeStatus): boolean {
  return status === 'collected' || status === 'abandoned'
}

/**
 * 通知在等待/收集集中的资格（设计：abandoned 通知在缓存中呈其终态、不进等待与收集集）。
 * 返回 true = 该通知已不该被 collect_results 视为待收集项。
 */
export function isNoticeOutOfCollectSet(status: NoticeStatus): boolean {
  return status === 'abandoned'
}
