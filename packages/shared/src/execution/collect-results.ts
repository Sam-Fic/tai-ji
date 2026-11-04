/**
 * collect_results 新通道契约（M0 契约层拍板项四条）。
 *
 * 权威依据：设计 §3.4 M0 与执行 API `notice.collect` 行、旧能力映射 pending 行、S15
 * 场景。四条拍板项逐条落在此文件：
 *
 * ① **未知 id 判定源 = 执行域已知键集的补集**：一个请求键既不在执行域已知键集
 *    （active / ready / collected / nonCollectable）也不在旧 pending 链已知键集时，
 *    判为 unknown_id，逐条进 errors 随本次调用返回，**不进等待集**（不阻塞到 timeout）。
 *    旧 pending 链（bash/session 类）是 M5 前的过渡路径，随旧条目链退役。M3–M5 升级
 *    窗口期内，升级前在途 run（尚未导入执行域）同判未知、同形态返回；M5 导入为
 *    interrupted 后该 id 转为已知（可 resume）——unknown_id 文案承载此窗口期语义。
 *
 * ② **混合键集两路聚合口径与单一 timeout 共享**：workflow/subagent 键走执行域路，
 *    bash/session 键走旧 pending 路；两路按键分路判定，三桶
 *    （collected/stillOpen/errors）为两路结果的按键并集。等待解除条件 = 等待键集
 *    （两路并集）全部终态/collected、timeout 到期、abort 三者之一——**不设路级解除**
 *    （任一路完成即整体返回会让 bash 先完成时提前返回，S15 ④ 可证伪子判据会检出）。
 *
 * ③ **notice.collect 幂等两层交叉**：先命令层（同 commandId 重放 → 返回首次受理
 *    修订号），未命中进入命令处理；处理中发现通知已 collected → 领域层 noticeId
 *    幂等命中，不落事件（collected 无自环转移），回执返回该通知 **NoticeCollected
 *    首次发生时的修订号**（不是会话当前修订号——期间其他命令推进 revision 不改变
 *    回执取值）。两层正交，判定顺序先①后②。
 *
 * ④ **通知内容快照读取通道**：collect_results 工具视图经执行事件流派生通知缓存读取
 *    通知内容与 collected 状态（缓存折叠输入 = NoticeQueued / NoticeDelivered /
 *    NoticeCollected / NoticeAbandoned，见 notice.ts），already-collected 幂等返回
 *    由此承载；该缓存为派生态、非事实源。不新增通知查询命令、ExecutionSnapshot
 *    外层不设 notices 字段（快照外层固定五项）。
 */

/** 返回三桶（按键并集，不按路分桶）。 */
export const COLLECT_RESULT_BUCKETS = ['collected', 'stillOpen', 'errors'] as const

export type CollectResultBucket = (typeof COLLECT_RESULT_BUCKETS)[number]

/**
 * 等待解除条件（三项封闭词表）。
 *
 * 不设「任一路完成」第四项：等待集恒为两路并集，路级解除是被 S15 ④ 明确否决的形态。
 */
export const COLLECT_WAIT_RELEASE_CONDITIONS = [
  'wait_set_all_terminal_or_collected',
  'timeout',
  'aborted',
] as const

export type CollectWaitReleaseCondition = (typeof COLLECT_WAIT_RELEASE_CONDITIONS)[number]

/** 键的两条来源路（执行域权威路 / 旧 pending 过渡路）。 */
export const COLLECT_KEY_SOURCES = ['execution', 'pending'] as const

export type CollectKeySource = (typeof COLLECT_KEY_SOURCES)[number]

/** 单键错误码（逐条 errors 返回，不进 waiting 集）。 */
export const COLLECT_KEY_ERROR_CODES = ['unknown_id', 'not_collectable'] as const

export type CollectKeyErrorCode = (typeof COLLECT_KEY_ERROR_CODES)[number]

/** 单键错误（recovery 指向可执行恢复动作）。 */
export interface CollectKeyError { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  key: string
  code: CollectKeyErrorCode
  message: string
  recovery: string
}

/**
 * 执行域已知键集（由 M3 工具视图从执行快照 + 通知缓存派生；四集合语义互斥）：
 * - active：非终局的 run / 有在途轮次的 member → 进等待集；
 * - ready：已终局且有结果工件、通知已 delivered 且未 collected（状态机 collected 仅可由
 *   delivered 进入，见 notice.ts NOTICE_STATUS_TRANSITIONS）→ 立即进 collected（并回写
 *   notice.collect）；
 *   通知 abandoned 的键不在此列——归 nonCollectable（对齐 notice.ts isNoticeOutOfCollectSet：
 *   abandoned 在缓存中呈其终态、不进等待与收集集），不得进 ready/collected；
 * - collected：通知已 collected → 进 collected（幂等返回其快照）；
 * - nonCollectable：已知但当前不可收集（interrupted 暂停态、已关闭且无结果的成员、通知
 *   abandoned 的键）→ errors。
 *
 * 同一键误入多集合时的优先级（fail-visible，不静默）：nonCollectable > collected >
 * ready > active——越靠近「不可推进」的判定越优先，避免把悬置对象放进等待集（S8）。
 */
export interface ExecutionCollectKeySets { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  active: readonly string[]
  ready: readonly string[]
  collected: readonly string[]
  nonCollectable: readonly string[]
}

export interface CollectRoutingInput { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 请求键（可重复；实现按首次出现序去重）。 */
  requested: readonly string[]
  /** 执行域已知键集（权威路）。 */
  execution: ExecutionCollectKeySets
  /** 旧 pending 链已知键（bash / session 类；M5 前过渡路）。 */
  pendingKnown: readonly string[]
}

/** 分路结果（collected/errors 两桶 + 两路等待子集；waitKeys 是两路并集；stillOpen 无字段——
 *  于等待解除时由等待集按当时状态派生，属 M3 工具视图）。 */
export interface CollectRouting { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  collected: string[]
  /** 执行域路等待键（S15 ④ 判据：与 pendingWait 并集共享单一 timeout）。 */
  executionWait: string[]
  /** 旧 pending 路等待键。 */
  pendingWait: string[]
  /** 等待键并集（唯一等待集；无路级解除）。 */
  waitKeys: string[]
  errors: CollectKeyError[]
}

/**
 * 未知 id 文案（文案 M0 定稿义务，设计 §5.2 旧能力映射 pending 行「窗口期口径」）：
 * 除「从未派发」外还须覆盖 M3–M5 升级窗口期形态——升级前在途 run（执行器已随旧
 * 进程终止、尚未导入执行域）对执行域同样未知、同形态返回；M5 导入为 interrupted
 * 后该 id 转为已知，可 resume（S8 窗口期判据引用此形态）。
 */
const UNKNOWN_ID_ERROR: Omit<CollectKeyError, 'key'> = {
  code: 'unknown_id',
  message:
    '请求 id 不属于本会话执行域已知键，也不属于旧 pending 链已知键（M3–M5 升级窗口期内，升级前在途 run 尚未导入执行域时同属未知——逐条 errors 返回、不进等待集、不占 timeout）',
  recovery:
    '确认该任务已在本会话派发；collect_results 的未知 id 按执行域已知键集补集判定，派发成功后再调用。若为升级前在途 run，M5 存量导入后该 id 转为已知（interrupted 态，可 resume）',
}

const NOT_COLLECTABLE_ERROR: Omit<CollectKeyError, 'key'> = {
  code: 'not_collectable',
  message: '该 run/member 处于不可收集状态（如 interrupted 暂停态或已关闭且无结果）',
  recovery: '先显式 resume（仅 interrupted 且脚本哈希一致）或等其进入终局后再 collect',
}

/**
 * 按键分路（纯函数，无 IO）。
 *
 * 判定顺序：执行域四集合（nonCollectable → collected → ready → active）→ 旧 pending
 * 已知键 → unknown。执行域优先于 pending：同一 id 在旧链残留时以执行域权威为准。
 */
export function routeCollectKeys(input: CollectRoutingInput): CollectRouting {
  const nonCollectable = new Set(input.execution.nonCollectable)
  const collected = new Set(input.execution.collected)
  const ready = new Set(input.execution.ready)
  const active = new Set(input.execution.active)
  const pendingKnown = new Set(input.pendingKnown)

  const seen = new Set<string>()
  const routing: CollectRouting = {
    collected: [],
    executionWait: [],
    pendingWait: [],
    waitKeys: [],
    errors: [],
  }

  for (const key of input.requested) {
    if (seen.has(key)) continue
    seen.add(key)

    if (nonCollectable.has(key)) {
      routing.errors.push({ key, ...NOT_COLLECTABLE_ERROR })
    } else if (collected.has(key) || ready.has(key)) {
      routing.collected.push(key)
    } else if (active.has(key)) {
      routing.executionWait.push(key)
    } else if (pendingKnown.has(key)) {
      routing.pendingWait.push(key)
    } else {
      routing.errors.push({ key, ...UNKNOWN_ID_ERROR })
    }
  }

  routing.waitKeys = [...routing.executionWait, ...routing.pendingWait]
  return routing
}

/** timeout_ms 解析结果（invalid 时调用方应返回 invalid_params，同时仍持有安全默认值）。 */
export interface CollectTimeoutResolution { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** null = 不限时（未传 timeout_ms 即不限时，ADR-0188：无默认墙钟）。 */
  timeoutMs: number | null
  valid: boolean
}

/**
 * 解析 timeout_ms：未传 = 不限时（null，无默认墙钟——ADR-0188 规则「未传就是不限时」）；
 * 合法值 = 非负整数；非法值（负数/小数/NaN/Infinity）= invalid + null（fail-visible：
 * 调用方据此显式报错，不静默改语义、不回退任何默认值）。
 */
export function resolveCollectTimeoutMs(value?: number): CollectTimeoutResolution {
  if (value === undefined) return { timeoutMs: null, valid: true }
  if (Number.isInteger(value) && value >= 0) return { timeoutMs: value, valid: true }
  return { timeoutMs: null, valid: false }
}

/**
 * notice.collect 两层幂等的判定顺序（先命令层、后领域层）。
 *
 * 顺序不可交换：命令层命中时连事件都不进入处理；领域层命中时命令本身是首次受理，
 * 只是通知已 collected，因此回执修订号取「首次收集发生点」。
 */
export const NOTICE_COLLECT_IDEMPOTENCY_ORDER = ['command', 'notice'] as const

export type NoticeCollectIdempotencyLayer = (typeof NOTICE_COLLECT_IDEMPOTENCY_ORDER)[number]

export interface NoticeCollectRevisionInput { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 命令层命中：该 commandId 首次受理的修订号（存在即最高优先）。 */
  commandReplayRevision?: number
  /** 领域层命中：该通知 NoticeCollected 事件首次发生所在修订号。 */
  noticeCollectedRevision?: number
  /** 当前会话修订号（两层都未命中 = 本次为首次收集，事件在本次批次落盘后的修订号）。 */
  currentRevision: number
}

/**
 * notice.collect 回执修订号裁决（两层幂等交叉情形）。
 *
 * 返回值的消费语义 = 「调用方确认该收集确认已生效」的修订号锚点，不承担快照交付；
 * 期间其他命令推进 currentRevision 不改变 ①② 两条命中路径的取值。
 */
export function resolveNoticeCollectRevision(input: NoticeCollectRevisionInput): number {
  if (input.commandReplayRevision !== undefined) return input.commandReplayRevision
  if (input.noticeCollectedRevision !== undefined) return input.noticeCollectedRevision
  return input.currentRevision
}
