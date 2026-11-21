/**
 * 快速创建接线 composable（模型路由页 · spec §4）。
 *
 * 从 ModelRoutePage 拆出的草稿接线半边（文件行数护栏）：占用集计算（草稿 ∪ 视图）、
 * usage 统计、事实态重复防护判定与两入口创建意图 → 构建器 → route-add 指令 + 本地
 * focus 定位 + toast 反馈。页面层保留 applyEditorOp 唯一入口与草稿所有权。
 */
import { useI18n } from 'vue-i18n'
import type { AggregationRoute, ProviderInfo } from '@taiji/shared'
import { useSettingsToast } from '../injection-keys'
import {
  buildAdvancedQuickRoute,
  buildSimpleQuickRoute,
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
  /** 新卡本地定位（页面 localFocus）。 */
  focusRoute: (routeId: string, memberId: string) => void
}

/** use-quick-create 返回面。 */
export interface UseQuickCreate { // oe-exempt:20261121:framework:快速创建跨文件形状契约（builder/组件/composable/测试多消费方，单实现为设计终态）
  usageOf: (providerId: string, modelId: string) => number
  existingSimpleOf: (providerId: string, modelId: string) => boolean
  onQuickCreateSimple: (pick: QuickPickModel) => void
  onQuickCreateAdvanced: (payload: { picks: QuickPickModel[]; filterKeyword: string }) => void
}

/** 页面草稿卡最小结构面（路由占用集只关心路由卡）。 */
export type QuickCreateDraftCard = { kind: 'route'; card: { route: AggregationRoute } } | { kind: 'direct' }

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
   * AC-Q13 事实防护：本编辑会话内「未保存落卡」的同 provider+model 单端点简单路由 →
   * 行内按钮禁用（防重复点击）。口径 = 草稿路由 ∖ 已保存视图路由——已保存的同型路由
   * 不拦（G8 逃生路径：保存后可再建一条同模型简单路由；修剪 F3）。
   */
  function existingSimpleOf(providerId: string, modelId: string): boolean {
    const savedIds = new Set(input.viewCardsOf().map((v) => v.route.id))
    return routeCardsOf(input.draftOf()).some(
      (c) =>
        !savedIds.has(c.route.id) &&
        c.route.mode === 'simple' &&
        c.route.members.length === 1 &&
        c.route.members[0]!.providerId === providerId &&
        c.route.members[0]!.modelId === modelId,
    )
  }

  /** 快速创建落卡（route-add 唯一入口 + focus 定位 + toast）。 */
  function quickAddRoute(route: AggregationRoute): void {
    input.addRoute(route)
    input.focusRoute(route.id, route.members[0]?.id ?? '')
  }

  function onQuickCreateSimple(pick: QuickPickModel): void {
    const route = buildSimpleQuickRoute({ pick, takenRouteIds: takenRouteIds(), takenNames: takenNames() })
    quickAddRoute(route)
    toast.info(t('settings.modelRoute.quickSimpleToast', { name: route.name }))
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

  return { usageOf, existingSimpleOf, onQuickCreateSimple, onQuickCreateAdvanced }
}
