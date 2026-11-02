/**
 * smart-context 配置域（pi-smart-context extension 的 runtime 侧配置范围）。
 *
 * 从 worktree-config-helper.ts 抽出（P1-7 名实拆分：原文件名只对应 worktree 偏好域，
 * 本域与其落盘路径/契约对象均不同）。读改写
 * ${PI_CODING_AGENT_DIR}/config/smart-context-ext-config.json（与 pi-smart-context
 * extension 的 llm-shared getConfigPath('smart-context') 路径契约对齐）。RMW / 锁协议
 * 走共享基建 ext-config-rmw.ts（与 setRenameModel 逐字同一实现——该文件同样被 runtime
 * 与 extension 双方 RMW）。
 *
 * 与 extension 配置的两层关系（dmg-r2-3 登记，勿再混为一谈）：
 * - 落盘默认基底 = extension DEFAULT_SMART_CONTEXT_CONFIG 的**全字段**镜像（机器对拍锁定）；
 * - GUI 快照 = 其中 5 个 GUI 可编辑字段的扁平视图（C3 独立压缩设置页起 ratio 入快照，
 *   见接口注）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPiAgentDir } from '../infra/pi/pi-paths.js'
import { extractRefString, rmwExtConfigField } from './ext-config-rmw.js'

/**
 * GUI 侧的 smart-context 配置快照（extension 侧 SmartContextConfig 的扁平视图：
 * compactModel 折叠为 "provider/modelId" 复合串，空串 = 未设置/跟随当前会话模型）。
 *
 * 射程沿革（dmg-r2-3 登记 → C3 独立压缩设置页修订）：dmg-r2-3 时本快照只含 4 个
 * GUI 可编辑字段，autoCompactThresholdRatio 因无控件刻意不进快照；C3 起设置页新增
 * 触发阈值控件，该字段按其预登记义务入快照并同步 packages/shared 的
 * config.smartContextConfig reply 契约（shared 协议已同步，无协议外字段）。字段生效
 * 侧仍在 extension（后台自动压缩触发线，ADR-0182 D4，compact-handler.ts 读时刷新），
 * runtime 无消费方、只经 RMW 落盘。
 */
export interface SmartContextConfigSnapshot {
  enabled: boolean
  /** 压缩模型 ref（"provider/modelId"，空串 = 未设置）。 */
  compactModel: string
  /** 3 档提醒阈值（token 绝对数，升序）。 */
  reminderThresholds: number[]
  /** 排除模型列表（完整 provider/modelId 精准匹配）。 */
  excludedModels: string[]
  /** 后台压缩触发线（上下文占窗口比例 0-1，达到即触发；非有限数回默认 0.9）。 */
  autoCompactThresholdRatio: number
}

/** 配置文件相对路径（与 pi-smart-context 的 llm-shared getConfigPath('smart-context') 契约一致）。 */
const SMART_CONTEXT_CONFIG_REL = join('config', 'smart-context-ext-config.json')

/** 3 档提醒阈值默认值工厂（token 绝对数，与 extension 的 DEFAULT_REMINDER_THRESHOLDS 一致）。 */
function defaultThresholds(): number[] {
  // eslint-disable-next-line no-magic-numbers -- 400K/500K/600K 是与 pi-smart-context extension 契约对齐的默认档位
  return [400_000, 500_000, 600_000]
}

/** 提醒阈值最大档数（与 extension 的 MAX_THRESHOLD_TIERS 一致）。 */
const SMART_CONTEXT_MAX_THRESHOLD_TIERS = 3

/**
 * 后台压缩触发线默认值（窗口 90%，与 extension 的 DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO
 * 一致：extensions/universal/smart-context/src/pure.ts:32；ADR-0182 D4）。
 * 进落盘默认基底与 GUI 快照（C3 起 GUI 有触发阈值控件，快照射程见 SmartContextConfigSnapshot 接口注）。
 */
const SMART_CONTEXT_DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO = 0.9

/**
 * 落盘默认基底工厂（文件缺失/损坏时用，与 extension 的 DEFAULT_SMART_CONTEXT_CONFIG
 * **全字段**一致：extensions/universal/smart-context/src/pure.ts:50）——含
 * autoCompactThresholdRatio（C3 起 GUI 快照同样含它，见 SmartContextConfigSnapshot 接口注）。
 * 工厂形态保证每次全新对象/数组，各 RMW 写点不共享嵌套引用。
 *
 * 全字段一致性由 src/services/__tests__/smart-context-config-default-parity.test.ts
 * 机器对拍锁定（import extension 侧 pure.ts 源码叶子逐字段深相等）：extension 将来加
 * 字段而本基底没跟上时该测试红灯，防再次单侧漂移。
 */
function smartContextDefaultBase(): Record<string, unknown> {
  return {
    enabled: true,
    compactModel: { type: 'ref', ref: '' },
    reminderThresholds: defaultThresholds(),
    excludedModels: [],
    autoCompactThresholdRatio: SMART_CONTEXT_DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO,
  }
}

/** smart-context 配置文件完整路径（${PI_CODING_AGENT_DIR}/config/smart-context-ext-config.json）。 */
function getSmartContextConfigPath(): string {
  return join(getPiAgentDir(), SMART_CONTEXT_CONFIG_REL)
}

/**
 * 阈值归一（与 extension normalizeSmartContextConfig 同款纪律）：过滤非正数/非有限数
 * → 升序 → 截 3 档；空数组回退默认。
 */
function normalizeThresholds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return defaultThresholds()
  const thresholds = [...raw]
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b)
    .slice(0, SMART_CONTEXT_MAX_THRESHOLD_TIERS)
  return thresholds.length > 0 ? thresholds : defaultThresholds()
}

/** 排除模型归一（与 extension 同款）：过滤非字符串与不含 "/" 的条目 → 去重（保序）。 */
function normalizeExcludedModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((m): m is string => typeof m === 'string' && m.includes('/')))]
}

/** 触发线归一（与 extension normalizeSmartContextConfig 同款纪律）：非有限数回默认，有限数钳制 [0,1]。 */
function normalizeAutoCompactThresholdRatio(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return SMART_CONTEXT_DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO
  }
  return Math.min(1, Math.max(0, raw))
}

/**
 * 默认快照（GUI 可编辑五字段的默认值；落盘基底是全字段镜像，见
 * smartContextDefaultBase——两者字段集一致，形态差异只剩 compactModel 的折叠）。
 */
function smartContextDefaults(): SmartContextConfigSnapshot {
  return {
    enabled: true,
    compactModel: '',
    reminderThresholds: defaultThresholds(),
    excludedModels: [],
    autoCompactThresholdRatio: SMART_CONTEXT_DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO,
  }
}

/**
 * 读取 smart-context 配置快照。文件不存在/坏 JSON/字段非法 → 默认值
 * （与 extension normalizeSmartContextConfig 的回退语义一致）。不抛错（容错处理，与 getRenameModel 一致）。
 */
export function getSmartContextConfig(): SmartContextConfigSnapshot {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getSmartContextConfigPath(), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return smartContextDefaults()
    }
    const r = parsed as Record<string, unknown>
    return {
      enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : true,
      compactModel: extractRefString(r, 'compactModel'),
      reminderThresholds: normalizeThresholds(r['reminderThresholds']),
      excludedModels: normalizeExcludedModels(r['excludedModels']),
      autoCompactThresholdRatio: normalizeAutoCompactThresholdRatio(r['autoCompactThresholdRatio']),
    }
  } catch {
    return smartContextDefaults()
  }
}

/** RMW 只覆盖指定字段（锁协议走共享 rmwExtConfigField，与 setRenameModel 结构性对齐）。 */
function writeSmartContextField(apply: (base: Record<string, unknown>) => void): void {
  rmwExtConfigField(getSmartContextConfigPath(), {}, smartContextDefaultBase, apply)
}

/** 设置智能上下文压缩开关（只覆盖 enabled 字段，保留其他字段）。 */
export function setSmartContextEnabled(enabled: boolean): void {
  writeSmartContextField((base) => {
    base['enabled'] = enabled
  })
}

/**
 * 设置压缩模型（只覆盖 compactModel 字段）。空串 = 跟随当前会话模型（same-model 模式）；
 * 非空但不含 "/" 归一为空串（extension pickMode 只认 ref 串，无 "/" 的 ref 等于未设置，不如归一）。
 */
export function setSmartContextCompactModel(model: string): void {
  const normalized = model.includes('/') ? model : ''
  writeSmartContextField((base) => {
    base['compactModel'] = { type: 'ref', ref: normalized }
  })
}

/** 设置 3 档提醒阈值（token 绝对数；clamp：过滤正数 → 升序 → 截 3 档，空回退默认）。 */
export function setSmartContextThresholds(thresholds: number[]): void {
  const normalized = normalizeThresholds(thresholds)
  writeSmartContextField((base) => {
    base['reminderThresholds'] = normalized
  })
}

/** 设置排除模型列表（过滤无 "/" 条目 + 去重，只覆盖 excludedModels 字段）。 */
export function setSmartContextExcludedModels(models: string[]): void {
  const normalized = normalizeExcludedModels(models)
  writeSmartContextField((base) => {
    base['excludedModels'] = normalized
  })
}

/** 设置后台压缩触发线（0-1 窗口占比；非有限数归默认 0.9、有限数钳制 [0,1]，与 extension normalize 同款）。 */
export function setSmartContextAutoCompactThresholdRatio(ratio: number): void {
  const normalized = normalizeAutoCompactThresholdRatio(ratio)
  writeSmartContextField((base) => {
    base['autoCompactThresholdRatio'] = normalized
  })
}
