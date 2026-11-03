/**
 * 存活探针（liveness probe）—— 检测 runtime「死 / 忙 / 假死」分级状态。
 *
 * 对应 spec §4.2 M2 子职责「存活探针」（W5 新增；2026-11-03 判据分级改造）。
 *
 * [HISTORICAL] 为什么需要它：
 * supervisor 原本只监听 child_process 的 'exit' 事件判定 runtime 是否存活。
 * 但 runtime 可能「进程活着（exitCode===null）但 HTTP 服务卡死」——
 * 例如 pi 死锁、event loop 阻塞、端口被防火墙静默 drop。
 * 此时 child 不会 exit，supervisor 误判存活，应用假死（前端 WS 永连不上但不触发重启）。
 *
 * 解决：周期性调 /health 端点，连续失败达阈值则判定「半活」，
 * 触发回调让 supervisor 强制重启（forceRestartForLiveness）。
 *
 * 判据分级（2026-11-03）：/health 跑在 runtime 主 event-loop 上（connection-manager
 * 的 http server），重算单块期间 /health 必超时——「忙被判成死」是单布尔判据的结构
 * 必然（历史事故：重算洪流期 liveness 3 连败强杀 runtime）。分级后：
 * - 进程活性信号（probeProcessAlive：kill(pid,0) + net.connect）先判「死」——
 *   进程消失 / 端口拒绝才可杀（连接建立由 OS accept 队列保证，与目标 JS 执行无关，
 *   event-loop 堵死时仍可连 =「忙」的可判定分界）。
 * - 端口可连但 /health 无应答 = 忙：不杀，记 WARN（进入忙沿一次）。
 * - 忙持续超假死阈值（LIVENESS_ZOMBIE_THRESHOLD_MS，5min——历史最重同步块实测
 *   11-12s，留 25 倍余量）= 假死（zombie）：回调 supervisor 先取证再杀。
 * - /health 结果携带的 eventLoopLag 遥测仍只作归因留档，不参与判死（IO 阻滞与
 *   真死锁在滞后分布上同形，D4 结论不变）。
 *
 * 设计为纯函数 + 独立 class（无 electron 依赖）：
 * - checkHealthEndpoint 可被单测（fetch 用 vi.stubGlobal 替换）
 * - LivenessMonitor 管理定时器，supervisor 组合它；进程活性探测可注入（probe 参数）
 *
 * 注意：本模块的 checkHealthEndpoint 与 health-checker.ts 的同名函数语义不同——
 *   health-checker 版本返回 boolean（给 waitForHealth 启动期轮询用，越简单越好）；
 *   本版本返回 { ok, ms }（给存活探针用，ms 用于日志/监控响应耗时）。
 *   两者独立维护，避免启动期轮询逻辑被存活探针的字段需求污染。
 *
 * 依赖方向：liveness-probe → 全局 fetch（Electron/Node 18+ 内置）
 *           + health-checker.probeProcessAlive（进程活性信号）
 */
import { probeProcessAlive, type ProcessProbeOutcome } from './health-checker.js'

/**
 * 假死（zombie）阈值（ms）：端口可连但 /health 连续 5min 无应答，才从「忙」升级
 * 为「假死」（先取证后杀）。判据取纯时间阈值，不附加 eventLoopLag 条件：/health
 * 无应答期间 runtime 无法上报 lag，滞后遥测只有最后健康时点的快照，「lag 持续顶格」
 * 在结构上不可观测；该意图已由时间阈值覆盖——历史最重同步块实测 11-12s，5min 留
 * 25 倍余量，重算单块是秒级~十秒级，5 分钟无应答才可能是真挂死。
 */
export const LIVENESS_ZOMBIE_THRESHOLD_MS = 5 * 60 * 1000

/**
 * 存活探针轮询间隔（ms）：本地回环 GET 轮询（0.2 QPS）对 runtime 压力可忽略，
 * 间隔只服务「发现速度」——紧事实采样，不留宽间隔慢判死。
 */
export const LIVENESS_INTERVAL_MS = 5_000

/**
 * 单次探针请求超时（ms）：/health 为本地回环轻端点（正常响应毫秒级，2s = 20 倍裕度），
 * fetch 逐请求硬超时（AbortSignal.timeout）保证单次请求不挂住——SIGSTOP 冻结等无
 * 响应形态按本次无应答计入，不会挂到 undici 默认 headersTimeout（300s）。超时只
 * 贡献无应答时长累计，是否升级忙/假死由 LIVENESS_ZOMBIE_THRESHOLD_MS 时间窗判定：
 * 健康期 event loop 短暂抖动至多误计一次无应答（下次成功即清零），秒级~十秒级重算
 * 单块只落 busy 记 WARN，不判死。
 */
export const LIVENESS_PROBE_TIMEOUT_MS = 2_000

/** 健康端点 URL（仅本地回环） */
const HEALTH_ENDPOINT = (port: number) => `http://127.0.0.1:${port}/health`

/**
 * 事件循环滞后遥测（判死归因留档字段，D4）——本模块是探针侧透传口：runtime
 * /health 健康应答体若携带 `eventLoopLag` 对象（字段名与 runtime 侧事件循环直方图
 * 快照同形，ms 单位）则透传至判死决策日志；未上报或形态不符时探针结果不带该
 * 字段，判死归因日志显式记 null（归因留档用，不做分支依据——IO 阻滞与真死锁在
 * 滞后分布上同形，见 D4）。
 *
 * 供给端现状：runtime 基线 /health 应答体 = { status, uptime }（packages/runtime/
 * src/transport/connection-manager.ts），不含本字段；在途 M1 遥测（startup-
 * readiness）形态 = runtime 结构化日志直方图行，同样不上报 /health——遥测供给
 * 接线归 runtime 侧，接入前判死日志 eventLoopLag 恒为 null。
 */
export type EventLoopLagTelemetry = {
  /** 滞后样本数（窗口内采样计数）。 */
  count?: number
  p50ms?: number
  p90ms?: number
  p99ms?: number
  maxMs?: number
  meanMs?: number
}

/** 遥测透传的数值字段清单（未登记键与非有限数值一律丢弃，防任意载荷透传）。 */
const TELEMETRY_NUMERIC_KEYS = ['count', 'p50ms', 'p90ms', 'p99ms', 'maxMs', 'meanMs'] as const

/**
 * 从 /health 响应体提取 `eventLoopLag` 遥测（纯函数）。响应体缺失 / 非 JSON /
 * `eventLoopLag` 非对象 / 六字段全非有限数值 = undefined（按「runtime 未上报」处理）。
 */
export function extractEventLoopLag(body: unknown): EventLoopLagTelemetry | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const raw = (body as { eventLoopLag?: unknown }).eventLoopLag
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const telemetry: EventLoopLagTelemetry = {}
  let picked = 0
  for (const key of TELEMETRY_NUMERIC_KEYS) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      telemetry[key] = value
      picked += 1
    }
  }
  return picked > 0 ? telemetry : undefined
}

/** 探针结果：ok=是否健康，ms=响应耗时（仅健康时带，用于日志） */
export interface HealthProbeResult {
  ok: boolean
  ms?: number
  /**
   * 事件循环滞后遥测（健康应答体 `eventLoopLag` 字段透传，判死归因留档通道）。
   * undefined = runtime 未上报（当前基线 /health 不携带该字段）。
   */
  eventLoopLag?: EventLoopLagTelemetry
}

/**
 * 调 HTTP /health 验证 runtime 存活状态（带响应耗时）。
 *
 * [HISTORICAL] 不变量：
 * - 永不向调用方抛错（探针失败由调用方累计计数处理，而非崩溃）
 * - 仅 2xx 视为健康（response.ok）；非 2xx / fetch reject（含逐请求超时 AbortError）均返回 ok=false
 * - 健康时附带 ms（响应耗时，用于日志诊断慢响应）；不健康时不带（无意义）
 *
 * @param port runtime 监听端口
 * @returns { ok, ms? } —— ok=false 表示未就绪或连不上
 */
export async function checkHealthEndpoint(port: number): Promise<HealthProbeResult> {
  const startedAt = Date.now()
  try {
    const response = await fetch(HEALTH_ENDPOINT(port), {
      signal: AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS),
    })
    if (response.ok) {
      // 事件循环滞后遥测透出：健康应答体读 eventLoopLag 可选字段（runtime 基线
      // 应答体不携带，供给端现状见 EventLoopLagTelemetry 头注）。
      // 读体失败（非 JSON / 无 json 通道 / 流中断）按无遥测处理——探针判定只看响应
      // 状态，遥测缺席不影响 ok 语义；读体超时由同一 AbortSignal 覆盖。读体调用本身
      // 兜底在 Promise 链内（response.json 通道缺席时同步抛错不得翻转 ok——fetch stub
      // 形态见 supervisor-health-liveness 测试）。
      const body: unknown = await Promise.resolve()
        .then(() => response.json())
        .catch(() => undefined)
      return { ok: true, ms: Date.now() - startedAt, eventLoopLag: extractEventLoopLag(body) }
    }
    return { ok: false }
  } catch {
    // fetch reject（ECONNREFUSED / 超时 / DNS 失败）：视为「不健康」，不抛错
    return { ok: false }
  }
}

/** 探针判定不可杀进程时回调的裁决类别：
 * - dead：进程不存在 / 端口拒绝连接（确证死，直接杀）
 * - zombie：端口可连但连续 LIVENESS_ZOMBIE_THRESHOLD_MS 无任何 HTTP 应答（假死，先取证再杀）
 */
export type LivenessVerdict = 'dead' | 'zombie'

/** 进入忙态时的上下文（busy 沿回调载荷，WARN 归因留档用）。 */
export interface LivenessBusyInfo {
  /** 本次忙态的起点时刻：最近一次健康（或启动）以来首个无应答 tick 的 epoch ms */
  unansweredSince: number
  /** 无应答已持续时长 ms（回调时刻快照） */
  unansweredMs: number
  /** 最后一次健康应答的 eventLoopLag 遥测（runtime 未上报/无健康历史 = undefined） */
  eventLoopLag?: EventLoopLagTelemetry
}

/** LivenessMonitor 构造参数 */
export interface LivenessMonitorOptions {
  /** 要探测的 runtime 端口 */
  port: number
  /** runtime 进程 pid（进程活性探测的输入；一次 monitor 生命周期绑定一次 spawn） */
  pid: number
  /** 判定不可杀级别时调（dead=杀 / zombie=先取证再杀；触发后探针自停，不重复触发） */
  onUnhealthy: (verdict: LivenessVerdict) => void
  /** 进入忙态沿回调（每轮忙态触发一次，busy 期间不重复；省略 = 静默，探针行为不变） */
  onBusy?: (info: LivenessBusyInfo) => void
  /** 轮询间隔 ms（默认 LIVENESS_INTERVAL_MS） */
  intervalMs?: number
  /** 假死阈值 ms（默认 LIVENESS_ZOMBIE_THRESHOLD_MS；测试注入短阈值） */
  zombieThresholdMs?: number
  /**
   * 进程活性探测注入点（默认 health-checker.probeProcessAlive）。测试注入 stub，
   * 免起真实进程/端口。
   */
  probe?: (pid: number, port: number) => Promise<ProcessProbeOutcome>
}

/**
 * 存活探针定时器管理器（四态状态机：healthy / busy / dead / zombie）。
 *
 * supervisor 在 start() 成功后创建并 start()，在 stop() 时 stop()。
 *
 * 状态转移表（tick 事件 × 现态 → 次态；探测输入 = 进程活性 + /health 两级）：
 *
 * | 现态    | 事件（探测结果）                       | 次态    | 动作 |
 * |---------|----------------------------------------|---------|------|
 * | *       | 进程消失 / 端口拒绝                    | dead    | onUnhealthy('dead')，探针自停 |
 * | any     | 端口可连 + /health 2xx                 | healthy | 清无应答窗口，留存健康快照 |
 * | healthy | 端口可连 + /health 无应答              | busy    | 记无应答起点，onBusy 沿回调 |
 * | busy    | 端口可连 + /health 无应答（未超阈值）  | busy    | 累计无应答时长 |
 * | busy    | 无应答持续 ≥ zombieThreshold           | zombie  | onUnhealthy('zombie')，探针自停 |
 * | busy    | 端口连接超时（非拒绝）                 | busy    | 同无应答累计（冻结形态按忙处理） |
 *
 * 杀只用于「确证死」（dead）与「持续无应答超 25 倍余量」（zombie）；
 * 「忙」（重算堵 event-loop）只记 WARN 不杀——误杀在判据结构上消除，不靠调参。
 *
 * [HISTORICAL] 用 setInterval 而非递归 setTimeout：
 *   间隔固定（LIVENESS_INTERVAL_MS），不受上次探测耗时影响（探测快则下次仍等满间隔）。
 *   单次探测不会重入（探测链不会卡到下一次 tick——probeProcessAlive 与 fetch 均带硬超时）。
 */
export class LivenessMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  /** 状态机现态（探针内部态，不外泄——supervisor 只消费回调） */
  private state: 'healthy' | 'busy' = 'healthy'
  /** 本次无应答窗口起点（null = 无在途无应答窗口，healthy 态） */
  private unansweredSince: number | null = null
  /** 已触发的不可杀裁决（dead/zombie 回调只发一次，触发后探针自停） */
  private triggered = false
  /** 最后一次健康应答的探针结果（含遥测）——判死归因日志的读取口，stop 不清（实例随 stop 一起被丢弃）。 */
  private lastHealthySnapshot: HealthProbeResult | null = null
  /** 最后一次健康应答时刻（epoch ms；null = 启动以来无健康应答）。 */
  private lastHealthyTime: number | null = null
  private readonly port: number
  private readonly pid: number
  private readonly onUnhealthy: (verdict: LivenessVerdict) => void
  private readonly onBusy: ((info: LivenessBusyInfo) => void) | null
  private readonly intervalMs: number
  private readonly zombieThresholdMs: number
  private readonly probe: (pid: number, port: number) => Promise<ProcessProbeOutcome>

  constructor(opts: LivenessMonitorOptions) {
    this.port = opts.port
    this.pid = opts.pid
    this.onUnhealthy = opts.onUnhealthy
    this.onBusy = opts.onBusy ?? null
    this.intervalMs = opts.intervalMs ?? LIVENESS_INTERVAL_MS
    this.zombieThresholdMs = opts.zombieThresholdMs ?? LIVENESS_ZOMBIE_THRESHOLD_MS
    this.probe = opts.probe ?? probeProcessAlive
  }

  /**
   * 最后一次健康应答的探针结果（判死归因日志的遥测读取口：`eventLoopLag` 来自
   * runtime 最后一次能响应 /health 时的上报——判死时刻 runtime 已无响应，遥测只能
   * 是最后健康时点的快照）。无健康应答历史 = null。
   */
  get lastHealthyResult(): HealthProbeResult | null {
    return this.lastHealthySnapshot
  }

  /** 最后一次健康应答时刻（epoch ms；null = 启动以来无健康应答，判死日志据此记失联时长 null）。 */
  get lastHealthyAt(): number | null {
    return this.lastHealthyTime
  }

  /** 启动周期探针（幂等：已启动则无操作） */
  start(): void {
    if (this.timer) return
    this.state = 'healthy'
    this.unansweredSince = null
    this.triggered = false
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    // unref：探针定时器不应阻止进程退出（Electron 主进程正常退出时无需等它）
    this.timer.unref()
  }

  /** 停止探针并复位状态（幂等：未启动则无操作） */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.state = 'healthy'
    this.unansweredSince = null
    this.triggered = false
  }

  /**
   * 单次探测（状态机 tick）。探测自停语义：dead/zombie 回调发出后本实例不再
   * 探测（triggered 标志）——处置链（杀 + 重启）会新建生命周期，旧探针静默退场，
   * 不依赖调用方及时 stop。
   */
  private async tick(): Promise<void> {
    if (this.triggered) return
    const processProbe = await this.probe(this.pid, this.port)
    if (processProbe.kind === 'dead') {
      this.trigger('dead')
      return
    }
    if (processProbe.kind === 'unreachable' && processProbe.reason === 'refused') {
      // 进程在但 listen 句柄已不在 = HTTP 服务死透，与进程消失同判（确证死）
      this.trigger('dead')
      return
    }

    // 进程活性无虞（alive 或 connect 超时的冻结形态）→ /health 服务健康探测
    const result = await checkHealthEndpoint(this.port)
    const now = Date.now()
    if (result.ok) {
      this.state = 'healthy'
      this.unansweredSince = null
      this.lastHealthySnapshot = result
      this.lastHealthyTime = now
      return
    }

    if (this.unansweredSince === null) {
      this.unansweredSince = now
    }
    const unansweredMs = now - this.unansweredSince
    if (this.state !== 'busy') {
      // busy 沿：只在本轮转入忙态时回调一次（每轮忙态一条 WARN，不逐 tick 刷屏）
      this.state = 'busy'
      this.onBusy?.({
        unansweredSince: this.unansweredSince,
        unansweredMs,
        eventLoopLag: this.lastHealthySnapshot?.eventLoopLag,
      })
    }
    if (unansweredMs >= this.zombieThresholdMs) {
      this.trigger('zombie')
    }
  }

  /** 触发不可杀裁决：回调一次 + 探针自停（状态保持，实例随即被处置链丢弃） */
  private trigger(verdict: LivenessVerdict): void {
    if (this.triggered) return
    this.triggered = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.onUnhealthy(verdict)
  }
}
