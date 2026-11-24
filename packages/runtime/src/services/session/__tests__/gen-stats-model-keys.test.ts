/**
 * gen-stats-model-keys 单元测试（provider-aggregation 虚拟路由 × gen-stats 命名空间展开层）。
 *
 * 覆盖：
 * - expandModelKeys：非虚拟 key 恒等；虚拟 key 按 route.id 展开为成员 `<providerId>/<modelId>`
 *   集（保序去重）；路由不存在 / 成员为空 / 快照为空 → 恒等退化（不抛错、不产空集——
 *   空集会让调用方「无文件可读」与「无路由」混淆，恒等保降级链语义逐字不变）；
 * - 反向寻址判据（expandModelKeys(registered).includes(physical)，生产路径同式）：物理 key
 *   恒自覆盖；跨路由不误覆盖（route-a 的成员不是 route-b 的寻址目标）。
 * - 成员过滤（prune F1/F6）：providerId 含 '/' / modelId 带 :level 选择器后缀（round-trip
 *   不可逆）/ 端点指向聚合保留 id（嵌套路由）/ 空字段 —— 全部跳过该成员；全部不可展开时
 *   恒等退化。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/gen-stats-model-keys.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { AggregationRoute } from '@taiji/shared'
import { expandModelKeys, planMemberReads, splitModelKey } from '../gen-stats-model-keys.js'

function route(id: string, members: Array<[string, string]>): AggregationRoute {
  return {
    id,
    name: id,
    modelId: id,
    enabled: true,
    mode: 'simple',
    members: members.map(([providerId, modelId], i) => ({ id: `m${i}`, providerId, modelId, type: 'none' as const })),
    specials: [],
  }
}

const ROUTES: AggregationRoute[] = [
  route('route-a', [['faux', 'faux-1']]),
  route('route-b', [['faux', 'faux-1'], ['faux', 'faux-1-b']]),
  route('route-empty', []),
  route('route-dup', [['faux', 'faux-1'], ['faux', 'faux-1']]),
]

describe('expandModelKeys', () => {
  it('非虚拟 key（物理 provider/model）恒等返回自身', () => {
    expect(expandModelKeys('faux/faux-1', ROUTES)).toEqual(['faux/faux-1'])
    expect(expandModelKeys('opendesign/deepseek-v4.1-flash', ROUTES)).toEqual(['opendesign/deepseek-v4.1-flash'])
  })

  it('虚拟 key 展开为成员物理 key 集（保序去重）', () => {
    expect(expandModelKeys('aggregation/route-b', ROUTES)).toEqual(['faux/faux-1', 'faux/faux-1-b'])
    expect(expandModelKeys('aggregation/route-a', ROUTES)).toEqual(['faux/faux-1'])
  })

  it('重复成员去重（同 provider+model 两条成员只留一个 key）', () => {
    expect(expandModelKeys('aggregation/route-dup', ROUTES)).toEqual(['faux/faux-1'])
  })

  it('虚拟 key 解析不到路由定义 → 恒等退化（配置缺失/损坏/路由已删）', () => {
    expect(expandModelKeys('aggregation/route-gone', ROUTES)).toEqual(['aggregation/route-gone'])
    expect(expandModelKeys('aggregation/route-a', [])).toEqual(['aggregation/route-a'])
  })

  it('虚拟 key 命中路由但成员为空 → 恒等退化（不返回空集）', () => {
    expect(expandModelKeys('aggregation/route-empty', ROUTES)).toEqual(['aggregation/route-empty'])
  })

  it('多段 model id 成员原样拼复合 key（openrouter 系 vendor/model）', () => {
    const routes = [route('route-or', [['openrouter', 'vendor/model']])]
    expect(expandModelKeys('aggregation/route-or', routes)).toEqual(['openrouter/vendor/model'])
  })
})

describe('反向寻址判据（expandModelKeys(...).includes(...)，生产路径同式）', () => {
  it('物理注册 key 只自覆盖（直连会话零回归判据）', () => {
    expect(expandModelKeys('faux/faux-1', ROUTES).includes('faux/faux-1')).toBe(true)
    expect(expandModelKeys('faux/faux-1', ROUTES).includes('faux/faux-1-b')).toBe(false)
  })

  it('虚拟注册 key 覆盖其全部成员', () => {
    expect(expandModelKeys('aggregation/route-b', ROUTES).includes('faux/faux-1')).toBe(true)
    expect(expandModelKeys('aggregation/route-b', ROUTES).includes('faux/faux-1-b')).toBe(true)
  })

  it('跨路由不误覆盖（route-a 的成员不是 route-b 帧的寻址目标）', () => {
    expect(expandModelKeys('aggregation/route-a', ROUTES).includes('faux/faux-1-b')).toBe(false)
  })

  it('路由不存在时虚拟 key 只自覆盖（退化后不再代收任何成员帧）', () => {
    expect(expandModelKeys('aggregation/route-gone', ROUTES).includes('faux/faux-1')).toBe(false)
    expect(expandModelKeys('aggregation/route-gone', ROUTES).includes('aggregation/route-gone')).toBe(true)
  })
})

describe('expandModelKeys 成员过滤（prune F1/F6：用户配置文本 → 复合 key 的生产者校验）', () => {
  it('providerId 含 / 的成员被跳过（首 / 切分会别名到别的 provider）', () => {
    const routes = [route('route-x', [['a/b', 'c'], ['faux', 'faux-1']])]
    expect(expandModelKeys('aggregation/route-x', routes)).toEqual(['faux/faux-1'])
  })

  it('modelId 带 :level 选择器后缀的成员被跳过（round-trip 不可逆）', () => {
    const routes = [route('route-x', [['faux', 'glm:xhigh'], ['faux', 'faux-1']])]
    expect(expandModelKeys('aggregation/route-x', routes)).toEqual(['faux/faux-1'])
  })

  it('端点指向聚合保留 id（嵌套路由）的成员被跳过（与写侧 validateAggregationRouteUpsert 同谓词）', () => {
    const routes = [route('route-x', [['aggregation', 'route-b'], ['faux', 'faux-1']])]
    expect(expandModelKeys('aggregation/route-x', routes)).toEqual(['faux/faux-1'])
  })

  it('空 providerId/modelId 成员被跳过', () => {
    const routes = [route('route-x', [['', 'faux-1'], ['faux', 'faux-1']])]
    expect(expandModelKeys('aggregation/route-x', routes)).toEqual(['faux/faux-1'])
  })

  it('全部成员不可展开 → 恒等退化（不返回空集）', () => {
    const routes = [route('route-x', [['a/b', 'c'], ['aggregation', 'route-b']])]
    expect(expandModelKeys('aggregation/route-x', routes)).toEqual(['aggregation/route-x'])
  })

  it('合法多段 model id（openrouter 系 vendor/model）不受过滤影响', () => {
    const routes = [route('route-or', [['openrouter', 'vendor/model']])]
    expect(expandModelKeys('aggregation/route-or', routes)).toEqual(['openrouter/vendor/model'])
  })
})

describe('splitModelKey（复合 key 切分规则单点，round-trip 过滤的判据来源）', () => {
  it('首 / 切分：provider 无 / ，model 可含 /', () => {
    expect(splitModelKey('openrouter/vendor/model')).toEqual({ provider: 'openrouter', model: 'vendor/model' })
    expect(splitModelKey('faux/faux-1')).toEqual({ provider: 'faux', model: 'faux-1' })
  })

  it('剥离 :thinkingLevel 选择器后缀（故带后缀的成员 key 不可逆、被过滤）', () => {
    expect(splitModelKey('faux/glm:xhigh')).toEqual({ provider: 'faux', model: 'glm' })
  })
})

describe('planMemberReads（MF-1：按解析文件路径去重，文件名层别名不双算）', () => {
  /** 复刻 safeModelFileName 的 raw 拼接判据（${provider}__${model}）——真实路径还带替换/截断/hash，碰撞判据同源 */
  const rawPathOf = (provider: string, model: string): string => `${provider}__${model}`

  it("别名到同一 raw 串的两个成员只读一次（('faux','x__y') vs ('faux__x','y')）", () => {
    const plan = planMemberReads(['faux/x__y', 'faux__x/y'], rawPathOf)
    expect(plan).toEqual([{ key: 'faux/x__y', filePath: 'faux__x__y' }])
  })

  it('不同文件各自成计划项且保序', () => {
    const plan = planMemberReads(['faux/a', 'faux/b', 'faux/a'], rawPathOf)
    expect(plan.map((e) => e.filePath)).toEqual(['faux__a', 'faux__b'])
  })

  it('modelId 含 / 的多段形态不与前缀移位别名碰撞', () => {
    const plan = planMemberReads(['openrouter/vendor/model', 'openrouter/vendor/model-x'], rawPathOf)
    expect(plan.map((e) => e.filePath)).toEqual(['openrouter__vendor/model', 'openrouter__vendor/model-x'])
  })
})
