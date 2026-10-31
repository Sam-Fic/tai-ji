/**
 * 常驻事件循环滞后遥测（startup-readiness 设计 §7.1 / RL4；U5 遥测半边）。
 *
 * Node `monitorEventLoopDelay` 直方图常驻采样（resolution 20ms = Node 默认档，
 * 密集采样口径、非 5s 探针），滞后分布进结构化日志（logger.info 一行 meta JSON：
 * p50/p90/p99/max/mean/count）。
 *
 * 职责边界（设计 §7.1「常驻遥测」行原文）：验收与日常排障同一遥测源，同时是
 * 「分片被改坏」的常驻红灯；**不参与杀进程决策**（探针判据不变——supervisor
 * /health 探针与 watchdog 不读本模块任何输出，RL11 判据前提不被拖累）。本模块
 * 导出面（start/stop/snapshot/reset）均为观测原语，无进程控制接口。
 *
 * 生命周期：与结构化日志管线同生命周期（initLogger 接线启动；unref 定时器不钉住
 * 进程退出）。落盘节流与采样密度分离：直方图连续累积（20ms 桶宽），落盘按
 * EMIT_INTERVAL_MS 汇总一行、随后窗口重置——瞬态尖峰保留在窗口直方图内
 * （max/ms 段），不被低频落盘稀释。
 *
 * 零依赖（node:perf_hooks 内建，不新增 tsup noExternal 项）。
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

/**
 * 直方图桶宽（= 采样密度；密集采样口径，非 5s 探针）。取 Node monitorEventLoopDelay
 * 默认 20ms：分辨率必须小于 A3/RL4 判据阈值 50ms——空闲稳态的事件循环自然 tick
 * 间隔会被直方图量化为 ≈ 分辨率值，若分辨率高于判据阈值（如 100ms），空闲稳态
 * 即呈现 ~100ms「滞后」，> 50ms 判据被量化假象淹没（结构性不可满足）；20ms 档下
 * 空闲稳态量化为 ~20ms，> 50ms 仍是真滞后的有效信号。
 */
const HISTOGRAM_RESOLUTION_MS = 20
/** 落盘间隔：每 60s 一行汇总（采样连续，落盘低频——日志量与观测密度的折中）。 */
const EMIT_INTERVAL_MS = 60_000
/** ns → ms 换算（monitorEventLoopDelay 直方图原生单位 = 纳秒）。 */
const NS_PER_MS = 1e6
/** 快照字段保留两位小数（ms 级观测粒度足够，抑制浮点噪声）：换算尺度 = 10^2。 */
const PRECISION_SCALE = 100
/** 直方图 percentile 采集点（50/90/99 是滞后分布观测的通行三档）。 */
const PERCENTILE_P50 = 50
const PERCENTILE_P90 = 90
const PERCENTILE_P99 = 99

/** 落盘口（logger.info 形态注入，避免 telemetry ⇄ logger 循环 import）。 */
export type TelemetryLogFn = (message: string, meta?: Record<string, unknown>) => void

/** 当前窗口直方图快照（单测断言与进程内排障的读取口；单位 ms——真机 A3 验收剧本在 Node 进程外读 60s 窗口日志行，不经此快照）。 */
export type EventLoopDelaySnapshot = {
  /** 滞后样本数（窗口内事件循环轮次数级的采样计数）。 */
  count: number
  p50ms: number
  p90ms: number
  p99ms: number
  maxMs: number
  meanMs: number
  /** 遥测是否在跑（未启动 = 全零快照，消费方按「无数据」处理）。 */
  running: boolean
}

let histogram: IntervalHistogram | undefined
let emitTimer: ReturnType<typeof setInterval> | undefined
let logFn: TelemetryLogFn | undefined

/** 启动常驻遥测（幂等；重复调用零效果）。log = 结构化日志落盘口。 */
export function startEventLoopDelayTelemetry(log: TelemetryLogFn): void {
  if (histogram !== undefined) return
  logFn = log
  histogram = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS })
  histogram.enable()
  emitTimer = setInterval((): void => {
    if (histogram === undefined) return
    const snap = snapshotFrom(histogram)
    // 窗口重置：每行是「过去 EMIT_INTERVAL_MS 的滞后分布」，不是进程 lifetime 累积。
    histogram.reset()
    // 零样本窗口（极安静的事件循环也可能有样本；count=0 是空窗口）照实落盘一行
    // 心跳——常驻可观测性要求「看得见遥测还活着」。
    logFn?.('[event-loop-telemetry] delay histogram window', {
      count: snap.count,
      p50ms: snap.p50ms,
      p90ms: snap.p90ms,
      p99ms: snap.p99ms,
      maxMs: snap.maxMs,
      meanMs: snap.meanMs,
    })
  }, EMIT_INTERVAL_MS)
  emitTimer.unref()
}

/** 停止遥测并释放资源（幂等；测试与进程收尾用）。 */
export function stopEventLoopDelayTelemetry(): void {
  if (emitTimer !== undefined) {
    clearInterval(emitTimer)
    emitTimer = undefined
  }
  if (histogram !== undefined) {
    histogram.disable()
    histogram = undefined
  }
  logFn = undefined
}

/** 读当前窗口直方图快照（不重置；消费方 = 单测断言 event-loop-telemetry.test.ts 与进程内排障——真机 A3 验收剧本读 60s 窗口日志行，不经此函数）。 */
export function getEventLoopDelaySnapshot(): EventLoopDelaySnapshot {
  if (histogram === undefined) {
    return { count: 0, p50ms: 0, p90ms: 0, p99ms: 0, maxMs: 0, meanMs: 0, running: false }
  }
  return snapshotFrom(histogram)
}

function snapshotFrom(h: IntervalHistogram): EventLoopDelaySnapshot {
  const toMs = (ns: number): number => Math.round((ns / NS_PER_MS) * PRECISION_SCALE) / PRECISION_SCALE
  return {
    count: h.count,
    p50ms: toMs(h.percentile(PERCENTILE_P50)),
    p90ms: toMs(h.percentile(PERCENTILE_P90)),
    p99ms: toMs(h.percentile(PERCENTILE_P99)),
    maxMs: toMs(h.max),
    meanMs: toMs(h.mean),
    running: true,
  }
}

/** 测试隔离钩子：停测 + 清模块态（vitest afterEach 用）。 */
export function _resetEventLoopTelemetryForTest(): void {
  stopEventLoopDelayTelemetry()
}
