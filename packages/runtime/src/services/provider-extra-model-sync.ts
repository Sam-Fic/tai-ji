/**
 * taiji 附加段 provider 的模型元数据同步（G-extra，L1 存量刷新半边）。
 *
 * ── 为什么需要本模块 ────────────────────────────────────────────────
 * 附加段 provider（快照 taijiExtra 标记，当前仅 opendesign）的执行可见性落在
 * models.json 实例上（pi 唯一加载源；见 provider-catalog-refresh.ts 的附加段判据段）。
 * `seedTaijiExtraInstanceModels` 只在「条目无 models」时播种一次——**用户已添加过的
 * 实例永远停在播种时的快照版本**，快照里修正的 reasoning / thinkingLevelMap / compat /
 * contextWindow / maxTokens / cost 对存量用户全部无效（pi 的 supportedLevels 由
 * models.json 条目的 reasoning+thinkingLevelMap 现算，旧值直接钳成「只有关档」）。
 *
 * 因此本模块把「快照模板 = 该 provider 模型清单的权威」这一既有约定（播种路径已如此）
 * 延伸到存量实例：每次同步按 id 合并——模板条目覆盖同 id 现场的元数据字段，用户自行
 * 追加的模型保留不动，**不删除**任何本地模型（远程/模板下线不传播，防误删在用模型）。
 * 语义与 remote-provider-sync.ts 的模型合并链逐条对齐（同一「同 id 覆盖 + 新 id 追加 +
 * 不删除本地」契约），差异仅数据源：那边是远程清单，这边是编译期快照。
 *
 * ── 触发点（不新增定时器，ADR-0190）─────────────────────────────────
 * 挂在 `ConfigService.refreshRemoteProviders()`（既有两个触发点：runtime 启动 30s 延迟
 * 单次、进设置 Provider 页），与 remote-config 各域同批执行。同步是纯读快照 + 内存比对，
 * 无变化即零写盘（noChange 早退），因此挂在设置页入口的代价可忽略。
 *
 * ── 用户改动被覆盖的代价（已登记）────────────────────────────────────
 * 模板对同 id 模型的字段覆盖**不区分**用户是否手改过。这与 remote-provider-sync 的
 * 既有已接受代价同源：附加段 provider 的模型清单本就不是用户资产（模板是权威），
 * 用户要偏离应新建自己的 provider 或追加自定义模型（追加的 id 不在模板内，永不被覆盖）。
 */
import type { IConfigStore } from './ports/config.js'
import type {
  AuthStorageAccessors,
  ProviderExtrasAccessors,
  SetProviderInput,
} from './provider-config-helper.js'
import { setProvider as setProviderImpl } from './provider-config-helper.js'
import type { CredentialWriter } from './auth/auth-storage.js'
import { isTaijiExtraProvider, getTaijiExtraTemplateModels } from './provider-catalog.js'
import {
  loadProviderModelMetadata,
  getProviderMetadataEntry,
  applyProviderModelMetadata,
} from './remote-config/remote-provider-metadata.js'

export interface ExtraModelSyncDeps { // oe-exempt:20261122:framework:与 remote-provider-sync 的 RemoteProviderSyncDeps/Result 同族依赖注入面——接口先立单实现常态（本仓架构偏好），注入面按 setProvider 形参位收窄，后续共享 provider 域同步变体时复用同形
  configStore: IConfigStore
  extrasStore?: ProviderExtrasAccessors
  authStorage?: AuthStorageAccessors
  credentialWriter?: CredentialWriter
}

export interface ExtraModelSyncResult { // oe-exempt:20261122:framework:同上（返回形状与 RemoteProviderSyncResult 对齐，调用方统一消费 updatedProviders）
  /** 实际发生了模型合并写盘的 provider id（无变化的不在列）。 */
  updatedProviders: string[]
}

/**
 * 快照模板条目 → models.json 模型条目（剥 null 键）。
 *
 * pi 的 models.json 可选字段一律不接受 null（cost/compat/thinkingLevelMap 等对象字段
 * 为 null 即拒载整个 provider）：快照模板对这些字段写 null 是「未声明」的表达，落盘
 * 形态必须是缺键。与 seedTaijiExtraInstanceModels 的剥除逻辑同源（两处共用同一语义，
 * 播种与刷新不得产出不同形态）。
 */
export function templateModelToDefinition(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(m)) {
    if (v === null) continue
    out[k] = v
  }
  return out
}

/**
 * 同步全部 taijiExtra provider 的实例模型（快照模板权威，同 id 覆盖 + 新 id 追加 +
 * 不删除本地；用户追加的自定义模型保留）。
 *
 * 只处理「models.json 里已存在该 provider 条目」的实例——**不创建新条目**（未添加的
 * provider 不出现在 pi 加载源里，凭空造条目会改变用户可见的 provider 集合）。
 * 无变化 provider 走 noChange 早退，不写盘（防 mtime 抖动触发下游广播）。
 *
 * @returns 实际发生写盘的 provider id 列表（供调用方决定是否 broadcastProviderList）
 */
export async function syncTaijiExtraProviderModels(
  deps: ExtraModelSyncDeps,
): Promise<ExtraModelSyncResult> {
  const result: ExtraModelSyncResult = { updatedProviders: [] }
  const stored = deps.configStore.readModels().providers ?? {}
  // 远程元数据域读侧（纯缓存，不触网）：域坏配置已被 guard 拒用 → undefined，退化为纯快照。
  const metadataConfig = loadProviderModelMetadata()

  for (const providerId of Object.keys(stored)) {
    if (!isTaijiExtraProvider(providerId)) continue
    // 快照模板 + 远程元数据补丁（域 5）→ 本次生效的模型清单基线。补丁层是免发版修正
    // 模型元数据的唯一通道；无远程数据时 entry=undefined，合并退化为纯快照。
    const entry = getProviderMetadataEntry(metadataConfig, providerId)
    const template = applyProviderModelMetadata(getTaijiExtraTemplateModels(providerId), entry)
      .map(templateModelToDefinition)
      // 空 id 模板条目无意义且会毒化 models.json（pi ModelDefinitionSchema minLength:1）
      .filter((m) => typeof m['id'] === 'string' && (m['id'] as string).trim() !== '')
    if (template.length === 0) continue

    const current = (stored[providerId]?.models ?? []) as unknown as Array<Record<string, unknown>>
    const currentById = new Map<string, Record<string, unknown>>(
      current.map((m) => [String(m['id']), m]),
    )
    const byId = new Map<string, Record<string, unknown>>(currentById)
    for (const t of template) byId.set(String(t['id']), t)
    const models = [...byId.values()]

    // noChange 判据与 remote-provider-sync 逐条同源：模板每条字段与现值 JSON 相等且无新 id
    // → 写后与现值一致（不能 stringify 比较「合并形态 vs 现值」，会被键序/缺键形态差污染）。
    // 不断言 current.length === template.length：用户自加的自定义模型不在模板内、也不被
    // 本同步触碰，只要模板全命中即合并结果与现值相同（长度差不代表需写盘）。
    const noChange = template.every((t) => {
      const cur = currentById.get(String(t['id']))
      if (!cur) return false // 新 id = 追加，非 no-op
      return Object.entries(t).every(
        ([k, v]) => JSON.stringify(cur[k]) === JSON.stringify(v),
      )
    })
    if (noChange) continue

    // 写路径 = setProvider 的 models 分支：复用 mergeProviderModel 的字段校验、
    // modelStates 保留、写策略链。只传 models，其余字段 undefined = 不变。
    await setProviderImpl(
      deps.configStore,
      deps.authStorage,
      deps.extrasStore,
      deps.credentialWriter,
      providerId,
      { models: models as NonNullable<SetProviderInput['models']> },
    )
    result.updatedProviders.push(providerId)
  }
  return result
}
