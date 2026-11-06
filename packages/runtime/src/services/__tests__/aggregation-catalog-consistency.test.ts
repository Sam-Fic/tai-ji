/**
 * aggregation-catalog-consistency.test（provider-aggregation A9/RL1 目录一致性对账，注入器半边）。
 *
 * RL1 形态：同一配置 fixture 喂注入器与扩展注册器，断言两侧条目集相等（同一加载时点）。
 * 本文件承载**注入器半边**（runtime listProviders 注入条目集 ⇔ routes 配置 fixture 的
 * 确定性对账：id 集相等、启停一致、复合串对齐键与 shared 单点一致、隐式排除前提成立）。
 *
 * 扩展注册器半边接入点（A9 完整形态）：u-pi-extension 交付 extensions/universal/
 * provider-aggregation 的注册器纯函数（routes → pi 注册条目集）后，在同一 fixture 上断言
 * 两侧条目集相等（注册侧 id 集与 enabled 集对照下方注入侧断言）；并行调度下扩展包由
 * u-pi-extension 单元交付，其自测（route-matrix / hot-reload）覆盖注册侧确定性，两侧
 * 联合对账随该单元落盘（impl-plan A9 依赖列 = u-runtime-inject、u-pi-extension 双方）。
 */
import { describe, expect, it } from 'vitest'
import type { AggregationRoute, ProviderInfo } from '@taiji/shared'
import { AGGREGATION_PROVIDER_ID, buildAggregationModelRef } from '@taiji/shared'
import type { IConfigStore } from '../ports/config.js'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'
import type { ProviderExtrasReader } from '../migration/provider-extras-migration.js'
import { listProviders } from '../provider-config-helper.js'

/** 目录一致性 fixture：双端点路由（A 启用 / B 停用）+ 物理端点 provider。 */
function routeOf(id: string, enabled: boolean): AggregationRoute {
  return {
    id,
    name: `路由 ${id}`,
    modelId: id,
    enabled,
    mode: 'advanced',
    specials: [],
    members: [
      { id: 'ep-1', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'window' },
      { id: 'ep-2', providerId: 'opencode-go', modelId: 'zai-glm-5.3-flash', type: 'none' },
    ],
  }
}

const FIXTURE_ROUTES = [routeOf('route-a', true), routeOf('route-b', false)]

const ENDPOINT_PROVIDERS: ProviderInfo[] = [
  {
    id: 'zhipu' as ProviderInfo['id'],
    name: 'zhipu',
    apiKeySet: true,
    status: 'connected',
    kind: 'custom',
    models: [{ id: 'glm-5.3-flash', contextWindow: 200000, reasoning: true, thinkingLevelMap: { off: 'off', minimal: 'minimal', high: 'high' } }],
  },
  {
    id: 'opencode-go' as ProviderInfo['id'],
    name: 'opencode-go',
    apiKeySet: true,
    status: 'connected',
    kind: 'custom',
    models: [{ id: 'zai-glm-5.3-flash', contextWindow: 128000, reasoning: true, thinkingLevelMap: { off: 'off', minimal: 'minimal', high: 'high' } }],
  },
]

function makeConfigStore(): IConfigStore {
  return {
    // models.json 条目形态与 custom 聚合读源一致（contextWindow 经 pickModelCapabilityFields
    // 透传——缺它注入条目的端点最小值派生会落空）
    readModels: () => ({
      providers: Object.fromEntries(ENDPOINT_PROVIDERS.map(p => [p.id, {
        name: p.name, apiKey: 'k',
        models: p.models.map(m => ({ id: m.id, contextWindow: m.contextWindow, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap })),
      }])),
    }),
    getEnabledModels: () => [],
  } as unknown as IConfigStore
}

type RoutesStoreStub = ProviderExtrasReader & { getAggregationRoutesWithDiagnosticsSync(): { routes: AggregationRoute[] } }

function makeExtrasStore(routes: AggregationRoute[]): RoutesStoreStub {
  return {
    getExtrasSync: () => undefined,
    readAllSync: () => ({}),
    getAggregationRoutesWithDiagnosticsSync: () => ({ routes }),
  } as RoutesStoreStub
}

const credentialResolver = {
  listCredentialBackedProviderIds: () => new Set<string>(['zhipu', 'opencode-go']),
} as unknown as IProviderCredentialResolver

function injectFixture(routes: AggregationRoute[]): ProviderInfo[] {
  return listProviders(makeConfigStore(), undefined, makeExtrasStore(routes), credentialResolver)
}

describe('aggregation-catalog-consistency（A9/RL1 目录一致性对账，注入器半边）', () => {
  const providers = injectFixture(FIXTURE_ROUTES)
  const aggregation = providers.find(p => p.id === AGGREGATION_PROVIDER_ID)

  it('注入条目集 = enabled 路由集（id 与顺序一致；停用路由不进目录）', () => {
    expect(aggregation).toBeDefined()
    const enabledFixtureIds = FIXTURE_ROUTES.filter(r => r.enabled).map(r => r.id)
    expect(aggregation!.models.map(m => m.id)).toEqual(enabledFixtureIds)
    // 停用路由（route-b）不注入（D9 停用侧：选择器不出现）
    expect(aggregation!.models.map(m => m.id)).not.toContain('route-b')
  })

  it('对齐键一致：注入条目复合串 = shared buildAggregationModelRef 单点产出', () => {
    for (const m of aggregation!.models) {
      expect(buildAggregationModelRef(m.id)).toBe(`${AGGREGATION_PROVIDER_ID}/${m.id}`)
    }
  })

  it('注入器条目启停恒 enabled（只有启用的路由进目录）与端点元数据派生自同一 fixture', () => {
    expect(aggregation!.models.every(m => m.enabled === true)).toBe(true)
    // contextWindow = 端点最小值（fixture 端点 200000/128000 → 128000）
    expect(aggregation!.models[0]!.contextWindow).toBe(128000)
  })

  it('隐式排除前提成立：聚合条目 apiKeySet=false 且无 quota 声明（D4 ① (c)/quota 系过滤条件）', () => {
    expect(aggregation!.apiKeySet).toBe(false)
    expect(aggregation!.quota).toBeUndefined()
    expect(aggregation!.baseUrl).toBeUndefined()
    expect(aggregation!.kind).toBe('aggregation')
    // 物理端点 provider 不受注入影响（同帧双源输出集合不变；序 = 既有聚合规则——
    // opencode-go 是真实 catalog 快照条目走 catalog 段在前，zhipu 走 custom 段在后）
    const physical = providers.filter(p => p.kind !== 'aggregation').map(p => p.id)
    expect(physical).toHaveLength(2)
    expect(physical).toEqual(expect.arrayContaining(['zhipu', 'opencode-go']))
  })

  it('零路由 / 全停用环境不注入聚合壳条目（V8 零配置回归：无路由分组残留）', () => {
    expect(injectFixture([]).some(p => p.id === AGGREGATION_PROVIDER_ID)).toBe(false)
    expect(injectFixture([routeOf('route-off', false)]).some(p => p.id === AGGREGATION_PROVIDER_ID)).toBe(false)
  })
})
