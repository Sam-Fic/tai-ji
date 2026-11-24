/**
 * taiji 远程配置 — provider 模型元数据域（域 5）：远程下发/覆盖 taiji 附加段 provider 的
 * 模型清单与字段，免发版修模型元数据。
 *
 * ── 为什么需要这个域 ────────────────────────────────────────────────
 * 附加段 provider（快照 taijiExtra 标记，当前仅 opendesign）的模型清单写在构建期快照
 * （`gen-builtin-providers.mjs`）。上游模型目录按天级变化（新模型上架、思考档位调整、价格
 * 变动），而快照只能随发版更新——登记在案的代价是「配置源 commit main 即发布」这条热更新
 * 承诺在模型元数据上不成立。
 *
 * 本域把它补上：远程 JSON 按 `providerId + modelId` 下发字段补丁（省略 = 不覆盖），由
 * `provider-extra-model-sync` 合并进快照模板后投影到 models.json——**执行侧与展示侧吃同一份
 * 合并结果**（pi 的唯一加载源就是 models.json，只改 UI 等于「看着新、跑着旧」）。
 *
 * ── 与域 1（builtin-providers）的分工 ───────────────────────────────
 * 域 1 的契约是「远程 provider 清单 = 用户可添加的模板」，其写路径绑定 `remoteSource` 标记
 * 与 `setProvider` 合并语义，且对快照已存在的 id 有撞名守卫（整条丢弃）。附加段 provider
 * 恰恰**就在快照里**（isCatalogProvider 命中），走域 1 会被守卫静默丢弃，且会给 catalog
 * provider 写 `remoteSource` 误标（模型被远程清单覆盖的既有风险面被放大到全量模型）。
 * 故本域只做「已存在实例的模型字段补丁」，不创建 provider、不改 provider 级字段、不碰
 * 用户自建 provider（`isTaijiExtraProvider` 判定是唯一圈定条件）。
 *
 * ── fail-visible 纪律 ──────────────────────────────────────────────
 * guard 拒绝 = 整域拒用（不部分采纳）：坏配置的最坏后果是停留在上次可用数据，绝不产出
 * 半份元数据。所有字段严格类型校验 + 未知键拒绝（拼写错误会静默失效，必须可见）。
 * 字段值禁写 JSON null（pi models.json 可选字段 null 会拒载整个 provider）——唯一例外是
 * `thinkingLevelMap` 的内层 value（null = 该档不支持，pi 语义）。
 */
import { isRecord, isOptionalField } from '../quota-providers/types.js'
import { loadRemoteConfig } from './remote-config-fetch.js'

/** 远程域缓存名（<getDataDir()>/remote-config/provider-model-metadata.json）。 */
export const DOMAIN = 'provider-model-metadata' as const

/** 单模型字段补丁（字段全部可选：省略 = 保留快照模板值）。 */
export interface ProviderModelPatch { // oe-exempt:20261122:framework:远程配置域的数据形状（wire 契约，与 remote-provider-templates 的 RemoteProviderModel 同族）——单实现常态，非投机抽象
  id: string
  name?: string
  api?: string
  baseUrl?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  thinkingLevelMap?: Record<string, string | null>
  compat?: Record<string, unknown>
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  headers?: Record<string, string>
}

/** 单 provider 的模型补丁段。 */
export interface ProviderModelMetadataEntry { // oe-exempt:20261122:framework:同上（域 JSON 形状，guard 与合并纯函数的输入类型）
  id: string
  models: ProviderModelPatch[]
  /** 显式删除清单（只删快照来源的模型；用户本地追加的模型不在此范围）。 */
  removeModels?: string[]
}

export interface ProviderModelMetadataConfig { // oe-exempt:20261122:framework:同上（域根形状 + guard 类型收窄目标）
  version: 1
  providers: ProviderModelMetadataEntry[]
}

/** 单模型补丁的合法键集（未知键 = 拒绝，防拼写错误静默失效）。 */
const PATCH_KEYS = new Set([
  'id',
  'name',
  'api',
  'baseUrl',
  'contextWindow',
  'maxTokens',
  'reasoning',
  'input',
  'thinkingLevelMap',
  'compat',
  'cost',
  'headers',
])

const ENTRY_KEYS = new Set(['id', 'models', 'removeModels'])

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function isOptionalPositiveInt(v: unknown): boolean {
  return v === undefined || isPositiveInt(v)
}

function isOptionalInputValid(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every((s) => s === 'text' || s === 'image'))
}

/** thinkingLevelMap：Record<string, string|null>，value 允许 null（pi 档位不支持语义）。 */
function isOptionalThinkingLevelMapValid(v: unknown): boolean {
  if (v === undefined) return true
  if (!isRecord(v) || Array.isArray(v)) return false
  return Object.values(v).every((x) => x === null || typeof x === 'string')
}

/** 普通对象且非数组（compat / headers 的形状前置）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && !Array.isArray(v)
}

/**
 * cost：出现即四字段齐全且为有限非负数（pi ModelCostSchema 缺字段会拒载整个 models.json）。
 */
function isOptionalCostValid(v: unknown): boolean {
  if (v === undefined) return true
  if (!isPlainObject(v)) return false
  const keys = Object.keys(v)
  if (keys.some((k) => k !== 'input' && k !== 'output' && k !== 'cacheRead' && k !== 'cacheWrite')) return false
  return (['input', 'output', 'cacheRead', 'cacheWrite'] as const).every((k) => {
    const n = v[k]
    return typeof n === 'number' && Number.isFinite(n) && n >= 0
  })
}

function isOptionalHeadersValid(v: unknown): boolean {
  if (v === undefined) return true
  if (!isPlainObject(v)) return false
  return Object.values(v).every((x) => typeof x === 'string')
}

/** 单模型补丁校验：未知键 / 空 id / 各字段类型。 */
function isModelPatchValid(m: unknown): m is ProviderModelPatch {
  if (!isPlainObject(m)) return false
  if (!isNonEmptyString(m['id'])) return false
  if (Object.keys(m).some((k) => !PATCH_KEYS.has(k))) return false
  return (
    isOptionalField(m['name'], 'string') &&
    isOptionalField(m['api'], 'string') &&
    isOptionalField(m['baseUrl'], 'string') &&
    isOptionalPositiveInt(m['contextWindow']) &&
    isOptionalPositiveInt(m['maxTokens']) &&
    isOptionalField(m['reasoning'], 'boolean') &&
    isOptionalInputValid(m['input']) &&
    isOptionalThinkingLevelMapValid(m['thinkingLevelMap']) &&
    (m['compat'] === undefined || isPlainObject(m['compat'])) &&
    isOptionalCostValid(m['cost']) &&
    isOptionalHeadersValid(m['headers'])
  )
}

/** provider 段校验：键集 / 非空唯一 id / models 数组逐条 / removeModels 形状。 */
function isProviderEntryValid(p: unknown): p is ProviderModelMetadataEntry {
  if (!isPlainObject(p)) return false
  if (Object.keys(p).some((k) => !ENTRY_KEYS.has(k))) return false
  if (!isNonEmptyString(p['id'])) return false
  const models = p['models']
  if (!Array.isArray(models)) return false
  const seenModels = new Set<string>()
  for (const m of models) {
    if (!isModelPatchValid(m)) return false
    if (seenModels.has(m.id)) return false
    seenModels.add(m.id)
  }
  const removeModels = p['removeModels']
  if (removeModels !== undefined) {
    if (!Array.isArray(removeModels) || !removeModels.every(isNonEmptyString)) return false
  }
  return true
}

/**
 * 域级 guard（remote-config-fetch 的整域拒绝入口）。
 *
 * 未知 provider id **不**在 guard 层拒绝（见 sync 侧的跳过 + warn）：远程清单跟随 main、
 * 快照跟随发版，两者时点必然错位——某次发版删掉一个附加段 provider 而远程还留着条目时，
 * 整域拒绝会让其余 provider 一起失效。结构/字段级非法才整域拒。
 */
export function isProviderModelMetadataConfig(v: unknown): v is ProviderModelMetadataConfig {
  if (!isPlainObject(v)) return false
  if (v['version'] !== 1) return false
  const providers = v['providers']
  if (!Array.isArray(providers)) return false
  const seenProviders = new Set<string>()
  for (const p of providers) {
    if (!isProviderEntryValid(p)) return false
    if (seenProviders.has(p.id)) return false
    seenProviders.add(p.id)
  }
  return true
}

/** 读远程模型元数据域（纯缓存，不发网络；消费方的同步读侧入口）。 */
export function loadProviderModelMetadata(): ProviderModelMetadataConfig | undefined {
  return loadRemoteConfig(DOMAIN, isProviderModelMetadataConfig)
}

/** 取某 provider 的元数据段（无该 provider / 无数据 → undefined）。 */
export function getProviderMetadataEntry(
  config: ProviderModelMetadataConfig | undefined,
  providerId: string,
): ProviderModelMetadataEntry | undefined {
  return config?.providers.find((p) => p.id === providerId)
}

/**
 * 把元数据补丁合并进快照模板模型列表（纯函数）。
 *
 * - 同 id：字段级浅覆盖（patch 显式给出的键覆盖模板值；cost/compat 整对象替换——半合并
 *   会让「远程只改 output 价格」意外保留旧 input，语义比整对象替换更难预测）。
 * - 新 id：追加（远程可在不发版时上新模型）。
 * - removeModels：从结果中剔除（只影响模板来源的条目；调用方负责保留用户本地模型）。
 *
 * @returns 合并后的模型列表（顺序 = 模板顺序，新 id 追加在末尾）
 */
export function applyProviderModelMetadata(
  template: Array<Record<string, unknown>>,
  entry: ProviderModelMetadataEntry | undefined,
): Array<Record<string, unknown>> {
  if (!entry) return template
  const removed = new Set(entry.removeModels ?? [])
  const patches = new Map<string, Record<string, unknown>>(
    entry.models.map((m) => [m.id, m as unknown as Record<string, unknown>]),
  )
  const out: Array<Record<string, unknown>> = []
  for (const t of template) {
    const id = String(t['id'])
    if (removed.has(id)) continue
    const patch = patches.get(id)
    out.push(patch ? { ...t, ...patch, id } : t)
    patches.delete(id)
  }
  // 模板里没有的新 id：直接以补丁为条目追加（缺的字段交给写盘链的默认值）
  for (const extra of patches.values()) {
    if (removed.has(String(extra['id']))) continue
    out.push(extra)
  }
  return out
}
