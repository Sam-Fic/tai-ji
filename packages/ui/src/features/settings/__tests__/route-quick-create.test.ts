/**
 * 快速创建路由草稿构建器单测（spec §4.5/§4.6/§7.2/§8 边界）。
 *
 * 覆盖：levels 全支持档初始化与缺省语义（AC-Q12）、命名三规则与重名序号、
 * id 生成/唯一/截断、端点勾选序、usage 统计口径（仅路由）。
 */
import { describe, it, expect } from 'vitest'
import {
  levelsFromSupported,
  buildSimpleQuickRoute,
  buildAdvancedQuickRoute,
  buildUsageIndex,
  quickPickKey,
  uniqueDisplayName,
  uniqueRouteId,
} from '../provider/route-quick-create'

const PICK = { providerId: 'zhipu', modelId: 'glm-4-6', modelDisplayName: 'GLM-4.6' }

describe('levelsFromSupported（AC-Q12：全支持档初始化；缺省 = 档位未知缺省）', () => {
  it('支持档全量映射为声明（value = 档位自身）', () => {
    expect(levelsFromSupported(['off', 'low', 'high'])).toEqual({ off: 'off', low: 'low', high: 'high' })
  })

  it('缺省 / 空数组 → undefined（不伪装全支持）', () => {
    expect(levelsFromSupported(undefined)).toBeUndefined()
    expect(levelsFromSupported([])).toBeUndefined()
  })
})

describe('uniqueDisplayName / uniqueRouteId（§8 边界：重名序号 / id 后缀）', () => {
  it('重名追加 2/3 序号', () => {
    expect(uniqueDisplayName('GLM-4.6', new Set(['GLM-4.6']))).toBe('GLM-4.6 2')
    expect(uniqueDisplayName('GLM-4.6', new Set(['GLM-4.6', 'GLM-4.6 2']))).toBe('GLM-4.6 3')
  })

  it('id kebab 化 + 冲突后缀（超 64 由 generateRouteIdFromName 截断内建）', () => {
    expect(uniqueRouteId('GLM 4.6', new Set())).toBe('glm-46')
    expect(uniqueRouteId('glm-4-6', new Set(['glm-4-6']))).toBe('glm-4-6-2')
    const long = 'a'.repeat(200)
    expect(uniqueRouteId(long, new Set()).length).toBeLessThanOrEqual(64)
    // 修剪 P5 回归：base 截满 64 且冲突时，后缀产物恒 ≤64（保存校验 route_id 不再拒绝）
    const slug = uniqueRouteId(long, new Set())
    const deduped = uniqueRouteId(long, new Set([slug]))
    expect(deduped.length).toBeLessThanOrEqual(64)
    expect(deduped).not.toBe(slug)
  })
})

describe('buildSimpleQuickRoute（spec §4.5）', () => {
  it('单端点无条件 + levels 全支持档 + name/id 从模型派生 + enabled/scoped 语义', () => {
    const route = buildSimpleQuickRoute({
      pick: { ...PICK, supportedLevels: ['off', 'max'] },
      takenRouteIds: [],
      takenNames: [],
    })
    expect(route.mode).toBe('simple')
    expect(route.enabled).toBe(true)
    expect(route.name).toBe('GLM-4.6')
    expect(route.modelId).toBe(route.id)
    expect(route.members).toHaveLength(1)
    expect(route.members[0]!.type).toBe('none')
    expect(route.members[0]!.levels).toEqual({ off: 'off', max: 'max' })
    expect(route.specials).toEqual([])
    expect(route.members[0]!.window).toBeUndefined()
    expect(route.members[0]!.quota).toBeUndefined()
  })

  it('重名与 id 冲突时追加序号（§8：同模型多路由允许）', () => {
    const route = buildSimpleQuickRoute({
      pick: PICK,
      takenRouteIds: ['glm-4-6'],
      takenNames: ['GLM-4.6'],
    })
    expect(route.name).toBe('GLM-4.6 2')
    expect(route.id).toBe('glm-4-6-2')
  })
})

describe('buildAdvancedQuickRoute（spec §4.6）', () => {
  const providerNameOf = (id: string) => (id === 'zhipu' ? '智谱' : id)

  it('同渠道 → 「渠道名 多模型」；端点按勾选序全无条件 + levels', () => {
    const route = buildAdvancedQuickRoute({
      picks: [
        { providerId: 'zhipu', modelId: 'glm-4-6', modelDisplayName: 'GLM-4.6', supportedLevels: ['low'] },
        { providerId: 'zhipu', modelId: 'glm-4-5-air', modelDisplayName: 'GLM-4.5 Air' },
      ],
      providerNameOf,
      filterKeyword: 'glm',
      takenRouteIds: [],
      takenNames: [],
    })
    expect(route.name).toBe('智谱 多模型')
    expect(route.mode).toBe('advanced')
    expect(route.members.map((m) => m.modelId)).toEqual(['glm-4-6', 'glm-4-5-air'])
    expect(route.members.every((m) => m.type === 'none')).toBe(true)
    expect(route.members[0]!.levels).toEqual({ low: 'low' })
    expect(route.members[1]!.levels).toBeUndefined()
  })

  it('跨渠道有筛选词 → 「筛选词 路由」；跨渠道无词 → 「多模型路由」', () => {
    const picks = [
      { providerId: 'zhipu', modelId: 'glm-4-6', modelDisplayName: 'GLM-4.6' },
      { providerId: 'moonshot', modelId: 'kimi-k2', modelDisplayName: 'Kimi K2' },
    ]
    const withKeyword = buildAdvancedQuickRoute({ picks, providerNameOf, filterKeyword: ' glm ', takenRouteIds: [], takenNames: [] })
    expect(withKeyword.name).toBe('glm 路由')
    const noKeyword = buildAdvancedQuickRoute({ picks, providerNameOf, filterKeyword: '', takenRouteIds: [], takenNames: [] })
    expect(noKeyword.name).toBe('多模型路由')
  })
})

describe('buildUsageIndex（§4.8：仅路由口径，同模型多路由累加）', () => {
  it('按 provider+model 计数，同一路由内同模型不重复计（唯一性约束下不存在）', () => {
    const usage = buildUsageIndex([
      {
        id: 'r1',
        name: 'r1',
        modelId: 'r1',
        enabled: true,
        mode: 'advanced',
        members: [
          { id: 'a', providerId: 'zhipu', modelId: 'glm-4-6', type: 'none' },
          { id: 'b', providerId: 'moonshot', modelId: 'kimi-k2', type: 'none' },
        ],
        specials: [],
      },
      {
        id: 'r2',
        name: 'r2',
        modelId: 'r2',
        enabled: true,
        mode: 'simple',
        members: [{ id: 'c', providerId: 'zhipu', modelId: 'glm-4-6', type: 'none' }],
        specials: [],
      },
    ])
    expect(usage.get(quickPickKey('zhipu', 'glm-4-6'))).toBe(2)
    expect(usage.get(quickPickKey('moonshot', 'kimi-k2'))).toBe(1)
    expect(usage.has(quickPickKey('zhipu', 'other'))).toBe(false)
  })
})
