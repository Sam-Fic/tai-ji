/**
 * session-model-virtual.test（provider-aggregation A5/RL5 切换链适配单测）。
 *
 * 断言面（RL5 逐条）：
 * ① set_model 路由条目成功且 get_state 回执为路由引用（虚拟引用原样返回，非 route 后物理模型）；
 * ② 凭据豁免：聚合 provider 无凭据（apiKeySet=false）不误报 PROVIDER_CREDENTIAL_MISSING（AS9）；
 * ③ 不在 taiji 注册表的模型 id → MODEL_NOT_FOUND（注入层未含的 id 正确命中）；
 * ④ 运行中新建路由窗口（注册表命中 + pi 未注册 + 扩展已装载）→ AGGREGATION_ROUTE_NOT_IN_SESSION
 *    可操作提示，不落 ENGINE_MODEL_MISSING 双因文案（D1 ③/D4 时点差）；
 * ⑤ 扩展禁用态 → AGGREGATION_EXTENSION_DISABLED（指引「在扩展管理中启用」，D9 ②）；
 * ⑥ pi 凭据缺失文本（No API key 前缀）→ PROVIDER_CREDENTIAL_MISSING 结构化映射（AX5 切换半边）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { IConfigService } from '../../../interfaces.js'
import type { IPiEngine } from '../../ports/pi-engine.js'
import type { IManagedSessionView } from '../types.js'
import type { SessionReplicatedStates } from '../session-state-projection.js'
import {
  AGGREGATION_EXTENSION_DISABLED,
  AGGREGATION_ROUTE_NOT_IN_SESSION,
  ENGINE_MODEL_MISSING,
  MODEL_NOT_FOUND,
  PROVIDER_CREDENTIAL_MISSING,
} from '../../../utils/errors.js'
import { AGGREGATION_PROVIDER_ID } from '@taiji/shared'
import { SessionModelControl, formatCredentialMissingPresentation, isPiCredentialMissingError } from '../session-model-control.js'
import { isModelInRegistry, providerHasCredential } from '../session-model-guards.js'

/** 可变 session 视图（与 session-model-bundle 同款最小形态）。 */
function makeSession(): IManagedSessionView {
  return { modelId: 'old/provider-old', thinkingLevel: 'medium' } as unknown as IManagedSessionView
}

interface VirtualFixtureOptions { // oe-exempt:20261106:framework:VirtualFixtureOptions 测试 fixture，单实现为设计终态
  /** listProviders 输出（isModelRegistered/hasProviderCredential 两判的数据源）。 */
  providers?: Array<{ id: string; models?: Array<{ id: string }>; apiKeySet?: boolean }>
  /** 扩展装载态（默认已装载）。 */
  routeExtensionLoadable?: boolean
  /** setModel 实现（默认成功）。 */
  setModelImpl?: () => Promise<void>
  /** get_state 读回（默认聚合引用原样返回）。 */
  stateModel?: { provider: string; id: string } | undefined
}

function makeVirtualFixture(opts: VirtualFixtureOptions = {}) {
  const providers = opts.providers ?? [
    { id: AGGREGATION_PROVIDER_ID, models: [{ id: 'route-a' }], apiKeySet: false },
    { id: 'p-phys', models: [{ id: 'm-phys' }], apiKeySet: true },
  ]
  const configService = {
    listProviders: () => providers,
  } as unknown as IConfigService
  const session = makeSession()
  const markDirty = { modelId: vi.fn(), usage: vi.fn(), thinkingLevel: vi.fn() }
  const states = {
    modelId: { markDirty: markDirty.modelId },
    usage: { markDirty: markDirty.usage },
    thinkingLevel: { markDirty: markDirty.thinkingLevel },
  } as unknown as SessionReplicatedStates
  const client = {
    setModel: vi.fn(opts.setModelImpl ?? (async () => undefined)),
    setThinkingLevel: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ model: opts.stateModel === undefined ? { id: 'route-a', provider: AGGREGATION_PROVIDER_ID } : opts.stateModel })),
    exited: false,
  }
  const control = new SessionModelControl({
    getSession: vi.fn(() => session),
    getReplicatedStates: vi.fn(() => states),
    syncTraceEntries: vi.fn(),
    ensureActive: vi.fn(async () => client as unknown as IPiEngine),
    // 两判走真 guards（凭据豁免与注册表判定是本文件的被测面，不经 mock 绕过）
    isModelRegistered: (provider, modelId) => isModelInRegistry(configService, provider, modelId),
    hasProviderCredential: (provider) => providerHasCredential(configService, provider),
    isRouteExtensionLoadable: () => opts.routeExtensionLoadable ?? true,
  })
  return { control, session, markDirty, client }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('session-model-virtual（A5/RL5 切换链适配）', () => {
  it('① set_model 路由条目成功：回执 = 路由引用原样（get_state 读回虚拟引用，非物理模型）', async () => {
    const { control, session, markDirty, client } = makeVirtualFixture()
    const result = await control.switchModel('s1', AGGREGATION_PROVIDER_ID as never, 'route-a')
    expect(client.setModel).toHaveBeenCalledWith(AGGREGATION_PROVIDER_ID, 'route-a')
    expect(result).toBe(`${AGGREGATION_PROVIDER_ID}/route-a`)
    expect(session.modelId).toBe(`${AGGREGATION_PROVIDER_ID}/route-a`)
    expect(markDirty.modelId).toHaveBeenCalledTimes(1)
  })

  it('② 凭据豁免（AS9）：聚合 provider apiKeySet=false 不误报 PROVIDER_CREDENTIAL_MISSING（三分型不落凭据码）', async () => {
    // pi 拒绝（Model not found）+ 注册表命中（B 已注入可见）+ 聚合 provider 无凭据——
    // 若无豁免会在此落 PROVIDER_CREDENTIAL_MISSING；豁免后走路由条目分支。
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { control } = makeVirtualFixture({
        providers: [{ id: AGGREGATION_PROVIDER_ID, models: [{ id: 'route-a' }, { id: 'route-b' }], apiKeySet: false }],
        setModelImpl: async () => { throw new Error(`Model not found: ${AGGREGATION_PROVIDER_ID}/route-b`) },
      })
      await expect(control.switchModel('s1', AGGREGATION_PROVIDER_ID as never, 'route-b'))
        .rejects.toMatchObject({ code: AGGREGATION_ROUTE_NOT_IN_SESSION })
      // guards 直测：聚合 provider 恒判齐备（configService 为 null 的 fail-open 形态同样豁免）
      expect(providerHasCredential(null, AGGREGATION_PROVIDER_ID)).toBe(true)
    } finally {
      errors.mockRestore()
    }
  })

  it('③ 注入层未含的 id → MODEL_NOT_FOUND 正确命中（聚合 provider 下的未注册路由 id）', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 聚合条目只注入 route-a；route-zz 不在 listProviders 输出（未注册/停用路由）
      const { control } = makeVirtualFixture({
        providers: [{ id: AGGREGATION_PROVIDER_ID, models: [{ id: 'route-a' }], apiKeySet: false }],
        setModelImpl: async () => { throw new Error(`Model not found: ${AGGREGATION_PROVIDER_ID}/route-zz`) },
      })
      await expect(control.switchModel('s1', AGGREGATION_PROVIDER_ID as never, 'route-zz'))
        .rejects.toMatchObject({ code: MODEL_NOT_FOUND })
    } finally {
      errors.mockRestore()
    }
  })

  it('④ 运行中新建路由窗口：注册表命中 + 扩展已装载 → AGGREGATION_ROUTE_NOT_IN_SESSION（不落双因文案）', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { control } = makeVirtualFixture({
        // 注册表同时含 A（已注册）与 B（运行中新建——磁盘派生即时可见）
        providers: [
          { id: AGGREGATION_PROVIDER_ID, models: [{ id: 'route-a' }, { id: 'route-b' }], apiKeySet: false },
        ],
        setModelImpl: async () => { throw new Error(`Model not found: ${AGGREGATION_PROVIDER_ID}/route-b`) },
        routeExtensionLoadable: true,
      })
      const err = await control.switchModel('s1', AGGREGATION_PROVIDER_ID as never, 'route-b').then(
        () => { throw new Error('should reject') },
        (e: unknown) => e as Error & { code: string },
      )
      expect(err.code).toBe(AGGREGATION_ROUTE_NOT_IN_SESSION)
      expect(err.code).not.toBe(ENGINE_MODEL_MISSING)
      expect(err.message).toContain('aggregation/route-b')
    } finally {
      errors.mockRestore()
    }
  })

  it('⑤ 扩展禁用态：→ AGGREGATION_EXTENSION_DISABLED（不落「新建会话」语义的同分支）', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { control } = makeVirtualFixture({
        setModelImpl: async () => { throw new Error(`Model not found: ${AGGREGATION_PROVIDER_ID}/route-a`) },
        routeExtensionLoadable: false,
      })
      await expect(control.switchModel('s1', AGGREGATION_PROVIDER_ID as never, 'route-a'))
        .rejects.toMatchObject({ code: AGGREGATION_EXTENSION_DISABLED })
    } finally {
      errors.mockRestore()
    }
  })

  it('⑥ pi 凭据缺失文本（No API key）→ PROVIDER_CREDENTIAL_MISSING 结构化映射（含端点名）', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { control } = makeVirtualFixture({
        setModelImpl: async () => { throw new Error('No API key for p-phys/m-phys') },
      })
      const err = await control.switchModel('s1', 'p-phys' as never, 'm-phys').then(
        () => { throw new Error('should reject') },
        (e: unknown) => e as Error & { code: string },
      )
      expect(err.code).toBe(PROVIDER_CREDENTIAL_MISSING)
      expect(err.message).toContain('p-phys/m-phys')
      expect(isPiCredentialMissingError(new Error('No API key for provider: p-phys'))).toBe(true)
      expect(isPiCredentialMissingError(new Error('Model not found: p/m'))).toBe(false)
    } finally {
      errors.mockRestore()
    }
  })
})

describe('formatCredentialMissingPresentation（AX5 出站映射，凭据缺失形态）', () => {
  it('三变体端点名提取 + 恢复指引', () => {
    expect(formatCredentialMissingPresentation('No API key for zhipu/glm-5.3-flash'))
      .toContain('zhipu/glm-5.3-flash')
    expect(formatCredentialMissingPresentation('No API key for provider: opencode-go'))
      .toContain('opencode-go')
    expect(formatCredentialMissingPresentation('No API key provided for provider "zai"'))
      .toContain('zai')
    for (const mapped of [
      formatCredentialMissingPresentation('No API key for zhipu/glm-5.3-flash')!,
      formatCredentialMissingPresentation('No API key for provider: opencode-go')!,
    ]) {
      expect(mapped).toContain('设置页')
      expect(mapped).toContain('API Key')
    }
  })

  it('非凭据缺失文本返回 undefined（原样透传，不为厂商失败形态建永不触发的分支）', () => {
    expect(formatCredentialMissingPresentation('API 返回 429: rate limited')).toBeUndefined()
    expect(formatCredentialMissingPresentation('fetch failed')).toBeUndefined()
    expect(formatCredentialMissingPresentation('')).toBeUndefined()
  })
})
