/**
 * ProcessManager.getPiVersion 缓存语义测试。
 *
 * 语义：成功值永久缓存；失败不缓存——每次调用重新探测（pi 修好/装好后版本即时反映，
 * 无时间窗负缓存）。
 *
 * Mock 策略：mock find-pi-executable（固定路径，免真实扫盘）+ 合并式 mock
 * node:child_process（importActual 保留 spawn 等其余导出，只覆盖 execSync——依赖图内
 * 其它模块 import spawn，工厂整体替换会破坏模块图）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/process-manager-pi-version.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'

const execSyncMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: execSyncMock }
})
vi.mock('../infra/pi/find-pi-executable.js', () => ({ findPiExecutable: vi.fn(() => '/fake-tools/pi') }))

import { ProcessManager } from '../infra/pi/process-manager.js'

describe('ProcessManager.getPiVersion 缓存语义', () => {
  let pm: ProcessManager

  beforeEach(() => {
    // 隔离：打包态 env 泄入测试进程会改道 findPackagedPi（同 process-manager-ephemeral R3）
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '')
    execSyncMock.mockReset()
    pm = new ProcessManager(tmpdir())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('失败不缓存：每次调用都重新探测；探测成功后新值生效且永久缓存', async () => {
    // 首次探测失败 → 'unknown'
    execSyncMock.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    await expect(pm.getPiVersion()).resolves.toBe('unknown')
    expect(execSyncMock).toHaveBeenCalledTimes(1)

    // 失败不缓存：再次调用重新探测
    await expect(pm.getPiVersion()).resolves.toBe('unknown')
    expect(execSyncMock).toHaveBeenCalledTimes(2)

    // 探测成功后新值生效
    execSyncMock.mockReturnValue('1.2.3\n')
    await expect(pm.getPiVersion()).resolves.toBe('1.2.3')
    expect(execSyncMock).toHaveBeenCalledTimes(3)

    // 成功值永久缓存：再调用不重探
    await expect(pm.getPiVersion()).resolves.toBe('1.2.3')
    expect(execSyncMock).toHaveBeenCalledTimes(3)
  })
})
