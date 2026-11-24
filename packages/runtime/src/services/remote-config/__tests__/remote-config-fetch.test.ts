/**
 * remote-config-fetch 单测（通用拉取器：节流 / ETag / guard 拒绝回退 / fail-safe 链）。
 *
 * 策略对齐 provider-catalog-refresh.test.ts：TAIJI_AGENT_DATA_DIR stub 到临时目录 +
 * fetch 全局 mock + vi.resetModules 动态 import 隔离模块级 cacheSnapshots。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rcf-test-'))
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function loadFresh() {
  vi.resetModules()
  return await import('../remote-config-fetch.js')
}

const VALID = { version: 1 as const, providers: [{ id: 'taiji-demo', name: 'Demo', models: [{ id: 'm1' }] }] }

function guard(v: unknown): v is typeof VALID {
  return (
    typeof v === 'object' && v !== null && (v as { version?: unknown }).version === 1 &&
    Array.isArray((v as { providers?: unknown }).providers)
  )
}

function mockFetch(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: null,
    headers: { get: (k: string): string | null => headers[k.toLowerCase()] ?? null },
  }))
  vi.stubGlobal('fetch', fn)
  return fn as unknown as ReturnType<typeof vi.fn>
}

/**
 * 按 URL 分派的双源 mock（双源改造后的默认形态）。
 *
 * 生产链路并发探测全部候选源，故用例必须能表达「github 失败 / gitcode 成功」这类
 * 分源差异——单一 mock 会让两源拿到同一响应，验不出 fail-forward。
 */
function mockFetchBySource(handlers: Record<string, () => { status: number; body?: unknown; headers?: Record<string, string> }>) {
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input)
    const matched = Object.entries(handlers).find(([host]) => url.includes(host))
    const h = matched?.[1]?.() ?? { status: 0 }
    return {
      ok: h.status >= 200 && h.status < 300,
      status: h.status,
      json: async () => {
        if (h.body === NOT_JSON) throw new Error('bad json')
        return h.body
      },
      body: null,
      headers: { get: (k: string): string | null => (h.headers?.[k.toLowerCase()] ?? null) },
    }
  })
  vi.stubGlobal('fetch', fn)
  return fn as unknown as ReturnType<typeof vi.fn>
}

/** 非 JSON 响应哨兵（模拟 GitCode raw 边缘缓存返回 HTML/占位文案）。 */
const NOT_JSON = Symbol('not-json')

function cachePath(): string {
  return join(dataDir, 'remote-config', 'builtin-providers.json')
}

function writeCache(data: unknown, etag?: string): void {
  mkdirSync(join(dataDir, 'remote-config'), { recursive: true })
  writeFileSync(cachePath(), JSON.stringify({ version: 1, checkedAt: Date.now(), etag, data }))
}

// 首载成本预热：本文件的模块图（remote-config-fetch + shared paths + logger）首次 import 的
// transform 开销会全部记在第一个用例头上（慢用例门禁按 testcase time 判定，阈值 2s）。
// beforeAll 里先加载一次，让那笔成本落在钩子里而不是用例里——不是放宽判据，是把
// 「包级首载」从用例耗时中剥离（同包 history-bundle 等其他文件同因）。
// hook 超时显式放宽：装载成本（模块图首次 transform），不是断言盲等。
beforeAll(async () => {
  await loadFresh()
}, 60_000)

describe('refreshRemoteConfig', () => {
  it('无缓存 + 200 + guard 通过 → 返回数据 + 落盘', async () => {
    const mod = await loadFresh()
    mockFetch(200, VALID, { etag: '"abc"' })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard)
    expect(out.data).toEqual(VALID)
    expect(out.refreshed).toBe(true)
    expect(existsSync(cachePath())).toBe(true)
  })

  it('无缓存 + 网络失败 → data undefined + reason network', async () => {
    const mod = await loadFresh()
    mockFetch(0).mockRejectedValue(new Error('offline'))
    const out = await mod.refreshRemoteConfig('builtin-providers', guard)
    expect(out.data).toBeUndefined()
    expect(out.refreshed).toBe(false)
    expect(out.reason).toBe('network')
  })

  it('节流窗内 → 零网络请求，data 来自缓存', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    const fn = mockFetch(200, VALID)
    const out = await mod.refreshRemoteConfig('builtin-providers', guard)
    expect(fn).not.toHaveBeenCalled()
    expect(out.data).toEqual(VALID)
    expect(out.reason).toBe('throttled')
  })

  it('304 → data 来自缓存，checkedAt 顺延', async () => {
    writeCache(VALID, '"abc"')
    const mod = await loadFresh()
    // force 绕过节流窗，命中 304 分支
    mockFetch(304)
    const out = await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out.data).toEqual(VALID)
    expect(out.refreshed).toBe(false)
    const persisted = JSON.parse(readFileSync(cachePath(), 'utf-8'))
    expect(persisted.etag).toBe('"abc"')
  })

  it('304 分支 checkedAt 顺延写盘失败 → warn 留痕（与 200 路径同构）且不阻断返回', async () => {
    writeCache(VALID, '"abc"')
    const mod = await loadFresh()
    // loadFresh 已 resetModules，此处拿到的 logger 与被测模块同一实例
    const { logger } = await import('../../../infra/logger.js')
    // tmp 路径换成同名目录：persistCache 的 writeFile(tmp) 抛 EISDIR，命中写盘失败分支
    mkdirSync(`${cachePath()}.tmp`, { recursive: true })
    mockFetch(304)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const out = await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
      expect(out.data).toEqual(VALID)
      expect(out.refreshed).toBe(false)
      expect(out.reason).toBe('throttled')
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toBe('[remote-config] persist cache failed')
      const meta = warnSpy.mock.calls[0]?.[1] as { domain?: unknown; error?: unknown } | undefined
      expect(meta?.domain).toBe('builtin-providers')
      expect(String(meta?.error)).toContain('EISDIR')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('200 内容变化 → refreshed=true + 新数据落盘；内容不变 → refreshed=false', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    const changed = { ...VALID, providers: [...VALID.providers, { id: 'taiji-x', name: 'X', models: [] }] }
    mockFetch(200, changed)
    const out = await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out.refreshed).toBe(true)
    expect(out.data).toEqual(changed)

    const mod2 = await loadFresh()
    mockFetch(200, changed)
    const out2 = await mod2.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out2.refreshed).toBe(false)
  })

  it('guard 拒绝 → 整体拒用回退缓存，坏数据不落盘', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    mockFetch(200, { version: 1, providers: 'not-an-array' })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out.data).toEqual(VALID)
    expect(out.reason).toBe('invalid')
    expect(JSON.parse(readFileSync(cachePath(), 'utf-8')).data).toEqual(VALID)
  })

  it('非 JSON 响应 → reason invalid 回退缓存', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    mockFetch(200, undefined).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new Error('bad json') },
      body: null,
      headers: { get: () => null },
    })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out.reason).toBe('invalid')
    expect(out.data).toEqual(VALID)
  })
})

describe('双源拉取（GitHub 主源 + GitCode 备源）', () => {
  it('主源成功 → 取主源数据并记录 source；备源结果不参与选优', async () => {
    const mod = await loadFresh()
    const OUT_OF_SYNC = { version: 1, providers: [{ id: 'from-gitcode', name: 'G', models: [{ id: 'm1' }] }] }
    mockFetchBySource({
      'raw.githubusercontent.com': () => ({ status: 200, body: VALID, headers: { etag: '"gh"' } }),
      'raw.gitcode.com': () => ({ status: 200, body: OUT_OF_SYNC, headers: { etag: '"gc"' } }),
    })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard)
    expect(out.data).toEqual(VALID)
    expect(out.source).toBe('github')
    expect(out.refreshed).toBe(true)
  })

  it('主源网络失败 → fail-forward 到备源（GitCode）', async () => {
    const mod = await loadFresh()
    mockFetchBySource({
      'raw.githubusercontent.com': () => ({ status: 0 }),
      'raw.gitcode.com': () => ({ status: 200, body: VALID, headers: { etag: '"gc"' } }),
    })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard)
    expect(out.data).toEqual(VALID)
    expect(out.source).toBe('gitcode')
    expect(out.sourceFailures).toEqual([{ source: 'github', reason: 'network' }])
  })

  it('主源 200 但 body 非 JSON（GitCode 式占位响应）→ 视为该源失败并切换备源', async () => {
    const mod = await loadFresh()
    mockFetchBySource({
      'raw.githubusercontent.com': () => ({ status: 200, body: NOT_JSON }),
      'raw.gitcode.com': () => ({ status: 200, body: VALID }),
    })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard)
    expect(out.data).toEqual(VALID)
    expect(out.source).toBe('gitcode')
  })

  it('主源 guard 拒绝 → 也走换源（坏配置只拒该源该份数据，不阻断备源好数据）', async () => {
    const mod = await loadFresh()
    mockFetchBySource({
      'raw.githubusercontent.com': () => ({ status: 200, body: { version: 99 } }),
      'raw.gitcode.com': () => ({ status: 200, body: VALID }),
    })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard)
    expect(out.data).toEqual(VALID)
    expect(out.source).toBe('gitcode')
  })

  it('两源全失败 → 回退缓存；reason 优先报 invalid（配置源本身有问题）', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    mockFetchBySource({
      'raw.githubusercontent.com': () => ({ status: 200, body: NOT_JSON }),
      'raw.gitcode.com': () => ({ status: 500 }),
    })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out.data).toEqual(VALID)
    expect(out.reason).toBe('invalid')
    expect(out.sourceFailures).toHaveLength(2)
  })

  it('ETag 按源分存：两源同一轮各自拿到自己的 etag，下一轮各自送 if-none-match', async () => {
    const mod = await loadFresh()
    const seen: Array<Record<string, string | null>> = []
    const fn = vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers ?? {})
      return {
        ok: true,
        status: 200,
        json: async () => VALID,
        body: null,
        headers: { get: (k: string) => (k.toLowerCase() === 'etag' ? '"etag-of-' + String(input).slice(8, 20) + '"' : null) },
      }
    })
    vi.stubGlobal('fetch', fn)
    await mod.refreshRemoteConfig('builtin-providers', guard)
    const envelope = JSON.parse(readFileSync(cachePath(), 'utf-8')) as { etags?: Record<string, string>; source?: string }
    expect(envelope.source).toBe('github')
    expect(envelope.etags?.github).toBeDefined()
    expect(envelope.etags?.gitcode).toBeDefined()
    // 两个源的 etag 不同（按源分存才有意义）
    expect(envelope.etags!.github).not.toBe(envelope.etags!.gitcode)
    // 首轮两源都无条件 GET（无 etag 可送）
    expect(seen.every((h) => h['if-none-match'] === undefined)).toBe(true)

    // 第二轮（force 跨过节流）：各自送自己的 etag
    seen.length = 0
    await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    const sent = seen.map((h) => h['if-none-match']).filter(Boolean)
    expect(sent).toHaveLength(2)
    expect(new Set(sent).size).toBe(2)
  })

  it('304 只对发出去的那个源的 etag 生效（命中即顺延 checkedAt，数据取缓存）', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    mockFetchBySource({
      'raw.githubusercontent.com': () => ({ status: 304 }),
      'raw.gitcode.com': () => ({ status: 304 }),
    })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out.data).toEqual(VALID)
    expect(out.source).toBe('github')
    expect(out.refreshed).toBe(false)
  })

  it('version 1 旧 envelope（单 etag）不迁移写盘，首轮无条件 GET', async () => {
    // writeCache 产出的就是 version 1 + 单 etag 形态
    writeCache(VALID, '"legacy-etag"')
    const mod = await loadFresh()
    const seen: Array<Record<string, string>> = []
    const fn = vi.fn(async (_i: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers ?? {})
      return { ok: true, status: 200, json: async () => VALID, body: null, headers: { get: () => null } }
    })
    vi.stubGlobal('fetch', fn)
    await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(seen.every((h) => h['if-none-match'] === undefined)).toBe(true)
  })
})

describe('loadRemoteConfig 读侧', () => {
  it('缓存损坏 JSON → undefined 不抛错', async () => {
    mkdirSync(join(dataDir, 'remote-config'), { recursive: true })
    writeFileSync(cachePath(), '[[[')
    const mod = await loadFresh()
    expect(mod.loadRemoteConfig('builtin-providers', guard)).toBeUndefined()
  })

  it('缓存合法 → 返回数据', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    expect(mod.loadRemoteConfig('builtin-providers', guard)).toEqual(VALID)
  })
})
