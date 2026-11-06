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
import type { AggregationRouteCard, AggregationRouteView } from '@taiji/shared'
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
