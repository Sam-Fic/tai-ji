/**
 * occupancy 转移边沿 → runtime-checkpoint 占用快照刷新（fix-chat-flow-stuck A-6）。
 *
 * 锁定：
 * - 归并快照翻转（idle↔occupied）时 occupancy + activityAt 刷进 checkpoint 已存在条目
 *   （attach 挂点只在注册时刻写——注册时刻占用恒 idle，「占用中崩溃」此前磁盘恒 idle，
 *   reattach 的 occupied 豁免判据永不命中）；
 * - turn 内相位推进（归并值不变）不刷新（事件边沿过滤，每回合最多 2 次落盘）；
 * - 布尔维（compacting/bash）参与三维投影翻转，handingOff 不参与（快照三维口径）；
 * - 未附着 session 不新增条目（refreshSessions 契约）；
 * - 刷新异常不外抛（best-effort 旁路隔离，occupancy 写回主链不受影响）；
 * - 端到端：占用中「崩溃」的磁盘快照经 runStartupReattach 自动恢复命中（安静长 turn，
 *   idle 超 2h 窗口仍恢复）。
 *
 * 单例注入：event-interpreter 经 getRuntimeCheckpointStore() 取模块级单例，本文件以
 * initRuntimeCheckpointStore 指定 tmp dir + 受控时钟（单例幂等，本文件是进程内首个 init）。
 * 跨用例隔离：store.reset() 清内存清单 + rmSync 删磁盘主文件（reset 不动磁盘，见其契约）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/occupancy-checkpoint-edge.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrashJournalEvent, CrashJournalWriter } from '@taiji/shared'
import { RUN_CHECKPOINT_FILENAME as CHECKPOINT_FILENAME } from '@taiji/shared/paths'
import type { MemPressureSample } from '../../../infra/mem-pressure.js'
import { runStartupReattach, type StartupReattachDeps, type StartupReattachOptions } from '../../startup-reattach.js'
import { applySessionOccupancyTransition, IDLE_SESSION_OCCUPANCY } from '../event-interpreter.js'
import { refreshCheckpointOnOccupancyEdge } from '../crash-forensics-hooks.js'
import {
  initRuntimeCheckpointStore,
  type RuntimeCheckpointStore,
} from '../runtime-checkpoint.js'
import type { SessionOccupancy, SessionOccupancyStateStore } from '../types.js'

const HOUR = 3_600_000
/** 受控时钟基准（attach 时刻）。 */
const T0 = 1_700_000_000_000
/** occupancy 翻转边沿时刻（Date.now() 经 fake timers 钉在此值）。 */
const T1 = T0 + 10_000

/** mem-pressure 注入样本：常态（不高压，端到端用例零延迟）。 */
const calmSample: MemPressureSample = { swapUsedMB: null, swapTotalMB: null, freeMB: 8 * 1024, totalMB: 16 * 1024 }

const createdDirs: string[] = []
let runDir: string
let store: RuntimeCheckpointStore

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  runDir = mkdtempSync(join(tmpdir(), 'occupancy-checkpoint-edge-'))
  createdDirs.push(runDir)
  const events: CrashJournalEvent[] = []
  const journal: CrashJournalWriter = { append: (e) => { events.push(e) } }
  store = initRuntimeCheckpointStore({ dir: runDir, now: () => T0, journal })
  // 跨用例隔离：清内存清单 + 删磁盘主文件（reset 不动磁盘——磁盘残留会让 read() 读到上一用例清单）
  store.reset()
  rmSync(join(runDir, CHECKPOINT_FILENAME), { force: true })
})

afterEach(() => {
  store.reset()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

afterAll(() => {
  // 递归删除带 maxRetries+retryDelay（pre-commit flake 卫生检查要求）
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

/** attach 挂点形态的初始条目（registerSession 注册时刻：占用恒 idle，活动时刻 T0）。 */
function seedAttachedSession(sessionId: string, filePath: string | null = null): void {
  store.upsertSession({ sessionId, filePath, activityAt: T0 })
}

/** 最小 session view（applySessionOccupancyTransition 的结构入参）。 */
function makeSession(sessionId: string): SessionOccupancyStateStore {
  return { id: sessionId }
}

function entryOf(sessionId: string) {
  const found = store.listEntries().find((e) => e.piSessionId === sessionId)
  expect(found).toBeDefined()
  return found!
}

describe('occupancy 转移边沿 → checkpoint 占用快照刷新（fix-chat-flow-stuck A-6）', () => {
  it('idle→dispatching 边沿：occupancy 翻 occupied + lastActivityAt 推进到边沿时刻', () => {
    seedAttachedSession('s1')
    expect(entryOf('s1').occupancy).toBe('idle')

    vi.setSystemTime(T1)
    const session = makeSession('s1')
    applySessionOccupancyTransition(session, null, 'dispatching')

    expect(session.occupancy?.turn).toBe('dispatching')
    expect(entryOf('s1').occupancy).toBe('occupied')
    expect(entryOf('s1').lastActivityAt).toBe(T1)
  })

  it('turn 内相位推进（dispatching→generating）归并值不变 → 不刷新（refreshSessions 不被调）', () => {
    seedAttachedSession('s1')
    const session = makeSession('s1')
    applySessionOccupancyTransition(session, null, 'dispatching')
    const afterRise = { ...entryOf('s1') }

    const refreshSpy = vi.spyOn(store, 'refreshSessions')
    applySessionOccupancyTransition(session, null, 'generating')

    expect(session.occupancy?.turn).toBe('generating')
    expect(refreshSpy).not.toHaveBeenCalled()
    // 条目字段零变化（无多余落盘）
    expect(entryOf('s1')).toEqual(afterRise)
  })

  it('settling→idle 边沿：occupancy 回落 idle + lastActivityAt 更新为退出占用时刻', () => {
    seedAttachedSession('s1')
    const session = makeSession('s1')
    applySessionOccupancyTransition(session, null, 'dispatching')

    applySessionOccupancyTransition(session, null, 'settling')
    applySessionOccupancyTransition(session, null, 'settling') // 幂等（值未变短路，不触发刷新）
    vi.setSystemTime(T1 + HOUR)
    applySessionOccupancyTransition(session, null, 'idle')

    expect(session.occupancy?.turn).toBe('idle')
    expect(entryOf('s1').occupancy).toBe('idle')
    expect(entryOf('s1').lastActivityAt).toBe(T1 + HOUR)
  })

  it('布尔维参与三维投影：idle turn 下 compacting-start → occupied，compacting-end 回落', () => {
    seedAttachedSession('s1')
    const session = makeSession('s1')

    applySessionOccupancyTransition(session, null, 'compacting-start')

    expect(entryOf('s1').occupancy).toBe('occupied')
    // compacting-end 回落 idle（turn 恒 idle 的纯压缩窗口）
    applySessionOccupancyTransition(session, null, 'compacting-end')
    expect(entryOf('s1').occupancy).toBe('idle')
  })

  it('handingOff 不参与快照投影：handingOff-start 单独置位不翻转 checkpoint 占用值', () => {
    seedAttachedSession('s1')
    const session = makeSession('s1')

    const refreshSpy = vi.spyOn(store, 'refreshSessions')
    applySessionOccupancyTransition(session, null, 'handingOff-start')

    expect(session.occupancy?.handingOff).toBe(true)
    expect(refreshSpy).not.toHaveBeenCalled()
    expect(entryOf('s1').occupancy).toBe('idle')
  })

  it('未附着 session（checkpoint 无条目）的转移边沿 no-op：不新增不复活条目', () => {
    expect(store.hasSession('ghost')).toBe(false)

    const nextOccupancy: SessionOccupancy = { ...IDLE_SESSION_OCCUPANCY, turn: 'generating' }
    refreshCheckpointOnOccupancyEdge('ghost', IDLE_SESSION_OCCUPANCY, nextOccupancy)

    expect(store.hasSession('ghost')).toBe(false)
    expect(existsSync(join(runDir, CHECKPOINT_FILENAME))).toBe(false)
  })

  it('刷新异常不外抛：occupancy 写回主链不受影响（best-effort 旁路隔离）', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    seedAttachedSession('s1')
    vi.spyOn(store, 'refreshSessions').mockImplementation(() => {
      throw new Error('checkpoint boom')
    })
    const session = makeSession('s1')

    expect(() => applySessionOccupancyTransition(session, null, 'dispatching')).not.toThrow()
    // occupancy 写回与广播主链已完成（旁路故障只降级日志）
    expect(session.occupancy?.turn).toBe('dispatching')
    expect(errSpy).toHaveBeenCalledOnce()
  })

  it('端到端：占用中「崩溃」的磁盘快照经 runStartupReattach 自动恢复命中（安静长 turn，idle 超 2h 窗口）', async () => {
    const sessionId = 'busy-s1'
    const sessionFile = join(runDir, 'busy-s1.jsonl')
    seedAttachedSession(sessionId, sessionFile)
    // 进入占用（边沿刷新落盘）；此后长 turn 持续 3h（占用中 runtime 崩溃——磁盘快照停留本形态）
    vi.setSystemTime(T1)
    applySessionOccupancyTransition(makeSession(sessionId), null, 'dispatching')
    vi.setSystemTime(T1 + 3 * HOUR)

    const restore = vi.fn(async (_sid: string) => undefined)
    const deps: StartupReattachDeps = { restore, waitForOrphanReap: async () => {} }
    const options: StartupReattachOptions = {
      checkpoint: store,
      now: () => T1 + 3 * HOUR,
      journal: { append: () => {} },
      delay: async () => {},
      queryMemPressure: async () => calmSample,
      fileExists: () => true,
    }
    const report = await runStartupReattach(deps, options)

    expect(report.candidates).toEqual([sessionId])
    expect(report.restored).toEqual([sessionId])
    expect(restore).toHaveBeenCalledWith(sessionId)
  })
})
