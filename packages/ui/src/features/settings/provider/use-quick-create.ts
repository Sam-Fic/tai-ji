/**
 * 快速创建接线 composable（模型路由页 · spec §4）。
 *
 * 从 ModelRoutePage 拆出的草稿接线半边（文件行数护栏）：占用集计算（草稿 ∪ 视图）、
 * usage 统计、事实态重复防护判定与创建意图 → 构建器 → route-add 唯一入口 + 本地
 * focus 定位 + toast 反馈。页面层保留 applyEditorOp 唯一入口与草稿所有权。
 *
 * 创建入口两形态（spec §3 创建入口收敛）：
 * - 模型行「加直连」：单模型 → 草稿追加渠道直连卡（scopedModels 白名单条目，无 routes
 *   定义；保存经 scopedRefs 整表覆写生效——两权威 D10 的白名单半边）。
 * - 底部「创建高级路由」：勾选多选 → 高级路由草稿卡。
 * 单模型路由形态的「建简单路由」入口已退役（用户裁决：单模型直接加直连，路由只承载
 * 多端点聚合）；简单路由的历史数据与卡片编辑能力不变。
 */
import { useI18n } from 'vue-i18n'
import type { AggregationRoute, ProviderInfo } from '@taiji/shared'
import { useSettingsToast } from '../injection-keys'
import {
  buildAdvancedQuickRoute,
  buildUsageIndex,
  quickPickKey,
  type QuickPickModel,
} from './route-quick-create'

/** 高级路由最少模型数（spec §4.6 前置条件：已选 ≥2）。 */
export const MIN_ADVANCED_PICKS = 2

/** use-quick-create 输入（页面草稿态与指令通道注入）。 */
export interface UseQuickCreateInput { // oe-exempt:20261121:framework:快速创建跨文件形状契约（builder/组件/composable/测试多消费方，单实现为设计终态）
  /** 页面草稿卡（reactive 引用经 getter 注入，避免持有过时快照）。 */
  draftOf: () => readonly QuickCreateDraftCard[]
  /** wire 视图（路由 id/name 占用集的已保存半边）。 */
  viewCardsOf: () => ReadonlyArray<{ route: AggregationRoute }>
  providersOf: () => ReadonlyArray<ProviderInfo>
  /** route-add 指令通道（页面 applyEditorOp）。 */
  addRoute: (route: AggregationRoute) => void
  /** direct-add 指令通道（页面 applyEditorOp）。 */
  addDirect: (providerId: string, modelId: string) => void
  /** 新卡本地定位（页面 localFocus）。 */
  focusRoute: (routeId: string, memberId: string) => void
}

/** use-quick-create 返回面。 */
export interface UseQuickCreate { // oe-exempt:20261121:framework:快速创建跨文件形状契约（builder/组件/composable/测试多消费方，单实现为设计终态）
  usageOf: (providerId: string, modelId: string) => number
  existingDirectOf: (providerId: string, modelId: string) => boolean
  onQuickCreateDirect: (pick: QuickPickModel) => void
  onQuickCreateAdvanced: (payload: { picks: QuickPickModel[]; filterKeyword: string }) => void
}

/** 页面草稿卡最小结构面（路由占用集只关心路由卡；直连去重关心直连卡的 provider/model）。 */
export type QuickCreateDraftCard =
  | { kind: 'route'; card: { route: AggregationRoute } }
  | { kind: 'direct'; providerId: string; modelId: string }

/** 草稿路由卡提取（直连卡不参与路由占用集）。 */
function routeCardsOf(draft: readonly QuickCreateDraftCard[]): Array<{ route: AggregationRoute }> {
  return draft.flatMap((c) => (c.kind === 'route' ? [{ route: c.card.route }] : []))
}

export function useQuickCreate(input: UseQuickCreateInput): UseQuickCreate {
  const { t } = useI18n()
  const toast = useSettingsToast()

  /** 草稿路由 id 占用集（草稿 ∪ 视图）。 */
  function takenRouteIds(): string[] {
    return [
      ...routeCardsOf(input.draftOf()).map((c) => c.route.id),
      ...input.viewCardsOf().map((v) => v.route.id),
    ]
  }

  /** 草稿路由名占用集（同上）。 */
  function takenNames(): string[] {
    return [
      ...routeCardsOf(input.draftOf()).map((c) => c.route.name),
      ...input.viewCardsOf().map((v) => v.route.name),
    ]
  }

  function providerNameOf(providerId: string): string {
    return input.providersOf().find((p) => p.id === providerId)?.name ?? providerId
  }

  /** 「用于 m 条路由」统计（仅路由口径，spec §4.8；从草稿现算随编辑实时更新）。 */
  function usageOf(providerId: string, modelId: string): number {
    return (
      buildUsageIndex(routeCardsOf(input.draftOf()).map((c) => c.route)).get(quickPickKey(providerId, modelId)) ?? 0
    )
  }

  /**
   * 直连去重防护（事实态，AC-Q13 同族）：该 provider+model 已有直连条目 → true。
   * 口径 = 草稿目标态直连卡（一张即拦截）——防的是「同一白名单条目重复落卡」
   * （保存整表覆写按去重保序会静默合并，草稿里留一张空转卡）。已落盘条目同样
   * 拦截（不存在「保存后再加一条同模型直连」的合法场景——白名单条目即模型本身），
   * 但其事实来源是草稿而非持久态：草稿由 cloneDraft 从持久态播种（已落盘直连卡
   * isNew:false 入草稿），本会话 direct-remove 摘除后 ref 不在草稿 → 该行恢复
   * 可创建态。恒读持久态的旧口径把「本会话已移除」误判为仍存在（2026-11-25
   * dev-merge review dmg-r1-1：移除后快速创建行仍显禁用态、同模型无法重加）。
   */
  function existingDirectOf(providerId: string, modelId: string): boolean {
    return input.draftOf().some((c) => c.kind === 'direct' && c.providerId === providerId && c.modelId === modelId)
  }

  /** 快速创建落卡（route-add 唯一入口 + focus 定位 + toast）。 */
  function quickAddRoute(route: AggregationRoute): void {
    input.addRoute(route)
    input.focusRoute(route.id, route.members[0]?.id ?? '')
  }

  /** 「加直连」：单模型 → 草稿追加直连卡（无 routes 定义，白名单半边载荷）。 */
  function onQuickCreateDirect(pick: QuickPickModel): void {
    input.addDirect(pick.providerId, pick.modelId)
    toast.info(t('settings.modelRoute.quickDirectToast', { name: pick.modelDisplayName }))
  }

  function onQuickCreateAdvanced(payload: { picks: QuickPickModel[]; filterKeyword: string }): void {
    if (payload.picks.length < MIN_ADVANCED_PICKS) return
    const route = buildAdvancedQuickRoute({
      picks: payload.picks,
      providerNameOf,
      filterKeyword: payload.filterKeyword,
      takenRouteIds: takenRouteIds(),
      takenNames: takenNames(),
    })
    quickAddRoute(route)
    toast.info(t('settings.modelRoute.quickAdvancedToast', { name: route.name }))
  }

  return { usageOf, existingDirectOf, onQuickCreateDirect, onQuickCreateAdvanced }
}
