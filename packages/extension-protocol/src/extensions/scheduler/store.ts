// scheduler 任务库快照文件（scheduler-redesign 方案 B：任务库与会话事实分离）。
//
// 任务定义与调度记账不再写进 pi 会话 JSONL（custom entry event sourcing 已整体退役），
// 改为独立 JSON 快照：按 owner sessionId 分片、存 pi agentDir、原子替换写
// （tmp + rename）。会话 JSONL 只剩 dispatch 注入消息与用户对话。
//
// 分片键 = sessionId 的理由（设计 §4.3）：
// - 单写者免费获得：同一 session 同一时刻只有一个 pi 进程，分片文件天然无并发写；
// - resume 同 sessionId → 同文件直接恢复；fork 新 sessionId → 分片不存在 → 空任务集
//   （等价旧 fork owner 过滤语义，实现从过滤逻辑降为「不同文件天然不共享」）；
// - `<root>/<segments>` 目录层沿用 workspace 路径隔离（同 agentDir 下不同 cwd 互不干扰）。
//
// 本模块是扩展（pi 进程内，唯一写者）与 taiji scheduler-manager 面板（runtime worker，
// 只读者）的同源单实现——路径推导与文件形状两侧必须构造性一致，双实现会漂移。
// 含 node:fs 依赖，**不进 index 桶出口**（浏览器消费方结构性不触达 node 内建，
// 先例 = background-task-entry 子出口），经 `./scheduler-store` 子出口暴露。

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ScheduledTask, SchedulerStoreFile } from './types.js'
import { SCHEDULER_STORE_SCHEMA_VERSION, isSchedulerStoreFile } from './types.js'

// 快照 schema 版本常量、文件形状类型与形状校验函数单源于 ./types.js（零 node 依赖
// 纯模块——M0 契约期 @taiji/shared/execution 经 extension-protocol 主出口单源 re-export，
// 浏览器消费方不得触达本文件 node:fs）；此处 re-export 保持既有 `./scheduler-store`
// 子出口与包内 `./store.js` import 路径不变。
export type { SchedulerStoreFile } from './types.js'
export { SCHEDULER_STORE_SCHEMA_VERSION, isSchedulerStoreFile }

/**
 * 读结果三分支：
 * - `ok`：解析成功，tasks 为任务集（可为空数组）
 * - `missing`：文件不存在 = 空任务集（**正常路径而非异常**——新 session / fork / 从未建任务）
 * - `corrupt`：文件存在但不可解析 → 已改名 `.corrupt-<ts>` 留证，调用方按空任务集启动
 */
export type SchedulerStoreRead =
  | { kind: 'ok'; tasks: ScheduledTask[] }
  | { kind: 'missing' }
  | { kind: 'corrupt'; renamedTo: string }

/** 读写选项：降级日志注入点（包内零 logger 依赖，与 ReplayFoldOptions.warn 先例同构）。 */
export type SchedulerStoreOptions = {
  warn?: (message: string, context?: unknown) => void
}

/**
 * 任务库分片文件路径：`<agentDir>/scheduler/<root>/<segments>/<sessionId>.json`。
 *
 * - `agentDir`：pi 的 getAgentDir() 值（扩展侧 pi 官方导出；taiji 面板侧 = shared
 *   getPiAgentDir()，同一目录——runtime 注入 pi 进程的 PI_CODING_AGENT_DIR 即它）
 * - `cwd`：owner session 工作目录（workspace 路径隔离键）
 * - `sessionId`：pi SessionManager.getSessionId()（--no-session 等空值由调用方归一，
 *   本函数对空/非法值 fail-fast——静默拼出错误路径会让任务「写到别处」不可见）
 *
 * 旧 store 文件（`scheduler.json`，v1）与新分片（`<sessionId>.json`）同目录不同名，
 * 互不冲突；旧文件按用户裁决不迁移、留盘为孤儿。
 */
export function schedulerStoreFilePath(agentDir: string, cwd: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Invalid sessionId for scheduler store path: ${JSON.stringify(sessionId)}`)
  }
  const resolved = path.resolve(cwd)
  const parsed = path.parse(resolved)
  const segments = resolved.slice(parsed.root.length)
    .split(path.sep).filter(Boolean)
  const root = parsed.root
    .replaceAll(/[^a-zA-Z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .toLowerCase() || 'root'
  return path.join(agentDir, 'scheduler', root, ...segments, `${sessionId}.json`)
}

/** 内存任务 → 快照任务：剥离运行时标记 pending，history 逐项拷贝（写入口单点收口）。 */
function toStoreTask(task: ScheduledTask): ScheduledTask {
  const { pending: _p, history, ...rest } = task
  return { ...rest, history: history.map(h => ({ ...h })) }
}

/**
 * 读快照：一次 JSON.parse（设计 §4.5——「读一个文件重建任务集」，重放折叠 / fork owner
 * 过滤 / 活跃路径裁剪三件套已随 event sourcing 退役）。
 *
 * 失败语义（设计 §4.3）：
 * - ENOENT → `missing`（空任务集正常路径）
 * - 解析/形状失败 → 改名 `.corrupt-<ts>` 留证 + 返回 `corrupt`（调用方按空任务集继续，
 *   调度不中断——与旧「恢复失败显式降级」语义一致）；改名自身失败（只读卷等）不抛，
 *   仍返回 `corrupt` + warn——读侧永远不因留证失败而中断启动
 * - 其他读错误（EACCES 等）→ 上抛，由调用方决定降级（扩展装配点 catch 显式降级）
 */
export function readSchedulerStore(filePath: string, options?: SchedulerStoreOptions): SchedulerStoreRead {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) return { kind: 'missing' }
    throw err
  }

  const corrupted = (renamedTo: string): SchedulerStoreRead => {
    options?.warn?.('scheduler store corrupted; renamed for inspection, starting with empty task set', {
      filePath,
      renamedTo,
    })
    return { kind: 'corrupt', renamedTo }
  }

  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return corrupted(renameCorrupt(filePath))
  }
  if (!isSchedulerStoreFile(data)) {
    return corrupted(renameCorrupt(filePath))
  }
  return { kind: 'ok', tasks: data.tasks }
}

/** 快照 JSON 缩进（人可读优先：任务库文件是排障时直接 cat 的对象，2 空格缩进）。 */
const SNAPSHOT_INDENT = 2

/**
 * 写快照：全量序列化 + 原子替换（tmp 文件 → fsync → rename，POSIX rename 原子性）。
 * 崩溃时要么旧文件完整、要么新文件完整，无半写形态。
 * 目录不存在则递归创建（首写建目录）。写失败 throw——调用方（扩展 runtime 的
 * persistTasks catch）负责 warn + 下写点重试，内存态照常推进。
 */
export function writeSchedulerStore(filePath: string, file: Omit<SchedulerStoreFile, 'schemaVersion'>, options?: SchedulerStoreOptions): void {
  const payload: SchedulerStoreFile = {
    schemaVersion: SCHEDULER_STORE_SCHEMA_VERSION,
    ...(file.sessionFile !== undefined && { sessionFile: file.sessionFile }),
    tasks: file.tasks.map(toStoreTask),
  }
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, SNAPSHOT_INDENT) + '\n', 'utf-8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, filePath)
  } catch (err) {
    // tmp 残留清理 best-effort：rename 失败后 tmp 无消费方，留盘只会堆积。
    // ENOENT（tmp 未建成 / 已被清理）静默；其他失败不掩盖原写错误，warn 留诊断。
    try {
      fs.unlinkSync(tmp)
    } catch (cleanupErr) {
      if (!isEnoent(cleanupErr)) {
        options?.warn?.('scheduler store tmp cleanup failed after write error', {
          tmp,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        })
      }
    }
    throw err
  }
}

/** 损坏文件改名留证：`<path>` → `<path>.corrupt-<ts>`；失败时返回原路径并吞错（读侧不因留证失败中断）。 */
function renameCorrupt(filePath: string): string {
  const renamedTo = `${filePath}.corrupt-${Date.now()}`
  try {
    fs.renameSync(filePath, renamedTo)
    return renamedTo
  } catch {
    return filePath
  }
}

/** ENOENT 判定（code 属性优先，message 兜底——跨平台 fs 错误形态）。 */
function isEnoent(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'ENOENT') return true
  return err instanceof Error && /ENOENT/.test(err.message)
}
