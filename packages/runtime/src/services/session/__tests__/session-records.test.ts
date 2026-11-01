/**
 * SessionRecords 直测（S6 迁出批 1）：subagent/workflow 记录域——派生缓存族（订阅注册/
 * 防抖失效/增量拉取/游标自愈/销毁清理）+ 动作命令转发 + 引擎配置读写。
 *
 * 分层（G2：import 无 session-service，stub 面 = deps 5 方法）：
 * - mock 层 = deps（pm/sessionStore/hasSession/getMessageBus/getExtensionPaths），entry
 *   形态对齐 pi appendCustomEntry 契约（沿用 session-record-entries.test.ts 的 fixture
 *   形态）；scanSubagentEntries/scanWorkflowEntries 等 extractor 生产代码真实执行。
 * - fake timers（项目规范）：SCALAR_STATE_DEBOUNCE_MS 防抖由 advanceTimersByTimeAsync 推进。
 * - 引擎配置组：vi.mock pi-paths 的 getPiAgentDir 指向 per-test 临时目录（其余导出
 *   importOriginal 保留），withFileLockSync/atomicWrite 真实执行。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { logger } from '../../../infra/logger.js'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { SessionRecordsDeps } from '../session-records.js'
import { SessionRecords, encodeDirectiveText } from '../session-records.js'
import type { SessionEventProjection } from '../events-projection.js'
// [event-push-channel] journal 推送喂入生产路径路由（SessionRecords 构造期注册 sink）
import { routeJournalReport } from '../journal-report-router.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'
import type { SkillInjector, SkillInjectionResult } from '../skill-injector.js'
import { getSubagentRecordsDir, resolvePiWorkflowRunsDir } from '@zhushanwen/subagent-core'
import { extractSubagentsFromSessionFile } from '../subagent-extractor.js'
import { extractWorkflowsFromSessionFile } from '../workflow-extractor.js'
// [subagent-composer 结果回执通道] 回执目录单源（rootSessionId 分区键，读侧与生产同式）
import { getSubagentMessageResultsDir } from '@zhushanwen/subagent-core'
import type { PlanStateView } from '@taiji/shared'

const extractSubagentsMock = vi.mocked(extractSubagentsFromSessionFile)
const extractWorkflowsMock = vi.mocked(extractWorkflowsFromSessionFile)

/** 引擎配置组的 getPiAgentDir 重定向目标（hoisted：vi.mock 工厂内引用）。 */
const piAgentDirRef = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getPiAgentDir: () => piAgentDirRef.dir,
    // session 存储树数据根（records 目录第二参）：与 getPiAgentDir 同 ref 重定向
    //——[session-store-layout-inversion D2] records 目录 = getSubagentRecordsDir(sid, dataDir)
    getConfigDir: () => piAgentDirRef.dir,
  }
})

// 数据根同 ref 重定向：subagent 会话 jsonl 路径穿越守卫锚 = getSessionStoreDir(getDataDir())
//（<dataDir>/ext-sessions/）——用例经 piAgentDirRef 控制守卫锚与 fixture 树根一致
vi.mock('@taiji/shared/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared/paths')>()
  return {
    ...actual,
    getDataDir: () => piAgentDirRef.dir,
  }
})

// [W1 / D6] 全文读路径 call-through spy（验收③「getWorkflows/getSubagents 不再调全文
// 读路径」的代码断言载体）：行为保持真实实现（既有测试零影响），仅计数调用——
// 正常体量会话走 事件派生视图不触达；oversize 分流（旧格式兼容路径）触达。
vi.mock('../subagent-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../subagent-extractor.js')>()
  return {
    ...actual,
    extractSubagentsFromSessionFile: vi.fn((filePath: string) =>
      actual.extractSubagentsFromSessionFile(filePath),
    ),
  }
})
vi.mock('../workflow-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflow-extractor.js')>()
  return {
    ...actual,
    extractWorkflowsFromSessionFile: vi.fn((filePath: string) =>
      actual.extractWorkflowsFromSessionFile(filePath),
    ),
  }
})

/** get_entries RPC 返回形态（pi GetEntriesResponse：{entries, leafId}）。 */
type GetEntriesResult = { data?: { entries?: unknown[]; leafId?: string | null } }

/**
 * v2 subagent-record 终态条目承载的字段词表（设计 D1 终态列）。
 *
 * 非词表键（身份域：origin / parentRunId / stepIndex / rootSessionId / depth /
 * startedAt…，以及旧 v1 残留键 chatMode 等）归注册条目——派生视图层只认字段词表，
 * 残留键天然被忽略（「legacy 键容忍」用例的 v2 等价形态）。
 */
const SUBAGENT_SETTLED_KEYS: ReadonlySet<string> = new Set([
  'stopReason', 'outcome', 'error', 'endedAt', 'turns', 'totalTokens',
  'model', 'thinkingLevel', 'engine', 'engineHandle', 'sessionFile', 'result',
])

/**
 * 自描述 subagent-record entry 族（W1 v2：注册条目恒有 + 非 running 时终态条目）。
 *
 * 返回数组供调用方展开进 entries 列表（v2 事实源 = 主 session 的两条小条目；
 * 运行态数据在 record 事件文件 / run journal，不在条目内）。
 * status='running' → 仅注册条目；其他状态（done/…）→ 追加终态条目（status:'idle'，
 * stopReason 由 v1 状态词映射，终态字段经 extra 注入）。
 */
function subagentRecordEntry(
  id: string,
  status: string,
  entryId: string,
  extra: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const identity: Record<string, unknown> = {}
  const settled: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(extra)) {
    if (SUBAGENT_SETTLED_KEYS.has(key)) settled[key] = value
    else identity[key] = value
  }
  const registered: Record<string, unknown> = {
    type: 'custom',
    customType: 'subagent-record',
    id: entryId,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      origin: 'tool',
      rootSessionId: 's1',
      depth: 0,
      startedAt: 1000,
      ...identity,
    },
  }
  if (status === 'running') return [registered]
  return [
    registered,
    {
      type: 'custom',
      customType: 'subagent-record',
      id: `${entryId}-settled`,
      parentId: null,
      timestamp: '2026-08-19T00:00:01Z',
      data: {
        v: 2,
        kind: 'settled',
        id,
        status: 'idle',
        stopReason: status === 'done' ? 'completed' : status,
        endedAt: 2000,
        turns: 1,
        totalTokens: 1,
        model: undefined,
        thinkingLevel: undefined,
        ...settled,
      },
    },
  ]
}

/**
 * 自描述 workflow-record entry 族（W1 v2：注册条目恒有 + 非 running 时终态条目）。
 *
 * 第 5 参 = 注册条目的 recordPath 锚点（v2 run 步骤级详情读侧发现锚；旧 v1 快照的
 * trace 参数随运行态移出条目删除——agentCalls 现由 run journal fold 供骨架，需要
 * 步骤断言的用例自建 `workflow-state/<runId>.record.jsonl`）。
 */
function workflowRecordEntry(
  runId: string,
  status: 'running' | 'done' | 'interrupted',
  entryId: string,
  reason?: string,
  recordPath = '',
): Array<Record<string, unknown>> {
  const registered: Record<string, unknown> = {
    type: 'custom',
    customType: 'workflow-record',
    id: entryId,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      runId,
      workflowName: 'test-flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath,
    },
  }
  if (status === 'running') return [registered]
  return [
    registered,
    {
      type: 'custom',
      customType: 'workflow-record',
      id: `${entryId}-settled`,
      parentId: null,
      timestamp: '2026-08-19T00:00:01Z',
      data: {
        v: 2,
        kind: 'settled',
        runId,
        status,
        ...(reason !== undefined ? { reason } : {}),
        settledAt: 2000,
        callCount: 0,
        usedTokens: 1,
      },
    },
  ]
}

/** entry 族数组 → JSONL 文本（磁盘 fixture 写入口，与 pi appendCustomEntry 落盘形态同构）。 */
function jsonlLines(entries: Array<Record<string, unknown>>): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

/** 最小装置：deps 全 mock（publish spy 收集 bus 发布；client 可编程）。 */
function makeRecords(depsOverrides: Partial<SessionRecordsDeps> = {}, injector?: SkillInjector) {
  const publish = vi.fn()
  const client = {
    getEntries: vi.fn(async (_since?: string) => ({ data: { entries: [], leafId: null } }) as GetEntriesResult),
    prompt: vi.fn(async (_text: string) => undefined),
  }
  const deps: SessionRecordsDeps = {
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    sessionStore: { scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>) } as unknown as ISessionStore,
    hasSession: vi.fn(() => true),
    getMessageBus: () => ({ publish } as unknown as IMessageBus),
    ...depsOverrides,
  }
  const records = new SessionRecords(deps, injector)
  return { records, publish, client, deps }
}

/** subscribe 后收集注册 handler，返回手动触发器（模拟 lifecycle 同步直发）。 */
function registerSession(records: SessionRecords): (sessionId: string) => void {
  const handlers: Array<(sessionId: string) => void> = []
  records.subscribe({ onSessionRegistered: (h) => { handlers.push(h) } })
  return (sessionId: string) => { for (const h of handlers) h(sessionId) }
}

/** 推进防抖并等待在途拉取落定。 */
async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
}

// ── subagent-composer 结果回执通道装置（2026-10-18 契约）────────────────
//
// cancel/message 转发带 --req=<uuid>，runtime 在 prompt resolve 后读请求作用域回执
// 文件（getSubagentMessageResultsDir(sessionId, dataDir)/<reqId>.json，读后即删；缺失 =
// 通道失败 throw）。装置 = ① 临时 agentDir 挂 piAgentDirRef（getPiAgentDir/getConfigDir
// 已 mock 指向该 ref——回执 dataDir 与生产 getConfigDir 同源）+ 会话 cwd 经
// deps.getSessionCwd 注入；② prompt mock 按命令内
// --req=<id> 同步写 {"scope":"ok"} 回执（extension 写侧时序：handler 落盘先于
// prompt resolve）。

/** 从命令文本解析 --req=<id> 并写成功回执（目录经生产同源单源函数推导，rootSessionId 分区键）。 */
function writeOkReceiptFromCommand(sid: string, dataDir: string, text: string): void {
  const req = /--req=([\w-]+)/.exec(text)?.[1]
  if (req === undefined) return
  const resultsFile = join(getSubagentMessageResultsDir(sid, dataDir), `${req}.json`)
  mkdirSync(dirname(resultsFile), { recursive: true })
  writeFileSync(resultsFile, JSON.stringify({ scope: 'ok' }))
}

/** 回执通道装置：cwd 注入 deps.getSessionCwd，测试 finally 调 dispose 清理。 */
function armReceiptChannel(): { agentDir: string; cwd: string; dispose: () => void } {
  const agentDir = mkdtempSync(join(tmpdir(), 'session-records-receipt-'))
  piAgentDirRef.dir = agentDir
  return {
    agentDir,
    cwd: join(agentDir, 'proj'),
    dispose: () => {
      piAgentDirRef.dir = ''
      rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

describe('订阅与缓存注册', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('subscribe 注册 handler：触发后缓存就位，失效可拉取', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [...subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledTimes(1)
  })

  it('未注册 session 的失效 no-op（冷启动走磁盘路径）', async () => {
    const { records, client } = makeRecords()
    records.invalidateRecordEntries('s-unknown', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
  })
})

describe('invalidateRecordEntries：防抖', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('防抖窗口内多次失效合并为一次拉取', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    records.invalidateRecordEntries('s1', 'workflow-record')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledTimes(1)
  })

  it('非 record customType 忽略（entry_appended 主信号的其他 custom entry）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'other-custom-type')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
  })
})

describe('refreshRecordEntries：拉取与发布', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // 「全量路径：有变化才发布」用例已并入 session-records-reconcile.test.ts「送达水位发布门」
  // （严格超集：三家族帧 + 内容等价），此处不重复。

  it('running 态仅步骤数变化也发布 workflowUpdate（GUI 步骤实时可见，[步骤可见性修复 2026-09-14]）', async () => {
    // [W1 / D6] 步骤视图换源：agentCalls 骨架改由 run journal fold 供给（v2 条目不内嵌
    // trace）——本用例用真实 run journal 驱动「同 run 新增一个 agent 步骤」。
    const dir = mkdtempSync(join(tmpdir(), 'session-records-wfsteps-'))
    // [session-store-layout-inversion D2/D3] run journal 随 workflow 域换根：
    // <root>/<sid>/workflow/runs/（分区键 = 当前 sid，与生产 resolvePiWorkflowRunsDir 同源）
    const runJournalDir = resolvePiWorkflowRunsDir('s1', dir)
    mkdirSync(runJournalDir, { recursive: true })
    const runJournalPath = join(runJournalDir, 'run-1.record.jsonl')
    writeFileSync(runJournalPath, `${JSON.stringify({ type: 'run-created', runId: 'run-1', workflowName: 'test-flow', argsSummary: '', ts: 1000 })}\n`)
    try {
      piAgentDirRef.dir = dir
      const { records, publish, client } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath: join(dir, 's1.jsonl') }]) } as unknown as ISessionStore,
      })
      const fire = registerSession(records)
      client.getEntries.mockResolvedValue({
        data: { entries: [...workflowRecordEntry('run-1', 'running', 'e1', undefined, runJournalPath)], leafId: 'e1' },
      })
      fire('s1')
      records.invalidateRecordEntries('s1', 'subagent-record')
      await flushDebounce()
      // 新增 run：首发一次（status 变化）
      expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.workflowUpdate')).toHaveLength(1)

      // 同 runId 仍 running，run journal 追加一个 agent 步骤（core 启动即写入 journal 的产物）——
      // status/reason 未变，但步骤数 / 步骤状态序列变化也必须发布（否则 GUI 详情整个 run
      // 期间收不到 reload 触发）。[event-push-channel] 增量喂入 = journal 推送报告
      // （经 journal-report-router 生产路径路由到本 session 派生视图）。
      const agentStarted = { type: 'agent-started', taskIndex: 0, agentName: 'reviewer', attempt: 1, seq: 2, ts: 1100 }
      writeFileSync(runJournalPath, `${JSON.stringify(agentStarted)}\n`, { flag: 'a' })
      expect(routeJournalReport('s1', {
        domain: 'run',
        fileKey: 'run-1',
        events: [agentStarted],
        sessionId: 's1',
        emittedAt: Date.now(),
      })).toBe(true)
      const stepMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.workflowUpdate')
      expect(stepMsgs).toHaveLength(2)
      expect(stepMsgs[1][0]).toBe('s1')
    } finally {
      piAgentDirRef.dir = ''
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  // 「同值重复 entry 不重复发布」用例与 session-records-reconcile.test.ts
  // 「同值增量（新 entryId 同内容）不发布」场景相同，此处不重复。

  it('派生视图未就绪时报告到达 → 就地建派生视图后应用并发布（D3 顺带发现 5：不再丢报等待轮边界冷读）', async () => {
    // 场景：session 注册了但从无订阅拉取（recordEntriesCaches 无该 session 缓存），
    // record 域 journal 事件报告先到——修复前返回 false（写侧折叠，事件要等下次
    // ensureProjection 触发点才冷读收敛，托盘「进行中」轮内全程停留旧态）。
    const dir = mkdtempSync(join(tmpdir(), 'session-records-early-report-'))
    // 记录事件文件：record-created（round-started 前置身份帧）+ round-started（running 态事实）
    // 目录锚 = getSubagentRecordsDir(sessionId)（session 存储树根会话分区——与生产
    // 同源；分区键即会话 id s1）
    const recordsDir = getSubagentRecordsDir('s1', dir)
    mkdirSync(recordsDir, { recursive: true })
    const eventsPath = join(recordsDir, 'sa-early.events')
    const created = { type: 'record-events', id: 'sa-early', ver: 1 }
    const createdFrame = { type: 'record-created', seq: 1, ts: 1000, id: 'sa-early', agent: 'worker', task: 't', slug: 's', origin: 'tool', rootSessionId: 's1', depth: 0, mode: 'background', startedAt: 1000 }
    const roundStarted = { type: 'record-round-started', seq: 2, ts: 1100, id: 'sa-early', round: 1 }
    writeFileSync(eventsPath, [created, createdFrame, roundStarted].map((l) => JSON.stringify(l)).join('\n') + '\n')
    try {
      piAgentDirRef.dir = dir
      const { records, publish } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath: join(dir, 's1.jsonl'), cwd: dir }]) } as unknown as ISessionStore,
      })
      registerSession(records) // 只注册生命周期（不触发任何拉取/订阅链——缓存与派生视图均未建）
      writeFileSync(join(dir, 's1.jsonl'), '{}\n')

      const acked = routeJournalReport('s1', {
        domain: 'record',
        fileKey: 'sa-early',
        events: [createdFrame, roundStarted],
        sessionId: 's1',
        emittedAt: Date.now(),
      })
      // 修复前 false（派生视图未建丢报）；修复后就地建派生视图 + 应用成功 + 回 ack
      expect(acked).toBe(true)
      const subMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.subagents')
      expect(subMsgs.length).toBeGreaterThanOrEqual(1)
      // 派生视图内的成员是 running 态（round-started 折叠产物——托盘「进行中」计数的数据源）
      const payload = subMsgs[0]![1] as { payload: { subagents: Array<{ subagentId: string; status: string }> } }
      const member = (payload.payload.subagents ?? []).find((r) => r.subagentId === 'sa-early')
      expect(member?.status).toBe('running')
    } finally {
      piAgentDirRef.dir = ''
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('轮终翻转维度（终态条目注册→idle / result 写入 / model 写入）触发 publish；legacy 残留键容忍不触发', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [...subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)

    // 逐维度翻转：去重层若缺比对会把「轮终」的显示信号静默吞掉（不 publish）
    // ① 终态条目落盘（status running→idle + result 写入）；② 终态字段 model 再翻
    for (const [entryId, extra] of [
      ['e-result', { result: 'round output' }],
      ['e-model', { result: 'round output', model: 'p/m' }],
    ] as Array<[string, Record<string, unknown>]>) {
      client.getEntries.mockResolvedValue({
        data: { entries: [...subagentRecordEntry('sa-1', 'done', entryId, extra)], leafId: 'e-x' },
      })
      records.invalidateRecordEntries('s1', 'subagent-record')
      await flushDebounce()
    }
    expect(publish).toHaveBeenCalledTimes(3)

    // legacy 残留键（chatMode 等 v1 字段）不进 v2 派生视图词表：叠加在前一形态之上仅新增
    // 该键，其余字段全同 → 派生视图值不变，不构成 publish 信号。
    client.getEntries.mockResolvedValue({
      data: { entries: [...subagentRecordEntry('sa-1', 'done', 'e-chatmode-legacy', { result: 'round output', model: 'p/m', chatMode: false })], leafId: 'e-x' },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(3)
  })

  it('lastRound 比对位：仅 lastRound 变化的投影也触发 publish（漏比对 = wire 永不下发新轮收条）', async () => {
    // [subagent-observability u3 F4] 构造「除 lastRound 外全字段相等」的两轮投影：
    // 第二轮收条与前轮同 stopReason/turns/totalTokens/resultSummary，仅多
    // promptDisposition——发布去重层缺 lastRound 比对位时判全等 → 不发布 → 红点
    // 判据失真。事件驱动链（report → fold → 投影 → 发布门）全真，不经 entry 面。
    const dir = mkdtempSync(join(tmpdir(), 'session-records-lastround-'))
    const recordsDir = getSubagentRecordsDir('s1', dir)
    mkdirSync(recordsDir, { recursive: true })
    const eventsPath = join(recordsDir, 'sa-lr.events')
    const header = { type: 'record-events', id: 'sa-lr' }
    const created = { type: 'record-created', seq: 1, ts: 1000, id: 'sa-lr', agent: 'worker', task: 't', slug: 's', origin: 'tool', rootSessionId: 's1', depth: 0, mode: 'background', startedAt: 1000 }
    // 两轮收条事实字段刻意同值（stopReason/turns/totalTokens/resultSummary）——
    // 第二轮仅多 promptDisposition（lastRound 的键）。
    const roundIdle1 = { type: 'record-round-idle', seq: 2, ts: 2000, round: 1, stopReason: 'stop', turns: 2, totalTokens: 500, resultSummary: 'round reply' }
    const reopened = { type: 'record-reopened', seq: 3, ts: 3000, epoch: 2, round: 0 }
    const roundStarted = { type: 'record-round-started', seq: 4, ts: 3100, round: 2, epoch: 2 }
    const roundIdle2 = { type: 'record-round-idle', seq: 5, ts: 4000, round: 2, stopReason: 'stop', turns: 2, totalTokens: 500, resultSummary: 'round reply', promptDisposition: 'queued' }
    writeFileSync(eventsPath, [header, created, roundIdle1].map((l) => JSON.stringify(l)).join('\n') + '\n')
    interface WireMember {
      subagentId: string
      status: string
      turns?: number
      lastRound?: { turns?: number; result?: string; promptDisposition?: string }
    }
    const membersOf = (frame: unknown): WireMember =>
      ((frame as { payload: { subagents: WireMember[] } }).payload.subagents ?? []).find((r) => r.subagentId === 'sa-lr')!
    try {
      piAgentDirRef.dir = dir
      const { records, publish } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath: join(dir, 's1.jsonl'), cwd: dir }]) } as unknown as ISessionStore,
      })
      registerSession(records)
      writeFileSync(join(dir, 's1.jsonl'), '{}\n')

      expect(routeJournalReport('s1', {
        domain: 'record',
        fileKey: 'sa-lr',
        events: [created, roundIdle1],
        sessionId: 's1',
        emittedAt: Date.now(),
      })).toBe(true)
      const subMsgs = () => publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.subagents')
      expect(subMsgs().length).toBeGreaterThanOrEqual(1)
      const first = membersOf(subMsgs()[0]![1])
      expect(first.lastRound).toEqual({ turns: 2, result: 'round reply' })

      // 第二轮：仅 lastRound.promptDisposition 新增（其余投影字段全等）→ 必须发布
      writeFileSync(eventsPath, [reopened, roundStarted, roundIdle2].map((l) => JSON.stringify(l)).join('\n') + '\n', { flag: 'a' })
      expect(routeJournalReport('s1', {
        domain: 'record',
        fileKey: 'sa-lr',
        events: [reopened, roundStarted, roundIdle2],
        sessionId: 's1',
        emittedAt: Date.now(),
      })).toBe(true)
      const frameCount = subMsgs().length
      const second = membersOf(subMsgs()[frameCount - 1]![1])
      // 「仅 lastRound 变化」的构造前提钉住（其余字段与首轮逐项相等）
      expect(second.status).toBe(first.status)
      expect(second.turns).toBe(first.turns)
      expect(second.lastRound).toEqual({ turns: 2, result: 'round reply', promptDisposition: 'queued' })
      // 发布锚：比对位删除（漏比对）时本断言红——wire 永不下发新轮收条
      expect(frameCount).toBeGreaterThanOrEqual(2)
    } finally {
      piAgentDirRef.dir = ''
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('engine 域同值新引用不重复发布（字段级浅比较——引用比较会把每轮重解析误判为变化）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    // engine 锚齐备的 zcode record 形态（终态条目承载 engine/engineHandle；
    // sessionRef 键序 = sessionId 在前）
    client.getEntries.mockResolvedValue({
      data: {
        entries: [...subagentRecordEntry('sa-1', 'done', 'e1', {
          engine: 'zcode',
          engineHandle: {
            sessionRef: { sessionId: 'z-1', dbPath: '/engines/zcode/session-db/db.sqlite' },
            eventsPath: '/engines/zcode/shared/journal.jsonl',
            poolKey: 'shared',
          },
        })],
        leafId: 'e1',
      },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)

    // 增量窗口返回同值新 entry：extractor 重新解析产生全新对象引用（applyRecordEntries
    // 每轮重扫），且 sessionRef 刻意换键序（dbPath 在前）——字段级浅比较判相等不发布
    client.getEntries.mockResolvedValue({
      data: {
        entries: [...subagentRecordEntry('sa-1', 'done', 'e9', {
          engine: 'zcode',
          engineHandle: {
            eventsPath: '/engines/zcode/shared/journal.jsonl',
            sessionRef: { dbPath: '/engines/zcode/session-db/db.sqlite', sessionId: 'z-1' },
            poolKey: 'shared',
          },
        })],
        leafId: 'e9',
      },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('zcode 续聊换锚：engineHandle.sessionRef.sessionId 变化是真值变化必须 publish', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: {
        entries: [...subagentRecordEntry('sa-1', 'done', 'e1', {
          engine: 'zcode',
          engineHandle: {
            sessionRef: { sessionId: 'z-1', dbPath: '/engines/zcode/session-db/db.sqlite' },
            poolKey: 'shared',
          },
        })],
        leafId: 'e1',
      },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)

    // 续聊后每轮换新 session（record 锚已换新）——sessionRef.sessionId 真变化触发 publish
    client.getEntries.mockResolvedValue({
      data: {
        entries: [...subagentRecordEntry('sa-1', 'done', 'e2', {
          engine: 'zcode',
          engineHandle: {
            sessionRef: { sessionId: 'z-2', dbPath: '/engines/zcode/session-db/db.sqlite' },
            poolKey: 'shared',
          },
        })],
        leafId: 'e2',
      },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('增量路径：cursor 建立后失效走 getEntries(since)', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [...subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()

    client.getEntries.mockClear()
    client.getEntries.mockResolvedValue({ data: { entries: [...subagentRecordEntry('sa-1', 'done', 'e2')], leafId: 'e2' } })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1')
    const subagentsMsgs = publish.mock.calls.filter(([, msg]) => (msg as { type: string }).type === 'session.subagents')
    expect(subagentsMsgs).toHaveLength(2) // 第一轮全量 + 增量变化各一帧
    expect((subagentsMsgs.at(-1)![1] as { payload: { subagents: Array<{ status: string }> } }).payload.subagents[0].status).toBe('idle') // [U6/D5] legacy done 归一 idle
  })

  it('游标失效自愈：Entry not found → 丢 cursor 第二轮全量重建', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [...subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()

    // since 拉取报 Entry not found → 同一次 refresh 内丢 cursor 全量重新拉取
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since !== undefined) throw new Error('Entry not found: e1')
      return { data: { entries: [...subagentRecordEntry('sa-1', 'done', 'e5')], leafId: 'e5' } } as GetEntriesResult
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1')
    expect(client.getEntries).toHaveBeenCalledWith()
    // 自愈重建后的状态经发布可见（取最后一帧——第一轮全量已发过 running 帧）
    const subagentsMsgs = publish.mock.calls.filter(([, msg]) => (msg as { type: string }).type === 'session.subagents')
    expect((subagentsMsgs.at(-1)![1] as { payload: { subagents: Array<{ status: string }> } }).payload.subagents[0].status).toBe('idle') // [U6/D5] legacy done 归一 idle
  })

  it('其他 RPC 错误：不发布、cursor 保留（下次重试仍走增量）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [...subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    publish.mockClear()

    client.getEntries.mockRejectedValue(new Error('rpc timeout'))
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).not.toHaveBeenCalled()

    // 恢复后重试：仍带原 cursor（未被丢弃）
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1')
  })

  it('inflight 共享：拉取在途时的新失效复用同一 promise', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    let release!: (v: GetEntriesResult) => void
    client.getEntries.mockImplementation(async () => new Promise<GetEntriesResult>((resolve) => { release = resolve }))
    records.invalidateRecordEntries('s1', 'subagent-record')
    // 同步推进：防抖到期 → refresh 同步段启动（inflight 已设，getEntries 挂起）
    vi.advanceTimersByTime(SCALAR_STATE_DEBOUNCE_MS)
    // 拉取在途：新失效 → 新防抖 → 到期后 refresh 复用 inflight（不重复 RPC）
    records.invalidateRecordEntries('s1', 'subagent-record')
    vi.advanceTimersByTime(SCALAR_STATE_DEBOUNCE_MS)
    release({ data: { entries: [...subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(client.getEntries).toHaveBeenCalledTimes(1)
  })

  it('session 已销毁检查：hasSession false 时 merge 但不 publish', async () => {
    const { records, publish, client } = makeRecords({ hasSession: vi.fn(() => false) })
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [...subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).not.toHaveBeenCalled()
  })

  it('client 不存在（session 已死）：getClient 命中后 warn 显形，拉取冻结 no-op', async () => {
    const getClient = vi.fn(() => undefined)
    const { records, client } = makeRecords({ pm: { getClient } as unknown as IProcessManager })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    // 生产代码真实消费的是 getClient('s1') 的 undefined 返回——断言打在 deps spy 上
    expect(getClient).toHaveBeenCalledWith('s1')
    expect(client.getEntries).not.toHaveBeenCalled()
    // [pull-push W0] 断点显形：warn 落「refresh skipped: pi client unavailable」恢复语义文案
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('refresh skipped: pi client unavailable'))).toBe(true)
    warnSpy.mockRestore()
  })
})


describe('onSessionDisposed', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('清缓存并停防抖定时器（pending 防抖到期后不拉取）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    records.onSessionDisposed('s1')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
    // 缓存条目已删：后续失效 no-op
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
  })

  it('未注册 session 的 dispose 幂等 no-op', () => {
    const { records } = makeRecords()
    expect(() => records.onSessionDisposed('s-none')).not.toThrow()
  })
})

describe('[RT-4#9] invalidateRecordEntries 未知 customType 早退门 warn 显形', () => {
  it('非白名单 customType 早退 + warn（按类型去重一次），白名单不受影响', async () => {
    vi.useFakeTimers()
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 同一未知类型两次：warn 只落一次（去重）
      records.invalidateRecordEntries('s1', 'future-record-kind')
      records.invalidateRecordEntries('s1', 'future-record-kind')
      // 文案子串随 D5 放宽后的双形态指引更新（旧形态 "unknown customType ... dropped" 已退役）
      const warns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("non-record customType 'future-record-kind' reached the gate"))
      expect(warns).toHaveLength(1)

      // 白名单类型不受影响：正常调度防抖拉取
      records.invalidateRecordEntries('s1', 'subagent-record')
      await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
      expect(client.getEntries).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('磁盘读侧（scanSessions → extractor 真实执行）', () => {
  it('getSubagents：定位 session 文件后经 extractor 提取 record 列表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, jsonlLines(subagentRecordEntry('sa-1', 'running', 'e1')))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    const result = await records.getSubagents('s1')
    expect(result.records).toHaveLength(1)
    // [RT-4#8] oversize 标志随结果透传（正常路径 false）
    expect(result.oversize).toBe(false)
    expect(result.records[0]).toEqual(expect.objectContaining({ subagentId: 'sa-1', status: 'running' }))
  })

  it('getSubagents：session 不在扫描结果返回 []', async () => {
    const { records } = makeRecords()
    // [RT-4#8] 结构化返回（records + oversize）：无扫描命中 = 空列表且非 oversize
    expect(await records.getSubagents('s-none')).toEqual({ records: [], oversize: false, found: false })
  })

  it('getWorkflows：定位 session 文件后提取 workflow 列表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, jsonlLines(workflowRecordEntry('run-1', 'done', 'e1')))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    const result = await records.getWorkflows('s1')
    expect(result.records).toHaveLength(1)
    expect(result.oversize).toBe(false)
    expect(result.records[0]).toEqual(expect.objectContaining({ runId: 'run-1', status: 'done' }))
  })

  it('[RT-4#8] oversize（文件 >32MB 预检阈值）：records 恒空 + oversize=true 透传 + 每会话一次 warn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-oversize-'))
    const filePath = join(dir, 'huge-session.jsonl')
    // 稀疏文件：写一字节后 truncate 到超阈值——stat.size 超限触发 extractor 预检降级，
    // 磁盘实际占用极小（fixture 自建自删）
    writeFileSync(filePath, '\n')
    truncateSync(filePath, 33 * 1024 * 1024)
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's-big', filePath }]) } as unknown as ISessionStore,
    })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 反复拉取（面板 retry 场景）：oversize 分形稳定 + warn 每会话只落一次
      const first = await records.getSubagents('s-big')
      const second = await records.getWorkflows('s-big')
      await records.getSubagents('s-big')
      expect(first).toEqual({ records: [], oversize: true, found: true })
      expect(second).toEqual({ records: [], oversize: true, found: true })
      // 每会话 + 每类别一次（去重 key = sid:kind）：3 次调用 2 条 warn（subagents 一次 + workflows 一次）
      const dedupeWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('list unavailable'))
      expect(dedupeWarns).toHaveLength(2)
    } finally {
      warnSpy.mockRestore()
      // teardown 递归删除补 maxRetries/retryDelay：与在途异步写竞争时 ENOTEMPTY 瞬态失败可重试
      // （同文件 :962 范式；rm/rmSync 默认 maxRetries=0，一次瞬态失败即抛 → 满载 flake）
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  // ── [U2 路径解析单点直查 D5]：查询定位走登记表 + 单文件直查，稳态零扫描；miss 回退
  // 不静默 found=false；同路径换 id 防御。fixture 首行为真 session header（header 惰性读
  // 校验的对象）──
  //
  // [U2 验收条款③·header 惰性读成本实测记录] 2026-11-01，darwin arm64，Node v24：
  // 实测对象 = 未激活会话单文件直查的 header 校验读（resolveQuerySessionRef 一/二级的
  // parseSessionHeader 首行读）。fixture = 200 个 100KB 兄弟会话目录 + 目标文件三档
  // 尺寸（64KB / 8MB / 32MB，32MB = oversize 阈值），warmup 200 次、计时 1000 次取中位：
  //   64KB median 0.012ms（p95 0.017ms）；8MB 0.012ms（p95 0.015ms）；32MB 0.011ms（p95 0.015ms）
  // 结论：单次直查 ~10-17µs，与文件尺寸（首行读不触尾部）及目录会话数（只开目标一个
  // 文件）解耦；对照退役形态 readFileSync 全量读 32MB = median 9.413ms（约 800 倍）。
  // 复测方式：按本节 fixture 形态写临时 vitest 用例（parseSessionHeader 计时 +
  // readFileSync 对照），`cd packages/runtime && npx vitest run <该临时文件>`，跑完即删。
  // 对照 M1 resolveSessionContext 先例：M1 实体不在本基线（btw 域在途），按同形态自测记录。
  const U2_SESSION_HEADER: Record<string, unknown> = {
    type: 'session', id: 's1', cwd: '/tmp/proj', timestamp: '2026-11-01T00:00:00Z',
  }

  function writeU2SessionFile(filePath: string, entries: Array<Record<string, unknown>>): void {
    writeFileSync(filePath, jsonlLines([U2_SESSION_HEADER, ...entries]))
  }

  it('[U2 D5] 稳态查询零扫描（登记表 + 单文件直查）；文件移动后回退扫描重建定位，不静默 found=false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-u2-'))
    try {
      const filePathV1 = join(dir, '2026-11-01T00-00-00-000Z_s1.jsonl')
      writeU2SessionFile(filePathV1, subagentRecordEntry('sa-1', 'running', 'e1'))
      const scanSessions = vi.fn(() => [{ id: 's1', filePath: filePathV1, cwd: '/tmp/proj' }])
      const { records } = makeRecords({
        sessionStore: { scanSessions } as unknown as ISessionStore,
      })
      // 首查：三级直查全 miss（登记表空 + meta 缓存空）→ 回退 force 扫描命中 → 登记
      const first = await records.getSubagents('s1')
      expect(first.found).toBe(true)
      expect(first.records.map((r) => r.subagentId)).toEqual(['sa-1'])
      expect(scanSessions).toHaveBeenCalledTimes(1)
      // 稳态二查：登记表命中（header 校验读首行）→ 零扫描调用——查询成本与全目录会话数解耦
      const second = await records.getSubagents('s1')
      expect(second.found).toBe(true)
      expect(scanSessions).toHaveBeenCalledTimes(1)
      // 归档/移动形态：文件搬走（旧路径消失）→ 登记条目 header 校验失败 → 回退扫描
      // （侧栏扫描管线已同步新位置）重建定位——回退路径不静默返回 found=false
      const filePathV2 = join(dir, 'moved_s1.jsonl')
      renameSync(filePathV1, filePathV2)
      writeU2SessionFile(filePathV2, subagentRecordEntry('sa-1', 'running', 'e1'))
      scanSessions.mockReturnValue([{ id: 's1', filePath: filePathV2, cwd: '/tmp/proj' }])
      const third = await records.getSubagents('s1')
      expect(third.found).toBe(true)
      expect(third.records.map((r) => r.subagentId)).toEqual(['sa-1'])
      expect(scanSessions).toHaveBeenCalledTimes(2) // 回退确实扫了（非静默 miss）
      // 新登记后稳态复归零扫描
      await records.getSubagents('s1')
      expect(scanSessions).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('[U2 D5] 同路径换 id（外部整文件替换）：登记条目 header 校验失败 → 删条目回退扫描，不拿旧条目错答', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-u2-swap-'))
    try {
      const filePath = join(dir, 'session.jsonl')
      writeU2SessionFile(filePath, subagentRecordEntry('sa-1', 'running', 'e1'))
      const scanSessions = vi.fn(() => [{ id: 's1', filePath, cwd: '/tmp/proj' }])
      const { records } = makeRecords({
        sessionStore: { scanSessions } as unknown as ISessionStore,
      })
      await records.getSubagents('s1') // 首查登记（回退扫描）
      expect(scanSessions).toHaveBeenCalledTimes(1)
      // 外部替换：同路径文件换成另一 id 的会话（header.id = s-other）
      writeFileSync(filePath, jsonlLines([
        { type: 'session', id: 's-other', cwd: '/tmp/other', timestamp: '2026-11-01T00:00:00Z' },
        ...subagentRecordEntry('sa-9', 'running', 'e9'),
      ]))
      // 二查：登记条目 header 校验失败（id 不符）→ 删条目 → 回退扫描（mock 仍回 s1 meta）
      const result = await records.getSubagents('s1')
      expect(scanSessions).toHaveBeenCalledTimes(2) // 校验失败未静默吞掉，回退重扫
      expect(result.found).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('[U1 检查点·同 id 复活布防] 导入落地失效（invalidateProjectionAfterImport）：整文件替换后下轮查询全量重建，不漏读新文件头部', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-import-land-'))
    try {
      const filePath = join(dir, 'session.jsonl')
      // V1：原会话（header + sa-1 注册行）——首查建投影、游标登记到 V1 文件尾
      writeU2SessionFile(filePath, subagentRecordEntry('sa-1', 'running', 'e1'))
      const { records } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath, cwd: '/tmp/proj' }]) } as unknown as ISessionStore,
      })
      const first = await records.getSubagents('s1')
      expect(first.records.map((r) => r.subagentId)).toEqual(['sa-1'])
      // 外部删除 + 同 id 导入复活：同路径整文件替换（新文件 size ≥ 旧游标，头部为全新内容）
      writeU2SessionFile(filePath, [
        ...subagentRecordEntry('sa-2', 'running', 'e2'),
        ...subagentRecordEntry('sa-3', 'running', 'e3'),
      ])
      // 布防形态对照：不失效时 size/游标核对把新文件误判为增量，从旧游标续读漏掉 sa-2
      const unguarded = await records.getSubagents('s1')
      expect(unguarded.records.some((r) => r.subagentId === 'sa-2')).toBe(false)
      // 导入落地失效：派生缓存与游标按会话 id 失效（旧投影 dispose + 游标清零）
      records.invalidateProjectionAfterImport('s1')
      // 下轮查询走 buildProjection 首建全量重建——新文件头部 entry 全量可见（AX1 真值）
      const after = await records.getSubagents('s1')
      expect(after.found).toBe(true)
      expect(after.records.map((r) => r.subagentId).sort()).toEqual(['sa-2', 'sa-3'])
      // 无缓存条目的会话：no-op（缓存不存在即无失效对象，不抛错）
      expect(() => records.invalidateProjectionAfterImport('s-never-queried')).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('getSubagentHistory / getAgentCallFilePath：负路径检查', () => {
  beforeEach(() => { piAgentDirRef.dir = mkdtempSync(join(tmpdir(), 'session-records-piagent-')) })
  afterEach(() => { piAgentDirRef.dir = '' })

  it('record 不存在返回 []', async () => {
    const { records } = makeRecords()
    expect(await records.getSubagentHistory('s1', 'sa-none')).toEqual({ messages: [], truncated: false })
  })

  it('路径穿越检查：sessionFile 逃出 piAgentDir 的 record 历史返回 []', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    // sessionFile 在 v2 契约里归终态条目（注册条目身份域无该字段）——用终态形态承载逃逸路径
    writeFileSync(filePath, jsonlLines(subagentRecordEntry('sa-1', 'done', 'e1', { sessionFile: '/etc/passwd' })))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    // 前置断言：逃逸路径确实进了 record（防「sessionFile 未派生视图 → 空值假绿」）
    expect((await records.getSubagents('s1')).records[0]!.sessionFile).toBe('/etc/passwd')
    expect(await records.getSubagentHistory('s1', 'sa-1')).toEqual({ messages: [], truncated: false })
    expect(await records.getAgentCallFilePath('s1', 'sa-1')).toBe('')
  })

  it('getAgentCallFilePath：record 无 sessionFile 返回空串（UI 隐藏按钮契约）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, jsonlLines(subagentRecordEntry('sa-1', 'running', 'e1')))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    expect(await records.getAgentCallFilePath('s1', 'sa-1')).toBe('')
  })

  it('getAgentCallHistory：agent call 即 subagent，委托 getSubagentHistory 路径', async () => {
    const { records } = makeRecords()
    expect(await records.getAgentCallHistory('s1', 'sa-none')).toEqual({ messages: [], truncated: false })
  })
})

describe('getSubagentHistory / getAgentCallFilePath：新布局守卫（A9 修复）', () => {
  beforeEach(() => { piAgentDirRef.dir = mkdtempSync(join(tmpdir(), 'session-records-exttree-')) })
  afterEach(() => {
    rmSync(piAgentDirRef.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    piAgentDirRef.dir = ''
  })

  /** 主 session fixture（终态条目承载 sessionFile，与既有逃逸用例同形态）。 */
  function recordsWithSessionFile(sessionFile: string) {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, jsonlLines(subagentRecordEntry('sa-1', 'done', 'e1', { sessionFile })))
    return {
      records: makeRecords({
        // convertHistory 透传 stub：getHistoryFromFilePath 转换链尾段 port（TC2 契约，
        // session-history.test.ts 同款 stub 形态）
        sessionStore: {
          scanSessions: vi.fn(() => [{ id: 's1', filePath }]),
          convertHistory: (messages: unknown[]) => messages,
        } as unknown as ISessionStore,
      }).records,
      cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
    }
  }

  it('新布局路径过守卫：ext-sessions 会话树内的 subagent JSONL 返回真实历史', async () => {
    // [session-store-layout-inversion] 新布局：subagent 会话 jsonl =
    // <dataDir>/ext-sessions/<rootSid>/subagents/sessions/*.jsonl——修复前守卫锚旧
    // <dataDir>/agent/ 布局恒拒（执行记录结构性恒空），修复后放行并真实读取。
    const subFile = join(piAgentDirRef.dir, 'ext-sessions', 's1', 'subagents', 'sessions', 'sa-1.jsonl')
    mkdirSync(dirname(subFile), { recursive: true })
    writeFileSync(subFile, [
      JSON.stringify({ type: 'message', id: 'm0', message: { role: 'user', content: '子代理任务输入' } }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'assistant', content: [{ type: 'text', text: '子代理执行输出' }] } }),
    ].join('\n') + '\n')
    const { records, cleanup } = recordsWithSessionFile(subFile)
    try {
      // 前置断言：sessionFile 确实进了 record（防「未派生视图 → 空值假绿」）
      expect((await records.getSubagents('s1')).records[0]!.sessionFile).toBe(subFile)
      const history = await records.getSubagentHistory('s1', 'sa-1')
      expect(history.messages.length).toBeGreaterThan(0)
      expect(history.truncated).toBe(false)
      expect(await records.getAgentCallFilePath('s1', 'sa-1')).toBe(subFile)
    } finally {
      cleanup()
    }
  })

  it('树外路径仍被拒：dataDir 内但 ext-sessions 树外不读（穿越防线不随锚迁移放松）', async () => {
    // dataDir 内、session 存储树外（旧布局落点 <dataDir>/agent/ 形态）：守卫锚迁到
    // ext-sessions 树根后仍必须拒——防锚迁移放大读面（数据根下任意文件不可借道读出）
    const outside = join(piAgentDirRef.dir, 'agent', 'sessions', 'evil.jsonl')
    mkdirSync(dirname(outside), { recursive: true })
    writeFileSync(outside, JSON.stringify({ type: 'message', id: 'm0', message: { role: 'user', content: 'secret' } }) + '\n')
    const { records, cleanup } = recordsWithSessionFile(outside)
    try {
      expect((await records.getSubagents('s1')).records[0]!.sessionFile).toBe(outside)
      expect(await records.getSubagentHistory('s1', 'sa-1')).toEqual({ messages: [], truncated: false })
      expect(await records.getAgentCallFilePath('s1', 'sa-1')).toBe('')
    } finally {
      cleanup()
    }
  })
})

describe('workflowAction / subagentAction：命令转发', () => {
  it('workflowAction 转发 /workflows <action> <runId> 到活跃 client', async () => {
    const { records, client } = makeRecords()
    await records.workflowAction('s1', 'abort', 'run-1')
    expect(client.prompt).toHaveBeenCalledWith('/workflows abort run-1')
  })

  it('workflowAction：session 不活跃 throw', async () => {
    const { records } = makeRecords({ pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager })
    await expect(records.workflowAction('s1', 'abort', 'run-1')).rejects.toThrow('Session s1 not active')
  })

  it('subagentAction cancel 转发 /subagents cancel <subagentId> --req=<uuid> 并消费回执（结果回执契约 2026-10-18）', async () => {
    const channel = armReceiptChannel()
    const { records, client } = makeRecords({ getSessionCwd: () => channel.cwd })
    ;(client.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      writeOkReceiptFromCommand('s1', channel.agentDir, text)
    })
    try {
      await records.subagentAction('s1', 'cancel', { subagentId: 'sa-1' })
      // --req=<uuid> 请求作用域参数（uuid 段锚形态不锚值，randomUUID 运行期生成）
      expect(client.prompt).toHaveBeenCalledWith(
        expect.stringMatching(/^\/subagents cancel sa-1 --req=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      )
      // 读后即删（请求作用域生命周期）：回执消费后目录不残留
      expect(readdirSync(getSubagentMessageResultsDir('s1', channel.agentDir))).toEqual([])
    } finally {
      channel.dispose()
    }
  })

  it('subagentAction message：--req=<uuid> 之后 text 经 encodeDirectiveText 编码保持命令单行', async () => {
    const channel = armReceiptChannel()
    const { records, client } = makeRecords({ getSessionCwd: () => channel.cwd })
    ;(client.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      writeOkReceiptFromCommand('s1', channel.agentDir, text)
    })
    try {
      await records.subagentAction('s1', 'message', { subagentId: 'sa-1', text: 'line1\nline2\\end' })
      const sent = (client.prompt as unknown as { mock: { calls: string[][] } }).mock.calls[0][0] as string
      const parsed = /^\/subagents message sa-1 --req=([\w-]+) (.*)$/.exec(sent)
      // --req=<uuid> 夹在 recordId 与 text 之间；uuid 锚形态，text 锚 encode 产物
      expect(parsed).not.toBeNull()
      expect(parsed![1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(parsed![2]).toBe(encodeDirectiveText('line1\nline2\\end'))
      expect(sent.includes('\n')).toBe(false)
    } finally {
      channel.dispose()
    }
  })

  it('subagentAction start 转发 /subagents start <slug> <task>', async () => {
    const { records, client } = makeRecords()
    await records.subagentAction('s1', 'start', { slug: 'worker', task: 'Do work' })
    expect(client.prompt).toHaveBeenCalledWith('/subagents start worker Do work')
  })

  it.each([
    ['cancel 缺 subagentId', 'cancel', {} as Record<string, string>, 'subagentId is required'],
    ['message 缺 text', 'message', { subagentId: 'sa-1' }, 'subagentId and text are required'],
    ['start 缺 slug', 'start', { task: 't' }, 'slug and task are required'],
  ])('协议错误 fail-fast：%s', async (_label, action, params, expected) => {
    const { records } = makeRecords()
    await expect(records.subagentAction('s1', action as 'cancel', params)).rejects.toThrow(expected)
  })

  it('subagentAction：session 不活跃 throw', async () => {
    const { records } = makeRecords({ pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager })
    await expect(records.subagentAction('s1', 'cancel', { subagentId: 'sa-1' })).rejects.toThrow('Session s1 not active')
  })
})

describe('引擎配置（getPiAgentDir 重定向临时目录，锁与原子写真实执行）', () => {
  beforeEach(() => {
    piAgentDirRef.dir = mkdtempSync(join(tmpdir(), 'session-records-engines-'))
    mkdirSync(join(piAgentDirRef.dir, 'subagents'), { recursive: true })
  })
  afterEach(() => { piAgentDirRef.dir = '' })

  it('engines.json + config.json 读取：返回动态清单与默认引擎', async () => {
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'engines.json'), JSON.stringify({ engines: ['pi', 'codex'] }))
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'config.json'), JSON.stringify({ defaultEngine: 'codex' }))
    const { records } = makeRecords()
    // u7 扩展（engine-provider-unification D5）：reply 恒带 engineModels（zcode 键 =
    // deriveZcodeEngineModels 双源派生，测试环境读宿主真实 ~/.zcode——不锚内容只锚形态）
    // 与 engineDefaults（config.json absent → {}）
    const view = await records.getSubagentEngineConfig()
    expect(view).toEqual(expect.objectContaining({ engines: ['pi', 'codex'], defaultEngine: 'codex', engineDefaults: {} }))
    expect(Array.isArray(view.engineModels?.zcode)).toBe(true)
  })

  it('[W4] engines.json 缺失：runtime 自身发现回退（回退源单源化，静态 JSON 兜底已删）', async () => {
    const discoverEngines = vi.fn(() => ['zcode', 'custom'])
    const { records } = makeRecords({ discoverEngines })
    const view2 = await records.getSubagentEngineConfig()
    expect(view2).toEqual(expect.objectContaining({ engines: ['zcode', 'custom'], defaultEngine: 'pi', engineDefaults: {} }))
    expect(Array.isArray(view2.engineModels?.zcode)).toBe(true)
    expect(discoverEngines).toHaveBeenCalledOnce()
  })

  it('[W4] 发现零命中/失败：空清单（不再 [pi] 兜底——静态声明列出的 id 无 bin 可执行）', async () => {
    const zero = makeRecords({ discoverEngines: vi.fn(() => []) })
    expect(await zero.records.getSubagentEngineConfig()).toEqual(expect.objectContaining({ engines: [], defaultEngine: 'pi', engineDefaults: {} }))
    const failed = makeRecords({ discoverEngines: vi.fn(() => { throw new Error('discovery down') }) })
    expect(await failed.records.getSubagentEngineConfig()).toEqual(expect.objectContaining({ engines: [], defaultEngine: 'pi', engineDefaults: {} }))
  })

  it('setSubagentDefaultEngine：未知引擎 throw（GUI 端防呆）', async () => {
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'engines.json'), JSON.stringify({ engines: ['pi'] }))
    const { records } = makeRecords()
    await expect(records.setSubagentDefaultEngine('unknown-engine')).rejects.toThrow("unknown subagent engine 'unknown-engine'")
  })

  it('setSubagentDefaultEngine：清单内引擎写入 config.json 且保留其他字段', async () => {
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'engines.json'), JSON.stringify({ engines: ['pi', 'codex'] }))
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'config.json'), JSON.stringify({ defaultEngine: 'pi', other: 'kept' }))
    const { records } = makeRecords()
    await records.setSubagentDefaultEngine('codex')
    const written = JSON.parse(readFileSync(join(piAgentDirRef.dir, 'subagents', 'config.json'), 'utf8')) as Record<string, unknown>
    expect(written.defaultEngine).toBe('codex')
    expect(written.other).toBe('kept')
  })
})

// ─── A2（adversarial-review-fixes MF-B）：subagentAction 定向文本挂注入 ───
//
// 锁定三件事：① message/start 分支在 encodeDirectiveText 之前经 injector.inject
// （标记在原始文本上匹配）；② notice 在 client.prompt 成功之后发布（时机契约
// 与 dispatcher 同款）；③ cancel / workflows 内部命令不经注入器。

describe('subagentAction：skill 注入挂载（A2 MF-B）', () => {
  /** spy 注入器：记录调用文本，返回可辨识的改写产物 + 可编程 notices。 */
  function makeSpyInjector(result?: Partial<SkillInjectionResult>): {
    injector: SkillInjector
    inject: ReturnType<typeof vi.fn>
  } {
    const inject = vi.fn(async (_client: unknown, text: string): Promise<SkillInjectionResult> => ({
      text: `<<injected:${text}>>`,
      notices: [],
      ...result,
    }))
    return { injector: { inject } as unknown as SkillInjector, inject }
  }

  it('message：encode 之前注入原始 text，prompt 收到 encode(注入产物)，notice 在 prompt 之后', async () => {
    const notices = [{ reason: 'skill_missing' as const, skills: ['ghost'] }]
    const { injector, inject } = makeSpyInjector({ notices })
    const channel = armReceiptChannel()
    const { records, publish, client } = makeRecords({ getSessionCwd: () => channel.cwd }, injector)
    const calls: string[] = []
    ;(client.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      calls.push(`prompt:${text}`)
      writeOkReceiptFromCommand('s1', channel.agentDir, text)
    })
    publish.mockImplementation((sid: string, msg: { type: string }) => {
      calls.push(`publish:${msg.type}`)
    })

    try {
      await records.subagentAction('s1', 'message', { subagentId: 'sa-1', text: '原始文本' })

      // ① 注入收到原始 text（encode 之前）
      expect(inject).toHaveBeenCalledTimes(1)
      expect(inject.mock.calls[0][1]).toBe('原始文本')
      // ② prompt 收到 encode(注入产物)；--req=<uuid> 请求作用域参数（结果回执契约 2026-10-18）
      const promptText = calls[0]!.slice('prompt:'.length)
      const parsed = /^\/subagents message sa-1 --req=([\w-]+) (.*)$/.exec(promptText)
      expect(parsed).not.toBeNull()
      expect(parsed![1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(parsed![2]).toBe(encodeDirectiveText('<<injected:原始文本>>'))
      // ③ 顺序：prompt 先于 notice（发送成功后才发布）
      expect(calls).toHaveLength(2)
      expect(calls[0]).toBe(`prompt:/subagents message sa-1 --req=${parsed![1]} ${encodeDirectiveText('<<injected:原始文本>>')}`)
      expect(calls[1]).toBe('publish:session.skillNotice')
      const noticeMsg = publish.mock.calls.find(([, msg]) => (msg as { type: string }).type === 'session.skillNotice')
      expect(noticeMsg).toBeDefined()
      expect(noticeMsg![0]).toBe('s1')
      expect((noticeMsg![1] as { payload: { reason: string; skills: string[] } }).payload)
        .toEqual({ sessionId: 's1', reason: 'skill_missing', skills: ['ghost'] })
    } finally {
      channel.dispose()
    }
  })

  it('start：task 同款注入（encode 之前）+ notice', async () => {
    const { injector, inject } = makeSpyInjector()
    const { records, client } = makeRecords({}, injector)
    await records.subagentAction('s1', 'start', { slug: 'worker', task: '干点活' })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0][1]).toBe('干点活')
    expect(client.prompt).toHaveBeenCalledWith(`/subagents start worker ${encodeDirectiveText('<<injected:干点活>>')}`)
  })

  it('prompt 失败：notice 不发布（发送成功后时机契约的否定用例）', async () => {
    const { injector } = makeSpyInjector({ notices: [{ reason: 'skill_missing', skills: ['ghost'] }] })
    const { records, publish, client } = makeRecords({}, injector)
    ;(client.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pi reject'))
    await expect(records.subagentAction('s1', 'message', { subagentId: 'sa-1', text: 't' })).rejects.toThrow('pi reject')
    expect(publish).not.toHaveBeenCalled()
  })

  it('notices 为空：不发布任何 bus 消息（no-op 零噪音）', async () => {
    const { injector } = makeSpyInjector()
    const channel = armReceiptChannel()
    const { records, publish, client } = makeRecords({ getSessionCwd: () => channel.cwd }, injector)
    ;(client.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      writeOkReceiptFromCommand('s1', channel.agentDir, text)
    })
    try {
      await records.subagentAction('s1', 'message', { subagentId: 'sa-1', text: 't' })
      expect(publish).not.toHaveBeenCalled()
    } finally {
      channel.dispose()
    }
  })

  it('cancel 与 workflows：不经注入器（内部命令显式跳过）', async () => {
    const { injector, inject } = makeSpyInjector()
    const channel = armReceiptChannel()
    const { records, client } = makeRecords({ getSessionCwd: () => channel.cwd }, injector)
    ;(client.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      writeOkReceiptFromCommand('s1', channel.agentDir, text)
    })
    try {
      await records.subagentAction('s1', 'cancel', { subagentId: 'sa-1' })
      await records.workflowAction('s1', 'abort', 'run-1')
      expect(inject).not.toHaveBeenCalled()
    } finally {
      channel.dispose()
    }
  })

  it('真注入器 + 纯文本：no-op 原文通过（mock client 无 getCommands 也不发起 RPC）', async () => {
    // 无标记文本在 parseSkillMarkers 短路返回前不触碰任何 client 方法——
    // mock client 只有 getEntries/prompt 两方法，注入若发起 RPC 即 TypeError 翻红
    const channel = armReceiptChannel()
    const { records, client } = makeRecords({ getSessionCwd: () => channel.cwd })
    ;(client.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      writeOkReceiptFromCommand('s1', channel.agentDir, text)
    })
    try {
      await records.subagentAction('s1', 'message', { subagentId: 'sa-1', text: '纯文本' })
      // --req=<uuid> 之后的 text 为原文（no-op 注入不改写）
      expect(client.prompt).toHaveBeenCalledWith(
        expect.stringMatching(/^\/subagents message sa-1 --req=[\w-]+ 纯文本$/),
      )
    } finally {
      channel.dispose()
    }
  })
})

// ── plan-state 派生视图（plan 模式重设计 D1③④）─────────────────────────────

/** plan-state entry fixture（data 平铺四必填 + 三 optional，无 v 字段——D4 否决版本轴）。 */
function planStateEntry(data: Record<string, unknown>, entryId: string): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'plan-state',
    id: entryId,
    parentId: null,
    timestamp: '2026-09-18T00:00:00Z',
    data,
  }
}

/** 新七字段形态（扩展三 optional 齐全）。 */
function fullPlanData(reviewState: 'awaiting' | 'revising'): Record<string, unknown> {
  return {
    isActive: true,
    planFilePath: '/tmp/taiji-plan/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'tech-design',
    skills: ['tech-design', 'dev-flow'],
    docs: [{ fileName: 'design.md', absPath: '/tmp/taiji-plan/auth/design.md', sourceSkill: 'tech-design', version: 1 }],
    reviewState,
  }
}

describe('plan-state 派生视图（D1③④）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('第二道门扩容：plan-state 不被早退（失效 → 防抖拉取真发生）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledTimes(1)
  })

  it('派生 publish：payload = { sessionId, planState }（与 shared 协议对齐，docs/skills 透传）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    const planMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')
    expect(planMsgs).toHaveLength(1)
    expect(planMsgs[0]![0]).toBe('s1')
    const payload = (planMsgs[0]![1] as { payload: { sessionId: string; planState: Record<string, unknown> } }).payload
    expect(payload.sessionId).toBe('s1')
    expect(payload.planState).toEqual(expect.objectContaining({
      isActive: true,
      skills: ['tech-design', 'dev-flow'],
      state: 'reviewing',
      docs: [expect.objectContaining({ fileName: 'design.md', version: 1 })],
    }))
    // D2 归一：旧字段不透出（entry reviewState:'awaiting' 归一为 state:'reviewing'）
    expect(payload.planState).not.toHaveProperty('reviewState')
    expect(payload.planState).not.toHaveProperty('reviewStateSource')
  })

  it('无 plan entry 不 publish（派生 null 且基线 null = 无变化，GUI 缺省即未激活）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [{ type: 'message', id: 'm1' }], leafId: 'm1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(0)
  })

  it('同值重复 entry 不重复 publish（planStateEquals diff 基线）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)

    // 增量窗口返回同值新 entry（仅 entryId 变，快照未变）——不发布
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e9')], leafId: 'e9' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)
  })

  it('内容变化才 publish：reviewState 翻转 / docs version bump 各触发一次', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    // revise：entry reviewState awaiting → revising（第二帧；D2 归一后派生 state reviewing → revising）
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('revising'), 'e2')], leafId: 'e2' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    // 修订完成重登记：version bump（第三帧）
    const bumped = fullPlanData('awaiting')
    bumped.docs = [{ fileName: 'design.md', absPath: '/tmp/taiji-plan/auth/design.md', sourceSkill: 'tech-design', version: 2 }]
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(bumped, 'e3')], leafId: 'e3' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    const planMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')
    expect(planMsgs).toHaveLength(3)
    expect((planMsgs[1]![1] as { payload: { planState: { state: string } } }).payload.planState.state).toBe('revising')
    expect((planMsgs[2]![1] as { payload: { planState: { docs: Array<{ version: number }> } } }).payload.planState.docs[0]!.version).toBe(2)
  })

  // §3.4 四触点第 3 层（发布水位）：仅 reviewStateSource 变化（D2 归一为 resumeHint，
  // 其余比对维度全等）必须 publish——漏比对会把 resumeHint 变化判「无变化」而抑制
  // session.planState 广播，renderer live 更新唯一通道是 WS 帧，帧被抑制即恒渲染旧降级
  // 文案（第 3 轮审查 P1）。
  it('仅 reviewStateSource→resumeHint 归一维度变化（其余维度全等）→ 恰好 publish 一帧 session.planState', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    // 首次拉取基线：awaiting 且无 source（旧 entry 形态，undefined 缺省）
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)

    // 同值新 entry 仅追加 reviewStateSource（resubmit 分支落盘后的重放形态；'explain'
    // 存量值在 extractor 归无值，白名单只认 'resubmit'——plan-state-extractor 裁决）
    const sourced = { ...fullPlanData('awaiting'), reviewStateSource: 'resubmit' }
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(sourced, 'e2')], leafId: 'e2' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    const planMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')
    expect(planMsgs).toHaveLength(2)
    expect((planMsgs[1]![1] as { payload: { planState: { resumeHint?: string } } }).payload.planState.resumeHint).toBe('resubmit')
  })

  it('reset entry：isActive=false 且 docs 保留仍 publish（产物 tab 回看驱动，与 isActive 解耦）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    const resetData = {
      isActive: false,
      planFilePath: '/tmp/taiji-plan/auth/plan.md',
      requirement: '',
      templateName: '',
      docs: [{ fileName: 'design.md', absPath: '/tmp/taiji-plan/auth/design.md', sourceSkill: 'tech-design', version: 1 }],
    }
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(resetData, 'e2')], leafId: 'e2' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    const planMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')
    expect(planMsgs).toHaveLength(2)
    const last = (planMsgs[1]![1] as { payload: { planState: Record<string, unknown> } }).payload.planState
    expect(last.isActive).toBe(false)
    expect(last.docs).toEqual([expect.objectContaining({ fileName: 'design.md' })])
  })

  // ── [U5 plan 冷路径归一 D6] 冷路径读侧换源：getPlanState 与 getSubagents/getWorkflows
  // 同一统一续读链（直查定位 → oversize 分流 → ensureProjection size/游标核对与续读），
  // plan 派生读 cache.planState（与 live planState 同一数据源、同一派生落点 mergePlanState），
  // 独立全文解析（extractPlanStateFromSessionFile）退役。验收对照：V7（冷启动 ≡ live）/
  // 无全文件 readFileSync / oversize 降级形态保持；RL7 = 冷热对拍断言（A7 行承接）。──

  it('[U5 D6] 冷路径 getPlanState：走统一续读链派生（与 getSubagents/getWorkflows 同一读路径）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-plan-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, [
      JSON.stringify({ type: 'message', id: 'm1' }),
      JSON.stringify(planStateEntry(fullPlanData('awaiting'), 'e1')),
    ].join('\n'))
    try {
      const { records } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
      })
      const view = await records.getPlanState('s1')
      expect(view.isActive).toBe(true)
      expect(view.state).toBe('reviewing')
      expect('reviewState' in view).toBe(false)
      expect(view.docs).toEqual([expect.objectContaining({ fileName: 'design.md', version: 1 })])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('[RL7 / U5 D6] 冷热对拍：冷启动 getPlanState 与激活会话后 cache.planState 派生结果一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-rl7-'))
    const filePath = join(dir, 'session.jsonl')
    // 磁盘腿与 live 腿同值 entry 集（plan entry + record 族混入——多族产出共存的续读链）
    const diskPlanEntry = planStateEntry(fullPlanData('awaiting'), 'e1')
    writeFileSync(filePath, [
      JSON.stringify({ type: 'message', id: 'm1' }),
      JSON.stringify(diskPlanEntry),
      ...subagentRecordEntry('sa-1', 'running', 'e2').map((e) => JSON.stringify(e)),
    ].join('\n') + '\n')
    try {
      const { records, client } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath, cwd: '/tmp/proj' }]) } as unknown as ISessionStore,
      })
      // 冷启动腿：无 live 数据——续读链首建扫描 + plan 派生（mergePlanState 全量语义）
      const cold = await records.getPlanState('s1')
      // live 腿：激活会话 → get_entries 全量轮返回同值 entry 集 → 同一派生函数落 cache.planState
      const fire = registerSession(records)
      client.getEntries.mockResolvedValue({
        data: { entries: [structuredClone(diskPlanEntry)], leafId: 'e1' },
      })
      fire('s1')
      records.invalidateRecordEntries('s1', 'plan-state')
      await flushDebounce()
      const cache = planStateCacheOf(records, 's1')
      expect(cache?.planState).not.toBeNull()
      expect(cold).toEqual(cache?.planState)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('[U5 D6] 冷启动后续读增量推进：追加 plan entry 后再次查询返回新值（同一游标链，非二次冷读）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-plan-incr-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, [
      JSON.stringify({ type: 'message', id: 'm1' }),
      JSON.stringify(planStateEntry(fullPlanData('awaiting'), 'e1')),
    ].join('\n') + '\n')
    try {
      const { records } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
      })
      const first = await records.getPlanState('s1')
      expect(first.state).toBe('reviewing')
      // 跨实例追加（dc801b73d 陈旧缺陷回归形态的 plan 版）：磁盘新事实经下次查询续读可见
      const resetEntry = planStateEntry({
        isActive: false,
        planFilePath: '/tmp/taiji-plan/auth/plan.md',
        requirement: '',
        templateName: '',
      }, 'e2')
      appendFileSync(filePath, JSON.stringify(resetEntry) + '\n')
      const second = await records.getPlanState('s1')
      expect(second.isActive).toBe(false)
      // reset entry（isActive:false）无 state 字段 → readLifecycleState 按 isActive 映射 'idle'
      expect(second.state).toBe('idle')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('[U5 D6 / V7] 冷启动查询无全文件 readFileSync（全文解析退役，读侧 = 流式扫描 + 字节原语）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-plan-nofull-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, [
      JSON.stringify({ type: 'message', id: 'm1' }),
      JSON.stringify(planStateEntry(fullPlanData('awaiting'), 'e1')),
    ].join('\n') + '\n')
    try {
      const { records } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
      })
      const readSpy = vi.spyOn(nodeFs, 'readFileSync')
      try {
        // 两次查询：首建（冷扫描）+ 稳态核对（零重算）——全程无 readFileSync 触达
        await records.getPlanState('s1')
        await records.getPlanState('s1')
        expect(readSpy).not.toHaveBeenCalled()
      } finally {
        readSpy.mockRestore()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('[U5 D6 / V7③] oversize（文件 >32MB 预检阈值）：plan 降级未激活缺省 View + 每会话一次 warn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-plan-oversize-'))
    const filePath = join(dir, 'huge-session.jsonl')
    // 稀疏文件：写一字节后 truncate 到超阈值——stat.size 超限触发降级，磁盘实际占用极小
    writeFileSync(filePath, '\n')
    truncateSync(filePath, 33 * 1024 * 1024)
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's-big', filePath }]) } as unknown as ISessionStore,
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const expected = { isActive: false, planFilePath: null, requirement: null, templateName: null }
      expect(await records.getPlanState('s-big')).toEqual(expected)
      // 面板 retry 场景：分形稳定 + warn 每会话只落一次（plan 分形文案）
      expect(await records.getPlanState('s-big')).toEqual(expected)
      const planWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('plan state unavailable'))
      expect(planWarns).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('[U5 D6] 冷路径 getPlanState：session 不在扫描结果返回未激活缺省 View（RPC reply 无 null 域）', async () => {
    const { records } = makeRecords()
    const view = await records.getPlanState('s-none')
    expect(view).toEqual({
      isActive: false,
      planFilePath: null,
      requirement: null,
      templateName: null,
    })
  })

  // [MF-1 回归] JSONL append-only 下 entry 不会消失，增量批（cursor delta）的
  // 「无 plan-state entry」= 本批无 plan 新信息，非「entry 被清空」——误判会把活跃 plan
  // 的 GUI（PlanModeBar/产物面板）被无关 subagent/workflow record 增量重新拉取静默打回未激活。
  it('增量批无 plan-state entry：保持基线不 publish（非全量路径收敛语义不适用）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    // 首次拉取（全量）：发布 awaiting 基线
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)

    // 增量 delta 只含 subagent-record（plan 实际仍活跃）——不 publish
    client.getEntries.mockClear()
    client.getEntries.mockResolvedValue({
      data: { entries: [...subagentRecordEntry('sa-1', 'running', 'e2')], leafId: 'e2' },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1') // 确认走的是增量路径（非全量重建）
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)

    // 第三拉：同值 plan entry 重现——若基线曾被误清为 null，此处会多 publish 一次；
    // 恰 1 帧 = 基线保持（planStateEquals diff 基线未被增量批破坏的间接证伪）
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e3')], leafId: 'e3' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')).toHaveLength(1)
  })

  it('全量重建 entry 消失：恰发布一次 session.planState 且为未激活缺省 View（收敛语义收归全量路径）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    // 首次拉取（全量）：发布 awaiting 基线
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    // 游标失效自愈（session 文件被外部改写）：丢 cursor 全量重新拉取，全集中 plan-state entry 已消失
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since !== undefined) throw new Error('Entry not found: e1')
      return { data: { entries: [...subagentRecordEntry('sa-1', 'done', 'e2')], leafId: 'e2' } } as GetEntriesResult
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1') // 第 1 轮增量（Entry not found）
    expect(client.getEntries).toHaveBeenCalledWith() // 第 2 轮丢 cursor 全量重建

    const planMsgs = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')
    expect(planMsgs).toHaveLength(2) // awaiting 基线帧 + 收敛帧，恰一次收敛
    expect((planMsgs[1]![1] as { payload: { planState: Record<string, unknown> } }).payload.planState)
      .toEqual({ isActive: false, planFilePath: null, requirement: null, templateName: null })
  })
})

// ── [W1 / D6] 事件派生视图读侧换源 ────────────────────────────
//
// 验收对照：① 磁盘 v2 会话 entry-only 降级读派生视图（无 事件源时 getSubagents/
// getWorkflows 经派生视图直接读 v2 注册/终态条目）；② v2 会话读派生视图（事件源胜出仲裁
// + 条目摘要合并 + fold 供步骤骨架）；③ 全文读路径不调用断言（正常体量走派生视图，
// oversize 分流才触达兼容路径）；④ 派生视图驱动信号（事件流 事件 → tail 复查 → 派生视图
// 变更 → publish）。

/** v2 subagent-record 注册条目 entry（W1 D1 契约）。 */
function subagentRegisteredV2(id: string): Record<string, unknown> {
  return {
    type: 'custom', customType: 'subagent-record', id: 'e-r1', parentId: null,
    timestamp: '2026-09-26T00:00:00Z',
    data: {
      v: 2, kind: 'registered', id, agent: 'worker', task: 'Do work', slug: 'work',
      origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1',
      depth: 0, startedAt: 1000,
    },
  }
}

/** v2 subagent-record 终态条目 entry（载荷与 事件流 冲突——断言 事件源胜出）。 */
function subagentSettledV2(id: string): Record<string, unknown> {
  return {
    type: 'custom', customType: 'subagent-record', id: 'e-s1', parentId: null,
    timestamp: '2026-09-26T00:00:01Z',
    data: {
      v: 2, kind: 'settled', id, status: 'idle', stopReason: 'interrupted',
      endedAt: 3000, turns: 9, totalTokens: 999, model: 'p/m', thinkingLevel: 'low',
      result: 'full result text',
    },
  }
}

/** v2 workflow-record 注册条目 entry。 */
function workflowRegisteredV2(runId: string, recordPath: string): Record<string, unknown> {
  return {
    type: 'custom', customType: 'workflow-record', id: 'e-w1', parentId: null,
    timestamp: '2026-09-26T00:00:00Z',
    data: {
      v: 2, kind: 'registered', runId, workflowName: 'test-flow', scriptName: 'test-flow',
      slug: 'tf', startedAt: 1000, recordPath,
    },
  }
}

/** v2 会话世界 fixture：agentDir（records 目录）+ 会话文件（v2 条目）+ run journal 目录。 */
function makeV2World(cwd: string): {
  worldDir: string
  agentDir: string
  sessionFile: string
  recordsDir: string
  runJournalDir: string
} {
  const worldDir = mkdtempSync(join(tmpdir(), 'session-records-w1-'))
  const agentDir = join(worldDir, 'agent')
  const sessionFile = join(worldDir, 's1.jsonl')
  // [session-store-layout-inversion D2] records 目录 = getSubagentRecordsDir(sessionId)
  // （rootSessionId 树内分区，分区键即会话 id s1；dataDir = worldDir 与 mock getConfigDir 对齐）
  const recordsDir = getSubagentRecordsDir('s1', worldDir)
  const runJournalDir = resolvePiWorkflowRunsDir('s1', worldDir)
  mkdirSync(recordsDir, { recursive: true })
  mkdirSync(runJournalDir, { recursive: true })
  return { worldDir, agentDir, sessionFile, recordsDir, runJournalDir }
}

describe('[W1] 读侧换源：磁盘 entry-only 派生视图 / v2 读派生视图 / 全文路径不调用 / 派生视图驱动信号', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    extractSubagentsMock.mockClear()
    extractWorkflowsMock.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    piAgentDirRef.dir = ''
  })

  it('磁盘 v2 会话 entry-only 降级：无 事件流 时 getSubagents/getWorkflows 经派生视图读 v2 条目', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-v2disk-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, jsonlLines([
      ...subagentRecordEntry('sa-1', 'running', 'e1', { origin: 'workflow', parentRunId: 'run-1', stepIndex: 0 }),
      ...workflowRecordEntry('run-1', 'running', 'e2'),
    ]))
    try {
      const { records } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath, cwd: '/tmp/proj' }]) } as unknown as ISessionStore,
      })
      const subagents = await records.getSubagents('s1')
      const workflows = await records.getWorkflows('s1')
      expect(subagents.records).toHaveLength(1)
      expect(subagents.records[0]).toMatchObject({
        subagentId: 'sa-1',
        status: 'running',
        origin: 'workflow',
        parentRunId: 'run-1',
        stepIndex: 0,
      })
      expect(workflows.records).toHaveLength(1)
      expect(workflows.records[0]).toMatchObject({ runId: 'run-1', status: 'running', scriptName: 'test-flow' })
      // [W1 / D6] 步骤视图换源：v2 条目不内嵌 trace；无 run journal fold 时步骤行由
      // subagent record overlay（[W0 / D1] parentRunId + stepIndex 合并）合成——
      // 原「v1 快照 trace → agentCalls」断言随兼容层删除，fold 供骨架的覆盖范围由
      // 本 describe 后续 事件流 用例承担。
      expect(workflows.records[0]!.agentCalls[0]).toMatchObject({ id: 0, agent: 'worker', status: 'running', sessionId: 'sa-1' })
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('读侧定档：面板只显示当前会话树内 record（rootSessionId 树内分区，验收③）', async () => {
    // [session-store-layout-inversion D2] records 目录 = <root>/<sid>/subagents/records：
    // 会话 A 的面板只冷读 A 自己的树；B 树的 record（即使 rootSessionId 错标 A）也不可见。
    const cwd = '/tmp/w1-proj'
    const worldA = makeV2World(cwd)
    piAgentDirRef.dir = worldA.worldDir
    try {
      // A 树：sa-mine（归属 A）
      writeFileSync(join(worldA.recordsDir, 'sa-mine.events'), [
        JSON.stringify({ type: 'record-events', id: 'sa-mine' }),
        JSON.stringify({ type: 'record-created', seq: 1, ts: 1000, id: 'sa-mine', agent: 'worker', task: 'mine', slug: 'm', origin: 'tool', rootSessionId: 's1', depth: 0, mode: 'bg', startedAt: 1000 }),
      ].join('\n') + '\n')
      // B 树：sa-other（归属 B，与 A 同 cwd——旧布局共享目录场景的对照）
      const recordsDirB = getSubagentRecordsDir('s2', worldA.worldDir)
      mkdirSync(recordsDirB, { recursive: true })
      writeFileSync(join(recordsDirB, 'sa-other.events'), [
        JSON.stringify({ type: 'record-events', id: 'sa-other' }),
        JSON.stringify({ type: 'record-created', seq: 1, ts: 1000, id: 'sa-other', agent: 'worker', task: 'other', slug: 'o', origin: 'tool', rootSessionId: 's2', depth: 0, mode: 'bg', startedAt: 1000 }),
      ].join('\n') + '\n')
      writeFileSync(worldA.sessionFile, JSON.stringify({ type: 'session', id: 's1', cwd }) + '\n')

      const { records } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath: worldA.sessionFile, cwd }]) } as unknown as ISessionStore,
      })
      const subagents = await records.getSubagents('s1')
      const ids = subagents.records.map((r) => r.subagentId)
      expect(ids).toContain('sa-mine')
      expect(ids).not.toContain('sa-other')
    } finally {
      rmSync(worldA.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('v2 读投影：事件 fold 胜出条目冲突（status/stopReason），条目独有字段（model/result）照常填充', async () => {
    const cwd = '/tmp/w1-proj'
    const world = makeV2World(cwd)
    piAgentDirRef.dir = world.worldDir
    try {
      // 事件源：created（无 settled）→ running；条目：settled(interrupted) → 事件源胜出显示 running
      writeFileSync(join(world.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-events', id: 'sa-1' }),
        JSON.stringify({ type: 'record-created', seq: 1, ts: 1000, id: 'sa-1', agent: 'worker', task: 'Do work', slug: 'work', origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, mode: 'bg', startedAt: 1000 }),
      ].join('\n') + '\n')
      writeFileSync(world.sessionFile, [
        JSON.stringify({ type: 'session', id: 's1', cwd }),
        JSON.stringify(subagentRegisteredV2('sa-1')),
        JSON.stringify(subagentSettledV2('sa-1')),
        JSON.stringify(workflowRegisteredV2('wf-1', join(world.runJournalDir, 'wf-1.record.jsonl'))),
      ].join('\n') + '\n')
      writeFileSync(join(world.runJournalDir, 'wf-1.record.jsonl'), [
        JSON.stringify({ type: 'run-created', runId: 'wf-1', workflowName: 'test-flow', argsSummary: '', ts: 1000 }),
        JSON.stringify({ type: 'agent-started', taskIndex: 0, agentName: 'worker', attempt: 1, ts: 1100 }),
      ].join('\n') + '\n')
      const { records } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath: world.sessionFile, cwd }]) } as unknown as ISessionStore,
      })
      const subagents = await records.getSubagents('s1')
      expect(subagents.records).toHaveLength(1)
      expect(subagents.records[0]).toMatchObject({
        subagentId: 'sa-1',
        status: 'running', // 事件源胜出（条目 settled idle 不生效）
        model: 'p/m', // 条目独有字段
        result: 'full result text',
        parentRunId: 'wf-1',
        stepIndex: 0,
      })
      const workflows = await records.getWorkflows('s1')
      expect(workflows.records).toHaveLength(1)
      expect(workflows.records[0]).toMatchObject({ runId: 'wf-1', status: 'running', scriptName: 'test-flow' })
      // 步骤视图合并（W0 输入换源）：record 派生视图 overlay 到 事件 fold 骨架行
      expect(workflows.records[0]!.agentCalls[0]).toMatchObject({ status: 'running', sessionId: 'sa-1' })
      // 验收③：正常体量会话零调用全文读路径
      expect(extractSubagentsMock).not.toHaveBeenCalled()
      expect(extractWorkflowsMock).not.toHaveBeenCalled()
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('派生视图驱动信号：事件文件追加终态事件 → journal 推送喂入 → 派生视图变更 publish（subagents 帧 + workflowUpdate 转态信号）', async () => {
    const cwd = '/tmp/w1-signal'
    const world = makeV2World(cwd)
    piAgentDirRef.dir = world.worldDir
    try {
      writeFileSync(join(world.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-events', id: 'sa-1' }),
        JSON.stringify({ type: 'record-created', seq: 1, ts: 1000, id: 'sa-1', agent: 'worker', task: 'Do work', slug: 'work', origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, mode: 'bg', startedAt: 1000 }),
      ].join('\n') + '\n')
      writeFileSync(world.sessionFile, [
        JSON.stringify(subagentRegisteredV2('sa-1')),
        JSON.stringify(workflowRegisteredV2('wf-1', join(world.runJournalDir, 'wf-1.record.jsonl'))),
      ].join('\n') + '\n')
      writeFileSync(join(world.runJournalDir, 'wf-1.record.jsonl'), [
        JSON.stringify({ type: 'run-created', runId: 'wf-1', workflowName: 'test-flow', argsSummary: '', ts: 1000 }),
        JSON.stringify({ type: 'agent-started', taskIndex: 0, agentName: 'worker', attempt: 1, ts: 1100 }),
      ].join('\n') + '\n')
      const { records, publish } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath: world.sessionFile, cwd }]) } as unknown as ISessionStore,
      })
      const fire = registerSession(records)
      fire('s1')

      // 冷启动首帧（attach 折叠 → onChange → publish：subagents 帧恰一）
      await records.getSubagents('s1')
      let subFrames = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.subagents')
      expect(subFrames).toHaveLength(1)
      expect((subFrames[0]![1] as { payload: { subagents: Array<{ status: string }> } }).payload.subagents[0]!.status).toBe('running')

      // 事件文件追加 record-settled（completed）→ journal 推送报告喂入 → 派生视图变更 publish
      //（[event-push-channel] 实时路径 = 推送，写侧落盘提交点推报告经生产路由到达派生视图）
      publish.mockClear()
      const settled = { type: 'record-settled', seq: 2, ts: 3000, stopReason: 'completed', endedAt: 3000, turns: 2, totalTokens: 500 }
      writeFileSync(join(world.recordsDir, 'sa-1.events'), [
        JSON.stringify(settled),
      ].join('\n') + '\n', { flag: 'a' })
      expect(routeJournalReport('s1', {
        domain: 'record',
        fileKey: 'sa-1',
        events: [settled],
        sessionId: 's1',
        emittedAt: Date.now(),
      })).toBe(true)

      subFrames = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.subagents')
      expect(subFrames).toHaveLength(1)
      expect((subFrames[0]![1] as { payload: { subagents: Array<{ status: string; stopReason: string }> } }).payload.subagents[0])
        .toMatchObject({ status: 'idle', stopReason: 'completed' })
      // 转态信号（stepStatuses running→completed 维度）：record overlay 翻步骤行 → workflowUpdate
      const wfSignals = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.workflowUpdate')
      expect(wfSignals).toHaveLength(1)
      expect((wfSignals[0]![1] as { payload: { update: { runId: string; status: string } } }).payload.update)
        .toEqual({ runId: 'wf-1', status: 'running', reason: undefined })
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  // [W1 双形态] v2 混沌收敛（原 w18-record-entry-chaos 双形态断言的领地内落点）：
  // entry 通道整体空转（无 entry_appended 信号 + get_entries 恒空——比「信号被拦截」
  // 更强的混沌）下，唯一驱动 = bg-notify 兜底失效链（invalidateRecordEntries 即
  // event-interpreter 经组合根注入的同一入口）→ 派生视图冷启动 → record 事件文件 fold
  // （事实源）独立重建，收敛值与信号在位时等价。
  it('[W1 双形态] v2 混沌：entry 通道整体空转 → 兜底失效触发派生视图冷启动，事件 fold 独立收敛', async () => {
    const cwd = '/tmp/w1-chaos'
    const world = makeV2World(cwd)
    piAgentDirRef.dir = world.worldDir
    try {
      // 事件源：created + settled(completed) 已落盘；会话文件仅注册条目（终态条目缺席）
      writeFileSync(join(world.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-events', id: 'sa-1' }),
        JSON.stringify({ type: 'record-created', seq: 1, ts: 1000, id: 'sa-1', agent: 'worker', task: 'Do work', slug: 'work', origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, mode: 'background', startedAt: 1000 }),
        JSON.stringify({ type: 'record-settled', seq: 2, ts: 3000, stopReason: 'completed', endedAt: 3000, turns: 2, totalTokens: 500 }),
      ].join('\n') + '\n')
      writeFileSync(world.sessionFile, `${JSON.stringify(subagentRegisteredV2('sa-1'))}\n`)
      // 混沌注入：get_entries 恒空（entry 源两代都不产出）——派生视图只能来自 事件源
      const { records, publish, client } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath: world.sessionFile, cwd }]) } as unknown as ISessionStore,
      })
      client.getEntries.mockResolvedValue({ data: { entries: [], leafId: null } })
      const fire = registerSession(records)
      fire('s1')

      // 唯一驱动：bg-notify 兜底失效信号（interpreter 经组合根到达的同一入口）
      records.invalidateRecordEntries('s1', 'subagent-record')
      await flushDebounce()
      expect(client.getEntries).toHaveBeenCalledTimes(1)

      // 收敛断言：事件 fold 独立重建（entry 通道空）——帧内容 = 事件文件的权威值
      const subFrames = publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.subagents')
      expect(subFrames).toHaveLength(1)
      expect((subFrames[0]![1] as { payload: { subagents: Array<{ subagentId: string; status: string; stopReason: string }> } }).payload.subagents)
        .toEqual([expect.objectContaining({ subagentId: 'sa-1', status: 'idle', stopReason: 'completed' })])
      // RPC 读侧同源：getSubagents 与已发布帧一致（读请求唯一数据源 = 派生视图）
      const rpc = await records.getSubagents('s1')
      expect(rpc.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'idle', stopReason: 'completed' })
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

// ── 查询真理通道：未激活会话投影 size/游标续读核对（F1-51/F1-17，U1 续读化改写）───
//
// 验收对照（D1/D2，ADR-0097）：未激活会话（无 journal 推送、无 entry 游标增量）首次读
// 建投影后，磁盘事实补写在激活前的可见性由「主文件 size/游标核对 + 事件域 readdir 逐
// 文件核对」承载——append-only 前提下 size 是精确信号：size 不变零重算；size 增大续读
// 增量段；size 小于游标截断/重写 = 唯一整体重建场景（U3 D3 后台化：快照应答 +
// 异步整建 + 原子切换）。mtime
// 对账整建已退役（mtime 是粗粒度信号：追加任意 entry 必变，与派生内容变化无蕴涵关系）。
// dc801b73d 陈旧缺陷回归断言（磁盘新事实经查询可见）零丢失，改写为续读语义。

/** 续读核对用例的实例观察面（摸私有 cache——projection 实例标识是「零重建」断言的载体）。 */
function projectionOf(records: SessionRecords, sessionId: string): SessionEventProjection | null {
  const caches = (records as unknown as { recordEntriesCaches: Map<string, { projection: SessionEventProjection | null }> }).recordEntriesCaches
  return caches.get(sessionId)?.projection ?? null
}

/** [RL7] 冷热对拍的 live 腿观察面（摸私有 cache——cache.planState 是 live 链的派生落点，
 * 与 getPlanState 读路径归一后的返回值同源）。 */
function planStateCacheOf(records: SessionRecords, sessionId: string): { planState: PlanStateView | null } | undefined {
  const caches = (records as unknown as { recordEntriesCaches: Map<string, { planState: PlanStateView | null }> }).recordEntriesCaches
  return caches.get(sessionId)
}

describe('查询真理通道：未激活会话投影 size/游标续读核对（F1-51/F1-17）', () => {
  function makeUnactivatedWorld(): {
    world: ReturnType<typeof makeV2World>
    records: SessionRecords
    publish: ReturnType<typeof vi.fn>
    rewriteSessionFile: (entries: Array<Record<string, unknown>>) => void
    appendSessionFile: (entries: Array<Record<string, unknown>>) => void
  } {
    const cwd = '/tmp/resume-proj'
    const world = makeV2World(cwd)
    piAgentDirRef.dir = world.worldDir
    const rewriteSessionFile = (entries: Array<Record<string, unknown>>): void => {
      writeFileSync(world.sessionFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    }
    const appendSessionFile = (entries: Array<Record<string, unknown>>): void => {
      writeFileSync(world.sessionFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { flag: 'a' })
    }
    rewriteSessionFile([
      { type: 'session', id: 's1', cwd },
      subagentRegisteredV2('sa-1'),
    ])
    const { records, publish } = makeRecords({
      sessionStore: {
        scanSessions: vi.fn(() => [{
          id: 's1',
          filePath: world.sessionFile,
          cwd,
          lastModified: statSync(world.sessionFile).mtimeMs,
        }]),
      } as unknown as ISessionStore,
    })
    return { world, records, publish, rewriteSessionFile, appendSessionFile }
  }

  it('主文件追加新事实（size 增大）→ 次查询续读可见，实例存续不重建（dc801b73d 回归断言零丢失）', async () => {
    const { world, records, appendSessionFile } = makeUnactivatedWorld()
    try {
      // 首读建事件投影：会话文件只有注册条目 → running 在途态（陈旧快照原缺陷形态）
      const first = await records.getSubagents('s1')
      expect(first.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'running' })
      const projectionBefore = projectionOf(records, 's1')
      expect(projectionBefore).not.toBeNull()

      // 磁盘事实补写（清点落定形态：settled 条目追加，append-only）
      appendSessionFile([subagentSettledV2('sa-1')])

      // 次查询：size/游标核对命中增长 → 续读增量段 → 新事实可见；同一实例续读（无整建）
      const second = await records.getSubagents('s1')
      expect(second.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'idle' })
      expect(projectionOf(records, 's1')).toBe(projectionBefore)
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('追加无关 entry（size 变、增量段无 record 族行）→ 零重算零重建零信号（RL1/V3）', async () => {
    const { world, records, publish, appendSessionFile } = makeUnactivatedWorld()
    try {
      const first = await records.getSubagents('s1')
      expect(first.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'running' })
      const projectionBefore = projectionOf(records, 's1')

      // 连续追加普通对话 entry（与派生视图无关；mtime 必变、size 必变——现状 mtime 对账
      // 每条触发一次整建，续读核对零重算）
      appendSessionFile([{ type: 'message', id: 'm1', message: { role: 'user', content: '普通对话一' } }])
      expect((await records.getSubagents('s1')).records[0]).toMatchObject({ subagentId: 'sa-1', status: 'running' })
      appendSessionFile([{ type: 'message', id: 'm2', message: { role: 'assistant', content: [] } }])
      const third = await records.getSubagents('s1')
      expect(third.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'running' })

      // 派生视图实例不 dispose 不重建；查询通道不触发布链（发布零帧）
      expect(projectionOf(records, 's1')).toBe(projectionBefore)
      expect(publish).not.toHaveBeenCalled()
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('只动事件目录不动主文件 → 事件域 readdir 逐文件 size/游标核对捕获（RL2 补建项，目录级单 stat 检不出的形态）', async () => {
    const { world, records } = makeUnactivatedWorld()
    try {
      // 事件源：record-created 已落盘（running）；会话文件仅注册条目
      writeFileSync(join(world.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-events', id: 'sa-1' }),
        JSON.stringify({ type: 'record-created', seq: 1, ts: 1000, id: 'sa-1', agent: 'worker', task: 'Do work', slug: 'work', origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, mode: 'bg', startedAt: 1000 }),
      ].join('\n') + '\n')
      const first = await records.getSubagents('s1')
      expect(first.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'running' })

      // 另一写者只向事件文件追加 record-settled 行（主文件字节不动）
      appendFileSync(join(world.recordsDir, 'sa-1.events'),
        JSON.stringify({ type: 'record-settled', seq: 2, ts: 3000, stopReason: 'completed', endedAt: 3000, turns: 2, totalTokens: 500 }) + '\n')

      // 次查询：主文件零重算 + 事件域独立核对续读到新事实（事件源胜出仲裁）
      const second = await records.getSubagents('s1')
      expect(second.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'idle', stopReason: 'completed' })
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('size 小于游标（截断/重写）→ 快照应答 + 异步整建原子切换换实例（U3 D3 后台化；唯一保留 dispose 的场景）', async () => {
    const { world, records, rewriteSessionFile } = makeUnactivatedWorld()
    try {
      // 首建：主文件含终态条目（idle），游标登记到文件尾
      rewriteSessionFile([
        { type: 'session', id: 's1', cwd: '/tmp/resume-proj' },
        subagentRegisteredV2('sa-1'),
        subagentSettledV2('sa-1'),
      ])
      const first = await records.getSubagents('s1')
      expect(first.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'idle' })
      const projectionBefore = projectionOf(records, 's1')

      // 重写为更短内容（compaction 重写形态：终态条目被重写裁掉）：size < 游标 → 截断判定
      rewriteSessionFile([
        { type: 'session', id: 's1', cwd: '/tmp/resume-proj' },
        subagentRegisteredV2('sa-1'),
      ])

      // [U3 D3] 截断整建后台化：查询先返回旧快照（在途窗口旧实例可读、不换实例）
      const second = await records.getSubagents('s1')
      expect(second.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'idle' })
      expect(projectionOf(records, 's1')).toBe(projectionBefore)
      // await 在途整建任务（确定性完成信号）→ 原子切换换实例 → 新视图可见
      const caches = (records as unknown as { recordEntriesCaches: Map<string, { projectionAsyncRead: Promise<void> | null }> }).recordEntriesCaches
      await caches.get('s1')!.projectionAsyncRead
      expect(projectionOf(records, 's1')).not.toBe(projectionBefore)
      const third = await records.getSubagents('s1')
      expect(third.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'running' })
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('[U5 D6] 截断重写后的 plan 派生：buildInSegments planEntries 上浮喂数，旧基线作废、整建后收敛到重写文件新值', async () => {
    const { world, records, rewriteSessionFile } = makeUnactivatedWorld()
    try {
      // 首建：主文件含活跃 plan entry（awaiting）+ record 族（多族产出共存）——游标登记到文件尾
      rewriteSessionFile([
        { type: 'session', id: 's1', cwd: '/tmp/resume-proj' },
        planStateEntry(fullPlanData('awaiting'), 'e-p1'),
        subagentRegisteredV2('sa-1'),
        subagentSettledV2('sa-1'),
      ])
      const first = await records.getPlanState('s1')
      expect(first.isActive).toBe(true)
      expect(first.state).toBe('reviewing')

      // 重写为更短内容且 plan entry 翻转（compaction 重写保留内存条目的形态变体）：
      // size < 游标 → 截断判定 → 异步整建（planEntries 收集 = 整建扫描产出的 plan-state 条目）
      rewriteSessionFile([
        { type: 'session', id: 's1', cwd: '/tmp/resume-proj' },
        planStateEntry(fullPlanData('revising'), 'e-p2'),
        subagentRegisteredV2('sa-1'),
      ])
      const second = await records.getPlanState('s1')
      expect(second.state).toBe('reviewing') // 快照应答：在途窗口旧基线可读
      const caches = (records as unknown as { recordEntriesCaches: Map<string, { projectionAsyncRead: Promise<void> | null }> }).recordEntriesCaches
      await caches.get('s1')!.projectionAsyncRead // await 在途整建（确定性完成信号）→ 原子切换
      const converged = await records.getPlanState('s1')
      expect(converged.state).toBe('revising')
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('删档反向分支（V9④/检查点）：事件文件被删 → 记录保留按 entry 末态最小行呈现，fold/游标随同一轮核对失效清理', async () => {
    const { world, records, appendSessionFile } = makeUnactivatedWorld()
    try {
      // 主文件补终态条目（删档 fixture 语义：主文件注册与终态条目在册、事件文件缺席）
      appendSessionFile([subagentSettledV2('sa-1')])
      writeFileSync(join(world.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-events', id: 'sa-1' }),
        JSON.stringify({ type: 'record-created', seq: 1, ts: 1000, id: 'sa-1', agent: 'worker', task: 'Do work', slug: 'work', origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, mode: 'bg', startedAt: 1000 }),
        JSON.stringify({ type: 'record-settled', seq: 2, ts: 3000, stopReason: 'completed', endedAt: 3000, turns: 2, totalTokens: 500 }),
      ].join('\n') + '\n')
      // 首查询：fold 值胜出（stopReason completed）
      const first = await records.getSubagents('s1')
      expect(first.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'idle', stopReason: 'completed' })

      // fixture 直接删除事件文件（「主文件在册 ∧ 事件文件缺席」磁盘态——保留维护轮/
      // 级联删除编排中途崩溃窗口/btw 线删除线 jsonl 在册形态共用该 fixture）
      rmSync(join(world.recordsDir, 'sa-1.events'))

      // 次查询：删档降级 entry-source-only——记录仍在列（主文件注册与终态条目在册），
      // 状态 = entry 末态且与 fold 列表一致；fold/游标随同一轮核对失效清理（无滞留）
      const second = await records.getSubagents('s1')
      expect(second.records).toHaveLength(1)
      expect(second.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'idle', stopReason: 'interrupted' })
      expect(projectionOf(records, 's1')?.sources.recordFolds.has('sa-1')).toBe(false)
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('原地重写布防（检查点）：同 id 二次注册（会话重开/重新附着）→ 派生缓存与游标失效，重写后内容全量重建可见', async () => {
    const { world, records, rewriteSessionFile, appendSessionFile } = makeUnactivatedWorld()
    try {
      const fire = registerSession(records)
      fire('s1')
      const first = await records.getSubagents('s1')
      expect(first.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'running' })
      const projectionBefore = projectionOf(records, 's1')

      // 写侧追加普通 entry（游标落后于文件尾）后原地重写整个文件（pi 版本迁移重写形态
      // ——行字节变短、新 size ≥ 旧游标的错位形态：持旧游标续读会从错位字节流起读、
      // 漏掉文件头部的新条目）
      appendSessionFile([{ type: 'message', id: 'm1', message: { role: 'user', content: '追加' } }])
      rewriteSessionFile([
        { type: 'session', id: 's1', cwd: '/tmp/resume-proj' },
        subagentRegisteredV2('sa-1'),
        { ...subagentSettledV2('sa-1'), id: 'e-s1-rewritten' },
      ])

      // 同 id 二次注册 = 附着/激活边界：派生缓存与游标失效 → 查询全量重建读到重写后内容
      fire('s1')
      const second = await records.getSubagents('s1')
      expect(second.records[0]).toMatchObject({ subagentId: 'sa-1', status: 'idle', result: 'full result text' })
      expect(projectionOf(records, 's1')).not.toBe(projectionBefore)
    } finally {
      rmSync(world.worldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
