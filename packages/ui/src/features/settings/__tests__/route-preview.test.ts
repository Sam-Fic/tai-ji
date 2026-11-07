/**
 * route-preview 纯函数单测（provider-aggregation U5b · A28 可判定 UI 断言的逻辑半边）。
 *
 * 覆盖验收标准（impl-plan A28 行 + D12/D13/D14 决策的消费语义）：
 * ① nowFromClock 墙钟 → 路由坐标换算（dow ISO 化 / 半小时格取整）
 * ② evaluateRouteAt 此刻求值：simple 恒取首端点 / advanced 逐端点条件 / 全落选 /
 *    额度数据未知 fail-open（D5）/ 特殊日期优先于周表（D13 双型）
 * ③ coverOwnersAt 覆盖预览着色：首个无条件端点截断（D14）/ fb 兜底格 / 仅额度端点不入轴
 * ④ truncationInfo 截断警告数据
 * ⑤ levelsUnion 档位并集按序去重（D7）
 * ⑦ weekdayBusinessWindow / blankWindowTable 坐标契约（7×48）
 * ⑧ candidateProviderIds 添加端点候选（存在 / 启用 / 提供该模型 / 未被本路由占用）
 * ⑨ specialOverrideFor 同日期多条取第一条（spec 已知限制）
 *
 * 测试判据：全部第①档同步逻辑（函数进、返回值出），零 mount / 零 IO / 零 fake timer。
 */
import { describe, it, expect } from 'vitest'
import type { AggregationRoute, AggregationMember, ProviderId, ProviderInfo } from '@taiji/shared'
import {
  blankWindowTable,
  candidateProviderIds,
  coverOwnersAt,
  endpointIssueKinds,
  endpointProviderOptions,
  evaluateRouteAt,
  levelsUnion,
  nowFromClock,
  specialOverrideFor,
  truncationInfo,
  weekdayBusinessWindow,
} from '../provider/route-preview'
import { AGGREGATION_PROVIDER_ID, TIME_WINDOW_DAYS, TIME_WINDOW_SLOTS_PER_DAY } from '@taiji/shared'

function prov(overrides: Omit<Partial<ProviderInfo>, 'id'> & { id: string }): ProviderInfo {
  const id = overrides.id as ProviderId
  return {
    name: id,
    apiKeySet: true,
    status: 'connected',
    models: [],
    ...overrides,
    id,
  }
}

function member(overrides: Partial<AggregationMember> & Pick<AggregationMember, 'id' | 'providerId'>): AggregationMember {
  return { modelId: 'glm-5-3', type: 'none', ...overrides }
}

function routeOf(overrides: Partial<AggregationRoute> & Pick<AggregationRoute, 'members'>): AggregationRoute {
  return {
    id: 'glm-5-3',
    name: 'GLM-5.3 Flash（路由）',
    modelId: 'glm-5-3',
    enabled: true,
    mode: 'advanced',
    specials: [],
    ...overrides,
  }
}

const WED_1430 = { dow: 2, slot: 29 }

describe('nowFromClock 墙钟换算', () => {
  it('14:30 → slot 29（半小时格取整）', () => {
    // 2026-11-04 是周三
    const now = nowFromClock(new Date(2026, 10, 4, 14, 30))
    expect(now.dow).toBe(2)
    expect(now.slot).toBe(29)
  })

  it('周日映射为 dow 6（ISO 顺序：周一=0 … 周日=6）', () => {
    // 2026-11-08 是周日
    const now = nowFromClock(new Date(2026, 10, 8, 0, 0))
    expect(now.dow).toBe(6)
    expect(now.slot).toBe(0)
  })

  it('分钟向下取整到半小时格（14:59 → slot 29）', () => {
    const now = nowFromClock(new Date(2026, 10, 4, 14, 59))
    expect(now.slot).toBe(29)
  })
})

describe('evaluateRouteAt 此刻求值（D5 矩阵 UI 预览半边）', () => {
  it('simple 模式恒取第一个端点，不判条件', () => {
    const r = routeOf({
      mode: 'simple',
      members: [
        member({ id: 'a', providerId: 'zhipu', type: 'window', window: blankWindowTable() }),
        member({ id: 'b', providerId: 'opencode-go' }),
      ],
    })
    const result = evaluateRouteAt(r, WED_1430)
    expect(result.hit?.id).toBe('a')
    expect(result.steps[0]?.ok).toBe(true)
  })

  it('advanced 模式逐端点求值，命中第一个条件满足者', () => {
    const win = blankWindowTable()
    win[2][29] = true // 周三 14:30 在窗内
    const r = routeOf({
      mode: 'advanced',
      members: [
        member({ id: 'a', providerId: 'zhipu', type: 'window', window: win }),
        member({ id: 'b', providerId: 'opencode-go' }),
      ],
    })
    const result = evaluateRouteAt(r, WED_1430)
    expect(result.hit?.id).toBe('a')
    expect(result.steps[1]?.skipped).toBe(true)
  })

  it('时间窗外的窗端点落选（reason=out-window），落到无条件端点', () => {
    const r = routeOf({
      mode: 'advanced',
      members: [
        member({ id: 'a', providerId: 'zhipu', type: 'window', window: blankWindowTable() }),
        member({ id: 'b', providerId: 'opencode-go' }),
      ],
    })
    const result = evaluateRouteAt(r, WED_1430)
    expect(result.steps[0]?.ok).toBe(false)
    expect(result.steps[0]?.reason).toBe('out-window')
    expect(result.hit?.id).toBe('b')
    expect(result.steps[1]?.reason).toBe('unconditional')
  })

  it('全部端点落选 → hit null（此刻无可用端点）', () => {
    const r = routeOf({
      mode: 'advanced',
      members: [member({ id: 'a', providerId: 'zhipu', type: 'window', window: blankWindowTable() })],
    })
    expect(evaluateRouteAt(r, WED_1430).hit).toBeNull()
  })

  it('额度条件在数据未知时按满足处理（fail-open，D5）', () => {
    const r = routeOf({
      mode: 'advanced',
      members: [member({ id: 'a', providerId: 'zhipu', type: 'quota', quota: { thresholdPercent: 80 } })],
    })
    const result = evaluateRouteAt(r, WED_1430)
    expect(result.hit?.id).toBe('a')
    expect(result.steps[0]?.reason).toBe('quota-unknown-open')
  })

  it('额度数据就位时按阈值判定（quotaOf 供给已用百分比，剩余换算后比阈值）', () => {
    const r = routeOf({
      mode: 'advanced',
      members: [member({ id: 'a', providerId: 'zhipu', type: 'quota', quota: { thresholdPercent: 80 } })],
    })
    // quotaOf 返回值 = 缓存已用百分比（QuotaWindow.pct 口径）：已用 30 → 剩余 70 < 80 → 落选
    const low = evaluateRouteAt(r, WED_1430, { quotaOf: () => 30 })
    expect(low.hit).toBeNull()
    expect(low.steps[0]?.reason).toBe('quota-low')
    // 已用 15 → 剩余 85 ≥ 80 → 命中
    const ok = evaluateRouteAt(r, WED_1430, { quotaOf: () => 15 })
    expect(ok.hit?.id).toBe('a')
    expect(ok.steps[0]?.reason).toBe('quota-ok')
  })

  it('combo 条件：时间窗内 + 额度满足才命中', () => {
    const win = blankWindowTable()
    win[2][29] = true
    const r = routeOf({
      mode: 'advanced',
      members: [
        member({ id: 'a', providerId: 'zhipu', type: 'combo', window: win, quota: { thresholdPercent: 50 } }),
      ],
    })
    // 已用 10 → 剩余 90 ≥ 50 → 额度满足命中；已用 60 → 剩余 40 < 50 → 落选
    expect(evaluateRouteAt(r, WED_1430, { quotaOf: () => 10 }).hit?.id).toBe('a')
    expect(evaluateRouteAt(r, WED_1430, { quotaOf: () => 60 }).hit).toBeNull()
    // 窗外即使额度充足也落选
    expect(evaluateRouteAt(r, { dow: 2, slot: 0 }, { quotaOf: () => 10 }).hit).toBeNull()
  })

  it('特殊日期 exclude 该日全天判窗外，优先于周表（D13）', () => {
    const win = weekdayBusinessWindow()
    win[2][29] = true
    const r = routeOf({
      mode: 'advanced',
      specials: [{ id: 's1', date: '2026-12-24', mode: 'exclude' }],
      members: [member({ id: 'a', providerId: 'zhipu', type: 'window', window: win })],
    })
    // 2026-12-24 是周四（dow 3）09:30 = slot 19：周表窗内，但 exclude 判窗外
    expect(evaluateRouteAt(r, { dow: 3, slot: 19 }, { nowDate: '2026-12-24' }).hit).toBeNull()
    // 同坐标无特殊日期时命中
    expect(evaluateRouteAt(r, { dow: 3, slot: 19 }).hit?.id).toBe('a')
  })

  it('特殊日期 include 仅指定区间判窗内，区间外回落周表（D13）', () => {
    const win = blankWindowTable() // 周表全空
    const r = routeOf({
      mode: 'advanced',
      specials: [{ id: 's1', date: '2026-12-24', mode: 'include', from: '20:00', to: '22:00' }],
      members: [member({ id: 'a', providerId: 'zhipu', type: 'window', window: win })],
    })
    // 21:00（slot 40）在 include 区间内 → 命中（V11 场景）
    expect(evaluateRouteAt(r, { dow: 3, slot: 40 }, { nowDate: '2026-12-24' }).hit?.id).toBe('a')
    // 10:00（slot 20）区间外且周表空 → 落选
    expect(evaluateRouteAt(r, { dow: 3, slot: 20 }, { nowDate: '2026-12-24' }).hit).toBeNull()
  })
})

describe('coverOwnersAt 覆盖预览着色（D14）', () => {
  it('首个无条件端点截断：其后时间窗端点不再着色', () => {
    const winB = blankWindowTable()
    winB[2][29] = true
    const winC = blankWindowTable()
    winC[2][29] = true
    const r = routeOf({
      members: [
        member({ id: 'a', providerId: 'zhipu' }), // 无条件，截断
        member({ id: 'b', providerId: 'opencode-go', type: 'window', window: winB }),
        member({ id: 'c', providerId: 'stepfun', type: 'window', window: winC }),
      ],
    })
    expect(coverOwnersAt(r, 2, 29)).toHaveLength(0)
  })

  it('无条件端点之前的窗端点正常着色（多端点多色）', () => {
    const winA = blankWindowTable()
    winA[2][29] = true
    const winB = blankWindowTable()
    winB[2][29] = true
    const r = routeOf({
      members: [
        member({ id: 'a', providerId: 'zhipu', type: 'window', window: winA }),
        member({ id: 'b', providerId: 'opencode-go', type: 'window', window: winB }),
        member({ id: 'c', providerId: 'stepfun' }),
      ],
    })
    const owners = coverOwnersAt(r, 2, 29)
    expect(owners.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('仅额度端点不进时间轴着色（spec §7.7）', () => {
    const r = routeOf({
      members: [member({ id: 'a', providerId: 'zhipu', type: 'quota', quota: { thresholdPercent: 80 } })],
    })
    expect(coverOwnersAt(r, 2, 29)).toHaveLength(0)
  })
})

describe('truncationInfo 截断警告数据（D14）', () => {
  it('无条件端点非最后位且其后有窗端点 → 警告', () => {
    const r = routeOf({
      members: [
        member({ id: 'a', providerId: 'zhipu' }),
        member({ id: 'b', providerId: 'opencode-go', type: 'window', window: blankWindowTable() }),
      ],
    })
    expect(truncationInfo(r)).toEqual({ unconditionalIndex: 0, suppressedAfter: true })
  })

  it('无条件端点在最后 → 无截断警告', () => {
    const r = routeOf({
      members: [
        member({ id: 'a', providerId: 'zhipu', type: 'window', window: blankWindowTable() }),
        member({ id: 'b', providerId: 'opencode-go' }),
      ],
    })
    expect(truncationInfo(r)?.suppressedAfter).toBe(false)
  })

  it('全条件无兜底 → null（显示无兜底条，不显示截断警告）', () => {
    const r = routeOf({
      members: [member({ id: 'a', providerId: 'zhipu', type: 'window', window: blankWindowTable() })],
    })
    expect(truncationInfo(r)).toBeNull()
  })
})

describe('endpointIssueKinds 端点异常标记（spec §4.5 配置保留优先）', () => {
  it('已删除渠道 → provider-deleted 标记', () => {
    const r = routeOf({ members: [member({ id: 'a', providerId: 'gone' })] })
    expect(endpointIssueKinds(r, [prov({ id: 'zhipu' })]).get(0)).toContain('provider-deleted')
  })

  it('已停用渠道 → provider-disabled 标记（设计 D9 责任语义：禁用仍使用）', () => {
    const r = routeOf({ members: [member({ id: 'a', providerId: 'zhipu' })] })
    expect(endpointIssueKinds(r, [prov({ id: 'zhipu', enabled: false })]).get(0)).toContain('provider-disabled')
  })

  it('渠道缺密钥 → no-key 标记', () => {
    const r = routeOf({ members: [member({ id: 'a', providerId: 'zhipu' })] })
    expect(endpointIssueKinds(r, [prov({ id: 'zhipu', apiKeySet: false })]).get(0)).toContain('no-key')
  })

  it('渠道在但模型已移除 → model-removed 标记', () => {
    const r = routeOf({ members: [member({ id: 'a', providerId: 'zhipu' })] })
    expect(endpointIssueKinds(r, [prov({ id: 'zhipu', models: [{ id: 'other' }] })]).get(0)).toContain('model-removed')
  })

  it('正常端点零标记', () => {
    const r = routeOf({ members: [member({ id: 'a', providerId: 'zhipu' })] })
    expect(endpointIssueKinds(r, [prov({ id: 'zhipu', models: [{ id: 'glm-5-3' }] })]).get(0)).toBeUndefined()
  })
})

describe('levelsUnion 档位并集（D7）', () => {
  it('端点档位并集按档位序去重', () => {
    const r = routeOf({
      members: [
        member({ id: 'a', providerId: 'zhipu', levels: { off: 'off', low: 'low', high: 'high' } }),
        member({ id: 'b', providerId: 'opencode-go', levels: { minimal: 'minimal', medium: 'medium' } }),
      ],
    })
    expect(levelsUnion(r)).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
  })

  it('端点缺 levels 声明按空集处理，null 键不代表支持', () => {
    const r = routeOf({
      members: [
        member({ id: 'a', providerId: 'zhipu', levels: { low: 'low', high: null } }),
        member({ id: 'b', providerId: 'opencode-go' }),
      ],
    })
    expect(levelsUnion(r)).toEqual(['low'])
  })
})

describe('时间窗表坐标契约（aggregation.ts TIME_WINDOW 常量同源）', () => {
  it('blankWindowTable 维度 = shared TIME_WINDOW 常量（7 行 × 48 列，单源断言）', () => {
    const t = blankWindowTable()
    expect(TIME_WINDOW_DAYS).toBe(7)
    expect(TIME_WINDOW_SLOTS_PER_DAY).toBe(48)
    expect(t).toHaveLength(TIME_WINDOW_DAYS)
    expect(t.every((row) => row.length === TIME_WINDOW_SLOTS_PER_DAY && row.every((c) => c === false))).toBe(true)
  })

  it('weekdayBusinessWindow = 周一~五 09:00-18:00（快捷涂抹「工作日白天」同源）', () => {
    const t = weekdayBusinessWindow()
    expect(t[0][18]).toBe(true) // 周一 09:00
    expect(t[0][35]).toBe(true) // 周一 17:30
    expect(t[0][36]).toBe(false) // 周一 18:00 窗外
    expect(t[5][18]).toBe(false) // 周六不在内
    expect(t[6][18]).toBe(false) // 周日不在内
  })
})

describe('candidateProviderIds 添加端点候选（spec §7.9）', () => {
  const providers = [
    prov({ id: 'zhipu', models: [{ id: 'glm-5-3' }] }),
    prov({ id: 'opencode-go', models: [{ id: 'glm-5-3' }] }),
    prov({ id: 'disabled-p', models: [{ id: 'glm-5-3' }], enabled: false }),
    prov({ id: 'no-model', models: [{ id: 'other' }] }),
    prov({ id: 'stepfun', models: [{ id: 'glm-5-3' }] }),
  ]

  it('只列启用 + 提供该模型 + 未被本路由占用的渠道', () => {
    const r = routeOf({
      members: [member({ id: 'a', providerId: 'zhipu' })],
    })
    expect(candidateProviderIds(r, providers)).toEqual(['opencode-go', 'stepfun'])
  })

  it('本路由全部渠道占用后无候选', () => {
    const r = routeOf({
      members: [
        member({ id: 'a', providerId: 'zhipu' }),
        member({ id: 'b', providerId: 'opencode-go' }),
        member({ id: 'c', providerId: 'stepfun' }),
      ],
    })
    expect(candidateProviderIds(r, providers)).toEqual([])
  })

  it('聚合条目一律不入选（kind=aggregation；路由 id 与聚合条目 models 撞名也不混入——嵌套路由拒绝，D4 ①/§1.3 ①）', () => {
    const agg = prov({ id: AGGREGATION_PROVIDER_ID, kind: 'aggregation', models: [{ id: 'glm-5-3' }] })
    const r = routeOf({
      id: 'glm-5-3',
      modelId: 'glm-5-3',
      members: [member({ id: 'a', providerId: 'zhipu' })],
    })
    // 撞名前提自证：聚合条目 models 含路由 modelId（settingsStore 全量下发形态），若无 kind 排除四条过滤本可满足
    expect(agg.models.some((m) => m.id === r.modelId)).toBe(true)
    const ids = candidateProviderIds(r, [...providers, agg])
    expect(ids).not.toContain(AGGREGATION_PROVIDER_ID)
    expect(ids).toEqual(['opencode-go', 'stepfun'])
  })

  it('endpointProviderOptions 换渠道候选同样排除聚合条目（含当前渠道保留路径）', () => {
    const agg = prov({ id: AGGREGATION_PROVIDER_ID, kind: 'aggregation', models: [{ id: 'glm-5-3' }] })
    const r = routeOf({
      id: 'glm-5-3',
      modelId: 'glm-5-3',
      members: [member({ id: 'a', providerId: 'zhipu' })],
    })
    const opts = endpointProviderOptions(r, member({ id: 'a', providerId: 'zhipu' }), [...providers, agg])
    expect(opts.map((o) => o.provider.id)).not.toContain(AGGREGATION_PROVIDER_ID)
    // 当前渠道 zhipu 保留（spec §7.8 异常标注语义），聚合条目排除
    expect(opts.map((o) => o.provider.id)).toEqual(['zhipu', 'opencode-go', 'stepfun'])
  })
})

describe('specialOverrideFor 特殊日期匹配（D13）', () => {
  it('同日期多条取第一条（spec 已知限制）', () => {
    const specials = [
      { id: 's1', date: '2026-12-24', mode: 'include', from: '20:00', to: '22:00' } as const,
      { id: 's2', date: '2026-12-24', mode: 'exclude' } as const,
    ]
    expect(specialOverrideFor(specials, '2026-12-24')?.id).toBe('s1')
    expect(specialOverrideFor(specials, '2026-12-25')).toBeUndefined()
  })
})
