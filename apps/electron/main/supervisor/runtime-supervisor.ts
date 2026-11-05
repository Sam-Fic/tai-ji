/**
 * RuntimeSupervisor Facade（implements IRuntimeSupervisor）。
 *
 * 对应 spec §4.2 M2「Process Supervisor」。组合子职责模块：
 *   port-discoverer（端口探测 + 残留 runtime 收割）
 *   process-control（spawn / kill 进程树）
 *   port-file（端口文件持久化）
 *
 * 这是「门面 + 协调者」模式：各子模块是纯函数/单一职责，Facade 负责串联
 * start/stop/restart 的完整时序，并持有 child/port 状态。
 *
 * [HISTORICAL] 不变量：
 * - start() 幂等：已有活进程则复用，不重复 spawn
 *   （实现时若 child 非空且未退出 exitCode===null，直接返回 this._port）
 * - start 完整时序：findAvailablePort → spawn → writePortFile（无健康等待轮询——
 *   启动成败只由 runtime 进程的 exit / ready 事件上报，事件驱动不做轮询判死）
 * - **快照广播改 listen-ready 驱动**（2026-11-05 hotfix：修复启动竞争）——旧时序
 *   「spawn 成功即组装快照并广播」下，renderer 比 listen 就绪早 ~1.3s 连接被拒
 *   （runtime spawn→listen 含同步迁移约 1.2-2.5s）；0.12.4 删除 ws 退避重连后首败即
 *   failed 终态，无事件驱动恢复通道。新时序：spawn 成功只落 pendingSpawn（端口/token/
 *   runtimeId 暂存），runtime listen 成功后经 IPC 发 ready 信令，onRuntimeReady 才组装
 *   快照（seq+1）并广播 runtime-port。renderer 首连拉取快照为 null → waiting-runtime
 *   等待态，ready 广播到达即连，此时端口必然已 listen。终局信号保持二元：ready 广播
 *   （成功）/ exit 广播 runtime-failed（失败），无时间阈值。
 * - startAndNotify 消除 main.ts whenReady/activate 重复：spawn 成功（ready 广播由
 *   onRuntimeReady 统一发），spawn 失败发 'runtime-error'
 * - [§6.1] 'runtime-port' 载荷 = 目标快照 RuntimeTargetSnapshot {seq, runtimeId, port, token}
 *   （channel 名不变；supervisor 持有快照单一权威，广播点统一经 currentSnapshot() 取载荷）
 * - **意外退出不自动重启**：onRuntimeExit 清状态后广播 'runtime-failed'，等待用户
 *   手动重试（restartRuntime IPC）；主动 stop() 置 stopping 标志，exit 不广播
 *
 * start 时序：
 * ```
 *   start():
 *     1. 若 child 活着 → return this._port（幂等）
 *     2. await stop()（先清旧的）
 *     3. port = await findAvailablePort()
 *     4. child = spawnRuntimeProcess(port, onExit, onReady)
 *     5. writePortFile(port)
 *     6. this._port = port; pendingSpawn = {child, runtimeId, token, port}; return port
 *     7. （异步）IPC runtime-ready 到达 → onRuntimeReady：组装快照（seq+1）+ 广播 runtime-port
 * ```
 *
 * 依赖方向：runtime-supervisor → interfaces + 子模块 + electron(BrowserWindow)
 */
import { BrowserWindow } from 'electron'
import type { ChildProcess } from 'node:child_process'
import type { IRuntimeSupervisor } from '../interfaces.js'
import { findAvailablePort, getPortOffset } from './port-discoverer.js'
import { spawnRuntimeProcess, stopRuntimeProcess } from './process-control.js'
import { writePortFile } from './port-file.js'
import { crashJournal } from '../logs/crash-journal.js'
// runtime-* 推送通道名同源 shared（ipc-channels SSOT，preload 侧同 import 消费）。
import { RUNTIME_PORT, RUNTIME_ERROR, RUNTIME_RESTARTING, RUNTIME_FAILED } from '@taiji/shared'
import type { RuntimeTargetSnapshot } from '@taiji/shared'

/** onRuntimeExit 登记清单分类结果（D1 runtime 自身事件挂点的 exit 侧归宿）。
 * 滚动重启（原 planned-shutdown 退出码 86 的唯一产生方）已删，该分类随之退役。 */
export type RuntimeExitJournalClass = 'crash' | 'suppressed'

/**
 * runtime 退出分类判别式（crash-forensics D1，纯函数可单测）：
 *
 * **异常死亡 ⇔ 非 before-quit 上下文 且 stopping=false**；两条件任一
 * 命中即不写 crash。逐条件依据：
 * - stopping → suppressed：stopping 被 stop() 全部调用方置位（app 退出 / 配置变更
 *   重启等主动停止），按 stopping 写 crash 会把每次正常退出记假 crash 污染归因
 *   #3——app 退出的 exit 落本分支**不写任何行**（shutdown 行由 before-quit 上下文写）。
 * - appQuitting（before-quit 上下文）→ suppressed：防御纵深——标记与 stop() 置位
 *   之间理论存在窗口，任一条件独立兜住「不把正常退出记 crash」。
 */
export function classifyRuntimeExit(input: {
  stopping: boolean
  appQuitting: boolean
}): RuntimeExitJournalClass {
  if (input.appQuitting || input.stopping) return 'suppressed'
  return 'crash'
}

/**
 * RuntimeSupervisor 实现。
 *
 * 使用方法：
 * ```ts
 * const supervisor = new RuntimeSupervisor()
 * const port = await supervisor.start()
 * await supervisor.startAndNotify(mainWindow)
 * await supervisor.stop()
 * ```
 */
export class RuntimeSupervisor implements IRuntimeSupervisor {
  private child: ChildProcess | null = null
  private _port: number | null = null
  /**
   * 当前 runtime 的实例标识（connection-datasync-ssot §6.1）：spawn 时与 token 同点签发，
   * 随进程生命周期存续（stop/exit 清 null）。快照字段之一，不单独暴露。
   */
  private _runtimeId: string | null = null
  /**
   * 连接目标快照（connection-datasync-ssot §6.1）：{seq, runtimeId, port, token} 的单一
   * 权威持有形态。seq = supervisor 进程内 spawn 计数（spawnSeq），每次 spawn +1——唯一
   * 职责是过期快照防护（消费方仅接受更高 seq）。生命周期与进程绑定：doStart 成功时组装，
   * stop()/onRuntimeExit 清 null；未启动（mock/等待态）读口返回 null，消费方进等待态。
   */
  private _snapshot: RuntimeTargetSnapshot | null = null
  /**
   * spawn 完成但 listen-ready 信令未到达期间的暂存（2026-11-05 hotfix：快照组装从
   * spawn 时推迟到 ready 时）。字段 = 组装快照所需的全部材料；exit / stop 时随
   * clearRuntimeState 清空（ready 迟到到达即丢弃）。语义 = 「进程已拉起、端口尚未
   * 就绪」的中间态——此期间 targetSnapshot 读口返回 null，renderer 拉取进
   * waiting-runtime 等待态，不发任何连接。
   */
  private pendingSpawn: { child: ChildProcess; runtimeId: string; token: string; port: number } | null = null
  /** spawn 计数（seq 来源）：supervisor 进程内单调递增，跨 stop/restart 不清零（过期快照防护依赖代数单调） */
  private spawnSeq = 0
  /**
   * 最近一次启动失败原因（RD-3#2 启动失败真因可见性）：startAndNotify / restartRuntime /
   * restartForConfigChange 失败时记录，start() 成功即清除（null = 当前无已知失败）。
   * renderer 经 get-runtime-start-error IPC 拉取——runtime-error / runtime-failed 推送
   * 可能早于 renderer 订阅安装（boot 竞态，webContents.send 静默丢失），拉取半边保证
   * 真因不丢。
   */
  private lastStartError: string | null = null
  /**
   * 主动停止标志：stop() 置位、start() 复位。onRuntimeExit 据此把 exit 归类为主动停止
   * （不广播 runtime-failed、不写 crash 行）。
   */
  private stopping = false
  /**
   * before-quit 上下文标记（main.ts before-quit handler 置位）——classifyRuntimeExit
   * 判别式输入。stopping 被 stop() 全部调用方置位，单看 stopping 无法区分「app 级退出」
   * 与「配置变更重启」等清场；本标记使 app 级退出上下文可区分
   * （crash-forensics D1 v6 第三挂点判别式显式化的配套输入）。
   */
  private appQuitting = false

  /** 当前监听端口（未启动为 null） */
  get port(): number | null {
    return this._port
  }

  /**
   * 当前连接目标快照（connection-datasync-ssot §6.1；未启动为 null）。
   * renderer 经 get-runtime-target-snapshot IPC 拉取；RUNTIME_PORT 广播载荷同形态。
   */
  get targetSnapshot(): RuntimeTargetSnapshot | null {
    return this._snapshot
  }

  /** 最近一次启动失败原因（成功启动后清除；null = 当前无已知失败）。renderer 经 get-runtime-start-error IPC 拉取 */
  get startError(): string | null {
    return this.lastStartError
  }

  /**
   * runtime 子进程在场性（main.ts before-quit 的 shutdown 行判据）：child 在且未退出。
   * before-quit 在 stop() 之前触发，此刻 child 大概率在场；runtime 未启动（mock）、
   * 已意外退出（onRuntimeExit 已清 child）、等待手动重试等形态均为 false——
   * 这些形态写 runtime shutdown 行是假事件（runtime 并未发生「关闭」）。
   * 判活形态对齐 start()/restartRuntime() 的 exitCode===null 检查（killed 不可靠的
   * [HISTORICAL] 教训）。
   */
  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  /**
   * 标记进入 app 级退出上下文（main.ts before-quit 调用；app 退出链不可逆，无复位路径——
   * start() 的复位仅为防御万一，正常时序不会在标记后再 start）。
   */
  markAppQuitting(): void {
    this.appQuitting = true
  }

  /** 端口偏移量（dev 模式 +DEV_PORT_OFFSET），clamp 到合法范围 */
  get portOffset(): number {
    return getPortOffset()
  }

  /**
   * 启动 runtime（幂等 + 并发串行化）。
   *
   * 时序：if child 活着 → 复用 → stop（清旧）→ findAvailablePort → spawn → writePortFile。
   * 复位主动停止标志（从任何路径进入时，清掉上次的 stopping）。
   *
   * 并发串行化（AM2，TOCTOU 双 spawn 从根源修复）：toggle 入口（restartForConfigChange）
   * 与启动链并发时，双方都可能通过幂等检查（检查在 await stop 之前完成）
   * → 双 spawn 抢端口。修复 = promise 链串行队列：
   * - 串行而非 join（共享同一 promise）：join 会让后到的 toggle 复用先到的启动结果——
   *   拿到旧配置的启动端口（幂等检查命中旧实例），违背「toggle 必须以新配置重启」的
   *   语义；串行队列保证每次 start 调用独立执行幂等判定。
   * - 前序失败不阻塞后序：链条以 settle 后的空 promise 续接，失败不毒化队列。
   * - 只串行化本方法与 restartForConfigChange：restartRuntime() 不包——其内部的 start()
   *   调用经公开入口已在队列内；doRestartForConfigChange 内部直调 doStart() 而非公开
   *   start()（再排队会等待自己 → 自死锁；doStart 无内部递归 start 调用，已核实）。
   *
   * @returns 实际监听的端口号
   */
  start(): Promise<number> {
    const run = this.startChain.then(() => this.doStart(), () => this.doStart())
    this.startChain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * start 串行队列尾指针：每个新 start 排在其后（AM2）。类型含 unknown 拒因——
   * 消费侧（start 包装）对 reject 分支显式续跑 doStart，不依赖前序成败。
   */
  private startChain: Promise<unknown> = Promise.resolve()

  /**
   * 配置变更触发的 runtime 重启（remote-access 开关切换入口；listen host 与
   * remote argv 是启动期一次性决策，配置落盘后必须真重启才生效）。
   *
   * 与 restartRuntime() 的差异：后者对存活进程幂等短路（直接广播端口不重启），
   * 恰恰违背「以新配置重启」的语义；本方法无条件 stop + 重新 spawn。
   *
   * 编排（收敛：原 bridge-handlers 复刻的 stop→start→广播编排上收至此，
   * renderer 可见协议变为 supervisor 单点）：
   * 1. 排入 startChain 串行队列（AM2：与手动 start 并发不双 spawn；
   *    队列续接语义同 start()——前序失败不毒化后序）；
   * 2. 队列内先广播 runtime-restarting 再动作（renderer 的 useConnection 在
   *    restarting 即收尾 pending 并停自动重连；广播晚于 stop 会让多秒 stop+spawn
   *    窗口内 renderer 无任何重连提示）；
   * 3. stop()（置 stopping 防 exit 误判意外死亡）→ doStart()（禁止调公开 start()——
   *    会再次排队 startChain 自死锁）→ 成功广播由 listen-ready 信令驱动
   *    （onRuntimeReady 统一发 runtime-port）。
   *
   * 失败语义：失败即补 runtime-failed 终态广播（renderer 经既有 failed 态拿重试按钮，
   * 协议不变量 closing：每次 runtime-restarting 广播必有终态广播——runtime-port
   * （ready 到达）或 runtime-failed；exit 意外死亡路径同样广播 runtime-failed，
   * 不变量保持）后 reject 上抛（invoke rejection，面板 toast 显形）；此时
   * runtime 已停，用户经既有 runtime-restart IPC 手动重试。
   *
   * @returns 重启后实际监听的端口号
   */
  restartForConfigChange(): Promise<number> {
    const run = this.startChain.then(
      () => this.doRestartForConfigChange(),
      () => this.doRestartForConfigChange(),
    )
    this.startChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** restartForConfigChange 的队列内执行体（广播 → stop → 重新 spawn → 广播端口/失败广播）。 */
  private async doRestartForConfigChange(): Promise<number> {
    // attempt=0：单次尝试（无自动重试，失败即终态广播）
    this.broadcastToAllWindows(RUNTIME_RESTARTING, { attempt: 0 })
    await this.stop()
    try {
      // doStart 前置 stop 已清 child，幂等检查不命中 → 必然真 spawn（新配置生效的保证）。
      // 快照广播不在此处发——listen-ready 信令到达时 onRuntimeReady 统一广播。
      const port = await this.doStart()
      return port
    } catch (e) {
      // 失败补 failed 终态广播：renderer 经既有 failed 态拿重试按钮，协议不变量
      // closing（restarting 必有终态广播，否则 renderer 停在 restarting 态不自愈，
      // 且 port=null 使面板 toggle 被 port!==null 门挡住，恢复通道 UI 不可达）。
      // payload 形态 { attempts, message }（attempts=0，无自动重试）；补广播后原样 rethrow。
      const message = e instanceof Error ? e.message : String(e)
      // toggle 失败同样刷新真因（RD-3#2，对齐 startAndNotify / restartRuntime 记录形态）：
      // renderer 若错过本次 runtime-failed 广播（boot 竞态 / 无窗口在场），拉取兜底通道
      // get-runtime-start-error 仍能取到真因——缺此行真因随当次广播窗口丢失
      this.lastStartError = message
      this.broadcastToAllWindows(RUNTIME_FAILED, { attempts: 0, message })
      throw e
    }
  }

  /** start() 的原函数体（幂等检查 + 完整启动时序），串行队列内执行（AM2）。 */
  private async doStart(): Promise<number> {
    // 复位主动停止标志（start 是新生命周期的开始，无论上次是主动 stop 还是意外退出）
    this.stopping = false
    // 同理复位 before-quit 上下文标记（防御性：正常时序 start 先于 before-quit，
    // 此处覆盖「标记后又有新 start」的非常规编排，防判别式误抑制真崩溃）
    this.appQuitting = false

    // 幂等：已有活进程则复用，不重复 spawn
    // [HISTORICAL] 用 exitCode===null 判活而非 !killed：自然崩溃时 killed 仍为 false，
    // 仅 exitCode 由 null 变为退出码。避免崩溃后检查误判存活、返回死端口（应用假死）。
    if (this.child && this.child.exitCode === null && this._port !== null) {
      // runtime 存活复用：历史启动失败已非当前事实，清除（startError 语义 = 当前无已知失败）
      this.lastStartError = null
      return this._port
    }
    // 先停掉已有的，等待其真正退出（stop 会置 stopping，spawn 后复位）
    await this.stop()

    const port = await findAvailablePort()
    console.log(`[runtime] Starting on port ${port}`)
    const spawned = spawnRuntimeProcess(
      port,
      (code) => this.onRuntimeExit(code),
      () => this.onRuntimeReady(),
    )
    this.child = spawned.child
    // §6.1：持有本生命周期实例标识（spawnRuntimeProcess 已与 token 同点签发并注入 env）
    this._runtimeId = spawned.runtimeId
    // spawn 成功即复位 stopping：此后本实例的 exit 是真实意外死亡信号（广播 runtime-failed）。
    // 快照不在此组装——listen-ready 信令到达才组装并广播（见 onRuntimeReady），
    // 消除「spawn 即广播 → renderer 连未就绪端口」的启动竞争。
    this.stopping = false

    writePortFile(port)
    this._port = port
    // 启动尝试已发起：清除启动失败记录（RD-3#2——真因只反映「当前无已知失败」之前的
    // 最近一次；与旧时序一致，spawn 成功即清，不等 ready）
    this.lastStartError = null
    // 暂存快照材料（ready 到达即组装）：child 引用用于代际校验之外的持有（exit 清空即
    // 迟到 ready 被丢弃）；seq 递增也推迟到 ready 时——「未就绪的 spawn 不消耗代数」，
    // 与旧注释「快照只在 spawn 成功的目标上成立」收紧为「只在 listen 就绪的目标上成立」。
    this.pendingSpawn = {
      child: spawned.child,
      runtimeId: spawned.runtimeId,
      token: spawned.token,
      port,
    }

    console.log(`[runtime] Spawned on port ${port} (awaiting listen-ready)`)
    return port
  }

  /**
   * listen-ready 信令处理（IPC `runtime-ready`，2026-11-05 hotfix：启动竞争修复）。
   *
   * runtime 在 WS server listen 成功后发信令（packages/runtime/src/index.ts 的
   * `[runtime] ready` 同点）。本方法 = 快照组装的唯一时点 + runtime-port 广播的
   * 统一入口：
   * 1. 代际校验：pendingSpawn 为空（exit / stop 已清）→ 迟到信令，丢弃（进程已死，
   *    广播死端口会把 renderer 连向黑洞）；
   * 2. 组装目标快照（seq+1, runtimeId, port, token 全部取自 pendingSpawn）；
   * 3. 广播 runtime-port 到全部存活窗口（renderer onRuntimePort → applyTargetSnapshot
   *    → 连接；此刻端口必然已 listen）。
   *
   * 无超时等待（时间机制删除裁决的延续）：等不到 ready 的进程要么 exit（→ runtime-failed
   *   广播，已有路径），要么卡在启动中途（renderer 停在 waiting-runtime 等待屏，有重试
   *    入口）——两者都是诚实终态，不用轮询定时器假装健康。
   */
  private onRuntimeReady(): void {
    const pending = this.pendingSpawn
    if (!pending) {
      console.warn('[runtime] runtime-ready received without pending spawn (stale/late) — dropped')
      return
    }
    this.pendingSpawn = null
    this.spawnSeq += 1
    this._snapshot = {
      seq: this.spawnSeq,
      runtimeId: pending.runtimeId,
      port: pending.port,
      token: pending.token,
    }
    console.log(`[runtime] listen-ready on port ${pending.port} — broadcasting target snapshot (seq ${this.spawnSeq})`)
    this.broadcastToAllWindows(RUNTIME_PORT, this.currentSnapshot())
  }

  /**
   * 启动 runtime 并把连接目标快照通知给渲染进程。
   *
   * spawn 成功：runtime-port 广播由 listen-ready 信令驱动（onRuntimeReady 统一发，
   * 经 broadcastToAllWindows 覆盖全部窗口——与其余广播点同形态）；本方法只负责
   * spawn 与失败路径。
   * 失败：win.webContents.send(RUNTIME_ERROR, { message })（不抛出）
   *
   * 消除 main.ts whenReady/activate 两处重复的 spawn + 通知逻辑。
   * [§6.1] RUNTIME_PORT 载荷为快照对象（channel 名不变，renderer 消费方按快照形态读取）。
   */
  async startAndNotify(win: BrowserWindow): Promise<number> {
    try {
      const port = await this.start()
      return port
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // 记录真因（RD-3#2）：renderer 经 get-runtime-start-error 拉取兜底 boot 竞态丢推送
      this.lastStartError = message
      console.error(`[runtime] startAndNotify failed: ${message}`)
      win.webContents.send(RUNTIME_ERROR, { message })
      return 0
    }
  }

  /**
   * 手动重启 runtime（用户从「runtime 不可用」状态条点击重试时调）。
   *
   * 场景：runtime 意外退出后前端展示 runtime-failed 状态条 + 重试按钮。
   * 用户点击 → 前端调 restartRuntime IPC → 此方法。
   * - runtime 已存活且 listen-ready（快照在场）：幂等，广播当前目标快照。renderer 侧
   *   applyTargetSnapshot 对 failed 态豁免幂等（同 seq 也转向重连）——「进程活着只是
   *   没连上」形态（如启动竞争首败）靠这条恢复，不会因幂等拒绝而点了没反应。
   * - runtime 已存活但 ready 未到（spawn 后 listen 前）：不广播（快照未组装），
   *   ready 到达时 onRuntimeReady 自会广播；此处 no-op。
   * - runtime 已死：走 start()，ready 信令到达后广播快照，失败刷新真因 + 补
   *   runtime-failed 终态广播（renderer 停留 failed 态，重试入口仍在；
   *   不 reject——bridge handler 不消费 rejection）
   */
  async restartRuntime(): Promise<void> {
    // runtime 存活 → 已就绪则幂等广播当前目标快照；未就绪等 ready 信令
    if (this.child && this.child.exitCode === null && this._port !== null) {
      if (this._snapshot) {
        console.log(`[runtime] restartRuntime: already ready on ${this._port}, broadcast target snapshot`)
        this.broadcastToAllWindows(RUNTIME_PORT, this.currentSnapshot())
      } else {
        console.log(`[runtime] restartRuntime: spawn in progress on ${this._port}, awaiting listen-ready broadcast`)
      }
      return
    }
    try {
      const newPort = await this.start()
      console.log(`[runtime] Manual restart spawned on port ${newPort} (awaiting listen-ready)`)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.lastStartError = message
      console.error(`[runtime] Manual restart failed: ${message}`)
      this.broadcastToAllWindows(RUNTIME_FAILED, { attempts: 0, message })
    }
  }

  /**
   * 停止 runtime 进程树（SIGTERM → 立即 SIGKILL 整棵树 → 等 exit 事件）。
   *
   * 时序见 process-control.ts 顶部注释。关键：先预记录后代 PID 再发信号。
   * 幂等：child 为空或已退出时直接 resolve。
   *
   * 置 stopping=true：onRuntimeExit 据此把 stop 期间的 exit 归类为主动停止
   * （不广播 runtime-failed、不写 crash 行）。
   */
  async stop(): Promise<void> {
    this.stopping = true
    await stopRuntimeProcess(this.child)
    this.clearRuntimeState()
  }

  /**
   * 清 runtime 进程状态（child/port/实例标识/目标快照/待就绪暂存同生命周期——stop 与
   * exit 两条终止路径的唯一清理出口；seq 不清零——代数单调，下次 spawn 重新签发）。
   * pendingSpawn 同清：进程已死，迟到的 ready 信令在 onRuntimeReady 被丢弃。
   */
  private clearRuntimeState(): void {
    this.child = null
    this._port = null
    this._runtimeId = null
    this._snapshot = null
    this.pendingSpawn = null
  }

  /**
   * runtime 子进程退出处理（意外死亡路径）。
   *
   * exit 是 supervisor 已知其死的权威信号（事件驱动，无轮询判死）：
   * 1. 清 child/port/实例标识/目标快照（幂等检查据此判定无活进程；防旧代快照——
   *    含其中 token——把重连目标拉回死实例）
   * 2. 崩溃登记清单（crash-forensics D1：runtime 自身事件由 main 侧写——runtime 被
   *    SIGKILL 时自己写不了，supervisor 是唯一在场者）。分类判别式见 classifyRuntimeExit：
   *    - crash → crash/process_exit
   *    - suppressed（stopping / before-quit 上下文）→ 零写入（app 级正常退出不记假 crash）
   * 3. 主动停止（stopping）→ 只记日志，不广播失败
   * 4. 意外死亡 → 广播 runtime-failed，等待用户手动重试（不自动重启）
   *
   * @param code 子进程退出码（null=被信号杀死）
   */
  private onRuntimeExit(code: number | null): void {
    // 清状态（幂等检查据此判定无活进程）；实例标识 / 目标快照 / 待就绪暂存随进程死亡
    // 失效（pendingSpawn 同清 = 迟到的 ready 信令将被 onRuntimeReady 丢弃）
    this.child = null
    this._port = null
    this._runtimeId = null
    this._snapshot = null
    this.pendingSpawn = null

    const verdict = classifyRuntimeExit({
      stopping: this.stopping,
      appQuitting: this.appQuitting,
    })
    if (verdict === 'crash') {
      crashJournal.append({ layer: 'runtime', event: 'crash', reason: 'process_exit', exitCode: code })
    }

    // 主动停止（app 退出 / 配置变更重启的清场）：不广播失败。appQuitting 与 stopping
    // 任一命中即抑制——before-quit 标记与 stop() 置位间理论存在窗口，退出上下文里
    // 广播「请手动重试」没有意义（对齐 classifyRuntimeExit 的 suppressed 判据）。
    if (this.stopping || this.appQuitting) {
      console.log(`[runtime] Process exited (code ${code}) during graceful stop`)
      return
    }

    console.log(`[runtime] Process exited unexpectedly (code ${code}) — broadcasting runtime-failed, waiting for manual retry`)
    this.broadcastToAllWindows(RUNTIME_FAILED, {
      attempts: 0,
      message: `runtime 进程已退出（${code === null ? '被信号终止' : `code ${code}`}），请点击重试手动重启`,
    })
  }

  /**
   * 广播事件到所有存活窗口（复用 broadcastWindowList 模式）。
   * 不存窗口引用（避免悬垂），每次实时 getAllWindows + isDestroyed 检查。
   */
  private broadcastToAllWindows(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }

  /**
   * RUNTIME_PORT 广播点的载荷取值（§6.1：4 广播点统一推 RuntimeTargetSnapshot）。
   * 构造不变量：4 个调用点都在 start/doStart 成功之后（成功即组装快照），运行时
   * _snapshot 必非 null；万一编排演进破坏该前提（广播点先于启动成功），显式 throw
   * 防止把 undefined/null 载荷推给 renderer（消费方无从区分「快照变更」与「快照清除」）。
   */
  private currentSnapshot(): RuntimeTargetSnapshot {
    if (!this._snapshot) {
      throw new Error('[runtime] RUNTIME_PORT broadcast invoked without an active target snapshot (start not completed)')
    }
    return this._snapshot
  }
}
