/**
 * aggregation-supported-levels.test（provider-aggregation A2/RL2 显示侧档位单测）。
 *
 * 断言链（D4 ⑤「显示 ≡ 生效」）：注入器只填 reasoning + thinkingLevelMap（不手填
 * supportedLevels）→ attachSupportedLevels 经 computeSupportedLevels（pi-ai 同源门控）
 * 自动标注 → supportedLevelsOf('<聚合providerId>/<routeId>') 返回值 = D7 端点档位并集。
 *
 * 键集定形（D4 ⑤ 修订）：注入条目 thinkingLevelMap 键集 = 端点档位并集 ∪ 并集外档位的
 * null 键——pi 门控对并集外普通档（off/minimal/low/medium/high）缺键默认保留
 * （models.js:690 return true 兜底），只有显式 null 才排除；端点档位不齐 fixture
 * （两端点键集均缺 low/medium）必须被正确排除。
 */
import { describe, expect, it } from 'vitest'
import type { AggregationMember, AggregationRoute, ProviderInfo } from '@taiji/shared'
import { AGGREGATION_PROVIDER_ID, buildAggregationModelRef } from '@taiji/shared'
import { supportedLevelsOf } from '@taiji/core/domain/new-task-search'
import { attachSupportedLevels } from '../model-capability.js'
import {
  buildAggregationProviderInfo,
  buildRouteThinkingLevelMap,
  deriveRouteContextWindow,
} from '../provider-config-helper.js'

/** 端点 levels 声明构造（仅档位面参与本文件断言；条件字段留空）。 */
function member(id: string, providerId: string, modelId: string, levels?: Record<string, string | null>): AggregationMember {
  return { id, providerId, modelId, type: 'none', ...(levels !== undefined ? { levels } : {}) }
}

function route(id: string, members: AggregationMember[]): AggregationRoute {
  return { id, name: `路由 ${id}`, modelId: id, enabled: true, mode: 'advanced', members, specials: [] }
}

/** 物理端点 provider（contextWindow 查询源；listProviders 双源聚合的最小形态）。
 * 物理模型带 reasoning/thinkingLevelMap（端点 levels 声明的生产回填源，显示链同一函数）。 */
function endpointProvider(id: string, models: Array<{ id: string; contextWindow?: number; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }>): ProviderInfo {
  return {
    id: id as ProviderInfo['id'],
    name: id,
    apiKeySet: true,
    status: 'connected',
    models,
    kind: 'custom',
  }
}

const GLM_LEVELS = { off: 'off', minimal: 'minimal', high: 'high' }

describe('aggregation-supported-levels（A2/RL2 显示侧档位）', () => {
  it('supportedLevelsOf(路由复合串) = 端点档位并集（标注链自算，注入器不手填 supportedLevels）', () => {
    const routes = [
      route('glm-route', [
        member('ep-1', 'zhipu', 'glm-5.3-flash', { off: 'off', minimal: 'minimal', high: 'high' }),
        member('ep-2', 'opencode-go', 'zai-glm-5.3-flash', { low: 'low', high: 'high', max: 'max' }),
      ]),
    ]
    const providers: ProviderInfo[] = [
      endpointProvider('zhipu', [{ id: 'glm-5.3-flash', contextWindow: 200000, reasoning: true, thinkingLevelMap: GLM_LEVELS }]),
      endpointProvider('opencode-go', [{ id: 'zai-glm-5.3-flash', contextWindow: 128000, reasoning: true, thinkingLevelMap: { low: 'low', high: 'high', max: 'max' } }]),
    ]
    const aggregation = buildAggregationProviderInfo(routes, providers)!
    expect(aggregation).toBeDefined()
    // 注入器只填 reasoning + thinkingLevelMap，supportedLevels 不由注入器手填（字段缺省）
    expect(aggregation.models[0]!.supportedLevels).toBeUndefined()
    const annotated = attachSupportedLevels([aggregation, ...providers])
    // supportedLevelsOf 唯一解析实现（core）：路由复合串命中聚合条目 → 端点并集
    const ref = buildAggregationModelRef('glm-route')
    expect(ref).toBe(`${AGGREGATION_PROVIDER_ID}/glm-route`)
    expect(supportedLevelsOf(ref, annotated)).toEqual(['off', 'minimal', 'low', 'high', 'max'])
    // 物理端点同函数同链：普通档缺键默认保留（pi 门控对 undefined 键不排除——
    // 这正是 D4 ⑤ 要求注入条目对并集外普通档显式置 null 的存在依据，两形态对照）
    expect(supportedLevelsOf('zhipu/glm-5.3-flash', annotated))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high'])
  })

  it('键集形态 = 端点档位并集 ∪ 并集外档位的 null 键（七档全集逐键断言）', () => {
    // 端点声明只覆盖 off/high/xhigh → 并集 = {off, high, xhigh}；并集外四档必须显式 null
    // （普通档缺键会被 pi 门控默认保留 → 显示与生效发散；xhigh/max 置 null 形态确定）
    const map = buildRouteThinkingLevelMap([
      member('ep', 'p', 'm', { off: 'off', high: 'high', xhigh: 'xhigh' }),
    ])
    expect(Object.keys(map).sort()).toEqual(['high', 'low', 'max', 'medium', 'minimal', 'off', 'xhigh'])
    expect(map.off).toBe('off')
    expect(map.high).toBe('high')
    expect(map.xhigh).toBe('xhigh')
    expect(map.minimal).toBeNull()
    expect(map.low).toBeNull()
    expect(map.medium).toBeNull()
    expect(map.max).toBeNull()
  })

  it('端点档位不齐 fixture：两端点键集均缺 low/medium → 并集正确排除（null 键生效）', () => {
    const routes = [
      route('ragged-route', [
        member('ep-1', 'p1', 'm1', { off: 'off', minimal: 'minimal', high: 'high' }),
        member('ep-2', 'p2', 'm2', { off: 'off', minimal: 'minimal', high: 'high', xhigh: 'xhigh' }),
      ]),
    ]
    const providers: ProviderInfo[] = [
      endpointProvider('p1', [{ id: 'm1' }]),
      endpointProvider('p2', [{ id: 'm2' }]),
    ]
    const annotated = attachSupportedLevels([buildAggregationProviderInfo(routes, providers)!])
    const levels = supportedLevelsOf(`${AGGREGATION_PROVIDER_ID}/ragged-route`, annotated)
    // 并集 = off/minimal/high/xhigh；low/medium 两端点均未声明 → null 键排除
    expect(levels).toEqual(['off', 'minimal', 'high', 'xhigh'])
    expect(levels).not.toContain('low')
    expect(levels).not.toContain('medium')
  })

  it('端点 levels 缺省 = 档位未知（shared 语义）→ 并集空集 → supportedLevels 空（七档全 null）', () => {
    const routes = [route('no-levels', [member('ep', 'p', 'm')])]
    const providers: ProviderInfo[] = [endpointProvider('p', [{ id: 'm' }])]
    const aggregation = buildAggregationProviderInfo(routes, providers)!
    expect(aggregation.models[0]!.thinkingLevelMap).toEqual({
      off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
    })
    const annotated = attachSupportedLevels([aggregation])
    expect(supportedLevelsOf(`${AGGREGATION_PROVIDER_ID}/no-levels`, annotated)).toEqual([])
  })

  it('注入条目 contextWindow = 端点最小值（D4 ⑤/D7 取端点最小落位）；全部端点缺省 → 不写键', () => {
    const routes = [route('cw-route', [
      member('ep-1', 'p1', 'm1'),
      member('ep-2', 'p2', 'm2'),
    ])]
    const providers: ProviderInfo[] = [
      endpointProvider('p1', [{ id: 'm1', contextWindow: 200000 }]),
      endpointProvider('p2', [{ id: 'm2', contextWindow: 128000 }]),
    ]
    const aggregation = buildAggregationProviderInfo(routes, providers)!
    expect(aggregation.models[0]!.contextWindow).toBe(128000)
    expect(deriveRouteContextWindow(routes[0]!.members, providers)).toBe(128000)
    // 全缺省形态：contextWindow 键缺省（undefined 语义与 pi 缺省声明同形退化，保守成立）
    const bare = buildAggregationProviderInfo(routes, [endpointProvider('p1', [{ id: 'm1' }]), endpointProvider('p2', [{ id: 'm2' }])])!
    expect(bare.models[0]!.contextWindow).toBeUndefined()
  })

  it('注入条目元数据形态：kind/reasoning 恒定 + apiKeySet=false + 无 quota 声明（隐式排除前提）', () => {
    const routes = [route('meta-route', [member('ep', 'p', 'm')])]
    const aggregation = buildAggregationProviderInfo(routes, [endpointProvider('p', [{ id: 'm' }])])!
    expect(aggregation.kind).toBe('aggregation')
    expect(aggregation.id).toBe(AGGREGATION_PROVIDER_ID)
    expect(aggregation.apiKeySet).toBe(false)
    expect(aggregation.baseUrl).toBeUndefined()
    expect(aggregation.api).toBeUndefined()
    expect(aggregation.quota).toBeUndefined()
    // 不标 enabled 字段（缺省即启用——聚合条目不被 enabledModels 渠道白名单门控，D10）
    expect(aggregation.enabled).toBeUndefined()
    expect(aggregation.models[0]!.reasoning).toBe(true)
  })
})
