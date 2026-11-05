/**
 * provider-live-sync 单元测试 —— session_start 加载时同步。
 *
 * 被测对象 = 扩展入口的 session_start handler（真实文件系统 fixture + fake
 * modelRegistry）。getAgentDir mock 指向真实 tmp fixture。
 *
 * 覆盖：
 * - models.json 在场 → refresh({ allowNetwork: false }) 恰一次（加载时同步主路径）
 * - models.json 缺失（ENOENT）→ 跳过刷新（防空配置重建可用集合的护栏；
 *   catalog-only 安装常态无损失——spawn 快照本就无自定义 provider）
 * - models.json 非 ENOENT 读错误（EISDIR）→ 按存在处理，刷新照常（刷新无害）
 * - 引擎拒绝配置 → logger.error 落 pi.appendEntry（坏配置的唯一机器证据）
 * - 同步链异常不冒泡（session_start handler 不阻断会话启动）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import providerLiveSync from '../index.ts'
import { startWithRegistryCtx } from './session-sync-harness.ts'

// mock pi 宿主模块的 getAgentDir 指向真实 tmp fixture。
const piMocks = vi.hoisted(() => ({ agentDir: '' }))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => piMocks.agentDir,
}))

describe('session_start 加载时同步', () => {
  let agentDir: string

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'provider-live-sync-sync-'))
    piMocks.agentDir = agentDir
  })

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 经 harness 启动扩展（pi 宿主面 = appendEntry spy）。 */
  async function start(): Promise<{ refresh: ReturnType<typeof vi.fn>; appendEntry: ReturnType<typeof vi.fn> }> {
    const appendEntry = vi.fn()
    const { refresh } = await startWithRegistryCtx({ appendEntry })
    return { refresh, appendEntry }
  }

  it('models.json 在场 → refresh({ allowNetwork: false }) 恰一次（加载时同步主路径）', async () => {
    writeFileSync(join(agentDir, 'models.json'), '{"providers":{}}')
    writeFileSync(join(agentDir, 'auth.json'), '{"a":"x"}')

    const { refresh } = await start()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false })
  })

  it('models.json 缺失（ENOENT）→ 跳过刷新（防空配置重建护栏；auth.json 在场也不刷）', async () => {
    writeFileSync(join(agentDir, 'auth.json'), '{"a":"x"}')

    const { refresh } = await start()

    expect(refresh).not.toHaveBeenCalled()
  })

  it('models.json 读出非 ENOENT 错误（EISDIR 目录位）→ 按存在处理，刷新照常', async () => {
    mkdirSync(join(agentDir, 'models.json'))

    const { refresh } = await start()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false })
  })

  /**
   * 日志通道回归：error 级日志必须落 pi.appendEntry（session JSONL custom entry，
   * 持久化、不依赖 pi 不捕获的 extension stderr）。驱动 `getError()` 非空分支——
   * 引擎拒绝配置是「坏配置的唯一机器证据」，其可见性不能寄望 stderr。
   */
  it('引擎拒绝配置 → logger.error 落 pi.appendEntry（provider-live-sync:log）', async () => {
    writeFileSync(join(agentDir, 'models.json'), '{"providers":{}}')
    const appendEntry = vi.fn()
    const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }))
    const getError = vi.fn(() => 'Invalid models.json schema: - providers')
    const on = vi.fn()
    providerLiveSync({ on, appendEntry } as unknown as ExtensionAPI)
    const handler = on.mock.calls.find((call) => call[0] === 'session_start')?.[1] as
      | ((event: unknown, sessionCtx: unknown) => Promise<void> | void)
      | undefined
    await handler?.({ type: 'session_start' }, { modelRegistry: { refresh, getError } })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(appendEntry).toHaveBeenCalledWith('provider-live-sync:log', expect.objectContaining({
      level: 'error',
      message: expect.stringContaining('[provider-live-sync] model config rejected by the engine'),
    }))
  })

  it('同步链异常（modelRegistry.refresh 抛错）→ 不冒泡，session_start 正常返回', async () => {
    writeFileSync(join(agentDir, 'models.json'), '{"providers":{}}')
    const appendEntry = vi.fn()
    const refresh = vi.fn(async () => {
      throw new Error('registry disposed')
    })
    const on = vi.fn()
    providerLiveSync({ on, appendEntry } as unknown as ExtensionAPI)
    const handler = on.mock.calls.find((call) => call[0] === 'session_start')?.[1] as
      | ((event: unknown, sessionCtx: unknown) => Promise<void> | void)
      | undefined

    await expect(handler?.({ type: 'session_start' }, { modelRegistry: { refresh, getError: () => null } })).resolves.toBeUndefined()
    expect(appendEntry).toHaveBeenCalledWith('provider-live-sync:log', expect.objectContaining({
      level: 'error',
      message: expect.stringContaining('session-start sync failed'),
    }))
  })
})
