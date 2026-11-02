/**
 * RpcClient kill 失败语义测试（kill-chain-architecture §4 Step 1 runtime 测试策略）。
 *
 * 锁定：
 * - kill 链失败（EPERM → KillSignalError）时 kill() reject；**pending 立即被 reject**
 *   （kill-failed 终态转移驱动，不等 exit 事件——杀不死的进程永不发 exit，等事件
 *   = 永挂，墙钟超时已随 ADR-0122 退役无兜底）。
 * - kill-failed 后客户端不可用：sendCommand 出站拒绝。
 * - 重复 kill 幂等 no-op（吸收态下 kill-requested 入口短路）。
 * - kill-failed 后迟到 exit 事件：无双重收尾（exitCallbacks 不通知——主动杀令的死亡
 *   落 killed / kill-failed 终态，通知抑制语义由终态词承载；rejectAll 空表 no-op）。
 *
 * 策略：rpc-client-mock 单源 mock（makeKillFail 覆盖 kill 为抛 EPERM——「kill 即死」
 * 缺省 mock 语义的失败面补充）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/rpc-client-kill-failed.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { KillSignalError } from '@zhushanwen/pi-rpc'
import type { RpcClient } from '../infra/pi/rpc-client.js'
import {
  clearExitHandlers,
  emitPiLine,
  emitProcExit,
  lastWrittenJson,
  makeKillFail,
  resetRpcClientMock,
} from '../../test/helpers/rpc-client-mock'

vi.mock('node:child_process', async () =>
  (await import('../../test/helpers/rpc-client-mock')).childProcessModule())

vi.mock('@taiji/shared', async () =>
  (await import('../../test/helpers/rpc-client-mock')).sharedModule())

vi.mock('@taiji/shared/paths', async () =>
  (await import('../../test/helpers/rpc-client-mock')).sharedPathsModule())

vi.mock('node:os', async () =>
  (await import('../../test/helpers/rpc-client-mock')).osModule())

vi.mock('../infra/pi/pi-paths.js', async () =>
  (await import('../../test/helpers/rpc-client-mock')).piPathsModule())

vi.mock('../infra/pi/pi-provider-store.js', async () =>
  (await import('../../test/helpers/rpc-client-mock')).piProviderStoreModule())

vi.mock('../infra/logger.js', async () =>
  (await import('../../test/helpers/rpc-client-mock')).loggerModule())

/** EPERM 错误（Node 原生 kill 抛错形态）。 */
function eperm(): Error {
  return Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
}

/** 发起一个 pending RPC（不回响应）——pending reject 断言的挂钩。返回原始 promise：
 *  调用方不得 await 它（悬挂中），只挂断言。stdin 写是同步的，发出即可断言。 */
function hangOnePending(client: RpcClient): Promise<unknown> {
  const pending: Promise<unknown> = client.bash('echo hi')
  expect(lastWrittenJson().type).toBe('bash')
  return pending
}

describe('RpcClient kill 失败语义（kill-failed 终态）', () => {
  let client: RpcClient

  beforeEach(async () => {
    resetRpcClientMock()
    const { RpcClient } = await import('../infra/pi/rpc-client.js')
    client = new RpcClient({ cwd: '/project' })
    await client.start()
  })

  afterEach(async () => {
    try { await client.kill() } catch { /* noop */ }
    clearExitHandlers()
  })

  it('kill EPERM → kill() reject（KillSignalError 诊断），pending 立即 reject 不悬挂', async () => {
    const pending = hangOnePending(client)
    // 先挂断言再触发（先例 rt2-hardening「proc error 路径 reject pending」：pending 的
    // reject 发生在 kill() 的微任务内，事后挂接会先产生 unhandled rejection）
    pending.catch(() => {}) // 预挂 rejection handler：reject 发生在 kill() 的微任务内，防 unhandled
    const pendingRejected = expect(pending).rejects.toThrow('pi process kill failed')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const restoreKillFail = makeKillFail(eperm())
    try {
      const killP = client.kill()
      await expect(killP).rejects.toMatchObject({ reason: 'permission-denied', errno: 'EPERM' })
      // kill-failed 转移驱动的 pending 收尾：错误文案带失败分型，与正常 kill 的
      // 'pi process killed' 可区分（设计 §3.2 要点 2）
      await expect(pending).rejects.toThrow('reason: permission-denied')
      await pendingRejected
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('kill failed'))).toBe(true)
    } finally {
      errSpy.mockRestore()
      restoreKillFail()
    }
  })

  it('kill-failed 后客户端不可用：sendCommand 出站拒绝', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const restoreKillFail = makeKillFail(eperm())
    try {
      await expect(client.kill()).rejects.toMatchObject({ reason: 'permission-denied' })
      // kill-failed 是终态：进程生死不可控，客户端整体不可用
      await expect(client.bash('echo again')).rejects.toThrow('pi process is not running')
    } finally {
      errSpy.mockRestore()
      restoreKillFail()
    }
  })

  it('kill-failed 后重复 kill → 幂等 no-op（吸收态入口短路，不重复 reject）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const restoreKillFail = makeKillFail(eperm())
    try {
      await expect(client.kill()).rejects.toMatchObject({ reason: 'permission-denied' })
      // 第二次 kill：吸收态幂等成功返回（destroySession 与并发清理双调场景）
      await expect(client.kill()).resolves.toBeUndefined()
    } finally {
      errSpy.mockRestore()
      restoreKillFail()
    }
  })

  it('kill-failed 后迟到 exit：exitCallbacks 不通知（killed / kill-failed 终态抑制）+ 无双重收尾', async () => {
    const exits: Array<[number | null, string]> = []
    client.onExit((code, stderr) => { exits.push([code, stderr]) })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const restoreKillFail = makeKillFail(eperm())
    try {
      await expect(client.kill()).rejects.toMatchObject({ reason: 'permission-denied' })
      // 进程最终死亡（权限环境变化等）：exit 事件迟到到达
      emitProcExit(0)
      expect(exits).toEqual([]) // 主动杀令已下：死亡通知抑制（与 kill 成功路径同语义）
    } finally {
      errSpy.mockRestore()
      restoreKillFail()
    }
  })

  it('正常 kill 路径回归锁：成功后 exit 到达走 onExit 收尾（pending reject 文案可区分）', async () => {
    const pending = hangOnePending(client)
    // 先挂断言再触发（unhandled rejection 防护，同上）
    pending.catch(() => {}) // 预挂 rejection handler：reject 发生在 kill() 的微任务内，防 unhandled
    const pendingRejected = expect(pending).rejects.toThrow('pi process killed')
    await client.kill() // 缺省 mock「kill 即死」：微任务内 emit exit
    await pendingRejected
  })

  it('kill 成功路径：exit 收割落 killed 终态，exitCallbacks 不通知（与 kill-failed 同抑制语义）', async () => {
    const exits: Array<[number | null, string]> = []
    client.onExit((code, stderr) => { exits.push([code, stderr]) })
    await client.kill() // 缺省 mock「kill 即死」：微任务内 emit exit，killing → killed
    // 主动杀令收割的死亡不产生死亡通知（pending 收尾归 kill() 的 onExit rejectAll
    // 安全网——通知抑制判据由终态词承载：exited 只从 spawned 到达）
    expect(exits).toEqual([])
    expect(client.exited).toBe(true) // killed 是终态：客户端不可用
  })

  it('已自然退出后再 kill → 幂等 no-op（spawned→exited 的入口短路）', async () => {
    emitProcExit(1)
    expect(client.exited).toBe(true)
    await expect(client.kill()).resolves.toBeUndefined()
  })
})

describe('ProcessManager.destroySession kill 失败收编（PROCESS-LEAK-RISK 活路径）', () => {
  it('kill() reject（KillSignalError）→ catch 触发 LEAK-RISK warn，会话表清理完成，destroySession 正常返回', async () => {
    const { ProcessManager } = await import('../infra/pi/process-manager.js')
    const pm = new ProcessManager(tmpdir())
    const killErr = new KillSignalError(4321, 'permission-denied', 'EPERM', undefined)
    const fakeClient = {
      kill: vi.fn(async () => {
        throw killErr
      }),
    } as unknown as RpcClient
    // 反射注入 processes/clientToId（private 字段经 unknown 中转，runtime/test 惯例——
    // 先例 rpc-client-mock earlyFrameBufferOf）
    const internals = pm as unknown as {
      processes: Map<string, { client: RpcClient; cwd: string; createdAt: number }>
      clientToId: Map<RpcClient, string>
    }
    internals.processes.set('s-kill-failed', { client: fakeClient, cwd: '/p', createdAt: Date.now() })
    internals.clientToId.set(fakeClient, 's-kill-failed')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // kill 失败不炸 destroySession：会话清理照常完成，失败经 warn 上报（活路径——
      // 修复前 kill 恒 resolve，该 catch 是死代码）
      await expect(pm.destroySession('s-kill-failed')).resolves.toBeUndefined()
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('PROCESS-LEAK-RISK'))).toBe(true)
      expect(internals.processes.size).toBe(0)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
