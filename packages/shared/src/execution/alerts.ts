/**
 * 执行域结构化告警契约（M0 契约层）。
 *
 * 权威依据：设计「恢复与中断」——失联宽限超时 = **观测告警，不是判死源**。
 *
 * 三档裁决（设计原文）：不做（失联标记滞留无人发现，违反触发可观测）→ 简单档 =
 * 观测告警不判死（采用）→ 复杂档 = 时间推测判死（违反 ADR-0122 分则 ⑤，不采用）。
 * 触发可观测的载体 = 本文件的结构化告警事件（日志 + 遥测）；它与误暂停可区分：
 * **告警不改变 run 终态**（不写执行日志事件、不产生状态转移）。
 *
 * 超时值单源 = budgets.ts 的 contactLostGraceMs（可被环境变量覆盖）。
 */

import type { ExecutionRevision } from './ids'

/** 告警事件名（日志 + 遥测的结构化信号名；不是执行域领域事件）。 */
export const EXECUTION_ALERT_EVENT = 'execution.alert' as const

/** 告警码封闭词表（当前唯一成员 = 失联宽限超时；扩位须同批登记判据）。 */
export const EXECUTION_ALERT_CODES = ['contact_lost_grace_exceeded'] as const

export type ExecutionAlertCode = (typeof EXECUTION_ALERT_CODES)[number]

/**
 * 失联宽限告警明细。
 *
 * 事实来源：run 快照的 contactLostAt（状态命令域断连标记）+ 观察时刻 + 宽限阈值。
 * 明细只读呈现，不参与状态判定。
 */
export interface ExecutionContactLostAlertDetail { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 失联标记起点（epoch ms，= run 快照 contactLostAt）。 */
  contactLostAt: number
  /** 触发告警时使用的宽限阈值（= 预算单源当前生效值）。 */
  graceMs: number
  /** 触发时刻快照的会话修订号（只读定位，不改变状态）。 */
  latestRevision: ExecutionRevision
}

/** 结构化告警载荷（日志/遥测共用同一形状）。 */
export interface ExecutionAlert { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  event: typeof EXECUTION_ALERT_EVENT
  code: ExecutionAlertCode
  sessionId: string
  /** 观察时刻（epoch ms）。 */
  observedAt: number
  detail: ExecutionContactLostAlertDetail
  message: string
  /** 恢复动作（错误/告警 → 权威源 → 重试闭环）。 */
  recovery: string
}

/**
 * 失联宽限告警构造（纯函数；只产载荷，不做 IO、不写事件日志、不改 run 状态）。
 *
 * 调用方（M1 state 提交单元）负责：到达宽限阈值时调用本函数 → 落结构化日志/遥测。
 * 重复触发由调用方按 run 去重（同一 contactLostAt 只告警一次）——本函数不持有状态。
 */
export function buildContactLostAlert(input: {
  sessionId: string
  contactLostAt: number
  graceMs: number
  latestRevision: ExecutionRevision
  observedAt: number
}): ExecutionAlert {
  return {
    event: EXECUTION_ALERT_EVENT,
    code: 'contact_lost_grace_exceeded',
    sessionId: input.sessionId,
    observedAt: input.observedAt,
    detail: {
      contactLostAt: input.contactLostAt,
      graceMs: input.graceMs,
      latestRevision: input.latestRevision,
    },
    message: `状态命令域失联超过宽限 ${input.graceMs}ms（起点 ${input.contactLostAt}）；告警不改变 run 终态`,
    recovery:
      '检查 runtime 与扩展进程的状态命令域连接并等待重连；失联标记随更高 revision 的续传自动清除，需判死时走事实信号（引擎域断连 / 进程探活 / startup-sweep）',
  }
}
