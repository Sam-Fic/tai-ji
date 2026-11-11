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

  it('仅额度端点路由拖拽网格：阻挡文案走 paintNoWindowEndpoint 独立键（与快捷涂抹 paintSelectFirst 分场景）', async () => {
    const warnings: string[] = []
    const members: AggregationRoute['members'] = [
      { id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'quota', quota: { thresholdPercent: 20 } },
    ]
    const w = mount(ModelRoutePage, {
      props: {
        view: viewOf([cardOf(routeOf({ members }))]),
        providers: [prov({ id: 'zhipu' })],
        scopedModels: [`${AGGREGATION_PROVIDER_ID}/glm-5-3`],
        now: NOW,
      },
      global: {
        provide: {
          [SETTINGS_TOAST_KEY as symbol]: {
            error: () => {},
            info: () => {},
            warning: (m: string) => warnings.push(m),
          },
        },
      },
      attachTo: document.body,
    })
    await w.find('[data-testid="route-card-toggle"]').trigger('click')
    // 路由无时间窗端点（仅额度端点，图例无端点可选）→ 拖拽网格被 startPaint 拦截；
    // i18n mock t() 返回 key 本身：断言独立键而非快捷涂抹的 paintSelectFirst
    await w.find('[data-testid="route-time-cell"][data-day="2"][data-slot="29"]').trigger('pointerdown')
    expect(warnings).toContain('settings.modelRoute.paintNoWindowEndpoint')
    expect(warnings).not.toContain('settings.modelRoute.paintSelectFirst')
    w.unmount()
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
