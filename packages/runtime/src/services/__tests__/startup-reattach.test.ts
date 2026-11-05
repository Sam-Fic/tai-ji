/**
 * reattach 编排单测（crash-forensics-and-watchdog §3.3 D3，实施单元 u5）。
 *
 * 验收条款逐条对照（impl-plan u5；时间过滤/高水位延迟/收割上界已随时间机制清查删除，
 * 对应验收组 A1/A2/A4/#27 一并退役）：
 * - **A3 live 孤儿未收割完不 spawn**：收割 promise 未 resolve 时编排不启动 restore（假收割
 *   promise 控制时序）；收割 promise 意外 reject → 全部候选跳过退 lazy + 删 checkpoint
 *   （宁 lazy 不双持的防御侧）。
 * - **A5 reattach-skipped 逐 session**：staleness 命中 / restore 失败各自产生一条 journal
 *   记录（sessionId/reason 断言）。
 * - **A6 checkpoint 删除属主**：全部尝试完后文件被删（含全跳过/零候选/无 checkpoint 形态）。
 * - **组合根挂点**：index.ts 源码顺序断言——runStartupReattach 在 await server.start() 之后
 *   （D3「listen 后」硬约束）。
 * - **收割 promise 交付**：startup-background-init 的 onOrphanReapChainScheduled 在调度后
 *   同步交付、链尾 settle 后 resolve（u5 消费方的接线证据）。
 *
 * 全部文件目标 = mkdtempSync(tmpdir) 自建自删（fs-guard 白名单）；递归删除带 maxRetries。
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/startup-reattach.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrashJournalEvent, CrashJournalWriter } from '@taiji/shared'
import { RUN_CHECKPOINT_FILENAME as CHECKPOINT_FILENAME } from '@taiji/shared/paths'
import { RuntimeCheckpointStore } from '../session/runtime-checkpoint.js'
import type { RuntimeCheckpointEntry } from '../session/runtime-checkpoint.js'
import {
  REATTACH_SKIP_RESTORE_FAILED,
  REATTACH_SKIP_STALENESS,
  runStartupReattach,
  type StartupReattachDeps,
  type StartupReattachOptions,
} from '../startup-reattach.js'
import { runStartupBackgroundInit } from '../startup-background-init.js'
import type { ExtensionService } from '../extension-service.js'
import type { ProcessManager } from '../../infra/pi/process-manager.js'
import type { SkillRegistry } from '../skill-registry.js'
import type { PluginService } from '../plugin-service/plugin-service.js'
import type { PiConfigStore } from '../../infra/pi/pi-config-store.js'
import type { AuthStorage } from '../auth/auth-storage.js'

/** 恒定可控时钟（checkpoint store 落盘时间戳）。 */
const T0 = 1_700_000_000_000

const createdDirs: string[] = []
let runDir: string

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'startup-reattach-'))
  createdDirs.push(runDir)
  // 收殓 mock 调用计数按用例隔离（收割交付用例断言 toHaveBeenCalledTimes）
  rh.reapOrphanPiProcesses.mockClear()
})

afterAll(() => {
  // maxRetries + retryDelay（教训 d9ad39cb8）：teardown 递归删除瞬态重试
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

/** 构造 checkpoint 条目（缺省形态：无时间戳、无占用标记）。 */
function entry(overrides: Partial<RuntimeCheckpointEntry>): RuntimeCheckpointEntry {
  return {
    piSessionId: 's1',
    filePath: join(runDir, 's1.jsonl'),
    lastActivityAt: null,
    lastViewedAt: null,
    occupancy: 'idle',
    backgroundTasks: false,
    relayChildren: false,
    ...overrides,
  }
}

interface Harness {
  store: RuntimeCheckpointStore
  events: CrashJournalEvent[]
  journal: CrashJournalWriter
  /** restore spy（vi.fn 实例，断言 toHaveBeenCalled* 直接可用）。 */
  restore: (sessionId: string) => Promise<unknown>
  checkpointPath: string
  /** A3 时序控制柄：resolve 收割 promise。 */
  settleHarvest: () => void
  harvestPromise: Promise<void>
}

function makeHarness(): Harness {
  const events: CrashJournalEvent[] = []
  const journal: CrashJournalWriter = { append: (e) => { events.push(e) } }
  const store = new RuntimeCheckpointStore({ dir: runDir, now: () => T0, journal })
  let settleHarvest: () => void = () => {}
  const harvestPromise = new Promise<void>((resolve) => { settleHarvest = resolve })
  const restore = vi.fn(async (_sessionId: string) => undefined)
  return {
    store,
    events,
    journal,
    restore,
    checkpointPath: join(runDir, CHECKPOINT_FILENAME),
    settleHarvest,
    harvestPromise,
  }
}

/** 编排依赖：缺省 restore=spy、收割=pending（settleHarvest 手动放行）。 */
function makeDeps(h: Harness, overrides: Partial<StartupReattachDeps> = {}): StartupReattachDeps {
  return {
    restore: (sid) => h.restore(sid),
    waitForOrphanReap: () => h.harvestPromise,
    ...overrides,
  }
}

/** 编排选项基线：journal/checkpoint 注入 + 文件存在性恒真（非 staleness 用例的探针免建真实文件）。 */
function makeOptions(h: Harness, overrides: Partial<StartupReattachOptions> = {}): StartupReattachOptions {
  return {
    journal: h.journal,
    checkpoint: h.store,
    fileExists: () => true,
    ...overrides,
  }
}

/** 写入候选并落盘 checkpoint（store.upsertSession 即落盘）。 */
function seed(h: Harness, entries: RuntimeCheckpointEntry[]): void {
  for (const e of entries) {
    h.store.upsertSession({
      sessionId: e.piSessionId,
      filePath: e.filePath,
      activityAt: e.lastActivityAt ?? undefined,
      viewedAt: e.lastViewedAt ?? undefined,
      occupancy: e.occupancy,
      backgroundTasks: e.backgroundTasks,
      relayChildren: e.relayChildren,
    })
  }
}

function skipEvents(events: CrashJournalEvent[]): CrashJournalEvent[] {
  return events.filter((e) => e.event === 'reattach-skipped')
}

// ─────────────────────────────────────────────────────────────────────────────
// A3 收割等待（P9 消灭双持；事实判定无时间上界）
// ─────────────────────────────────────────────────────────────────────────────

describe('A3 收割等待（P9 消灭双持）', () => {
  it('收割 promise 未 resolve 时编排不启动 restore；resolve 后恢复执行', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'live' })])
    const pending = runStartupReattach(makeDeps(h), makeOptions(h))
    // 让编排跑到收割 await：收割未完成 → 零 spawn
    await new Promise((r) => setTimeout(r, 0))
    expect(h.restore).not.toHaveBeenCalled()

    h.settleHarvest()
    const report = await pending
    expect(h.restore).toHaveBeenCalledTimes(1)
    expect(h.restore).toHaveBeenCalledWith('live')
    expect(report.restored).toEqual(['live'])
    expect(report.checkpointDeleted).toBe(true)
  })

  it('收割 promise 意外 reject（契约违背的防御机制侧）→ 全部候选跳过 + 删 checkpoint（宁 lazy 不双持）', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a' })])
    const report = await runStartupReattach(
      makeDeps(h, { waitForOrphanReap: () => Promise.reject(new Error('harvest boom')) }),
      makeOptions(h),
    )
    expect(h.restore).not.toHaveBeenCalled()
    expect(report.skipped.map((s) => s.reason)).toEqual([REATTACH_SKIP_RESTORE_FAILED])
    expect(report.checkpointDeleted).toBe(true)
    expect(existsSync(h.checkpointPath)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A5 reattach-skipped 逐 session journal 记录
// ─────────────────────────────────────────────────────────────────────────────

describe('A5 reattach-skipped 事件（逐 session 一条）', () => {
  it('staleness 命中：filePath=null 与文件缺失各自产生一条（reason=file-missing），不 spawn', async () => {
    const h = makeHarness()
    const missingPath = join(runDir, 'deleted-by-user.jsonl')
    const healthyPath = join(runDir, 'healthy.jsonl')
    seed(h, [
      entry({ piSessionId: 'unknown-path', filePath: null }), // pi 延迟写入窗口
      entry({ piSessionId: 'user-deleted', filePath: missingPath }), // 用户已删除
      entry({ piSessionId: 'healthy', filePath: healthyPath }),
    ])
    writeFileSync(healthyPath, '', 'utf8')
    h.settleHarvest()
    // 本用例走真实 fs 存在性查询（tmp 白名单内），校验 guard 默认实现形态
    const report = await runStartupReattach(makeDeps(h), makeOptions(h, { fileExists: (p) => existsSync(p) }))
    // 只有 healthy 尝试 spawn（staleness guard 先于 restore）
    expect(h.restore).toHaveBeenCalledTimes(1)
    expect(h.restore).toHaveBeenCalledWith('healthy')
    expect(report.restored).toEqual(['healthy'])
    expect(report.skipped).toEqual([
      { sessionId: 'unknown-path', reason: REATTACH_SKIP_STALENESS },
      { sessionId: 'user-deleted', reason: REATTACH_SKIP_STALENESS },
    ])
    const skips = skipEvents(h.events)
    expect(skips).toHaveLength(2)
    expect(skips[0]).toMatchObject({ layer: 'runtime', event: 'reattach-skipped', sessionId: 'unknown-path', reason: 'file-missing' })
    expect(String(skips[0]?.detailDigest)).toContain('delayed-write')
    expect(skips[1]).toMatchObject({ sessionId: 'user-deleted', reason: 'file-missing' })
    expect(String(skips[1]?.detailDigest)).toContain(missingPath)
  })

  it('restore 失败：逐 session 记 restore-failed（detailDigest 含错误），批次内其余继续（并发 2 容错）', async () => {
    const h = makeHarness()
    seed(h, [
      entry({ piSessionId: 'boom' }),
      entry({ piSessionId: 'fine' }),
    ])
    h.settleHarvest()
    const restore = vi.fn(async (sid: string) => {
      if (sid === 'boom') throw new Error('pi spawn failed')
      return undefined
    })
    const report = await runStartupReattach(makeDeps(h, { restore }), makeOptions(h))
    expect(restore).toHaveBeenCalledTimes(2) // 失败不阻断批次
    expect(report.restored).toEqual(['fine'])
    expect(report.skipped).toEqual([{ sessionId: 'boom', reason: REATTACH_SKIP_RESTORE_FAILED }])
    const skips = skipEvents(h.events)
    expect(skips).toHaveLength(1)
    expect(skips[0]).toMatchObject({ sessionId: 'boom', reason: 'restore-failed' })
    expect(String(skips[0]?.detailDigest)).toContain('pi spawn failed')
  })

  it('分批并发 2：三候选按 2+1 两批逐批执行，单 session 失败不阻断下一批', async () => {
    const h = makeHarness()
    seed(h, [
      entry({ piSessionId: 'a' }),
      entry({ piSessionId: 'b' }),
      entry({ piSessionId: 'c' }),
    ])
    h.settleHarvest()
    const restore = vi.fn(async (sid: string) => {
      if (sid === 'b') throw new Error('b failed')
      return undefined
    })
    const report = await runStartupReattach(makeDeps(h, { restore }), makeOptions(h))
    expect(restore).toHaveBeenCalledTimes(3)
    expect(report.restored.sort()).toEqual(['a', 'c'])
    expect(report.skipped).toEqual([{ sessionId: 'b', reason: REATTACH_SKIP_RESTORE_FAILED }])
    expect(report.checkpointDeleted).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A6 checkpoint 删除属主（D3 契约 1 第二路）
// ─────────────────────────────────────────────────────────────────────────────

describe('A6 checkpoint 删除（全部尝试完后无条件删）', () => {
  it('全部 restore 成功 → 文件被删', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a' })])
    h.settleHarvest()
    await runStartupReattach(makeDeps(h), makeOptions(h))
    expect(existsSync(h.checkpointPath)).toBe(false)
  })

  it('中途全跳过（staleness 全命中）→ 文件仍被删（A6「全跳过也删」）', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'ghost', filePath: null })])
    h.settleHarvest()
    const report = await runStartupReattach(makeDeps(h), makeOptions(h))
    expect(h.restore).not.toHaveBeenCalled()
    expect(report.skipped).toHaveLength(1)
    expect(existsSync(h.checkpointPath)).toBe(false)
    expect(report.checkpointDeleted).toBe(true)
  })

  it('checkpoint sessions 空（零候选）→ 零尝试仍删', async () => {
    const h = makeHarness()
    h.store.upsertSession({ sessionId: 'tmp-seed', filePath: join(runDir, 'tmp.jsonl') })
    // 直接构造空 sessions 快照：绕过 seed 写入（store 无清空 API，经 checkpointPath 覆写）
    writeFileSync(h.checkpointPath, JSON.stringify({ sessions: [] }), 'utf8')
    h.settleHarvest()
    const report = await runStartupReattach(makeDeps(h), makeOptions(h))
    expect(report.candidates).toEqual([])
    expect(h.restore).not.toHaveBeenCalled()
    expect(existsSync(h.checkpointPath)).toBe(false)
    expect(report.checkpointDeleted).toBe(true)
  })

  it('无 checkpoint（clean exit / 首次启动）→ 零动作零 spawn（A3b 冷启动维持 lazy）', async () => {
    const h = makeHarness()
    let harvestAwaited = false
    const report = await runStartupReattach(
      makeDeps(h, { waitForOrphanReap: () => { harvestAwaited = true; return h.harvestPromise } }),
      makeOptions(h),
    )
    expect(report.checkpointFound).toBe(false)
    expect(report.candidates).toEqual([])
    expect(h.restore).not.toHaveBeenCalled()
    // 零动作形态下不应等待收割（无 spawn 风险情形）
    expect(harvestAwaited).toBe(false)
    expect(report.checkpointDeleted).toBe(false)
  })

  it('默认删除路径（无注入）：真实 tmp 文件被 unlink（D3 删除属主第二路走 store.checkpointPath）', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a' })])
    h.settleHarvest()
    const report = await runStartupReattach(makeDeps(h), makeOptions(h))
    expect(report.checkpointDeleted).toBe(true)
    expect(existsSync(h.checkpointPath)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 组合根挂点（D3「listen 后」硬约束）+ 收割 promise 交付（startup-background-init 消费方）
// ─────────────────────────────────────────────────────────────────────────────

describe('组合根挂点与收割 promise 交付', () => {
  it('index.ts 源码顺序断言：runStartupReattach 调用点位于 await server.start() 之后', () => {
    const candidates = [
      join(process.cwd(), 'src/index.ts'),
      join(process.cwd(), 'packages/runtime/src/index.ts'),
    ]
    const srcFile = candidates.find((p) => existsSync(p))
    if (!srcFile) throw new Error(`index.ts not found from cwd=${process.cwd()}`)
    const src = readFileSync(srcFile, 'utf-8')
    const listenAt = src.indexOf('await server.start()')
    const reattachAt = src.indexOf('runStartupReattach(')
    expect(listenAt).toBeGreaterThan(-1)
    expect(reattachAt).toBeGreaterThan(-1)
    expect(reattachAt).toBeGreaterThan(listenAt)
  })

  it('onOrphanReapChainScheduled：调度后同步交付完成 promise，5s 定时器触发且收殓链 settle 后 resolve', async () => {
    vi.useFakeTimers()
    try {
      const delivered: Promise<void>[] = []
      await runStartupBackgroundInit(makeBgDeps((p) => { delivered.push(p) }))
      // 调度即交付（同步段内回调），reattach 编排 await 的就是这份 promise
      expect(delivered).toHaveLength(1)
      let settled = false
      void delivered[0]!.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(mockReap.reapOrphanPiProcesses).toHaveBeenCalledTimes(1)
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('未传 onOrphanReapChainScheduled 时零行为变化（既有 fire-and-forget 形态不破）', async () => {
    vi.useFakeTimers()
    try {
      await expect(runStartupBackgroundInit(makeBgDeps(undefined))).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(mockReap.reapOrphanPiProcesses).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── runStartupBackgroundInit 测试装配（收割交付用例专用）─────────────────────

const rh = vi.hoisted(() => ({
  reapOrphanPiProcesses: vi.fn(async () => ({ scanned: 0, reaped: [], failed: [], unsupported: false })),
}))

vi.mock('../reap-orphan-pi.js', () => ({
  ORPHAN_REAP_DELAY_MS: 5_000,
  reapOrphanPiProcesses: rh.reapOrphanPiProcesses,
}))

vi.mock('../migration/legacy-provider-migration.js', () => ({
  migrateProviderConfig: vi.fn(async () => ({
    catalog: { migrated: [], kept: [], skipped: [], failed: [], errors: [] },
    enabled: { migratedEnabled: false, fullDisabledWarn: false },
  })),
}))

vi.mock('../rename-session-config.js', () => ({
  ensureAutoRenameDefault: vi.fn(),
}))

vi.mock('../extension-startup-config.js', () => ({
  ensureDeclaredStartupConfigs: vi.fn(() => ({ ensured: 0, skipped: 0, failed: 0 })),
}))

vi.mock('../session/background-task-reaper.js', () => ({
  reapAllSessionsBackgroundTasks: vi.fn(async () => undefined),
}))

const mockReap = rh

/** runStartupBackgroundInit 最小依赖组（除收殓链外全部 spy/常量对象）。 */
function makeBgDeps(onOrphanReapChainScheduled?: (completion: Promise<void>) => void) {
  // u17 判据 v2：readSpawnMarkers 现为必填 dep（本用例不触发收殓清单消费，null = 清单缺席 fail-safe）
  const readSpawnMarkers = vi.fn(() => null)
  const extensionService = {
    migrateBuiltinExtensions: vi.fn(async () => undefined),
    checkAndAutoUpgrade: vi.fn(async () => []),
    getExtensionPaths: vi.fn(async () => []),
  } as unknown as ExtensionService
  const pm = {
    getPiVersion: vi.fn(async () => '9.9.9'),
  } as unknown as ProcessManager
  const skillRegistry = {
    initGlobal: vi.fn(async () => undefined),
    getGlobalSkills: vi.fn(() => []),
  } as unknown as SkillRegistry
  const pluginService = {
    initialize: vi.fn(async () => undefined),
  } as unknown as PluginService
  return {
    readSpawnMarkers,
    configStore: {} as PiConfigStore,
    authStorage: {} as AuthStorage,
    credentialWriter: { saveCredential: vi.fn() },
    extensionService,
    pm,
    appInfo: { appVersion: '1.2.3', piVersion: 'unknown' },
    broadcastAppInfo: vi.fn(),
    skillRegistry,
    pluginService,
    ...(onOrphanReapChainScheduled ? { onOrphanReapChainScheduled } : {}),
  }
}
