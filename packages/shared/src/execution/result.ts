/**
 * 结果工件契约（M0 契约层）。
 *
 * 权威依据：
 * - 设计 D2：结果正文写独立工件，事件只引用工件、不内嵌全文；快照与派生视图可删可重建。
 * - 设计 §5.2 双形态契约字段单一权威：结果字段 = `resultId/runId|memberId/stepKey/
 *   attemptId/status/content/error/usage/engine`。
 * - 设计 D6：RunSettled 前先提交结果工件；`result.get` 始终可查。
 *
 * 身份约束：runId / memberId 至少一个存在（Run 级结果只有 runId；run 内成员结果
 * 两者都有；独立 subagent 结果只有 memberId）。stepKey/attemptId 在结果粒度可确定时携带。
 */

import type { AgentUsageTotal, FailureCause } from '@zhushanwen/subagent-engine-sdk'

import type { AttemptId, MemberId, ResultId, RunId, StepKey } from './ids'

/** 结果工件终局状态（partially_succeeded 是 Run 级聚合词，结果工件不承载）。 */
export const RESULT_STATUSES = ['done', 'failed', 'cancelled', 'time_limited'] as const

export type ResultStatus = (typeof RESULT_STATUSES)[number]

/** 结果错误载荷（失败原因沿用引擎协议五维词表，禁止在重写中另立词表）。 */
export interface ResultError { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 可读错误信息（面向用户/agent 的恢复指向文案）。 */
  message: string
  /** 五维失败分类（词表权威 = @zhushanwen/subagent-engine-sdk）；未分类形态不产假 cause。 */
  cause?: FailureCause
}

/** 结果引擎引用（一次结果的执行载体；开放集合，取值跟随引擎注册表）。 */
export interface ResultEngine { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 引擎标识（pi / zcode / ...）。 */
  type: string
  /** 引擎侧会话定位（存在时）。 */
  sessionId?: string
}

/** 结果工件公共面（runId/memberId 的「至少一个」由下方联合表达）。 */
export interface ResultArtifactFields { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 结果工件唯一 id（ResultRecorded 引用它）。 */
  resultId: ResultId
  /** Step 身份键（结果粒度可确定时携带）。 */
  stepKey?: StepKey
  /** 产生该结果的 Attempt id（存在时）。 */
  attemptId?: AttemptId
  /** 结果终局状态（done/failed/cancelled/time_limited）。 */
  status: ResultStatus
  /**
   * 结果正文。正文独立落盘、可反复查询；形状由执行域结果生产者决定（文本 / 结构化
   * / 多段内容均可），基座不预设，消费方按 status + error 判定成败。
   */
  content: unknown
  /** 失败详情（status=failed 时一般存在；成功/取消可缺省）。 */
  error?: ResultError
  /** token 用量（引擎累计口径，单源 = AgentUsageTotal）。 */
  usage?: AgentUsageTotal
  /** 结果引擎引用（一次结果的执行载体）。 */
  engine?: ResultEngine
}

/**
 * 结果工件（ResultArtifact）。
 *
 * 存在性约束：`runId` 与 `memberId` 至少一个（两者可同时存在——run 内成员结果）。
 * 字段级对账锚点 = 设计 §5.2 十个字段，契约测试逐字段锁定。
 */
export type ResultArtifact = ResultArtifactFields &
  (
    | { runId: RunId; memberId?: MemberId }
    | { runId?: RunId; memberId: MemberId }
  )

/** 结果目标（事件 ResultRecorded 的引用形态；与 ResultArtifact 的扁平字段一一对应）。 */
export type ResultTarget =
  | { kind: 'run'; runId: RunId }
  | { kind: 'member'; memberId: MemberId; attemptId: AttemptId }
  | { kind: 'step'; runId: RunId; stepKey: StepKey; attemptId: AttemptId }
