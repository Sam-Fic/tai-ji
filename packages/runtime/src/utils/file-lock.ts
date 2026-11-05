/**
 * 跨进程同步/异步文件锁（D1a，integrity-hardening.md §3.1；锁统一 D1-A，
 * docs/architecture/file-lock-unification-and-reaper-sink.md §3.2）。
 *
 * 为什么存在：settings.json / auth.json / providers.json 等文件被 taiji runtime 与
 * pi 子进程双写（跨进程 RMW），Node 单线程只能保证进程内不交错，挡不住跨进程的
 * 「后写者基于旧快照覆盖先写者」。
 *
 * 锁原语统一（D1-A）：本模块不再本地封装 proper-lockfile，改从
 * `@zhushanwen/pi-file-lock/core` 引入零依赖自实现 mkdir 锁单次原语
 * （acquireLock / acquireLockSync；磁盘协议逐字段照抄 proper-lockfile@4.1.2——
 * 与 pi 内嵌 proper-lockfile 互斥同一把锁的兼容性权威源，协议细节见该包
 * lock-core.ts 头注释）。本文件职责 = 本地签名适配层（导出清单与旧版逐项
 * 一致，调用方零改动）。锁冲突（ELOCKED）不重试不等待，直接抛错——
 * 持锁方崩溃遗留的锁由人工删除锁目录恢复。
 * extension 侧 @zhushanwen/pi-file-lock 与本模块同源 lock-core，两侧协议一致
 * 由构造保证。
 *
 * realpath:false 统一：core 的路径规范化仅做字符串绝对化（path.resolve），
 * 不解析 symlink——与 pi auth-storage 及 extension 包现状一致。runtime async
 * 锁旧版（proper-lockfile 默认 realpath:true）属历史偏差，统一为 false 属纠正；
 * 锁目标路径（auth.json 在 getPiAgentDir()、settings 在 getDataDir() 派生目录）
 * 均动态推导、无 symlink 场景，影响面声明为零（设计 §3.2 D1-A）。
 *
 * [行为变化声明] 旧版 withFileLockAsync 的 onCompromised（proper-lockfile 保活
 * 定时器检测到锁 mtime 被刷新/锁目录消失时延迟抛出）在新实现下不存在——统一锁
 * 不做周期 touch（设计 §3.2 D1-A 显式决策：现有契约临界区毫秒级，远小于
 * stale/2，保活无必要）。后果：锁被外部删除/夺取后 fn 照常执行、release 对
 * 锁目录已消失静默成功（ENOENT 容忍）。AsyncFileLockOptions 对外形状不变
 * （ensure/logTag），消费方无感。
 *
 * 契约：
 *   - fn 内仅做既定读改写（读目标文件 + 纯内存变更 + 原子写），禁其他 I/O 与
 *     再次对本文件加锁（嵌套取锁必然 ELOCKED → fail-fast）。
 *     async 版 fn 允许 await。
 *   - 锁冲突 fail-fast 抛错（对齐 pi 放弃保存的语义），不静默不重排队。
 *
 * 归属：跨层共享叶子层 utils/（与 json-store 同层），无业务语义。
 *
 * 锁协议登记：docs/architecture/data-source-registry.md §6（与 extension 侧
 * 同一把 lockfile `<目标文件>.lock` 互斥）。
 */

import { acquireLock, acquireLockSync, type LockRelease } from '@zhushanwen/pi-file-lock/core'

/**
 * 同步跨进程文件锁内执行 fn：acquireLockSync（realpath:false）单次获取，
 * 锁冲突（ELOCKED）直接抛带恢复指引的错误（不重试不等待）；unlock 放
 * finally（fn 抛错也释放）。
 *
 * 锁前父目录确保由 core 内部兜底（recursive mkdir，已存在静默成功）。
 */
export function withFileLockSync<T>(filePath: string, fn: () => T): T {
  let release: (() => void) | undefined
  try {
    release = acquireLockSync(filePath)
  } catch (err) {
    if (isElocked(err)) throwLockConflict(filePath, err)
    throw err
  }
  try {
    return fn()
  } finally {
    release()
  }
}

function isElocked(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ELOCKED'
}

/**
 * 锁冲突（ELOCKED）统一错误出口：文案带恢复指引、cause 挂原始锁原语错误、code 归一
 * 'ELOCKED'（消费方按 code 判定）。sync/async 两版共用一份文案，改指引只动这里。
 */
function throwLockConflict(filePath: string, cause: unknown): never {
  throw Object.assign(
    new Error(
      `[file-lock] ${filePath} 写锁获取失败：锁被占用（持锁方临界区异常或已崩溃）。` +
      `恢复指引：确认无并发写入方后删除 ${filePath}.lock 锁目录重试。`,
      { cause },
    ),
    { code: 'ELOCKED' },
  )
}

// ──────────────────────── async 版（auth.json / providers.json 写锁共用） ────────────────────────

export interface AsyncFileLockOptions {
  /** 锁前调用方的初始化钩子（如 auth.json 确保文件存在——对齐 pi ensureFileExists 惯例）。 */
  ensure: () => void
  /** release 失败 warn 的日志前缀（如 'auth-storage' / 'provider-extras-store'）。 */
  logTag: string
}

/**
 * 跨进程异步文件锁：acquireLock（realpath:false）单次获取，锁冲突（ELOCKED）
 * 直接抛带恢复指引的错误（不重试不退避）。unlock 放 finally，失败仅 warn 不外抛
 * （fn 结果优先）。锁协议单点维护——auth-storage 与 provider-extras-store 共用，
 * 勿在调用方复制参数。
 */
export async function withFileLockAsync<T>(
  filePath: string,
  opts: AsyncFileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  opts.ensure()
  let release: LockRelease | undefined
  try {
    release = await acquireLock(filePath)
  } catch (err) {
    if (isElocked(err)) throwLockConflict(filePath, err)
    throw err
  }
  try {
    return await fn()
  } finally {
    try {
      await release()
    } catch (error) {
      // release 仅在非 ENOENT 的 fs 错误（权限等）时失败——不外抛（fn 结果优先），
      // warn 而非静默：锁被外部删等异常需要可观测
      console.warn(`[${opts.logTag}] release lock failed (continuing, lock may be compromised):`, error)
    }
  }
}
