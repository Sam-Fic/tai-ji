/**
 * 执行事件契约（M0 契约层：事件外层字段 + 事件类型 + 每类事件 payload）。
 *
 * 权威依据：
 * - 设计 §3.1 领域事件（21 个过去式事件名与语义）。
 * - 设计 §5.2 双形态契约字段单一权威：事件外层十个字段 =
 *   `v/sessionId/seq/eventId/aggregateType/aggregateId/type/commandId/timestamp/payload`。
 * - 设计 D19（WAL 顺序）：先追加执行日志并持久成功 → 更新内存快照 → 回 accepted；
 *   事件是恢复的唯一事实源，命令意图不写进日志（命令结果以事件或幂等回执表达）。
 *
 * 聚合归属：`aggregateType` 只有 run / member 两类聚合根；Step/Attempt/Result 事件
 * 挂在所属 run 或 member 聚合上；Notice 事件挂在其 refId 指向的 run/member 聚合上
 * （通知不是独立聚合根，避免出现第三类聚合）。
 */

import type { FailureCause, EngineStopReason } from '@zhushanwen/subagent-engine-sdk'

import type {
  AttemptId,
  CommandId,
  ExecutionSessionId,
  MemberId,
  NoticeId,
  ResultId,
  RunId,
  StepKey,
} from './ids'
import type { NoticeConsumer, NoticeContent, NoticeType } from './notice'
import type { ResultStatus, ResultTarget } from './result'
import type {
  AttemptOutcome,
  DispatchOrigin,
  MemberMode,
  RunOutcome,
  RunPauseCause,
  StepOutcome,
} from './status'

/** 事件契约版本（事件外层 `v` 的当前值；不兼容变更才升版）。 */
export const EXECUTION_EVENT_CONTRACT_VERSION = 1 as const

/** 聚合类型（只有两类聚合根，禁止第三类）。 */
export const EXECUTION_AGGREGATE_TYPES = ['run', 'member'] as const

export type ExecutionAggregateType = (typeof EXECUTION_AGGREGATE_TYPES)[number]

/**
 * 领域事件名（过去式；顺序仅作稳定遍历）。
 *
 * 事件只记录已发生事实；命令意图不写进日志。
 */
export const EXECUTION_EVENT_TYPES = [
  'RunCreated',
  'RunStarted',
  'RunPaused',
  'RunResumed',
  'RunSettled',
  'StepScheduled',
  'StepStarted',
  'StepSettled',
  'StepCancelled',
  'MemberCreated',
  'MemberTurnStarted',
  'MemberIdle',
  'MemberClosed',
  'AttemptStarted',
  'AttemptSettled',
  'AttemptInterrupted',
  'ResultRecorded',
  'NoticeQueued',
  'NoticeDelivered',
  'NoticeCollected',
  'NoticeAbandoned',
] as const

export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number]

/** Attempt 的父实体（Step 尝试归 run 聚合，成员轮次尝试归 member 聚合）。 */
export type AttemptParent =
  | { kind: 'step'; runId: RunId; stepKey: StepKey }
  | { kind: 'member'; memberId: MemberId }

/** 成员关闭原因（关闭只中断当前轮次，不删除历史结果）。 */
export const MEMBER_CLOSED_REASONS = ['user', 'parent'] as const

export type MemberClosedReason = (typeof MEMBER_CLOSED_REASONS)[number]

/**
 * 通知放弃原因（当前唯一来路 = 投递重试耗尽；设计 D6：投递失败保留重试，
 * 放弃是重试耗尽后的显式终态，不是投递首次失败的处置）。
 */
export const NOTICE_ABANDONED_REASONS = ['delivery_retries_exhausted'] as const

export type NoticeAbandonedReason = (typeof NOTICE_ABANDONED_REASONS)[number]

/**
 * 事件 payload 映射（type → payload 形状）。
 *
 * 字段选择原则：只承载「事件当下已发生的事实」与恢复所需的最小定位信息；正文/大对象
 * 一律引用 id（resultId / scriptHash / paramsHash），不内嵌全文。
 */
export interface ExecutionEventPayloadMap { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  RunCreated: {
    runId: RunId
    /** 脚本静态路径（归一形态，用于展示与 resume 定位）。 */
    scriptPath: string
    /** 脚本内容哈希（resume 一致性校验的第一道；变化即拒绝恢复）。 */
    scriptHash: string
    /** 参数哈希（resume 一致性校验的第二道）。 */
    paramsHash: string
  }
  RunStarted: { runId: RunId }
  RunPaused: { runId: RunId; cause: RunPauseCause }
  RunResumed: { runId: RunId }
  RunSettled: {
    runId: RunId
    outcome: RunOutcome
    /** 结果工件引用（RunSettled 前必须先提交工件，D6）。 */
    resultId: ResultId
  }
  StepScheduled: {
    runId: RunId
    stepKey: StepKey
    /** 调用点静态路径归一 + 行/列（stepKey 的输入之一，见 identity.ts）。 */
    callSite: string
    /** 同点序号（0 起；stepKey 的输入之一）。 */
    occurrence: number
    /** 该步骤调用的 agent 名（存在时；仅展示，不参与身份）。 */
    agent?: string
  }
  StepStarted: { runId: RunId; stepKey: StepKey; attemptId: AttemptId }
  StepSettled: {
    runId: RunId
    stepKey: StepKey
    attemptId: AttemptId
    outcome: StepOutcome
    resultId?: ResultId
  }
  StepCancelled: { runId: RunId; stepKey: StepKey; reason: string }
  MemberCreated: {
    memberId: MemberId
    /** interactive / one-shot 共用同一生命周期（设计 §3.1）。 */
    mode: MemberMode
    /** 派发方式（manual / script，契约级终态裁决第 11 项正名词表）。 */
    origin: DispatchOrigin
    agent?: string
    model?: string
    /** workflow 内成员归属的 run（独立 subagent 成员缺省）。 */
    parentRunId?: RunId
  }
  MemberTurnStarted: { memberId: MemberId; attemptId: AttemptId; turn: number }
  MemberIdle: {
    memberId: MemberId
    turn: number
    /** 引擎收尾事实词（stop / error / aborted，SDK EngineStopReason）。 */
    stopReason: EngineStopReason
  }
  MemberClosed: { memberId: MemberId; closedReason: MemberClosedReason }
  AttemptStarted: {
    attemptId: AttemptId
    /** 引擎标识（pi / zcode / ...，开放集合）。 */
    engineType: string
    /** 父实体（Step 尝试 / 成员轮次尝试）。 */
    parent: AttemptParent
  }
  AttemptSettled: {
    attemptId: AttemptId
    outcome: AttemptOutcome
    /** 失败分类（成功/取消时缺省；词表权威 = 引擎协议 SDK）。 */
    failure?: FailureCause
  }
  AttemptInterrupted: { attemptId: AttemptId; cause: RunPauseCause }
  ResultRecorded: {
    resultId: ResultId
    target: ResultTarget
    status: ResultStatus
  }
  NoticeQueued: {
    noticeId: NoticeId
    noticeType: NoticeType
    /** 通知对象 id（runId 或 memberId，与 aggregateId 一致）。 */
    refId: RunId | MemberId
    consumer: NoticeConsumer
    /** 通知内容必须随事件落盘，否则事件重放无法重建通知缓存。 */
    content: NoticeContent
  }
  NoticeDelivered: {
    noticeId: NoticeId
    /** 投递后累计尝试次数（1 起）。 */
    attempt: number
  }
  NoticeCollected: { noticeId: NoticeId }
  NoticeAbandoned: { noticeId: NoticeId; reason: NoticeAbandonedReason }
}

/**
 * 事件外层信封（十个字段的单一权威形状）。
 *
 * `seq` 的口径（与契约级终态裁决第 4 项合读）：
 * - seq = 会话内单调递增的事件序号（批次内逐事件分配，永不回退）；
 * - 对外 `revision` = 该原子批次最后一条事件的 seq——一个批次只推进一次对外修订号
 *   （修订号的消费语义是快照可比性，不需要事件级粒度）；
 * - 因此「单条事件应用后的内部 revision 等于其 seq」与「一个批次一个对外 revision」
 *   同时成立：批次中间态不对外发布，快照/推送只在批次边界携带 revision。
 *
 * `commandId` 只在命令产生的批次事件上出现；故障路径（RunPaused 等）缺省。
 */
export interface ExecutionEventEnvelope { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 事件契约版本（当前恒 1；不兼容变更才升版）。 */
  v: typeof EXECUTION_EVENT_CONTRACT_VERSION
  /** 会话 id（事件流按会话分片）。 */
  sessionId: ExecutionSessionId
  /** 会话内单调递增事件序号（批次内逐事件分配，永不回退）。 */
  seq: number
  /** 事件唯一 id。 */
  eventId: string
  /** 聚合类型（只有 run / member 两类聚合根）。 */
  aggregateType: ExecutionAggregateType
  /** 聚合根 id（runId 或 memberId）。 */
  aggregateId: RunId | MemberId
  /** 事件类型（21 个过去式事件之一）。 */
  type: ExecutionEventType
  /** 产生该事件的命令 id（命令批次事件才带；故障路径缺省）。 */
  commandId?: CommandId
  /** 墙钟时间戳（epoch ms；与仓库既有事件流口径一致）。 */
  timestamp: number
  /** 类型相关的负载（下方 ExecutionEvent 判别联合细化其形状）。 */
  payload: unknown
}

/**
 * 判别联合事件（外层字段 + 每 type 的 payload 形状）。
 *
 * 字段级对账锚点 = 设计 §5.2 事件外层十字段；契约测试同时做类型级与运行级锁定。
 */
export type ExecutionEvent = {
  [K in ExecutionEventType]: Omit<ExecutionEventEnvelope, 'type' | 'payload'> & {
    type: K
    payload: ExecutionEventPayloadMap[K]
  }
}[ExecutionEventType]

/** 事件类型守卫（恢复/解析边界的收窄入口；不解释 payload 合法性）。 */
export function isExecutionEventType(value: string): value is ExecutionEventType {
  return (EXECUTION_EVENT_TYPES as readonly string[]).includes(value)
}
