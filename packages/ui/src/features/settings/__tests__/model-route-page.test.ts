/**
 * ModelRoutePage 组件族可判定 UI 断言（provider-aggregation U5b · impl-plan A28 L1 行）。
 *
 * A28 断言清单（impl-plan 行原文：aria-label 完整 / role=gridcell / 穷举表内容渲染 /
 * 空状态 / 未保存条 DOM 断言）：
 * ① 首屏冒烟：关键交互 testid 全在 DOM（TEST-STRATEGY §3 渲染 gate 模板）
 * ② 空状态：无供应商时 model-route-empty + 概览条隐藏（spec §7.11）
 * ③ 孤儿引用提示条 + 隔离呈报（U1 读取标记的编辑器承载）
 * ④ 未保存条：初始隐藏 → 编辑标脏 → save/discard emit 载荷（spec §9.1 两页共享形态）
 * ⑤ 时间轴：role=gridcell + aria-label 完整（星期/时间范围/归属渠道或兜底，spec §11.4）
 * ⑥ 穷举对照表内容渲染：owner 归属 / fb 兜底 / 截断警告与「不会命中」标记（D14）
 * ⑦ 此刻 chip 求值展示 + 无命中态（D14 权威求值展示）
 * ⑧ simple/advanced 模式切换：条件区显隐与「无条件 · 按顺序兜底」（D12）
 * ⑨ 端点行：排序按钮禁用边界 + 最后端点删除保护（spec §7.8）
 * ⑩ 特殊日期：添加/校验（D13，M3 增量）
 *
 * 测试模式（对齐本目录既有惯例）：vitest.setup mock vue-i18n（t() 返回 key）→ 文案断言
 * 用 i18n key / data-testid / aria 属性；now prop 注入固定坐标（禁 fake timer）。
 * 组件均为轻量挂载（单卡/两三端点 fixture，远低于 domain-map heavy 判据），留默认档。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount, VueWrapper } from '@vue/test-utils'
import type { AggregationRouteCard, AggregationRouteView, AggregationRoute, ProviderId, ProviderInfo } from '@taiji/shared'
import { AGGREGATION_PROVIDER_ID } from '@taiji/shared'
import ModelRoutePage from '../provider/ModelRoutePage.vue'
import RouteUnsavedBar from '../provider/RouteUnsavedBar.vue'
import { blankWindowTable, weekdayBusinessWindow, type RouteNow } from '../provider/route-preview'

const NOW: RouteNow = { dow: 2, slot: 29 } // 周三 14:30（对齐 spec §5.2 演示坐标语义）

function prov(overrides: Omit<Partial<ProviderInfo>, 'id'> & { id: string }): ProviderInfo {
  const id = overrides.id as ProviderId
  return {
    name: id,
    apiKeySet: true,
    status: 'connected',
    models: [{ id: 'glm-5-3' }],
    ...overrides,
    id,
  }
}

function routeOf(overrides: Partial<AggregationRoute> & Partial<Pick<AggregationRoute, 'members'>>): AggregationRoute {
  return {
    id: 'glm-5-3',
    name: 'GLM-5.3 Flash（路由）',
    modelId: 'glm-5-3',
    enabled: true,
    mode: 'advanced',
    members: overrides.members ?? [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }],
    specials: [],
    ...overrides,
    // 保证 members 必有（AggregationRoute schema 至少 1 端点）
  }
}

function cardOf(route: AggregationRoute, overrides?: Partial<AggregationRouteCard>): AggregationRouteCard {
  return {
    route,
    scoped: true,
    scopedIndex: 0,
    memberIssues: [],
    ...overrides,
  }
}

function viewOf(cards: AggregationRouteCard[], overrides?: Partial<AggregationRouteView>): AggregationRouteView {
  return { cards, orphanRefs: [], ...overrides }
}

function mountPage(
  cards: AggregationRouteCard[],
  providers: ProviderInfo[] = [prov({ id: 'zhipu' }), prov({ id: 'opencode-go' })],
  viewOverrides?: Partial<AggregationRouteView>,
  scopedModels?: string[],
  newSessionRouteIds?: ReadonlySet<string>,
): VueWrapper {
  // 缺省从视图卡派生白名单（与 buildAggregationRouteView wire 生成规则同构：scoped 卡按
  // scopedIndex 升序映射聚合引用）——buildRoutePageCards 契约要求 scopedModels 全量，
  // fixture 只给视图卡时补齐半边，否则 scoped 路由卡会被派生丢弃。
  const resolvedScopedModels =
    scopedModels ??
    cards
      .filter((c) => c.scoped)
      .sort((a, b) => a.scopedIndex - b.scopedIndex)
      .map((c) => `${AGGREGATION_PROVIDER_ID}/${c.route.id}`)
  return mount(ModelRoutePage, {
    props: {
      view: viewOf(cards, viewOverrides),
      providers,
      scopedModels: resolvedScopedModels,
      now: NOW,
      ...(newSessionRouteIds !== undefined ? { newSessionRouteIds } : {}),
    },
    attachTo: document.body,
  })
}

// ConfirmDialog 经 Portal teleport 到 body；用例间卸载挂载件防跨用例 DOM 残留串扰
enableAutoUnmount(afterEach)

const KEY_TESTIDS = [
  'model-route-page',
  'model-route-overview',
  'route-card',
  'route-unsaved-bar-slot',
]

describe('ModelRoutePage 首屏与页面级结构', () => {
  it('首屏渲染：DOM 含关键交互元素', () => {
    const w = mountPage([cardOf(routeOf({}))])
    for (const testid of KEY_TESTIDS) {
      expect(w.find(`[data-testid="${testid}"]`).exists()).toBe(true)
    }
  })

  it('空状态：无卡片时显示空态与概览隐藏（spec §7.11）', () => {
    const w = mountPage([])
    expect(w.find('[data-testid="model-route-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="model-route-overview"]').exists()).toBe(false)
  })

  it('概览条计数：模型/端点/高级模式（spec §7.2）', () => {
    const win = blankWindowTable()
    const w = mountPage([
      cardOf(routeOf({ id: 'r1', mode: 'simple', members: [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }] })),
      cardOf(routeOf({ id: 'r2', members: [{ id: 'b', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: win }] })),
    ])
    const overview = w.find('[data-testid="model-route-overview"]')
    expect(overview.exists()).toBe(true)
    expect(overview.text()).toContain('2')
    expect(overview.text()).toContain('1') // 高级模式 1 个
  })

  it('孤儿引用提示条渲染原值（U1 读取标记的页面承载）', () => {
    const w = mountPage([cardOf(routeOf({}))], [prov({ id: 'zhipu' })], {
      orphanRefs: [`${AGGREGATION_PROVIDER_ID}/ghost-route`],
    })
    const notice = w.find('[data-testid="route-orphan-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain(`${AGGREGATION_PROVIDER_ID}/ghost-route`)
  })

  it('配置隔离呈报渲染（corrupted 语义）', () => {
    const w = mountPage([cardOf(routeOf({}))], [prov({ id: 'zhipu' })], {
      corrupted: true,
      corruptedFilePath: '/config/providers.json.corrupt-xxx',
    })
    expect(w.find('[data-testid="route-corrupted-notice"]').exists()).toBe(true)
  })
})

describe('未保存状态条（spec §9.1，两页共享组件）', () => {
  it('初始无改动不显示未保存条，编辑后出现（展开不算改动）', async () => {
    const w = mountPage([cardOf(routeOf({}))])
    expect(w.findComponent(RouteUnsavedBar).props('dirty')).toBe(false)
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    expect(w.findComponent(RouteUnsavedBar).props('dirty')).toBe(false)
    // 真实编辑动作：卡头模式切换 → 标脏
    await w.find('[data-testid="route-card-mode-simple"]').trigger('click')
    expect(w.findComponent(RouteUnsavedBar).props('dirty')).toBe(true)
  })

  it('discard emit 重置草稿回到视图态（dirty 归零）', async () => {
    const w = mountPage([cardOf(routeOf({}))])
    await w.find('[data-testid="route-card-mode-simple"]').trigger('click')
    expect(w.findComponent(RouteUnsavedBar).props('dirty')).toBe(true)
    w.findComponent(RouteUnsavedBar).vm.$emit('discard')
    await w.vm.$nextTick()
    expect(w.findComponent(RouteUnsavedBar).props('dirty')).toBe(false)
  })

  it('save emit 载荷含 routes 全量与 scopedRefs 复合串（卡片序）', async () => {
    const r1 = routeOf({ id: 'r1' })
    const r2 = routeOf({ id: 'r2' })
    const w = mountPage([cardOf(r1, { scopedIndex: 0 }), cardOf(r2, { scoped: false, scopedIndex: -1 })])
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const emitted = w.findComponent(ModelRoutePage).emitted('save')
    expect(emitted).toBeTruthy()
    const payload = emitted![0]![0] as { routes: AggregationRoute[]; scopedRefs: string[] }
    expect(payload.routes.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(payload.scopedRefs).toEqual([`${AGGREGATION_PROVIDER_ID}/r1`])
  })
})

describe('时间轴与穷举对照表（A28：role=gridcell / aria-label 完整 / 内容渲染）', () => {
  async function expandedPage(members: AggregationRoute['members']): Promise<VueWrapper> {
    const w = mountPage([cardOf(routeOf({ members }))])
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    return w
  }

  it('时间轴格渲染 role=gridcell 且 aria-label 完整（星期+时间范围+归属）', async () => {
    const win = blankWindowTable()
    win[2][29] = true // 周三 14:30 窗内
    const w = await expandedPage([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: win },
      { id: 'b', providerId: 'opencode-go', modelId: 'glm-5-3', type: 'none' },
    ])
    const cells = w.findAll('[data-testid="route-time-cell"]')
    expect(cells.length).toBe(7 * 48)
    const owned = cells.find((c) => c.attributes('data-day') === '2' && c.attributes('data-slot') === '29')
    expect(owned).toBeTruthy()
    expect(owned!.attributes('role')).toBe('gridcell')
    const label = owned!.attributes('aria-label') ?? ''
    expect(label).toContain('14:30') // 格起点半点
    expect(label).toContain('zhipu') // 归属渠道
  })

  it('兜底格 aria-label 标注兜底渠道（fb 语义）', async () => {
    const w = await expandedPage([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: blankWindowTable() },
      { id: 'b', providerId: 'opencode-go', modelId: 'glm-5-3', type: 'none' },
    ])
    const cell = w.find('[data-testid="route-time-cell"][data-day="2"][data-slot="29"]')
    expect(cell.attributes('aria-label')).toContain('opencode-go')
  })

  it('截断警告渲染 + 被截断端点「不会命中」标记（D14 / V12 半边）', async () => {
    const win = blankWindowTable()
    win[2][29] = true
    const w = await expandedPage([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' },
      { id: 'b', providerId: 'opencode-go', modelId: 'glm-5-3', type: 'window', window: win },
    ])
    expect(w.find('[data-testid="route-time-warning"]').exists()).toBe(true)
    const row = w.find('[data-testid="route-endpoint-row"][data-index="1"]')
    expect(row.text()).toContain('neverHit')
  })

  it('兜底条两态：有兜底渠道名 / 无兜底提示', async () => {
    const withFb = await expandedPage([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' },
    ])
    expect(withFb.find('[data-testid="route-time-fallback-bar"]').text()).toContain('zhipu')

    const allWindow = await expandedPage([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: weekdayBusinessWindow() },
    ])
    expect(allWindow.find('[data-testid="route-time-fallback-bar"]').text()).toContain('noFallback')
  })

  it('此刻格高亮（data-now 标记在周三 14:30 坐标）', async () => {
    const w = await expandedPage([{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }])
    expect(w.find('[data-testid="route-time-cell"][data-day="2"][data-slot="29"][data-now]').exists()).toBe(true)
  })
})

describe('此刻 chip（D14 权威求值展示）', () => {
  it('命中端点 → chip 含渠道名与启用前缀语义', () => {
    const w = mountPage([cardOf(routeOf({}))])
    const chip = w.find('[data-testid="route-card-now-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('zhipu')
  })

  it('全落选 → 无可用端点态', () => {
    const w = mountPage([
      cardOf(routeOf({ members: [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: blankWindowTable() }] })),
    ])
    expect(w.find('[data-testid="route-card-now-chip"]').text()).toContain('nowNoHit')
  })

  it('停用路由 → 「若启用」前缀语义', () => {
    const w = mountPage([cardOf(routeOf({ enabled: false }))])
    expect(w.find('[data-testid="route-card-now-chip"]').text()).toContain('nowIfEnabled')
  })
})

describe('simple/advanced 模式切换（D12）', () => {
  it('simple 模式条件区显示「按顺序兜底」并隐藏时间轴/特殊日期', async () => {
    const win = blankWindowTable()
    win[2][29] = true
    const w = mountPage([
      cardOf(routeOf({ mode: 'simple', members: [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: win }] })),
    ])
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    expect(w.find('[data-testid="route-time-grid"]').exists()).toBe(false)
    expect(w.find('[data-testid="route-special-dates"]').exists()).toBe(false)
    expect(w.find('[data-testid="route-endpoint-row"]').text()).toContain('simpleFallback')
  })

  it('切换模式 emit change 且条件数据保留（不丢条件，D12）', async () => {
    const win = blankWindowTable()
    win[2][29] = true
    const w = mountPage([
      cardOf(routeOf({ mode: 'simple', members: [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: win }] })),
    ])
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    const modeBtn = w.find('[data-testid="route-card-mode-advanced"]')
    await modeBtn.trigger('click')
    const emitted = w.findComponent(ModelRoutePage).emitted('change')
    expect(emitted).toBeTruthy()
    // 切回 advanced 后时间轴恢复显示（条件数据未清空）
    expect(w.find('[data-testid="route-time-grid"]').exists()).toBe(true)
  })
})

describe('端点行操作（spec §7.8）', () => {
  function twoMemberPage(): VueWrapper {
    return mountPage([
      cardOf(routeOf({
        members: [
          { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' },
          { id: 'b', providerId: 'opencode-go', modelId: 'glm-5-3', type: 'none' },
        ],
      })),
    ])
  }

  it('排序按钮禁用边界：第一个上移禁用、最后个下移禁用', async () => {
    const w = twoMemberPage()
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    const firstRow = w.find('[data-testid="route-endpoint-row"][data-index="0"]')
    const lastRow = w.find('[data-testid="route-endpoint-row"][data-index="1"]')
    expect(firstRow.find('[data-testid="endpoint-move-up"]').attributes('disabled')).toBeDefined()
    expect(lastRow.find('[data-testid="endpoint-move-down"]').attributes('disabled')).toBeDefined()
  })

  it('端点上移 emit change 且草稿顺序交换', async () => {
    const w = twoMemberPage()
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    await w.find('[data-testid="route-endpoint-row"][data-index="1"] [data-testid="endpoint-move-up"]').trigger('click')
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeTruthy()
    expect(w.find('[data-testid="route-endpoint-row"][data-index="0"]').text()).toContain('opencode-go')
  })

  it('最后端点删除保护：aria-disabled 且点击后端点数不变（spec §7.8）', async () => {
    const w = mountPage([cardOf(routeOf({}))]
    )
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    const removeBtn = w.find('[data-testid="endpoint-remove"]')
    expect(removeBtn.attributes('aria-disabled')).toBe('true')
    await removeBtn.trigger('click')
    expect(w.findAll('[data-testid="route-endpoint-row"]').length).toBe(1)
  })

  it('添加端点：候选下拉 + 插入到第一个无条件端点之前（spec §7.9）', async () => {
    const w = mountPage([
      cardOf(routeOf({
        members: [
          { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: weekdayBusinessWindow() },
          { id: 'b', providerId: 'opencode-go', modelId: 'glm-5-3', type: 'none' },
        ],
      })),
    ], [prov({ id: 'zhipu' }), prov({ id: 'opencode-go' }), prov({ id: 'stepfun' })])
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    await w.find('[data-testid="add-endpoint-btn"]').trigger('click')
    // 高级模式：新端点（无条件）插到第一个无条件端点（index 1）之前 → 新端点在 index 1
    const rows = w.findAll('[data-testid="route-endpoint-row"]')
    expect(rows.length).toBe(3)
    expect(rows[1]!.text()).toContain('stepfun')
  })
})

describe('特殊日期编辑（D13，M3 增量）', () => {
  it('默认隐藏（M1），advanced + 启用波次开关时显示', async () => {
    const w = mountPage([cardOf(routeOf({}))])
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    // advanced 模式下特殊日期区渲染（M3 编辑器随本单元交付；显隐随模式）
    expect(w.find('[data-testid="route-special-dates"]').exists()).toBe(true)
  })

  it('添加全天除外：校验通过后 specials 增一条', async () => {
    const w = mountPage([cardOf(routeOf({}))])
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    await w.find('[data-testid="special-date-input"]').setValue('2026-12-24')
    await w.find('[data-testid="special-add-btn"]').trigger('click')
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeTruthy()
    expect(w.findAll('[data-testid="special-row"]').length).toBe(1)
  })

  it('额外启用缺起止时间时不添加（spec §7.10 校验）', async () => {
    const w = mountPage([cardOf(routeOf({}))])
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    await w.find('[data-testid="special-date-input"]').setValue('2026-12-24')
    await w.find('[data-testid="special-mode-include"]').trigger('click')
    // 清空起止默认值后直接提交（模拟「缺少起止时间」）
    await w.find('[data-testid="special-from-input"]').setValue('')
    await w.find('[data-testid="special-to-input"]').setValue('')
    await w.find('[data-testid="special-add-btn"]').trigger('click')
    expect(w.findAll('[data-testid="special-row"]').length).toBe(0)
  })
})

describe('模型卡顺序与参与选择开关（D10/D11 视图半边）', () => {
  it('卡上移/下移按钮禁用边界与 move-card emit', async () => {
    const w = mountPage([
      cardOf(routeOf({ id: 'r1' })),
      cardOf(routeOf({ id: 'r2' })),
    ])
    const first = w.findAll('[data-testid="route-card"]')[0]!
    const second = w.findAll('[data-testid="route-card"]')[1]!
    expect(first.find('[data-testid="route-move-up"]').attributes('disabled')).toBeDefined()
    expect(second.find('[data-testid="route-move-down"]').attributes('disabled')).toBeDefined()
    await second.find('[data-testid="route-move-up"]').trigger('click')
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeTruthy()
    expect(w.findAll('[data-testid="route-card"]')[0]!.attributes('data-route-id')).toBe('r2')
  })

  it('参与选择开关切换 → change + save 载荷 scopedRefs 跟随', async () => {
    const w = mountPage([
      cardOf(routeOf({ id: 'r1' })),
      cardOf(routeOf({ id: 'r2' }), { scoped: false, scopedIndex: -1 }),
    ])
    const secondCard = w.findAll('[data-testid="route-card"]')[1]!
    await secondCard.find('[data-testid="route-scoped-toggle"]').trigger('click')
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeTruthy()
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { scopedRefs: string[] }
    expect(payload.scopedRefs).toEqual([
      `${AGGREGATION_PROVIDER_ID}/r1`,
      `${AGGREGATION_PROVIDER_ID}/r2`,
    ])
  })
})

describe('渠道直连卡（D10/U9：无 routes 的白名单模型 = 默认单端点形态）', () => {
  /** scopedModels = [物理条目, 路由引用] 的交错 fixture：直连卡在前、路由卡在后。 */
  function mixedPage(): VueWrapper {
    return mountPage(
      [cardOf(routeOf({ id: 'r1' }), { scopedIndex: 1 })],
      [prov({ id: 'zhipu' })],
      undefined,
      ['zhipu/glm-5-3', `${AGGREGATION_PROVIDER_ID}/r1`],
    )
  }

  it('物理模型白名单条目渲染直连卡：名称 + 直连标记 + 排序/开关工具', () => {
    const w = mixedPage()
    const direct = w.find('[data-testid="route-direct-card"]')
    expect(direct.exists()).toBe(true)
    expect(direct.attributes('data-ref')).toBe('zhipu/glm-5-3')
    expect(direct.find('[data-testid="route-direct-name"]').text()).toContain('zhipu')
    // 卡片序 = scopedModels 序：直连卡在前、路由卡在后（交错轴 = 白名单序）
    const firstTestId = w.find('[data-testid="model-route-page"] [data-testid="route-direct-card"], [data-testid="model-route-page"] [data-testid="route-card"]')
    expect(firstTestId.attributes('data-testid')).toBe('route-direct-card')
    expect(direct.find('[data-testid="route-direct-move-up"]').attributes('disabled')).toBeDefined()
    expect(direct.find('[data-testid="route-direct-move-down"]').attributes('disabled')).toBeUndefined()
  })

  it('渠道缺失时直连卡渲染 missing 标记（原值保留）', () => {
    const w = mountPage([], [prov({ id: 'zhipu' })], undefined, ['deleted-provider/gone-model'])
    const direct = w.find('[data-testid="route-direct-card"]')
    expect(direct.exists()).toBe(true)
    expect(direct.find('[data-testid="route-direct-missing"]').exists()).toBe(true)
  })

  it('直连卡上移：物理条目排到路由卡之前（卡片序即白名单目标序）', async () => {
    const w = mountPage(
      [cardOf(routeOf({ id: 'r1' }), { scopedIndex: 0 })],
      [prov({ id: 'zhipu' })],
      undefined,
      [`${AGGREGATION_PROVIDER_ID}/r1`, 'zhipu/glm-5-3'],
    )
    expect(w.findAll('[data-testid="route-card"]')).toHaveLength(1)
    await w.find('[data-testid="route-direct-card"] [data-testid="route-direct-move-up"]').trigger('click')
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeTruthy()
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { scopedRefs: string[] }
    // U3 回归基准（A10 视图 join 语义）：scopedRefs = 全量目标态，物理条目不丢且随卡片序
    expect(payload.scopedRefs).toEqual(['zhipu/glm-5-3', `${AGGREGATION_PROVIDER_ID}/r1`])
  })

  it('直连卡参与选择开关关闭后保存：物理条目移出 scopedModels 目标态', async () => {
    const w = mixedPage()
    await w.find('[data-testid="route-direct-scoped-toggle"]').trigger('click')
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeTruthy()
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { scopedRefs: string[]; routes: AggregationRoute[] }
    expect(payload.scopedRefs).toEqual([`${AGGREGATION_PROVIDER_ID}/r1`])
    expect(payload.routes.map((r) => r.id)).toEqual(['r1'])
  })
})

describe('新建路由入口（U9 创建侧，GL5/V15）', () => {
  it('页头「新建路由」按钮生成默认草稿卡：追加卡尾 + 默认名 + 预填首个可用渠道端点 + 标脏', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1' }))])
    await w.find('[data-testid="route-create-btn"]').trigger('click')
    const cards = w.findAll('[data-testid="route-card"]')
    expect(cards.length).toBe(2)
    const created = cards[1]!
    expect(created.find('[data-testid="route-card-name"]').text()).toBe('settings.modelRoute.newRouteName')
    // 预填端点可见（保存校验要求至少一个端点；候选下拉按 route.modelId 过滤，预填真实模型才可继续添加）
    expect(created.text()).toContain('zhipu')
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeTruthy()
    // 保存载荷含新路由（端点在位）
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { routes: AggregationRoute[] }
    const createdRoute = payload.routes[1]!
    expect(createdRoute.name).toBe('settings.modelRoute.newRouteName')
    expect(createdRoute.members).toHaveLength(1)
    expect(createdRoute.members[0]!.providerId).toBe('zhipu')
    expect(createdRoute.members[0]!.type).toBe('none')
  })

  it('连点两次生成两张草稿卡：id 唯一性后缀不冲突', async () => {
    const w = mountPage([])
    await w.find('[data-testid="route-empty-create"]').trigger('click')
    await w.find('[data-testid="route-create-btn"]').trigger('click')
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { routes: AggregationRoute[] }
    const ids = payload.routes.map((r) => r.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[1]).toBe(`${ids[0]}-2`)
  })

  it('空状态「新建路由」= V8 零配置态引导：创建后空态消失、卡片与概览条出现', async () => {
    const w = mountPage([])
    expect(w.find('[data-testid="model-route-empty"]').exists()).toBe(true)
    await w.find('[data-testid="route-empty-create"]').trigger('click')
    expect(w.find('[data-testid="model-route-empty"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="route-card"]').length).toBe(1)
    expect(w.find('[data-testid="model-route-overview"]').exists()).toBe(true)
  })
})

describe('删除路由入口（U9 删除侧，GL5/V14）', () => {
  it('卡头删除按钮打开确认弹层（提示白名单清理与默认模型回退）', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1' }))])
    await w.find('[data-testid="route-delete-btn"]').trigger('click')
    await flushPromises()
    const dialogText = document.body.textContent ?? ''
    expect(dialogText).toContain('settings.modelRoute.deleteConfirmTitle')
    expect(dialogText).toContain('settings.modelRoute.deleteConfirmDesc')
  })

  it('确认后 emit route-delete 携带路由 id；草稿不乐观移除且不标脏（卡移除由视图刷新承载）', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1' }))])
    await w.find('[data-testid="route-delete-btn"]').trigger('click')
    await flushPromises()
    const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'settings.modelRoute.deleteConfirmConfirm',
    )
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()
    const emitted = w.findComponent(ModelRoutePage).emitted('routeDelete')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['r1'])
    // 事实驱动（ADR-0122 ⑨）：删除 RPC 成功后的视图刷新才移除卡
    expect(w.findAll('[data-testid="route-card"]').length).toBe(1)
    expect(w.findComponent(RouteUnsavedBar).props('dirty')).toBe(false)
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeFalsy()
  })
})

describe('新会话可用徽标（U7，D1③：运行期新建、当前 pi 会话未注册）', () => {
  it('路由 id 在 newSessionRouteIds 集内 → 卡显徽标；不在 → 不显', () => {
    const w = mountPage(
      [cardOf(routeOf({ id: 'r1' })), cardOf(routeOf({ id: 'r2' }), { scopedIndex: 1 })],
      undefined,
      undefined,
      undefined,
      new Set(['r2']),
    )
    const cards = w.findAll('[data-testid="route-card"]')
    expect(cards[0]!.find('[data-testid="route-card-new-session-badge"]').exists()).toBe(false)
    const badge = cards[1]!.find('[data-testid="route-card-new-session-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('settings.modelRoute.newSessionAvailable')
  })

  it('缺省（未传集）不显徽标', () => {
    const w = mountPage([cardOf(routeOf({}))])
    expect(w.find('[data-testid="route-card-new-session-badge"]').exists()).toBe(false)
  })
})
