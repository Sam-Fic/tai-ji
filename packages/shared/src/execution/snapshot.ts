/**
 * 执行快照契约（M0 契约层）。
 *
 * 权威依据：
 * - 设计 §5.2 双形态契约字段单一权威：快照外层五个字段 =
 *   `sessionId/revision/generation/runs/members`。
 * - 设计 D5：快照与增量消息都带 `revision = 最后事件 seq` 与 `generation`；renderer
 *   只接受更高 revision；runtime 世代变化时先标 stale 再重新拉取。
 * - 设计「恢复与中断」：状态命令域连接断 = 失联标记（不判死），**快照携带
 *   `contactLostAt`**；该标记挂在 run 快照上（S12「run 保持失联标记而非 interrupted」），
 *   从而保持外层五字段的字段级单一权威不被破坏。
 *
 * 外部消费者只读快照与事件流，不直接读执行域内部文件格式；快照是可删缓存/派生态，
 * 事实源仍是执行事件日志。
 */

import type { FailureCause, EngineStopReason } from '@zhushanwen/subagent-engine-sdk'

import type {
  AttemptId,
  ExecutionGeneration,
  ExecutionRevision,
  ExecutionSessionId,
  MemberId,
  ResultId,
  RunId,
  StepKey,
} from './ids'
import type {
  AttemptStatus,
  DispatchOrigin,
  MemberMode,
  MemberStatus,
  RunOutcome,
  RunStatus,
  StepStatus,
} from './status'

/**
 * 成员最近一轮快照（轮次级事实；成员历史结果由结果工件按 id 查询，不内嵌全文）。
 */
export interface ExecutionMemberTurnSnapshot { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  readonly attemptId: AttemptId
  /** 成员轮次序号（1 起）。 */
  turn: number
  /** 所属 attempt 的状态（status.ts AttemptStatus 同源词表，扩值自动跟随）。 */
  status: AttemptStatus
  startedAt: number
  settledAt?: number
  /** 引擎收尾事实词（停止原因）。 */
  stopReason?: EngineStopReason
  /** 五维失败分类（失败轮）。 */
  failure?: FailureCause
  /** 本轮回执的结果工件引用（存在时）。 */
  resultId?: ResultId
}

/**
 * 成员快照（MemberSession 聚合根的只读视图）。
 *
 * 身份字段（memberId）创建后不变；mode 决定是否接受 member.send。
 */
export interface ExecutionMemberSnapshot { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  readonly memberId: MemberId
  mode: MemberMode
  status: MemberStatus
  /** 派发方式（manual / script）。 */
  origin: DispatchOrigin
  agent?: string
  model?: string
  /** workflow 内成员归属的 run（独立 subagent 成员缺省）。 */
  parentRunId?: RunId
  createdAt: number
  closedAt?: number
  lastTurn?: ExecutionMemberTurnSnapshot
}

/**
 * 步骤快照（Run 聚合内实体）。
 *
 * stepKey 是恢复匹配键（由脚本哈希派生）；callSite/occurrence 是其输入的展示副本。
 */
export interface ExecutionStepSnapshot { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  readonly stepKey: StepKey
  /** 调用点静态路径归一 + 行/列（展示与重放定位）。 */
  callSite: string
  /** 同点序号（0 起）。 */
  occurrence: number
  /** 该步骤调用的 agent 名（展示用，不参与身份）。 */
  agent?: string
  status: StepStatus
  /** 当前/最近一次活跃 Attempt（同一时刻最多一个活跃 Attempt）。 */
  attemptId?: AttemptId
  startedAt?: number
  settledAt?: number
  resultId?: ResultId
}

/**
 * Run 快照（Run 聚合根的只读视图）。
 *
 * `contactLostAt`：状态命令域断连后的失联标记（epoch ms），**不是终态**——瞬断/扩展
 * 重启时不把 run 误标为 interrupted；重连续传后随更高 revision 清除。判死只由事实信号
 * 承载（引擎域断连 / 进程探活 / startup-sweep），时间阈值的宽限超时只产生可观测告警
 * （见 alerts.ts），不改变本字段之外的任何状态。
 */
export interface ExecutionRunSnapshot { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  readonly runId: RunId
  status: RunStatus
  /** 终局结算结果（仅终局 Run 存在）。 */
  outcome?: RunOutcome
  scriptPath: string
  scriptHash: string
  paramsHash: string
  createdAt: number
  startedAt?: number
  /** interrupted 状态进入时间（暂停态，可 resume）。 */
  interruptedAt?: number
  settledAt?: number
  /** 失联标记（epoch ms）；undefined = 状态命令域连接正常。 */
  contactLostAt?: number
  /** Run 级结果工件引用（终局后存在）。 */
  resultId?: ResultId
  steps: ExecutionStepSnapshot[]
}

/**
 * 执行快照（某会话在 revision 时的只读视图）。
 *
 * 外层字段固定五项（设计 §5.2）：任何新增快照级数据都必须先改契约与设计，禁止
 * 在对象上加第六个字段（尤其禁止 notices——通知经派生缓存读取，见 notice.ts）。
 */
export interface ExecutionSnapshot { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 会话 id（快照按会话分片）。 */
  sessionId: ExecutionSessionId
  /** = 最后应用事件（批次末事件）的 seq。 */
  revision: ExecutionRevision
  /** runtime 实例世代（重启即变；renderer 拒绝旧世代消息）。 */
  generation: ExecutionGeneration
  /** 本会话全部 run 的只读视图（含终局 run）。 */
  runs: ExecutionRunSnapshot[]
  /** 本会话全部成员的只读视图（含已关闭成员）。 */
  members: ExecutionMemberSnapshot[]
}
