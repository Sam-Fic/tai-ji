/**
 * session 真删除挂点三入口竞态测试（turn-boundary-index RL5 / 设计 D5，u-lifecycle）。
 *
 * 覆盖（任务书验收①②③④）：lifecycle.delete / btw closeLine / archive purgeArchive
 * 三条真删除路径各自——
 * - 在途首次构建被取消（挂点在整树删除原语之前转发，提交段复检必然晚于标记：删除入口
 *   的挂点调用点先于本次构建第一个 IO 完成回调——同步段直接到达（delete / closeLine）
 *   或经 serialize 首个微任务到达（purgeArchive），均构造性先于 IO 回调）；
 * - 被取消的 session.history 请求按现有 ENOENT 空页语义收尾并记录警告；
 * - 删除后无 history-index 写回（取消标记拒绝无 await 提交段 + 整树 trash 回收）；
 * - 内存 LRU 清理（A 段 store 直测钉行为；三入口用例经挂点转发放大同一方法链）；
 *   purgeArchive 一例专门验证不经 removeSessionEntry（销毁链 onSessionDisposed 不触发）
 *   时内存索引也由该挂点清理。
 * 对照（验收③）：pi 进程退出（onSessionDisposed）只清内存索引，读取不取消、结果完整。
 *
 * 隔离纪律：索引与线树写删目标全部落在 useTmpDataDir 注入的 $TAIJI_AGENT_DATA_DIR
 * （fs-guard 白名单）内的 mkdtemp 目录，自建自删；reader 自持 store 经生产推导
 * getSessionHistoryIndexFile 落在隔离 dataDir（转发链真实形态——不注入 indexFileOf）。
 * 背景任务收殓 mock（真实现含 spawnSync ps，禁子进程红线）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { IProcessManager } from '../../ports/pi-engine.js'
import { encodeCwd, getSessionHistoryIndexFile, getSessionStoreDir } from '@taiji/shared/paths'
import { useTmpDataDir } from './helpers/btw-harness.js'
import { SessionHistoryReader } from '../history-reader.js'
import { convertPiHistory } from '../../../infra/pi/message-converter.js'
import { scanTurnBoundariesForward, verifyTurnBoundaries } from '../../../infra/pi/turn-index-scanner.js'
import { TurnIndexStore } from '../turn-index-store.js'
import { SessionLifecycle } from '../session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { ISessionStore } from '../../ports/session.js'
import { BtwService } from '../btw-service.js'
import type { BtwLineRecord, BtwServiceDeps } from '../btw-service.js'
import { ArchiveService } from '../../archive/archive-service.js'
import type { ArchiveServiceDeps } from '../../archive/archive-service.js'

// 收殓 mock（真实现 spawnSync ps——测试红线禁真子进程；lifecycle scanned 分支的 cascade
// 与 archive fixture 的 deps 都会经此收殓，统一 mock 掉）
vi.mock('../background-task-reaper.js', () => ({
  reapSessionBackgroundTasks: vi.fn(async () => undefined),
}))

// tombstone 登记钉成可观测 spy（session-lifecycle 内 clearRemovedSessionDataForDelete
// 与 archive purge 步骤 2 都经此模块；真实实现在 session-data-store，此处只验时序）
const sessionDataStore = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../../plugin-service/session-data-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plugin-service/session-data-store.js')>()
  return {
    ...actual,
    clearRemovedSessionData: vi.fn((sessionId: string) => {
      sessionDataStore.calls.push(`tombstone:${sessionId}`)
    }),
  }
})

let root = ''
let restoreDataDir: () => void
let warnSpy: MockInstance

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-delete-index-race-'))
  restoreDataDir = useTmpDataDir()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  restoreDataDir()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── 共享 fixture ─────────────────────────────────────────────────────────────

const LINE_ID = 'line-race-0001'

/**
 * 扫描 port 生产同源装配（组合根 index.ts 同款同名函数简写——store 索引构建与 reader
 * 窗口校验经构造注入，测试直 import infra 装配同源行为）。
 */
const scanner = { scanTurnBoundariesForward, verifyTurnBoundaries }

function userJson(id: string, content: string): string {
  return JSON.stringify({ type: 'message', id, message: { role: 'user', content } })
}

function assistantJson(content: string): string {
  return JSON.stringify({ type: 'message', message: { role: 'assistant', content } })
}

/** 建一个含两个 user turn 的线 JSONL（btw 线路径的读取目标；内容合法可解析）。 */
function writeLineJsonl(dir: string): string {
  const file = join(dir, `${LINE_ID}.jsonl`)
  writeFileSync(file, [
    JSON.stringify({ type: 'session', id: LINE_ID, cwd: '/proj/race', timestamp: '2026-01-01T00:00:00.000Z' }),
    userJson('u1', 'first'),
    assistantJson('reply-a'),
    userJson('u2', 'second'),
    assistantJson('reply-b'),
  ].join('\n') + '\n')
  return file
}

/**
 * 构造走 btw 线路径的 reader（主会话定位恒 miss——三入口用例的读取目标全部是线文件，
 * reader 自持 store 的索引落 $TAIJI_AGENT_DATA_DIR 推导路径 = 隔离目录内）。
 */
function makeReader(lineFile: string): SessionHistoryReader {
  return new SessionHistoryReader({
    pm: { getClient: () => undefined } as unknown as IProcessManager,
    // convertHistory 委托 infra 真实现（对照例走完整转换链，消息断言才有内容意义）
    sessionStore: {
      scanSessions: () => [],
      convertHistory: (raw: unknown[], entryIds?: string[]) => convertPiHistory(raw, entryIds),
    } as unknown as ISessionStore,
    resolveBtwThreadFile: (sessionId) => (sessionId === LINE_ID ? lineFile : undefined),
    scanner,
  })
}

/** 索引文件落点（生产推导 = 隔离 dataDir/ext-sessions/<sid>/history-index/turns.json）。 */
const indexFileOf = (sessionId: string): string => getSessionHistoryIndexFile(sessionId)

describe('A. TurnIndexStore 挂点行为单点（LRU 清理与竞态收尾）', () => {
  let store: TurnIndexStore
  let lineFile: string

  beforeEach(() => {
    // store 直测注入 indexFileOf（落本用例 mkdtemp 根）；与 reader 段的生产推导隔离互补
    store = new TurnIndexStore({ indexFileOf: (sid) => join(root, 'idx', sid, 'history-index', 'turns.json'), scanner })
    lineFile = writeLineJsonl(root)
  })

  it('onSessionDeleted 清理内存 LRU（挂点行为单点直断言）', async () => {
    await store.ensureFresh(LINE_ID, lineFile)
    expect(store.hasMemoryIndex(LINE_ID)).toBe(true)
    store.onSessionDeleted(LINE_ID)
    expect(store.hasMemoryIndex(LINE_ID)).toBe(false)
  })

  it('竞态收尾：删除标记先设、构建后完成——内存条目不复活、无写回、请求 warn 空页', async () => {
    const pending = store.ensureFresh(LINE_ID, lineFile)
    // 同步落标记：提交段复检在 await 链之后执行，必然晚于本调用（构造性时序）
    store.onSessionDeleted(LINE_ID)
    expect(await pending).toBeNull()
    // touchMemory 不感知标记——竞态收尾清理必须回收构建后完成复活的内存条目
    expect(store.hasMemoryIndex(LINE_ID)).toBe(false)
    expect(existsSync(join(root, 'idx', LINE_ID, 'history-index', 'turns.json'))).toBe(false)
    expect(existsSync(join(root, 'idx', LINE_ID, 'history-index', 'turns.json.tmp'))).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('已真删除'))
  })
})

describe('B. SessionHistoryReader 挂点委托（转发链端到端）+ 普通销毁对照', () => {
  it('在途首次构建被取消：请求按 ENOENT 空页并 warn，无 history-index 写回', async () => {
    const lineFile = writeLineJsonl(root)
    const reader = makeReader(lineFile)
    const pending = reader.getHistory(LINE_ID)
    // 挂点转发：doGetHistory 同步段让出在首个 IO await——标记必然先于提交段复检
    reader.onSessionDeleted(LINE_ID)
    const result = await pending
    expect(result.messages).toEqual([])
    expect(result.truncated).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('已真删除'))
    expect(existsSync(indexFileOf(LINE_ID))).toBe(false)
    expect(existsSync(indexFileOf(LINE_ID) + '.tmp')).toBe(false)
    // 删除后再请求：标记命中直接空页（不复活索引、不残留 LRU 条目的可观察形态）
    const again = await reader.getHistory(LINE_ID)
    expect(again.messages).toEqual([])
  })

  it('对照（验收③保留断言）：onSessionDisposed（pi 进程退出）不取消读取，结果完整返回', async () => {
    const lineFile = writeLineJsonl(root)
    const reader = makeReader(lineFile)
    const pending = reader.getHistory(LINE_ID)
    reader.onSessionDisposed(LINE_ID)
    const result = await pending
    // 构建照常完成：两个 user turn 的消息窗口完整返回（含索引落盘——普通销毁不拒提交）
    expect(result.messages.length).toBeGreaterThan(0)
    expect(existsSync(indexFileOf(LINE_ID))).toBe(true)
  })
})

// ── C 段：lifecycle.delete 挂点接线 ─────────────────────────────────────────

describe('C. lifecycle.delete 挂点（scanned 分支，整树 trash 之前）', () => {
  function makeLifecycleHarness(lineFile: string, reader: SessionHistoryReader): { lifecycle: SessionLifecycle; calls: string[] } {
    const calls: string[] = []
    const svc = {
      findScannedSession: (sid: string) =>
        sid === LINE_ID ? { id: LINE_ID, filePath: lineFile, cwd: '/proj/race', name: 'race', timestamp: '2026-01-01T00:00:00.000Z', size: 1, lastModified: 1 } : undefined,
      // 生产链路同构：svc 可选成员 → SessionService.onSessionDeleted → historyReader 转发。
      // 测试内直接转发 reader.onSessionDeleted（同一条 reader→自持 store 链）。
      onSessionDeleted: (sid: string) => {
        calls.push(`deleted:${sid}`)
        reader.onSessionDeleted(sid)
      },
    } as unknown as ILifecycleSessionOps
    const sessionStore = {
      trash: async (p: string) => {
        calls.push(`trash:${p}`)
        rmSync(p, { force: true, maxRetries: 5, retryDelay: 20 })
      },
      trashDirectory: async (d: string) => {
        calls.push(`treeTrash:${d}`)
        rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      },
      invalidateMetaCache: () => {},
      invalidateScanCache: () => {
        calls.push('invalidateScan')
      },
      refreshAll: () => {},
    } as unknown as ISessionStore
    const registerDeps = {
      adapterFactory: vi.fn(),
      getMessageBus: () => null,
      broadcastGlobal: vi.fn(),
    } as unknown as ISessionRegisterDeps
    const lifecycle = new SessionLifecycle(svc, {} as never, {} as never, sessionStore, {} as never, registerDeps)
    return { lifecycle, calls }
  }

  it('在途构建 × delete 并发：挂点在整树 trash 前转发取消，请求空页 + warn + 无写回 + 树内无索引残留', async () => {
    const lineFile = writeLineJsonl(root)
    const reader = makeReader(lineFile)
    const { lifecycle, calls } = makeLifecycleHarness(lineFile, reader)
    // 线树目录（索引落点所在树 = getSessionStoreDir()/<sid>，即 cascade 的整树 trash 对象）
    const lineTree = join(getSessionStoreDir(), LINE_ID)
    mkdirSync(join(lineTree, 'attachments'), { recursive: true })
    writeFileSync(join(lineTree, 'attachments', 'paste-1.png'), 'png')

    const pending = reader.getHistory(LINE_ID)
    // delete 开头到挂点行全同步（生成中门 → userStopped 清理 → 死亡处置 → btw 判别 miss
    // → 挂点）——标记先于在途构建的提交段复检（构造性时序）
    await lifecycle.delete(LINE_ID)
    const result = await pending

    // 挂点在整树 trash 之前被调用（calls 序）
    expect(calls.indexOf(`deleted:${LINE_ID}`)).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf(`deleted:${LINE_ID}`)).toBeLessThan(calls.findIndex((c) => c.startsWith('treeTrash:')))
    // 取消生效：空页 + warn
    expect(result.messages).toEqual([])
    expect(result.truncated).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('已真删除'))
    // 无写回 + 整树回收（索引目录随线树消失，无 history-index 残留）
    expect(existsSync(indexFileOf(LINE_ID))).toBe(false)
    expect(existsSync(lineTree)).toBe(false)
  })
})

// ── D 段：btw closeLine 挂点接线 ────────────────────────────────────────────

describe('D. btw closeLine 挂点（线树 trashDirectory 之前）', () => {
  function makeBtwHarness(lineFile: string, reader: SessionHistoryReader): { svc: BtwService; calls: string[] } {
    const calls: string[] = []
    const svc = new BtwService({
      processes: {
        createSession: vi.fn(),
        destroySession: vi.fn(async () => undefined),
        rekey: vi.fn(),
        getClient: () => undefined,
      },
      buildLineSpawnOptions: vi.fn(async () => ({ env: {} })),
      registerSession: vi.fn(async () => undefined),
      resolveMainSessionFile: () => undefined,
      trashDirectory: async (d: string) => {
        calls.push(`treeTrash:${d}`)
        rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      },
      resolvePiCommand: () => 'pi',
      // 生产链路同构：BtwServiceDeps 可选成员（组合根注入闭包）→ SessionService → reader 转发
      onSessionDeleted: (sid: string) => {
        calls.push(`deleted:${sid}`)
        reader.onSessionDeleted(sid)
      },
    } as unknown as BtwServiceDeps)
    // 预置注册表条目（closeLine 消费面：进程已亡、线文件 = 在途构建的读取目标）
    const rec: BtwLineRecord = {
      piSessionId: LINE_ID,
      mainSid: 'main-race-0001',
      cwd: '/proj/race',
      label: 'race-line',
      threadDir: root,
      sessionFilePath: lineFile,
      snapshotKind: 'forked',
      surface: 'btw',
      createdAt: 0,
      pendingInteraction: false,
      contractRounds: 1,
      client: undefined,
    }
    ;(svc as unknown as { registry: Map<string, BtwLineRecord> }).registry.set(LINE_ID, rec)
    return { svc, calls }
  }

  it('在途构建 × closeLine 并发：挂点在线树 trash 前转发取消，请求空页 + warn + 线树整删', async () => {
    const lineFile = writeLineJsonl(root)
    const reader = makeReader(lineFile)
    const { svc, calls } = makeBtwHarness(lineFile, reader)
    const lineTree = join(getSessionStoreDir(), LINE_ID)
    mkdirSync(lineTree, { recursive: true })

    const pending = reader.getHistory(LINE_ID)
    // closeLine 到挂点行全同步（registry 命中 → 条目摘除 → client 无 → 终结扇出 → 文件段
    // 跳过 → resolveLineTreeDir → 挂点）——标记先于提交段复检（构造性时序）
    await svc.closeLine(LINE_ID)
    const result = await pending

    expect(calls.indexOf(`deleted:${LINE_ID}`)).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf(`deleted:${LINE_ID}`)).toBeLessThan(calls.findIndex((c) => c.startsWith('treeTrash:')))
    expect(result.messages).toEqual([])
    expect(result.truncated).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('已真删除'))
    expect(existsSync(indexFileOf(LINE_ID))).toBe(false)
    expect(existsSync(lineTree)).toBe(false)
    expect(await svc.closeLine(LINE_ID)).toBe(false) // 并发双删幂等形态
  })
})

// ── E 段：archive purgeArchive 挂点接线（不经 removeSessionEntry 的 LRU 专门验证）──

describe('E. purgeArchive 挂点（tombstone 同段次序、cascade 之前；LRU 由挂点清理的专门验证）', () => {
  /** staging 态归档单元 fixture（簿记 + 明文枚举源；cascade 正常链可达整树 trash）。 */
  function seedStagingLedger(dataDir: string, lineFile: string): { archiveRoot: string; unitDir: string } {
    const archiveRoot = join(dataDir, 'agent', 'archive')
    const cwd = '/proj/race'
    const unitDir = join(archiveRoot, encodeCwd(cwd))
    mkdirSync(unitDir, { recursive: true })
    const originalFile = `2026-10-20T00-00-00-000Z_${LINE_ID}.jsonl`
    writeFileSync(join(unitDir, originalFile), readLineFile(lineFile))
    const ledger = {
      sessionId: LINE_ID,
      name: `会话-${LINE_ID}`,
      originalFile,
      cwd,
      archivedAt: '2026-10-20T00:00:00.000Z',
      rawBytes: 1,
      status: 'staging',
      summary: null,
    }
    writeFileSync(join(unitDir, `${originalFile}.archive.json`), `${JSON.stringify(ledger, null, 2)}\n`)
    return { archiveRoot, unitDir }
  }

  function readLineFile(lineFile: string): string {
    return readFileSync(lineFile, 'utf-8')
  }

  it('在途构建 × purgeArchive 并发：挂点在 tombstone 后 cascade 前转发取消；不经 removeSessionEntry 时 LRU 也由挂点清理', async () => {
    const lineFile = writeLineJsonl(root)
    const reader = makeReader(lineFile)
    const dataDir = process.env.TAIJI_AGENT_DATA_DIR
    if (dataDir === undefined) throw new Error('useTmpDataDir must have set TAIJI_AGENT_DATA_DIR')
    const { archiveRoot } = seedStagingLedger(dataDir, lineFile)
    const calls: string[] = []
    const removeSessionEntry = vi.fn()
    const service = new ArchiveService({
      isGenerating: () => false,
      getActiveSession: () => undefined,
      findScannedSession: () => undefined,
      disposeUserStopped: () => {
        calls.push('userStopped')
      },
      fireArchiveDisposition: () => {
        calls.push('archiveDisp')
      },
      closeAllBtwLines: async () => [],
      detachSession: () => {},
      destroyPiSession: async () => {},
      removeSessionEntry: (sid: string) => {
        removeSessionEntry(sid)
      },
      reapBackgroundTasks: async () => undefined,
      clearRemovedSessionData: () => {
        calls.push(`tombstone:${LINE_ID}`)
      },
      // 生产链路同构：ArchiveServiceDeps 可选成员（组合根注入闭包）→ SessionService → reader
      onSessionDeleted: (sid: string) => {
        calls.push(`deleted:${sid}`)
        reader.onSessionDeleted(sid)
      },
      unbindCanvas: () => {},
      trash: async (p: string) => {
        calls.push(`trash:${p}`)
        rmSync(p, { force: true, maxRetries: 5, retryDelay: 20 })
      },
      trashDirectory: async (d: string) => {
        calls.push(`treeTrash:${d}`)
        rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      },
      invalidateScanCache: () => {},
      broadcastSessionList: () => {},
      getSessionSummary: () => undefined,
      warn: () => {},
    }, {
      dataDir,
      archiveRoot,
      agentDir: join(dataDir, 'agent'),
      sessionsRoot: join(dataDir, 'agent', 'sessions'),
    })

    // 非活跃形态：purge 前先让索引建立并有在途构建——pending 挂在首个 IO await 上。
    // 线树目录预置（cascade 段 3 有 existsSync 门——目录不在场时整树软删按目标态达成
    // 跳过，时序断言会失去 treeTrash 锚点）。
    const lineTree = join(getSessionStoreDir(), LINE_ID)
    mkdirSync(lineTree, { recursive: true })
    const pending = reader.getHistory(LINE_ID)
    // purgeArchive 经 serialize 首个微任务执行 runPurge：步骤 1 簿记门 → 步骤 2 tombstone
    // → 步骤 2.5 挂点（转发取消标记）——微任务先于在途构建的 IO 完成回调（构造性时序）
    const purge = service.purgeArchive(LINE_ID)
    const [result, purgeReply] = await Promise.all([pending, purge])

    // purge 链不经销毁链：removeSessionEntry 未被调用——内存索引 LRU 只能由挂点清理
    expect(removeSessionEntry).not.toHaveBeenCalled()
    // 挂点被调恰一次且次序 = tombstone 之后、整树 trash 之前（与步骤 2 同段次序）
    expect(calls.filter((c) => c === `deleted:${LINE_ID}`)).toHaveLength(1)
    expect(calls.indexOf(`tombstone:${LINE_ID}`)).toBeLessThan(calls.indexOf(`deleted:${LINE_ID}`))
    expect(calls.indexOf(`deleted:${LINE_ID}`)).toBeLessThan(calls.findIndex((c) => c.startsWith('treeTrash:')))
    // 取消生效：请求空页 + warn
    expect(result.messages).toEqual([])
    expect(result.truncated).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('已真删除'))
    // 无写回 + 整树回收（storeRoot = dataDir/ext-sessions，索引目录随会话树消失）
    expect(existsSync(indexFileOf(LINE_ID))).toBe(false)
    expect(existsSync(lineTree)).toBe(false)
    // purge reply 终态（无 keep-all 保守保留）
    expect(purgeReply.keptSubagentsDir).toBeUndefined()
    expect(archiveRoot.length).toBeGreaterThan(0)
  })
})
