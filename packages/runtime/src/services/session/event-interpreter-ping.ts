/**
 * PingProbe — pi 进程健康探测循环（ADR-0047，替代事件静默检测）。
 *
 * [协作对象，T4 拆分] 从 event-interpreter.ts 按变化原因抽出：ping 定时器、连续失败计数、
 * stream_warn 去重标志三个可变态及 tick 状态机自成封闭单元，与 interpreter 主编排无共享
 * 状态（解释见 event-interpreter.ts 头注「协作对象」节）。interpreter 经三个挂点委托：
 * turn-start → start()、turn-end → stop()、dispose → stop()。本对象不持有 interpreter
 * 主引用（send / pingPi / onSilentAbort 经窄依赖注入）。
 */
import type { ServerMessage } from '@taiji/shared'

/**
 * [ADR-0047] ping 间隔：turn 进行中每 60s 发一次 get_state 进程健康探测。
 *
 * 阈值依据见 ADR-0047「阈值依据」。平衡 RPC 流量（轻量）与响应速度。
 *
 * export 供测试 import（SR6 SSOT：测试跟随源码常量，不漂移）。
 */
export const PING_INTERVAL_MS = 60_000
/** [ADR-0047] 连续失败阈值：3 次（180s）→ 判定 pi 停滞 → onSilentAbort。export 供测试（SR6）。 */
export const PING_FAIL_THRESHOLD = 3
/** [AC-8] 连续 2 次失败（120s）→ 广播 message.stream_warn 一次（提示性，不中断）。export 供测试（SR6）。 */
export const PING_WARN_FAIL_COUNT = 2
/**
 * [pi-stall-detection D1] 观测超时窗：探测请求的有界等待上限——窗满 = 该次探测计失败。
 *
 * 量级依据：get_state 是 pi 侧同步内存读（无 await、无 IO），事件循环活时毫秒级响应；
 * 5s 与正常 RTT 相差三个数量级，悬挂（永不返回）是唯一落到窗外的形态。终值按 AS10
 * 实测校准（区间 5-10s），不变量：≤ PING_INTERVAL_MS（窗值大于探测间隔会让上一轮
 * 探测未判完下一轮又发出）。export 供测试（SR6 + RL9 常量护栏）。
 */
export const PING_OBSERVE_TIMEOUT_MS = 5_000

/** PingProbe 窄依赖（EventInterpreterOptions 的结构化视图，test mock 友好）。 */
export interface PingProbeDeps {
  sessionId: string
  /** WS 帧发送（stream_warn 广播路径）。 */
  send: (msg: ServerMessage) => void
  /**
   * [ADR-0047] ping get_state 探测回调（组合根注入）。
   *
   * 延迟解析 client：interpreter 在 session 创建时构造，那时 client 可能尚未 spawn。
   * 回调内部按当前 sessionId 取 pm.getClient(sessionId)?.probeState(PING_OBSERVE_TIMEOUT_MS)
   * （观测变体：请求级有界等待 + 窗满 cancel pending），client 未就绪时
   * 返回 undefined（计为一次失败但不抛错——AC-9：client 偶发未就绪不应让 interpret 批次崩溃）。
   *
   * 返回值语义（失败判定内涵三态，pi-stall-detection D1）：
   *   - resolve(非 undefined) → pi 健康（事件循环活，能响应 get_state）→ 清零失败计数
   *   - resolve(undefined)   → client 未就绪或拿不到 state → 计失败但不抛错（AC-9）
   *   - reject               → 探测失败 → 计失败。来源含三态：进程死（exit 链
   *                            rejectAll）/ 探测请求观测超时（probeState 窗满 reject，
   *                            事件循环挂死形态）/ stdin 写失败
   *
   * 设计权衡：ping 能穿透所有「pi 合理等待」场景（ask_user / 网络 / 文件锁）——
   * pi 阻塞在 await 时事件循环仍活，get_state 必快速响应（毫秒级）。观测超时窗
   * （PING_OBSERVE_TIMEOUT_MS）远大于正常 RTT，窗满即事件循环挂死或进程死的信号。
   * 详见 ADR-0047「ping 可行性验证」与 pi-stall-detection D1。
   *
   * 本层防御（tick 有界等待）：即使 pingPi 实现自身无界悬挂（如探测变体未接线 /
   * mock 缺陷），tick 也不跨窗等待——观测超时由 tick 内 PING_OBSERVE_TIMEOUT_MS
   * 有界等待兜住判定语义（与请求级 cancel 分层：cancel 归 probeState，判定归本模块）。
   */
  pingPi?: () => Promise<Record<string, unknown> | undefined> | undefined
  /** pi 停滞 abort 回调（连续 3 次失败触发；组合根调 sessionService.abort 复用兜底广播路径）。 */
  onSilentAbort?: (payload: { sessionId: string }) => void
}

export class PingProbe {
  /** ping 定时器句柄（null = 未在探测） */
  private timer: ReturnType<typeof setInterval> | null = null
  /** 当前连续失败计数（成功即清零） */
  private failCount = 0
  /** 本 turn 是否已广播过 message.stream_warn（避免重复） */
  private warned = false

  constructor(private readonly deps: PingProbeDeps) {}

  /**
   * 启动 ping 探测循环（turn-start 挂点）。
   *
   * 幂等：若已有循环在跑（如上一 turn 未正常 stop），先清。每次 turn-start 重置
   * 失败计数与 warned，确保跨 turn 独立计数（本 turn 第 1 次失败 = 新一轮，不继承上 turn）。
   */
  start(): void {
    this.stop()
    this.failCount = 0
    this.warned = false
    // [vitest 时序] setInterval 回调同步调度 tick；tick 内 await pingPi() 是微任务，
    // vi.advanceTimersByTimeAsync 能同时推进宏任务（setInterval tick）与被 flush 的微任务。
    this.timer = setInterval(() => { void this.tick() }, PING_INTERVAL_MS)
  }

  /** 停止 ping 探测循环（turn-end / dispose 挂点）。幂等。 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 单次 ping tick：调 pingPi() 探测 pi 是否响应 get_state。
   *
   * 成功（resolve 非 undefined）→ 清零失败计数 + warned 标志（AC-8b：中途成功重置累积）。
   * 失败三态（pi-stall-detection D1：悬挂也是失败）→ failCount++：
   *   ① reject（进程死 exit 链 / 探测观测超时 / stdin 写失败）
   *   ② resolve(undefined)（client 未就绪，AC-9）
   *   ③ 观测超时（await 有界等待窗满——pingPi 永不 settle 的悬挂形态）。
   * 达 2 次且 !warned 广播 WARN；达 3 次触发 onSilentAbort + stop()（AC-7）。
   */
  private async tick(): Promise<void> {
    const cb = this.deps.pingPi
    if (!cb) return // 未注入 pingPi（如组合根尚未接入）→ 不探测，不误 abort
    let ok = false
    try {
      const probe = cb()
      const state = probe === undefined ? undefined : await this.awaitBounded(probe)
      // resolve(undefined) 计为失败但不抛错（AC-9：client 未就绪不算崩溃信号，累积到 3 次仍 abort）
      ok = state !== undefined
    } catch (e) {
      // SR5：记日志（经 logger patchConsole 落盘，架构约定 #4），不静默吞错——pi 停滞
      // （进程死或事件循环挂死）的真实诊断依赖此处
      console.warn('[event-interpreter] ping get_state failed:', e)
      ok = false
    }
    // SR1（M1 并发 bug）：await 窗口（有界等待 ≤ PING_OBSERVE_TIMEOUT_MS ≤ PING_INTERVAL_MS，
    // RL9 护栏）期间 turn-end 可能已到来触发 stop()（清 timer）。此时已 in-flight 的 tick
    // 绝不能继续更新 failCount——否则 turn 已正常结束却因累积达阈值误触发 onSilentAbort，
    // 广播 aborted。timer === null 即被 stop，直接 return（不增计数、不广播、不 abort）。
    if (this.timer === null) return
    if (ok) {
      // 健康响应 → 清零（AC-8b：中途成功后需重新累积 2 次才 WARN）
      this.failCount = 0
      this.warned = false
      return
    }
    this.failCount += 1
    // AC-8：连续 2 次失败广播 message.stream_warn 一次（提示性，不中断流）
    if (this.failCount === PING_WARN_FAIL_COUNT && !this.warned) {
      this.warned = true
      this.deps.send({
        type: 'message.stream_warn',
        payload: {
          sessionId: this.deps.sessionId,
          // SR3：间隔由 PING_INTERVAL_MS 决定，不硬编码 60（常量 SSOT）
          // 1000 = ms→s 换算常数，无语义歧义
          // eslint-disable-next-line no-magic-numbers -- ms→s 单位换算常数，同 OUTBOUND_FRAME_* 豁免范式
          content: `pi 停滞：连续 ${this.failCount * (PING_INTERVAL_MS / 1000)}s 未响应健康探测`,
        },
      })
    }
    // ADR-0047 + pi-stall-detection D1：连续 3 次失败 → 判定 pi 停滞（未响应健康探测：
    // 进程死或事件循环挂死，不区分二者的处置分型归 onSilentAbort 消费方）→
    // onSilentAbort + 停止 ping（AC-7）
    if (this.failCount >= PING_FAIL_THRESHOLD) {
      this.stop()
      this.deps.onSilentAbort?.({ sessionId: this.deps.sessionId })
    }
  }

  /**
   * 探测 promise 的有界等待（pi-stall-detection D1 观测超时，判定级）。
   *
   * 窗内 settle → 透传 settle 结果；窗满（probe 永不 settle 的悬挂形态，PR1 盲区）→
   * 以观测超时错误 reject（计入失败三态之三）。与请求级超时（probeState 窗满 cancel
   * pending）分层：cancel 归 rpc-client 探测变体（RL8），失败判定归本模块。
   *
   * probe 的迟到 settle（本层超时先到、probe 后到）已被下方 then 消费——then 与
   * setTimeout 同步块内挂载，timer 回调必晚于同步挂载，无 unhandledRejection；
   * 迟到的 resolve/reject 对已 settle 的等待 promise 是 no-op。
   */
  private awaitBounded(probe: Promise<Record<string, unknown> | undefined>): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`ping get_state observation timeout (${PING_OBSERVE_TIMEOUT_MS}ms)`))
      }, PING_OBSERVE_TIMEOUT_MS)
      probe.then(
        (state) => {
          clearTimeout(timer)
          resolve(state)
        },
        (e: unknown) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
  }
}
