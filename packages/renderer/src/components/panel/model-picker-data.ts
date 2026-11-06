/**
 * model-picker-data —— 模型选择列表的数据范围（ModelSelectPopover 与 ModelThinkingAggregate 共用）。
 *
 * W3a 从 ModelSelectPopover 提取（深模块纪律：禁止两处复制）：裸 id 拆分 / provider 分组 +
 * enabled 过滤 / ModelPickerPanel 分组形状 / 选中反查 providerId 四件逻辑收敛于此。
 * 语义不得漂移——特别是「反查失败静默忽略」的兜底（渲染与点击之间列表被刷新时，
 * 不发伪造 provider 的 select，见 resolveProviderId 的消费方注释）。
 *
 * 零 vue 组件依赖：纯函数 + settingsStore 订阅（分组形状为结构化类型，与 ModelPickerPanel
 * 的 ModelPickerGroup 结构兼容，不从 .vue import 类型）。M3 命中端点展示（U6 完成）追加
 * routeView 只读缓存订阅（拉取 + 失效广播重拉，模块级单例——与 settingsStore 常驻订阅同型，
 * renderer 生命周期持有）+ evaluateRouteAt 此刻求值（@taiji/ui 纯函数，UI 预览半边与
 * pi 扩展求值语义对齐由同源坐标契约守护）；拉取失败 = 投影缺席（行标注零 DOM，不阻塞选择器）。
 */
import { computed, ref, toValue } from 'vue'
import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import { getSettingsStore } from '@taiji/core'
import type { AggregationRouteCard, ModelInfo, ProviderId } from '@taiji/shared'
import { evaluateRouteAt, nowFromClock } from '@taiji/ui/features/settings'
import { config } from '@/api'

/** provider 分组（providerId 用于选中反查，provider 名仅用于分组标题显示） */
export interface ModelGroup {
  providerId: ProviderId
  provider: string
  /**
   * 模型路由组标记（U6/D4 ①）：true = 聚合 provider 的路由条目组——面板按本标记把
   * 分组标题接到 i18n 定稿键（数据侧 providerName 是 runtime 固定中文）并在行尾渲染
   * 路由徽标。判别消费 ModelInfo.aggregation 标记字段（u-foundation 契约），禁止按
   * providerId 字面值自行推断（判别单点 = shared isAggregationModelRef）。
   */
  aggregation?: boolean
  models: ModelInfo[]
}

/** ModelPickerPanel 分组形状（provider 名 + {id,name} 列表；providerId 随组下行——
 *  点击事件的 provider 归属单点，反查函数只作无 providerId 组的兜底） */
export interface PickerGroupRef {
  provider: string
  providerId: ProviderId
  /** 模型路由组标记（透传 ModelGroup.aggregation——面板组标题 i18n 与行尾徽标的判别键） */
  aggregation?: boolean
  models: { id: string; name?: string; hitEndpoint?: string | null }[]
}

// ── 路由视图只读缓存（M3 命中端点展示的数据源；模块级单例，拉取 + 失效广播重拉） ──

/** routeId → 路由卡（空 map = 未拉取/失败——行标注缺席，不阻塞选择器）。
 *  声明处注解 = data-source-registry.md 主表 #94（routes join 视图只读镜像缓存）。 */
// @data-owner #94
const routeCardsById = ref(new Map<string, AggregationRouteCard>())
/** 首拉 + 订阅只发生一次（多消费方共享同一缓存，不重复拉取）。 */
let routeViewWired = false

function ensureRouteCards(): void {
  if (routeViewWired) return
  routeViewWired = true
  const refresh = (): void => {
    config
      .getRouteView()
      .then((view) => {
        routeCardsById.value = new Map(view.cards.map((c) => [c.route.id, c]))
      })
      .catch(() => {
        // 拉取失败维持上次/空映射：命中端点标注整体缺席（零 DOM），选择器主功能不受影响
      })
  }
  refresh()
  // 保存/删除后的失效广播 → 重拉（last-value 全量下发同协议；订阅随 renderer 生命周期持有）
  config.onRouteView(refresh)
}

/**
 * 拆出裸 modelId：selected 可能是 "provider/modelId" 复合串
 * （live-state 状态层 / config.defaults.defaultModel / composer 暂存值均可能为此格式），
 * 但 ModelInfo.id 是裸 modelId。匹配列表项时取 `/` 后段。
 */
export function bareModelId(v: string): string {
  const i = v.lastIndexOf('/')
  return i >= 0 ? v.slice(i + 1) : v
}

/**
 * 按 provider 分组（搜索过滤与空态判定在 ModelPickerPanel 内）。空分组不渲染。
 * 同时过滤 enabled===false 的 model：runtime aggregateModels 已过滤一遍，
 * 但 settingsStore.models 与 providers 同源广播，若某次广播未过滤则会泄漏禁用模型到切换器，
 * 故前端兜底再过滤一次（双保险）。
 * providerFilter 限定展示的 provider（ProviderPage 默认 pill 传 [p.id]；聚合页不传 = 全量）。
 */
function buildModelGroups(
  models: readonly ModelInfo[],
  providerFilter?: readonly ProviderId[],
): ModelGroup[] {
  const map = new Map<string, ModelGroup>()
  for (const m of models) {
    if (m.enabled === false) continue
    if (providerFilter && !providerFilter.includes(m.providerId)) continue
    const key = m.providerId
    let g = map.get(key)
    if (!g) {
      g = { providerId: key, provider: m.providerName, aggregation: m.aggregation === true, models: [] }
      map.set(key, g)
    }
    g.models.push(m)
  }
  return [...map.values()]
}

/** ModelPickerPanel 分组形状映射（providerId 随组下行——同 short-id 多 provider 时
 *  点击归属以被点行的组为准，不再按裸 id 全局反查首中，D3 顺带发现 7 歧义修复） */
function toPickerGroups(groups: readonly ModelGroup[]): PickerGroupRef[] {
  return groups.map((g) => ({
    provider: g.provider,
    providerId: g.providerId,
    ...(g.aggregation ? { aggregation: true } : {}),
    models: g.models.map((m) => ({ id: m.id, name: m.name })),
  }))
}

/**
 * 路由行此刻命中端点投影（M3 命中端点展示，U6 完成）：对路由定义按当前坐标求值一次
 *（groups 重算时点求值——广播/挂载驱动的事件式刷新，无周期重算，ADR-0190）。命中端点
 * 展示名 = provider 名（GL2：端点真实 id 只在配置与消息记录可见，选择器显示名）；路由
 * 定义在但条件全不满足 = null（行显「此刻无命中」）；非路由行 / 路由视图未到位 = 缺省
 *（标注缺席）。
 *
 * 路由视图缓存懒拉（不预拉语义，对齐分区首访 U10）：仅当候选里出现路由条目（聚合组）
 * 才触发首拉——零配置 / 未配路由环境零请求（V8 零行为形态）；拉取失败 = 标注整体缺席。
 */
function withHitEndpoints(groups: readonly PickerGroupRef[], providerNames: ReadonlyMap<string, string>): PickerGroupRef[] {
  if (groups.some((g) => g.aggregation)) ensureRouteCards()
  if (routeCardsById.value.size === 0) return [...groups]
  const now = nowFromClock(new Date())
  return groups.map((g) => {
    if (!g.aggregation) return g
    return {
      ...g,
      models: g.models.map((m) => {
        const card = routeCardsById.value.get(m.id)
        if (!card) return m
        const result = evaluateRouteAt(card.route, now)
        if (result.hit === null) return { ...m, hitEndpoint: null }
        const hit = result.hit
        return { ...m, hitEndpoint: providerNames.get(hit.providerId) ?? hit.providerId }
      }),
    }
  })
}

/**
 * 裸 modelId → providerId 反查。渲染与点击之间 groups 被刷新（模型禁用/移除、
 * providerFilter 变化）时返回 undefined——消费方必须静默忽略该次选择，
 * 不得伪造空串 provider（会穿品牌类型，下游拼出 `/modelId` 畸形复合 id）。
 */
export function resolveProviderIdFromGroups(
  groups: readonly ModelGroup[],
  modelId: string,
): ProviderId | undefined {
  return groups.find((g) => g.models.some((m) => m.id === modelId))?.providerId
}

/**
 * 选中 ref 的显示词汇归一（模型段大小写）。run 级展示链的盖章值源自引擎原生 ref
 * （runtime 详情增强已按 manifest 逆表把 provider 段翻回 pi 词汇，模型段保留引擎
 * 目录拼写——两世界拼写差，如 zcode 目录 `GLM-5.3-Flash` vs pi 行 id
 * `glm-5.3-flash`），而选择器的行匹配是 providerId + id 精确等值。本函数按
 * providerId 圈定行集、模型段大小写不敏感命中后回写 pi 行原生 id；未命中
 * （provider 不在清单 / 模型段无匹配 / 裸 id 不分段）原样返回——不伪造匹配。
 * 已是 pi 行原生拼写的输入（热切回执 / 覆盖意图 / composer 会话模型）恒等返回，
 * 消费方统一套用无副作用。
 */
export function canonicalizeModelRef(ref: string, models: readonly ModelInfo[]): string {
  const i = ref.lastIndexOf('/')
  if (i <= 0) return ref
  const providerId = ref.slice(0, i)
  const modelId = ref.slice(i + 1)
  const row = models.find(
    (m) => m.providerId === providerId && m.id.toLowerCase() === modelId.toLowerCase(),
  )
  return row === undefined ? ref : `${providerId}/${row.id}`
}

/**
 * 数据范围 composable：settingsStore.models 常驻订阅读取（init 在 AppShell 根注册，
 * 不随组件卸载断开——旧实现组件内 onMounted 订阅会错过 sendInitialState 一次性推送，
 * 2026-07-01 竞态修复的现形态）。
 *
 * @param providerFilter 限定展示的 provider 分组（响应式取值；undefined = 全量）
 */
export function useModelPickerData(
  providerFilter?: MaybeRefOrGetter<ProviderId[] | undefined>,
): {
  /** 过滤 providerFilter + enabled 的全量候选（未做搜索过滤，供 panel 区分空态） */
    groups: ComputedRef<ModelGroup[]>
    /** 模型池是否非空（enabled 过滤 + providerFilter 限定），空态区分依据 */
    hasAnyModel: ComputedRef<boolean>
    /** ModelPickerPanel 分组形状（providerId 随组） */
    pickerGroups: ComputedRef<PickerGroupRef[]>
    /** 全局默认模型（config.defaults.defaultModel，"provider/modelId" 复合串；空串 = 未配置）。
     *  消费方透传给 ModelPickerPanel 的 defaultModel prop 驱动行尾「默认」标签（demo .pt）。 */
    defaultModel: ComputedRef<string>
    /** 裸 modelId → providerId 反查（undefined = 反查失败，消费方静默忽略）。
     *  [顺带发现 7] 同 short-id 多 provider 时反查首中不保证是被点行——主路径消费
     *  panel 事件携带的组级 providerId，本函数仅兜底无 providerId 的自建分组形态。 */
    resolveProviderId: (modelId: string) => ProviderId | undefined
} {
  const settingsStore = getSettingsStore()

  const groups = computed<ModelGroup[]>(() =>
    buildModelGroups(
      settingsStore.models.value,
      providerFilter === undefined ? undefined : toValue(providerFilter),
    ),
  )

  const resolveProviderId = (modelId: string): ProviderId | undefined =>
    resolveProviderIdFromGroups(groups.value, modelId)

  return {
    groups,
    hasAnyModel: computed(() => groups.value.length > 0),
    pickerGroups: computed(() =>
      withHitEndpoints(
        toPickerGroups(groups.value),
        new Map(settingsStore.providers.value.map((p) => [p.id, p.name])),
      ),
    ),
    defaultModel: computed(() => settingsStore.defaultModel.value),
    resolveProviderId,
  }
}
