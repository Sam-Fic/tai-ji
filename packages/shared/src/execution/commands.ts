/**
 * 执行 API 契约（命令 / 回执 / 错误 / 控制通道帧，M0 契约层）。
 *
 * 权威依据：
 * - 设计 §3.1 执行 API 命令表（11 个命令，全部带幂等键 commandId；持久写入成功后
 *   才回 accepted）。
 * - 设计 D10：transport 保留 control socket（Unix socket + 单行 JSON 信封 + hello
 *   握手），语义层升级为 request / response / notification 三类消息；幂等键 = 命令 id，
 *   重复命令返回同一修订号。
 * - 契约级终态裁决第 4 项：重复命令按命令 id 幂等返回同一修订号。
 * - `notice.collect` 的两层幂等（命令层 commandId → 领域层 noticeId）见 collect-results.ts。
 */

import type { CommandId, MemberId, NoticeId, RunId } from './ids'
import type { ExecutionSnapshot } from './snapshot'
import type { ResultArtifact } from './result'

/** 命令名封闭词表（顺序对齐设计 §3.1 执行 API 表；新增命令 = 契约变更）。 */
export const EXECUTION_COMMAND_NAMES = [
  'run.start',
  'member.start',
  'member.send',
  'run.resume',
  'run.cancel',
  'member.cancel',
  'member.close',
  'snapshot.get',
  'result.get',
  'notice.ack',
  'notice.collect',
] as const

export type ExecutionCommandName = (typeof EXECUTION_COMMAND_NAMES)[number]

/** 命令级预算（token / 时间两维；缺省 = 不额外限制，走引擎/会话默认）。 */
export interface ExecutionBudgetRequest { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  timeMs?: number
  tokens?: number
}

/** 隔离选项（worktree = 独立工作树；cwd = 执行工作目录覆盖）。 */
export interface ExecutionIsolation { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  worktree?: boolean
  cwd?: string
}

/**
 * 脚本来源（路径 / 源码二选一）。
 *
 * scriptPath 恒需存在：它既是展示名，也是 stepKey 调用点归一与 resume 诊断的定位信息。
 */
export type ScriptSource =
  | { kind: 'path'; scriptPath: string }
  | { kind: 'inline'; scriptPath: string; scriptSource: string }

/** fork 源（成员续聊 / 会话分叉；两种来源互斥）。 */
export type MemberForkSource =
  | { kind: 'member'; memberId: MemberId }
  | { kind: 'session'; sessionId: string }

export interface RunStartParams { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  sessionId: string
  script: ScriptSource
  /** workflow 调用参数（脚本 ABI 保持；不参与身份，不写入事件正文）。 */
  args?: unknown
  model?: string
  budget?: ExecutionBudgetRequest
  isolation?: ExecutionIsolation
}

export interface MemberStartParams { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  sessionId: string
  /** 派发任务正文（脚本 ABI 保持）。 */
  task: string
  agent?: string
  model?: string
  isolation?: ExecutionIsolation
  forkFrom?: MemberForkSource
}

export interface MemberSendParams { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  memberId: MemberId
  message: string
}

export interface RunResumeParams { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  runId: RunId
  /** 参数哈希（必须与 RunCreated 记录一致；脚本哈希一致性由 runId 定位的 RunCreated 校验）。 */
  paramsHash: string
}

export interface RunCancelParams { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  runId: RunId
}

export interface MemberCancelParams { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  memberId: MemberId
}

export interface MemberCloseParams { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  memberId: MemberId
}

export interface SnapshotGetParams { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  sessionId: string
  /** 可选指定修订号；缺省 = 当前快照。 */
  revision?: number
}

/** 结果查询目标（三种形态互斥：run / member（可带 attempt）/ 单 attempt）。 */
export type ResultGetParams =
  | { runId: RunId }
  | { memberId: MemberId; attemptId?: string }
  | { attemptId: string }

export interface NoticeAckParams { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  noticeId: NoticeId
}

export interface NoticeCollectParams { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  noticeId: NoticeId
}

/** 命令参数映射（method → params）。 */
export interface ExecutionCommandParamsMap { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  'run.start': RunStartParams
  'member.start': MemberStartParams
  'member.send': MemberSendParams
  'run.resume': RunResumeParams
  'run.cancel': RunCancelParams
  'member.cancel': MemberCancelParams
  'member.close': MemberCloseParams
  'snapshot.get': SnapshotGetParams
  'result.get': ResultGetParams
  'notice.ack': NoticeAckParams
  'notice.collect': NoticeCollectParams
}

/** 通用修订号回执（变更命令的 accepted 载荷）。 */
export interface RevisionReceipt { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  revision: number
}

export interface RunStartReceipt { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  runId: RunId
  revision: number
}

export interface MemberStartReceipt { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  memberId: MemberId
  revision: number
}

export interface SnapshotGetReceipt { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  snapshot: ExecutionSnapshot
}

export interface ResultGetReceipt { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  artifact: ResultArtifact
}

/** 回执映射（method → result 载荷）。 */
export interface ExecutionCommandReceiptMap { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  'run.start': RunStartReceipt
  'member.start': MemberStartReceipt
  'member.send': RevisionReceipt
  'run.resume': RevisionReceipt
  'run.cancel': RevisionReceipt
  'member.cancel': RevisionReceipt
  'member.close': RevisionReceipt
  'snapshot.get': SnapshotGetReceipt
  'result.get': ResultGetReceipt
  'notice.ack': RevisionReceipt
  'notice.collect': RevisionReceipt
}

/**
 * 命令信封。
 *
 * 幂等契约：同一 commandId 的重放（无论参数是否相同）由命令通道层判重，返回该命令
 * **首次受理的修订号**；不重复追加事件、不重复产生副作用。执行器重连后重放未确认
 * 命令是正常路径（D10 生死二态 + 有界背压，不设心跳）。
 */
export interface ExecutionCommandEnvelope<M extends ExecutionCommandName = ExecutionCommandName> { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  commandId: CommandId
  method: M
  params: ExecutionCommandParamsMap[M]
}

/** 判别联合命令（commandId + method + params）。 */
export type ExecutionCommand = {
  [M in ExecutionCommandName]: ExecutionCommandEnvelope<M>
}[ExecutionCommandName]

/** 成功回执信封（transport response 的 result 载荷；id 配对由传输层完成）。 */
export interface ExecutionReplyEnvelope<M extends ExecutionCommandName = ExecutionCommandName> { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  commandId: CommandId
  result: ExecutionCommandReceiptMap[M]
}

export type ExecutionReply = {
  [M in ExecutionCommandName]: ExecutionReplyEnvelope<M>
}[ExecutionCommandName]

/**
 * 命令错误码封闭词表（错误 → 权威源 → 重试动作的恢复闭环由 recovery 字段承载）。
 */
export const EXECUTION_COMMAND_ERROR_CODES = [
  'invalid_params',
  'run_not_found',
  'run_not_interrupted',
  'resume_script_mismatch',
  'member_not_found',
  'member_not_interactive',
  'member_closed',
  'notice_not_found',
  'notice_not_delivered',
  'budget_hard_limit_exceeded',
  'internal_error',
] as const

export type ExecutionCommandErrorCode = (typeof EXECUTION_COMMAND_ERROR_CODES)[number]

/**
 * 命令错误。
 *
 * `recovery` 必须指向可执行的恢复动作（具体命令 / 下一步），形成「错误 → 权威源 →
 * 重试」闭环；空串仅用于无需恢复动作的终局错误。
 */
export interface ExecutionCommandError { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  code: ExecutionCommandErrorCode
  message: string
  recovery: string
}

/** 失败回执信封（transport response 的 error 载荷）。 */
export interface ExecutionErrorReply { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  commandId: CommandId
  error: ExecutionCommandError
}

/**
 * 控制通道请求帧（D10 语义层三类消息之一）。
 *
 * method 取值 = 本文件 EXECUTION_COMMAND_NAMES 之一，或传输契约登记的语义层方法
 * （engine.* / state.* / domain.*）。params 形状由 method 决定。
 */
export interface ControlRequestFrame { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  id: string
  method: string
  params?: unknown
}

/** 控制通道应答帧（result 与 error 二选一）。 */
export interface ControlResponseFrame { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  id: string
  result?: unknown
  error?: ExecutionCommandError
}

/** 控制通道通知帧（无 id，不需要应答；例如事实广播与告警）。 */
export interface ControlNotificationFrame { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  method: string
  params?: unknown
}

/** 语义层方法名空间前缀（D10；执行 API 命令名不加上下文前缀，与设计表格逐字一致）。 */
export const CONTROL_METHOD_NAMESPACES = ['engine', 'state', 'domain'] as const

export type ControlMethodNamespace = (typeof CONTROL_METHOD_NAMESPACES)[number]
