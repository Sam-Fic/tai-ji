/**
 * 路由求值跨实现对拍（对照验证，differential testing；provider-aggregation r1-2 修复）：
 * 同一 fixture 矩阵喂 pi 扩展 evaluateRoute（extensions/universal/provider-aggregation，
 * pi 实际路由生效判定）与 UI evaluateRouteAt（@taiji/ui route-preview，选择器「此刻命中」
 * 可视权威），断言两侧同结论——任一侧判定式漂移（缺表语义、specials 覆盖顺序、额度
 * 换算方向等）对拍必红。
 *
 * 形态先例 = 本目录 aggregation-catalog-consistency.test.ts（同 fixture 喂注入器与扩展
 * 注册器的跨包相对路径 import；本文件同款装配，宿主选 runtime = 该先例同域，且 runtime
 * tsconfig 无 rootDir 约束可同时纳入两侧源码）。生产代码边界不破：UI 运行时代码不
 * import 扩展侧（route-preview.ts 头注释契约），本文件是测试域内的对拍装配。
 *
 * 求值输入对齐：两侧共享同一 Date（NOW）——UI 侧坐标经 nowFromClock 派生、日期键经
 * 本文件 localIso 派生，扩展侧直接消费 Date（本地时区语义两侧同轴）；额度快照同一张
 * Map 同时喂扩展 quotaByProviderId 与 UI quotaOf。协调世界时无关：两侧各自用本地取值，
 * 同一进程内一致。
 */
import { describe, expect, it } from 'vitest'
import type {
  AggregationMember,
  AggregationRoute,
  AggregationSpecialDate,
  AggregationTimeWindowTable,
} from '@taiji/shared'
import { evaluateRouteAt, blankWindowTable, fmtSlot, nowFromClock } from '../../../../../packages/ui/src/features/settings/provider/route-preview.ts'
import { evaluateRoute, type RouteQuotaSnapshot } from '../../../../../extensions/universal/provider-aggregation/src/router.ts'

/** 固定求值墙钟（2026-05-11 周一 10:00 本地时区；槽边界整点，坐标确定）。 */
const NOW = new Date(2026, 4, 11, 10, 0)
const NOW_COORD = nowFromClock(NOW)

/** 本地日期 `YYYY-MM-DD`（与扩展 formatLocalDate / UI todayLocalIso 同语义的测试侧镜像）。 */
function localIso(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

const TODAY = localIso(NOW)

function memberOf(overrides: Partial<AggregationMember> & Pick<AggregationMember, 'id'>): AggregationMember {
  return { providerId: 'prov-a', modelId: 'm-a', type: 'none', ...overrides }
}

function routeOf(members: AggregationMember[], overrides: Partial<AggregationRoute> = {}): AggregationRoute {
  return {
    id: 'route-x',
    name: 'Route X',
    modelId: 'route-x',
    enabled: true,
    mode: 'advanced',
    specials: [],
    members,
    ...overrides,
  }
}

/** 周表：仅目标格（NOW 所在 dow/slot）涂 value，其余全 false。 */
function tableAtNow(value: boolean): AggregationTimeWindowTable {
  const table = blankWindowTable()
  table[NOW_COORD.dow]![NOW_COORD.slot] = value
  return table
}

/** include 型特殊日期：from/to 按 HH:mm（offsetSlots = 0 覆盖目标格，> 0 不覆盖）。 */
function includeSpecial(offsetSlots: number): AggregationSpecialDate {
  return {
    id: `sp-include-${offsetSlots}`,
    date: TODAY,
    mode: 'include',
    from: fmtSlot(NOW_COORD.slot + offsetSlots),
    to: fmtSlot(NOW_COORD.slot + offsetSlots + 1),
  }
}

function excludeSpecial(): AggregationSpecialDate {
  return { id: 'sp-exclude', date: TODAY, mode: 'exclude' }
}

/** 对拍执行：同一 route + 额度快照喂两侧，断言命中端点下标同结论（null = 双侧无命中）。 */
function assertSameHit(route: AggregationRoute, quota?: Map<string, RouteQuotaSnapshot>): number | null {
  const quotaOf = quota ? (pid: string) => quota.get(pid)?.percent : undefined
  const ext = evaluateRoute({ route, now: NOW, quotaByProviderId: quota })
  const ui = evaluateRouteAt(route, NOW_COORD, { quotaOf, nowDate: TODAY })
  const extHit = ext.outcome === 'candidates' ? ext.memberIndexes[0]! : null
  expect(ui.hitIndex).toBe(extHit)
  return extHit
}

describe('跨实现对拍：扩展 evaluateRoute ⇔ UI evaluateRouteAt（同一 fixture 矩阵同结论）', () => {
  const quotaHalfLeft = new Map<string, RouteQuotaSnapshot>([['prov-a', { percent: 20 }]]) // 剩余 80 ≥ 50
  const quotaExhausted = new Map<string, RouteQuotaSnapshot>([['prov-a', { percent: 80 }]]) // 剩余 20 < 50

  // 缺表语义（r1-2 修复的核心分歧点）：扩展侧 fail-open 被 route-matrix.test.ts 锁定，
  // UI 侧修复前对同一输入判不命中——本组用例即两侧结论曾经相反的形态。
  it('window 缺表（字段留驻）→ 两侧同判命中（fail-open：缺失数据不判死）', () => {
    const m = memberOf({ id: 'm1', type: 'window' })
    expect(assertSameHit(routeOf([m]))).toBe(0)
  })

  it('combo 缺表 + 额度满足 → 两侧同判命中（缺表 = 无约束）', () => {
    const m = memberOf({ id: 'm1', type: 'combo', quota: { thresholdPercent: 50 } })
    expect(assertSameHit(routeOf([m]), quotaHalfLeft)).toBe(0)
  })

  it('combo 缺表 + 额度耗尽 → 两侧同判落选（缺表只豁免时间维，不豁免额度维）', () => {
    const m = memberOf({ id: 'm1', type: 'combo', quota: { thresholdPercent: 50 } })
    expect(assertSameHit(routeOf([m]), quotaExhausted)).toBeNull()
  })

  // specials 覆盖顺序（r1-2 修复的第二处分歧：UI 修复前先判缺表，specials 覆盖被短路）。
  it('缺表 + specials exclude 当日 → 两侧同判落选（specials 先于缺表判定）', () => {
    const m = memberOf({ id: 'm1', type: 'window' })
    expect(assertSameHit(routeOf([m], { specials: [excludeSpecial()] }))).toBeNull()
  })

  it('缺表 + specials include 覆盖当前格 → 两侧同判命中', () => {
    const m = memberOf({ id: 'm1', type: 'window' })
    expect(assertSameHit(routeOf([m], { specials: [includeSpecial(0)] }))).toBe(0)
  })

  it('缺表 + specials include 区间外 → 回落周表缺表 fail-open，两侧同判命中', () => {
    const m = memberOf({ id: 'm1', type: 'window' })
    expect(assertSameHit(routeOf([m], { specials: [includeSpecial(2)] }))).toBe(0)
  })

  // 周表在场的常规形态（两侧本来一致的语义，防回归基线）。
  it('window 表目标格为 true → 两侧同判命中；全 false → 两侧同判落选', () => {
    const hit = memberOf({ id: 'm1', type: 'window', window: tableAtNow(true) })
    expect(assertSameHit(routeOf([hit]))).toBe(0)
    const miss = memberOf({ id: 'm1', type: 'window', window: tableAtNow(false) })
    expect(assertSameHit(routeOf([miss]))).toBeNull()
  })

  it('周表命中 + specials exclude 当日 → 两侧同判落选（specials 覆盖周表，D13）', () => {
    const m = memberOf({ id: 'm1', type: 'window', window: tableAtNow(true) })
    expect(assertSameHit(routeOf([m], { specials: [excludeSpecial()] }))).toBeNull()
  })

  it('周表全 false + specials include 覆盖当前格 → 两侧同判命中', () => {
    const m = memberOf({ id: 'm1', type: 'window', window: tableAtNow(false) })
    expect(assertSameHit(routeOf([m], { specials: [includeSpecial(0)] }))).toBe(0)
  })

  // 额度维度（换算方向同型：剩余 = 100 − 已用）。
  it('quota 快照剩余充足 / 数据未知 / 低于阈值 → 两侧同结论', () => {
    const m = memberOf({ id: 'm1', type: 'quota', quota: { thresholdPercent: 50 } })
    expect(assertSameHit(routeOf([m]), quotaHalfLeft)).toBe(0)
    expect(assertSameHit(routeOf([m]), new Map())).toBe(0) // 快照缺 provider 键 = 未知 fail-open
    expect(assertSameHit(routeOf([m]), quotaExhausted)).toBeNull()
  })

  // 组合与排序语义（首命中即停 / 逐端点条件）。
  it('combo 双条件同满足 → 命中；combo 仅时间维满足 → 落选', () => {
    const ok = memberOf({ id: 'm1', type: 'combo', window: tableAtNow(true), quota: { thresholdPercent: 50 } })
    expect(assertSameHit(routeOf([ok]), quotaHalfLeft)).toBe(0)
    const bad = memberOf({ id: 'm1', type: 'combo', window: tableAtNow(true), quota: { thresholdPercent: 50 } })
    expect(assertSameHit(routeOf([bad]), quotaExhausted)).toBeNull()
  })

  it('首位落选次位命中 → 两侧同报命中下标 1；simple 模式恒取首端点', () => {
    const blocked = memberOf({ id: 'm1', type: 'window', window: tableAtNow(false) })
    const free = memberOf({ id: 'm2', type: 'none' })
    expect(assertSameHit(routeOf([blocked, free]))).toBe(1)
    expect(assertSameHit(routeOf([blocked, free], { mode: 'simple' }))).toBe(0)
  })

  it('全端点落选 → 两侧同判无命中（null）', () => {
    const blocked = memberOf({ id: 'm1', type: 'window', window: tableAtNow(false) })
    const exhausted = memberOf({ id: 'm2', type: 'quota', quota: { thresholdPercent: 50 } })
    expect(assertSameHit(routeOf([blocked, exhausted]), quotaExhausted)).toBeNull()
  })
})
