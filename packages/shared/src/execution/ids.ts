/**
 * 执行域标识类型（M0 契约层，设计 §3.1 领域模型 / §5.2 双形态契约字段单一权威）。
 *
 * 为什么单列：执行域的身份稳定性是恢复契约的前提（设计 D3 / 契约级终态裁决第 8 条）——
 * runId / memberId / attemptId 创建后不变；stepKey 由脚本哈希派生。把这些类型集中一处，
 * 下游（runtime 状态权威、扩展执行器、renderer）引用同一组别名，避免各自写裸 string
 * 后字段语义漂移。
 *
 * 全部为 string 别名（不做名义类型 brand）：现有仓库的 wire 契约与 JSONL 落盘都按裸
 * string 传输，brand 会强迫每个解析边界做断言，收益不抵成本；身份不变性由事件 payload
 * 的只写一次语义与 resume 校验承载，不由类型系统假装保证。
 */

/** 执行域会话 id（主 session id；快照与事件流按会话分片）。 */
export type ExecutionSessionId = string

/** Run 唯一 id（创建时生成，永不变；RunCreated 事件是唯一创建点）。 */
export type RunId = string

/** MemberSession 唯一 id（创建时生成，永不变；subagent 成员与独立 member 共用）。 */
export type MemberId = string

/** Step 身份键（= hash(scriptHash, callSite, occurrence)，生成规则见 identity.ts）。 */
export type StepKey = string

/** Attempt 唯一 id（一次步骤/成员轮次的执行尝试；引擎会话不能跨 Step 复用）。 */
export type AttemptId = string

/** 结果工件 id（ResultRecorded 事件引用它，正文独立落盘）。 */
export type ResultId = string

/** 通知 id（NoticeIntent 的领域层幂等键，见 notice.ts）。 */
export type NoticeId = string

/** 命令幂等键（同一 commandId 重放返回首次受理的修订号，见 commands.ts）。 */
export type CommandId = string

/** 会话执行日志修订号（= 最后应用事件的 seq；快照与推送共用）。 */
export type ExecutionRevision = number

/** runtime 实例世代（重启即变；renderer 拒绝旧世代消息）。 */
export type ExecutionGeneration = number
