/**
 * readiness 域（startup-readiness-and-current-state 设计 §7.1 能力契约层，u-m0 M0 契约期）。
 *
 * 领域形状 SSOT：对齐 protocol.ts 既有组织惯例「领域形状下沉各自领域文件，protocol.ts
 * 仅登记 type→payload 映射」（retry-rules / network-proxy / session-occupancy 先例）。
 * 跨进程消费经 shared 出口（index.ts）——core 登记表 DataSourceDescriptor 的 requires
 * 引用本文件 RemoteCapability（设计 §7.4）。
 *
 * 契约封闭性（2026-10-31 收窄裁决，D1 不采用栏有否决记录）：ReadinessSnapshot = capabilities
 * 数组唯一 + 能力项字段集封闭——v2 草案的六值进程生命周期 state 字段
 * （spawning/listening/serving/draining/stopped/failed）及显式转移表删除：零消费方
 * 且 failed/stopped 两值协议上不可达（进程已死/已停时 WS 连接不存在，readiness RPC
 * 与广播均发不出）。runtime 进程内部阶段（spawn/serve/drain）为实现细节不入跨进程
 * 协议；进程死活由既有信号承载（探针 /health 判据不变、WS 断连、supervisor 进程信号
 * 与退出码）。字段集封闭由 READINESS_CAPABILITY_ENTRY_FIELDS 白名单常量 + 契约封闭性单测
 * （__tests__/readiness.test.ts，RL1）双重看守，防字段回潮。
 */

/** 跨进程能力枚举（设计 §7.1：协议 SSOT 进 @taiji/shared；本地依赖维度
 * focusedSession/viewOpen 在 core 组合，不进本枚举——见 core transport
 * DataSourceDescriptor.requires）。四项能力判据权威 = 设计 §6.1（D1）：
 * - transport：WS listen + 鉴权（控制通道不属它）
 * - business：迁移 + 服务装配 + 插件装载（确定性失败阻断，D2）+ 双控制通道各自
 *   listen——判据按通道存在性伸缩（D1 降级语义：状态命令域 socket 由重写 D10 交付，
 *   未落地时现存引擎传输域 listen 即满足、落地后自动并入）
 * - sessions：执行日志重放 + 执行器接管 + startup-sweep 收编三段（终态判据，随会话
 *   迁移逐会话切换；执行器未重连归本能力恢复进度，不算 business 未就绪）
 * - storage：会话磁盘元数据可读（与执行态解耦） */
export type RemoteCapability = 'transport' | 'business' | 'sessions' | 'storage'

/** 恢复进度 n/m（设计 §7.1 形状块：progress 与 SessionsRecoveryProgressPayload 字段同源）。 */
export interface ReadinessProgress { // oe-exempt:20261031:framework:启动就绪跨包协议契约（shared 单源 ports 层，恢复进度 n/m 形状，实现随后续波次落地）
  done: number
  total: number
}

/**
 * 能力项（设计 §7.1 形状块逐字段）。
 *
 * 字段集封闭（RL1）：name / ready / reason? / since / progress? 恰好五项——
 * 字段集外新增（进程生命周期 state 字段等）即红。机器看守 = 下方
 * READINESS_CAPABILITY_ENTRY_FIELDS 白名单常量（运行期可断言的单一投影）+ 契约封闭性
 * 单测的编译期双向对账断言（keyof 集合 ⊆ 白名单 ∩ 白名单 ⊆ keyof）。
 */
export interface ReadinessCapabilityEntry { // oe-exempt:20261031:framework:启动就绪跨包协议契约（shared 单源 ports 层，能力项字段集封闭由 RL1 白名单看守，实现随后续波次落地）
  /** 能力名（RemoteCapability 四值闭集）。 */
  name: RemoteCapability
  /** 当前是否就绪。 */
  ready: boolean
  /** 未就绪原因：机器可读枚举 + 人可读文案（插件失败含插件 id，D2）。就绪时缺省。 */
  reason?: string
  /** 进入当前 ready 态的时刻（epoch 毫秒）——边沿时序断言（A1 边沿间隔 > 0）的数据源。 */
  since: number
  /** 恢复进度 n/m：仅 sessions 恢复期出现（D11，2026-10-31 R3 补契约——属能力项字段
   * 集内补全，非能力项之外的新维度；被否候选「progress 不入快照」见 D11 不采用栏）。 */
  progress?: ReadinessProgress
}

/**
 * readiness 快照（设计 §7.1 形状块）：初始推送 readiness 段 / runtime.readiness RPC
 * reply / runtime.readinessChanged 广播三通道共用的载荷形状（推送与拉取同源——
 * 广播为加速显示，拉取为持续态唯一真相，D1 三段式消费）。
 *
 * 契约封闭性判据 = capabilities 数组唯一：快照顶层除 capabilities 外无其他字段（RL1）。
 */
export interface ReadinessSnapshot { // oe-exempt:20261031:framework:启动就绪跨包协议契约（shared 单源 ports 层，推送/拉取/广播三通道共用载荷形状，实现随后续波次落地）
  capabilities: ReadinessCapabilityEntry[]
}

/**
 * sessions 恢复进度节流通知载荷（设计 §7.1 形状块；广播消息
 * runtime.sessionsRecoveryProgress，D11）：reason 迁移（如 mem-pressure → 恢复中 n/m）
 * 不构成能力翻转、无 readinessChanged 边沿可借，状态行刷新走本通知——500ms 级时间
 * 节流，仅 sessions 恢复期发送；退役条件 = 随重写 M5 恢复链移交执行域时一并退役
 * （D11 时间平抑登记）。
 */
export interface SessionsRecoveryProgressPayload { // oe-exempt:20261031:framework:启动就绪跨包协议契约（shared 单源 ports 层，会话恢复节流通知载荷，实现随后续波次落地）
  /** 机器可读枚举——覆盖 reason 迁移（如 mem-pressure → 恢复中）的文案刷新。 */
  reason: string
  /** n/m 进度；跳过/退化懒恢复等无计数形态缺省。 */
  progress?: ReadinessProgress
}

/**
 * 能力项字段集白名单（RL1 契约封闭性的运行期可断言载体）：与
 * ReadinessCapabilityEntry 的 keyof 集合双向锁定——类型加字段不改本常量 → 编译期
 * 对账断言红（readiness.test.ts，tsc 层）；改本常量不加字段 → satisfies 约束红 +
 * 单测运行期精确断言红。协议字段扩展 = 同时改类型与本常量（diff 显式可见，
 * 契约 review 点）。
 */
export const READINESS_CAPABILITY_ENTRY_FIELDS = [
  'name',
  'ready',
  'reason',
  'since',
  'progress',
] as const satisfies readonly (keyof ReadinessCapabilityEntry)[]

/** ReadinessSnapshot 快照顶层字段白名单（RL1：capabilities 数组唯一的运行期投影）。 */
export const READINESS_SNAPSHOT_FIELDS = ['capabilities'] as const satisfies readonly (keyof ReadinessSnapshot)[]
