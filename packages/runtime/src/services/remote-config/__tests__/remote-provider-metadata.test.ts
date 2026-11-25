/**
 * remote-provider-metadata 单测（域 5：附加段 provider 模型元数据补丁）。
 *
 * 红线用例：guard 整域拒（未知键 / 坏 cost / 重复 id / 版本不符）/ 字段级浅覆盖 /
 * cost 与 compat 整对象替换 / 新 id 追加 / removeModels 剔除 / 无数据退化纯快照。
 * 策略同 remote-config-fetch.test.ts（tmp dataDir + resetModules 动态 import）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rpm-test-'))
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function loadFresh() {
  vi.resetModules()
  return await import('../remote-provider-metadata.js')
}

function writeConfig(data: unknown): void {
  mkdirSync(join(dataDir, 'remote-config'), { recursive: true })
  writeFileSync(
    join(dataDir, 'remote-config', 'provider-model-metadata.json'),
    JSON.stringify({ version: 2, checkedAt: Date.now(), source: 'github', etags: {}, data }),
  )
}

const VALID: import('../remote-provider-metadata.js').ProviderModelMetadataConfig = {
  version: 1,
  providers: [
    {
      id: 'opendesign',
      models: [
        { id: 'deepseek-v4-pro', maxTokens: 64000, reasoning: true },
        { id: 'brand-new-model', name: 'Brand New', contextWindow: 200000, maxTokens: 8000 },
      ],
      removeModels: ['hy4-preview'],
    },
  ],
}

// 首载成本预热（同 remote-config-fetch.test.ts 注释）：首个用例的 1.3s 是模块图首次
// import 的 transform 开销，落在钩子里而非用例里（慢用例门禁按 testcase time 判定）。
// hook 超时显式放宽：装载成本（模块图首次 transform），不是断言盲等。
beforeAll(async () => {
  await loadFresh()
}, 60_000)

describe('isProviderModelMetadataConfig（域 guard，fail-visible）', () => {
  it('合法配置通过', async () => {
    const mod = await loadFresh()
    expect(mod.isProviderModelMetadataConfig(VALID)).toBe(true)
  })

  it('空 providers 数组合法（骨架形态）', async () => {
    const mod = await loadFresh()
    expect(mod.isProviderModelMetadataConfig({ version: 1, providers: [] })).toBe(true)
  })

  it('version 不符 → 拒', async () => {
    const mod = await loadFresh()
    expect(mod.isProviderModelMetadataConfig({ version: 2, providers: [] })).toBe(false)
  })

  it('未知模型字段（拼写错误）→ 整域拒', async () => {
    const mod = await loadFresh()
    expect(
      mod.isProviderModelMetadataConfig({
        version: 1,
        providers: [{ id: 'opendesign', models: [{ id: 'm1', maxToken: 100 }] }],
      }),
    ).toBe(false)
  })

  it('cost 缺字段（pi ModelCostSchema 拒载整表）→ 整域拒', async () => {
    const mod = await loadFresh()
    expect(
      mod.isProviderModelMetadataConfig({
        version: 1,
        providers: [{ id: 'opendesign', models: [{ id: 'm1', cost: { input: 1, output: 2, cacheRead: 0 } }] }],
      }),
    ).toBe(false)
  })

  it('cost 四字段齐全 → 通过', async () => {
    const mod = await loadFresh()
    expect(
      mod.isProviderModelMetadataConfig({
        version: 1,
        providers: [{ id: 'opendesign', models: [{ id: 'm1', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] }],
      }),
    ).toBe(true)
  })

  it('同一 provider 内重复模型 id → 拒', async () => {
    const mod = await loadFresh()
    expect(
      mod.isProviderModelMetadataConfig({
        version: 1,
        providers: [{ id: 'opendesign', models: [{ id: 'm1' }, { id: 'm1' }] }],
      }),
    ).toBe(false)
  })

  it('重复 provider id → 拒', async () => {
    const mod = await loadFresh()
    expect(
      mod.isProviderModelMetadataConfig({
        version: 1,
        providers: [{ id: 'a', models: [] }, { id: 'a', models: [] }],
      }),
    ).toBe(false)
  })

  it('thinkingLevelMap 内层 null 合法（该档不支持语义），整体 null 非法', async () => {
    const mod = await loadFresh()
    expect(
      mod.isProviderModelMetadataConfig({
        version: 1,
        providers: [{ id: 'p', models: [{ id: 'm1', thinkingLevelMap: { off: 'off', medium: null } }] }],
      }),
    ).toBe(true)
    expect(
      mod.isProviderModelMetadataConfig({
        version: 1,
        providers: [{ id: 'p', models: [{ id: 'm1', thinkingLevelMap: null }] }],
      }),
    ).toBe(false)
  })
})

describe('applyProviderModelMetadata（合并语义）', () => {
  const template = [
    { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', maxTokens: 128000, contextWindow: 1048000, reasoning: true },
    { id: 'hy4-preview', name: 'hy4-preview', maxTokens: 32000, contextWindow: 1048000, reasoning: true },
    { id: 'glm-5.3-flash', name: 'glm-5.3-flash', maxTokens: 32000, contextWindow: 1048000, reasoning: true },
  ]

  it('同 id 字段级浅覆盖（未提及的字段保留模板值）', async () => {
    const mod = await loadFresh()
    const out = mod.applyProviderModelMetadata(template, { id: 'opendesign', models: [{ id: 'deepseek-v4-pro', maxTokens: 64000 }] })
    const pro = out.find((m) => m.id === 'deepseek-v4-pro')!
    expect(pro.maxTokens).toBe(64000)
    expect(pro.contextWindow).toBe(1048000) // 模板值保留
    expect(pro.reasoning).toBe(true)
  })

  it('新 id 追加在末尾；模板原有顺序不变', async () => {
    const mod = await loadFresh()
    const out = mod.applyProviderModelMetadata(template, {
      id: 'opendesign',
      models: [{ id: 'new-model', name: 'New', maxTokens: 8000 }],
    })
    expect(out.map((m) => m.id)).toEqual(['deepseek-v4-pro', 'hy4-preview', 'glm-5.3-flash', 'new-model'])
  })

  it('removeModels 从结果剔除（只影响模板条目）', async () => {
    const mod = await loadFresh()
    const out = mod.applyProviderModelMetadata(template, { id: 'opendesign', models: [], removeModels: ['hy4-preview'] })
    expect(out.map((m) => m.id)).not.toContain('hy4-preview')
    expect(out).toHaveLength(2)
  })

  it('cost 整对象替换（不做字段级合并，避免「只改 output 保留旧 input」的意外）', async () => {
    const mod = await loadFresh()
    const tpl = [{ id: 'm1', cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }]
    const out = mod.applyProviderModelMetadata(tpl, {
      id: 'p',
      models: [{ id: 'm1', cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } }],
    })
    expect(out[0].cost).toEqual({ input: 9, output: 9, cacheRead: 9, cacheWrite: 9 })
  })

  it('无 entry（无远程数据）→ 模板原样返回', async () => {
    const mod = await loadFresh()
    expect(mod.applyProviderModelMetadata(template, undefined)).toBe(template)
  })

  it('removeModels 命中新追加的 id 时不追加', async () => {
    const mod = await loadFresh()
    const out = mod.applyProviderModelMetadata(template, {
      id: 'opendesign',
      models: [{ id: 'ghost', maxTokens: 100 }],
      removeModels: ['ghost'],
    })
    expect(out.map((m) => m.id)).not.toContain('ghost')
  })
})

describe('loadProviderModelMetadata（读侧）', () => {
  it('无缓存 → undefined（消费方退化为纯快照）', async () => {
    const mod = await loadFresh()
    expect(mod.loadProviderModelMetadata()).toBeUndefined()
  })

  it('合法缓存 → 返回配置', async () => {
    writeConfig(VALID)
    const mod = await loadFresh()
    expect(mod.loadProviderModelMetadata()).toEqual(VALID)
  })

  it('坏缓存（guard 拒）→ undefined，不部分采纳', async () => {
    writeConfig({ version: 1, providers: [{ id: 'p', models: [{ id: 'm1', bogusKey: 1 }] }] })
    const mod = await loadFresh()
    expect(mod.loadProviderModelMetadata()).toBeUndefined()
  })

  it('getProviderMetadataEntry：命中 / 未命中', async () => {
    const mod = await loadFresh()
    expect(mod.getProviderMetadataEntry(VALID, 'opendesign')?.models).toHaveLength(2)
    expect(mod.getProviderMetadataEntry(VALID, 'nope')).toBeUndefined()
    expect(mod.getProviderMetadataEntry(undefined, 'opendesign')).toBeUndefined()
  })
})
