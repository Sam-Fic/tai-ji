/**
 * 执行域状态词表与显式状态机（M0 契约层）。
 *
 * 权威依据：
 * - 词表继承：契约级终态裁决第 5 项（D16）——终局结算直接继承现行词表
 *   （FailureCause / StopReason / 取消优先族 / partially_succeeded），重写只换承载
 *   （执行日志）不换词表；本文件的 RunOutcome 五项与 `packages/shared/src/workflow.ts`
 *   的 WORKFLOW_RUN_OUTCOME_ALL 逐项相等（契约测试锁）。
 * - 迁移约束：设计 §3.1 领域模型「Run 聚合不变量」与「MemberSession 聚合不变量」。
 *
 * 为什么状态机进 M0：本仓库约定有状态的领域模型必须先立显式状态机（状态枚举 +
 * 合法转移表 + 表外转移 fail-fast）。M0 定契约、M1 实现，二者共用同一张表，避免
 * runtime 与服务侧各自解释状态。
 *
 * 表外转移的处置口径 = 调用方 fail-fast（抛错并显式报错），禁止静默吞。
 */

/** Run 终局结算词表（五项，逐项继承现行词表；顺序仅作稳定遍历，不表达优先级）。 */
export const RUN_OUTCOMES = [
  'done',
  'failed',
  'cancelled',
  'time_limited',
  'partially_succeeded',
] as const

export type RunOutcome = (typeof RUN_OUTCOMES)[number]

/**
 * Run 生命周期状态：created → running ⇄ interrupted → 终局（五值之一）。
 *
 * 语义要点（设计 §3.1 Run 聚合不变量）：
 * - Run 只能从 created 进入 running（创建与启动由同一持久提交完成）；
 * - interrupted 只是暂停态，恢复后回到 running，不是终局；
 * - terminal 只能进入一次。
 */
export const RUN_STATUSES = ['created', 'running', 'interrupted', ...RUN_OUTCOMES] as const

export type RunStatus = (typeof RUN_STATUSES)[number]

/**
 * Run 合法转移表（state × next → 是否合法）。
 *
 * interrupted 的进入只由故障路径产生（startup-sweep / 引擎域断连 / 父 pi 退出），
 * 不提供主动暂停命令（设计 §3.1「不设主动暂停命令」否决记录）。
 *
 * created → running 是唯一出边：run.start 的创建与启动在同一个原子批次提交
 * （RunCreated / RunStarted 同批落盘、持久确认后才回 accepted），因此 created 是
 * 批次内的瞬时态、不会成为 startup-sweep 可观察的未终局形态（M1 实现约束）。
 */
export const RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  created: ['running'],
  running: ['interrupted', ...RUN_OUTCOMES],
  interrupted: ['running', ...RUN_OUTCOMES],
  done: [],
  failed: [],
  cancelled: [],
  time_limited: [],
  partially_succeeded: [],
}

/** Run 暂停原因（interrupted 的全部来路；均为故障路径事实）。 */
export const RUN_PAUSE_CAUSES = ['startup_sweep', 'engine_disconnected', 'parent_exited'] as const

export type RunPauseCause = (typeof RUN_PAUSE_CAUSES)[number]

/** Step 终局词表（partially_succeeded 是 Run 级聚合词，不适用于单个 Step）。 */
export const STEP_OUTCOMES = ['done', 'failed', 'cancelled', 'time_limited'] as const

export type StepOutcome = (typeof STEP_OUTCOMES)[number]

export const STEP_STATUSES = ['scheduled', 'running', ...STEP_OUTCOMES] as const

export type StepStatus = (typeof STEP_STATUSES)[number]

/** Step 合法转移表：调度后最多一次启动，终局只进一次。 */
export const STEP_STATUS_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  scheduled: ['running', 'cancelled'],
  running: [...STEP_OUTCOMES],
  done: [],
  failed: [],
  cancelled: [],
  time_limited: [],
}

/** 成员模式（设计 §3.1：interactive / one-shot 共用同一生命周期）。 */
export const MEMBER_MODES = ['interactive', 'one-shot'] as const

export type MemberMode = (typeof MEMBER_MODES)[number]

export const MEMBER_STATUSES = ['running', 'idle', 'closed'] as const

export type MemberStatus = (typeof MEMBER_STATUSES)[number]

/** 成员合法转移表：关闭只中断当前轮次，不删除历史结果。 */
export const MEMBER_STATUS_TRANSITIONS: Readonly<Record<MemberStatus, readonly MemberStatus[]>> = {
  running: ['idle', 'closed'],
  idle: ['running', 'closed'],
  closed: [],
}

/** Attempt 终局词表（一次执行尝试的结局；与 Step 同族，不含 Run 级聚合词）。 */
export const ATTEMPT_OUTCOMES = ['done', 'failed', 'cancelled', 'time_limited'] as const

export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number]

/** Attempt 生命周期状态：running → settled / interrupted（终态只进一次）。 */
export const ATTEMPT_STATUSES = ['running', 'settled', 'interrupted'] as const

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]

export const ATTEMPT_STATUS_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  running: ['settled', 'interrupted'],
  settled: [],
  interrupted: [],
}

/**
 * 派发方式词表（契约级终态裁决第 11 项：旧 RecordOrigin 按真实语义正名为
 * manual / script —— 手动派发 / 脚本派发）。
 */
export const DISPATCH_ORIGINS = ['manual', 'script'] as const

export type DispatchOrigin = (typeof DISPATCH_ORIGINS)[number]

/** 转移合法性判定（表驱动；表外返回 false，由调用方 fail-fast 报错）。 */
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_STATUS_TRANSITIONS[from].includes(to)
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_STATUS_TRANSITIONS[from].includes(to)
}

export function canTransitionMember(from: MemberStatus, to: MemberStatus): boolean {
  return MEMBER_STATUS_TRANSITIONS[from].includes(to)
}

export function canTransitionAttempt(from: AttemptStatus, to: AttemptStatus): boolean {
  return ATTEMPT_STATUS_TRANSITIONS[from].includes(to)
}

/** Run 是否终局（终局词表成员即终局；created/running/interrupted 均非终局）。 */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return (RUN_OUTCOMES as readonly RunStatus[]).includes(status)
}

/** Member 是否已关闭（closed 是唯一终态）。 */
export function isClosedMemberStatus(status: MemberStatus): boolean {
  return status === 'closed'
}
