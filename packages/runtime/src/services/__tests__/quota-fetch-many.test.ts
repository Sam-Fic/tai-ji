/**
 * QuotaService.fetchMany 单测（provider-aggregation D3/U4 批量按需刷新入口）。
 *
 * 守护：allSettled 聚合语义（单 provider 失败不丢整批）+ 意外逃逸分支（fetch 实现路径
 * 不 throw，rejected 分支是防御未来回归的兜底——按 network 失败态落盘不中断）。
 * 装配同 provider-write-fields.test.ts 的 makeQuotaService 先例：临时 dataDir + 桩
 * resolver，无 quota 配置的 provider 走 doFetch「无 fetcher 早退」（零网络）。
 */
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js';
import { QuotaService } from '../quota-service.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string

/** 恒注入形态的 resolver 替身（形态同 provider-write-fields.test.ts stubResolver）。 */
const stubResolver: IProviderCredentialResolver = {
  hasProviderCredential: () => false,
  listCredentialBackedProviderIds: () => new Set<string>(),
  resolveProviderCredential: async () => undefined,
  resolveProviderApiKeyRaw: async () => undefined,
  resolveProviderBaseUrl: () => undefined,
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quota-fetch-many-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function makeQuotaService(): QuotaService {
  mkdirSync(join(dir, 'config'), { recursive: true })
  return new QuotaService({ dataDir: dir, providerExists: () => true, providerCredentialResolver: stubResolver })
}

describe('QuotaService.fetchMany', () => {
  it('批量查询：无 quota 配置的 provider 全部按失败态 resolve（fulfilled 分支，不抛错）', async () => {
    const svc = makeQuotaService()
    const results = await svc.fetchMany(['p-a', 'p-b'])
    expect(results.size).toBe(2)
    expect(results.get('p-a')?.data).toBeNull()
    expect(results.get('p-b')?.data).toBeNull()
  })

  it('节流内去重：同 id 连续两批只落一次取数（fetch 非 force 维度走同一 throttle 窗）', async () => {
    const svc = makeQuotaService()
    await svc.fetchMany(['p-throttle'])
    const first = await svc.fetchMany(['p-throttle'])
    expect(first.get('p-throttle')?.data).toBeNull()
  })

  it('意外逃逸分支：fetch reject 时按 network 失败态落盘，同批其余不受影响', async () => {
    const svc = makeQuotaService()
    const fetchSpy = vi.spyOn(svc, 'fetch')
    // 首个 id 意外逃逸（防御分支），其余正常
    fetchSpy.mockImplementationOnce(async () => {
      throw new Error('unexpected escape')
    })
    const results = await svc.fetchMany(['p-escape', 'p-normal'])
    expect(results.get('p-normal')?.data).toBeNull()
    expect(results.get('p-escape')).toEqual({ data: null, lastFetchAt: null, reason: 'network' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('空集输入：不发起任何 fetch，返回空 Map', async () => {
    const svc = makeQuotaService()
    const fetchSpy = vi.spyOn(svc, 'fetch')
    const results = await svc.fetchMany([])
    expect(results.size).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
