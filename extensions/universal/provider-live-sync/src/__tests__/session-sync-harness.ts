/**
 * provider-live-sync 测试的 session_start 驱动共用件（catalog-bridge 与 model-sync 的
 * 同款夹具）。
 *
 * 启动扩展并注入 fake modelRegistry 会话 ctx（session_start 同步用例的共同骨架）：
 * 捕获 session_start handler、以 `{ refresh, getError }` spy 的 ctx 调用它（handler
 * 为 async——harness await 其完成，断言在同步链落定后进行）。`piStub` = 各测试文件
 * 特有的 pi 宿主面（appendEntry / registerProvider 等 spy）。
 */
import { expect, vi } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import providerLiveSync from '../index.ts'

export type SessionStartHarness = {
  refresh: ReturnType<typeof vi.fn>
  getError: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

/** 启动扩展并触发一次 session_start（await 同步链完整落地）。 */
export async function startWithRegistryCtx<T extends Record<string, unknown>>(
  piStub: T,
): Promise<SessionStartHarness> {
  const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }))
  const getError = vi.fn(() => null)
  const ctx = { modelRegistry: { refresh, getError } }
  const on = vi.fn()
  providerLiveSync({ ...piStub, on } as unknown as ExtensionAPI)
  const handler = on.mock.calls.find((call) => call[0] === 'session_start')?.[1] as
    | ((event: unknown, sessionCtx: unknown) => Promise<void> | void)
    | undefined
  expect(handler).toBeTypeOf('function')
  await handler?.({ type: 'session_start' }, ctx)
  return { refresh, getError, on }
}
