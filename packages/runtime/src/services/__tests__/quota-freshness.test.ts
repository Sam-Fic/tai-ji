/**
 * quota-freshness.test（provider-aggregation A3/RL3 新鲜度单测）。
 *
 * 断言链（D3/SI1）：额度缓存数据「距上次成功取数超过阈值判未知 + 跨重置窗口判未知」
 * 语义的单源判定（isAggregationQuotaDataFresh，shared 契约根）与本单元编排的消费语义
 * （AggregationQuotaRefresher 触发点①②③的刷新对象推导与「过期才刷」过滤）。
 *
 * RL3 边界覆盖：阈值内/外、resetSec 跨窗、缓存缺失四型（条目缺失 / data 缺失投影 null /
 * lastFetchAt 缺失或非法 / resetSec 缺失——跨窗判定不参与，仅阈值判定生效）。
 *
 * 纯逻辑测试（TEST-STRATEGY 三档判据①档）：时间以参数注入（now / freshnessMs），
 * 零真实时钟、零 IO、零进程——fake timers 也不需要。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AggregationRoute } from '@taiji/shared'
import { AGGREGATION_QUOTA_FRESHNESS_MS, isAggregationQuotaDataFresh } from '@taiji/shared'
import {
  AggregationQuotaRefresher,
  collectQuotaBoundProviderIds,
  type AggregationQuotaRefresherDeps,
} from '../aggregation-quota-refresher.js'

const FRESH_MS = AGGREGATION_QUOTA_FRESHNESS_MS

// ── isAggregationQuotaDataFresh：RL3 判定单点 ────────────────────────────────────────

describe('isAggregationQuotaDataFresh', () => {
  it('阈值内 = 新鲜（true）', () => {
    const now = 1_000_000
    expect(isAggregationQuotaDataFresh({ lastFetchAt: now - FRESH_MS + 1, resetSecs: [null] }, now)).toBe(true)
  })

  it('阈值外 = 未知（false）——距上次成功取数超过阈值', () => {
    const now = 1_000_000
    expect(isAggregationQuotaDataFresh({ lastFetchAt: now - FRESH_MS - 1, resetSecs: [null] }, now)).toBe(false)
    expect(isAggregationQuotaDataFresh({ lastFetchAt: now - FRESH_MS * 2, resetSecs: [null] }, now)).toBe(false)
  })

  it('阈值边界 = 恰在阈值点仍新鲜（「超过」为严格大于，D3 逐字语义）', () => {
    const now = 1_000_000
    expect(isAggregationQuotaDataFresh({ lastFetchAt: now - FRESH_MS, resetSecs: [] }, now)).toBe(true)
    expect(isAggregationQuotaDataFresh({ lastFetchAt: now - FRESH_MS - 1, resetSecs: [] }, now)).toBe(false)
  })

  it('resetSec 跨窗 = 未知（快照预期重置点已过，数据属已结束周期）', () => {
    const now = 1_000_000
    // 取数发生在 60s 前，快照声明重置点在 30s 后（resetSec=30）——now 时重置点（lastFetchAt+30s）已过 30s → 跨窗
    const lastFetchAt = now - 60_000
    expect(isAggregationQuotaDataFresh({ lastFetchAt, resetSecs: [30] }, now)).toBe(false)
  })

  it('resetSec 未跨窗 = 新鲜（重置点在未来，即使已过部分时间）', () => {
    const now = 1_000_000
    const lastFetchAt = now - 60_000
    expect(isAggregationQuotaDataFresh({ lastFetchAt, resetSecs: [120] }, now)).toBe(true)
  })

  it('跨窗判定按任一窗口生效（多窗任一重置点已过即未知）', () => {
    const now = 1_000_000
    const lastFetchAt = now - 60_000
    // 月窗重置点远（未跨），5h 窗重置点 30s 后于取数（已过 30s，跨）→ 未知
    expect(isAggregationQuotaDataFresh({ lastFetchAt, resetSecs: [30, 3600, null] }, now)).toBe(false)
    // 全部窗口未跨 → 新鲜
    expect(isAggregationQuotaDataFresh({ lastFetchAt, resetSecs: [120, 3600, 86_400] }, now)).toBe(true)
  })

  it('resetSec 缺失（null/undefined）的窗口不参与跨窗判定——仅阈值判定生效', () => {
    const now = 1_000_000
    const lastFetchAt = now - 60_000 // 阈值内
    expect(isAggregationQuotaDataFresh({ lastFetchAt, resetSecs: [null, undefined] }, now)).toBe(true)
    // 同形态但超阈值 → 未知（阈值判定不受 resetSec 缺失影响）
    expect(isAggregationQuotaDataFresh({ lastFetchAt: now - FRESH_MS - 1, resetSecs: [null] }, now)).toBe(false)
  })

  it('缓存缺失型：lastFetchAt 缺失/非法（null/undefined/NaN/0/负数）= 未知', () => {
    const now = 1_000_000
    expect(isAggregationQuotaDataFresh({ lastFetchAt: null, resetSecs: [60] }, now)).toBe(false)
    expect(isAggregationQuotaDataFresh({ lastFetchAt: undefined, resetSecs: [60] }, now)).toBe(false)
    expect(isAggregationQuotaDataFresh({ lastFetchAt: Number.NaN, resetSecs: [60] }, now)).toBe(false)
    expect(isAggregationQuotaDataFresh({ lastFetchAt: 0, resetSecs: [60] }, now)).toBe(false)
    expect(isAggregationQuotaDataFresh({ lastFetchAt: -5, resetSecs: [60] }, now)).toBe(false)
  })

  it('freshnessMs 可注入（判定语义与常量解耦，调用方按配置点传值）', () => {
    const now = 1_000_000
    expect(isAggregationQuotaDataFresh({ lastFetchAt: now - 500, resetSecs: [] }, now, 400)).toBe(false)
    expect(isAggregationQuotaDataFresh({ lastFetchAt: now - 500, resetSecs: [] }, now, 600)).toBe(true)
  })
})

// ── collectQuotaBoundProviderIds：刷新对象推导 ───────────────────────────────────────

function quotaMember(id: string, providerId: string, threshold = 80) {
  return { id, providerId, modelId: `model-${id}`, type: 'quota' as const, quota: { thresholdPercent: threshold } }
}
function comboMember(id: string, providerId: string) {
  return { id, providerId, modelId: `model-${id}`, type: 'combo' as const, quota: { thresholdPercent: 50 } }
}
function route(id: string, members: AggregationRoute['members'], overrides: Partial<AggregationRoute> = {}): AggregationRoute {
  return { id, name: `路由 ${id}`, modelId: id, enabled: true, mode: 'advanced', members, specials: [], ...overrides }
}

describe('collectQuotaBoundProviderIds', () => {
  it('收集启用中且含额度条件端点的路由引用 provider（quota + combo）', () => {
    const routes = [
      route('r1', [quotaMember('m1', 'zhipu'), comboMember('m2', 'opencode-go')]),
    ]
    expect(collectQuotaBoundProviderIds(routes)).toEqual(['zhipu', 'opencode-go'])
  })

  it('排除禁用路由（enabled=false）', () => {
    const routes = [route('r1', [quotaMember('m1', 'zhipu')], { enabled: false })]
    expect(collectQuotaBoundProviderIds(routes)).toEqual([])
  })

  it('排除 simple 模式路由（D12：simple 不判条件，无额度数据需求；切回 advanced 的保存动作即触发点①）', () => {
    const routes = [route('r1', [quotaMember('m1', 'zhipu')], { mode: 'simple' })]
    expect(collectQuotaBoundProviderIds(routes)).toEqual([])
  })

  it('排除非额度条件端点（none / window）与 quota 字段缺失的额度型端点（无从判死不猜阈值——router 同语义）', () => {
    const routes = [
      route('r1', [
        { id: 'a', providerId: 'p-none', modelId: 'm', type: 'none' },
        { id: 'b', providerId: 'p-window', modelId: 'm', type: 'window', window: [] as unknown as boolean[][] },
        { id: 'c', providerId: 'p-nofield', modelId: 'm', type: 'quota' },
      ]),
    ]
    expect(collectQuotaBoundProviderIds(routes)).toEqual([])
  })

  it('同 provider 多端点去重（刷新一次覆盖全部端点——QuotaService 按 provider 缓存）', () => {
    const routes = [
      route('r1', [quotaMember('m1', 'zhipu'), comboMember('m2', 'zhipu')]),
      route('r2', [quotaMember('m3', 'zhipu')]),
    ]
    expect(collectQuotaBoundProviderIds(routes)).toEqual(['zhipu'])
  })
})

// ── AggregationQuotaRefresher：触发点①②③编排语义 ──────────────────────────────────

function makeDeps(overrides: Partial<AggregationQuotaRefresherDeps> = {}): AggregationQuotaRefresherDeps & {
  fetchMany: ReturnType<typeof vi.fn>
  readRoutes: ReturnType<typeof vi.fn>
  getFreshnessProbe: ReturnType<typeof vi.fn>
} {
  const fetchMany = vi.fn(async (_ids: readonly string[]) => new Map())
  const readRoutes = vi.fn((): readonly AggregationRoute[] => [])
  const getFreshnessProbe = vi.fn((_id: string) => null)
  const deps = {
    fetchMany,
    readRoutes,
    getFreshnessProbe,
    getSessionModelRef: vi.fn((_sid: string) => undefined),
    // 判定墙钟固定（触发点③「过期才刷」过滤的确定性——fixture lastFetchAt 都以 NOW 锚定）
    now: () => NOW,
    ...overrides,
  } as AggregationQuotaRefresherDeps & {
    fetchMany: ReturnType<typeof vi.fn>
    readRoutes: ReturnType<typeof vi.fn>
    getFreshnessProbe: ReturnType<typeof vi.fn>
  }
  return deps
}

/** 触发点③ fixture 的判定墙钟锚（getFreshnessProbe 返回的 lastFetchAt 以此构造）。 */
const NOW = 1_000_000

describe('AggregationQuotaRefresher 触发点编排', () => {
  it('触发点① 路由配置保存：刷新全部额度条件引用 provider（不过滤新鲜度——保存是明确数据需求时刻，节流去重兜并发）', async () => {
    const deps = makeDeps({
      readRoutes: () => [
        route('r1', [quotaMember('m1', 'zhipu')]),
        route('r2', [{ id: 'w', providerId: 'p-win', modelId: 'm', type: 'window' }]),
      ],
    })
    const refresher = new AggregationQuotaRefresher(deps)
    await refresher.notifyRoutesChanged()
    expect(deps.fetchMany).toHaveBeenCalledTimes(1)
    expect(deps.fetchMany.mock.calls[0][0]).toEqual(['zhipu'])
  })

  it('触发点② set_model 绑定路由：非路由引用短路（不刷新）', async () => {
    const deps = makeDeps()
    const refresher = new AggregationQuotaRefresher(deps)
    await refresher.notifyRouteBound('zhipu/glm-5.3-flash')
    expect(deps.fetchMany).not.toHaveBeenCalled()
  })

  it('触发点② set_model 绑定路由：路由引用刷新该路由的额度 provider 集', async () => {
    const deps = makeDeps({
      readRoutes: () => [
        route('r1', [quotaMember('m1', 'zhipu'), comboMember('m2', 'opencode-go')]),
        route('r2', [quotaMember('m3', 'other')]),
      ],
    })
    const refresher = new AggregationQuotaRefresher(deps)
    await refresher.notifyRouteBound('aggregation/r1')
    expect(deps.fetchMany).toHaveBeenCalledTimes(1)
    expect(deps.fetchMany.mock.calls[0][0]).toEqual(['zhipu', 'opencode-go'])
  })

  it('触发点② 绑定引用解析不到 routes 定义（悬空/已删除）短路', async () => {
    const deps = makeDeps({ readRoutes: () => [] })
    const refresher = new AggregationQuotaRefresher(deps)
    await refresher.notifyRouteBound('aggregation/ghost')
    expect(deps.fetchMany).not.toHaveBeenCalled()
  })

  it('触发点③ 回合收尾（未绑定路由的会话）：短路（D1 ④ 零配置零行为）', async () => {
    const deps = makeDeps({ getSessionModelRef: () => 'zhipu/glm-5.3-flash' })
    const refresher = new AggregationQuotaRefresher(deps)
    await refresher.notifyAgentSettled('sid-1')
    expect(deps.fetchMany).not.toHaveBeenCalled()
  })

  it('触发点③ 绑定路由 + 数据过期：仅刷新过期子集（D3「过期才刷」）', async () => {
    const now = 1_000_000
    const deps = makeDeps({
      readRoutes: () => [route('r1', [quotaMember('m1', 'zhipu'), comboMember('m2', 'opencode-go')])],
      getSessionModelRef: () => 'aggregation/r1',
      getFreshnessProbe: (id: string) =>
        id === 'zhipu'
          ? { lastFetchAt: now - FRESH_MS - 1, resetSecs: [null] } // 超阈值 → 过期
          : { lastFetchAt: now - 1_000, resetSecs: [3_600] }, // 新鲜
    })
    const refresher = new AggregationQuotaRefresher(deps)
    await refresher.notifyAgentSettled('sid-1')
    expect(deps.fetchMany).toHaveBeenCalledTimes(1)
    expect(deps.fetchMany.mock.calls[0][0]).toEqual(['zhipu'])
  })

  it('触发点③ 绑定路由 + 数据全部新鲜：不发起刷新（AS11 触发密度收敛）', async () => {
    const now = 1_000_000
    const deps = makeDeps({
      readRoutes: () => [route('r1', [quotaMember('m1', 'zhipu')])],
      getSessionModelRef: () => 'aggregation/r1',
      getFreshnessProbe: (_id: string) => ({ lastFetchAt: now - 1_000, resetSecs: [null] }),
    })
    const refresher = new AggregationQuotaRefresher(deps)
    await refresher.notifyAgentSettled('sid-1')
    expect(deps.fetchMany).not.toHaveBeenCalled()
  })

  it('触发点③ 无缓存条目（缺失型①②）= 不新鲜 → 刷新', async () => {
    const deps = makeDeps({
      readRoutes: () => [route('r1', [quotaMember('m1', 'zhipu')])],
      getSessionModelRef: () => 'aggregation/r1',
      getFreshnessProbe: () => null,
    })
    const refresher = new AggregationQuotaRefresher(deps)
    await refresher.notifyAgentSettled('sid-1')
    expect(deps.fetchMany.mock.calls[0][0]).toEqual(['zhipu'])
  })

  it('错误隔离：fetchMany 失败不上抛（触发点调用方不被刷新失败阻断）', async () => {
    const deps = makeDeps({
      readRoutes: () => [route('r1', [quotaMember('m1', 'zhipu')])],
      fetchMany: async () => { throw new Error('network down') },
    })
    const refresher = new AggregationQuotaRefresher(deps)
    await expect(refresher.notifyRoutesChanged()).resolves.toBeUndefined()
  })

  it('错误隔离：readRoutes 抛错（配置读侧异常）不上抛', async () => {
    const deps = makeDeps({
      readRoutes: () => { throw new Error('extras file locked') },
    })
    const refresher = new AggregationQuotaRefresher(deps)
    await expect(refresher.notifyRouteBound('aggregation/r1')).resolves.toBeUndefined()
  })
})
