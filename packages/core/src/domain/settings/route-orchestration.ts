/**
 * 模型路由页编排 deep module（provider-aggregation U9，设计 D10/D11）。
 *
 * 两权威分层（D10）：scopedModels 是可选性与顺序的正交权威（字段与全部读点零改动），
 * routes 是端点与条件的唯一权威；模型路由页是 runtime 对两者聚合计算的视图（非权威）。
 * 本模块承载视图编排与保存编排的纯逻辑半边（join 视图组装、路由页卡片派生、跨两权威
 * 保存顺序与失败恢复、删除精确清理、默认编排决策），IO 半边（extras store 读写、wire
 * reply/广播）在 runtime aggregation-message-handler；transport 通道在
 * @taiji/core api/domains/config 的 aggregation 档（aggregation.getRouteView/saveRoute/
 * deleteRoute 三 RPC + routeView 失效广播）。
 *
 * 消费方：runtime handler（buildAggregationRouteView / scopedModelsWithRouteRemoved /
 * resolveDefaultSyncAfterScopedWrite——wire 侧装配）、路由页 UI（U5b：buildRoutePageCards
 * + createRouteSaveOrchestrator）。测试入口 = 本模块导出函数（A10 双权威编排单测）。
 */
import type {
  AggregationMemberIssue,
  AggregationRoute,
  AggregationRouteCard,
  AggregationRouteDeleted,
  AggregationRouteSaved,
  AggregationRouteView,
  ProviderInfo,
} from '@taiji/shared'
import {
  aggregationRouteIdFromRef,
  buildAggregationModelRef,
} from '@taiji/shared'

// ── join 视图（wire 载荷组装：aggregation.getRouteView 的 reply 与 routeView 广播共用） ──

/** buildAggregationRouteView 的输入（= runtime readAggregationRoutes 读取结果的投影）。 */
export interface AggregationRouteViewInput { // oe-exempt:20261106:framework:ports 契约，单实现为设计终态
  /** routes 域全集（键缺失 / 文件不存在 / 损坏被隔离 = 空数组）。 */
  routes: readonly AggregationRoute[]
  /** 顶层 scopedModels 全量原样（sanitize 后）。 */
  scopedModels: readonly string[]
  /** 悬空端点标记全集（annotateDanglingMembers 输出；本函数按 routeId 分组进卡）。 */
  memberIssues: readonly AggregationMemberIssue[]
  /** scopedModels 中解析不到 routes 定义的失效引用（collectOrphanAggregationRefs 输出）。 */
  orphanRefs: readonly string[]
  /** extras 文件（或 routes 段）损坏被隔离（设置页「路由配置已隔离」呈报开关）。 */
  corrupted?: boolean
  /** 被隔离的坏文件路径（corrupted=true 且隔离 rename 成功时有值）。 */
  corruptedFilePath?: string
}

/**
 * 组装路由页 join 视图（D10）：
 * - 卡片集合 = routes 定义的模型全集（含 scopedModels 未参与的条目——卡片开关关的
 *   「未参与选择」态，加入后即出现在选择器）；scopedModels 中的物理模型条目不经本 wire
 *   下发（前端经既有 settingsStore.scopedModels 通道持有，路由页卡片派生见
 *   buildRoutePageCards）。
 * - 卡片顺序 = scopedModels 序在前（按 scopedIndex 升序交错）、未参与路由卡跟后
 *   （routes 数组序）——与选择器顺序同轴（V9）。
 * - 孤儿引用不生成卡（只进 orphanRefs 提示条，下一次保存清理）。
 */
export function buildAggregationRouteView(input: AggregationRouteViewInput): AggregationRouteView {
  const { routes, scopedModels } = input
  const scopedIndexOf = new Map<string, number>()
  scopedModels.forEach((ref, index) => scopedIndexOf.set(ref, index))
  const issuesByRoute = new Map<string, AggregationMemberIssue[]>()
  for (const issue of input.memberIssues) {
    const bucket = issuesByRoute.get(issue.routeId)
    if (bucket) bucket.push(issue)
    else issuesByRoute.set(issue.routeId, [issue])
  }
  const cards: AggregationRouteCard[] = routes.map((route) => {
    const ref = buildAggregationModelRef(route.id)
    const scopedIndex = scopedIndexOf.get(ref)
    return {
      route,
      scoped: scopedIndex !== undefined,
      scopedIndex: scopedIndex ?? -1,
      memberIssues: issuesByRoute.get(route.id) ?? [],
    }
  })
  const ordered = [
    ...cards.filter(c => c.scoped).sort((a, b) => a.scopedIndex - b.scopedIndex),
    ...cards.filter(c => !c.scoped),
  ]
  return {
    cards: ordered,
    // 孤儿引用原样透传（collectOrphanAggregationRefs 已保证 = 解析不到 routes 定义的聚合引用）。
    orphanRefs: [...input.orphanRefs],
    ...(input.corrupted ? { corrupted: true } : {}),
    ...(input.corrupted && input.corruptedFilePath !== undefined ? { corruptedFilePath: input.corruptedFilePath } : {}),
  }
}

// ── 路由页卡片派生（两页一份数据的视图半边；U5b 消费，退役 useScopedModels 的派生逻辑归位） ──

/** 渠道直连卡：scopedModels 中非路由引用的物理模型条目（无 routes 定义——现有渠道直连形态）。 */
export interface RouteDirectCard { // oe-exempt:20261106:framework:ports 契约，单实现为设计终态
  kind: 'direct'
  /** 模型复合串 `provider/modelId`（scopedModels 条目原值）。 */
  ref: string
  providerId: string
  modelId: string
  /** 渲染元数据（provider 不在当前目录时 missing=true，名称降级回 id）。 */
  providerName: string
  modelName: string
  apiKeySet: boolean
  missing: boolean
}

/** 路由卡（wire 视图卡片原样携带）。 */
export interface RouteDefinitionCard { // oe-exempt:20261106:framework:ports 契约，单实现为设计终态
  kind: 'route'
  card: AggregationRouteCard
}

/** 路由页卡片（直连形态 ∪ 路由形态，scopedModels 序交错）。 */
export type RoutePageCard = RouteDirectCard | RouteDefinitionCard

/** buildRoutePageCards 的目录元数据输入（ProviderInfo 的消费子集）。 */
export type RoutePageProviderIndex = ReadonlyArray<Pick<ProviderInfo, 'id' | 'name' | 'models' | 'apiKeySet'>>

/**
 * 路由页完整卡片列表（D10「卡片集合 = scopedModels 条目 ∪ routes 定义的模型」的视图半边）：
 * - 主轴 = scopedModels 数组序：路由卡（聚合引用且解析到 routes 定义）与渠道直连卡按各自
 *   在 scopedModels 中的位置交错——卡片顺序 = 选择器顺序（V9）。
 * - 无 routes 的白名单物理模型 → 渠道直连卡（渲染元数据由 providers 派生；provider 已删 /
 *   模型已移除时 missing=true，原值保留）。
 * - 未参与路由卡（routes 定义但不在 scopedModels——卡片开关关）跟在 scoped 段之后。
 * - 孤儿引用（orphanRefs）不生成卡——失效引用提示条数据直接取 view.orphanRefs。
 */
export function buildRoutePageCards(
  view: AggregationRouteView,
  scopedModels: readonly string[],
  providers: RoutePageProviderIndex,
): RoutePageCard[] {
  const cardByRouteId = new Map(view.cards.map(c => [c.route.id, c]))
  // key 放宽为 string：scopedModels 条目拆出的 provider 段是裸 string，而 ProviderInfo.id
  // 是 ProviderId branded string——Map key 用宽类型，构造侧 branded 值直接放入。
  const providerById = new Map<string, RoutePageProviderIndex[number]>(providers.map(p => [p.id, p]))
  const usedRouteIds = new Set<string>()
  const scopedCards: RoutePageCard[] = []
  for (const ref of scopedModels) {
    const routeId = aggregationRouteIdFromRef(ref)
    const routeCard = routeId !== undefined ? cardByRouteId.get(routeId) : undefined
    if (routeCard) {
      usedRouteIds.add(routeCard.route.id)
      scopedCards.push({ kind: 'route', card: routeCard })
      continue
    }
    if (routeId !== undefined) continue // 孤儿引用：不生成卡（view.orphanRefs 提示条承载）
    // 渠道直连卡：物理模型复合串的渲染元数据派生（原 useScopedModels.scopedRenderItems 逻辑归位）
    const slashIdx = ref.indexOf('/')
    const providerId = slashIdx === -1 ? ref : ref.substring(0, slashIdx)
    const modelId = slashIdx === -1 ? '' : ref.substring(slashIdx + 1)
    const provider = providerById.get(providerId)
    const model = provider?.models.find(m => m.id === modelId)
    scopedCards.push({
      kind: 'direct',
      ref,
      providerId,
      modelId,
      providerName: provider?.name ?? providerId,
      modelName: model?.name ?? modelId,
      apiKeySet: provider?.apiKeySet ?? true,
      missing: !provider || !model,
    })
  }
  const unscopedCards: RoutePageCard[] = view.cards
    .filter(c => !c.scoped && !usedRouteIds.has(c.route.id))
    .map(c => ({ kind: 'route' as const, card: c }))
  return [...scopedCards, ...unscopedCards]
}

// ── 保存编排（一次保存跨两权威的写入顺序与失败恢复，D10/U9 检查点） ──────────────────

/** 路由页编排 transport port（形状与 api/domains/config 的 aggregation 档 + 既有 setScopedModels 对齐）。 */
export interface RouteOrchestrationPorts { // oe-exempt:20261106:framework:ports 契约，单实现为设计终态
  /** 拉取 join 视图（aggregation.getRouteView）。 */
  getRouteView(): Promise<AggregationRouteView>
  /** routes 权威写入（aggregation.saveRoute；校验拒绝/写盘失败 reject）。 */
  saveRoute(route: AggregationRoute): Promise<AggregationRouteSaved>
  /** 路由删除（aggregation.deleteRoute；runtime 侧双写编排：routes 删除 + scopedModels 精确清理 + 默认编排）。 */
  deleteRoute(routeId: string): Promise<AggregationRouteDeleted>
  /** scopedModels 权威写入（config.setScopedModels 既有通道，含 default 同步编排）。 */
  setScopedModels(models: string[]): Promise<string[]>
}

/** 一次保存的写入意图（两权威按字段区分：route = routes 权威写；scopedModels = 白名单权威写）。 */
export interface RouteSaveIntent { // oe-exempt:20261106:framework:ports 契约，单实现为设计终态
  /** 待保存路由定义（路由卡编辑保存时提供；纯排序/开关保存省略）。 */
  route?: AggregationRoute
  /**
   * routes 回滚基准：该路由保存前的磁盘态。AggregationRoute = 编辑语义（scopedModels 写
   * 失败时 saveRoute 回滚到旧值）；null = 新建语义（回滚 = deleteRoute 撤销刚建条目）；
   * 省略 = 无 routes 写（无需回滚）。
   */
  priorRoute?: AggregationRoute | null
  /** scopedModels 全量目标态（排序/开关变化时提供；与既有通道同形——全量覆写、去重保序）。 */
  scopedModels?: string[]
}

/** 保存结果：成功回执（两权威各自写了什么；未写的权威为 null）。 */
export type RouteSaveSuccess = {
  ok: true
  saved: AggregationRouteSaved | null
  scopedModels: string[] | null
}

/**
 * 保存失败分型（失败恢复语义的显式化，不静默吞）：
 * - 'routes'          ：routes 写失败（校验拒绝/写盘失败）——scopedModels 未动，两权威一致。
 * - 'scoped'          ：scopedModels 写失败且本次无 routes 写——两权威一致。
 * - 'scoped-rolled-back'      ：scopedModels 写失败，routes 写已回滚复原——两权威一致（保存整体失败）。
 * - 'scoped-rollback-failed'  ：scopedModels 写失败且 routes 回滚也失败——残留态（routes 新值
 *    已落盘、白名单未跟上）：读取侧 join 视图照常呈现（新路由卡 / 孤儿引用标记），UI 必须显式
 *    呈报「路由定义已保存但白名单未同步，请重试」，禁止静默。
 */
export type RouteSaveFailure = {
  ok: false
  stage: 'routes' | 'scoped' | 'scoped-rolled-back' | 'scoped-rollback-failed'
  /** 触发失败的动作抛错（UI 归因文案输入）。 */
  error: unknown
  /** stage='scoped-rollback-failed' 时：回滚动作自身的抛错。 */
  rollbackError?: unknown
}

export type RouteSaveOutcome = RouteSaveSuccess | RouteSaveFailure

/**
 * 保存编排器（U9 检查点「一次保存跨两权威的写入顺序与失败恢复」）：
 * 写入顺序 = routes 先、scopedModels 后（routes 是本次保存的主语义，scopedModels 失败时
 * 对已写 routes 做回滚；反序则回滚对象是白名单——白名单是既有安全边界，回滚它等于拿
 * 既有权威陪葬，不采用）。scopedModels 写走既有 config.setScopedModels 通道（default
 * 同步编排内建于该通道）。
 */
export function createRouteSaveOrchestrator(ports: RouteOrchestrationPorts): {
  save(intent: RouteSaveIntent): Promise<RouteSaveOutcome>
  delete(routeId: string): Promise<AggregationRouteDeleted>
} {
  return {
    async save(intent: RouteSaveIntent): Promise<RouteSaveOutcome> {
      const hasRouteWrite = intent.route !== undefined
      const hasScopedWrite = intent.scopedModels !== undefined
      if (!hasRouteWrite && !hasScopedWrite) {
        // 空意图 = 调用方编排错误（保存按钮在无变化时不应可点），fail-fast 显式拒绝。
        return { ok: false, stage: 'routes', error: new Error('route save intent is empty') }
      }
      let saved: AggregationRouteSaved | null = null
      if (hasRouteWrite) {
        try {
          saved = await ports.saveRoute(intent.route!)
        } catch (error) {
          return { ok: false, stage: 'routes', error }
        }
      }
      if (!hasScopedWrite) return { ok: true, saved, scopedModels: null }
      try {
        const scopedModels = await ports.setScopedModels(intent.scopedModels!)
        return { ok: true, saved, scopedModels }
      } catch (error) {
        // scopedModels 写失败 → 按回滚基准恢复 routes 权威（两权威一致性优先于部分成功）。
        if (!hasRouteWrite) return { ok: false, stage: 'scoped', error }
        const prior = intent.priorRoute
        try {
          if (prior === undefined) {
            // 不可达：hasRouteWrite 时 priorRoute 必然提供（编辑/新建二选一）——防御分支
            // 兜同新建语义（撤销刚建条目），并把契约缺口暴露给调用方。
            await ports.deleteRoute(intent.route!.id)
          } else if (prior === null) {
            await ports.deleteRoute(intent.route!.id)
          } else {
            await ports.saveRoute(prior)
          }
          return { ok: false, stage: 'scoped-rolled-back', error }
        } catch (rollbackError) {
          return { ok: false, stage: 'scoped-rollback-failed', error, rollbackError }
        }
      }
    },
    delete(routeId: string): Promise<AggregationRouteDeleted> {
      // 删除的双写编排（routes 删除 + scopedModels 精确清理 + 默认编排 + 失败恢复）内建于
      // runtime aggregation.deleteRoute；core 侧只透传。
      return ports.deleteRoute(routeId)
    },
  }
}

// ── 删除精确清理 + 默认编排决策（runtime deleteRoute 编排的纯逻辑半边） ────────────────

/**
 * scopedModels 的路由条目精确清理（删除路由的同一保存内执行）。
 *
 * 只移除 `<聚合providerId>/<routeId>` 本身的全部出现——不按 provider 前缀清理
 * （cleanScopedModelsResidue 形态不可用：同一聚合 provider 承载全部路由，前缀清理会误删
 * 全部路由条目，D9/U9 检查点）。物理模型条目与其他路由条目原样保留、顺序不变。
 */
export function scopedModelsWithRouteRemoved(scopedModels: readonly string[], routeId: string): string[] {
  const target = buildAggregationModelRef(routeId)
  return scopedModels.filter(ref => ref !== target)
}

/** resolveDefaultSyncAfterScopedWrite 的决策目标（default 编排的写侧输入）。 */
export interface DefaultSyncTarget { // oe-exempt:20261106:framework:ports 契约，单实现为设计终态
  /** scopedModels 新首位（复合串原值）。 */
  ref: string
  provider: string
  modelId: string
}

/**
 * scopedModels 写入后的默认编排决策（与 config.setScopedModels 既有编排 syncDefaultToScopedModels
 * 同语义——删除路由/路由页排序使 scopedModels[0] 变化时，新第一位即全局默认）：
 * - scopedModels 空 → null（保留现有 default；删空时由 findValidDefaultModel 既有 auto-fix
 *   回退首个可用模型，landing fallback 不指向已删路由）。
 * - 新首位 provider 不在当前目录或已禁用 → null（跳过同步保留现有 default——写成不可用
 *   默认会被 getDefaultModel auto-fix 冲掉，静默破坏「第一位即默认」）。
 * - 新首位为路由引用（provider 段 = 聚合保留 id）时在 provider 级之上补路由级判定：
 *   routeId 在 routes 域存在且 enabled 才返回目标，否则 null（停用/悬空路由写成 default
 *   会被 getDefaultModel 聚合分支按同一维度判不可用并 auto-fix 冲掉——判定维度对齐
 *   读取侧 findValidDefaultModel；扩展禁用维度由读取侧组合根判定承载，本纯函数不持）。
 * - 否则返回写侧目标（handler 再对比 currentDefault：相同则幂等跳过写，仍视为已同步）。
 */
export function resolveDefaultSyncAfterScopedWrite(
  scopedModels: readonly string[],
  providers: ReadonlyArray<Pick<ProviderInfo, 'id' | 'enabled'>>,
  routes: readonly AggregationRoute[],
): DefaultSyncTarget | null {
  if (scopedModels.length === 0) return null
  const ref = scopedModels[0]!
  const slashIdx = ref.indexOf('/')
  if (slashIdx <= 0) return null
  const provider = ref.substring(0, slashIdx)
  const modelId = ref.substring(slashIdx + 1)
  const info = providers.find(p => p.id === provider)
  if (!info || info.enabled === false) return null
  const routeId = aggregationRouteIdFromRef(ref)
  if (routeId !== undefined) {
    const route = routes.find(r => r.id === routeId)
    if (!route || !route.enabled) return null
  }
  return { ref, provider, modelId }
}

// ── 复合串形态兼容（U9 检查点：路由条目复合串与既有 isModelRef 校验兼容） ──────────────
// 兼容性由结构保证：聚合保留 id 与 routeId（isValidRouteId：非空 kebab-case）均不含 '/'，
// `<聚合providerId>/<routeId>` 恒满足 isModelRef 的「provider 与 id 段都非空」契约——
// isModelRef 的真实执行点在 runtime config.setScopedModels 入口（model-message-handler
// 格式校验），本模块不重复实现该谓词；A10 测试以同语义断言锁定该兼容性。
