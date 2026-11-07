/**
 * useRoutePageOrchestration 编排 composable 单测（provider-aggregation U9 删除侧 / U11 加载态 /
 * U7 新会话可用快照的宿主接线）。
 *
 * 覆盖：
 * ① 首拉成功：routeView 落地 + loading/failed 复位 + U7 首次快照建立（当前视图徽标集为空）
 * ② 首拉失败：failed 置位 + error toast（非静默吞）+ 重试放行收敛
 * ③ U7 派生集：广播视图 ∖ 首次快照 = 运行期新建 id 集（旧 id 消失后集合收缩）
 * ④ 删除编排：消费 deleteRoute 端口 + 成功 toast + 主动拉取收敛
 * ⑤ 删除失败：error toast 且不向上抛（调用方 = SettingsModal 模板接线，无 catch 义务）
 * ⑥ 保存编排（U9 保存侧）：单路由合并意图成功 / scopedModels 失败回滚（编辑 saveRoute(prior)
 *    与新建 deleteRoute）/ 回滚也失败的残留态呈报（saveScopedMismatch 指引 + 收敛拉取）/
 *    多路由批次拆分写残留态呈报 / 纯排序开关失败一致态 / routes 写失败白名单未动
 *
 * 测试模式（对齐 composables 域惯例）：'@/api' 门面 inline vi.mock（orchestration 只消费
 * config 域 aggregation 档五键）；useToast 为模块级单例（无需注入），toast 断言读其共享
 * toasts 列表；composable 含 onBeforeUnmount 订阅清理，经 harness 组件 mount 承载 setup
 * 上下文，enableAutoUnmount 用例间卸载。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { AggregationRoute, AggregationRouteCard, AggregationRouteView } from '@taiji/shared'
import { config as configApi } from '@/api'
import { useToast } from '@/composables/useToast'
import { useRoutePageOrchestration } from '../useRoutePageOrchestration'

vi.mock('@/api', () => ({
  config: {
    getRouteView: vi.fn(),
    onRouteView: vi.fn(() => () => {}),
    saveRoute: vi.fn(async () => ({})),
    deleteRoute: vi.fn(async () => ({})),
    setScopedModels: vi.fn(async (models: string[]) => models),
  },
}))

type Orchestration = ReturnType<typeof useRoutePageOrchestration>

/** composable 需要组件 setup 上下文（onBeforeUnmount 订阅清理），harness 承载。 */
function mountOrchestration(): { api: Orchestration } {
  let api!: Orchestration
  mount(defineComponent({
    setup() {
      api = useRoutePageOrchestration()
      return () => null
    },
  }))
  return { api }
}

function routeCardOf(id: string, scopedIndex: number): AggregationRouteCard {
  return {
    route: {
      id,
      name: id,
      modelId: id,
      enabled: true,
      mode: 'simple',
      members: [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }],
      specials: [],
    },
    scoped: scopedIndex >= 0,
    scopedIndex,
    memberIssues: [],
  }
}

/** 视图 route 的编辑副本（首端点换 modelId = 内容变化，过 composable 的 changedRoutes 判定）。 */
function editedRouteOf(id: string): AggregationRoute {
  const card = routeCardOf(id, 0)
  return { ...card.route, members: [{ ...card.route.members[0]!, modelId: 'glm-5.2' }] }
}

function viewOf(ids: string[]): AggregationRouteView {
  return { cards: ids.map((id, i) => routeCardOf(id, i)), orphanRefs: [] }
}

function getRouteViewMock(): Mock {
  return vi.mocked(configApi.getRouteView)
}

beforeEach(() => {
  vi.clearAllMocks()
})

// harness 挂载件（含 onRouteView 订阅）用例间卸载，防订阅泄漏与告警串扰
enableAutoUnmount(afterEach)

describe('视图加载态（U11）', () => {
  it('首拉成功：routeView 落地 + loading/failed 复位', async () => {
    const { api } = mountOrchestration()
    expect(api.routeViewLoading.value).toBe(false)
    getRouteViewMock().mockResolvedValueOnce(viewOf(['r1', 'r2']))
    const pending = api.ensureRouteView()
    // 拉取进行中：loading 置位（routeView 仍为 null）
    expect(api.routeViewLoading.value).toBe(true)
    await pending
    await flushPromises()
    expect(api.routeView.value).not.toBeNull()
    expect(api.routeViewLoading.value).toBe(false)
    expect(api.routeViewFailed.value).toBe(false)
  })

  it('首拉失败：failed 置位 + error toast（非静默吞）；重试放行并收敛', async () => {
    const { api } = mountOrchestration()
    const { toasts } = useToast()
    const toastsBefore = toasts.value.length
    getRouteViewMock()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(viewOf(['r1']))
    await api.ensureRouteView()
    await flushPromises()
    expect(api.routeView.value).toBeNull()
    expect(api.routeViewFailed.value).toBe(true)
    expect(api.routeViewLoading.value).toBe(false)
    expect(toasts.value.length).toBe(toastsBefore + 1)
    expect(toasts.value[toasts.value.length - 1]!.type).toBe('error')
    // 重试 = 重新 ensureRouteView（失败复位守卫后放行）
    await api.ensureRouteView()
    await flushPromises()
    expect(api.routeViewFailed.value).toBe(false)
    expect(api.routeView.value).not.toBeNull()
    expect(getRouteViewMock()).toHaveBeenCalledTimes(2)
  })
})

describe('新会话可用快照（U7：本应用生命周期首次加载路由 id 集）', () => {
  it('首次成功加载建立快照：当前视图全部 id 在快照内 → 徽标集为空', async () => {
    const { api } = mountOrchestration()
    getRouteViewMock().mockResolvedValueOnce(viewOf(['r1', 'r2']))
    await api.ensureRouteView()
    await flushPromises()
    expect([...api.newSessionRouteIds.value]).toEqual([])
  })

  it('后续视图新增 id ∉ 首次快照 → 进徽标集；视图回退按当前视图 ∖ 快照收缩', async () => {
    const { api } = mountOrchestration()
    getRouteViewMock().mockResolvedValueOnce(viewOf(['r1']))
    await api.ensureRouteView()
    await flushPromises()
    // routeView 失效广播（runtime 保存/删除后 last-value 全量下发）携新路由 r2
    const broadcast = vi.mocked(configApi.onRouteView).mock.calls[0]?.[0] as (v: AggregationRouteView) => void
    broadcast(viewOf(['r1', 'r2']))
    await flushPromises()
    expect([...api.newSessionRouteIds.value]).toEqual(['r2'])
    // r1 被删除后视图只余 r2：r2 仍属运行期新建（快照未含它），集合按当前视图收缩
    broadcast(viewOf(['r2']))
    await flushPromises()
    expect([...api.newSessionRouteIds.value]).toEqual(['r2'])
  })
})

describe('删除路由编排（U9 删除侧：deleteRoute 端口单 RPC 双写）', () => {
  it('确认删除：消费 deleteRoute 端口 + 成功 toast + 主动拉取收敛', async () => {
    const { api } = mountOrchestration()
    const { toasts } = useToast()
    getRouteViewMock().mockResolvedValueOnce(viewOf(['r1', 'r2']))
    await api.ensureRouteView()
    await flushPromises()
    const pullsBefore = getRouteViewMock().mock.calls.length
    await api.onRoutePageDelete('r1')
    await flushPromises()
    expect(vi.mocked(configApi.deleteRoute)).toHaveBeenCalledWith('r1')
    expect(getRouteViewMock().mock.calls.length).toBe(pullsBefore + 1)
    expect(toasts.value.some((t) => t.type === 'info' && t.message === '路由已删除')).toBe(true)
  })

  it('删除失败：error toast 且不向上抛（SettingsModal 模板接线无 catch 义务）', async () => {
    const { api } = mountOrchestration()
    const { toasts } = useToast()
    const toastsBefore = toasts.value.length
    vi.mocked(configApi.deleteRoute).mockRejectedValueOnce(new Error('boom'))
    await expect(api.onRoutePageDelete('r1')).resolves.toBeUndefined()
    expect(toasts.value.length).toBe(toastsBefore + 1)
    expect(toasts.value[toasts.value.length - 1]!.type).toBe('error')
  })
})

describe('保存编排（U9 保存侧：合并意图与失败恢复）', () => {
  /** 挂载已加载视图的编排实例（save 失败路径全部以此为基准 prior）。 */
  async function mountWithView(ids: string[]): Promise<{ api: Orchestration }> {
    const { api } = mountOrchestration()
    getRouteViewMock().mockResolvedValueOnce(viewOf(ids))
    await api.ensureRouteView()
    await flushPromises()
    return { api }
  }

  it('单路由保存 = 合并意图一次 save：saveRoute + setScopedModels 同轮调用 + 成功 toast + 主动拉取收敛', async () => {
    const { api } = mountOrchestration()
    const { toasts } = useToast()
    toasts.value = [] // toast 是模块级单例且在列上限 5：清掉前序用例残留，防限流丢弃 + 断言串扰
    getRouteViewMock().mockResolvedValueOnce(viewOf(['r1', 'r2']))
    await api.ensureRouteView()
    await flushPromises()
    const edited = editedRouteOf('r1')
    const pullsBefore = getRouteViewMock().mock.calls.length
    await api.onRoutePageSave({ routes: [edited], scopedRefs: ['agg/r1', 'zhipu/glm-5.3'] })
    await flushPromises()
    expect(vi.mocked(configApi.saveRoute)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(configApi.saveRoute)).toHaveBeenCalledWith(edited)
    expect(vi.mocked(configApi.setScopedModels)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(configApi.setScopedModels)).toHaveBeenCalledWith(['agg/r1', 'zhipu/glm-5.3'])
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]).toMatchObject({ type: 'info', message: '已保存' })
    expect(getRouteViewMock().mock.calls.length).toBe(pullsBefore + 1)
  })

  it('单路由编辑 scopedModels 失败：合并意图回滚 saveRoute(prior) + 原始错误 toast（回滚成功两权威一致，无残留拉取）', async () => {
    const { api } = await mountWithView(['r1', 'r2'])
    const { toasts } = useToast()
    toasts.value = []
    const prior = viewOf(['r1', 'r2']).cards[0]!.route
    const edited = editedRouteOf('r1')
    vi.mocked(configApi.setScopedModels).mockRejectedValueOnce(new Error('scoped write failed'))
    const pullsBefore = getRouteViewMock().mock.calls.length
    await api.onRoutePageSave({ routes: [edited], scopedRefs: ['agg/r1'] })
    await flushPromises()
    // 回滚 = saveRoute(priorRoute)（编辑语义：主写 edited → scopedModels 失败 → 回写 prior）
    expect(vi.mocked(configApi.saveRoute)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(configApi.saveRoute)).toHaveBeenNthCalledWith(1, edited)
    expect(vi.mocked(configApi.saveRoute)).toHaveBeenNthCalledWith(2, prior)
    // 回滚成功 = 两权威一致：呈报原始错误（非残留态专用指引），不触发收敛拉取
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]).toMatchObject({ type: 'error', message: 'scoped write failed' })
    expect(getRouteViewMock().mock.calls.length).toBe(pullsBefore)
  })

  it('单路由新建 scopedModels 失败：合并意图回滚 deleteRoute 撤销刚建条目（priorRoute=null 语义）', async () => {
    const { api } = await mountWithView(['r1'])
    const { toasts } = useToast()
    toasts.value = []
    const newRoute = routeCardOf('r-new', -1).route
    vi.mocked(configApi.setScopedModels).mockRejectedValueOnce(new Error('scoped write failed'))
    await api.onRoutePageSave({ routes: [newRoute], scopedRefs: ['agg/r-new'] })
    await flushPromises()
    expect(vi.mocked(configApi.saveRoute)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(configApi.saveRoute)).toHaveBeenCalledWith(newRoute)
    expect(vi.mocked(configApi.deleteRoute)).toHaveBeenCalledWith('r-new')
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]).toMatchObject({ type: 'error', message: 'scoped write failed' })
  })

  it('单路由保存 scopedModels 失败且回滚也失败：saveScopedMismatch 专用指引 + 主动拉取收敛（残留态禁止静默）', async () => {
    const { api } = await mountWithView(['r1', 'r2'])
    const { toasts } = useToast()
    toasts.value = []
    const edited = editedRouteOf('r1')
    vi.mocked(configApi.saveRoute)
      .mockResolvedValueOnce({ route: edited, memberIssues: [] }) // 主写成功
      .mockRejectedValueOnce(new Error('rollback failed')) // 回滚失败
    vi.mocked(configApi.setScopedModels).mockRejectedValueOnce(new Error('scoped write failed'))
    getRouteViewMock().mockResolvedValueOnce(viewOf(['r1', 'r2'])) // 残留态收敛拉取
    const pullsBefore = getRouteViewMock().mock.calls.length
    await api.onRoutePageSave({ routes: [edited], scopedRefs: ['agg/r1'] })
    await flushPromises()
    expect(vi.mocked(configApi.saveRoute)).toHaveBeenCalledTimes(2)
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]).toMatchObject({ type: 'error', message: '路由定义已保存但模型白名单未同步，请重试保存' })
    expect(getRouteViewMock().mock.calls.length).toBe(pullsBefore + 1)
  })

  it('多路由批次 scopedModels 失败（拆分写，routes 半边已落盘）：saveScopedMismatch 指引 + 主动拉取收敛（组合残留态）', async () => {
    const { api } = await mountWithView(['r1', 'r2'])
    const { toasts } = useToast()
    toasts.value = []
    const edited1 = editedRouteOf('r1')
    const edited2 = editedRouteOf('r2')
    vi.mocked(configApi.setScopedModels).mockRejectedValueOnce(new Error('scoped write failed'))
    getRouteViewMock().mockResolvedValueOnce(viewOf(['r1', 'r2'])) // 残留态收敛拉取
    const pullsBefore = getRouteViewMock().mock.calls.length
    await api.onRoutePageSave({ routes: [edited1, edited2], scopedRefs: ['agg/r1', 'agg/r2'] })
    await flushPromises()
    expect(vi.mocked(configApi.saveRoute)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(configApi.setScopedModels)).toHaveBeenCalledTimes(1)
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]).toMatchObject({ type: 'error', message: '路由定义已保存但模型白名单未同步，请重试保存' })
    expect(getRouteViewMock().mock.calls.length).toBe(pullsBefore + 1)
  })

  it('纯排序/开关保存 scopedModels 失败（无 routes 写）：原始错误 toast（两权威一致非残留），不触发 saveRoute 与收敛拉取', async () => {
    const { api } = await mountWithView(['r1', 'r2'])
    const { toasts } = useToast()
    toasts.value = []
    const unchanged = routeCardOf('r1', 0).route
    vi.mocked(configApi.setScopedModels).mockRejectedValueOnce(new Error('scoped write failed'))
    const pullsBefore = getRouteViewMock().mock.calls.length
    await api.onRoutePageSave({ routes: [unchanged], scopedRefs: ['zhipu/glm-5.3'] })
    await flushPromises()
    expect(vi.mocked(configApi.saveRoute)).not.toHaveBeenCalled()
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]).toMatchObject({ type: 'error', message: 'scoped write failed' })
    expect(getRouteViewMock().mock.calls.length).toBe(pullsBefore)
  })

  it('routes 写失败：白名单未动（编排器 stage=routes 一致态），原始错误 toast 且 setScopedModels 未调用', async () => {
    const { api } = await mountWithView(['r1', 'r2'])
    const { toasts } = useToast()
    toasts.value = []
    vi.mocked(configApi.saveRoute).mockRejectedValueOnce(new Error('route_id_conflict'))
    await api.onRoutePageSave({ routes: [editedRouteOf('r1')], scopedRefs: ['agg/r1'] })
    await flushPromises()
    expect(vi.mocked(configApi.saveRoute)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(configApi.setScopedModels)).not.toHaveBeenCalled()
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]).toMatchObject({ type: 'error', message: 'route_id_conflict' })
  })
})
