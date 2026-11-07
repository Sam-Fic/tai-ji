// @vitest-environment happy-dom

/**
 * model-picker-data 命中端点投影测试（provider-aggregation M3 数据半边）：pickerGroups
 * 计算链的路由行「此刻命中端点」标注——withHitEndpoints 对缓存路由定义按当前坐标求值
 * （evaluateRouteAt）后写 hitEndpoint（命中 = 端点 provider 显示名；定义在但条件全不
 * 满足 = null「此刻无命中」；缓存无该路由 id = 标注缺席）。
 *
 * 与 ModelPickerPanel.route-hit.test.ts 的分界：该文件锁定呈现映射（模板三元），本文件
 * 锁定数据求值半边（#94 缓存懒拉 + evaluateRouteAt 投影）。'@/api' config 域窄 mock
 * （getRouteView/onRouteView 两键，缓存懒拉与失效广播重拉的数据源）；模块级缓存单例
 * （routeCardsById）按测试文件隔离——本文件内两用例共享同一次首拉结果。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { getSettingsStore } from '@taiji/core'
import type { ModelInfo, NormalizedQuotaRow, ProviderId } from '@taiji/shared'
import { useModelPickerData } from '@/components/panel/model-picker-data'
import { useQuotaStore } from '@/stores/quota'

const { getRouteViewMock, onRouteViewMock } = vi.hoisted(() => ({
  // 首拉回三卡：work-route 无条件端点（恒命中）+ night-route 时间窗全空表（恒不命中）
  // + quota-route 额度条件端点（threshold 20：剩余 < 20 落选——dmg-r1-10 额度接线锁定）
  getRouteViewMock: vi.fn(async () => ({
    cards: [
      {
        route: {
          id: 'work-route', name: '工作路由', modelId: 'work-route', enabled: true, mode: 'advanced',
          members: [{ id: 'ep-1', providerId: 'zhipu', modelId: 'glm-5.3', type: 'none' }],
          specials: [],
        },
        scoped: true, scopedIndex: 0, memberIssues: [],
      },
      {
        route: {
          id: 'night-route', name: '夜间路由', modelId: 'night-route', enabled: true, mode: 'advanced',
          members: [{
            id: 'ep-2', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'window',
            window: Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => false)),
          }],
          specials: [],
        },
        scoped: true, scopedIndex: 1, memberIssues: [],
      },
      {
        route: {
          id: 'quota-route', name: '额度路由', modelId: 'quota-route', enabled: true, mode: 'advanced',
          members: [{
            id: 'ep-3', providerId: 'zhipu', modelId: 'glm-4.7', type: 'quota',
            quota: { thresholdPercent: 20 },
          }],
          specials: [],
        },
        scoped: true, scopedIndex: 2, memberIssues: [],
      },
    ],
    orphanRefs: [],
  })),
  onRouteViewMock: vi.fn(() => () => {}),
}))

vi.mock('@/api', () => ({
  config: { getRouteView: getRouteViewMock, onRouteView: onRouteViewMock },
}))

const ROUTE_WORK: ModelInfo = { id: 'work-route', name: '工作路由', providerId: 'aggregation' as ProviderId, providerName: '模型路由', aggregation: true, enabled: true }
const ROUTE_NIGHT: ModelInfo = { id: 'night-route', name: '夜间路由', providerId: 'aggregation' as ProviderId, providerName: '模型路由', aggregation: true, enabled: true }
const ROUTE_QUOTA: ModelInfo = { id: 'quota-route', name: '额度路由', providerId: 'aggregation' as ProviderId, providerName: '模型路由', aggregation: true, enabled: true }
const ZHIPU_GLM: ModelInfo = { id: 'glm-5.3', name: 'GLM 5.3', providerId: 'zhipu' as ProviderId, providerName: 'Zhipu', enabled: true }

beforeEach(() => {
  setActivePinia(createPinia())
  const store = getSettingsStore()
  store.models.value = [ZHIPU_GLM, ROUTE_WORK, ROUTE_NIGHT, ROUTE_QUOTA]
  store.providers.value = [
    { id: 'zhipu' as ProviderId, name: 'Zhipu' },
    { id: 'aggregation' as ProviderId, name: '模型路由' },
  ] as never
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('withHitEndpoints 命中端点投影（M3 数据半边）', () => {
  it('首拉触发一次（懒拉语义）且缓存未到时标注缺席；落盘后命中路由行写端点显示名', async () => {
    const { pickerGroups } = useModelPickerData()
    // 首次求值：聚合组在场触发懒拉（缓存尚未落地 = 投影缺席，行无 hitEndpoint 键）
    const first = pickerGroups.value
    expect(first.find((g) => g.aggregation)?.models.every((m) => m.hitEndpoint === undefined)).toBe(true)
    expect(getRouteViewMock).toHaveBeenCalledTimes(1)
    expect(onRouteViewMock).toHaveBeenCalledTimes(1)

    await flushPromises()
    // 二次求值（挂载/广播驱动的事件式刷新）：缓存落地后投影生效——命中端点 = provider 显示名
    const second = pickerGroups.value
    const routeGroup = second.find((g) => g.aggregation)
    expect(routeGroup?.models.find((m) => m.id === 'work-route')?.hitEndpoint).toBe('Zhipu')
  })

  it('定义在但条件全不满足 = hitEndpoint null（「此刻无命中」）；缓存无该 id = 标注缺席', async () => {
    const { pickerGroups } = useModelPickerData()
    await flushPromises()
    const routeGroup = pickerGroups.value.find((g) => g.aggregation)
    // night-route 时间窗全空表恒不命中 → null（行显「此刻无命中」，非 undefined 缺席）
    expect(routeGroup?.models.find((m) => m.id === 'night-route')?.hitEndpoint).toBeNull()
    // 物理组行不经投影（零 hitEndpoint 键）
    const physical = pickerGroups.value.find((g) => !g.aggregation)
    expect(physical?.models.every((m) => m.hitEndpoint === undefined)).toBe(true)
  })

  // ── 额度维度接线（dmg-r1-10）：quotaOf 与路由页 chip、pi 生效判定同输入 ──

  /** 构造 zhipu 首窗口已用 pct 的额度缓存行（wins[0] 携带，quotaOf 投影口径）。 */
  const quotaRow = (pct: number): NormalizedQuotaRow => ({
    label: 'Zhipu Plan',
    wins: [
      { pct, resetSec: 3600 },
      { pct: 0, resetSec: null },
      { pct: 0, resetSec: null },
    ],
  })

  it('额度缓存缺席 = 数据未知 fail-open（quota-route 仍显示命中，D5 语义保持）', async () => {
    const { pickerGroups } = useModelPickerData()
    await flushPromises()
    // quota store 零缓存 → pct undefined → quota-unknown-open 判满足
    const routeGroup = pickerGroups.value.find((g) => g.aggregation)
    expect(routeGroup?.models.find((m) => m.id === 'quota-route')?.hitEndpoint).toBe('Zhipu')
  })

  it('额度耗尽端点不再显示命中（剩余 < threshold 落选）；缓存更新驱动重算恢复命中', async () => {
    const quotaStore = useQuotaStore()
    // pct 81 → 剩余 19 < threshold 20 → 端点落选（pi 生效判定同结论——「显示 ≡ 生效」）
    quotaStore.setCache('zhipu', quotaRow(81), Date.now())
    const { pickerGroups } = useModelPickerData()
    await flushPromises()
    const routeGroup = pickerGroups.value.find((g) => g.aggregation)
    expect(routeGroup?.models.find((m) => m.id === 'quota-route')?.hitEndpoint).toBeNull()

    // 缓存刷新（pct 80 → 剩余 20 ≥ 20）：reactive Map 依赖追踪驱动 pickerGroups 重算
    quotaStore.setCache('zhipu', quotaRow(80), Date.now())
    expect(pickerGroups.value.find((g) => g.aggregation)?.models.find((m) => m.id === 'quota-route')?.hitEndpoint).toBe('Zhipu')
  })
})
