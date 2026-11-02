// src/kill-chain.ts
//
// pi 进程杀链：SIGKILL 直杀 + 三值完成判别（kill-chain-architecture 设计）。
//
// kill 的业务承诺是「目标进程将不再运行」，不是「我调用了 kill(2)」。完成判别三值：
//   already-dead      目标已达成（幂等成功——K2 语义，对已死进程 kill 是 no-op）
//   signal-delivered  目标必然达成（SIGKILL 不可捕获不可忽略，投递成功 = 死亡确定）
//   kill-failed       目标未达成、进程仍活（EPERM / 不可判定）——reject(KillSignalError)
// 「信号已发出即承诺兑现」只在投递成功时成立；把发信号失败折叠成 resolve 属签名说谎
// （下游据假事实运行：pending 永挂 / run 永无终态 / 收割计数虚高）。
//
// 分层契约（计算器/裁判）：本杀链只做确定性映射（发信号 + errno 分型 + 三态探针复核），
// 不内建重试、不裁决业务后果——三个调用方（runtime RpcClient / pi-subagent-cli
// killChild / killAllActiveChildren）按各自业务域裁决失败后果。
//
// 与 @zhushanwen/subagent-engine-sdk killChain 的关系（README「刻意不统一清单」第 6 条）：
// SDK 版是引擎中立层（SIGTERM → grace → SIGKILL + 有界收尸 + terminated/killed 判别，
// zcode 消费）；本版是 pi 进程杀链单源（SIGKILL 直杀 + 不等收尸的 settle + 三值判别）
// ——两个业务含义域的分别建模。probePidAlive 与 SDK 同名三态探针刻意各自私有实现
// （本包不 import SDK，依赖方向隔离）。
//
// 不设 grace 等待窗 / 收尸等待 / 重试：ADR-0122 裁决回收层不设时间窗兜底；幂等性由
// 「目标达成即成功」保证（kill-failed 后再调 kill 重新走全链，期间进程死了则落
// already-dead）。

/** 可杀子进程的结构形状（Node ChildProcess 的结构子集；测试可注入 fake）。 */
export interface KillableChild {
  /**
   * 已退判别（可选——Node ChildProcess 恒有，自造 fake 可省略）。任一非 null
   * 即已退出：杀链前置短路零信号（K2 语义：对已回收进程 kill 是幂等 no-op，
   * 不发信号、不抛、可重复）。
   */
  exitCode?: number | null
  /** 被信号杀死判别（与 exitCode 互备，见 exitCode 注释）。 */
  signalCode?: string | null
  /** 进程 pid（KillSignalError 诊断 + 三态探针目标；真实 ChildProcess 恒有，自造 fake 可省略）。 */
  readonly pid?: number
  /** 发信号。返回 true 当且仅当 kill(2) 成功；返回 false 时 errno 被吞（无法区分 ESRCH 与 EPERM）。 */
  kill(signal?: NodeJS.Signals | number): boolean
  /** 注册 exit 监听（onExit 收尾钩子载体；重复触发由调用方幂等保证）。 */
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/** 杀链完成判别（resolve 词表——两态都是合法完成）。 */
export type KillOutcome =
  | { status: 'signal-delivered' }   // SIGKILL 已成功投递（进程必死，收尾等 exit 事件）
  | { status: 'already-dead' }       // 进程已不存在（前置短路 / ESRCH / 探针复核确证）

/**
 * 杀链失败（reject 词表）——目标未达成，进程仍活。
 *
 * 对齐 DiskStoreReadError 模式：失败不折叠成合法空态，抛带诊断字段（pid/reason/errno）
 * 的分型错误，下游每个消费点显式登记降级形态。编程错误（EINVAL / ERR_UNKNOWN_SIGNAL /
 * ENOSYS——信号名非法）不进本分型，从杀链原样冒出（fail-fast）。
 */
export class KillSignalError extends Error {
  /** 杀链目标进程 pid（fake child 缺 pid 时 undefined）。 */
  readonly pid: number | undefined
  /**
   * 失败分型：'permission-denied' = EPERM（进程存在但不可杀）；'undetermined' =
   * kill() 返回 false 或携带罕见 errno，探针复核仍存活 / 不可判定——按进程存活保守处理。
   */
  readonly reason: 'permission-denied' | 'undetermined'
  /** kill() 抛错时携带的原始 errno code（false 路径无值）。 */
  readonly errno: string | undefined
  /** 原始抛出对象（kill() 抛错路径；false 路径无值）。 */
  readonly cause: unknown

  constructor(
    pid: number | undefined,
    reason: 'permission-denied' | 'undetermined',
    errno: string | undefined,
    cause: unknown,
  ) {
    super(
      `SIGKILL on pi process (pid: ${pid ?? 'unknown'}) failed: process is still alive `
      + `(reason: ${reason}${errno !== undefined ? `, errno: ${errno}` : ''})`,
    )
    this.name = 'KillSignalError'
    this.pid = pid
    this.reason = reason
    this.errno = errno
    this.cause = cause
  }
}

/** 已退判别（exitCode / signalCode 任一非 null；无字段的 fake 视为存活）。 */
function isAlreadyExited(child: KillableChild): boolean {
  return (child.exitCode !== undefined && child.exitCode !== null)
    || (child.signalCode !== undefined && child.signalCode !== null)
}

/** 错误对象的 errno code 提取（Error.code 或 undefined；非错误形态无值）。 */
function errnoOf(err: unknown): string | undefined {
  return err !== null && typeof err === 'object' && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined
}

/**
 * 单 pid 存活探针（`process.kill(pid, 0)`，三态）。
 *
 * true = 存活；false = 已死（ESRCH 确证）；undefined = 不可判定（EPERM = 进程存在
 * 但属他人 / 探针异常）——undefined 按存活保守处理（误判存活只多一次失败上报，
 * 误判死亡会漏杀活进程）。与 SDK kill-chain.ts probePidAlive 同名同语义的私有实现
 * （不 import SDK，见文件头分层说明）。
 */
function probePidAlive(pid: number | undefined): boolean | undefined {
  if (pid === undefined) return undefined
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    return undefined
  }
}

/**
 * 发信号 + 失败分型（单点，计算器核心）。
 *
 * 判据是**目标状态**（进程是否仍活），不是**调用是否抛错**——throw / return false 是
 * Node API 的表达形态，语义靠 errno + 探针复核还原：
 *   kill() → true                       signal-delivered
 *   抛 ESRCH / 返回 false 且探针 ESRCH   already-dead（等价成功，K2）
 *   抛 EPERM                             KillSignalError(permission-denied)
 *   false / 罕见 errno 且探针非 false    KillSignalError(undetermined)——保守按存活
 *   抛 EINVAL / ERR_UNKNOWN_SIGNAL / ENOSYS  原样冒出（编程错误，不属运行时失败分型）
 */
function deliverSignal(child: KillableChild): KillOutcome {
  let threw: unknown
  try {
    if (child.kill('SIGKILL')) return { status: 'signal-delivered' }
  } catch (err) {
    threw = err
    const thrownCode = errnoOf(err)
    if (thrownCode === 'EINVAL' || thrownCode === 'ERR_UNKNOWN_SIGNAL' || thrownCode === 'ENOSYS') {
      // 编程错误（信号名非法）：fail-fast 冒出，不进运行时失败分型词表
      throw err
    }
  }
  // false（无 errno）或抛错：按 errno 先判，判不了用探针复核
  const code = errnoOf(threw)
  if (code === 'ESRCH') return { status: 'already-dead' }
  if (code === 'EPERM') throw new KillSignalError(child.pid, 'permission-denied', code, threw)
  const alive = probePidAlive(child.pid)
  if (alive === false) return { status: 'already-dead' }
  throw new KillSignalError(child.pid, 'undetermined', code, threw)
}

/**
 * pi 进程杀链（SIGKILL 直杀，无等待窗）。
 *
 * 时序：
 *   1. 前置 exitCode/signalCode 短路（已回收进程 kill 是幂等 no-op，零信号）；
 *   2. SIGKILL 直杀 + 分型（deliverSignal）→ resolve(KillOutcome)（不等收尸——
 *      exit handler 由进程生命周期接手，投递成功即死亡确定，收尾只是等事实到达）；
 *      失败（进程仍活）→ reject(KillSignalError)；
 *   3. exit 事件到达时执行 onExit 收尾钩子（调用方清 pending 等）。
 *
 * 进程存活检查：前置 exitCode/signalCode 短路（pi-subagent-cli 的 killChild /
 * killAllActiveChildren 调用点无调用方检查，agent_end 回补 finally 的 kill 常落在
 * 已回收进程上，前置短路保「零信号」语义）。
 */
export function killPiProcess(
  child: KillableChild,
  opts?: {
    /** exit 事件到达时的收尾钩子（调用方 rejectAll pending 等）。 */
    onExit?: () => void
  },
): Promise<KillOutcome> {
  if (isAlreadyExited(child)) return Promise.resolve({ status: 'already-dead' })
  return new Promise<KillOutcome>((resolve, reject) => {
    // 先挂 exit 监听再发信号：onExit 钩子不丢（kill-failed 时进程不死、事件永不来，
    // 钩子自然不执行——收尾改由调用方在 reject 路径驱动，见设计 §2.3）
    child.on('exit', () => {
      opts?.onExit?.()
    })
    try {
      resolve(deliverSignal(child))
    } catch (err) {
      reject(err)
    }
  })
}
