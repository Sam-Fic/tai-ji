/**
 * provider-extra-model-sync 单测（G-extra 存量刷新半边的合并写盘语义）。
 *
 * 红线用例：同 id 覆盖 / 新 id 追加 / 不删除本地（含用户手动加的模型）/ 非 taijiExtra
 * provider 不触碰 / models.json 无该 provider 条目时不创建 / 无变化 no-op（零写盘）。
 * 策略同 remote-provider-sync.test.ts（tmp dataDir + resetModules 动态 import）。
 *
 * 模板数据源是编译期快照（builtin-providers.json 的 taijiExtra 段），不 mock——用真实
 * opendesign 模板断言「快照里 reasoning 全 true」这类内容口径，快照改坏时这里会红。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IConfigStore } from '../ports/config.js'
import type { ProviderExtras } from '../provider-extras-store.js'
import type { ProviderExtrasAccessors } from '../provider-config-helper.js'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pems-test-'))
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function loadFresh() {
  vi.resetModules()
  return await import('../provider-extra-model-sync.js')
}

/**
 * 轻量 fake：只实现 sync 链路消费的 IConfigStore 面。upsertProvider 记录调用（写盘断言）
 * 并把结果回写内存（供「幂等重跑 no-op」断言用）。
 */
function makeConfigStore(initial: Record<string, Record<string, unknown>>) {
  const providers = new Map<string, Record<string, unknown>>(
    Object.entries(initial).map(([id, cfg]) => [id, structuredClone(cfg)]),
  )
  const upserts: Array<{ id: string; entry: Record<string, unknown> }> = []
  const store = {
    readModels: () => ({ providers: Object.fromEntries(providers) }),
    getProviderConfig: (id: string) => providers.get(id),
    upsertProvider: (id: string, entry: Record<string, unknown>) => {
      providers.set(id, structuredClone(entry))
      upserts.push({ id, entry })
      return {}
    },
    getEnabledModels: () => [],
    setEnabledModels: () => {},
    ensureProviderInWhitelist: () => {},
  }
  return { store: store as unknown as IConfigStore, upserts, providers }
}

function makeExtrasStore(): ProviderExtrasAccessors {
  const providers: Record<string, ProviderExtras> = {}
  return {
    getExtrasSync: (id: string) => providers[id],
    modify: async (id: string, fn: (cur: ProviderExtras | undefined) => ProviderExtras) => {
      providers[id] = fn(providers[id])
      return providers[id]
    },
    cleanScopedModelsResidue: async () => {},
  }
}

// 首载成本预热（同 remote-config 家族测试注释）：本模块经 provider-catalog 连带装载
// builtin-providers.json 快照（1546 models），首次 import 的 transform/解析开销约 3-8s，
// 全部记在第一个用例头上（慢用例门禁按 testcase time 判定，阈值 2s）。钩子里先加载一次，
// 把那笔包级成本从用例耗时中剥离——不是放宽判据。
// hook 超时显式放宽：装载成本（快照 1546 models 首次解析），不是断言盲等。
beforeAll(async () => {
  await loadFresh()
}, 60_000)

describe('syncTaijiExtraProviderModels', () => {
  it('存量条目 reasoning:false → 用快照模板覆盖为 reasoning:true 且带 thinkingLevelMap/compat/cost', async () => {
    const { store, upserts } = makeConfigStore({
      opendesign: {
        models: [
          // 旧快照形态：非思考 + cost 缺键
          { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 1048000, maxTokens: 32000 },
          // 用户自行追加的模型（模板里没有）→ 必须保留
          { id: 'my-local-model', name: 'My Local', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 8000, maxTokens: 1000 },
        ],
      },
    })
    const mod = await loadFresh()
    const result = await mod.syncTaijiExtraProviderModels({
      configStore: store,
      extrasStore: makeExtrasStore(),
    })

    expect(result.updatedProviders).toEqual(['opendesign'])
    expect(upserts).toHaveLength(1)
    const models = upserts[0].entry.models as Array<Record<string, unknown>>

    const pro = models.find((m) => m.id === 'deepseek-v4-pro')
    expect(pro).toBeDefined()
    expect(pro!.reasoning).toBe(true)
    expect(pro!.thinkingLevelMap).toMatchObject({ off: 'off', high: 'high', max: 'max' })
    expect(pro!.compat).toMatchObject({ thinkingFormat: 'deepseek', supportsReasoningEffort: true })
    expect(pro!.cost).toMatchObject({ input: 1.32, output: 3.96 })
    // context_budget 口径：deepseek-v4-pro 的 output_budget 是 128000
    expect(pro!.maxTokens).toBe(128000)

    // 用户自定义模型保留（不删除本地）
    expect(models.some((m) => m.id === 'my-local-model')).toBe(true)
    // 模板新增的模型被追加（14 个模板 id 全在）
    expect(models.length).toBe(new Set([...models.map((m) => String(m.id))]).size)
    for (const id of ['deepseek-v4.1-flash-eco', 'minimax-m3.1-flash']) {
      expect(models.some((m) => m.id === id), `模板模型 ${id} 应被追加`).toBe(true)
    }
  })

  it('模板 null 值键不落盘（thinkingLevelMap 里的 null 档保留，其余字段不写 null）', async () => {
    const { store, upserts } = makeConfigStore({ opendesign: { models: [] } })
    const mod = await loadFresh()
    await mod.syncTaijiExtraProviderModels({ configStore: store, extrasStore: makeExtrasStore() })
    const models = upserts[0].entry.models as Array<Record<string, unknown>>

    // glm-5.3-flashx 的 medium 档为 null（端点显式拒绝）→ thinkingLevelMap 内层 null 保留
    const flashx = models.find((m) => m.id === 'glm-5.3-flashx')!
    expect((flashx.thinkingLevelMap as Record<string, string | null>).medium).toBeNull()
    // 顶层字段不出现 null（pi models.json 对象字段 null 会拒载整表）
    for (const m of models) {
      for (const [k, v] of Object.entries(m)) {
        expect(v, `${m.id} 的字段 ${k} 不应为 null`).not.toBeNull()
      }
    }
  })

  it('非 taijiExtra provider 不触碰（custom provider 的模型原样保留、零写盘）', async () => {
    const { store, upserts } = makeConfigStore({
      'my-custom': { models: [{ id: 'x', name: 'X', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 1000, maxTokens: 100 }] },
    })
    const mod = await loadFresh()
    const result = await mod.syncTaijiExtraProviderModels({ configStore: store, extrasStore: makeExtrasStore() })
    expect(result.updatedProviders).toEqual([])
    expect(upserts).toHaveLength(0)
  })

  it('models.json 无该 provider 条目 → 不创建（未添加的 provider 不出现在 pi 加载源）', async () => {
    const { store, upserts } = makeConfigStore({})
    const mod = await loadFresh()
    const result = await mod.syncTaijiExtraProviderModels({ configStore: store, extrasStore: makeExtrasStore() })
    expect(result.updatedProviders).toEqual([])
    expect(upserts).toHaveLength(0)
  })

  it('幂等：同步写盘后再跑一次 → 无变化 no-op（零写盘，防 mtime 抖动触发广播）', async () => {
    const { store, upserts } = makeConfigStore({ opendesign: { models: [] } })
    const mod = await loadFresh()
    await mod.syncTaijiExtraProviderModels({ configStore: store, extrasStore: makeExtrasStore() })
    expect(upserts).toHaveLength(1)

    const second = await mod.syncTaijiExtraProviderModels({ configStore: store, extrasStore: makeExtrasStore() })
    expect(second.updatedProviders).toEqual([])
    expect(upserts).toHaveLength(1)
  })
})

describe('templateModelToDefinition', () => {
  it('剥除顶层 null 键，保留嵌套 null（thinkingLevelMap 内层语义）', async () => {
    const mod = await loadFresh()
    const out = mod.templateModelToDefinition({
      id: 'm1',
      cost: null,
      compat: null,
      thinkingLevelMap: { off: 'off', medium: null },
      maxTokens: 1000,
    })
    expect(out).not.toHaveProperty('cost')
    expect(out).not.toHaveProperty('compat')
    expect(out.thinkingLevelMap).toEqual({ off: 'off', medium: null })
    expect(out.maxTokens).toBe(1000)
  })
})
