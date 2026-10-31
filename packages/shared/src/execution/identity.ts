/**
 * 执行身份与恢复契约（M0 契约层）。
 *
 * 权威依据：
 * - 设计 D3：`runId`、`memberId`、`attemptId` 创建后不变；Step 用
 *   `stepKey = hash(scriptHash, callSite, occurrence)`；RunCreated 记录脚本哈希与参数
 *   哈希；resume 只在哈希一致且 run 为 interrupted 时接受；脚本 ABI 保持，但脚本必须
 *   作为确定性计划使用。
 * - 契约级终态裁决第 8 项（D17）：stepKey = 脚本哈希 + 调用点静态路径归一 + 分支序号；
 *   脚本哈希变化即拒绝恢复并显式报告；静态解析不可得名的运行时实例归「未匹配组」
 *   显式呈现，不强行匹配。
 *
 * 哈希算法选择：shared 是零 node 依赖的纯模块（准入规则 3），不能用 node:crypto。
 * 采用 FNV-1a 64 位（BigInt 实现，逐 UTF-16 code unit 计算）——确定性、跨进程/跨
 * 引擎一致、无外部依赖；非密码学强度足够：stepKey 只需在同一 run 的步骤集合内区分
 * 调用点，不承担安全边界。输出 16 位小写十六进制（固定宽度，便于日志与对账）。
 * 算法属契约：改变编码或哈希即所有 run 的恢复键失效，必须升版并同批迁移。
 */

import type { StepKey } from './ids'
import type { RunStatus } from './status'

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n
const FNV_PRIME_64 = 0x100000001b3n
const UINT64_MASK = 0xffffffffffffffffn
const STEP_KEY_HASH_RADIX = 16
const STEP_KEY_HEX_LENGTH = 16

/** 创建后永不改变的实体身份字段（恢复/查询以这些字段为键）。 */
export const STABLE_IDENTITY_FIELDS = ['runId', 'memberId', 'attemptId'] as const

/**
 * 调用点（静态位置，1 基行列；路径必须是仓库相对 POSIX 形态）。
 *
 * 为什么行列 1 基而 occurrence 0 基：行列与编辑器/错误栈展示口径一致；occurrence 是
 * 程序计数语义（同一点第几次命中），与数组索引一致。
 */
export interface StaticCallSite { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 仓库相对脚本路径（`/` 分隔；禁止绝对路径与 `..` 越界语义）。 */
  scriptPath: string
  /** 1 基行号。 */
  line: number
  /** 1 基列号。 */
  column: number
}

/** 调用点引用（结构化静态位置，或解析器已归一好的字符串）。 */
export type CallSiteRef = StaticCallSite | string

/** 未匹配组标记（静态解析不可得名的运行时实例显式归此组）。 */
export const STEP_KEY_UNMATCHED_GROUP = 'unmatched' as const

/** 未匹配组条目（不做强行匹配；展示用运行时标签不参与身份）。 */
export interface UnmatchedStepGroup { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  kind: 'unmatched'
  group: typeof STEP_KEY_UNMATCHED_GROUP
  occurrence: number
  /** 运行时实例的可读标签（如脚本执行序 callId），仅展示。 */
  label?: string
}

/** stepKey 解析结果（静态可命名 → 稳定键；否则显式未匹配组）。 */
export type StepKeyResolution =
  | { kind: 'static'; stepKey: StepKey; callSite: string; occurrence: number }
  | UnmatchedStepGroup

/** stepKey 输入（三者共同决定身份；任一变化即不同步骤）。 */
export interface StepKeyInput { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  /** 脚本内容哈希（RunCreated.scriptHash 同源）。 */
  scriptHash: string
  /** 归一后的调用点字符串（`normalizeCallSiteRef` 的产物）。 */
  callSite: string
  /** 同点序号（0 起；同一次脚本执行中同一调用点的第 N 次命中）。 */
  occurrence: number
}

/**
 * 调用点路径归一：反斜杠 → `/`、剥除前导 `./`、折叠重复 `/`、去尾部 `/`。
 *
 * 只做确定性字符串归一，不做文件系统解析（不解析 `..`、不拼接 cwd）——归一结果必须
 * 与运行机器无关，否则跨机器恢复键不一致。
 */
export function normalizeCallSitePath(value: string): string {
  const unified = value.replace(/\\/g, '/')
  const withoutDotPrefix = unified.replace(/^(?:\.\/)+/, '')
  return withoutDotPrefix.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value)
}

/** 结构化调用点 → 归一字符串（`scriptPath:line:column`）。 */
export function formatCallSite(site: StaticCallSite): string {
  if (!site.scriptPath) {
    throw new Error('formatCallSite: scriptPath 为空；调用点静态路径是 stepKey 身份的一部分，必须提供')
  }
  const normalizedPath = normalizeCallSitePath(site.scriptPath)
  if (!normalizedPath) {
    throw new Error('formatCallSite: scriptPath 归一后为空；恢复动作：传入仓库相对脚本路径')
  }
  if (isAbsolutePath(normalizedPath)) {
    throw new Error(
      'formatCallSite: scriptPath 是绝对路径或带盘符；恢复动作：传仓库相对 POSIX 路径（stepKey 必须跨机器一致）',
    )
  }
  if (!Number.isInteger(site.line) || site.line < 1) {
    throw new Error('formatCallSite: line 必须是 ≥1 的整数（1 基行号）')
  }
  if (!Number.isInteger(site.column) || site.column < 1) {
    throw new Error('formatCallSite: column 必须是 ≥1 的整数（1 基列号）')
  }
  return `${normalizedPath}:${site.line}:${site.column}`
}

/** 调用点引用 → 归一字符串（字符串形态只做路径归一，保留已有 `:line:column` 后缀）。 */
export function normalizeCallSiteRef(ref: CallSiteRef): string {
  if (typeof ref !== "string") return formatCallSite(ref);
  const normalized = normalizeCallSitePath(ref);
  if (!normalized) {
    throw new Error("normalizeCallSiteRef: 调用点为空；恢复动作：传入脚本解析得到的静态调用点");
  }
  if (isAbsolutePath(normalized)) {
    throw new Error(
      "normalizeCallSiteRef: 调用点是绝对路径或带盘符；恢复动作：传仓库相对 POSIX 路径（stepKey 必须跨机器一致）",
    );
  }
  return normalized;
}

function lengthPrefixed(value: string): string {
  return `${value.length}:${value}`
}

/** FNV-1a 64 位（逐 UTF-16 code unit；跨引擎确定性）。 */
function fnv1a64Hex(value: string): string {
  let hash = FNV_OFFSET_BASIS_64
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = (hash * FNV_PRIME_64) & UINT64_MASK
  }
  return hash.toString(STEP_KEY_HASH_RADIX).padStart(STEP_KEY_HEX_LENGTH, '0')
}

/**
 * stepKey 生成（设计 D3 / D17 第 8 项的确定性实现）。
 *
 * 规范编码 = 三段长度前缀拼接（`len:value`），消除分隔符出现在输入中造成的歧义；
 * 哈希输入包含 scriptHash、归一调用点、occurrence 三者，缺一不可。
 */
export function computeStepKey(input: StepKeyInput): StepKey {
  if (!input.scriptHash) {
    throw new Error('computeStepKey: scriptHash 为空；恢复动作：从 RunCreated.scriptHash 取脚本哈希')
  }
  if (!input.callSite) {
    throw new Error('computeStepKey: callSite 为空；静态解析不可得时应走 resolveStepKey 的未匹配组分支')
  }
  if (!Number.isInteger(input.occurrence) || input.occurrence < 0) {
    throw new Error('computeStepKey: occurrence 必须是 ≥0 的整数（同点序号，0 起）')
  }
  const canonical = `${lengthPrefixed(input.scriptHash)}|${lengthPrefixed(input.callSite)}|${input.occurrence}`
  return fnv1a64Hex(canonical)
}

/**
 * 解析 stepKey：静态调用点可得 → 稳定键；不可得 → 未匹配组（不强行匹配）。
 *
 * 调用点为空（undefined 或空串归一后为空）是「静态解析不可得名」的唯一信号；
 * 结构化调用点非法（绝对路径/负行列）会抛错——那是解析器缺陷，不是合法的未匹配形态。
 */
export function resolveStepKey(input: {
  scriptHash: string
  callSite?: CallSiteRef
  occurrence: number
  label?: string
}): StepKeyResolution {
  if (input.callSite === undefined) {
    return {
      kind: 'unmatched',
      group: STEP_KEY_UNMATCHED_GROUP,
      occurrence: input.occurrence,
      ...(input.label !== undefined ? { label: input.label } : {}),
    }
  }
  const callSite = normalizeCallSiteRef(input.callSite)
  if (!callSite) {
    return {
      kind: 'unmatched',
      group: STEP_KEY_UNMATCHED_GROUP,
      occurrence: input.occurrence,
      ...(input.label !== undefined ? { label: input.label } : {}),
    }
  }
  return {
    kind: 'static',
    stepKey: computeStepKey({ scriptHash: input.scriptHash, callSite, occurrence: input.occurrence }),
    callSite,
    occurrence: input.occurrence,
  }
}

/** resume 拒绝码（显式报告，不静默重放）。 */
export const RUN_RESUME_REJECTION_CODES = ['resume_script_mismatch', 'run_not_interrupted'] as const

export type RunResumeRejectionCode = (typeof RUN_RESUME_REJECTION_CODES)[number]

/** resume 校验输入（参数哈希一致性由命令参数侧校验，本函数只锁脚本哈希 + 状态）。 */
export interface RunResumeCheckInput { // oe-exempt:20261031:framework:执行域跨包协议契约（shared 单源 ports 层，实现随 u-m1/u-m2/u-m3 波次落地）
  status: RunStatus
  /** 当前待恢复脚本的哈希。 */
  scriptHash: string
  /** RunCreated 记录的脚本哈希（权威）。 */
  recordedScriptHash: string
}

export type RunResumeCheckResult =
  | { ok: true }
  | { ok: false; code: RunResumeRejectionCode }

/**
 * resume 接受条件（设计 D3）：脚本哈希一致且 run 为 interrupted，两者缺一拒绝。
 *
 * 判定顺序：先脚本哈希、后状态——哈希不一致在语义上是身份不匹配（可能与状态无关），
 * 优先返回可诊断的 `resume_script_mismatch`（设计失败路径的显式错误码）。
 */
export function checkRunResume(input: RunResumeCheckInput): RunResumeCheckResult {
  if (input.scriptHash !== input.recordedScriptHash) {
    return { ok: false, code: 'resume_script_mismatch' }
  }
  if (input.status !== 'interrupted') {
    return { ok: false, code: 'run_not_interrupted' }
  }
  return { ok: true }
}
