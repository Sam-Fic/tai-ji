// @vitest-environment happy-dom

/**
 * ModelPickerPanel 路由行「此刻命中端点」呈现测试（provider-aggregation M3 命中端点展示，
 * 终态同步 F1-31 落地锁定）：行尾路由徽标三态——命中（routeHitNow）/ 无命中（routeNoHitNow）/
 * 数据未到位（routeBadge 原样）。数据求值半边在 model-picker-data（#94 缓存 + evaluateRouteAt），
 * 本文件只锁定呈现映射（模板三元），不 mock @/api（本组件不感知数据来源）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ModelPickerPanel from '../ModelPickerPanel.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  messages: {
    'zh-CN': {
      panel: {
        modelSelect: {
          searchPlaceholder: '搜索模型…',
          noMatch: '无匹配模型',
          noModel: '无模型',
          defaultTag: '默认',
          routeGroupTitle: '模型路由',
          routeBadge: '路由',
          routeHitNow: '路由 → {name}',
          routeNoHitNow: '路由 · 此刻无命中',
        },
      },
    },
  },
})

function mountPanel(groups: unknown): ReturnType<typeof mount> {
  return mount(ModelPickerPanel, {
    props: { groups } as never,
    global: { plugins: [i18n] },
  })
}

function routeBadgeText(wrapper: ReturnType<typeof mount>): string {
  return wrapper.find('[data-testid="model-picker-route-badge"]').text()
}

describe('ModelPickerPanel 路由行命中端点呈现（M3，F1-31）', () => {
  it('hitEndpoint 为端点名 → 行尾「路由 → 端点名」', () => {
    const wrapper = mountPanel([
      {
        provider: '模型路由',
        providerId: 'aggregation',
        aggregation: true,
        models: [{ id: 'work-route', name: '工作路由', hitEndpoint: '智谱 GLM' }],
      },
    ])
    expect(routeBadgeText(wrapper)).toBe('路由 → 智谱 GLM')
  })

  it('hitEndpoint 为 null（定义在但条件全不满足）→ 行尾「路由 · 此刻无命中」', () => {
    const wrapper = mountPanel([
      {
        provider: '模型路由',
        providerId: 'aggregation',
        aggregation: true,
        models: [{ id: 'night-route', name: '夜间路由', hitEndpoint: null }],
      },
    ])
    expect(routeBadgeText(wrapper)).toBe('路由 · 此刻无命中')
  })

  it('hitEndpoint 缺省（视图未到位/非路由行形态）→ 行尾「路由」原样', () => {
    const wrapper = mountPanel([
      {
        provider: '模型路由',
        providerId: 'aggregation',
        aggregation: true,
        models: [{ id: 'work-route', name: '工作路由' }],
      },
    ])
    expect(routeBadgeText(wrapper)).toBe('路由')
  })

  it('非聚合组行不渲染路由徽标', () => {
    const wrapper = mountPanel([
      {
        provider: '智谱',
        providerId: 'zhipu',
        models: [{ id: 'glm-5.3' }],
      },
    ])
    expect(wrapper.find('[data-testid="model-picker-route-badge"]').exists()).toBe(false)
  })
})
