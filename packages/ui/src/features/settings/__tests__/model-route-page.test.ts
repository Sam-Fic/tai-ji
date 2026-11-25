/**
 * ModelRoutePage 组件族可判定 UI 断言（provider-aggregation U5b · impl-plan A28 L1 行）。
 *
 * A28 断言清单（impl-plan 行原文：aria-label 完整 / role=gridcell / 穷举表内容渲染 /
 * 空状态 / 未保存条 DOM 断言）：
 * ① 首屏冒烟：关键交互 testid 全在 DOM（TEST-STRATEGY §3 渲染 gate 模板）
 * ② 空状态：无供应商时 model-route-empty + 概览条隐藏（spec §7.11）
 * ③ 孤儿引用提示条 + 隔离呈报（U1 读取标记的编辑器承载）
 * ④ 未保存条：初始隐藏 → 编辑标脏 → save/discard emit 载荷（spec §9.1 两页共享形态）
 * ⑤ 端点行内时间轴（spec §12 迁移）：role=gridcell + aria-label 完整（星期/时间范围/归属渠道）+ 拖涂取反与快捷涂抹
 * ⑥ 行内网格覆盖语义：覆盖/无覆盖对照 + 截断与「不会命中」标记 + 卡底兜底条（D14）
 * ⑦ 此刻 chip 求值展示 + 无命中态（D14 权威求值展示）
 * ⑧ simple/advanced 模式切换：条件区显隐与「无条件 · 按顺序兜底」（D12）
 * ⑨ 端点行：排序按钮禁用边界 + 最后端点删除保护（spec §7.8）
 * ⑩ 特殊日期：添加/校验（D13，M3 增量）
 *
 * 测试模式（对齐本目录既有惯例）：vitest.setup mock vue-i18n（t() 返回 key）→ 文案断言
 * 用 i18n key / data-testid / aria 属性；now prop 注入固定坐标（禁 fake timer）。
 * 组件均为轻量挂载（单卡/两三端点 fixture，远低于 domain-map heavy 判据），但本文件登记于
 * docs/testing/domain-map.json 的 settings 域排除清单，默认档不收集——用域触发档执行：
 * node scripts/run-domain-tests.mjs settings（或 TAIJI_TEST_DOMAIN=settings + vitest run）。
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { mount, flushPromises, enableAutoUnmount, VueWrapper } from '@vue/test-utils'
import type { AggregationRouteCard, AggregationRouteView, AggregationRoute, ProviderId, ProviderInfo } from '@taiji/shared'
import { AGGREGATION_PROVIDER_ID } from '@taiji/shared'
import ModelRoutePage from '../provider/ModelRoutePage.vue'
import RouteCard from '../provider/RouteCard.vue'
import RouteUnsavedBar from '../provider/RouteUnsavedBar.vue'
import { blankWindowTable, weekdayBusinessWindow, type RouteNow } from '../provider/route-preview'
import { SETTINGS_TOAST_KEY } from '../injection-keys'
import { pickSelectOption } from './helpers'

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

  it('概览条计数：模型/端点/高级模式/直连（spec §7.2）', () => {
    const win = blankWindowTable()
    const w = mountPage(
      [
        cardOf(routeOf({ id: 'r1', mode: 'simple', members: [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }] })),
        // r2 未参与选择（scoped=false）→ 跟在 scoped 段之后，仍计模型/端点/高级模式
        cardOf(routeOf({ id: 'r2', members: [{ id: 'b', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: win }] }), { scoped: false }),
      ],
      [prov({ id: 'zhipu' })],
      undefined,
      ['zhipu/glm-5-3', `${AGGREGATION_PROVIDER_ID}/r1`],
    )
    const overview = w.find('[data-testid="model-route-overview"]')
    expect(overview.exists()).toBe(true)
    // 卡片集合 = 直连卡 1 + 路由卡 2（r1 参与 + r2 未参与）；端点 = 直连计 1 + 各路由成员数
    expect(overview.text()).toContain('3')
    expect(overview.text()).toContain('3') // 端点合计 3
    expect(overview.text()).toContain('1') // 高级模式 1 个
    // 直连口径（新增）：1 个直连
    const directStat = w.find('[data-testid="model-route-overview-direct"]')
    expect(directStat.exists()).toBe(true)
    expect(directStat.text()).toContain('settings.modelRoute.overviewDirect')
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

describe('端点行内时间轴（spec §12 行内网格迁移：编辑时段展开 7×48，单端点可路由语义）', () => {
  /** 展开卡并打开第一个窗型端点的行内网格。 */
  async function gridPage(members: AggregationRoute['members']): Promise<VueWrapper> {
    const w = mountPage([cardOf(routeOf({ members }))])
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    await w.find('[data-testid="endpoint-edit-time"]').trigger('click')
    return w
  }

  it('编辑时段展开 7×48 行内网格：role=gridcell + aria 含星期/时间范围/归属渠道', async () => {
    const win = blankWindowTable()
    win[2][29] = true // 周三 14:30 窗内
    const w = await gridPage([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: win },
    ])
    const cells = w.findAll('[data-testid="route-time-cell"]')
    expect(cells.length).toBe(7 * 48)
    const owned = cells.find((c) => c.attributes('data-day') === '2' && c.attributes('data-slot') === '29')
    expect(owned).toBeTruthy()
    expect(owned!.attributes('role')).toBe('gridcell')
    const label = owned!.attributes('aria-label') ?? ''
    expect(label).toContain('14:30') // 格起点半点
    expect(label).toContain('zhipu') // 归属渠道
    // 覆盖格 = 该端点可路由（demo 绿格语义）：style 落 success 底
    expect(owned!.attributes('style')).toContain('success')
  })

  it('无覆盖格显 cellNoCover 语义（aria + surface 底），窗内/窗外对照', async () => {
    const win = blankWindowTable()
    win[2][29] = true
    const w = await gridPage([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: win },
    ])
    const empty = w.find('[data-testid="route-time-cell"][data-day="0"][data-slot="0"]')
    expect(empty.attributes('aria-label')).toContain('cellNoCover')
    expect(empty.classes()).toContain('bg-surface-2')
  })

  it('此刻格高亮（data-now 标记在周三 14:30 坐标）', async () => {
    const w = await gridPage([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: blankWindowTable() },
    ])
    expect(w.find('[data-testid="route-time-cell"][data-day="2"][data-slot="29"][data-now]').exists()).toBe(true)
  })

  it('拖涂首格取反：窗内格 pointerdown → 涂擦（endpoint-window-set value=false 落草稿）', async () => {
    const win = blankWindowTable()
    win[2][29] = true
    const w = await gridPage([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: win },
    ])
    await w.find('[data-testid="route-time-cell"][data-day="2"][data-slot="29"]').trigger('pointerdown')
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { routes: AggregationRoute[] }
    expect(payload.routes[0]!.members[0]!.window![2]![29]).toBe(false)
  })

  it('快捷涂抹「清空时段」作用于本端点（endpoint-window-replace 全空表）', async () => {
    const w = await gridPage([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: weekdayBusinessWindow() },
    ])
    await w.find('[data-testid="route-time-preset-clear"]').trigger('click')
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { routes: AggregationRoute[] }
    const table = payload.routes[0]!.members[0]!.window!
    expect(table.flat().every((v) => v === false)).toBe(true)
  })

  it('非窗型端点无「编辑时段」入口（仅额度端点不出行内网格；旧阻挡文案场景随迁移消亡）', async () => {
    const w = mountPage([
      cardOf(routeOf({ members: [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'quota', quota: { thresholdPercent: 20 } }] })),
    ])
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    expect(w.find('[data-testid="endpoint-edit-time"]').exists()).toBe(false)
    expect(w.find('[data-testid="route-time-cell"]').exists()).toBe(false)
  })

  it('截断/不命中标记在端点行（迁移后警告由行内 chip 承载）', async () => {
    const win = blankWindowTable()
    win[2][29] = true
    const w = await expandedCard([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' },
      { id: 'b', providerId: 'opencode-go', modelId: 'glm-5-3', type: 'window', window: win },
    ])
    expect(w.find('[data-testid="route-endpoint-row"][data-index="0"] [data-testid="endpoint-truncates"]').exists()).toBe(true)
    expect(w.find('[data-testid="route-endpoint-row"][data-index="1"] [data-testid="endpoint-never-hit"]').exists()).toBe(true)
  })

  /** 展开卡（不开网格）。 */
  async function expandedCard(members: AggregationRoute['members']): Promise<VueWrapper> {
    const w = mountPage([cardOf(routeOf({ members }))])
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    return w
  }

  it('兜底条两态：有兜底渠道名 / 无兜底提示（卡底承载，demo 同形）', async () => {
    const withFb = await expandedCard([{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }])
    expect(withFb.find('[data-testid="route-time-fallback-bar"]').text()).toContain('zhipu')

    const allWindow = await expandedCard([
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'window', window: weekdayBusinessWindow() },
    ])
    expect(allWindow.find('[data-testid="route-time-fallback-bar"]').text()).toContain('noFallback')
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
    expect(w.find('[data-testid="endpoint-edit-time"]').exists()).toBe(false)
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
    // 切回 advanced 后条件编辑入口恢复（编辑时段/条件分段在位 = 条件数据未清空）
    expect(w.find('[data-testid="endpoint-edit-time"]').exists()).toBe(true)
    expect(w.find('[data-testid="endpoint-condition-type"]').exists()).toBe(true)
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
  it('advanced 模式显示特殊日期编辑器、simple 模式隐藏（显隐随模式，无波次门控）', async () => {
    const w = mountPage([cardOf(routeOf({}))])
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    // advanced 模式下特殊日期区渲染（M3 编辑器随本单元交付；显隐判据 = route.mode === 'advanced'）
    expect(w.find('[data-testid="route-special-dates"]').exists()).toBe(true)

    // simple 模式隐藏（切模式条件保留，D12；显隐无历史「波次开关」门控）
    const simple = mountPage([cardOf(routeOf({ mode: 'simple' }))])
    await simple.find('[data-testid="route-card-toggle"]').trigger('click')
    expect(simple.find('[data-testid="route-special-dates"]').exists()).toBe(false)
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

  it('直连卡「移除」已落盘条目：确认对话框（白名单清理 + 默认回退提示）→ 确认后草稿摘除且保存载荷移除该条目', async () => {
    const w = mixedPage()
    await w.find('[data-testid="route-direct-card"] [data-testid="route-direct-remove"]').trigger('click')
    await flushPromises()
    // 确认对话框（RouteDirectCard 卡内承载，与删路由同款原语）
    const dialogText = document.body.textContent ?? ''
    expect(dialogText).toContain('settings.modelRoute.directRemoveConfirmTitle')
    expect(dialogText).toContain('settings.modelRoute.directRemoveConfirmDesc')
    expect(dialogText).toContain('zhipu / glm-5-3') // 名称插值进描述
    // 未确认前草稿不动（无乐观移除）
    expect(w.findAll('[data-testid="route-direct-card"]')).toHaveLength(1)
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeFalsy()

    const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'settings.modelRoute.directRemoveConfirmConfirm',
    )
    expect(confirmBtn).toBeTruthy()
    await confirmBtn!.click()
    await flushPromises()
    expect(w.findAll('[data-testid="route-direct-card"]')).toHaveLength(0)
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeTruthy()

    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { scopedRefs: string[] }
    // 白名单半边目标态不再含该物理条目（清理由保存承载，非即时写权威）
    expect(payload.scopedRefs).toEqual([`${AGGREGATION_PROVIDER_ID}/r1`])
  })

  it('直连卡「移除」未保存新卡：即时摘除无确认对话框（草稿内丢弃）', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1' }))], [
      prov({ id: 'zhipu', name: '智谱', models: [{ id: 'glm-4-6', name: 'GLM-4.6' }] }),
    ])
    await w.find('[data-testid="route-quick-provider-row"]').trigger('click')
    await w.find('[data-testid="route-quick-create-direct"]').trigger('click')
    expect(w.findAll('[data-testid="route-direct-card"]')).toHaveLength(1)
    await w.find('[data-testid="route-direct-card"] [data-testid="route-direct-remove"]').trigger('click')
    await flushPromises()
    // 无确认对话框（新增徽标条目 = 本会话草稿，丢弃不需确认）
    expect(document.body.textContent ?? '').not.toContain('settings.modelRoute.directRemoveConfirmTitle')
    expect(w.findAll('[data-testid="route-direct-card"]')).toHaveLength(0)
    // 面板行恢复可创建态（去重防护随草稿摘除解除）
    expect(w.find('[data-testid="route-quick-create-direct"]').exists()).toBe(true)
  })
})

describe('快速创建入口（spec §4：渠道展开加直连 / 筛选多选建高级路由）', () => {
  // jsdom 无 scrollIntoView（focus 定位与面板聚焦调用），测试级补桩
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {}
  })

  /** 展开第一个渠道的模型列表（点击渠道行）。 */
  async function expandFirstProvider(w: VueWrapper): Promise<void> {
    await w.find('[data-testid="route-quick-provider-row"]').trigger('click')
  }

  it('模型行「加直连」：草稿追加直连卡（卡尾 + 直连标记 + 新增徽标）+ 保存载荷 scopedRefs 含新条目', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1' }))], [
      prov({ id: 'zhipu', name: '智谱', models: [{ id: 'glm-4-6', name: 'GLM-4.6' }] }),
      prov({ id: 'moonshot' }),
    ])
    await expandFirstProvider(w)
    // 创建前：面板行显「加直连」入口（无「建简单路由」——入口已退役）
    expect(w.find('[data-testid="route-quick-create-direct"]').exists()).toBe(true)
    expect(w.find('[data-testid="route-quick-create-simple"]').exists()).toBe(false)
    await w.find('[data-testid="route-quick-create-direct"]').trigger('click')

    // 直连卡追加到草稿卡尾（direct 派生经 core buildDirectCard 单源）
    const directs = w.findAll('[data-testid="route-direct-card"]')
    expect(directs).toHaveLength(1)
    const direct = directs[0]!
    expect(direct.attributes('data-ref')).toBe('zhipu/glm-4-6')
    expect(direct.find('[data-testid="route-direct-name"]').text()).toContain('智谱')
    expect(direct.find('[data-testid="route-direct-name"]').text()).toContain('GLM-4.6')
    // 新增徽标（本编辑会话未落盘）
    expect(direct.find('[data-testid="route-direct-new"]').exists()).toBe(true)
    // 卡片序 = 草稿序：路由卡在前、新直连卡追加卡尾
    expect(w.find('[data-testid="route-direct-card"], [data-testid="route-card"]').attributes('data-testid')).toBe('route-card')
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeTruthy()

    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { routes: AggregationRoute[]; scopedRefs: string[] }
    // 直连条目只进白名单半边（routes 载荷不变——无 routes 定义）
    expect(payload.routes.map((r) => r.id)).toEqual(['r1'])
    expect(payload.scopedRefs).toEqual([`${AGGREGATION_PROVIDER_ID}/r1`, 'zhipu/glm-4-6'])
  })

  it('直连去重防护（AC-Q13 同族）：白名单已有该模型 → 行内按钮禁用显示已添加直连', async () => {
    const w = mountPage(
      [cardOf(routeOf({ id: 'r1' }))],
      [prov({ id: 'zhipu', name: '智谱', models: [{ id: 'glm-4-6', name: 'GLM-4.6' }] })],
      undefined,
      [`${AGGREGATION_PROVIDER_ID}/r1`, 'zhipu/glm-4-6'],
    )
    await expandFirstProvider(w)
    // 已落盘直连条目：禁用态 + 无创建入口
    expect(w.find('[data-testid="route-quick-direct-exists"]').exists()).toBe(true)
    expect(w.find('[data-testid="route-quick-create-direct"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="route-direct-card"]')).toHaveLength(1)
  })

  it('草稿内重复添加被事实态拦截：加过一次后该行按钮即禁用（防同一白名单条目重复落卡）', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1' }))], [
      prov({ id: 'zhipu', name: '智谱', models: [{ id: 'glm-4-6', name: 'GLM-4.6' }] }),
    ])
    await expandFirstProvider(w)
    await w.find('[data-testid="route-quick-create-direct"]').trigger('click')
    expect(w.findAll('[data-testid="route-direct-card"]')).toHaveLength(1)
    // 草稿半边也进防护口径（保存整表覆写按去重保序会静默合并，草稿留空转卡）
    expect(w.find('[data-testid="route-quick-direct-exists"]').exists()).toBe(true)
    expect(w.find('[data-testid="route-quick-create-direct"]').exists()).toBe(false)
  })

  it('筛选后勾选两模型 → 创建高级路由：勾选序多端点全无条件 + 待配置分流徽标 + 选择清空', async () => {
    const w = mountPage(
      [cardOf(routeOf({ id: 'r1' }))],
      [
        prov({ id: 'zhipu', name: '智谱', models: [{ id: 'glm-4-6', name: 'GLM-4.6' }, { id: 'glm-4-5-air', name: 'GLM-4.5 Air' }] }),
        prov({ id: 'moonshot', models: [{ id: 'kimi-k2', name: 'Kimi K2' }] }),
      ],
    )
    await w.find('[data-testid="route-quick-filter"]').setValue('glm')
    // 筛选分组只显匹配渠道（moonshot 无 glm 模型不入组）
    expect(w.findAll('[data-testid="route-quick-provider-row"]').length).toBe(1)
    await expandFirstProvider(w)
    await w.find('[data-testid="route-quick-pick-zhipu-glm-4-6"]').trigger('click')
    await w.find('[data-testid="route-quick-pick-zhipu-glm-4-5-air"]').trigger('click')
    // 保存摘要与计数
    expect(w.find('[data-testid="route-quick-selection-summary"]').text()).toContain('settings.modelRoute.quickSelectedN')
    const advBtn = w.find('[data-testid="route-quick-create-advanced"]')
    expect((advBtn.element as HTMLButtonElement).disabled).toBe(false)
    await advBtn.trigger('click')
    const cards = w.findAll('[data-testid="route-card"]')
    expect(cards.length).toBe(2)
    // AC-Q7：待配置分流徽标
    expect(cards[1]!.find('[data-testid="route-card-pending-split"]').exists()).toBe(true)
    // 选择清空（创建后）
    expect(w.find('[data-testid="route-quick-selection-summary"]').text()).toContain('settings.modelRoute.quickSelectHint')
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { routes: AggregationRoute[] }
    const created = payload.routes[1]!
    expect(created.mode).toBe('advanced')
    expect(created.members.map((m) => m.modelId)).toEqual(['glm-4-6', 'glm-4-5-air'])
    expect(created.members.every((m) => m.type === 'none')).toBe(true)
  })

  it('已选 <2 时「创建高级路由」禁用；筛选无结果空态；选择跨筛选保留', async () => {
    const w = mountPage(
      [],
      [
        prov({ id: 'zhipu', models: [{ id: 'glm-4-6', name: 'GLM-4.6' }] }),
        prov({ id: 'moonshot', models: [{ id: 'kimi-k2', name: 'Kimi K2' }] }),
      ],
    )
    const advBtn = w.find('[data-testid="route-quick-create-advanced"]')
    expect((advBtn.element as HTMLButtonElement).disabled).toBe(true)
    await w.find('[data-testid="route-quick-filter"]').setValue('nomatch')
    expect(w.find('[data-testid="route-quick-filter-empty"]').exists()).toBe(true)
    // 换词后勾选，再清词：选择保留（spec §4.4）
    await w.find('[data-testid="route-quick-filter"]').setValue('kimi')
    await expandFirstProvider(w)
    await w.find('[data-testid="route-quick-pick-moonshot-kimi-k2"]').trigger('click')
    await w.find('[data-testid="route-quick-filter-clear"]').trigger('click')
    expect(w.find('[data-testid="route-quick-selection-summary"]').text()).toContain('settings.modelRoute.quickSelectedN')
    expect((advBtn.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('空状态「快速创建」按钮只展开聚焦面板，不生成另一套默认值卡片', async () => {
    const w = mountPage(
      [],
      [prov({ id: 'zhipu', models: [{ id: 'glm-4-6', name: 'GLM-4.6' }] })],
    )
    expect(w.find('[data-testid="model-route-empty"]').exists()).toBe(true)
    await w.find('[data-testid="route-empty-create"]').trigger('click')
    expect(w.findAll('[data-testid="route-card"]').length).toBe(0)
    expect(w.find('[data-testid="route-quick-create"]').exists()).toBe(true)
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

// ── 引用 chip 跳转定位（U5 补呈现 · 外部 spec §6.4：展开对应模型卡 + 滚动定位 + 闪烁高亮）──

describe('ModelRoutePage 引用跳转定位（focus prop）', () => {
  // jsdom 无 scrollIntoView（RouteCard watch 定位调用），测试级补桩
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {}
  })

  it('focus 命中卡：自动展开 + 目标端点行带 data-member-id 锚与闪烁类；未命中卡保持收起', async () => {
    const w = mount(ModelRoutePage, {
      props: {
        view: viewOf([
          cardOf(routeOf({ id: 'r1', members: [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }] })),
          cardOf(routeOf({ id: 'r2', members: [{ id: 'b', providerId: 'opencode-go', modelId: 'glm-5-3', type: 'none' }] })),
        ]),
        providers: [prov({ id: 'zhipu' }), prov({ id: 'opencode-go' })],
        // scopedModels 全量必须随卡给足（mountPage 同款契约：缺半边 scoped 路由卡被派生丢弃）
        scopedModels: [`${AGGREGATION_PROVIDER_ID}/r1`, `${AGGREGATION_PROVIDER_ID}/r2`],
        now: NOW,
        focus: { routeId: 'r2', memberId: 'b' },
      },
      attachTo: document.body,
    })
    await flushPromises()

    const cards = w.findAll('[data-testid="route-card"]')
    expect(cards.length).toBe(2)
    // 命中卡（r2）：自动展开 = 端点行直接可见 + data-member-id 锚 + 闪烁类已挂
    const hitCard = cards[1]!
    const hitRow = hitCard.find('[data-testid="route-endpoint-row"]')
    expect(hitRow.exists()).toBe(true)
    expect(hitRow.attributes('data-member-id')).toBe('b')
    expect(hitRow.classes()).toContain('route-endpoint-flash')
    // 未命中卡（r1）：保持收起（端点行不在 DOM）
    expect(cards[0]!.find('[data-testid="route-endpoint-row"]').exists()).toBe(false)
  })

  it('focus 缺省：全部卡保持收起（零 DOM 副作用）', async () => {
    const w = mountPage([cardOf(routeOf({}))])
    await flushPromises()
    expect(w.find('[data-testid="route-endpoint-row"]').exists()).toBe(false)
  })
})

// ── 路由名称行内编辑（点击名称 → 编辑态 → route-patch { name }；id 是对齐键不可变，
//    name 保存校验只要求非空，数据层原生支持改名）──

describe('路由名称行内编辑（route-patch name）', () => {
  it('点击名称进入编辑态，Enter 提交改名指令并回显新名 + 标脏', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1', name: '原名' }))])
    await w.find('[data-testid="route-card-name"]').trigger('click')
    const input = w.find('[data-testid="route-card-name-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('改名后')
    await input.trigger('keydown.enter')
    // 构建者白盒：RouteCard 上抛的指令载荷
    const emitted = w.findComponent(RouteCard).emitted('op')
    expect(emitted).toBeTruthy()
    expect(emitted![0]![0]).toEqual({ kind: 'route-patch', routeId: 'r1', patch: { name: '改名后' } })
    // 黑盒 DOM：提交后回展示态并显示新名；未保存条标脏
    expect(w.find('[data-testid="route-card-name-input"]').exists()).toBe(false)
    expect(w.find('[data-testid="route-card-name"]').text()).toBe('改名后')
    expect(w.findComponent(RouteUnsavedBar).props('dirty')).toBe(true)
  })

  it('Esc 取消：不发指令、名称保持原值', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1', name: '原名' }))])
    await w.find('[data-testid="route-card-name"]').trigger('click')
    await w.find('[data-testid="route-card-name-input"]').setValue('草稿值')
    await w.find('[data-testid="route-card-name-input"]').trigger('keydown.esc')
    expect(w.findComponent(RouteCard).emitted('op')).toBeFalsy()
    expect(w.find('[data-testid="route-card-name"]').text()).toBe('原名')
    expect(w.findComponent(RouteUnsavedBar).props('dirty')).toBe(false)
  })

  it('空值不提交（trim 后为空直接退出编辑态，名称不变）', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1', name: '原名' }))])
    await w.find('[data-testid="route-card-name"]').trigger('click')
    await w.find('[data-testid="route-card-name-input"]').setValue('   ')
    await w.find('[data-testid="route-card-name-input"]').trigger('keydown.enter')
    expect(w.findComponent(RouteCard).emitted('op')).toBeFalsy()
    expect(w.find('[data-testid="route-card-name"]').text()).toBe('原名')
  })

  it('失焦提交（blur 同提交通道）', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1', name: '原名' }))])
    await w.find('[data-testid="route-card-name"]').trigger('click')
    await w.find('[data-testid="route-card-name-input"]').setValue('失焦改名')
    await w.find('[data-testid="route-card-name-input"]').trigger('blur')
    const emitted = w.findComponent(RouteCard).emitted('op')
    expect(emitted![0]![0]).toEqual({ kind: 'route-patch', routeId: 'r1', patch: { name: '失焦改名' } })
  })
})

// ── 端点模型下拉（渠道与模型独立选择；候选 = 本渠道启用模型，当前值禁用/已移除保留标注）──

describe('端点模型下拉（endpoint-patch modelId）', () => {
  /** 展开 + 单端点 fixture：member 挂在 providers[0] 渠道。 */
  async function expandedRow(
    member: AggregationRoute['members'][number],
    providers: ProviderInfo[],
  ): Promise<VueWrapper> {
    const w = mountPage([cardOf(routeOf({ members: [member] }))], providers)
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    return w
  }

  const ZHIPU_MIXED = (): ProviderInfo[] => [
    prov({ id: 'zhipu', models: [{ id: 'glm-5-3' }, { id: 'glm-4-plus', enabled: false }] }),
    prov({ id: 'opencode-go', models: [{ id: 'k2-turbo' }] }),
  ]

  async function openModelOptions(w: VueWrapper): Promise<string[]> {
    const trigger = w.find('[data-testid="endpoint-model-select"]').element as HTMLElement
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    trigger.click()
    await flushPromises()
    return Array.from(document.body.querySelectorAll('[role="option"]')).map((el) => el.textContent ?? '')
  }

  it('模型 chip 已换成下拉（endpoint-model-select）；候选只列启用模型', async () => {
    const w = await expandedRow({ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }, ZHIPU_MIXED())
    expect(w.find('[data-testid="endpoint-model-select"]').exists()).toBe(true)
    const texts = await openModelOptions(w)
    expect(texts).toContain('glm-5-3')
    // 禁用模型不入候选（配置保留标注只对「当前值」生效，非当前值直接隐藏）
    expect(texts.some((t) => t.includes('glm-4-plus'))).toBe(false)
  })

  it('选其他启用模型 → endpoint-patch { modelId } 载荷上抛', async () => {
    const providers = [prov({ id: 'zhipu', models: [{ id: 'glm-5-3' }, { id: 'glm-4-air' }] })]
    const w = await expandedRow({ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }, providers)
    await pickSelectOption(w.find('[data-testid="endpoint-model-select"]').element as HTMLElement, 'glm-4-air')
    const emitted = w.findComponent(RouteCard).emitted('op')
    expect(emitted).toBeTruthy()
    expect(emitted![0]![0]).toMatchObject({ kind: 'endpoint-patch', routeId: 'glm-5-3', patch: { modelId: 'glm-4-air' } })
  })

  it('当前模型已禁用：保留为选项并标注（modelDisabledLabel）', async () => {
    const w = await expandedRow({ id: 'a', providerId: 'zhipu', modelId: 'glm-4-plus', type: 'none' }, ZHIPU_MIXED())
    const texts = await openModelOptions(w)
    expect(texts.some((t) => t.includes('glm-4-plus'))).toBe(true)
    expect(texts.some((t) => t.includes('settings.modelRoute.modelDisabledLabel'))).toBe(true)
  })

  it('当前模型已移除：保留为选项并标注（modelRemovedLabel）', async () => {
    const w = await expandedRow({ id: 'a', providerId: 'zhipu', modelId: 'gone-model', type: 'none' }, ZHIPU_MIXED())
    const texts = await openModelOptions(w)
    expect(texts.some((t) => t.includes('gone-model'))).toBe(true)
    expect(texts.some((t) => t.includes('settings.modelRoute.modelRemovedLabel'))).toBe(true)
  })
})

// ── 渠道切换联动模型重置（opEndpointPatch providerId 联动：端点渠道与模型独立选择的
//    语义闭环——切渠道后旧 modelId 落新渠道悬空，重置为新渠道第一个启用模型）──

describe('渠道切换联动模型重置（endpoint-patch providerId）', () => {
  it('切到有模型渠道：modelId 重置为新渠道第一个启用模型（DOM + save 载荷双断言）', async () => {
    const providers = [
      prov({ id: 'zhipu', models: [{ id: 'glm-5-3' }] }),
      prov({ id: 'opencode-go', models: [{ id: 'k2-turbo' }, { id: 'k2-lite', enabled: false }] }),
    ]
    const w = mountPage([cardOf(routeOf({ members: [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }] }))], providers)
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    await pickSelectOption(w.find('[data-testid="endpoint-provider-select"]').element as HTMLElement, 'opencode-go')
    const row = w.find('[data-testid="route-endpoint-row"]')
    expect(row.text()).toContain('opencode-go')
    expect(row.text()).toContain('k2-turbo')
    expect(row.text()).not.toContain('glm-5-3')
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { routes: AggregationRoute[] }
    expect(payload.routes[0]!.members[0]).toMatchObject({ providerId: 'opencode-go', modelId: 'k2-turbo' })
  })

  it('新渠道无启用模型：modelId 保留原值（悬空由异常 chip 呈报，保存不拒绝）', async () => {
    const providers = [
      prov({ id: 'zhipu', models: [{ id: 'glm-5-3' }] }),
      prov({ id: 'opencode-go', models: [] }),
    ]
    const w = mountPage([cardOf(routeOf({ members: [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }] }))], providers)
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    await pickSelectOption(w.find('[data-testid="endpoint-provider-select"]').element as HTMLElement, 'opencode-go')
    const row = w.find('[data-testid="route-endpoint-row"]')
    // modelId 保留 + model-removed 异常 chip（配置保留优先语义）
    expect(row.text()).toContain('glm-5-3')
    expect(row.text()).toContain('settings.modelRoute.issue.model-removed')
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { routes: AggregationRoute[] }
    expect(payload.routes[0]!.members[0]).toMatchObject({ providerId: 'opencode-go', modelId: 'glm-5-3' })
  })
})

// ── 卡片拖拽排序（HTML5 DnD：把手 dragstart → 卡根 dragover/drop → moveCardToSlot 纯函数）──

describe('卡片拖拽排序（drag-and-drop reorder）', () => {
  it('路由卡拖到第一张卡前缘：卡序交换 + 标脏 + save 载荷顺序跟随', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1' })), cardOf(routeOf({ id: 'r2' }))])
    const cards = () => w.findAll('[data-testid="route-card"]')
    await cards()[1]!.find('[data-testid="route-card-drag-handle"]').trigger('dragstart')
    await cards()[0]!.trigger('dragover', { clientY: 0 })
    // 指示线（前缘 inset shadow 工具类）挂在目标卡上
    expect(cards()[0]!.classes()).toContain('shadow-[inset_0_2px_0_0_var(--accent)]')
    await cards()[0]!.trigger('drop')
    await cards()[0]!.trigger('dragend')
    expect(cards()[0]!.attributes('data-route-id')).toBe('r2')
    expect(cards()[1]!.attributes('data-route-id')).toBe('r1')
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeTruthy()
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { routes: AggregationRoute[] }
    expect(payload.routes.map((r) => r.id)).toEqual(['r2', 'r1'])
  })

  it('放回原位（目标自身后缘）不重排不标脏', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1' })), cardOf(routeOf({ id: 'r2' }))])
    const cards = () => w.findAll('[data-testid="route-card"]')
    await cards()[0]!.find('[data-testid="route-card-drag-handle"]').trigger('dragstart')
    await cards()[0]!.trigger('dragover', { clientY: 500 })
    expect(cards()[0]!.classes()).toContain('shadow-[inset_0_-2px_0_0_var(--accent)]')
    await cards()[0]!.trigger('drop')
    await cards()[0]!.trigger('dragend')
    expect(w.findComponent(ModelRoutePage).emitted('change')).toBeFalsy()
    expect(cards()[0]!.attributes('data-route-id')).toBe('r1')
    // 拖拽态已复位：指示类摘除
    expect(cards()[0]!.classes()).not.toContain('shadow-[inset_0_-2px_0_0_var(--accent)]')
  })

  it('直连卡拖到路由卡之后：save 载荷 scopedRefs 顺序跟随（卡片序 = 白名单目标序）', async () => {
    const w = mountPage(
      [cardOf(routeOf({ id: 'r1' }), { scopedIndex: 0 })],
      [prov({ id: 'zhipu' })],
      undefined,
      [`${AGGREGATION_PROVIDER_ID}/r1`, 'zhipu/glm-5-3'],
    )
    await w.find('[data-testid="route-direct-card"] [data-testid="route-direct-drag-handle"]').trigger('dragstart')
    // 拖过路由卡（index 1）下缘 → 插入槽位 2 = 移到末尾
    await w.find('[data-testid="route-card"]').trigger('dragover', { clientY: 500 })
    await w.find('[data-testid="route-card"]').trigger('drop')
    await w.find('[data-testid="route-card"]').trigger('dragend')
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { scopedRefs: string[] }
    expect(payload.scopedRefs).toEqual([`${AGGREGATION_PROVIDER_ID}/r1`, 'zhipu/glm-5-3'])
  })
})

// ── 修剪回归（tree-plant prune：fixed 发现的探针升格单测） ────────────────────────

describe('修剪回归：保存中禁用 / 模型切换 levels 过滤', () => {
  it('disabled prop → 未保存条保存/放弃按钮禁用（保存/删除编排窗口防并发，修剪 R2/R1）', async () => {
    const w = mountPage([cardOf(routeOf({ id: 'r1' }))])
    // 制造 dirty 使未保存条可见（v-show）
    await w.find('[data-testid="route-scoped-toggle"]').trigger('click')
    await w.setProps({ disabled: true })
    expect((w.find('[data-testid="unsaved-save"]').element as HTMLButtonElement).disabled).toBe(true)
    expect((w.find('[data-testid="unsaved-discard"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('端点换模型：已声明档位按新模型 supportedLevels 过滤（修剪 F2 半更新死锁半边）', async () => {
    const providers = [
      prov({
        id: 'zhipu',
        models: [
          { id: 'glm-4-6', name: 'GLM-4.6', supportedLevels: ['off', 'low'] },
          { id: 'glm-4-air', name: 'glm-4-air', supportedLevels: ['off', 'high'] },
        ],
      }),
      prov({ id: 'moonshot', models: [{ id: 'kimi-k2', name: 'Kimi K2' }] }),
    ]
    const route = routeOf({
      id: 'r1',
      members: [
        { id: 'a', providerId: 'zhipu', modelId: 'glm-4-6', type: 'none', levels: { off: 'off', low: 'low' } },
      ],
    })
    const w = mountPage([cardOf(route)], providers)
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    await pickSelectOption(w.find('[data-testid="endpoint-model-select"]').element as HTMLElement, 'glm-4-air')
    await flushPromises()
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { routes: AggregationRoute[] }
    // low 不在新模型支持集 → 过滤掉；off 保留
    expect(payload.routes[0]!.members[0]!.levels).toEqual({ off: 'off' })
  })

  it('已声明但新模型不支持的档位仍可点取消（不与 disabled 死锁，修剪 F2）', async () => {
    const providers = [
      prov({ id: 'zhipu', models: [{ id: 'glm-4-6', name: 'GLM-4.6', supportedLevels: ['off'] }] }),
      prov({ id: 'moonshot', models: [{ id: 'kimi-k2', name: 'Kimi K2' }] }),
    ]
    const route = routeOf({
      id: 'r1',
      members: [
        // 悬空声明形态：supportedLevels 缺 low，但 levels 已声明 low（历史数据/模型能力收缩）
        { id: 'a', providerId: 'zhipu', modelId: 'glm-4-6', type: 'none', levels: { off: 'off', low: 'low' } },
      ],
    })
    const w = mountPage([cardOf(route)], providers)
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    await w.find('[data-testid="endpoint-levels-toggle"]').trigger('click')
    const lowBtn = w.find('[data-testid="endpoint-level-low"]')
    expect((lowBtn.element as HTMLButtonElement).disabled).toBe(false)
    await lowBtn.trigger('click')
    await flushPromises()
    w.findComponent(RouteUnsavedBar).vm.$emit('save')
    await w.vm.$nextTick()
    const payload = (w.findComponent(ModelRoutePage).emitted('save')![0]![0]) as { routes: AggregationRoute[] }
    expect(payload.routes[0]!.members[0]!.levels).toEqual({ off: 'off', low: null })
  })
})
