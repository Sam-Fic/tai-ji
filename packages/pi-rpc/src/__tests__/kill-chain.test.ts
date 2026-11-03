// src/__tests__/kill-chain.test.ts
//
// 杀链测试：SIGKILL 直杀 + 三值完成判别（signal-delivered / already-dead /
// kill-failed→reject(KillSignalError)）。fake child 记录信号序列（KillableChild
// 结构子集注入）；三态探针经 vi.spyOn(process, 'kill') 注入桩（probePidAlive 私有
// 实现的唯一外部依赖面）。
//
// 行为门禁（kill-chain-architecture §4 Step 3）：「kill() 返回 false 或抛非 ESRCH
// 错误时不得 resolve 成功」是独立测试组（发信号失败不得按成功完成）；已退前置短路
// 的 K2 幂等分支独立成组。

import { describe, expect, it, vi } from 'vitest'

import { killPiProcess, KillSignalError } from '../kill-chain.ts'
import type { KillableChild } from '../kill-chain.ts'

interface FakeChild extends KillableChild {
  signals: string[]
  /** 模拟进程退出：触发已注册的 exit listener。 */
  emitExit(): void
}

function makeFakeChild(overrides?: { exitCode?: number | null; signalCode?: string | null }): FakeChild {
  const signals: string[] = []
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  const child: FakeChild = {
    pid: 4321,
    signals,
    ...(overrides?.exitCode !== undefined ? { exitCode: overrides.exitCode } : {}),
    ...(overrides?.signalCode !== undefined ? { signalCode: overrides.signalCode } : {}),
    kill(signal?: NodeJS.Signals | number) {
      signals.push(String(signal))
      return true
    },
    on(_event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
      exitListener = listener
      return child
    },
    emitExit() {
      exitListener?.(0, null)
      exitListener = undefined
    },
  }
  return child
}

/** 带 errno code 的错误（Node 原生 kill 抛错形态）。 */
function errnoError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** 探针桩：mock process.kill(pid, 0) 的三态行为（probePidAlive 的外部依赖面）。 */
function stubProbe(impl: (pid: number, signal: undefined | NodeJS.Signals | number) => void): () => void {
  const spy = vi.spyOn(process, 'kill').mockImplementation(((
    pid: number,
    signal?: undefined | NodeJS.Signals | number,
  ) => {
    impl(pid, signal)
  }) as typeof process.kill)
  return () => spy.mockRestore()
}

describe('killPiProcess：SIGKILL 直杀（正常路径）', () => {
  it('kill() 返回 true → resolve(signal-delivered)，发信号后立即 resolve（不等收尸）', async () => {
    const child = makeFakeChild()
    await expect(killPiProcess(child)).resolves.toEqual({ status: 'signal-delivered' })
    expect(child.signals).toEqual(['SIGKILL'])
  })

  it('exit 到达：onExit 收尾钩子被调（resolve 已先行）', async () => {
    const child = makeFakeChild()
    const onExit = vi.fn()
    await killPiProcess(child, { onExit })
    expect(onExit).not.toHaveBeenCalled()
    child.emitExit()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('无 exitCode/signalCode 字段的 fake（undefined）→ 视为存活，正常发信号', async () => {
    const child = makeFakeChild()
    await expect(killPiProcess(child)).resolves.toEqual({ status: 'signal-delivered' })
    expect(child.signals).toEqual(['SIGKILL'])
  })
})

describe('killPiProcess：发信号失败不得 resolve 成功（行为门禁）', () => {
  // 「kill() false 或抛非 ESRCH 错误时不得 resolve 成功」——EPERM 折叠成 resolve
  // 是本设计修正的架构缺陷（下游据假事实运行：pending 永挂 / run 永无终态）。
  it('kill 抛 EPERM → reject KillSignalError(permission-denied)（不再照常 resolve）', async () => {
    const child = makeFakeChild()
    child.kill = (signal?: NodeJS.Signals | number) => {
      child.signals.push(String(signal))
      throw errnoError('EPERM', 'kill EPERM')
    }
    const p = killPiProcess(child)
    await expect(p).rejects.toBeInstanceOf(KillSignalError)
    await expect(p).rejects.toMatchObject({ pid: 4321, reason: 'permission-denied', errno: 'EPERM' })
    expect(child.signals).toEqual(['SIGKILL'])
  })

  it('kill 返回 false + 探针存活（true）→ reject KillSignalError(undetermined)', async () => {
    const restore = stubProbe(() => {}) // process.kill(pid, 0) 不抛 = 探针 true
    try {
      const child = makeFakeChild()
      child.kill = (signal?: NodeJS.Signals | number) => {
        child.signals.push(String(signal))
        return false
      }
      const p = killPiProcess(child)
      await expect(p).rejects.toMatchObject({ reason: 'undetermined', errno: undefined })
      await expect(p).rejects.toBeInstanceOf(KillSignalError)
    } finally {
      restore()
    }
  })

  it('kill 返回 false + 探针不可判定（EPERM）→ reject KillSignalError(undetermined)（保守按存活）', async () => {
    const restore = stubProbe((_pid, signal) => {
      if (signal === 0) throw errnoError('EPERM', 'probe EPERM')
    })
    try {
      const child = makeFakeChild()
      child.kill = (signal?: NodeJS.Signals | number) => {
        child.signals.push(String(signal))
        return false
      }
      await expect(killPiProcess(child)).rejects.toMatchObject({ reason: 'undetermined' })
    } finally {
      restore()
    }
  })

  it('kill 抛无 code 错误 + 探针存活 → reject KillSignalError(undetermined)', async () => {
    const restore = stubProbe(() => {})
    try {
      const child = makeFakeChild()
      child.kill = (signal?: NodeJS.Signals | number) => {
        child.signals.push(String(signal))
        throw new Error('kill unknown failure')
      }
      await expect(killPiProcess(child)).rejects.toMatchObject({
        reason: 'undetermined',
        errno: undefined,
      })
    } finally {
      restore()
    }
  })
})

describe('killPiProcess：失败形态中的等价成功（ESRCH / 复核确证已死）', () => {
  // ESRCH = 目标已达成（幂等成功，K2 同精神）：迟到 kill / 收割时已自退的进程落此类
  it('kill 抛 ESRCH → resolve(already-dead)', async () => {
    const child = makeFakeChild()
    child.kill = (signal?: NodeJS.Signals | number) => {
      child.signals.push(String(signal))
      throw errnoError('ESRCH', 'kill ESRCH')
    }
    await expect(killPiProcess(child)).resolves.toEqual({ status: 'already-dead' })
    expect(child.signals).toEqual(['SIGKILL'])
  })

  it('kill 返回 false + 探针复核 ESRCH → resolve(already-dead)', async () => {
    const restore = stubProbe((_pid, signal) => {
      if (signal === 0) throw errnoError('ESRCH', 'probe ESRCH')
    })
    try {
      const child = makeFakeChild()
      child.kill = (signal?: NodeJS.Signals | number) => {
        child.signals.push(String(signal))
        return false
      }
      await expect(killPiProcess(child)).resolves.toEqual({ status: 'already-dead' })
    } finally {
      restore()
    }
  })

  it('kill 抛无 code 错误 + 探针复核 ESRCH → resolve(already-dead)', async () => {
    const restore = stubProbe((_pid, signal) => {
      if (signal === 0) throw errnoError('ESRCH', 'probe ESRCH')
    })
    try {
      const child = makeFakeChild()
      child.kill = (signal?: NodeJS.Signals | number) => {
        child.signals.push(String(signal))
        throw new Error('kill transient error')
      }
      await expect(killPiProcess(child)).resolves.toEqual({ status: 'already-dead' })
    } finally {
      restore()
    }
  })
})

describe('killPiProcess：编程错误冒出（不进运行时失败分型）', () => {
  it('kill 抛 EINVAL → 原样冒出（非 KillSignalError）', async () => {
    const child = makeFakeChild()
    const EINVAL_ERR = errnoError('EINVAL', 'invalid signal')
    child.kill = (signal?: NodeJS.Signals | number) => {
      child.signals.push(String(signal))
      throw EINVAL_ERR
    }
    await expect(killPiProcess(child)).rejects.toBe(EINVAL_ERR)
  })
})

describe('killPiProcess：已退前置短路（K2 幂等，独立分组）', () => {
  it('已退进程（exitCode 非 null）→ 前置短路零信号，resolve(already-dead)（不抛、可重复）', async () => {
    const child = makeFakeChild({ exitCode: 0 })
    await expect(killPiProcess(child)).resolves.toEqual({ status: 'already-dead' })
    await expect(killPiProcess(child)).resolves.toEqual({ status: 'already-dead' }) // 可重复
    expect(child.signals).toEqual([])
  })

  it('被信号杀死（signalCode 非 null）→ 前置短路零信号', async () => {
    const child = makeFakeChild({ signalCode: 'SIGKILL' })
    await expect(killPiProcess(child)).resolves.toEqual({ status: 'already-dead' })
    expect(child.signals).toEqual([])
  })
})
