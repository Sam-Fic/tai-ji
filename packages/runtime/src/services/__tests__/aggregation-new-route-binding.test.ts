/**
 * aggregation-new-route-binding.test（provider-aggregation A8/RL8 运行时序列集成，L1 可脚本化）。
 *
 * 序列（D1 ③/D4 时点差语义，同一进程内以可变 extras store 模拟配置保存、以 mock pi client
 * 模拟 pi 进程注册态）：
 * ① 路由配置只有 A → 注入层（listProviders）只见 A；
 * ② 新建路由 B 并保存（extras store 更新）→ 注入层立即可见 B（纯磁盘派生，无 pi 注册态过滤）；
 * ③ 未重载的会话 set_model B：pi 以 `Model not found` 拒绝 → runtime 按路由条目分支映射为
 *    AGGREGATION_ROUTE_NOT_IN_SESSION 可操作提示（不落 ENGINE_MODEL_MISSING 双因文案）；
 * ④ 会话重载（新进程工厂期注册，此处以「pi client 接受 B」模拟注册完成）→ set_model B 成功，
 *    回执 = 路由引用。
 */
import { describe, expect, it, vi } from 'vitest'
import type { IConfigService } from '../../interfaces.js'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { AggregationRoute, ProviderInfo } from '@taiji/shared'
import { AGGREGATION_PROVIDER_ID } from '@taiji/shared'
import type { IConfigStore } from '../ports/config.js'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'
import type { ProviderExtrasReader } from '../migration/provider-extras-migration.js'
import { listProviders } from '../provider-config-helper.js'
import { ModelService } from '../model-service.js'
import {
  AGGREGATION_ROUTE_NOT_IN_SESSION,
  ENGINE_MODEL_MISSING,
} from '../../utils/errors.js'
import { isModelInRegistry, providerHasCredential } from '../session/session-model-guards.js'
import { SessionModelControl } from '../session/session-model-control.js'
import type { IManagedSessionView } from '../session/types.js'
import type { SessionReplicatedStates } from '../session/session-state-projection.js'

/** 可变 extras store stub：readAllExtrasWithFallback 所需双读 + U3 注入的 routes 读取。 */
type MutableRoutesStore = ProviderExtrasReader & {
  getAggregationRoutesWithDiagnosticsSync(): { routes: AggregationRoute[] }
  __setRoutes(next: AggregationRoute[]): void
}

function makeExtrasStore(initialRoutes: AggregationRoute[]): MutableRoutesStore {
  let routes = initialRoutes
  return {
    getExtrasSync: () => undefined,
    readAllSync: () => ({}),
    getAggregationRoutesWithDiagnosticsSync: () => ({ routes }),
    // 序列驱动点：模拟 U9 保存编排写 routes 段后的磁盘态
    __setRoutes(next: AggregationRoute[]) { routes = next },
  } as MutableRoutesStore
}

function routeOf(id: string): AggregationRoute {
  return { id, name: `路由 ${id}`, modelId: id, enabled: true, mode: 'advanced', specials: [], members: [{ id: 'ep-1', providerId: 'p-phys', modelId: 'm-phys', type: 'none' }] }
}

function makeConfigStore(): IConfigStore {
  return {
    readModels: () => ({ providers: { 'p-phys': { name: 'phys', apiKey: 'k', models: [{ id: 'm-phys' }] } } }),
    getEnabledModels: () => [],
  } as unknown as IConfigStore
}

const credentialResolver = {
  listCredentialBackedProviderIds: () => new Set<string>(['p-phys']),
} as unknown as IProviderCredentialResolver

function injectedProviderIds(providers: ProviderInfo[]): Set<string> {
  const aggregation = providers.find(p => p.id === AGGREGATION_PROVIDER_ID)
  return new Set(aggregation?.models.map(m => m.id) ?? [])
}

/** model.list 聚合链探针：ModelService 双参聚合（最小 setServices 装配，scopedModels 由调用方传）。 */
function aggregateModels(providers: ProviderInfo[], scopedModels: string[]) {
  const modelService = new ModelService({} as ConstructorParameters<typeof ModelService>[0])
  modelService.setServices(
    {} as Parameters<ModelService['setServices']>[0],
    { getScopedModels: () => scopedModels } as Parameters<ModelService['setServices']>[1],
    {} as Parameters<ModelService['setServices']>[2],
  )
  return modelService.aggregateModelsWithScoped(providers, scopedModels)
}

describe('aggregation-new-route-binding（A8/RL8 运行时序列）', () => {
  it('① → ②：路由 B 保存后注入层立即可见（磁盘派生，无需 pi 注册态）', () => {
    const extrasStore = makeExtrasStore([routeOf('route-a')])
    const configStore = makeConfigStore()
    const initial = listProviders(configStore, undefined, extrasStore, credentialResolver)
    expect(injectedProviderIds(initial)).toEqual(new Set(['route-a']))
    expect(initial.find(p => p.id === AGGREGATION_PROVIDER_ID)?.kind).toBe('aggregation')
    // 保存路由 B（U9 写 routes 段）
    extrasStore.__setRoutes([routeOf('route-a'), routeOf('route-b')])
    const after = listProviders(configStore, undefined, extrasStore, credentialResolver)
    expect(injectedProviderIds(after)).toEqual(new Set(['route-a', 'route-b']))
    // model.list 聚合链同帧可见（scopedModels 空 = 全量放行，物理 + 路由并存）
    const models = aggregateModels(after, [])
    expect(models.map(m => `${m.providerId}/${m.id}`)).toContain(`${AGGREGATION_PROVIDER_ID}/route-b`)
    expect(models.find(m => m.id === 'route-b')?.aggregation).toBe(true)
  })

  it('③ → ④：未重载 set_model B 被映射为可操作提示（不落双因文案）；重载后成功路由', async () => {
    const extrasStore = makeExtrasStore([routeOf('route-a'), routeOf('route-b')])
    const providers = listProviders(makeConfigStore(), undefined, extrasStore, credentialResolver)
    const configService = {
      listProviders: () => providers,
    } as unknown as IConfigService

    // —— ③ 未重载会话：pi 进程只注册了 A，set_model B 被拒 ——
    const session = { modelId: 'old/x', thinkingLevel: 'medium' } as unknown as IManagedSessionView
    const states = {
      modelId: { markDirty: vi.fn() },
      usage: { markDirty: vi.fn() },
      thinkingLevel: { markDirty: vi.fn() },
    } as unknown as SessionReplicatedStates
    const client = {
      setModel: vi.fn(async (provider: string, modelId: string) => {
        // pi 进程注册集 = {route-a}（会话加载时点快照）——B 不在其中
        if (modelId === 'route-b') throw new Error(`Model not found: ${provider}/${modelId}`)
      }),
      setThinkingLevel: vi.fn(async () => undefined),
      getState: vi.fn(async () => ({ model: { id: 'route-a', provider: AGGREGATION_PROVIDER_ID } })),
      exited: false,
    }
    const control = new SessionModelControl({
      getSession: vi.fn(() => session),
      getReplicatedStates: vi.fn(() => states),
      syncTraceEntries: vi.fn(),
      ensureActive: vi.fn(async () => client as unknown as IPiEngine),
      isModelRegistered: (provider, modelId) => isModelInRegistry(configService, provider, modelId),
      hasProviderCredential: (provider) => providerHasCredential(configService, provider),
      isRouteExtensionLoadable: () => true,
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const err = await control.switchModel('s1', AGGREGATION_PROVIDER_ID as never, 'route-b').then(
        () => { throw new Error('should reject') },
        (e: unknown) => e as Error & { code: string },
      )
      expect(err.code).toBe(AGGREGATION_ROUTE_NOT_IN_SESSION)
      expect(err.code).not.toBe(ENGINE_MODEL_MISSING)
      // 注册表命中前提自证（B 在注入层可见——区分 MODEL_NOT_FOUND 与时点差分支的判据）
      expect(isModelInRegistry(configService, AGGREGATION_PROVIDER_ID, 'route-b')).toBe(true)

      // —— ④ 重载：新进程工厂期注册 B 完成（pi client 此后接受 B）→ set_model 成功路由 ——
      const result = await control.switchModel('s1', AGGREGATION_PROVIDER_ID as never, 'route-a')
      expect(result).toBe(`${AGGREGATION_PROVIDER_ID}/route-a`)
      client.setModel.mockImplementation(async () => undefined)
      client.getState.mockImplementation(async () => ({ model: { id: 'route-b', provider: AGGREGATION_PROVIDER_ID } }))
      const reloaded = await control.switchModel('s1', AGGREGATION_PROVIDER_ID as never, 'route-b')
      expect(reloaded).toBe(`${AGGREGATION_PROVIDER_ID}/route-b`)
    } finally {
      consoleError.mockRestore()
    }
  })
})
