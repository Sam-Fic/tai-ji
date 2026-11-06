/**
 * useRoutePageOrchestration —— 模型路由页编排 composable（provider-aggregation D10 视图半边
 * + U9 保存/删除编排的宿主接线；SettingsModal 模型路由分区的数据与写通道，组件层只做模板接线）。
 *
 * 视图：aggregation.getRouteView 拉取 + routeView 失效广播订阅刷新（runtime 保存/删除后
 * last-value 全量下发，多窗口同步；丢失由保存成功后的主动拉取收敛——协议注释契约）。
 * 加载态（U11）：loading/failed 显式暴露，分区首拉期间与失败重试由 SettingsModal 呈现
 * 占位（routeView === null 不再是纯空白）。保存：core createRouteSaveOrchestrator（routes
 * 先写、scopedModels 后写、scopedModels 失败回滚 routes）；删除：同一编排器 delete 端口
 * （runtime 单 RPC 双写编排 = routes 删除 + scopedModels 精确清理 + 默认模型回退）；
 * transport 半边经 @/api config 域 aggregation 档 + setScopedModels 既有通道
 * （门面继承 VITE_MOCK 切换，mock 侧同构实现）。
 */
import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { createRouteSaveOrchestrator, toErrorMessage } from '@taiji/core'
import type { AggregationRouteView } from '@taiji/shared'
import type { RoutePageSavePayload } from '@taiji/ui/features/settings'
import { config as configApi } from '@/api'
import { useToast } from '@/composables/useToast'

export function useRoutePageOrchestration(): {
  /** join 视图缓存（null = 首访拉取中或失败，内容分支不挂载）。 */
  routeView: Ref<AggregationRouteView | null>
  /** 首访拉取进行中（U11：SettingsModal 加载占位开关）。 */
  routeViewLoading: Ref<boolean>
  /** 首访拉取失败（U11：失败占位 + 重试入口；重试 = 重新 ensureRouteView）。 */
  routeViewFailed: Ref<boolean>
  /** 分区首访拉取（失败复位标记，重进分区可重试）。 */
  ensureRouteView: () => Promise<void>
  /** 未保存条保存编排（U5 检查点：保存成功反馈 = 成功 toast）。 */
  onRoutePageSave: (payload: RoutePageSavePayload) => Promise<void>
  /** 删除路由编排（U9 删除侧：deleteRoute 端口单 RPC 双写，成功反馈 = 成功 toast）。 */
  onRoutePageDelete: (routeId: string) => Promise<void>
  /** 新会话可用路由 id 集（U7：当前视图 ∖ 本应用生命周期首次加载快照）。 */
  newSessionRouteIds: Ref<ReadonlySet<string>>
  } {
  const routeView = ref<AggregationRouteView | null>(null)
  const routeViewLoading = ref(false)
  const routeViewFailed = ref(false)
  /** 首访拉取标记（拉取副作用只跑一次，同 visitedViews 首访挂载语义）。 */
  let routeViewFetchStarted = false
  /** 保存编排进行中标记（防未保存条重复提交导致的两权威交错写）。 */
  let saving = false
  /**
   * 本应用生命周期首次成功加载的路由 id 快照（U7 判定基准；null = 快照未建立）。
   * 首次快照之后的路由 = 本应用运行期内新建（当前 pi 会话加载时未注册，重开会话方可
   * 绑定——D1③ 语义），徽标只在运行期新建的卡上出现。
   */
  let initialRouteIds: ReadonlySet<string> | null = null
  const { t } = useI18n()
  const { info: toastInfo, error: toastError } = useToast()

  const routeSaveOrchestrator = createRouteSaveOrchestrator({
    getRouteView: () => configApi.getRouteView(),
    saveRoute: (route) => configApi.saveRoute(route),
    deleteRoute: (routeId) => configApi.deleteRoute(routeId),
    setScopedModels: (models) => configApi.setScopedModels(models),
  })

  /** routeView 唯一写入点：首个非空视图落地时建立 U7 快照，此后不再重建。 */
  function adoptRouteView(view: AggregationRouteView): void {
    if (initialRouteIds === null) {
      initialRouteIds = new Set(view.cards.map((c) => c.route.id))
    }
    routeView.value = view
  }

  /** U7 派生集：当前视图路由 id ∖ 首次快照（快照未建立时恒空集，不显徽标）。 */
  const newSessionRouteIds = computed<ReadonlySet<string>>(() => {
    const view = routeView.value
    if (view === null || initialRouteIds === null) return new Set()
    return new Set(view.cards.filter((c) => !initialRouteIds!.has(c.route.id)).map((c) => c.route.id))
  })

  async function ensureRouteView(): Promise<void> {
    if (routeViewFetchStarted) return
    routeViewFetchStarted = true
    routeViewLoading.value = true
    routeViewFailed.value = false
    try {
      adoptRouteView(await configApi.getRouteView())
    } catch (e) {
      routeViewFetchStarted = false // 允许重进分区重试
      routeViewFailed.value = true
      toastError(toErrorMessage(e))
    } finally {
      routeViewLoading.value = false
    }
  }

  // 路由视图失效广播订阅：组件常驻订阅，随卸载清理
  const disposeRouteViewSubscription = configApi.onRouteView((view) => {
    adoptRouteView(view)
  })
  onBeforeUnmount(disposeRouteViewSubscription)

  async function onRoutePageSave(payload: RoutePageSavePayload): Promise<void> {
    if (saving) return
    saving = true
    try {
      const priorById = new Map((routeView.value?.cards ?? []).map((c) => [c.route.id, c.route]))
      for (const route of payload.routes) {
        const prior = priorById.get(route.id)
        if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(route)) continue
        const outcome = await routeSaveOrchestrator.save({ route, priorRoute: prior ?? null })
        if (!outcome.ok) throw outcome.error
      }
      const scopedOutcome = await routeSaveOrchestrator.save({ scopedModels: payload.scopedRefs })
      if (!scopedOutcome.ok) {
        throw scopedOutcome.stage === 'scoped-rollback-failed'
          ? new Error(t('settings.modelRoute.saveScopedMismatch'))
          : scopedOutcome.error
      }
      toastInfo(t('settings.saved'))
      // 主动拉取收敛（不依赖广播时序；视图刷新触发 ModelRoutePage 草稿重置回权威态）
      adoptRouteView(await configApi.getRouteView())
    } catch (e) {
      toastError(toErrorMessage(e))
    } finally {
      saving = false
    }
  }

  async function onRoutePageDelete(routeId: string): Promise<void> {
    try {
      await routeSaveOrchestrator.delete(routeId)
      toastInfo(t('settings.modelRoute.routeDeleted'))
      // 主动拉取收敛（同保存语义）；刷新后的视图触发 ModelRoutePage 草稿重置 = 卡移除
      adoptRouteView(await configApi.getRouteView())
    } catch (e) {
      toastError(toErrorMessage(e))
    }
  }

  return { routeView, routeViewLoading, routeViewFailed, ensureRouteView, onRoutePageSave, onRoutePageDelete, newSessionRouteIds }
}
