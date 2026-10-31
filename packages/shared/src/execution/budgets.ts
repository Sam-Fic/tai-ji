/**
 * 执行域资源预算单源（M0 契约层）。
 *
 * 权威依据：
 * - 契约级终态裁决第 3 项（D16）：执行日志按大小分段（8–16MB/段）+ 在 run 或批次
 *   边界写检查点；预算两级（会话级 + 全局级）：软限先归档最旧的已终局段，硬上限拒绝
 *   新 run 并显式报错。
 * - 契约级终态裁决第 10 项（D17）：预算常量进 shared 配置契约单源（可被环境变量
 *   覆盖），默认值随设计定稿一次，之后改值走 changeset；不允许散落字面量。
 * - 设计「恢复与中断」：失联宽限超时 = 观测告警不是判死源，**告警通道与超时值进
 *   M0 契约**（本文件给出超时默认值，告警载荷见 alerts.ts）。
 *
 * 取值说明（M0 定稿默认值；改值走 changeset）：
 * - 段大小取设计区间 8–16MB：min 是「未到该尺寸不做仅按尺寸的轮转」下界，target 是
 *   「到达该尺寸必然在下一个批次边界轮转」上界；轮转点还受 run/批次边界约束。
 * - 会话软限 256MB ≈ 16–32 个满段，为归档旧终局段留出操作空间；硬限 = 软限 ×2，
 *   到达即拒绝新 run（不淘汰活跃段）。
 * - 全局软限 = 会话软限 ×8（约 8 个会话同时触软限），硬限 = 全局软限 ×2。
 * - 失联宽限 60s：本地 Unix socket 无网络抖动形态，宽限只覆盖「信号链自身故障」的
 *   极端场景（设计三档裁决），60s 与仓库既有 renderer RPC 余量同量级，不参与判死。
 */

/** 执行域两级预算与日志分段阈值（字节 / 毫秒）。 */
export interface ExecutionBudgets { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 日志段最小尺寸：未到此尺寸不因尺寸轮转（仍可在 run/批次边界轮转）。 */
  logSegmentMinBytes: number
  /** 日志段目标尺寸：到达即必须在下一个批次边界轮转。 */
  logSegmentTargetBytes: number
  /** 会话级软限：到达后归档最旧的已终局段。 */
  sessionSoftLimitBytes: number
  /** 会话级硬限：到达后拒绝新 run 并显式报错。 */
  sessionHardLimitBytes: number
  /** 全局级软限：到达后归档最旧的已终局段（跨会话）。 */
  globalSoftLimitBytes: number
  /** 全局级硬限：到达后拒绝新 run 并显式报错。 */
  globalHardLimitBytes: number
  /** 状态命令域失联宽限：超时只写结构化告警，不判死（见 alerts.ts）。 */
  contactLostGraceMs: number
}

/** 预算常量单源（唯一默认值定义点；环境变量只做覆盖，不产生第二份默认值）。 */
export const EXECUTION_BUDGET_DEFAULTS: Readonly<ExecutionBudgets> = Object.freeze({
  // eslint-disable-next-line no-magic-numbers -- 设计标定 8–16MB/段区间的下界（见文件头取值说明）
  logSegmentMinBytes: 8 * 1024 * 1024,
  // eslint-disable-next-line no-magic-numbers -- 设计标定 8–16MB/段区间的上界（见文件头取值说明）
  logSegmentTargetBytes: 16 * 1024 * 1024,
  // eslint-disable-next-line no-magic-numbers -- 会话软限 256MB，约 16–32 个满段（见文件头取值说明）
  sessionSoftLimitBytes: 256 * 1024 * 1024,
  // eslint-disable-next-line no-magic-numbers -- 会话硬限 = 软限 ×2（见文件头取值说明）
  sessionHardLimitBytes: 512 * 1024 * 1024,
  // eslint-disable-next-line no-magic-numbers -- 全局软限 = 会话软限 ×8（见文件头取值说明）
  globalSoftLimitBytes: 2 * 1024 * 1024 * 1024,
  // eslint-disable-next-line no-magic-numbers -- 全局硬限 = 全局软限 ×2（见文件头取值说明）
  globalHardLimitBytes: 4 * 1024 * 1024 * 1024,
  contactLostGraceMs: 60_000,
})

/** 每个预算字段的环境变量覆盖名（唯一登记处；新增字段须同批登记）。 */
export const EXECUTION_BUDGET_ENV_NAMES: Readonly<Record<keyof ExecutionBudgets, string>> = Object.freeze({
  logSegmentMinBytes: 'TAIJI_EXECUTION_LOG_SEGMENT_MIN_BYTES',
  logSegmentTargetBytes: 'TAIJI_EXECUTION_LOG_SEGMENT_TARGET_BYTES',
  sessionSoftLimitBytes: 'TAIJI_EXECUTION_LOG_SESSION_SOFT_LIMIT_BYTES',
  sessionHardLimitBytes: 'TAIJI_EXECUTION_LOG_SESSION_HARD_LIMIT_BYTES',
  globalSoftLimitBytes: 'TAIJI_EXECUTION_LOG_GLOBAL_SOFT_LIMIT_BYTES',
  globalHardLimitBytes: 'TAIJI_EXECUTION_LOG_GLOBAL_HARD_LIMIT_BYTES',
  contactLostGraceMs: 'TAIJI_EXECUTION_CONTACT_LOST_GRACE_MS',
})

/** 环境变量快照（调用方显式注入；本模块绝不改写它）。 */
export type ExecutionBudgetEnv = Record<string, string | undefined>

/** 被忽略的覆盖项（fail-visible：调用方负责把 ignored 写日志/告警，不静默吞）。 */
export interface ExecutionBudgetOverrideIssue { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  envName: string
  rawValue: string
  /** 忽略原因 + 恢复动作。 */
  reason: string
}

/** 解析结果（budgets 恒为合法值；ignored 表达哪些覆盖未生效）。 */
export interface ExecutionBudgetResolution { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  budgets: ExecutionBudgets
  ignored: ExecutionBudgetOverrideIssue[]
}

const POSITIVE_INTEGER_PATTERN = /^\d+$/

/**
 * 读取进程环境快照（不 import node 内置：shared 是零 node 依赖纯模块）。
 * 无 process 的宿主（纯浏览器环境）返回空对象 → 全部走默认值。
 */
export function readExecutionBudgetEnv(): ExecutionBudgetEnv {
  const processLike = (globalThis as { process?: { env?: ExecutionBudgetEnv } }).process
  return processLike?.env ?? {}
}

function parsePositiveInteger(
  field: keyof ExecutionBudgets,
  env: ExecutionBudgetEnv,
  ignored: ExecutionBudgetOverrideIssue[],
): number | undefined {
  const envName = EXECUTION_BUDGET_ENV_NAMES[field]
  const rawValue = env[envName]
  if (rawValue === undefined || rawValue === '') return undefined
  if (!POSITIVE_INTEGER_PATTERN.test(rawValue)) {
    ignored.push({
      envName,
      rawValue,
      reason: '必须是正整数字符串（字节数 / 毫秒）；恢复动作：改为十进制正整数或删除该环境变量',
    })
    return undefined
  }
  const parsed = Number(rawValue)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    ignored.push({
      envName,
      rawValue,
      reason: '超出安全整数范围或不是正数；恢复动作：改为可表示的正整数或删除该环境变量',
    })
    return undefined
  }
  return parsed
}

function revertOverrides(
  budgets: ExecutionBudgets,
  overridden: Set<keyof ExecutionBudgets>,
  fields: readonly (keyof ExecutionBudgets)[],
  env: ExecutionBudgetEnv,
  ignored: ExecutionBudgetOverrideIssue[],
  reason: string,
): boolean {
  let reverted = false
  for (const field of fields) {
    if (!overridden.has(field)) continue
    budgets[field] = EXECUTION_BUDGET_DEFAULTS[field]
    overridden.delete(field)
    ignored.push({
      envName: EXECUTION_BUDGET_ENV_NAMES[field],
      rawValue: env[EXECUTION_BUDGET_ENV_NAMES[field]] ?? '',
      reason,
    })
    reverted = true
  }
  if (!reverted) {
    ignored.push({
      envName: fields.map((field) => EXECUTION_BUDGET_ENV_NAMES[field]).join(' / '),
      rawValue: '',
      reason,
    })
  }
  return reverted
}

/**
 * 解析两级预算：默认值 + 环境变量覆盖 + 关系不变量校验。
 *
 * 关系不变量（任一破坏 = 相关覆盖回退默认值并记录 ignored）：
 * - logSegmentMinBytes ≤ logSegmentTargetBytes；
 * - sessionSoftLimitBytes < sessionHardLimitBytes；
 * - globalSoftLimitBytes < globalHardLimitBytes；
 * - sessionHardLimitBytes ≤ globalHardLimitBytes；
 * - sessionSoftLimitBytes ≤ globalSoftLimitBytes。
 *
 * 校验为不动点式收敛：任一检查触发实际回退后从头重跑全部检查，直至一轮无回退——
 * 顺序单遍校验在「先触发的检查回退字段破坏了先前已通过的检查」时不会复检（例：会话
 * 软/硬限同时覆盖、会话硬限因超全局硬限先回退，回退后的软限 ≥ 硬限不再被检出）。
 */
export function resolveExecutionBudgets(
  env: ExecutionBudgetEnv = readExecutionBudgetEnv(),
): ExecutionBudgetResolution {
  const budgets: ExecutionBudgets = { ...EXECUTION_BUDGET_DEFAULTS }
  const ignored: ExecutionBudgetOverrideIssue[] = []
  const overridden = new Set<keyof ExecutionBudgets>()

  for (const field of Object.keys(EXECUTION_BUDGET_ENV_NAMES) as (keyof ExecutionBudgets)[]) {
    const parsed = parsePositiveInteger(field, env, ignored)
    if (parsed === undefined) continue
    budgets[field] = parsed
    overridden.add(field)
  }

  // 终止性：每次实际回退都把一个覆盖字段置回默认值并移出 overridden（默认值组满足
  // 全部不变量），循环至多执行 overridden 大小 + 1 轮。检查触发但无可回退字段时只
  // 记录不驱动下一轮——继续循环不会改变任何值，只会无限重复记录。
  for (;;) {
    let revertedThisPass = false
    const enforce = (
      broken: boolean,
      fields: readonly (keyof ExecutionBudgets)[],
      reason: string,
    ): void => {
      if (!broken) return
      if (revertOverrides(budgets, overridden, fields, env, ignored, reason)) {
        revertedThisPass = true
      }
    }
    enforce(
      budgets.logSegmentMinBytes > budgets.logSegmentTargetBytes,
      ['logSegmentMinBytes', 'logSegmentTargetBytes'],
      '段最小尺寸不得大于段目标尺寸；恢复动作：调整两个环境变量使 min ≤ target',
    )
    enforce(
      budgets.sessionSoftLimitBytes >= budgets.sessionHardLimitBytes,
      ['sessionSoftLimitBytes', 'sessionHardLimitBytes'],
      '会话软限必须小于会话硬限；恢复动作：调整两个环境变量使 soft < hard',
    )
    enforce(
      budgets.globalSoftLimitBytes >= budgets.globalHardLimitBytes,
      ['globalSoftLimitBytes', 'globalHardLimitBytes'],
      '全局软限必须小于全局硬限；恢复动作：调整两个环境变量使 soft < hard',
    )
    enforce(
      budgets.sessionHardLimitBytes > budgets.globalHardLimitBytes,
      ['sessionHardLimitBytes', 'globalHardLimitBytes'],
      '会话硬限不得大于全局硬限；恢复动作：调整两个环境变量使会话级 ≤ 全局级',
    )
    enforce(
      budgets.sessionSoftLimitBytes > budgets.globalSoftLimitBytes,
      ['sessionSoftLimitBytes', 'globalSoftLimitBytes'],
      '会话软限不得大于全局软限；恢复动作：调整两个环境变量使会话级 ≤ 全局级',
    )
    if (!revertedThisPass) break
  }

  return { budgets, ignored }
}
