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
import { describe, it, expect } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
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
): VueWrapper {
  return mount(ModelRoutePage, {
    props: {
      view: viewOf(cards, viewOverrides),
      providers,
      now: NOW,
    },
    attachTo: document.body,
  })
}

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
