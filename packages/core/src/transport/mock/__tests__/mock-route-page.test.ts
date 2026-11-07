// mock 门面路由页 + 插件版本下拉 stub 单测（provider-aggregation U9 / plugin 版本下拉）。
// 被测新增面：config 域 getRouteView / saveRoute / deleteRoute / onRouteView 四成员 +
// plugin 域 listPluginVersions——mock 内存态 stub（无 providers.json 域），断言回执形状
// 与「不推送广播」的空态语义。真实编排逻辑由 runtime aggregation-message-handler 测试承载，
// 这里只锚 mock 层回执契约（G4 参数全等断言已保证签名与 real 域对齐，编译期兜底）。
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { AggregationRoute } from '@taiji/shared'
import { config, plugin, setMockTiming, resetMockTiming, __clearTimers } from '../index'

/** 最小合法路由 fixture（simple 模式单端点，specials 空——形状锚 shared AggregationRoute） */
const demoRoute: AggregationRoute = {
  id: 'demo-route',
  name: '演示路由',
  modelId: 'demo-route',
  enabled: true,
  mode: 'simple',
  members: [{ id: 'm1', providerId: 'p1', modelId: 'model-a', type: 'none' }],
  specials: [],
}

beforeAll(() => {
  // 压缩 ack 时序（各方法 sleep(ack) 后 resolve，默认 40ms 无必要）
  setMockTiming({ ack: 1 })
})

afterAll(() => {
  resetMockTiming()
})

afterEach(() => {
  __clearTimers()
})

describe('mock config 路由页（getRouteView / saveRoute / deleteRoute / onRouteView）', () => {
  it('getRouteView：mock 无 routes 域，恒空视图（无卡无孤儿、非 corrupted）', async () => {
    await expect(config.getRouteView()).resolves.toEqual({ cards: [], orphanRefs: [] })
  })

  it('saveRoute：回显保存值 + 空 memberIssues（mock 无悬空校验数据源）', async () => {
    await expect(config.saveRoute(demoRoute)).resolves.toEqual({ route: demoRoute, memberIssues: [] })
  })

  it('deleteRoute：回显 routeId + 空 scopedModels（mock 无白名单可清理）', async () => {
    await expect(config.deleteRoute('demo-route')).resolves.toEqual({ routeId: 'demo-route', scopedModels: [] })
  })

  it('onRouteView：注册即返回退订函数（mock 不推送广播，注册零副作用）', () => {
    const unsubscribe = config.onRouteView(() => {})
    expect(typeof unsubscribe).toBe('function')
    // 退订在 mock 空态下可安全重复调用
    expect(() => unsubscribe()).not.toThrow()
  })
})

describe('mock plugin.listPluginVersions', () => {
  it('mock 无 registry 通道，返回单版本演示形态（下拉三段流在 mock 模式可走通）', async () => {
    await expect(plugin.listPluginVersions('demo-plugin')).resolves.toEqual({
      versions: ['0.1.0'],
      latest: '0.1.0',
    })
  })
})
