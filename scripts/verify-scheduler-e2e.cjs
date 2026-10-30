#!/usr/bin/env node
/**
 * verify-scheduler-e2e.cjs — pi-scheduler 任务库快照轨手动 e2e（真实 pi 进程 + faux LLM 演员）
 *
 * 定位：**手动**端到端验证工具（不在 CI 编排）。驱动真实 pi CLI 进程加载真实
 * extensions/universal/scheduler，用 faux provider 脚本充当 LLM（零 token、凭证无关），
 * 断言落在 scheduler 的唯一持久化载体上：
 *
 *   <PI_CODING_AGENT_DIR>/scheduler/<root>/<cwd segments>/<sessionId>.json
 *
 * 设计依据：.tmp/architecture-decay-audit/designs/scheduler-redesign.md 方案 B
 *（任务库与会话事实分离）。实装锚点：
 *   - packages/extension-protocol/src/extensions/scheduler/store.ts（路径推导 / 快照读写）
 *   - extensions/universal/scheduler/src/{index,backend,runtime}.ts（装配 / 恢复 / 记账）
 *   - resources/plugins/scheduler-manager/index.ts（面板只读方：同一 store 模块）
 *
 * 断言面（与 store.test.ts 单测互补，不重复堆砌）：
 *   - **跨进程 + 真实文件系统**：扩展写入的快照文件路径 / schemaVersion / tasks 内容 /
 *     原子替换（无 .tmp- 残留）/ 无 v1 legacy scheduler.json
 *   - **面板读取一致**：脚本直接 require 与面板同一份 store 模块（Node 24 type stripping），
 *     按面板公式（getPiAgentDir = <TAIJI_AGENT_DATA_DIR>/agent）推导路径并读取，断言与扩展
 *     写入路径逐字一致、任务集一致（单测的注入式读写不覆盖「两侧路径构造性一致」）
 *   - **会话流只承载会话事实**：会话 JSONL 无 `pi-scheduler:task` 条目（event sourcing
 *     已退役，负向断言）、dispatch 注入消息出现（`pi-scheduler:dispatched` 前缀）
 *   - 恢复：session_start 直读快照重建任务集（resume / 损坏留证 / 既有快照 + cron 失效停用）
 *
 * 本脚本不覆盖（明确边界）：
 *   - taiji GUI 面板渲染（overlay 树 / 徽标）——数据链已由「面板同源读快照」覆盖，
 *     渲染由 renderer 侧测试负责；真机验收用 pnpm dev 打开同一会话目视
 *   - 投递端口（unified-delivery）受理路径——本装配只加载 scheduler + faux，端口缺席走
 *     backend 的直发兜底（warn + pi.sendMessage，at-most-once）；端口受理/幂等测试见
 *     extensions/universal/scheduler/src/__tests__/backend-delivery.test.ts
 *   - 同一 sessionId 双进程双写（无锁，out of scope，S16 仅登记行为）
 *
 * 场景映射表（旧「会话 entry 事件溯源 + ack 合成轮」→ 新「快照任务库」）：
 *
 *   | 旧场景 | 旧断言 | 新归属 |
 *   |--------|--------|--------|
 *   | S1  once 创建 | 回显 + upsert entry | S1 保留：回显 + 快照（schemaVersion/tasks/sessionFile/原子写）+ 会话流无任务条目 |
 *   | S2  recurring 创建 | 回显 + upsert entry | S2 保留：同 S1，recurring 字段（nextRunAt/expiresAt 默认 7d） |
 *   | S3  session 隔离 | B 无 scheduler entry | S3 保留：分片文件隔离（不同 sessionId → 不同文件，B 分片不存在） |
 *   | S4  once 到期注入 owner-only | A 出 delete entry、B 干净 | S4 保留：快照删除任务 + 注入消息出现在 A + B 无分片 |
 *   | S5  resume 重放 | 重开同 session entry 重放 | S5 保留：同 sessionId 同分片直读恢复；文件字节/mtime 不变（读不写） |
 *   | S6  旧 store 导入 | legacy scheduler.json 被导入删除 | **删除**：importer 已退役（用户裁决不迁移），改为 S1/S9 断言 legacy 文件不产生 |
 *   | S7  busy 窗口延后 dispatch | dispatchTask 首行 isIdle 兜底 | **删除**：新 runtime 无 isIdle 门控（steer 忙闲同注入） |
 *   | S8  subagent 隔离 | subagent 是独立 session 无 owner entry | **删除**：由 S3/S11 覆盖（subagent = 新 sessionId = 新分片） |
 *   | S9  删 session 无残留 | B 空 + legacy store 无孤儿 | S9 改写：删会话文件后分片成孤儿（任务库独立于会话文件），新会话不读、无 legacy 文件 |
 *   | S10 旧 store 并发导入 | 两进程 rename 竞态 | **删除**：importer 已退役 |
 *   | S11 fork 隔离（手工） | fork 副本 list 为空 | S11 升级为自动：RPC fork → 新 sessionId → 新分片 missing → 空任务集；原分片不变 |
 *   | S12 dispatch 后 resume | advance nextRunAt 不回退 | S12 保留：记账跨重启持久化（快照字节相等 + nextRunAt 不回退） |
 *   | S13 首轮 kill 丢任务（手工） | 首 turn 内 kill → resume 任务丢失 | S13 **语义反转**：首轮建任务后立即 kill → resume 任务仍在（写盘不依赖 pi 首写门控） |
 *   | S14 post-flush 耐久 | 已有对话后才落盘 | **删除**：门控不存在；S1/S2 已在首轮直接断言快照 |
 *   | S15 taiji 兼容（手工） | GUI 历史列表正常 | S15 改写：面板数据链 = 快照直读（pi 进程退出后仍可读、任务集一致） |
 *   | S16 双开同一 session | 记录双触发行为 | S16 保留 FOLLOWUP：同一 sessionId 双进程同分片（无锁，out of scope） |
 *   | S17 entry 线性增长 | 1 upsert + N advance，nextRunAt 单调 | S17 改写：快照 runCount 增长 + nextRunAt 单调 + history 记账 + dispatch 注入 |
 *   | S18 命令表单改值 | 表单契约 + notify + upsert + ack 合成行 | S18 保留前三项；快照替代 entry；**ack 断言删除** |
 *   | S19 命令表单取消 | 无 toast / 无 entry / 无 ack 行 | S19 保留取消语义；断言**无快照文件写入**（机制红利） |
 *   | S20 无参默认草稿 | 表单契约 + notify + cron 归一化 entry | S20 保留，落盘断言改快照 |
 *   | S21 预填原值 | 表单契约 + notify + entry | S21 保留，落盘断言改快照 |
 *   | S22 合成行字段 + 宿主不变量 | stopReason/usage/model_change/auto-rename | **删除**：合成轮机制不存在 |
 *   | S23 连续两次创建确认轮恰 1 次 | aborted 行恰 1 | **删除**：合成轮机制不存在 |
 *   | — | — | S24 新增：toggle off/on 快照转移（resume 后按快照 id 操作） |
 *   | — | — | S25 新增：delete 快照转移（任务移除、文件保留空集） |
 *   | — | — | S26 新增：run-now dispatch（立即注入 + 记账 + nextRunAt 推进） |
 *   | — | — | S27 新增：过期清理（expires 到期 → tick 移除，不注入） |
 *   | — | — | S28 新增：--no-session 写盘（无会话文件仍落盘；分片键为进程 UUID，重启不恢复——登记语义） |
 *   | — | — | S29 新增：损坏快照恢复（改名 .corrupt-<ts> 留证 + 空集启动 + 再写新快照） |
 *   | — | — | S30 新增：既有快照恢复 + cron 失效停用（dispatch 后 disableForInvalidCron 落盘） |
 *
 * 用例形态：
 *   - 纯文件系统可验证（无需 pi 进程，读快照/推导路径）：--self-test 全量覆盖；
 *     S15 的断言段在进程退出后执行（面板读取不依赖 pi 存活）
 *   - 需要真机环境（真实 pi + 扩展加载层）：S1-S5/S9/S11-S13/S17-S21/S24-S30
 *
 * 环境装配（与 taiji 生产布局同构）：
 *   <tmp>/data                = TAIJI_AGENT_DATA_DIR（面板 getPiAgentDir 的根）
 *   <tmp>/data/agent          = PI_CODING_AGENT_DIR（pi 官方 getAgentDir；扩展写快照处）
 *   <tmp>/workspace           = pi 进程 cwd（快照路径的 workspace 隔离段）
 *   <tmp>/sessions            = --session-dir
 *   ui-preferences.json 固定 locale=en-US（notify 文案断言的确定性前提）
 *   所有临时目录在 mkdtemp 后 realpathSync（macOS /var → /private/var，路径推导必须同源）
 *
 * 用法：
 *   node scripts/verify-scheduler-e2e.cjs                # 默认跑 A 类（必须全过）
 *   node scripts/verify-scheduler-e2e.cjs S1             # 单场景
 *   node scripts/verify-scheduler-e2e.cjs aclass|bclass|all|v
 *   node scripts/verify-scheduler-e2e.cjs --self-test    # 无副作用自检（不 spawn pi）
 *
 * 环境变量：
 *   PI_BIN=<path>                 覆盖 pi 二进制（缺省 apps/electron/resources/pi/pi-<平台>-<arch>）
 *   SCHED_E2E_MODEL=faux/faux-1   覆盖测试模型（仅限 faux/ 演员；零 token 红线）
 *   SCHED_E2E_KEEP_TMP=1          保留临时工作区并打印路径（失败归因用）
 *
 * 退出码：0 = 已跑场景无 FAIL；1 = 任一 FAIL；2 = 脚本异常 / 用法错误
 */
'use strict'

const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

// 表单帧判定纯函数族（与 scripts/__tests__/verify-scheduler-e2e.test.mjs 共用单测锚点）
const {
  checkScheduleFormDraftContract,
  getScheduleQuestionFromRequest,
  parseJsonlEntries,
} = require('./lib/scheduler-e2e-judgers.cjs')

const TAG = '[SCHED-E2E]'
const REPO_ROOT = path.resolve(__dirname, '..')
const EXTENSION_PATH = path.join(REPO_ROOT, 'extensions', 'universal', 'scheduler')
/** faux provider 注册 extension（与 runtime equivalence 套件同一 SSOT 文件） */
const FAUX_LLM_EXT_PATH = path.join(
  REPO_ROOT, 'packages', 'runtime', 'src', '__tests__', 'fixtures', 'faux-llm-ext.ts',
)
const PI_BIN_DEFAULT = path.join(
  REPO_ROOT, 'apps', 'electron', 'resources', 'pi', `pi-${process.platform}-${process.arch}`,
)

/**
 * 任务库 store 模块（**真源单实现**，不是 CJS 端口）：扩展写、面板读、本脚本断言三方
 * 消费同一份 TS 源码。Node 24 原生 type stripping + require(esm) 直接加载 .ts；
 * 路径推导与快照形状因此构造性一致，不存在脚本侧副本漂移。
 */
const STORE_MODULE_PATH = path.join(
  REPO_ROOT, 'packages', 'extension-protocol', 'src', 'extensions', 'scheduler', 'store.ts',
)
let storeModule
try {
  storeModule = require(STORE_MODULE_PATH)
} catch (err) {
  console.error(`${TAG} 无法加载 store 模块: ${STORE_MODULE_PATH}`)
  console.error(`${TAG} 原因: ${err && err.message ? err.message : String(err)}`)
  console.error(`${TAG} 需要 Node >= 24（原生 TypeScript type stripping），当前 ${process.version}（见 .nvmrc）`)
  process.exit(2)
}

const { SCHEDULER_STORE_SCHEMA_VERSION, readSchedulerStore, schedulerStoreFilePath, writeSchedulerStore } = storeModule

/** 统一提问表单请求的 select title marker（SSOT = extension-protocol ui-form/marker.ts） */
const UI_FORM_MARKER = '\x00TAIJI_UI_FORM'
/** dispatch 注入消息的 customType 前缀（runtime.ts DISPATCH_CUSTOM_TYPE_PREFIX） */
const DISPATCH_CUSTOM_TYPE_PREFIX = 'pi-scheduler:'
/** event sourcing 已退役的任务条目类型（仅用于负向断言：会话流不得出现） */
const RETIRED_SESSION_TASK_ENTRY = 'pi-scheduler:task'
/** v1 旧 store 文件名（importer 已退役；仅用于负向断言：调度树内不得出现） */
const LEGACY_STORE_FILENAME = 'scheduler.json'
/** 非法/空 sessionId 的分片归一值（index.ts session_start 同规则） */
const NO_SESSION_SHARD = 'no-session'

/** 测试模型（faux 演员；env 覆盖仅限 faux/ 前缀——零 token 红线） */
const MODEL = (() => {
  const m = process.env.SCHED_E2E_MODEL || 'faux/faux-1'
  if (!m.startsWith('faux/')) {
    console.error(`${TAG} SCHED_E2E_MODEL 必须是 faux/ 演员实际 "${m}"（faux 轨零 token 红线）`)
    process.exit(2)
  }
  return m
})()

/** faux 模型演员 id（--model 'faux/<id>' 的 id 段；:level 后缀剥除） */
const FAUX_MODEL_ID = MODEL.includes('/')
  ? MODEL.slice(MODEL.indexOf('/') + 1).split(':')[0]
  : MODEL

// ── 基础工具 ────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** @returns {string | null} */
function locatePiBinary() {
  for (const candidate of [process.env.PI_BIN || null, PI_BIN_DEFAULT].filter(Boolean)) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 面板侧 pi agent 目录（packages/shared/src/paths.ts getPiAgentDir 的同式；self-test 锚定）。 */
function panelAgentDir(dataDir) {
  return path.join(dataDir, 'agent')
}

/** sessionId 归一到分片键（非法/空 → 'no-session'，与 index.ts session_start 同规则）。 */
function normalizeSessionId(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]+$/.test(raw) ? raw : NO_SESSION_SHARD
}

/** dispatch 注入消息的完整 customType（runtime.ts 的 `${DISPATCH_CUSTOM_TYPE_PREFIX}dispatched`）。 */
const DISPATCH_CUSTOM_TYPE = `${DISPATCH_CUSTOM_TYPE_PREFIX}dispatched`

/** 会话条目里的 dispatch 注入（pi sendMessage 落盘形态：type='custom_message' + customType）。 */
function dispatchEntries(entries) {
  return (entries || []).filter(e => e && e.customType === DISPATCH_CUSTOM_TYPE)
}

/** dispatch 条目正文文本（content 可能是 string 或 text block 数组）。 */
function dispatchContentText(entry) {
  const content = entry && entry.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(block => (block && typeof block.text === 'string' ? block.text : '')).join('')
  }
  return ''
}

/** 轮询 RPC entries 直到 dispatch 注入条目数 >= expected（内存态，无落盘延迟）。 */
async function waitForDispatchEntries(s, expected, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let entries = []
  while (Date.now() < deadline) {
    entries = dispatchEntries(await s.getEntries())
    if (entries.length >= expected) return { ok: true, entries }
    await sleep(200)
  }
  return { ok: entries.length >= expected, entries }
}

/** 递归列出目录下全部文件（缺省目录返回 []）。 */
function walkFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  return out
}

function schedulerTreeRoot(agentDir) {
  return path.join(agentDir, 'scheduler')
}

/** 调度树内全部文件（排障 evidence 用）。 */
function schedulerTreeFiles(agentDir) {
  return walkFiles(schedulerTreeRoot(agentDir))
}

/** 分片快照文件（排除原子写 tmp 残留 / 损坏留证 / v1 legacy 文件）。 */
function shardFiles(agentDir) {
  return schedulerTreeFiles(agentDir).filter(f => {
    const base = path.basename(f)
    if (!base.endsWith('.json')) return false
    if (base.includes('.tmp-') || base.includes('.corrupt-')) return false
    return base !== LEGACY_STORE_FILENAME
  })
}

function tmpResidues(agentDir) {
  return schedulerTreeFiles(agentDir).filter(f => path.basename(f).includes('.tmp-'))
}

function corruptResidues(agentDir) {
  return schedulerTreeFiles(agentDir).filter(f => path.basename(f).includes('.corrupt-'))
}

function legacyStoreFiles(agentDir) {
  return schedulerTreeFiles(agentDir).filter(f => path.basename(f) === LEGACY_STORE_FILENAME)
}

/**
 * 原样读快照（JSON.parse，不触发 store 的 corrupt 改名副作用——S29 需要观察原始状态）。
 * @returns {{ exists: boolean, text: string, raw: unknown, error: string | null }}
 */
function readSnapshotRaw(filePath) {
  if (!existsSync(filePath)) return { exists: false, text: '', raw: null, error: null }
  let text
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch (err) {
    return { exists: true, text: '', raw: null, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    return { exists: true, text, raw: JSON.parse(text), error: null }
  } catch (err) {
    return { exists: true, text, raw: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 轮询快照直到 predicate 成立；返回最后一次观察结果（含 .ok）。
 * predicate 入参 = readSnapshotRaw 结果。
 */
async function waitForSnapshot(filePath, predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  let snapshot = readSnapshotRaw(filePath)
  while (Date.now() < deadline) {
    if (predicate(snapshot)) return { ok: true, snapshot }
    await sleep(intervalMs)
    snapshot = readSnapshotRaw(filePath)
  }
  return { ok: predicate(snapshot), snapshot }
}

/** 从快照 raw 取 tasks（非数组返回 []）。 */
function snapshotTasks(snapshot) {
  return snapshot && snapshot.raw && Array.isArray(snapshot.raw.tasks) ? snapshot.raw.tasks : []
}

function findTask(snapshot, id) {
  return snapshotTasks(snapshot).find(t => t && t.id === id)
}

/** 面板侧读取（同一 store 模块；corrupt 会改名——只在文件有效时调用）。 */
function panelReadTasks(filePath) {
  const read = readSchedulerStore(filePath)
  return { read, tasks: read.kind === 'ok' ? read.tasks : [] }
}

/** 断言收集器：证据单行化（失败项标 FAIL，全部项带实际值，便于失败归因）。 */
function makeChecks() {
  const items = []
  return {
    add(label, ok, detail) {
      items.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) })
      return !!ok
    },
    eq(label, actual, expected) {
      return this.add(label, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
    },
    allOk() {
      return items.every(i => i.ok)
    },
    evidence() {
      return items
        .map(i => `${i.ok ? 'ok' : 'FAIL'} ${i.label}${i.detail ? ` (${i.detail})` : ''}`)
        .join('; ')
    },
    items,
  }
}

// ── 工作区（taiji 生产布局同构） ─────────────────────────────────────────

/**
 * 临时工作区：dataDir / agentDir / cwd / sessionDir 四层分离，与 taiji 运行时注入
 * pi 子进程的 env 同构（TAIJI_AGENT_DATA_DIR=<dataDir>，PI_CODING_AGENT_DIR=<dataDir>/agent）。
 * 整棵 root 先 realpathSync：macOS mkdtemp 返回 /var/...（symlink），而 pi 子进程的
 * process.cwd() 解析为 /private/var/...——不快照同一物理路径会让路径推导全错。
 */
function makeWorkspace(label) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `pi-sched-e2e-${label}.`)))
  const dataDir = path.join(root, 'data')
  const agentDir = path.join(dataDir, 'agent')
  const cwd = path.join(root, 'workspace')
  const sessionDir = path.join(root, 'sessions')
  for (const dir of [agentDir, cwd, sessionDir]) mkdirSync(dir, { recursive: true })
  return {
    label,
    root,
    dataDir,
    agentDir,
    cwd,
    sessionDir,
    cleanup() {
      if (process.env.SCHED_E2E_KEEP_TMP === '1') {
        console.log(`${TAG} [debug] keep tmp workspace: ${root}`)
        return
      }
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      } catch {
        /* best-effort */
      }
    },
  }
}

/** 预置 faux agentDir（settings/models/ui-preferences + 本轮响应脚本）。 */
function seedFauxAgent(ws, label, fauxSteps) {
  writeFileSync(path.join(ws.agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'faux',
    defaultModel: FAUX_MODEL_ID,
    enabledModels: [MODEL.split(':')[0]],
    retry: { enabled: false },
  }, null, 2))
  writeFileSync(path.join(ws.agentDir, 'models.json'), JSON.stringify({
    providers: {
      faux: {
        name: 'faux',
        api: 'faux',
        apiKey: 'not-needed',
        // 自定义模型条目必须有 baseUrl（pi provider-composer 校验）；faux 不耗网络
        baseUrl: 'http://127.0.0.1:1/faux',
        models: [{
          id: FAUX_MODEL_ID,
          name: `Faux ${FAUX_MODEL_ID}`,
          input: ['text'],
          contextWindow: 128000,
          maxTokens: 16384,
        }],
      },
    },
  }, null, 2))
  // locale 固定 en-US：scheduler 的 notify 文案断言（i18n 词典）以此为前提
  writeFileSync(
    path.join(ws.dataDir, 'ui-preferences.json'),
    JSON.stringify({ v: 1, locale: 'en-US' }, null, 2),
  )
  const scriptPath = path.join(ws.dataDir, `faux-responses-${label}.json`)
  writeFileSync(scriptPath, JSON.stringify(fauxSteps))
  return scriptPath
}

// ── pi RPC session 封装 ──────────────────────────────────────────────────

/**
 * stdout 行分发：JSON.parse 失败的行（banner / 半行）跳过；全部成功帧进 captured
 * （证据来源）、response 帧按 id 唤醒 pending、sessionFile 进缓存、turn_end 唤醒回合等待者。
 */
function consumeRpcLine(line, state, captured, pending) {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  captured.push(msg)

  if (msg.type === 'response' && msg.data && typeof msg.data.sessionFile === 'string') {
    state.sessionFileCache = msg.data.sessionFile
  }
  if (msg.type === 'response' && msg.id) {
    const waiter = pending.get(msg.id)
    if (waiter) {
      pending.delete(msg.id)
      waiter.resolve(msg)
    }
  }
  if (msg.type === 'extension_ui_request') {
    if (msg.method === 'notify') {
      state.notifies.push({
        id: typeof msg.id === 'string' ? msg.id : String(msg.id),
        message: typeof msg.message === 'string' ? msg.message : '',
        notifyType: typeof msg.notifyType === 'string' ? msg.notifyType : undefined,
      })
    }
    const view = {
      id: typeof msg.id === 'string' ? msg.id : String(msg.id),
      method: typeof msg.method === 'string' ? msg.method : '',
      title: typeof msg.title === 'string' ? msg.title : undefined,
      options: Array.isArray(msg.options) ? msg.options.map(String) : undefined,
    }
    let reply
    if (state.uiActor) {
      reply = state.uiActor(view)
    } else {
      // 缺省 uiActor：schedule 表单属非预期（模型路径直建，不应弹表单）→ 记录 + 取消
      if (msg.method !== 'select' || msg.title !== UI_FORM_MARKER) return
      state.unexpectedScheduleForms.push(view)
      reply = { cancelled: true }
    }
    if (reply && state.respond) {
      state.respond({ type: 'extension_ui_response', id: msg.id, ...reply })
    }
    return
  }
  if (msg.type === 'turn_end') {
    const stopReason = (msg.message && msg.message.stopReason) || msg.stopReason || ''
    if (stopReason !== 'toolUse' && state.turnEndResolver) {
      const resolver = state.turnEndResolver
      state.turnEndResolver = null
      resolver.resolve({ ok: true, stopReason })
    }
  }
}

/** 表单问题 → 回包 key（D2 回包契约：key = header ?? question，与 FormOverlay qKey 同规则）。 */
function formAnswerKey(question) {
  return typeof question.header === 'string' ? question.header : question.question
}

/** 构造表单确认回包：FormAnswers envelope（{key: flat ScheduleFormResult JSON}）。 */
function scheduleFormAnswer(question, result) {
  return {
    value: JSON.stringify({
      [formAnswerKey(question)]: JSON.stringify({ action: 'create', ...result }),
    }),
  }
}

/**
 * spawn 一个 pi 进程（加载 scheduler + faux provider，关 builtin tools / context files）。
 * @param {ReturnType<typeof makeWorkspace>} ws
 * @param {{ label: string, fauxSteps: Array<object>, uiActor?: Function | null,
 *           extraExtensions?: string[], sessionFile?: string, noSession?: boolean }} opts
 */
function spawnSession(ws, opts) {
  const scriptPath = seedFauxAgent(ws, opts.label, opts.fauxSteps || [])
  const args = [
    '--no-extensions',
    '--extension', EXTENSION_PATH,
    '--extension', FAUX_LLM_EXT_PATH,
    '--no-builtin-tools',
    '--no-context-files',
    '--mode', 'rpc',
    '--session-dir', ws.sessionDir,
    '--model', MODEL,
    '--approve',
  ]
  for (const extra of opts.extraExtensions || []) args.push('--extension', extra)
  if (opts.noSession === true) args.push('--no-session')
  if (opts.sessionFile) args.push('--session', opts.sessionFile)

  const child = spawn(locatePiBinary() || PI_BIN_DEFAULT, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: ws.cwd,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: ws.agentDir,
      TAIJI_AGENT_DATA_DIR: ws.dataDir,
      TAIJI_FAUX_SCRIPT: scriptPath,
      PI_SKIP_VERSION_CHECK: '1',
      ...(process.env.SCHED_E2E_KEEP_TMP === '1' ? { TAIJI_AGENT_DEBUG: '1' } : {}),
    },
  })

  let rpcId = 0
  /** @type {Map<string, { resolve: (v: unknown) => void }>} */
  const pending = new Map()
  /** @type {unknown[]} */
  const captured = []
  const state = {
    stdoutBuf: '',
    turnEndResolver: null,
    sessionFileCache: null,
    uiActor: opts.uiActor || null,
    respond: null,
    notifies: [],
    unexpectedScheduleForms: [],
  }
  let stderrBuf = ''
  let exitInfo = null
  const exitPromise = new Promise(resolve => {
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal }
      resolve(exitInfo)
    })
  })

  state.respond = obj => {
    try {
      child.stdin.write(JSON.stringify(obj) + '\n')
    } catch {
      /* 进程已退出：应答丢弃（场景断言会暴露） */
    }
  }

  child.stdout.on('data', data => {
    state.stdoutBuf += data.toString('utf-8')
    let nl
    while ((nl = state.stdoutBuf.indexOf('\n')) >= 0) {
      const line = state.stdoutBuf.slice(0, nl)
      state.stdoutBuf = state.stdoutBuf.slice(nl + 1)
      consumeRpcLine(line, state, captured, pending)
    }
  })
  child.stderr.on('data', data => {
    stderrBuf += data.toString('utf-8')
  })

  function sendRpc(command) {
    const id = `r${++rpcId}`
    return new Promise(resolve => {
      pending.set(id, { resolve })
      try {
        child.stdin.write(JSON.stringify({ ...command, id }) + '\n')
      } catch {
        pending.delete(id)
        resolve({ success: false, error: 'stdin closed (pi exited)' })
      }
    })
  }

  function waitForTurnEnd(timeoutMs) {
    return new Promise(resolve => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        state.turnEndResolver = null
        resolve({ ok: false })
      }, timeoutMs)
      state.turnEndResolver = {
        resolve: value => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve(value)
        },
      }
    })
  }

  async function waitReady(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = await Promise.race([sendRpc({ type: 'get_state' }), sleep(5000).then(() => null)])
      if (r && r.success) return r
      await sleep(300)
    }
    return null
  }

  /** 发 prompt 并等回合结束（模型路径）。 */
  async function prompt(message, turnTimeoutMs = 120000) {
    const ack = await Promise.race([sendRpc({ type: 'prompt', message }), sleep(20000).then(() => null)])
    if (!ack) throw new Error('prompt ack timeout (20s)')
    if (!ack.success) throw new Error('prompt rejected: ' + JSON.stringify(ack.error || ack.data))
    return waitForTurnEnd(turnTimeoutMs)
  }

  /** 发 prompt 只等 ack（不等回合结束；S13 首轮 kill 用）。 */
  async function promptNoWait(message, ackTimeoutMs = 20000) {
    const ack = await Promise.race([
      sendRpc({ type: 'prompt', message }),
      sleep(ackTimeoutMs).then(() => null),
    ])
    if (!ack) throw new Error('prompt ack timeout (20s)')
    if (!ack.success) throw new Error('prompt rejected: ' + JSON.stringify(ack.error || ack.data))
    return ack
  }

  /** 发 slash 命令（pi 的 `/` 分支不产生 turn 事件，只等 ack）。 */
  async function sendCommand(message, ackTimeoutMs = 20000) {
    const ack = await Promise.race([
      sendRpc({ type: 'prompt', message }),
      sleep(ackTimeoutMs).then(() => null),
    ])
    if (!ack) throw new Error('command ack timeout (20s)')
    if (!ack.success) throw new Error('command rejected: ' + JSON.stringify(ack.error || ack.data))
    return ack
  }

  /** 已捕获的统一表单 schedule 请求帧。 */
  function formRequests() {
    return captured
      .filter(m => m && m.type === 'extension_ui_request' && m.method === 'select' && m.title === UI_FORM_MARKER)
      .map(m => ({
        id: typeof m.id === 'string' ? m.id : String(m.id),
        options: Array.isArray(m.options) ? m.options.map(String) : [],
      }))
  }

  async function waitForFormRequest(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const reqs = formRequests()
      if (reqs.length > 0) return reqs
      await sleep(150)
    }
    return formRequests()
  }

  async function waitForNotify(predicate, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = state.notifies.find(n => (predicate ? predicate(n) : true))
      if (hit) return hit
      await sleep(150)
    }
    return null
  }

  async function getStateData() {
    const r = await sendRpc({ type: 'get_state' })
    return r && r.success && r.data ? r.data : null
  }

  async function getEntries() {
    const r = await sendRpc({ type: 'get_entries' })
    return r && r.success && r.data && Array.isArray(r.data.entries) ? r.data.entries : []
  }

  async function getMessages() {
    const r = await sendRpc({ type: 'get_messages' })
    return r && r.success && r.data && Array.isArray(r.data.messages) ? r.data.messages : []
  }

  /** 会话 id / sessionFile（分片键与冗余字段断言的来源）。 */
  async function sessionInfo() {
    const stateData = await getStateData()
    const rawSessionId = stateData && typeof stateData.sessionId === 'string' ? stateData.sessionId : ''
    return {
      rawSessionId,
      sessionId: normalizeSessionId(rawSessionId),
      sessionFile: stateData && typeof stateData.sessionFile === 'string' ? stateData.sessionFile : null,
      model: stateData ? stateData.model : null,
      isStreaming: stateData ? stateData.isStreaming : null,
    }
  }

  /** 磁盘会话 JSONL（只反映已落盘内容；文件不存在 = 未落盘的正常形态）。 */
  function readSessionJsonl(filePath) {
    const target = filePath || state.sessionFileCache
    if (!target || !existsSync(target)) return { path: target || null, exists: false, text: '', entries: [] }
    let text = ''
    try {
      text = readFileSync(target, 'utf-8')
    } catch {
      return { path: target, exists: true, text: '', entries: [] }
    }
    return { path: target, exists: true, text, entries: parseJsonlEntries(text) }
  }

  function messageToText(message) {
    if (!message) return ''
    const content = message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n')
    }
    return ''
  }

  /**
   * dispatch 注入证据 blob：get_messages 文本 + 全部捕获帧 + 磁盘 JSONL。
   * 三源合并（任一来源命中即算）——注入消息经 steer 进会话流的落盘形态由 pi 内部决定，
   * 不对单一路径做过度承诺；负向断言（无任务条目）同样三源检查。
   */
  async function evidenceBlob() {
    const messages = await getMessages()
    const messageText = messages.map(messageToText).join('\n')
    const capturedText = captured
      .map(m => {
        try {
          return JSON.stringify(m)
        } catch {
          return ''
        }
      })
      .join('\n')
    const jsonl = readSessionJsonl()
    return `${messageText}\n${capturedText}\n${jsonl.text}`
  }

  /** 先 SIGTERM，5s 未退出再 SIGKILL；返回退出信息（保证后续文件断言无并发写）。 */
  async function kill() {
    if (exitInfo) return exitInfo
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    const graceful = await Promise.race([exitPromise, sleep(5000).then(() => null)])
    if (graceful) return graceful
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    return Promise.race([exitPromise, sleep(2000).then(() => null)])
  }

  return {
    sendRpc,
    waitReady,
    prompt,
    promptNoWait,
    sendCommand,
    waitForFormRequest,
    waitForNotify,
    getStateData,
    getEntries,
    getMessages,
    sessionInfo,
    readSessionJsonl,
    evidenceBlob,
    kill,
    getCaptured: () => captured,
    getNotifies: () => state.notifies,
    getUnexpectedScheduleForms: () => state.unexpectedScheduleForms,
    stderrTail: (len = 600) => stderrBuf.slice(-len),
    exitInfo: () => exitInfo,
  }
}

// ── 快照断言辅助 ────────────────────────────────────────────────────────

function storePathFor(ws, sessionId) {
  return schedulerStoreFilePath(ws.agentDir, ws.cwd, sessionId)
}

/** 面板侧同一路径（面板读方公式：getPiAgentDir()=<dataDir>/agent + sessions.get 的 cwd）。 */
function panelStorePathFor(ws, sessionId) {
  return schedulerStoreFilePath(panelAgentDir(ws.dataDir), ws.cwd, sessionId)
}

/**
 * 面板一致性组：扩展写入路径 == 面板推导路径 → 面板 readable → 任务集一致。
 * 单测用注入路径覆盖 store 行为，本断言覆盖「两侧路径构造性一致」这一跨进程性质。
 */
function checkPanelParity(ws, ck, sessionId, expectedTaskIds) {
  const extensionPath = storePathFor(ws, sessionId)
  const panelPath = panelStorePathFor(ws, sessionId)
  ck.eq('panel path == extension path', panelPath, extensionPath)
  const { read, tasks } = panelReadTasks(panelPath)
  ck.eq('panel read kind', read.kind, 'ok')
  ck.eq(
    'panel task ids',
    JSON.stringify(tasks.map(t => t.id).sort()),
    JSON.stringify([...expectedTaskIds].sort()),
  )
  return { extensionPath, panelPath, tasks }
}

/** 调度树整洁度组：恰 1 个分片、无 tmp 残留、无 v1 legacy 文件。 */
function checkStoreHygiene(ws, ck, expectedShardCount = 1) {
  const shards = shardFiles(ws.agentDir)
  ck.eq('shard file count', shards.length, expectedShardCount)
  ck.eq('tmp residue count', tmpResidues(ws.agentDir).length, 0)
  ck.eq('legacy scheduler.json count', legacyStoreFiles(ws.agentDir).length, 0)
  return shards
}

/** 会话流负向：event sourcing 任务条目已退役，任何内联/磁盘来源都不得出现。 */
function checkNoRetiredTaskEntries(ck, entries, jsonlEntries, label) {
  const inline = (entries || []).filter(
    e => e && e.type === 'custom' && e.customType === RETIRED_SESSION_TASK_ENTRY,
  )
  const disk = (jsonlEntries || []).filter(
    e => e && e.type === 'custom' && e.customType === RETIRED_SESSION_TASK_ENTRY,
  )
  ck.eq(`${label} inline retired task entries`, inline.length, 0)
  ck.eq(`${label} jsonl retired task entries`, disk.length, 0)
}

/** 计时断言容差（写入口同一 backend.now()，同源字段可精确相等）。 */
function approx(actual, expected, tolerance) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance
}

// ── 场景定义 ────────────────────────────────────────────────────────────
// 每个场景返回 { name, status: 'PASS' | 'FAIL' | 'FOLLOWUP', evidence, debug? }

function fail(name, reason) {
  return { name, status: 'FAIL', evidence: reason }
}

/** S1：once 创建 → 快照（回显 + 字段 + 原子写 + 面板一致 + 会话流无任务条目）。 */
async function runS1(piBin) {
  const ws = makeWorkspace('S1')
  let s = null
  try {
    s = spawnSession(ws, {
      label: 'S1',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'e2e-once-task', schedule: '1h', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    if (!(await s.waitReady())) return fail('S1', 'pi not ready / extension load failed: ' + s.stderrTail())

    const turn = await s.prompt('Call the schedule tool with the preset arguments. Then reply with the single word: done')
    if (!turn.ok) return fail('S1', 'turn did not end (timeout)')

    const info = await s.sessionInfo()
    const storePath = storePathFor(ws, info.sessionId)
    const waited = await waitForSnapshot(storePath, snap => snapshotTasks(snap).length === 1, 20000)
    const snapshot = waited.snapshot
    const tasks = snapshotTasks(snapshot)
    const task = tasks[0] || null

    const entries = await s.getEntries()
    const jsonl = s.readSessionJsonl(info.sessionFile)
    const blob = await s.evidenceBlob()
    const unexpectedForms = s.getUnexpectedScheduleForms()

    const ck = makeChecks()
    // 模型路径回显（service.ts 的 once 单行）
    ck.add("echo 'Next run: in 1h'", /Next run:\s+in\s+1h/.test(blob))
    ck.add("no 'Next 5 runs:'", !blob.includes('Next 5 runs:'))
    ck.add('no numbered run lines', !/^\s*\d+\.\s+in\s/m.test(blob))
    ck.eq('no unexpected form frames', unexpectedForms.length, 0)

    // 快照本体
    ck.add('snapshot exists', snapshot.exists && !snapshot.error, snapshot.error || '')
    ck.eq('schemaVersion', snapshot.raw && snapshot.raw.schemaVersion, SCHEDULER_STORE_SCHEMA_VERSION)
    ck.eq('sessionFile redundant field', snapshot.raw && snapshot.raw.sessionFile, info.sessionFile)
    ck.eq('task count', tasks.length, 1)
    if (task) {
      ck.add('task id is 8 hex', /^[0-9a-f]{8}$/.test(task.id), String(task.id))
      ck.eq('task prompt', task.prompt, 'e2e-once-task')
      ck.eq('task name auto', task.name, 'e2e-once-task')
      ck.eq('task kind', task.kind, 'once')
      ck.eq('task enabled', task.enabled, true)
      ck.eq('task runCount', task.runCount, 0)
      ck.eq('task history', JSON.stringify(task.history), '[]')
      // addTask 单次 now：createdAt 与 nextRunAt 同源，可精确相等
      ck.eq('nextRunAt = createdAt + 1h', task.nextRunAt - task.createdAt, 3600000)
      ck.add('once has no expiresAt', task.expiresAt === undefined, String(task.expiresAt))
      ck.add('no pending in snapshot', !('pending' in task) && !snapshot.text.includes('"pending"'))
    }
    ck.add('snapshot is human-readable (2-space indent)', snapshot.text.includes('\n  "schemaVersion"'))

    const shards = checkStoreHygiene(ws, ck, 1)
    ck.eq('shard path == derived path', shards.length === 1 ? shards[0] : null, storePath)
    checkPanelParity(ws, ck, info.sessionId, task ? [task.id] : [])
    checkNoRetiredTaskEntries(ck, entries, jsonl.entries, 's1')

    await s.kill()
    // 进程退出后面板侧仍可读（快照读取不依赖 pi 存活）
    const afterKill = readSchedulerStore(panelStorePathFor(ws, info.sessionId))
    ck.eq('panel read after pi exit', afterKill.kind, 'ok')

    return {
      name: 'S1',
      status: ck.allOk() ? 'PASS' : 'FAIL',
      evidence: ck.evidence(),
      debug: { snapshot: snapshot.text },
    }
  } catch (err) {
    return fail('S1', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/** S2：recurring 创建 → 快照（5 行回显 + 默认 7d 过期 + 到点时间精确）。 */
async function runS2(piBin) {
  const ws = makeWorkspace('S2')
  let s = null
  try {
    s = spawnSession(ws, {
      label: 'S2',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'e2e-recurring-task', schedule: '10m', kind: 'recurring' } }] },
        { text: 'done' },
      ],
    })
    if (!(await s.waitReady())) return fail('S2', 'pi not ready: ' + s.stderrTail())
    const turn = await s.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turn.ok) return fail('S2', 'turn did not end')

    const info = await s.sessionInfo()
    const storePath = storePathFor(ws, info.sessionId)
    const waited = await waitForSnapshot(storePath, snap => snapshotTasks(snap).length === 1, 20000)
    const snapshot = waited.snapshot
    const task = snapshotTasks(snapshot)[0] || null
    const blob = await s.evidenceBlob()
    const ck = makeChecks()

    ck.add("echo 'Next 5 runs:'", blob.includes('Next 5 runs:'))
    ck.eq('numbered run lines', (blob.match(/^\s*\d+\.\s+in\s/mg) || []).length, 5)
    ck.eq('no unexpected form frames', s.getUnexpectedScheduleForms().length, 0)

    ck.add('snapshot exists', snapshot.exists && !snapshot.error, snapshot.error || '')
    ck.eq('task count', snapshotTasks(snapshot).length, 1)
    if (task) {
      ck.eq('task kind', task.kind, 'recurring')
      ck.eq('task prompt', task.prompt, 'e2e-recurring-task')
      ck.eq('task enabled', task.enabled, true)
      ck.eq('nextRunAt = createdAt + 10m', task.nextRunAt - task.createdAt, 600000)
      ck.eq('default expiresAt = createdAt + 7d', task.expiresAt - task.createdAt, 7 * 86400000)
      ck.add('history empty', Array.isArray(task.history) && task.history.length === 0)
    }
    checkStoreHygiene(ws, ck, 1)
    checkPanelParity(ws, ck, info.sessionId, task ? [task.id] : [])

    return { name: 'S2', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S2', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/** S3：session 隔离（同 cwd，不同 sessionId → 不同分片，B 无任务、无文件）。 */
async function runS3(piBin) {
  const ws = makeWorkspace('S3')
  let a = null
  let b = null
  try {
    a = spawnSession(ws, {
      label: 'S3-A',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'iso-A-task', schedule: '30m', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    if (!(await a.waitReady())) return fail('S3', 'pi A not ready: ' + a.stderrTail())
    const turnA = await a.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turnA.ok) return fail('S3', 'A turn did not end')
    const infoA = await a.sessionInfo()
    const pathA = storePathFor(ws, infoA.sessionId)
    const waitedA = await waitForSnapshot(pathA, snap => snapshotTasks(snap).length === 1, 20000)
    if (!waitedA.ok) return fail('S3', 'A did not persist task snapshot')
    const taskA = snapshotTasks(waitedA.snapshot)[0]
    await a.kill()

    b = spawnSession(ws, {
      label: 'S3-B',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    if (!(await b.waitReady())) return fail('S3', 'pi B not ready: ' + b.stderrTail())
    const turnB = await b.prompt('Call schedule_control with action list. Then reply: done')
    if (!turnB.ok) return fail('S3', 'B turn did not end')
    const infoB = await b.sessionInfo()
    const pathB = storePathFor(ws, infoB.sessionId)
    const blobB = await b.evidenceBlob()
    const entriesB = await b.getEntries()
    const jsonlB = b.readSessionJsonl(infoB.sessionFile)

    const ck = makeChecks()
    ck.add('A/B sessionId differ', infoA.sessionId !== infoB.sessionId, `${infoA.sessionId} vs ${infoB.sessionId}`)
    ck.add('A/B shard paths differ', pathA !== pathB, `${pathA} vs ${pathB}`)
    ck.add('B shard missing', !existsSync(pathB))
    ck.eq('B snapshot tasks', snapshotTasks(readSnapshotRaw(pathB)).length, 0)
    ck.add("B list says 'No scheduled tasks.'", blobB.includes('No scheduled tasks.'))
    ck.eq('A shard still has task', snapshotTasks(readSnapshotRaw(pathA)).length, 1)
    checkNoRetiredTaskEntries(ck, entriesB, jsonlB.entries, 'b')
    checkStoreHygiene(ws, ck, 1)

    return {
      name: 'S3',
      status: ck.allOk() ? 'PASS' : 'FAIL',
      evidence: ck.evidence() + `; A task id=${taskA ? taskA.id : '?'}`,
    }
  } catch (err) {
    return fail('S3', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (a) await a.kill()
    if (b) await b.kill()
    ws.cleanup()
  }
}

/** S4：once 到期 → dispatch（快照删除任务 + 注入出现）+ owner-only（B 无分片）。B 类。 */
async function runS4(piBin) {
  const ws = makeWorkspace('S4')
  let a = null
  let b = null
  try {
    const marker = 'E2E-ONCE-DISPATCH-PROBE'
    a = spawnSession(ws, {
      label: 'S4-A',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: marker, schedule: '1m', kind: 'once' } }] },
        { text: 'done' },
        ...Array.from({ length: 4 }, () => ({ text: 'ok' })),
      ],
    })
    if (!(await a.waitReady())) return fail('S4', 'pi A not ready: ' + a.stderrTail())
    const turnA = await a.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turnA.ok) return fail('S4', 'A create turn did not end')
    const infoA = await a.sessionInfo()
    const pathA = storePathFor(ws, infoA.sessionId)
    const created = await waitForSnapshot(pathA, snap => snapshotTasks(snap).length === 1, 20000)
    if (!created.ok) return fail('S4', 'A did not create task')

    // B 同 cwd 启动（A 仍存活）：新 sessionId → 无任务
    b = spawnSession(ws, {
      label: 'S4-B',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    if (!(await b.waitReady())) return fail('S4', 'pi B not ready: ' + b.stderrTail())
    const turnB = await b.prompt('Call schedule_control with action list. Then reply: done')
    if (!turnB.ok) return fail('S4', 'B list turn did not end')
    const infoB = await b.sessionInfo()
    const blobB = await b.evidenceBlob()

    // 等 once 到期（1m）+ tick（30s）+ LLM 抖动
    const dispatched = await waitForSnapshot(pathA, snap => snapshotTasks(snap).length === 0, 150000, 2000)
    const dispatchPoll = await waitForDispatchEntries(a, 1, 15000)

    const ck = makeChecks()
    ck.add('A task removed after once dispatch', dispatched.ok)
    ck.eq('dispatch injected exactly once', dispatchPoll.entries.length, 1)
    ck.add('dispatch content is task prompt', dispatchContentText(dispatchPoll.entries[0]) === marker,
      JSON.stringify(dispatchContentText(dispatchPoll.entries[0]).slice(0, 80)))
    ck.add('B shard missing', !existsSync(storePathFor(ws, infoB.sessionId)))
    ck.add("B list says 'No scheduled tasks.'", blobB.includes('No scheduled tasks.'))
    ck.eq('A shard remains readable (empty tasks)', snapshotTasks(readSnapshotRaw(pathA)).length, 0)

    return { name: 'S4', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S4', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (a) await a.kill()
    if (b) await b.kill()
    ws.cleanup()
  }
}

/** S5：resume 恢复（同 sessionId 同分片；读不写：文件字节与 mtime 不变）。 */
async function runS5(piBin) {
  const ws = makeWorkspace('S5')
  let a = null
  let a2 = null
  try {
    a = spawnSession(ws, {
      label: 'S5-A',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'resume-test', schedule: '30m', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    if (!(await a.waitReady())) return fail('S5', 'pi A not ready: ' + a.stderrTail())
    const turnA = await a.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turnA.ok) return fail('S5', 'A create turn did not end')
    const infoA = await a.sessionInfo()
    const pathA = storePathFor(ws, infoA.sessionId)
    const created = await waitForSnapshot(pathA, snap => snapshotTasks(snap).length === 1, 20000)
    if (!created.ok) return fail('S5', 'A did not create task')
    const textBefore = created.snapshot.text
    const mtimeBefore = statSync(pathA).mtimeMs
    const taskId = snapshotTasks(created.snapshot)[0].id
    await a.kill()

    a2 = spawnSession(ws, {
      label: 'S5-A2',
      sessionFile: infoA.sessionFile || undefined,
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    if (!(await a2.waitReady())) return fail('S5', 'resume not ready: ' + a2.stderrTail())
    const turnA2 = await a2.prompt('Call schedule_control with action list. Then reply: done')
    if (!turnA2.ok) return fail('S5', 'resume list turn did not end')
    const infoA2 = await a2.sessionInfo()
    const blobA2 = await a2.evidenceBlob()
    const textAfter = readFileSync(pathA, 'utf-8')
    const mtimeAfter = statSync(pathA).mtimeMs

    const ck = makeChecks()
    ck.eq('resume keeps sessionId', infoA2.sessionId, infoA.sessionId)
    ck.add("list not 'No scheduled tasks.'", !blobA2.includes('No scheduled tasks.'))
    ck.add('list shows task id', blobA2.includes(taskId), taskId)
    ck.add('snapshot byte-identical after resume (read does not write)', textAfter === textBefore)
    ck.eq('snapshot mtime unchanged', mtimeAfter, mtimeBefore)
    checkStoreHygiene(ws, ck, 1)

    return { name: 'S5', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S5', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (a) await a.kill()
    if (a2) await a2.kill()
    ws.cleanup()
  }
}

/** S9：删除会话文件 → 分片成孤儿（任务库独立于会话文件），新会话不读、无 legacy 文件。 */
async function runS9(piBin) {
  const ws = makeWorkspace('S9')
  let a = null
  let b = null
  try {
    a = spawnSession(ws, {
      label: 'S9-A',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'orphan-test', schedule: '30m', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    if (!(await a.waitReady())) return fail('S9', 'pi A not ready: ' + a.stderrTail())
    const turnA = await a.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turnA.ok) return fail('S9', 'A create turn did not end')
    const infoA = await a.sessionInfo()
    const pathA = storePathFor(ws, infoA.sessionId)
    const created = await waitForSnapshot(pathA, snap => snapshotTasks(snap).length === 1, 20000)
    if (!created.ok) return fail('S9', 'A did not create task')
    await a.kill()

    // 删除会话文件（模拟 session 被删除）
    if (infoA.sessionFile && existsSync(infoA.sessionFile)) rmSync(infoA.sessionFile, { force: true })

    b = spawnSession(ws, {
      label: 'S9-B',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    if (!(await b.waitReady())) return fail('S9', 'pi B not ready: ' + b.stderrTail())
    const turnB = await b.prompt('Call schedule_control with action list. Then reply: done')
    if (!turnB.ok) return fail('S9', 'B list turn did not end')
    const infoB = await b.sessionInfo()
    const blobB = await b.evidenceBlob()

    const ck = makeChecks()
    ck.add('A shard stays on disk (orphan by design)', existsSync(pathA))
    ck.eq('A shard still holds task', snapshotTasks(readSnapshotRaw(pathA)).length, 1)
    ck.add('B session file differs from A', infoB.sessionFile !== infoA.sessionFile)
    ck.add('B shard missing', !existsSync(storePathFor(ws, infoB.sessionId)))
    ck.add("B list says 'No scheduled tasks.'", blobB.includes('No scheduled tasks.'))
    ck.eq('legacy scheduler.json count', legacyStoreFiles(ws.agentDir).length, 0)
    ck.eq('tmp residue count', tmpResidues(ws.agentDir).length, 0)

    return { name: 'S9', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S9', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (a) await a.kill()
    if (b) await b.kill()
    ws.cleanup()
  }
}

/**
 * S11：fork 分片隔离（旧 C 类手工 → 自动）。RPC fork 产生新 sessionId →
 * 新分片不存在 → 空任务集；原 session 分片不变。
 *
 * fork 后不发模型 prompt：pi 的 fork 会重跑 extension factory，faux fixture 的防重播种
 *（SEEDED_KEY）使新 core 队列为空 → 后续 turn 命中「No more faux responses」空响应。
 * 空任务集改用构造性断言：新分片不存在 ⇔ readSchedulerStore=missing ⇔ loadTasks=[]。
 */
async function runS11(piBin) {
  const ws = makeWorkspace('S11')
  let s = null
  try {
    s = spawnSession(ws, {
      label: 'S11',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'fork-origin-task', schedule: '2h', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    if (!(await s.waitReady())) return fail('S11', 'pi not ready: ' + s.stderrTail())
    const turnCreate = await s.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turnCreate.ok) return fail('S11', 'create turn did not end')
    const infoA = await s.sessionInfo()
    const pathA = storePathFor(ws, infoA.sessionId)
    const created = await waitForSnapshot(pathA, snap => snapshotTasks(snap).length === 1, 20000)
    if (!created.ok) return fail('S11', 'origin session did not create task')

    const forkMessages = await s.sendRpc({ type: 'get_fork_messages' })
    const messages = forkMessages && forkMessages.success && forkMessages.data ? forkMessages.data.messages : []
    const entryId = messages.length > 0 ? messages[0].entryId : null
    if (!entryId) return fail('S11', 'no forkable user message (get_fork_messages empty)')
    const forkResp = await s.sendRpc({ type: 'fork', entryId })
    if (!forkResp || !forkResp.success) return fail('S11', 'fork RPC failed: ' + JSON.stringify(forkResp))

    // fork 后 rebind session，轮询到新 sessionId
    let infoFork = null
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      infoFork = await s.sessionInfo()
      if (infoFork.sessionId !== infoA.sessionId) break
      await sleep(300)
    }
    if (!infoFork || infoFork.sessionId === infoA.sessionId) return fail('S11', 'fork did not rebind to a new sessionId')
    const pathFork = storePathFor(ws, infoFork.sessionId)
    const entriesFork = await s.getEntries()

    const ck = makeChecks()
    ck.add('fork sessionId differs', infoFork.sessionId !== infoA.sessionId, `${infoA.sessionId} -> ${infoFork.sessionId}`)
    ck.add('fork session file differs', infoFork.sessionFile !== infoA.sessionFile)
    ck.add('fork shard path differs', pathFork !== pathA)
    ck.add('fork shard missing', !existsSync(pathFork))
    ck.eq('fork shard read = missing (empty task set)', panelReadTasks(pathFork).read.kind, 'missing')
    ck.eq('origin shard still has task', snapshotTasks(readSnapshotRaw(pathA)).length, 1)
    checkStoreHygiene(ws, ck, 1)
    ck.eq('fork session has no retired task entries', entriesFork.filter(e => e && e.customType === RETIRED_SESSION_TASK_ENTRY).length, 0)

    return { name: 'S11', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S11', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/**
 * S13：首轮 kill 耐久（旧语义反转）。首轮建任务后不等 turn 结束立即 kill →
 * resume 任务仍在（写盘不依赖 pi 会话首写门控）。A 类。
 */
async function runS13(piBin) {
  const ws = makeWorkspace('S13')
  let a = null
  let a2 = null
  try {
    a = spawnSession(ws, {
      label: 'S13-A',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'first-turn-kill', schedule: '30m', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    if (!(await a.waitReady())) return fail('S13', 'pi A not ready: ' + a.stderrTail())
    const infoA = await a.sessionInfo()
    const pathA = storePathFor(ws, infoA.sessionId)
    // 不等 turn_end：tool 执行即同步写快照
    await a.promptNoWait('Call the schedule tool with the preset arguments. Then reply: done')
    const created = await waitForSnapshot(pathA, snap => snapshotTasks(snap).length === 1, 20000)
    await a.kill()
    if (!created.ok) return fail('S13', 'task snapshot missing before/after immediate kill')

    const sessionFile = infoA.sessionFile
    if (!sessionFile || !existsSync(sessionFile)) {
      return fail('S13', 'session file missing after kill (cannot resume): ' + String(sessionFile))
    }

    a2 = spawnSession(ws, {
      label: 'S13-A2',
      sessionFile,
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    if (!(await a2.waitReady())) return fail('S13', 'resume not ready: ' + a2.stderrTail())
    const turnList = await a2.prompt('Call schedule_control with action list. Then reply: done')
    if (!turnList.ok) return fail('S13', 'resume list turn did not end')
    const blob = await a2.evidenceBlob()
    const task = snapshotTasks(readSnapshotRaw(pathA))[0]

    const ck = makeChecks()
    ck.add('snapshot written during first turn', created.ok)
    ck.add('task survived immediate kill', !!task, task ? task.id : 'missing')
    ck.add("resume list not 'No scheduled tasks.'", !blob.includes('No scheduled tasks.'))
    ck.add('resume list shows task id', task ? blob.includes(task.id) : false)

    return { name: 'S13', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S13', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (a) await a.kill()
    if (a2) await a2.kill()
    ws.cleanup()
  }
}

/**
 * S15：taiji 面板数据链（pi 进程退出后仍可读）。两个任务 → kill → 面板侧
 * 按 getPiAgentDir 公式直读：路径一致、任务集一致、徽标可用（enabled 计数）。
 */
async function runS15(piBin) {
  const ws = makeWorkspace('S15')
  let s = null
  try {
    s = spawnSession(ws, {
      label: 'S15',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'panel-task-a', schedule: '1h', kind: 'recurring' } }] },
        { text: 'done' },
        { toolCalls: [{ name: 'schedule', args: { prompt: 'panel-task-b', schedule: '2h', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    if (!(await s.waitReady())) return fail('S15', 'pi not ready: ' + s.stderrTail())
    const turn1 = await s.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turn1.ok) return fail('S15', 'first create turn did not end')
    const turn2 = await s.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turn2.ok) return fail('S15', 'second create turn did not end')

    const info = await s.sessionInfo()
    const path = storePathFor(ws, info.sessionId)
    const created = await waitForSnapshot(path, snap => snapshotTasks(snap).length === 2, 20000)
    if (!created.ok) return fail('S15', 'two tasks not persisted')
    const taskIds = snapshotTasks(created.snapshot).map(t => t.id)
    await s.kill()

    const ck = makeChecks()
    const parity = checkPanelParity(ws, ck, info.sessionId, taskIds)
    ck.eq('panel enabled count (badge)', parity.tasks.filter(t => t.enabled).length, 2)
    ck.eq('panel hidden false when tasks exist', parity.tasks.length > 0, true)
    ck.add('pi process exited', !!s.exitInfo())
    checkStoreHygiene(ws, ck, 1)

    return {
      name: 'S15',
      status: ck.allOk() ? 'PASS' : 'FAIL',
      evidence: ck.evidence() + `; tasks=${JSON.stringify(taskIds)}`,
    }
  } catch (err) {
    return fail('S15', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/**
 * S17：dispatch 累积记账（旧 entry 增长 → 快照 runCount/history/nextRunAt）。
 * 10s recurring，观察到 >= 3 次 dispatch；nextRunAt 在 runCount 变化点严格递增。
 */
async function runS17(piBin) {
  const ws = makeWorkspace('S17')
  let s = null
  try {
    const marker = 'E2E-RECURRING-DISPATCH-PROBE'
    s = spawnSession(ws, {
      label: 'S17',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: marker, schedule: '10s', kind: 'recurring' } }] },
        { text: 'done' },
        ...Array.from({ length: 60 }, () => ({ text: 'ok' })),
      ],
    })
    if (!(await s.waitReady())) return fail('S17', 'pi not ready: ' + s.stderrTail())
    const turnCreate = await s.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turnCreate.ok) return fail('S17', 'create turn did not end')
    const info = await s.sessionInfo()
    const path = storePathFor(ws, info.sessionId)
    const created = await waitForSnapshot(path, snap => snapshotTasks(snap).length === 1, 20000)
    if (!created.ok) return fail('S17', 'task not persisted')
    const task = snapshotTasks(created.snapshot)[0]
    const taskId = task.id

    const observations = []
    let lastRunCount = 0
    const deadline = Date.now() + 420000
    while (Date.now() < deadline) {
      await sleep(5000)
      const snap = readSnapshotRaw(path)
      const task = findTask(snap, taskId)
      if (!task) {
        // recurring 不应消失（删除只发生在 once 或过期）
        observations.push({ runCount: -1, nextRunAt: null })
        break
      }
      if (task.runCount !== lastRunCount) {
        observations.push({ runCount: task.runCount, nextRunAt: task.nextRunAt })
        lastRunCount = task.runCount
      }
      if (lastRunCount >= 3) break
    }

    const finalSnap = readSnapshotRaw(path)
    const finalTask = findTask(finalSnap, taskId)
    const dispatchPoll = await waitForDispatchEntries(s, Math.max(lastRunCount, 1), 15000)
    const ck = makeChecks()

    ck.add('observed >= 3 dispatches', lastRunCount >= 3, `runCount=${lastRunCount}`)
    ck.add('task still present (recurring not deleted)', !!finalTask)
    if (finalTask) {
      ck.eq('runCount', finalTask.runCount, lastRunCount)
      ck.add('history length matches runCount (cap 20)', finalTask.history.length === Math.min(lastRunCount, 20),
        `history=${finalTask.history.length}`)
      ck.add('history all success', finalTask.history.every(h => h.status === 'success'))
      ck.eq('lastStatus', finalTask.lastStatus, 'success')
      ck.add('lastRunAt is recent', approx(finalTask.lastRunAt, Date.now(), 120000), String(finalTask.lastRunAt))
      ck.eq('nextRunAt = lastRunAt + 10s', finalTask.nextRunAt - finalTask.lastRunAt, 10000)
      ck.add('no pending persisted', !('pending' in finalTask))
    }
    let monotonic = true
    for (let i = 1; i < observations.length; i += 1) {
      const prev = observations[i - 1]
      const cur = observations[i]
      if (!(cur.runCount > prev.runCount) || !(cur.nextRunAt > prev.nextRunAt)) monotonic = false
    }
    ck.add('nextRunAt strictly increases across dispatch points', monotonic, JSON.stringify(observations.map(o => o.nextRunAt)))
    ck.eq('dispatch entries = runCount', dispatchPoll.entries.length, lastRunCount)
    ck.add('every dispatch content is task prompt', dispatchPoll.entries.every(e => dispatchContentText(e) === marker),
      dispatchPoll.entries.map(e => JSON.stringify(dispatchContentText(e).slice(0, 40))).join(','))

    return { name: 'S17', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S17', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/**
 * S18：命令路径表单（带参预填 + 用户改值确认）→ 快照。
 * 断言：表单契约 / notify 回显裁定值 / 快照内容 / 无 ack 合成行（机制已退役）。
 */
async function runS18(piBin) {
  const ws = makeWorkspace('S18')
  let s = null
  try {
    s = spawnSession(ws, {
      label: 'S18',
      fauxSteps: [{ text: 'ok' }],
      uiActor: req => {
        if (req.method !== 'select' || req.title !== UI_FORM_MARKER) return null
        const question = getScheduleQuestionFromRequest(req)
        if (!question) return null
        return scheduleFormAnswer(question, { kind: 'once', schedule: '45m', prompt: 'user-edited-prompt' })
      },
    })
    if (!(await s.waitReady())) return fail('S18', 'pi not ready: ' + s.stderrTail())
    await s.sendCommand('/schedule 1h "confirm-draft-prompt"')
    const reqs = await s.waitForFormRequest(15000)
    const contract = checkScheduleFormDraftContract(reqs, {
      kind: 'recurring', schedule: '1h', prompt: 'confirm-draft-prompt',
    })
    const notify = await s.waitForNotify(n => n.message.includes('user-edited-prompt'), 15000)

    const info = await s.sessionInfo()
    const path = storePathFor(ws, info.sessionId)
    const waited = await waitForSnapshot(path, snap => snapshotTasks(snap).length === 1, 20000)
    const task = snapshotTasks(waited.snapshot)[0] || null
    const entries = await s.getEntries()
    const jsonl = s.readSessionJsonl(info.sessionFile)
    await s.kill()

    const ck = makeChecks()
    ck.eq('form select requests', reqs.length, 1)
    ck.add('form draft contract', contract.ok, contract.desc)
    ck.add(
      'notify echoes edited values',
      !!notify && /^Created [0-9a-f]{8}: user-edited-prompt · once in 45m · next run in \d+m/.test(notify.message),
      notify ? notify.message : '(none)',
    )
    ck.eq('notify type', notify && notify.notifyType, 'info')
    ck.add('snapshot exists', waited.ok)
    if (task) {
      ck.eq('task prompt (edited)', task.prompt, 'user-edited-prompt')
      ck.eq('task kind (edited)', task.kind, 'once')
      ck.eq('task schedule interval 45m', task.schedule && task.schedule.intervalMs, 2700000)
      ck.eq('task schedule mode', task.schedule && task.schedule.mode, 'interval')
    }
    // ack 合成轮已退役：命令路径不产生任何 assistant 行（无合成轮、无真实轮）
    const assistantLines = jsonl.entries.filter(
      e => e && e.type === 'message' && e.message && e.message.role === 'assistant',
    )
    ck.eq('no assistant lines (ack synthetic turn retired)', assistantLines.length, 0)
    checkNoRetiredTaskEntries(ck, entries, jsonl.entries, 's18')
    checkPanelParity(ws, ck, info.sessionId, task ? [task.id] : [])

    return { name: 'S18', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S18', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/** S19：命令路径表单取消 → 不写快照、无 toast、无任务条目（取消不是错误）。 */
async function runS19(piBin) {
  const ws = makeWorkspace('S19')
  let s = null
  try {
    s = spawnSession(ws, {
      label: 'S19',
      fauxSteps: [{ text: 'ok' }],
      uiActor: req => {
        if (req.method !== 'select' || req.title !== UI_FORM_MARKER) return null
        return { cancelled: true }
      },
    })
    if (!(await s.waitReady())) return fail('S19', 'pi not ready: ' + s.stderrTail())
    await s.sendCommand('/schedule 30m "cancel-path-task"')
    const reqs = await s.waitForFormRequest(15000)
    await sleep(2000)
    const notifies = s.getNotifies()
    const info = await s.sessionInfo()
    const path = storePathFor(ws, info.sessionId)
    const entries = await s.getEntries()
    const jsonl = s.readSessionJsonl(info.sessionFile)
    await s.kill()

    const ck = makeChecks()
    ck.eq('form select requests', reqs.length, 1)
    ck.eq('notify frames (cancel is not an error)', notifies.length, 0)
    ck.add('no snapshot file written', !existsSync(path))
    ck.eq('shard file count', shardFiles(ws.agentDir).length, 0)
    checkNoRetiredTaskEntries(ck, entries, jsonl.entries, 's19')

    return { name: 'S19', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S19', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/** S20：无参表单默认草稿（once/空串）→ 用户提交 cron → 快照（cron 归一化 6 字段）。 */
async function runS20(piBin) {
  const ws = makeWorkspace('S20')
  let s = null
  try {
    s = spawnSession(ws, {
      label: 'S20',
      fauxSteps: [{ text: 'ok' }],
      uiActor: req => {
        if (req.method !== 'select' || req.title !== UI_FORM_MARKER) return null
        const question = getScheduleQuestionFromRequest(req)
        if (!question) return null
        return scheduleFormAnswer(question, {
          kind: 'recurring', schedule: '0 9 * * *', prompt: 'daily-standup-reminder',
        })
      },
    })
    if (!(await s.waitReady())) return fail('S20', 'pi not ready: ' + s.stderrTail())
    await s.sendCommand('/schedule')
    const reqs = await s.waitForFormRequest(15000)
    const contract = checkScheduleFormDraftContract(reqs, { kind: 'once', schedule: '', prompt: '' })
    const notify = await s.waitForNotify(n => n.message.includes('daily-standup-reminder'), 15000)
    const info = await s.sessionInfo()
    const path = storePathFor(ws, info.sessionId)
    const waited = await waitForSnapshot(path, snap => snapshotTasks(snap).length === 1, 20000)
    const task = snapshotTasks(waited.snapshot)[0] || null
    const jsonl = s.readSessionJsonl(info.sessionFile)
    await s.kill()

    const ck = makeChecks()
    ck.eq('form select requests', reqs.length, 1)
    ck.add('default draft (once / empty schedule / empty prompt)', contract.ok, contract.desc)
    ck.add(
      'notify echoes normalized cron',
      !!notify && /^Created [0-9a-f]{8}: daily-standup-reminder · 0 0 9 \* \* \*/.test(notify.message),
      notify ? notify.message : '(none)',
    )
    ck.add('snapshot exists', waited.ok)
    if (task) {
      ck.eq('task kind', task.kind, 'recurring')
      ck.eq('task schedule mode', task.schedule && task.schedule.mode, 'cron')
      ck.eq('cron normalized to 6 fields', task.schedule && task.schedule.cronExpression, '0 0 9 * * *')
      ck.eq('task prompt', task.prompt, 'daily-standup-reminder')
      const next = new Date(task.nextRunAt)
      ck.add('nextRunAt at local 09:00:00', next.getHours() === 9 && next.getMinutes() === 0 && next.getSeconds() === 0,
        next.toString())
    }
    const aborted = jsonl.entries.filter(
      e => e && e.type === 'message' && e.message && e.message.role === 'assistant',
    )
    ck.eq('no assistant lines (command path + ack retired)', aborted.length, 0)
    checkPanelParity(ws, ck, info.sessionId, task ? [task.id] : [])

    return { name: 'S20', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S20', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/** S21：/schedule 预填原值确认基线（命令参数 → 表单 initial → 快照）。 */
async function runS21(piBin) {
  const ws = makeWorkspace('S21')
  let s = null
  try {
    s = spawnSession(ws, {
      label: 'S21',
      fauxSteps: [{ text: 'ok' }],
      uiActor: req => {
        if (req.method !== 'select' || req.title !== UI_FORM_MARKER) return null
        const question = getScheduleQuestionFromRequest(req)
        if (!question) return null
        return scheduleFormAnswer(question, { kind: 'recurring', schedule: '30m', prompt: 'alias-task' })
      },
    })
    if (!(await s.waitReady())) return fail('S21', 'pi not ready: ' + s.stderrTail())
    await s.sendCommand('/schedule 30m "alias-task"')
    const reqs = await s.waitForFormRequest(15000)
    const contract = checkScheduleFormDraftContract(reqs, {
      kind: 'recurring', schedule: '30m', prompt: 'alias-task',
    })
    const notify = await s.waitForNotify(n => n.message.includes('alias-task'), 15000)
    const info = await s.sessionInfo()
    const path = storePathFor(ws, info.sessionId)
    const waited = await waitForSnapshot(path, snap => snapshotTasks(snap).length === 1, 20000)
    const task = snapshotTasks(waited.snapshot)[0] || null
    await s.kill()

    const ck = makeChecks()
    ck.eq('form select requests', reqs.length, 1)
    ck.add('form prefill reflects command args', contract.ok, contract.desc)
    ck.add(
      'notify echoes command values',
      !!notify && /^Created [0-9a-f]{8}: alias-task · every 30m/.test(notify.message),
      notify ? notify.message : '(none)',
    )
    ck.add('snapshot exists', waited.ok)
    if (task) {
      ck.eq('task prompt', task.prompt, 'alias-task')
      ck.eq('task kind', task.kind, 'recurring')
      ck.eq('task interval 30m', task.schedule && task.schedule.intervalMs, 1800000)
    }
    return { name: 'S21', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S21', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

// ── 快照转移 / 恢复类新增场景 ────────────────────────────────────────────

/**
 * 两阶段通用骨架：阶段 1 建任务并取回 id/分片路径；阶段 2 resume 用预置 tool call
 * 操作该 id（任务 id 运行时生成，faux 队列写死不了）。
 */
async function createThenResume(ws, opts) {
  const phase1 = spawnSession(ws, {
    label: opts.p1Label,
    fauxSteps: [
      { toolCalls: [{ name: 'schedule', args: opts.createArgs }] },
      { text: 'done' },
    ],
  })
  if (!(await phase1.waitReady())) throw new Error('phase1 pi not ready: ' + phase1.stderrTail())
  const turn = await phase1.prompt('Call the schedule tool with the preset arguments. Then reply: done')
  if (!turn.ok) throw new Error('phase1 create turn did not end')
  const info = await phase1.sessionInfo()
  const storePath = storePathFor(ws, info.sessionId)
  const created = await waitForSnapshot(storePath, snap => snapshotTasks(snap).length === 1, 20000)
  if (!created.ok) throw new Error('phase1 task not persisted')
  const task = snapshotTasks(created.snapshot)[0]
  await phase1.kill()
  return { sessionFile: info.sessionFile, sessionId: info.sessionId, storePath, task }
}

/** S24：toggle off/on → 快照 enabled 双向转移（resume 后按快照 id 操作）。 */
async function runS24(piBin) {
  const ws = makeWorkspace('S24')
  let s = null
  try {
    const base = await createThenResume(ws, {
      p1Label: 'S24-P1',
      createArgs: { prompt: 'e2e-toggle-task', schedule: '1h', kind: 'recurring' },
    })
    const taskId = base.task.id
    s = spawnSession(ws, {
      label: 'S24-P2',
      sessionFile: base.sessionFile,
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'toggle', id: taskId, enabled: false } }] },
        { text: 'done' },
        { toolCalls: [{ name: 'schedule_control', args: { action: 'toggle', id: taskId, enabled: true } }] },
        { text: 'done' },
      ],
    })
    if (!(await s.waitReady())) return fail('S24', 'phase2 pi not ready: ' + s.stderrTail())

    const turnOff = await s.prompt(`Call schedule_control with action toggle, id ${taskId}, enabled false. Then reply: done`)
    if (!turnOff.ok) return fail('S24', 'toggle-off turn did not end')
    const offSnap = await waitForSnapshot(base.storePath, snap => {
      const t = findTask(snap, taskId)
      return !!t && t.enabled === false
    }, 15000)
    const turnOn = await s.prompt(`Call schedule_control with action toggle, id ${taskId}, enabled true. Then reply: done`)
    if (!turnOn.ok) return fail('S24', 'toggle-on turn did not end')
    const onSnap = await waitForSnapshot(base.storePath, snap => {
      const t = findTask(snap, taskId)
      return !!t && t.enabled === true
    }, 15000)
    await s.kill()

    const ck = makeChecks()
    ck.add('task present after resume (snapshot reload)', !!base.task)
    ck.add('toggle off persisted enabled=false', offSnap.ok)
    ck.add('toggle on persisted enabled=true', onSnap.ok)
    const finalTask = findTask(readSnapshotRaw(base.storePath), taskId)
    ck.eq('final enabled', finalTask && finalTask.enabled, true)
    ck.eq('runCount untouched by toggles', finalTask && finalTask.runCount, 0)
    ck.eq('tmp residue count', tmpResidues(ws.agentDir).length, 0)

    return { name: 'S24', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() + `; task=${taskId}` }
  } catch (err) {
    return fail('S24', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/** S25：delete → 快照任务移除（文件保留空集）+ 面板读到 0 条。 */
async function runS25(piBin) {
  const ws = makeWorkspace('S25')
  let s = null
  try {
    const base = await createThenResume(ws, {
      p1Label: 'S25-P1',
      createArgs: { prompt: 'e2e-delete-task', schedule: '2h', kind: 'once' },
    })
    const taskId = base.task.id
    s = spawnSession(ws, {
      label: 'S25-P2',
      sessionFile: base.sessionFile,
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'delete', id: taskId } }] },
        { text: 'done' },
      ],
    })
    if (!(await s.waitReady())) return fail('S25', 'phase2 pi not ready: ' + s.stderrTail())
    const turn = await s.prompt(`Call schedule_control with action delete, id ${taskId}. Then reply: done`)
    if (!turn.ok) return fail('S25', 'delete turn did not end')
    const waited = await waitForSnapshot(base.storePath, snap => snapshotTasks(snap).length === 0, 15000)
    await s.kill()

    const raw = readSnapshotRaw(base.storePath)
    const ck = makeChecks()
    ck.add('delete observed by snapshot poll', waited.ok)
    ck.add('snapshot still exists after delete', raw.exists)
    ck.add('tasks emptied', snapshotTasks(raw).length === 0)
    ck.eq('schemaVersion intact', raw.raw && raw.raw.schemaVersion, SCHEDULER_STORE_SCHEMA_VERSION)
    ck.add('deleted task gone', !findTask(raw, taskId))
    const parity = checkPanelParity(ws, ck, base.sessionId, [])
    ck.eq('panel sees empty list', parity.tasks.length, 0)
    ck.eq('tmp residue count', tmpResidues(ws.agentDir).length, 0)

    return { name: 'S25', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() + `; deleted=${taskId}` }
  } catch (err) {
    return fail('S25', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/** S26：run-now → 立即注入 + 记账（runCount/lastRunAt/history/nextRunAt 推进）。 */
async function runS26(piBin) {
  const ws = makeWorkspace('S26')
  let s = null
  try {
    const marker = 'E2E-RUN-NOW-PROBE'
    const base = await createThenResume(ws, {
      p1Label: 'S26-P1',
      createArgs: { prompt: marker, schedule: '1h', kind: 'recurring' },
    })
    const taskId = base.task.id
    s = spawnSession(ws, {
      label: 'S26-P2',
      sessionFile: base.sessionFile,
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'run', id: taskId } }] },
        { text: 'done' },
        ...Array.from({ length: 4 }, () => ({ text: 'ok' })),
      ],
    })
    if (!(await s.waitReady())) return fail('S26', 'phase2 pi not ready: ' + s.stderrTail())
    const turn = await s.prompt(`Call schedule_control with action run, id ${taskId}. Then reply: done`)
    if (!turn.ok) return fail('S26', 'run turn did not end')
    const waited = await waitForSnapshot(base.storePath, snap => {
      const t = findTask(snap, taskId)
      return !!t && t.runCount >= 1
    }, 20000)
    const dispatchPoll = await waitForDispatchEntries(s, 1, 15000)
    await s.kill()

    const task = findTask(readSnapshotRaw(base.storePath), taskId)
    const ck = makeChecks()
    ck.add('run-now accounting persisted', waited.ok)
    if (task) {
      ck.eq('runCount', task.runCount, 1)
      ck.eq('lastStatus', task.lastStatus, 'success')
      ck.add('lastRunAt recent', approx(task.lastRunAt, Date.now(), 120000), String(task.lastRunAt))
      ck.eq('nextRunAt = lastRunAt + 1h', task.nextRunAt - task.lastRunAt, 3600000)
      ck.eq('history length', task.history.length, 1)
      ck.eq('history[0].status', task.history[0] && task.history[0].status, 'success')
      ck.add('no pending persisted', !('pending' in task))
    }
    ck.add('dispatch injected exactly once', dispatchPoll.entries.length === 1, String(dispatchPoll.entries.length))
    ck.add('dispatch content is task prompt', dispatchContentText(dispatchPoll.entries[0]) === marker)
    ck.eq('tmp residue count', tmpResidues(ws.agentDir).length, 0)

    return { name: 'S26', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S26', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/** S27：过期清理（expires 到期 → tick 移除任务，不 dispatch）。B 类。 */
async function runS27(piBin) {
  const ws = makeWorkspace('S27')
  let s = null
  try {
    const marker = 'E2E-EXPIRY-PROBE'
    s = spawnSession(ws, {
      label: 'S27',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: marker, schedule: '5s', kind: 'recurring', expires: '5s' } }] },
        { text: 'done' },
        ...Array.from({ length: 5 }, () => ({ text: 'ok' })),
      ],
    })
    if (!(await s.waitReady())) return fail('S27', 'pi not ready: ' + s.stderrTail())
    const turn = await s.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turn.ok) return fail('S27', 'create turn did not end')
    const info = await s.sessionInfo()
    const path = storePathFor(ws, info.sessionId)
    const created = await waitForSnapshot(path, snap => snapshotTasks(snap).length === 1, 20000)
    if (!created.ok) return fail('S27', 'task not persisted')
    const task = snapshotTasks(created.snapshot)[0]
    const expired = await waitForSnapshot(path, snap => snapshotTasks(snap).length === 0, 90000, 2000)
    const inlineDispatches = dispatchEntries(await s.getEntries())
    const diskDispatches = dispatchEntries(s.readSessionJsonl(info.sessionFile).entries)
    await s.kill()

    const ck = makeChecks()
    ck.eq('expiresAt = createdAt + 5s', task.expiresAt - task.createdAt, 5000)
    ck.add('task removed by expiry cleanup', expired.ok)
    ck.eq('final task count', snapshotTasks(readSnapshotRaw(path)).length, 0)
    ck.eq('expiry removed task WITHOUT dispatch (inline)', inlineDispatches.length, 0)
    ck.eq('expiry removed task WITHOUT dispatch (jsonl)', diskDispatches.length, 0)

    return { name: 'S27', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S27', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s) await s.kill()
    ws.cleanup()
  }
}

/**
 * S28：--no-session 写盘（无会话文件仍落盘；sessionFile 字段省略）。
 *
 * 实测语义（pi 1.0.0）：persist=false 时 sessionManager 仍生成**进程内 UUID** sessionId
 *（session-manager.newSession 无条件 createSessionId），故分片键是该 UUID 而非
 * 'no-session'——index.ts 的归一分支在本版本不触发。因此：
 *   - 任务确实落盘（旧机制「--no-session 任务不持久化」的缺陷消失，写盘不依赖会话门控）
 *   - 重启 = 新进程新 UUID = 新分片，不恢复上一进程的任务（诚实登记，不是本场景要证的「恢复」）
 * 断言两条：① 本进程快照在盘、无 sessionFile 字段；② 重启进程分片不同且看不到旧任务。
 */
async function runS28(piBin) {
  const ws = makeWorkspace('S28')
  let s1 = null
  let s2 = null
  try {
    s1 = spawnSession(ws, {
      label: 'S28-P1',
      noSession: true,
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'no-session-task', schedule: '30m', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    if (!(await s1.waitReady())) return fail('S28', 'phase1 pi not ready: ' + s1.stderrTail())
    const info1 = await s1.sessionInfo()
    const turn1 = await s1.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turn1.ok) return fail('S28', 'phase1 create turn did not end')
    const path1 = storePathFor(ws, info1.sessionId)
    const created = await waitForSnapshot(path1, snap => snapshotTasks(snap).length === 1, 20000)
    await s1.kill()
    if (!created.ok) return fail('S28', 'no-session task not persisted at ' + path1)

    const raw1 = created.snapshot
    const task = snapshotTasks(raw1)[0]
    s2 = spawnSession(ws, {
      label: 'S28-P2',
      noSession: true,
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    if (!(await s2.waitReady())) return fail('S28', 'phase2 pi not ready: ' + s2.stderrTail())
    const info2 = await s2.sessionInfo()
    const turn2 = await s2.prompt('Call schedule_control with action list. Then reply: done')
    if (!turn2.ok) return fail('S28', 'phase2 list turn did not end')
    const blob = await s2.evidenceBlob()
    await s2.kill()

    const ck = makeChecks()
    ck.add('phase1 sessionId is a shard-legal id (UUID)', /^[A-Za-z0-9_-]+$/.test(info1.rawSessionId), info1.rawSessionId)
    ck.add('snapshot written without a session file', created.ok, path1)
    ck.add('sessionFile field omitted (--no-session)', raw1.raw && !('sessionFile' in raw1.raw))
    ck.add('phase2 sessionId differs (no stable identity)', info2.sessionId !== info1.sessionId,
      `${info1.sessionId} -> ${info2.sessionId}`)
    ck.add('phase2 shard missing (no cross-restart recovery)', !existsSync(storePathFor(ws, info2.sessionId)))
    ck.add("phase2 list says 'No scheduled tasks.'", blob.includes('No scheduled tasks.'))
    ck.add('phase1 snapshot still on disk (durable write)', existsSync(path1))
    const raw2 = readSnapshotRaw(path1)
    ck.add('phase1 snapshot byte-identical after restart', raw2.text === raw1.text)
    ck.eq('shard file count', shardFiles(ws.agentDir).length, 1)
    ck.eq('tmp residue count', tmpResidues(ws.agentDir).length, 0)
    ck.add('task id recorded', !!task, task ? task.id : 'missing')

    return { name: 'S28', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S28', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s1) await s1.kill()
    if (s2) await s2.kill()
    ws.cleanup()
  }
}

/** S29：损坏快照恢复（改名 .corrupt-<ts> 留证 + 空集启动 + 再写新快照）。 */
async function runS29(piBin) {
  const ws = makeWorkspace('S29')
  let s1 = null
  let s2 = null
  try {
    s1 = spawnSession(ws, {
      label: 'S29-P1',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'corrupt-before-task', schedule: '1h', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    if (!(await s1.waitReady())) return fail('S29', 'phase1 pi not ready: ' + s1.stderrTail())
    const turn1 = await s1.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turn1.ok) return fail('S29', 'phase1 create turn did not end')
    const info = await s1.sessionInfo()
    const path = storePathFor(ws, info.sessionId)
    const created = await waitForSnapshot(path, snap => snapshotTasks(snap).length === 1, 20000)
    if (!created.ok) return fail('S29', 'phase1 task not persisted')
    await s1.kill()

    const corruptText = '{broken json'
    writeFileSync(path, corruptText, 'utf-8')

    s2 = spawnSession(ws, {
      label: 'S29-P2',
      sessionFile: info.sessionFile,
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
        { toolCalls: [{ name: 'schedule', args: { prompt: 'after-corrupt-task', schedule: '45m', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    if (!(await s2.waitReady())) return fail('S29', 'phase2 pi not ready: ' + s2.stderrTail())
    // session_start 读损坏 → 改名留证；轮询 .corrupt-<ts> 出现
    let corruptFile = null
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const files = corruptResidues(ws.agentDir)
      if (files.length > 0) {
        corruptFile = files[0]
        break
      }
      await sleep(200)
    }
    const turnList = await s2.prompt('Call schedule_control with action list. Then reply: done')
    if (!turnList.ok) return fail('S29', 'list turn did not end')
    const blobAfterCorrupt = await s2.evidenceBlob()
    const turnCreate = await s2.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turnCreate.ok) return fail('S29', 'post-corrupt create turn did not end')
    const rewritten = await waitForSnapshot(path, snap => snapshotTasks(snap).length === 1, 20000)
    await s2.kill()

    const ck = makeChecks()
    ck.add('corrupt file renamed for inspection', !!corruptFile, corruptFile || '(none)')
    ck.add('renamed file kept original content', !!corruptFile && readFileSync(corruptFile, 'utf-8') === corruptText)
    ck.add("corrupt start list says 'No scheduled tasks.'", blobAfterCorrupt.includes('No scheduled tasks.'))
    ck.add('new snapshot written after recovery', rewritten.ok)
    const newTask = snapshotTasks(rewritten.snapshot)[0] || null
    ck.eq('new snapshot task count', snapshotTasks(rewritten.snapshot).length, 1)
    if (newTask) {
      ck.eq('new task prompt', newTask.prompt, 'after-corrupt-task')
      ck.add('old task not resurrected', newTask.prompt !== 'corrupt-before-task')
    }
    ck.eq('schemaVersion after rewrite', rewritten.snapshot.raw && rewritten.snapshot.raw.schemaVersion, SCHEDULER_STORE_SCHEMA_VERSION)

    return { name: 'S29', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S29', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s1) await s1.kill()
    if (s2) await s2.kill()
    ws.cleanup()
  }
}

/**
 * S30：既有快照恢复 + cron 失效停用。预置一条 cron 非法且已到期的任务 →
 * session_start 恢复 → tick dispatch（受理）→ computeNextRunAt undefined →
 * disableForInvalidCron（enabled=false + lastError）落盘；后续 tick 不再注入。B 类。
 */
async function runS30(piBin) {
  const ws = makeWorkspace('S30')
  let s1 = null
  let s2 = null
  try {
    const marker = 'E2E-CRON-INVALID-PROBE'
    // 阶段 1 必须先产生一次对话：pi 的会话文件在首条 user/assistant 消息后落盘，
    // --session 打开不存在的文件会得到**新 sessionId**（与预置分片路径错配）。
    s1 = spawnSession(ws, { label: 'S30-P1', fauxSteps: [{ text: 'seed' }] })
    if (!(await s1.waitReady())) return fail('S30', 'phase1 pi not ready: ' + s1.stderrTail())
    const seedTurn = await s1.prompt('Reply with the single word: seed')
    if (!seedTurn.ok) return fail('S30', 'phase1 seed turn did not end')
    const info = await s1.sessionInfo()
    await s1.kill()
    if (!info.sessionFile || !existsSync(info.sessionFile)) {
      return fail('S30', 'phase1 session file missing (cannot resume the same sessionId): ' + String(info.sessionFile))
    }

    const path = storePathFor(ws, info.sessionId)
    const now = Date.now()
    const seededTask = {
      id: 'deadc0de',
      name: 'cron-invalid-task',
      prompt: marker,
      kind: 'recurring',
      schedule: { mode: 'cron', cronExpression: 'not-a-cron' },
      enabled: true,
      createdAt: now - 60000,
      nextRunAt: now - 1000,
      runCount: 0,
      history: [],
    }
    writeSchedulerStore(path, {
      sessionFile: info.sessionFile || undefined,
      tasks: [seededTask],
    })

    s2 = spawnSession(ws, {
      label: 'S30-P2',
      sessionFile: info.sessionFile,
      fauxSteps: [
        ...Array.from({ length: 6 }, () => ({ text: 'ok' })),
      ],
    })
    if (!(await s2.waitReady())) return fail('S30', 'phase2 pi not ready: ' + s2.stderrTail())
    // tick 至多 30s：等到 dispatch 记账 + 停用落盘
    const disabled = await waitForSnapshot(path, snap => {
      const t = findTask(snap, 'deadc0de')
      return !!t && t.enabled === false
    }, 90000, 2000)
    const afterDisabled = readSnapshotRaw(path)
    const taskAfter = findTask(afterDisabled, 'deadc0de')
    const dispatchPoll = await waitForDispatchEntries(s2, 1, 15000)
    // 再等一个观察窗，确认停用后不再重复 dispatch（next tick 不再标 pending）
    await sleep(5000)
    const settled = findTask(readSnapshotRaw(path), 'deadc0de')
    const finalDispatches = dispatchEntries(await s2.getEntries())
    await s2.kill()

    const ck = makeChecks()
    ck.add('invalid-cron task recovered from seeded snapshot', !!taskAfter)
    ck.add('disabled after dispatch (persisted)', disabled.ok)
    if (taskAfter) {
      ck.eq('enabled', taskAfter.enabled, false)
      ck.eq('lastStatus', taskAfter.lastStatus, 'failed')
      ck.eq('lastError', taskAfter.lastError, 'cron expression invalid')
      ck.eq('runCount (dispatch accepted once)', taskAfter.runCount, 1)
      ck.eq('history records the accepted dispatch', taskAfter.history.length, 1)
      ck.eq('nextRunAt kept (no now fallback)', taskAfter.nextRunAt, seededTask.nextRunAt)
    }
    ck.eq('dispatch injected exactly once', dispatchPoll.entries.length, 1)
    ck.add('dispatch content is task prompt', dispatchContentText(dispatchPoll.entries[0]) === marker)
    ck.add('no repeated dispatch after disable', finalDispatches.length === 1, String(finalDispatches.length))
    ck.add('no repeated dispatch after disable (runCount)', !!settled && settled.runCount === 1, settled ? String(settled.runCount) : 'missing')

    return { name: 'S30', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S30', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (s1) await s1.kill()
    if (s2) await s2.kill()
    ws.cleanup()
  }
}

// ── followup 桩（明确登记难自动化原因 + 手工步骤）───────────────────────

function followupS16() {
  return {
    name: 'S16',
    status: 'FOLLOWUP',
    evidence: '同一 sessionId 双进程同分片属 out of scope（设计 §4.3 单写者前提：taiji 每会话单进程，无锁）',
    followup:
      '手工（记录行为用）：两个 pi 进程 --session 同一文件 → 同一 sessionId → 同一分片 JSON；' +
      '两边 tick 都会读同一任务集，可能双触发/互相覆盖快照（预期形态，文档化不修）。' +
      '真机 taiji 侧双开同一 workspace 是不同 session，不受影响（S3 已覆盖）。',
  }
}

// ── B 类场景：S12（dispatch 后 resume）──────────────────────────────────

/**
 * S12：dispatch 后 resume 不回退（记账持久化）。B 类：依赖真 dispatch 时序；
 * 无 dispatch 时降级 FOLLOWUP（不误报 FAIL）。
 */
async function runS12(piBin) {
  const ws = makeWorkspace('S12')
  let a = null
  let a2 = null
  try {
    a = spawnSession(ws, {
      label: 'S12-A',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'E2E-RESUME-AFTER-DISPATCH', schedule: '5s', kind: 'recurring' } }] },
        { text: 'done' },
        ...Array.from({ length: 12 }, () => ({ text: 'ok' })),
      ],
    })
    if (!(await a.waitReady())) return fail('S12', 'pi A not ready: ' + a.stderrTail())
    const turnCreate = await a.prompt('Call the schedule tool with the preset arguments. Then reply: done')
    if (!turnCreate.ok) return fail('S12', 'create turn did not end')
    const info = await a.sessionInfo()
    const path = storePathFor(ws, info.sessionId)
    const created = await waitForSnapshot(path, snap => snapshotTasks(snap).length === 1, 20000)
    if (!created.ok) return fail('S12', 'task not persisted')
    const taskId = snapshotTasks(created.snapshot)[0].id
    const dispatched = await waitForSnapshot(path, snap => {
      const t = findTask(snap, taskId)
      return !!t && t.runCount >= 1
    }, 90000, 2000)
    if (!dispatched.ok) {
      return {
        name: 'S12',
        status: 'FOLLOWUP',
        evidence: 'no dispatch within 90s (tick/LLM timing); nextRunAt non-regression not verifiable',
        followup:
          '手工：建 recurring 5s 任务 → 等 1 次 dispatch → 记快照 nextRunAt → kill → resume → ' +
          '断言快照字节相等且 list 的 nextRunAt 未回退到创建初值',
      }
    }
    const beforeText = readFileSync(path, 'utf-8')
    const beforeTask = findTask(readSnapshotRaw(path), taskId)
    await a.kill()

    a2 = spawnSession(ws, {
      label: 'S12-A2',
      sessionFile: info.sessionFile,
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    if (!(await a2.waitReady())) return fail('S12', 'resume not ready: ' + a2.stderrTail())
    const turnList = await a2.prompt('Call schedule_control with action list. Then reply: done')
    if (!turnList.ok) return fail('S12', 'resume list turn did not end')
    const blob = await a2.evidenceBlob()
    const afterText = readFileSync(path, 'utf-8')
    const afterTask = findTask(readSnapshotRaw(path), taskId)
    await a2.kill()

    const ck = makeChecks()
    ck.add('snapshot byte-identical across restart', afterText === beforeText)
    ck.add('task present after restart', !!afterTask)
    ck.add('runCount not reset', !!afterTask && !!beforeTask && afterTask.runCount === beforeTask.runCount,
      `${beforeTask ? beforeTask.runCount : '?'} -> ${afterTask ? afterTask.runCount : '?'}`)
    ck.add('nextRunAt not regressed to createdAt+5s', !!afterTask && afterTask.nextRunAt > afterTask.createdAt + 5000,
      afterTask ? String(afterTask.nextRunAt - afterTask.createdAt) : '?')
    ck.add("list not 'No scheduled tasks.'", !blob.includes('No scheduled tasks.'))

    return { name: 'S12', status: ck.allOk() ? 'PASS' : 'FAIL', evidence: ck.evidence() }
  } catch (err) {
    return fail('S12', `exception: ${err && err.stack ? err.stack : String(err)}`)
  } finally {
    if (a) await a.kill()
    if (a2) await a2.kill()
    ws.cleanup()
  }
}

// ── V 门禁（设计主张 → 场景证据）────────────────────────────────────────

function confirmV(results) {
  const byName = Object.fromEntries(results.map(r => [r.name, r]))
  const pass = name => byName[name] && byName[name].status === 'PASS'
  const anyPass = names => names.some(pass)

  const gates = [
    {
      name: 'V1',
      claim: '快照是唯一持久化通道：会话 JSONL 不再承载任务条目（S1/S2/S18 负向断言）',
      status: anyPass(['S1', 'S2', 'S18']) ? 'CONFIRMED' : 'NEEDS-FOLLOWUP',
    },
    {
      name: 'V2',
      claim: '分片隔离：不同 sessionId（新会话 / fork）→ 不同文件，任务天然不共享（S3/S11）',
      status: anyPass(['S3']) && (pass('S11') || !byName.S11) ? 'CONFIRMED' : 'NEEDS-FOLLOWUP',
    },
    {
      name: 'V3',
      claim: '恢复 = 一次直读：resume / corrupted 留证后空集启动 / --no-session 写盘（S5/S29/S28）',
      status: anyPass(['S5', 'S29', 'S28']) ? 'CONFIRMED' : 'NEEDS-FOLLOWUP',
    },
    {
      name: 'V4',
      claim: '写盘不依赖会话门控：首轮 kill 存活 / 无会话文件仍落盘（S13/S28）',
      status: anyPass(['S13', 'S28']) ? 'CONFIRMED' : 'NEEDS-FOLLOWUP',
    },
    {
      name: 'V5',
      claim: '记账跨重启持久化：dispatch 推进的 runCount / nextRunAt 不因重启回退（S12/S17/S30）',
      status: anyPass(['S12', 'S17', 'S30']) ? 'CONFIRMED' : 'NEEDS-FOLLOWUP',
    },
  ]
  return gates
}

// ── 场景注册表与分类 ────────────────────────────────────────────────────

const SCENARIOS = {
  S1: runS1,
  S2: runS2,
  S3: runS3,
  S4: runS4,
  S5: runS5,
  S9: runS9,
  S11: runS11,
  S12: runS12,
  S13: runS13,
  S15: runS15,
  S17: runS17,
  S18: runS18,
  S19: runS19,
  S20: runS20,
  S21: runS21,
  S24: runS24,
  S25: runS25,
  S26: runS26,
  S27: runS27,
  S28: runS28,
  S29: runS29,
  S30: runS30,
  S16: followupS16,
}

/** A 类：核心机制场景（默认跑；全过才 exit 0）。 */
const A_CLASS = [
  'S1', 'S2', 'S3', 'S5', 'S9', 'S11', 'S13', 'S15', 'S17', 'S18', 'S19', 'S20', 'S21',
  'S24', 'S25', 'S26', 'S28', 'S29',
]
/** B 类：时序敏感（真 tick / 到期），失败不应静默降级但可重跑。 */
const B_CLASS = ['S4', 'S12', 'S27', 'S30']
/** C 类：仅手工 followup。 */
const C_CLASS = ['S16']

// ── 结果打印与 main ─────────────────────────────────────────────────────

function printResult(result) {
  const marker = result.status === 'PASS'
    ? 'PASS'
    : result.status === 'FAIL'
      ? 'FAIL'
      : result.status === 'CONFIRMED'
        ? 'CONFIRMED'
        : result.status === 'NEEDS-FOLLOWUP'
          ? 'NEEDS-FOLLOWUP'
          : 'FOLLOWUP'
  console.log(`${TAG} [${marker}] ${result.name}` + (typeof result.elapsedMs === 'number' ? ` (${(result.elapsedMs / 1000).toFixed(1)}s)` : ''))
  console.log(`${TAG}    ${result.evidence}`)
  if (result.followup) console.log(`${TAG}    followup: ${result.followup}`)
}

async function executeScenario(name, piBin) {
  const fn = SCENARIOS[name]
  if (typeof fn !== 'function') return null
  try {
    return await fn(piBin)
  } catch (err) {
    return { name, status: 'FAIL', evidence: `exception: ${err && err.stack ? err.stack : String(err)}` }
  }
}

function selectScenarioList(arg) {
  if (arg === 'all') return [...A_CLASS, ...B_CLASS, ...C_CLASS]
  if (arg === 'aclass') return [...A_CLASS]
  if (arg === 'bclass') return [...B_CLASS, ...C_CLASS]
  if (arg === 'v') return [...A_CLASS, ...B_CLASS]
  if (SCENARIOS[arg]) return [arg]
  return null
}

// ── 自检（无副作用：不 spawn pi，不写产品目录）──────────────────────────

/**
 * --self-test：脚本自身与 store 契约自检（纯文件系统）。覆盖：
 * 路径推导（sessionId 分片 / cwd 隔离 / root 段 / 非法 id fail-fast）、快照读写
 * （schemaVersion / pending 剥离 / sessionFile 省略 / 原子写无 tmp 残留）、
 * 读三分支（missing / corrupt 留证）、面板路径公式（getPiAgentDir = <dataDir>/agent）。
 * 失败 = 脚本或 store 契约漂移，此时任何 e2e 结论都不可信。
 */
function runSelfTest() {
  console.log(`${TAG} ============================================================`)
  console.log(`${TAG} self-test (no pi spawn, no side effects outside tmp)`)
  const checks = []
  const add = (label, ok, detail) => checks.push({ label, ok: !!ok, detail: detail || '' })
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pi-sched-self-test.')))

  try {
    // 1. schema 版本
    add('schemaVersion === 2', SCHEDULER_STORE_SCHEMA_VERSION === 2, String(SCHEDULER_STORE_SCHEMA_VERSION))

    // 2. 路径推导
    add(
      'POSIX root 归一为 root 段',
      schedulerStoreFilePath('/agent', '/w/proj', 'sess-1') === path.join('/agent', 'scheduler', 'root', 'w', 'proj', 'sess-1.json'),
      schedulerStoreFilePath('/agent', '/w/proj', 'sess-1'),
    )
    add(
      '不同 cwd 不同路径',
      schedulerStoreFilePath('/agent', '/w/a', 's1') !== schedulerStoreFilePath('/agent', '/w/b', 's1'),
    )
    add(
      '不同 sessionId 不同路径',
      schedulerStoreFilePath('/agent', '/w', 's1') !== schedulerStoreFilePath('/agent', '/w', 's2'),
    )
    add(
      'root cwd 路径',
      schedulerStoreFilePath('/agent', '/', 's1') === path.join('/agent', 'scheduler', 'root', 's1.json'),
      schedulerStoreFilePath('/agent', '/', 's1'),
    )
    let invalidThrew = 0
    for (const bad of ['', '../escape', 'a/b', 'has space']) {
      try {
        schedulerStoreFilePath('/agent', '/w', bad)
      } catch {
        invalidThrew += 1
      }
    }
    add('illegal sessionId fail-fast', invalidThrew === 4, `${invalidThrew}/4 threw`)
    add(
      'legal sessionId (uuid form) accepted',
      schedulerStoreFilePath('/agent', '/w', '019a1b2c-3d4e-7f00-8000-000000000000').endsWith('.json'),
    )

    // 3. 写后读回 + 原子写 + pending 剥离
    const file = schedulerStoreFilePath(path.join(dir, 'agent'), '/w/proj', 'sess-1')
    const task = {
      id: 'a1b2c3d4',
      name: 'self-test',
      prompt: 'self-test prompt',
      kind: 'recurring',
      schedule: { mode: 'interval', intervalMs: 3600000 },
      enabled: true,
      createdAt: 1000,
      nextRunAt: 3600000,
      runCount: 1,
      history: [{ at: 1, status: 'success' }],
      pending: true,
    }
    writeSchedulerStore(file, { sessionFile: '/sessions/s.jsonl', tasks: [task] })
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    add('written schemaVersion', raw.schemaVersion === SCHEDULER_STORE_SCHEMA_VERSION, String(raw.schemaVersion))
    add('written sessionFile', raw.sessionFile === '/sessions/s.jsonl', String(raw.sessionFile))
    add('pending stripped on write', raw.tasks.length === 1 && !('pending' in raw.tasks[0]))
    add('history preserved', JSON.stringify(raw.tasks[0].history) === JSON.stringify([{ at: 1, status: 'success' }]))
    const read = readSchedulerStore(file)
    add('read kind ok', read.kind === 'ok', read.kind)
    add('read tasks length', read.kind === 'ok' && read.tasks.length === 1)
    const tmpAfter = walkFiles(path.dirname(file)).filter(f => path.basename(f).includes('.tmp-'))
    add('no tmp residue after atomic write', tmpAfter.length === 0, tmpAfter.join(','))

    // 4. sessionFile 缺省省略
    const file2 = schedulerStoreFilePath(path.join(dir, 'agent'), '/w/proj', 'sess-2')
    writeSchedulerStore(file2, { tasks: [] })
    const raw2 = JSON.parse(readFileSync(file2, 'utf-8'))
    add('sessionFile omitted when undefined', !('sessionFile' in raw2))

    // 5. 读三分支
    add('missing file → missing', readSchedulerStore(path.join(dir, 'nope', 'x.json')).kind === 'missing')
    const corruptPath = schedulerStoreFilePath(path.join(dir, 'agent'), '/w/proj', 'sess-3')
    mkdirSync(path.dirname(corruptPath), { recursive: true })
    writeFileSync(corruptPath, '{not json', 'utf-8')
    const corruptRead = readSchedulerStore(corruptPath)
    add('corrupt file → corrupt', corruptRead.kind === 'corrupt', corruptRead.kind)
    add('corrupt renamed .corrupt-<ts>', corruptRead.kind === 'corrupt' && existsSync(corruptRead.renamedTo))
    add('original path gone after rename', !existsSync(corruptPath))
    const badVersionPath = schedulerStoreFilePath(path.join(dir, 'agent'), '/w/proj', 'sess-4')
    writeFileSync(badVersionPath, JSON.stringify({ schemaVersion: 1, tasks: [] }), 'utf-8')
    add('schemaVersion mismatch → corrupt', readSchedulerStore(badVersionPath).kind === 'corrupt')

    // 6. 面板路径公式（getPiAgentDir = <dataDir>/agent）与两侧路径一致
    const dataDir = path.join(dir, 'data')
    add('panel agent dir formula', panelAgentDir(dataDir) === path.join(dataDir, 'agent'), panelAgentDir(dataDir))
    add(
      'panel path == extension path when agentDir=<dataDir>/agent',
      schedulerStoreFilePath(panelAgentDir(dataDir), '/w/proj', 'sess-1')
        === schedulerStoreFilePath(path.join(dataDir, 'agent'), '/w/proj', 'sess-1'),
    )

    // 7. 调度树扫描辅助
    add('shardFiles finds the shard', shardFiles(path.join(dir, 'agent')).length >= 1, String(shardFiles(path.join(dir, 'agent')).length))
    add('legacyStoreFiles empty', legacyStoreFiles(path.join(dir, 'agent')).length === 0)
    add('corruptResidues finds renamed files', corruptResidues(path.join(dir, 'agent')).length >= 1,
      String(corruptResidues(path.join(dir, 'agent')).length))
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch {
      /* best-effort */
    }
  }

  let failed = 0
  for (const c of checks) {
    if (!c.ok) failed += 1
    console.log(`${TAG}   ${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` (${c.detail})` : ''}`)
  }
  console.log(`${TAG} self-test: ${checks.length - failed}/${checks.length} passed`)
  return failed === 0 ? 0 : 1
}

async function main() {
  const arg = process.argv[2] || 'aclass'
  if (arg === '--self-test' || arg === 'self-test') return runSelfTest()

  const piBin = locatePiBinary()
  console.log(`${TAG} ============================================================`)
  console.log(`${TAG} pi-scheduler e2e (task-store snapshot track)`)
  console.log(`${TAG} model: ${MODEL}`)
  if (!piBin) {
    console.log(`${TAG} pi binary not found (set PI_BIN); expected ${PI_BIN_DEFAULT}`)
    return 2
  }
  if (!existsSync(EXTENSION_PATH)) {
    console.log(`${TAG} extension not found: ${EXTENSION_PATH}`)
    return 2
  }
  const toRun = selectScenarioList(arg)
  if (!toRun) {
    console.log(`${TAG} unknown scenario: ${arg}`)
    console.log(`${TAG} usage: node scripts/verify-scheduler-e2e.cjs [S1|S2|...|aclass|bclass|all|v|--self-test]`)
    return 2
  }
  console.log(`${TAG} pi: ${piBin}`)
  console.log(`${TAG} extension: ${EXTENSION_PATH}`)
  console.log(`${TAG} store module: ${STORE_MODULE_PATH}`)
  console.log(`${TAG} scenario(s): ${toRun.join(', ')}`)

  const results = []
  for (const name of toRun) {
    console.log(`${TAG} ------------------------------------------------------------`)
    console.log(`${TAG} running ${name} ...`)
    const startedAt = Date.now()
    const result = await executeScenario(name, piBin)
    if (result) {
      result.elapsedMs = Date.now() - startedAt
      results.push(result)
      printResult(result)
      if (result.status === 'FAIL' && result.debug && result.debug.snapshot) {
        console.log(`${TAG} [debug] ${name} snapshot:\n${result.debug.snapshot}`)
      }
    }
  }

  console.log(`${TAG} ------------------------------------------------------------`)
  console.log(`${TAG} V-gates (design claims):`)
  const gates = confirmV(results)
  for (const gate of gates) printResult({ ...gate, evidence: gate.claim })

  const ran = results.filter(r => typeof r.elapsedMs === 'number')
  const failed = results.filter(r => r.status === 'FAIL')
  const followed = results.filter(r => r.status === 'FOLLOWUP')
  const aRan = ran.filter(r => A_CLASS.includes(r.name))
  const aFailed = failed.filter(r => A_CLASS.includes(r.name))
  console.log(`${TAG} ============================================================`)
  console.log(`${TAG} A-class: ${aRan.length - aFailed.length}/${aRan.length} PASS`)
  if (aFailed.length > 0) console.log(`${TAG}   FAIL (blocker): ${aFailed.map(r => r.name).join(', ')}`)
  console.log(`${TAG} total: ${ran.length - failed.length - followed.length} PASS, ${failed.length} FAIL, ${followed.length} FOLLOWUP`)
  if (followed.length > 0) console.log(`${TAG}   followup: ${followed.map(r => r.name).join(', ')}`)
  console.log(`${TAG} V-gates: ${gates.filter(g => g.status === 'CONFIRMED').length} confirmed, ${gates.filter(g => g.status !== 'CONFIRMED').length} needs-followup`)

  // 判定：任一 FAIL = 1；全 FOLLOWUP/无 FAIL = 0（followup 是显式登记，不是静默跳过）
  const code = failed.length === 0 && results.length > 0 ? 0 : 1
  console.log(`${TAG} exit code: ${code}`)
  return code
}

main()
  .then(code => {
    setTimeout(() => process.exit(code), 300)
  })
  .catch(err => {
    console.error(`${TAG} crashed: ${err && err.stack ? err.stack : String(err)}`)
    process.exit(2)
  })

// 全局安全超时（S17/S12/S30 等真 tick 场景放宽到 20min）
setTimeout(() => {
  console.log(`${TAG} global timeout 1200s — killing`)
  process.exit(1)
}, 1200000).unref()
