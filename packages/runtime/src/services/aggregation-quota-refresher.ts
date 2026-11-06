/**
 * AggregationQuotaRefresher — 额度供给编排（provider-aggregation D3/U4，M2）。
 *
 * 事件驱动的按需刷新：仅对「启用中且含额度条件端点」的路由引用的 provider 刷新，
 * QuotaService 既有节流内去重（fetchMany 全走非 force fetch——10s throttle + pending
 * 并发复用），零定时器（ADR-0190 红线：触发全部事件驱动，上游查询为外部网络调用属
 * 保留白名单①；本模块无任何周期性/延迟性时间机制——无周期循环、无延迟执行、无文件
 * 监视——刷新只发生在三个 notify 方法被显式调用的时刻，V8 零定时器断言的本模块半边）。
 *
 * 触发点三处（D3 触发点清单，封闭——新增触发点须先回设计对账 AS21）：
 * ① 路由配置保存（saveRoute/deleteRoute 成功后，transport aggregation-message-handler
 *    经 ctx 钩子调用 notifyRoutesChanged）——不过滤新鲜度：保存是明确的数据需求时刻，
 *    且模式切换（simple→advanced）后端点条件从「不参与求值」翻为参与，过期判定无法
 *    表达这类语义翻转，节流去重兜重复触发；
 * ② set_model 绑定模型路由成功（model-message-handler 回执生效值后经 ctx 钩子调用
 *    notifyRouteBound）——非路由引用 / 悬空路由内部短路；
 * ③ 绑定路由会话的回合收尾（组合根 agentSettledListeners 多播订阅 notifyAgentSettled）
 *    ——带「过期才刷」过滤（判定链：绑定模型是路由 → 该路由含额度条件端点 → 数据超
 *    新鲜度阈值/跨重置窗口），新鲜时零网络请求（AS11 触发密度收敛：回合收尾触发频率
 *    × 阈值过滤，接口压力 = 真实数据过期事件而非对话节奏）。
 *
 * 与既有 hover/设置强刷互不干扰：不触碰 QuotaService 的 force 通道（refresh）与
 * lastFetchTime 语义，fetchMany 与 hover fetch 同走非 force 维度、同一节流窗（10s 内
 * 互相返回缓存——同一数据的两次近邻读取收敛为一次网络请求，正是「节流内去重」）。
 *
 * 新鲜度判定单源在 shared（isAggregationQuotaDataFresh + AGGREGATION_QUOTA_FRESHNESS_MS）：
 * 本模块（runtime「过期才刷」）、pi 扩展（组装快照时判未知 → fail-open）与浮层标注
 * 三方同源，禁止另写时间比较。
 */

import type { AggregationRoute } from '@taiji/shared'
import {
  aggregationRouteIdFromRef,
  isAggregationQuotaDataFresh,
  type AggregationQuotaFreshnessProbe,
} from '@taiji/shared'
import { logger } from '../infra/logger.js'

export interface AggregationQuotaRefresherDeps { // oe-exempt:20261106:framework:Deps ports 契约，单实现为设计终态
  /**
   * 批量按需刷新入口（生产注入 QuotaService.fetchMany——非 force 维度，节流内去重）。
   */
  fetchMany(providerIds: readonly string[]): Promise<unknown>
  /** 路由配置读取（生产注入 configService.readAggregationRoutes 的 routes 段）。 */
  readRoutes(): readonly AggregationRoute[]
  /**
   * 额度缓存条目的新鲜度投影（生产注入 quotaService.getCached 的 wins/lastFetchAt 投影）。
   * null = 无缓存条目 / 条目缺 data（缓存缺失四型之①②）= 不新鲜。
   */
  getFreshnessProbe(providerId: string): AggregationQuotaFreshnessProbe | null
  /** 会话绑定模型复合串读取（'provider/id'；触发点③判定链第一环）。 */
  getSessionModelRef(sessionId: string): string | undefined
  /** 判定墙钟（缺省 Date.now；测试注入固定值保判定确定性——纯逻辑单测判据①档）。 */
  now?(): number
}

/**
 * 收集「启用额度条件」路由引用的 provider id 集（D3 刷新对象限定）：enabled 且 advanced
 * 模式路由中，type ∈ {quota, combo} 且 quota 字段在位的端点的 providerId 去重集。
 *
 * - simple 模式路由排除（D12：simple 不判条件，端点条件数据保留显示但不参与求值——无
 *   数据需求；切回 advanced 的保存动作即触发点①，数据随即跟进）；
 * - type=quota/combo 但 quota 字段缺失的端点排除（求值侧无从判死不猜阈值——router
 *   isQuotaConditionSatisfied 同语义，无阈值即无数据需求）；
 * - window/none 端点排除（无额度维度）。
 */
export function collectQuotaBoundProviderIds(routes: readonly AggregationRoute[]): string[] {
  const providerIds = new Set<string>()
  for (const route of routes) {
    if (!route.enabled || route.mode !== 'advanced') continue
    for (const member of route.members) {
      if ((member.type !== 'quota' && member.type !== 'combo') || member.quota === undefined) continue
      providerIds.add(member.providerId)
    }
  }
  return [...providerIds]
}

export class AggregationQuotaRefresher {
  constructor(private readonly deps: AggregationQuotaRefresherDeps) {}

  /**
   * 触发点①：路由配置保存/删除成功（runtime 进程内写方时刻）。刷新全部额度条件引用
   * provider；编排失败只 warn 不上抛（调用方为 transport handler，保存回执不被刷新失败阻断）。
   */
  async notifyRoutesChanged(): Promise<void> {
    try {
      await this.refreshProviderIds(collectQuotaBoundProviderIds(this.deps.readRoutes()))
    } catch (err) {
      logger.warn('[aggregation-quota] routes-changed refresh failed (save unaffected)', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * 触发点②：set_model 绑定模型路由成功。modelRef = 生效模型复合串（'provider/id'）；
   * 非路由引用（物理模型）或解析不到 routes 定义的悬空引用内部短路。
   */
  async notifyRouteBound(modelRef: string): Promise<void> {
    try {
      const routeId = aggregationRouteIdFromRef(modelRef)
      if (routeId === undefined) return
      const route = this.deps.readRoutes().find(r => r.id === routeId)
      if (route === undefined) return
      await this.refreshProviderIds(routeQuotaProviderIds(route))
    } catch (err) {
      logger.warn('[aggregation-quota] route-bound refresh failed (switch unaffected)', {
        modelRef,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * 触发点③：绑定路由会话的回合收尾（agent_settled）。判定链：会话绑定模型是路由 →
   * 路由在配置中（enabled）→ 含额度条件端点 → 数据超新鲜度阈值（isAggregationQuotaDataFresh
   * 判未知）——仅过期子集发起刷新（D3「过期才刷」），新鲜时零网络请求。
   */
  async notifyAgentSettled(sessionId: string): Promise<void> {
    try {
      const modelRef = this.deps.getSessionModelRef(sessionId)
      if (modelRef === undefined) return
      const routeId = aggregationRouteIdFromRef(modelRef)
      if (routeId === undefined) return
      const route = this.deps.readRoutes().find(r => r.id === routeId && r.enabled)
      if (route === undefined) return
      const providerIds = routeQuotaProviderIds(route)
      const now = this.deps.now?.() ?? Date.now()
      const stale = providerIds.filter(id => {
        const probe = this.deps.getFreshnessProbe(id)
        if (probe === null) return true
        return !isAggregationQuotaDataFresh(probe, now)
      })
      await this.refreshProviderIds(stale)
    } catch (err) {
      logger.warn('[aggregation-quota] agent-settled refresh failed (turn unaffected)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** 刷新执行（空集跳过不触 fetchMany；失败上抛给触发点方法的 catch 收口）。 */
  private async refreshProviderIds(providerIds: readonly string[]): Promise<void> {
    if (providerIds.length === 0) return
    await this.deps.fetchMany(providerIds)
  }
}

/** 单条路由的额度条件引用 provider 集（触发点②③的刷新对象推导，去重）。 */
function routeQuotaProviderIds(route: AggregationRoute): string[] {
  return collectQuotaBoundProviderIds([route])
}
