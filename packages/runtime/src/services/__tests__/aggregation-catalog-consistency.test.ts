/**
 * aggregation-catalog-consistency.test（provider-aggregation A9/RL1 目录一致性对账）。
 *
 * RL1 形态：同一配置 fixture 喂注入器与扩展注册器，断言两侧条目集相等（同一加载时点）。
 * 注入器半边：runtime listProviders 注入条目集 ⇔ routes 配置 fixture 的确定性对账
 * （id 集相等、启停一致、复合串对齐键与 shared 单点一致、隐式排除前提成立）。
 * 扩展注册器半边：extensions/universal/provider-aggregation 导出的注册条目集纯函数
 * buildVirtualModelDefinitions（派生规则单源——扩展工厂工厂期 / session_start 对账 /
 * route 求值前重读三处注册时点与本对账同函数）以同一 fixture（FIXTURE_ROUTES +
 * ENDPOINT_PROVIDERS 目录快照）派生注册条目集，与注入器条目集相等对账：id 集 /
 * enabled 投影 / thinkingLevels 并集键集 / contextWindow 最小值——扩展工厂派生规则
 * 漂移时本对账必变红。contextWindow 解析规则同样单源（resolveContextWindowFromDirectory），
 * 本文件只构造 fixture 形态的目录快照，不复制最小值/省略规则。
 */
import { describe, expect, it } from 'vitest'
import type { AggregationRoute, ProviderInfo } from '@taiji/shared'
import { AGGREGATION_PROVIDER_ID, buildAggregationModelRef } from '@taiji/shared'
import type { IConfigStore } from '../ports/config.js'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'
import type { ProviderExtrasReader } from '../migration/provider-extras-migration.js'
import { listProviders } from '../provider-config-helper.js'
import {
  buildVirtualModelDefinitions,
  resolveContextWindowFromDirectory,
} from '../../../../../extensions/universal/provider-aggregation/src/virtual-model-definitions.ts'

/** 目录一致性 fixture：双端点路由（A 启用 / B 停用）+ 物理端点 provider。端点 levels
 * 声明不齐（ep-1 多 minimal、ep-2 仅 off/high，xhigh 显式 null）——档位并集派生两侧
 * 同源对账的实质输入（空 levels 会让并集断言退化为恒空）。 */
function routeOf(id: string, enabled: boolean): AggregationRoute {
  return {
    id,
    name: `路由 ${id}`,
    modelId: id,
    enabled,
    mode: 'advanced',
    specials: [],
    members: [
      { id: 'ep-1', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'window', levels: { off: 'off', minimal: 'minimal', high: 'high', xhigh: null } },
      { id: 'ep-2', providerId: 'opencode-go', modelId: 'zai-glm-5.3-flash', type: 'none', levels: { off: 'off', high: 'high' } },
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

// ── 扩展注册器半边（A9/RL1 联合对账） ────────────────────────────────────────────────
// 同一 fixture（上方 FIXTURE_ROUTES + ENDPOINT_PROVIDERS）喂扩展注册条目派生纯函数，
// 与注入器输出逐项相等。目录快照按 fixture 物理端点构造；最小值/省略规则不在此复制
// （resolveContextWindowFromDirectory 单源）。端点悬空时两侧省略形态按各自登记分流
// （注入器取已知最小值 / 注册器省略 = pi 合成 0，impl-plan notes ② 登记）——RL1 对账
// 前提是同一加载时点的目录一致 fixture，悬空场景不入本对账。
const fixtureDirectory = {
  find: (providerId: string, modelId: string) =>
    ENDPOINT_PROVIDERS.find(p => p.id === providerId)?.models.find(m => m.id === modelId),
}

describe('aggregation-catalog-consistency（A9/RL1 联合对账：扩展注册器半边同 fixture 相等）', () => {
  const registered = buildVirtualModelDefinitions(FIXTURE_ROUTES, route => resolveContextWindowFromDirectory(fixtureDirectory, route))
  const injected = injectFixture(FIXTURE_ROUTES).find(p => p.id === AGGREGATION_PROVIDER_ID)
  const enabledOf = (id: string): boolean => FIXTURE_ROUTES.find(r => r.id === id)!.enabled

  it('注册条目集 = fixture 全集（含停用路由——注册侧停用 = 保持注册，AS22/D9；provider/id/name 承载一致）', () => {
    expect(registered.map(d => d.id)).toEqual(FIXTURE_ROUTES.map(r => r.id))
    expect(registered.every(d => d.provider === AGGREGATION_PROVIDER_ID)).toBe(true)
    expect(registered.every(d => d.name === `路由 ${d.id}`)).toBe(true)
  })

  it('enabled 投影相等：注册条目按 fixture enabled 投影 = 注入条目集（RL1「条目集合、id、启停一致」）', () => {
    expect(injected).toBeDefined()
    const enabledRegisteredIds = registered.filter(d => enabledOf(d.id)).map(d => d.id)
    expect(enabledRegisteredIds).toEqual(injected!.models.map(m => m.id))
    // 停用条目只在注册侧存在（route-b：注册保持、注入不出现——两侧分工的负向锁定）
    expect(registered.map(d => d.id)).toContain('route-b')
    expect(injected!.models.map(m => m.id)).not.toContain('route-b')
  })

  it('thinkingLevels 并集相等：注册条目 thinkingLevels = 注入条目 thinkingLevelMap 非 null 键（端点档位不齐 + null 键不支持语义两侧一致，D4 ⑤/D7）', () => {
    for (const d of registered) {
      const entry = injected!.models.find(m => m.id === d.id)
      if (!entry) continue // 停用条目注入侧不出现（enabled 投影断言已核对）
      const nonNullLevels = Object.entries(entry.thinkingLevelMap ?? {}).filter(([, v]) => v !== null).map(([k]) => k)
      expect(nonNullLevels).toEqual(d.thinkingLevels)
      // fixture 端点档位不齐（ep-1 独有 minimal、xhigh 显式 null）→ 并集恰为三档，防恒真
      expect(d.thinkingLevels).toEqual(['off', 'minimal', 'high'])
    }
  })

  it('contextWindow 相等：两侧同为端点最小值 128000（解析与省略规则单源 resolveContextWindowFromDirectory）', () => {
    for (const d of registered) {
      const entry = injected!.models.find(m => m.id === d.id)
      if (!entry) continue
      expect(d.contextWindow).toBe(entry.contextWindow)
      expect(d.contextWindow).toBe(128000)
    }
  })
})
