/**
 * 静默判定矩阵测试（pi-stall-detection U4，D0 约定文件名——testCommand 确定性载体）。
 *
 * 覆盖验收条款（设计 §4.2 对应行）：
 * - RL4：T/T_hint 单源联动推导等式 + 逐窗不等式 + 配置维超界降级触发（两口径不并存——
 *   实施裁决 = 主案超界降级，resolveStallMatrixArms 纯函数消费配置快照）；
 * - RL5：豁免锚点（compacting / ask_user）暂停计时不产生漏报/误报；锚点消失后从既有静默
 *   时长继续（不重置）；判死后辅助提示清除；转后台防护（C2 格，无锚点形态）= T 盖过
 *   转后台窗 + 早退边沿帧（tool_execution_end）刷新计时 + 边界后照常判死；
 * - RL11：在途信号刷新静默计时 + 过滤帧不计时 + summarization backoff 按载荷 delayMs
 *   宽限 + 反向判死必达；
 * - RL13：steer 投递失败降级 warn 不阻断恢复；
 * - RL14：禁用（httpIdleTimeoutMs=0）/ 超界配置只装配提示分支 + 配置值切换联动；
 * - RL16：第 2 层判死自动 abort 悬挂升级走判死强杀分型 + 标记分型消费 + restore/注入可达
 *   + 用户停止升级链对照 + 机器 abort 路径分型与恢复分流（noteAgentStart / session_manager）；
 * - AS16：事件全清单逐事件落位（装配表断言 + 真实 translate() 双事件配对防护）。
 *
 * 测试执行判据（TEST-STRATEGY「新写测试判据」）：全部单测层逻辑——fake timers 驱动确定性
 * 触发（时间参数化注入，无真实挂钟窗口）；dispatcher 层 mock client/svc/pm 注入桩；
 * 配置读侧不触盘（快照注入），无真进程 / 真 IO / 大预算形态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SILENCE_HINT_LEAD_MS,
  MODEL_WINDOW_FALLBACK_MS,
  DEFAULT_IDLE_BACKGROUND_SEC,
  DEFAULT_MCP_TIMEOUT_MS,
  SILENCE_TICK_MS,
  deriveSilenceThresholds,
  resolveStallMatrixArms,
  stallMatrixActionForKind,
  stallMatrixActionForEvent,
  STALL_MATRIX_EVENT_ASSEMBLY,
  SilenceMatrix,
  composeStallJudgeHintText,
  type StallMatrixConfigSnapshot,
  type StallJudgePayload,
} from '../src/services/session/event-interpreter-silence.js'
import { translate } from '../src/infra/pi/event-adapter.js'
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js'
import {
  ABORT_UPGRADE_WINDOW_MS,
  AUTO_RECOVER_DELAY_MS,
  type StallAutoDisposePort,
} from '../src/services/session/message-dispatcher.js'
import { userStoppedGate } from '../src/services/session/event-interpreter.js'
import { userStoppedMarkStore } from '../src/services/session/session-service.js'
import { PROBE_STALL_AUTO_QUIT } from '../src/services/session/types.js'
import type { IManagedSessionView, PiTranslatedEvent } from '../src/services/session/types.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { IDispatcherSessionOps } from '../src/services/session/session-internal.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { ServerMessage } from '@taiji/shared'

/** 默认配置快照（RL4 绿灯断言区基准：转后台 600s 开启、模型窗未设、provider 未设、无 MCP 条目）。 */
const DEFAULT_SNAPSHOT: StallMatrixConfigSnapshot = {
  idleBackgroundSec: DEFAULT_IDLE_BACKGROUND_SEC,
  httpIdleTimeoutMs: null,
  providerTimeoutMs: null,
  mcpMaxTimeoutMs: null,
}

// ── RL4：阈值推导断言 ────────────────────────────────────────────────

describe('RL4 阈值推导：T/T_hint 单源联动（默认配置绿灯断言区）', () => {
  it('T = idleBackgroundSec + 300 等式（任意合法 idleBackgroundSec，含边界 1 与极大值）', () => {
    for (const idle of [1, 60, 300, 600, 3600, 86_400]) {
      const t = deriveSilenceThresholds(idle)
      expect(t.judgeMs).toBe((idle + 300) * 1_000)
    }
  })

  it('T 恒大于每个单段合法静默窗（逐窗不等式，不叠加求和：转后台窗 / 默认模型窗 300s / 默认 MCP 窗 60s）', () => {
    for (const idle of [1, 60, 300, 600, 3600, 86_400]) {
      const t = deriveSilenceThresholds(idle)
      // 逐窗各自成立（D3/AX2 单段覆盖口径）：转后台窗、默认模型窗、默认 MCP 窗
      expect(t.judgeMs).toBeGreaterThan(idle * 1_000)
      expect(t.judgeMs).toBeGreaterThan(300 * 1_000)
      expect(t.judgeMs).toBeGreaterThan(60 * 1_000)
    }
  })

  it('T_hint = T − 60s 等式 + T_hint < T + T_hint > idleBackgroundSec（300s 差值 > 提前量恒成立）', () => {
    for (const idle of [1, 60, 300, 600, 3600, 86_400]) {
      const t = deriveSilenceThresholds(idle)
      expect(t.hintMs).toBe(t.judgeMs - SILENCE_HINT_LEAD_MS)
      expect(t.hintMs).toBeLessThan(t.judgeMs)
      expect(t.hintMs).toBeGreaterThan(idle * 1_000)
    }
  })

  it('常量护栏：提前量 60s、覆盖公式常量分量 300s（SR6——测试跟随源码常量，不本地重复定义）', () => {
    expect(SILENCE_HINT_LEAD_MS).toBe(60_000)
    expect(MODEL_WINDOW_FALLBACK_MS).toBe(300_000)
    expect(SILENCE_TICK_MS).toBeLessThanOrEqual(5_000)
  })
})

describe('RL4/RL14 配置维：超界降级触发 + 禁用分支 + 噪音边界', () => {
  it('默认配置：判死 + 提示双分支装配（judgeMs/hintMs 随公式）', () => {
    const arms = resolveStallMatrixArms(DEFAULT_SNAPSHOT)
    expect(arms.judge).toBe(true)
    expect(arms.hint).toBe(true)
    expect(arms.judgeMs).toBe((DEFAULT_IDLE_BACKGROUND_SEC + 300) * 1_000)
    expect(arms.hintMs).toBe(arms.judgeMs - SILENCE_HINT_LEAD_MS)
  })

  it('超界降级触发（review-direction#3）：httpIdleTimeoutMs=3600000 → 只装配提示分支', () => {
    const arms = resolveStallMatrixArms({ ...DEFAULT_SNAPSHOT, httpIdleTimeoutMs: 3_600_000 })
    expect(arms.judge).toBe(false)
    expect(arms.hint).toBe(true)
  })

  it('超界降级触发：provider.timeoutMs=600000 叠加较小 idleBackgroundSec → 只装配提示分支', () => {
    const arms = resolveStallMatrixArms({ ...DEFAULT_SNAPSHOT, idleBackgroundSec: 60, providerTimeoutMs: 600_000 })
    expect(arms.judge).toBe(false)
    expect(arms.hint).toBe(true)
  })

  it('超界降级触发：MCP 条目 timeout=1200s（> T=900s）→ 只装配提示分支', () => {
    const arms = resolveStallMatrixArms({ ...DEFAULT_SNAPSHOT, mcpMaxTimeoutMs: 1_200_000 })
    expect(arms.judge).toBe(false)
  })

  it('边界点等号同降级（RL4「重合即不覆盖」口径）：自愈窗生效值 == T → judge=false', () => {
    const t = deriveSilenceThresholds(DEFAULT_IDLE_BACKGROUND_SEC).judgeMs
    const arms = resolveStallMatrixArms({ ...DEFAULT_SNAPSHOT, providerTimeoutMs: t })
    expect(arms.judge).toBe(false)
  })

  it('RL14 禁用（httpIdleTimeoutMs=0）：只装配提示分支（AS15——该配置下模型请求无 pi 自愈窗）', () => {
    const arms = resolveStallMatrixArms({ ...DEFAULT_SNAPSHOT, httpIdleTimeoutMs: 0 })
    expect(arms.judge).toBe(false)
    expect(arms.hint).toBe(true)
  })

  it('RL14 配置值切换联动（0 ↔ 300000）：分支装配随快照切换随动（按会话启动读取）', () => {
    const disabled = resolveStallMatrixArms({ ...DEFAULT_SNAPSHOT, httpIdleTimeoutMs: 0 })
    const enabled = resolveStallMatrixArms({ ...DEFAULT_SNAPSHOT, httpIdleTimeoutMs: 300_000 })
    expect(disabled.judge).toBe(false)
    expect(enabled.judge).toBe(true)
    // 回切同理（0 ↔ 300000 双向往返）
    expect(resolveStallMatrixArms({ ...DEFAULT_SNAPSHOT, httpIdleTimeoutMs: 0 }).judge).toBe(false)
  })

  it('idleBackgroundSec ≤ 60s 提示噪音边界（U4 裁决：接受呈现噪音，不建第二参数）——T_hint 落模型自愈窗内', () => {
    for (const idle of [1, 30, 60]) {
      const t = deriveSilenceThresholds(idle)
      // 噪音登记形态的成立条件：提示阈值 ≤ 默认模型窗（提示可出现于模型合法自愈窗内）。
      // 提示非判定动作（AX5 约束判定类动作），判死仍由 T 与四层收窄承担。
      expect(t.hintMs).toBeLessThanOrEqual(300 * 1_000)
      // 判死分支不因此收窄：T > 模型窗恒成立（judge 仍装配）
      expect(resolveStallMatrixArms({ ...DEFAULT_SNAPSHOT, idleBackgroundSec: idle }).judge).toBe(true)
    }
  })

  it('idleBackgroundSec=null（U4 裁决③：转后台关闭 = 前台静默无界，AX5 收窄）→ 只装配提示分支', () => {
    const arms = resolveStallMatrixArms({ ...DEFAULT_SNAPSHOT, idleBackgroundSec: null })
    expect(arms.judge).toBe(false)
    expect(arms.hint).toBe(true)
  })
})

// ── 矩阵行为测试基建（fake timers + 注入 send/onJudge）────────────────

interface MatrixHarness { // oe-exempt:20261101:test:测试注入桩装配形状（单消费方）
  matrix: SilenceMatrix
  frames: ServerMessage[]
  judged: StallJudgePayload[]
  /** 推进 N 秒并 flush 微任务（tick 与 onJudge 内的同步路径消化）。 */
  advance: (ms: number) => Promise<void>
}

function makeMatrix(snapshot: StallMatrixConfigSnapshot = DEFAULT_SNAPSHOT, sessionId = 's-stall'): MatrixHarness {
  const frames: ServerMessage[] = []
  const judged: StallJudgePayload[] = []
  const matrix = new SilenceMatrix({
    sessionId,
    send: (msg) => frames.push(msg),
    configSnapshot: snapshot,
    onJudge: (payload) => judged.push(payload),
  })
  const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms)
  }
  return { matrix, frames, judged, advance }
}

/** stall_hint 帧提取（active 边沿序列）。 */
function hintEdges(frames: ServerMessage[]): Array<{ active: boolean; silentMs: number }> {
  return frames
    .filter((m): m is ServerMessage & { type: 'session.stall_hint' } => m.type === 'session.stall_hint')
    .map((m) => ({ active: (m.payload as { active: boolean }).active, silentMs: (m.payload as { silentMs: number }).silentMs }))
}

// ── RL11：在途信号 / 过滤帧 / backoff 宽限 / 反向判死必达 ─────────────

describe('RL11 在途信号：帧流刷新静默计时 + 在途阶段定位', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each([
    ['tool_execution_update', { kind: 'message', message: { type: 'message.tool_call_update', payload: { sessionId: 's-stall', toolCallId: 't1', detail: 'x' } } } as unknown as PiTranslatedEvent],
    ['bash_execution_update', { kind: 'bash-execution-update' } as PiTranslatedEvent],
    ['message_update（text_delta）', { kind: 'message', message: { type: 'message.text_delta', payload: { sessionId: 's-stall', delta: 'x' } } } as unknown as PiTranslatedEvent],
  ])('%s 到达刷新静默计时（T 处不判死；帧后重新起算）', async (_name, ev) => {
    const h = makeMatrix()
    h.matrix.start()
    // 静默 8 分钟 → 帧到达（刷新）→ 再静默 8 分钟（累计不足 T=900s）
    await h.advance(8 * 60_000)
    h.matrix.observe(ev)
    await h.advance(8 * 60_000)
    expect(h.judged).toHaveLength(0)
    expect(hintEdges(h.frames).filter((e) => e.active)).toHaveLength(0)
    h.matrix.stop()
  })

  it('在途阶段定位：tool_execution_update → phase=tool；turn_start（llm-request-start）→ phase=model-first-byte', async () => {
    const h = makeMatrix()
    h.matrix.start()
    // 工具在途形态：tool-call-start 后静默超窗
    h.matrix.observe({ kind: 'tool-call-start', toolCallId: 't1', toolName: 'bash', input: {}, entry: {} } as unknown as PiTranslatedEvent)
    await h.advance(900_000 + SILENCE_TICK_MS)
    expect(h.judged).toHaveLength(1)
    expect(h.judged[0].phase).toBe('tool')
    // 模型首字节前形态：turn_start 后静默超窗
    h.matrix.start()
    h.matrix.observe({ kind: 'llm-request-start', sessionId: 's-stall' } as PiTranslatedEvent)
    await h.advance(900_000 + SILENCE_TICK_MS)
    expect(h.judged).toHaveLength(2)
    expect(h.judged[1].phase).toBe('model-first-byte')
  })

  it('过滤帧（session_info_changed / thinking_level_changed / queue_update / entry_appended 对应 kind）不计时——超窗判死必达', async () => {
    const h = makeMatrix()
    h.matrix.start()
    // 过滤族帧到达：不刷新计时（映射表 filtered 落位）
    h.matrix.observe({ kind: 'session-renamed', name: 'x' } as PiTranslatedEvent)
    h.matrix.observe({ kind: 'thinking-level', level: 'high' } as PiTranslatedEvent)
    h.matrix.observe({ kind: 'record-entry-appended', customType: 'subagent-record' } as PiTranslatedEvent)
    // queue_update 在翻译层 NULL_EVENTS 丢弃（不产 kind——映射表登记 filtered 的实现形态）
    expect(stallMatrixActionForKind('session-renamed')).toBe('filtered')
    expect(stallMatrixActionForKind('thinking-level')).toBe('filtered')
    expect(stallMatrixActionForKind('record-entry-appended')).toBe('filtered')
    // 静默连续累计超 T → 判死必达（过滤帧未洗掉计时——AS16③「计入会洗掉停滞判定」反证）
    await h.advance(900_000 + SILENCE_TICK_MS)
    expect(h.judged).toHaveLength(1)
  })

  it('summarization_retry_scheduled 按载荷 delayMs 宽限：backoff 窗内不判死，窗满后恢复计时', async () => {
    const h = makeMatrix()
    h.matrix.start()
    // backoff 300s 宽限（T-已静默 800s 时刻到达：宽限覆盖 800→1100s，跨过 T=900s）
    await h.advance(800_000)
    h.matrix.observe({ kind: 'summarization-retry-scheduled', delayMs: 300_000 } as PiTranslatedEvent)
    await h.advance(150_000) // 950s：T 已过但 backoff 窗内（800+300=1100s 截止）
    expect(h.judged).toHaveLength(0)
    // 窗满后从既有静默继续（不重置——与 RL5 锚点同语义）：1200s = 冻结 800s + 窗满后
    // 累计 100s = 900s 达 T → 判死（backoff 宽限是暂停非清零，fail-safe 不放大豁免）
    await h.advance(250_000)
    expect(h.judged).toHaveLength(1)
    // 判死后矩阵自停：继续推进零重判
    await h.advance(300_000)
    expect(h.judged).toHaveLength(1)
  })

  it('delayMs 载荷畸形（null）→ 不给宽限（fail-safe 收窄）；帧流到达终结 backoff 窗', async () => {
    const h = makeMatrix()
    h.matrix.start()
    h.matrix.observe({ kind: 'summarization-retry-scheduled', delayMs: null } as PiTranslatedEvent)
    await h.advance(900_000 + SILENCE_TICK_MS)
    expect(h.judged).toHaveLength(1)
    // 帧流终结 backoff：backoff 窗内到达帧 → 窗终结，重新起算
    const h2 = makeMatrix()
    h2.matrix.start()
    await h2.advance(100_000)
    h2.matrix.observe({ kind: 'summarization-retry-scheduled', delayMs: 600_000 } as PiTranslatedEvent)
    await h2.advance(200_000)
    h2.matrix.observe({ kind: 'message', message: { type: 'message.text_delta', payload: { sessionId: 's-stall', delta: 'x' } } } as unknown as PiTranslatedEvent)
    await h2.advance(899_000)
    expect(h2.judged).toHaveLength(0)
    await h2.advance(2_000)
    expect(h2.judged).toHaveLength(1)
  })

  it('反向：超窗且无在途无豁免 → 判死必达（payload 携带 silentMs 与 phase；单回合至多一次）', async () => {
    const h = makeMatrix()
    h.matrix.start()
    await h.advance(900_000 + 2 * SILENCE_TICK_MS)
    expect(h.judged).toHaveLength(1)
    expect(h.judged[0].sessionId).toBe('s-stall')
    expect(h.judged[0].silentMs).toBeGreaterThanOrEqual(900_000)
    expect(h.judged[0].phase).toBe('stream')
    // 判死后矩阵自停：继续推进零重判
    await h.advance(900_000)
    expect(h.judged).toHaveLength(1)
  })
})

// ── RL5：豁免锚点（runtime 侧：暂停计时 / 继续 / 清除）────────────────

describe('RL5 豁免锚点：暂停计时非重置 + 判死后辅助提示清除', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('compacting 锚点：在场超阈值无提示不判死；锚点消失后从既有静默时长继续（不重置）', async () => {
    const h = makeMatrix()
    h.matrix.start()
    // 静默 100s → compaction_start（锚点置位，计时暂停）
    await h.advance(100_000)
    h.matrix.observe({ kind: 'compaction-start', reason: 'manual' } as PiTranslatedEvent)
    // 锚点在场超阈值（远超 T=900s）：无提示、无判死（C8 格豁免）
    await h.advance(1_200_000)
    expect(h.judged).toHaveLength(0)
    expect(hintEdges(h.frames)).toHaveLength(0)
    // compaction_end：锚点解除 + 刷新（压缩完成 = 推进证据，重新起算）
    h.matrix.observe({ kind: 'compaction-end', reason: 'manual', aborted: false } as PiTranslatedEvent)
    await h.advance(899_000)
    expect(h.judged).toHaveLength(0)
    await h.advance(2_000)
    expect(h.judged).toHaveLength(1)
  })

  it('ask_user pending 锚点（交互式 extension-ui）：在场超阈值不判死；真实 translate() 双事件不破锚（extension.dialog 交付帧过滤）', async () => {
    const h = makeMatrix()
    h.matrix.start()
    await h.advance(50_000)
    // 真实翻译输出（watchdog 同款防回归：ask_user select → [extension-ui, extension.dialog 帧] 双事件）
    const askUserEvents = translate(
      { type: 'extension_ui_request', id: 'r1', method: 'select', title: 'ASK_USER:测试', message: 'q', options: ['a', 'b'] } as never,
      's-stall',
    )
    for (const ev of askUserEvents) h.matrix.observe(ev)
    // 锚点在双事件批次后仍存活（交付帧 extension.dialog 被过滤，不触发 refresh 清锚）
    await h.advance(1_200_000)
    expect(h.judged).toHaveLength(0)
    expect(hintEdges(h.frames)).toHaveLength(0)
    // 帧流恢复（agent 继续产出）→ 锚解除 + 刷新：重新起算后超 T 判死
    h.matrix.observe({ kind: 'message', message: { type: 'message.text_delta', payload: { sessionId: 's-stall', delta: 'x' } } } as unknown as PiTranslatedEvent)
    await h.advance(900_000 + SILENCE_TICK_MS)
    expect(h.judged).toHaveLength(1)
  })

  it('notify 方法不置锚（fire-and-forget 不阻塞 agent 循环）——静默超窗照常判死', async () => {
    const h = makeMatrix()
    h.matrix.start()
    await h.advance(50_000)
    h.matrix.observe({ kind: 'extension-ui', requestId: 'r1', sessionId: 's-stall', method: 'notify', payload: {} } as unknown as PiTranslatedEvent)
    await h.advance(900_000 + SILENCE_TICK_MS)
    expect(h.judged).toHaveLength(1)
  })

  it('转后台防护（C2 格，无锚点形态）：早退边沿帧（tool_execution_end）刷新计时——转后台窗内不误杀，边界后照常判死', async () => {
    const h = makeMatrix()
    h.matrix.start()
    // 前台命令静默至转后台窗满（默认 idleBackgroundSec=600s）：T=900s 构造性盖过，窗满未判死
    await h.advance(DEFAULT_IDLE_BACKGROUND_SEC * 1_000)
    expect(h.judged).toHaveLength(0)
    // 转后台 = 工具调用早退（[TAIJI-FG-BG] 标记）→ tool_execution_end 帧到达：刷新计时重新起算
    h.matrix.observe({
      kind: 'tool-call-end',
      toolCallId: 't1',
      output: '[TAIJI-FG-BG] Command moved to background after 600s without output',
      details: undefined,
      images: undefined,
      toolName: 'bash',
      isError: false,
      entry: {},
    } as unknown as PiTranslatedEvent)
    // 刷新后静默 899s（< T=900s）：不判死——转后台不设锚点，防线 = T 盖过转后台窗 + 边沿帧刷新
    await h.advance(899_000)
    expect(h.judged).toHaveLength(0)
    // 登记边界：转后台后同回合仍占用且静默超 T 照常判死（pending 后台任务无帧流信号可锚）
    await h.advance(1_000 + 2 * SILENCE_TICK_MS)
    expect(h.judged).toHaveLength(1)
    expect(h.judged[0].phase).toBe('tool')
  })

  it('提示边沿：T_hint 到达 active=true 广播；帧流恢复 active=false 清除；判死（T）后提示清除（RL5 清除用例）', async () => {
    const h = makeMatrix()
    h.matrix.start()
    // T_hint = 840s：到达即广播 active=true（行动窗 = 判死前 60s）
    await h.advance(840_000)
    expect(hintEdges(h.frames)).toEqual([{ active: true, silentMs: expect.any(Number) }])
    // 用户不操作：T 到达判死 → 提示清除边沿（V9 e 时序——T_hint/T 60s 间隔钉住）
    await h.advance(60_000 + 2 * SILENCE_TICK_MS)
    expect(h.judged).toHaveLength(1)
    expect(hintEdges(h.frames).at(-1)).toMatchObject({ active: false })
    // 判死清除后不再重复广播
    await h.advance(120_000)
    expect(hintEdges(h.frames)).toHaveLength(2)
  })

  it('judge=false（RL14 降级）时矩阵只装配提示分支：T_hint 提示到达、T 处零判死', async () => {
    const h = makeMatrix({ ...DEFAULT_SNAPSHOT, httpIdleTimeoutMs: 0 })
    expect(h.matrix.resolvedArms.judge).toBe(false)
    h.matrix.start()
    await h.advance(840_000)
    expect(hintEdges(h.frames).filter((e) => e.active)).toHaveLength(1)
    await h.advance(900_000)
    expect(h.judged).toHaveLength(0)
  })
})

// ── AS16：事件全清单逐事件落位 ────────────────────────────────────────

describe('AS16 三分类装配：23+1 事件全清单逐事件落位（检查点核实载体）', () => {
  it('装配表覆盖全清单且动作值封闭（refresh 族 / 锚点 / backoff / 过滤 / settle / 锚覆盖 / 占用外）', () => {
    expect(STALL_MATRIX_EVENT_ASSEMBLY).toHaveLength(24)
    const legal = new Set([
      'refresh', 'refresh-tool', 'refresh-model-first-byte',
      'anchor-compacting', 'anchor-release', 'ask-user-anchor', 'backoff', 'filtered', 'settle',
      'covered-by-anchor', 'out-of-occupancy',
    ])
    for (const row of STALL_MATRIX_EVENT_ASSEMBLY) {
      expect(legal.has(row.action)).toBe(true)
      expect(row.note.length).toBeGreaterThan(0)
    }
  })

  it('kind 级分类与新补录翻译（bash-execution-update / summarization-retry-scheduled）落位', () => {
    expect(stallMatrixActionForKind('bash-execution-update')).toBe('refresh-tool')
    expect(stallMatrixActionForKind('summarization-retry-scheduled')).toBe('backoff')
    expect(stallMatrixActionForKind('llm-request-start')).toBe('refresh-model-first-byte')
    expect(stallMatrixActionForKind('agent-settled')).toBe('settle')
    expect(stallMatrixActionForKind('message')).toBe('refresh')
  })

  it('真实 translate()：bash_execution_update / summarization_retry_scheduled 产出矩阵消费 kind（NULL_EVENTS 退役回归钉）', () => {
    const bash = translate({ type: 'bash_execution_update', id: 'rpc-1', delta: 'out' } as never, 's-stall')
    expect(bash).toEqual([{ kind: 'bash-execution-update' }])
    const retry = translate({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'x' } as never, 's-stall')
    expect(retry).toEqual([{ kind: 'summarization-retry-scheduled', delayMs: 2000 }])
    // queue_update 维持 NULL（过滤帧实现形态）
    expect(translate({ type: 'queue_update' } as never, 's-stall')).toEqual([])
  })
})

// ── dispatcher 层基建（RL13/RL16）───────────────────────────────────

function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test/workspace',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    bashRunToken: undefined,
    occupancy: { turn: 'generating', compacting: false, bash: false, handingOff: false },
    ...overrides,
  }
}

interface StallHarnessOptions { // oe-exempt:20261101:test:测试注入桩装配形状（单消费方）
  /** client.abort 实现（缺省立即回执；传 () => new Promise(() => {}) 构造悬挂）。 */
  abortImpl?: () => Promise<unknown>
  /** destroy 挂起门（分型断言用：挂住编排使置位分型在恢复链消费前可观察——U2 同款）。 */
  hangDestroy?: boolean
}

/** 判死链 harness（U2 message-dispatcher.test.ts makeStallHarness 同款窄化形态）。 */
function makeStallHarness(opts: StallHarnessOptions = {}) {
  const order: string[] = []
  const client = {
    prompt: vi.fn(async () => ({})),
    touchActivity: vi.fn(),
    abort: vi.fn(opts.abortImpl ?? (async () => ({}))),
    exited: false,
    pid: 4242,
    getCommands: vi.fn(async () => []),
    onEvent: vi.fn(() => () => {}),
  } as unknown as IPiEngine
  const session = makeMockSession()
  const svc = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    clearSessionOutcome: vi.fn(),
    getSession: vi.fn(() => session),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  } as unknown as IDispatcherSessionOps
  // 可释放的 destroy 挂起门（分型断言：置位分型在恢复链消费前观察——U2 同款，置位在
  // 编排开头、消费在恢复链，立即 resolve 的 destroy 会让窗口推进后 consume 先行清标记）。
  let releaseDestroy: (() => void) | null = null
  const destroyGate: Promise<void> | null = opts.hangDestroy
    ? new Promise<void>((resolve) => { releaseDestroy = resolve })
    : null
  const pm = {
    getClient: vi.fn(() => client),
    destroySession: vi.fn(async () => {
      order.push('destroy')
      if (destroyGate) await destroyGate
    }),
  } as unknown as IProcessManager
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
  const published: ServerMessage[] = []
  const messageBus = {
    publish: vi.fn((_sid: string, msg: ServerMessage) => published.push(msg)),
  } as unknown as IMessageBus
  const dispatcher = new MessageDispatcher(svc, pm, workspaceService, messageBus)
  const port: StallAutoDisposePort = {
    restoreSession: vi.fn(async () => {
      order.push('restore')
      return {}
    }),
    injectReasonHint: vi.fn(async () => {
      order.push('inject')
    }),
    reportDeath: vi.fn(() => {
      order.push('reportDeath')
    }),
    consumeAutoRecoveryMark: vi.fn((sid: string) => {
      order.push('consume')
      return userStoppedMarkStore.consumeUserStoppedMarkOfSource(sid, [PROBE_STALL_AUTO_QUIT])
    }),
  }
  dispatcher.setStallAutoDisposePort(port)
  userStoppedGate.configure({ marks: userStoppedMarkStore, abortSession: vi.fn(async () => {}) })
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
  }
  return {
    dispatcher, port, client, session, svc, pm, published, order, flush,
    /** 释放 destroy 挂起门（hangDestroy 用例的编排完成信号）。 */
    releaseDestroy: () => releaseDestroy?.(),
  }
}

/** 清理 userStopped 标记宿主与门面接线（跨用例隔离；U2 测试同款）。 */
function resetStallGateState(): void {
  userStoppedMarkStore.clearAllUserStoppedMarks()
  userStoppedGate.resetForTest()
}

const JUDGE_PAYLOAD: StallJudgePayload = {
  sessionId: 's1',
  silentMs: 901_000,
  phase: 'tool',
}

// ── RL16：第 2 层判死自动 abort（悬挂升级分型 + 恢复分流）──────────────

describe('RL16 判死自动 abort：悬挂升级走判死强杀分型 + 恢复链可达', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(resetStallGateState)
  afterEach(() => vi.useRealTimers())

  it('C4 形态（abort 悬挂）：窗满升级 forceQuitSession source=判死分型（非 abort_timeout 用户分型）+ 标记分型消费 + restore + steer 注入', async () => {
    // hangDestroy 挂住编排：置位分型在恢复链消费前观察（U2 同款时序门）
    const h = makeStallHarness({ abortImpl: () => new Promise(() => {}), hangDestroy: true })
    const p = h.dispatcher.handleSilenceJudgeDetermination('s1', JUDGE_PAYLOAD)
    await vi.advanceTimersByTimeAsync(ABORT_UPGRADE_WINDOW_MS)
    await h.flush()
    // 判死强杀分型置位（机器判定无用户意图参与——types.ts 标记置位不变量）
    expect(userStoppedMarkStore.getUserStoppedSource('s1')).toBe(PROBE_STALL_AUTO_QUIT)
    expect(userStoppedMarkStore.getUserStoppedSource('s1')).not.toBe('abort_timeout')
    h.releaseDestroy()
    await vi.advanceTimersByTimeAsync(AUTO_RECOVER_DELAY_MS)
    await p
    await h.flush()
    // 自动恢复链：标记分型消费 → restore → 注入（静默判死文案，非探测判死缺省文案）
    expect(h.order).toEqual(['destroy', 'consume', 'restore', 'inject'])
    const injectText = (h.port.injectReasonHint as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string
    expect(injectText).toContain('静默')
    expect(injectText).toContain('工具执行中')
    expect(userStoppedMarkStore.hasUserStoppedMark('s1')).toBe(false)
    // reason 文案随分型分流（U3 修复断言）：stall_auto 升级套判死分型文案——entry 枚举
    // 标签与实际 source 一致（非 'User abort…(abort_timeout)' 用户停止谎报），exit 含
    // 「停滞 + 自动恢复」语义（与恢复链在途事实一致，D2 可读文案消费裁决）
    expect(h.svc.persistSessionOutcome).toHaveBeenCalledWith(
      's1', 'stopped', 'pi stalled (health probe unresponsive) — auto force-quit (probe_stall_auto_quit)',
    )
    const exited = h.published.find((m) => m.type === 'session.exited') as
      | { type: 'session.exited'; payload: { sessionId: string; code: null; reason: string } }
      | undefined
    expect(exited).toBeDefined()
    expect(exited!.payload.reason).toContain('停滞')
    expect(exited!.payload.reason).toContain('自动恢复')
    expect(exited!.payload.reason).not.toContain('User abort')
  })

  it('成功回执形态（LLM 请求类悬挂 abort 即达）：stopped 终态 + occupancy 复位 + complete{aborted} + steer 注入（静默文案）', async () => {
    const h = makeStallHarness()
    await h.dispatcher.handleSilenceJudgeDetermination('s1', JUDGE_PAYLOAD)
    await h.flush()
    // 型 1（generating 有回合可中止）：idle 复位 + stopped 终态（机器判定文案）+ 完成帧
    expect(h.session.occupancy?.turn).toBe('idle')
    expect(h.svc.persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'Silence judge auto abort (stall_auto)')
    expect(h.published.some((m) => m.type === 'message.complete')).toBe(true)
    // steer 注入到达（agent 循环带着提示继续）；无升级、无强杀、无自动恢复链
    expect(h.order).toEqual(['inject'])
    expect(h.pm.destroySession).not.toHaveBeenCalled()
    const injectText = (h.port.injectReasonHint as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string
    expect(injectText).toContain('静默')
    expect(userStoppedMarkStore.hasUserStoppedMark('s1')).toBe(false)
  })

  it('对照（用户停止升级链）：abort_timeout 用户分型不进自动恢复接线（显式重开语义不变）', async () => {
    const h = makeStallHarness({ abortImpl: () => new Promise(() => {}) })
    const p = h.dispatcher.abort('s1')
    await vi.advanceTimersByTimeAsync(ABORT_UPGRADE_WINDOW_MS)
    await vi.advanceTimersByTimeAsync(AUTO_RECOVER_DELAY_MS)
    await p
    await h.flush()
    expect(userStoppedMarkStore.getUserStoppedSource('s1')).toBe('abort_timeout')
    expect(h.order).not.toContain('consume')
    expect(h.order).not.toContain('restore')
    expect(h.order).not.toContain('inject')
  })

  it('机器 abort 路径分型与恢复分流（V11）：noteAgentStart（convergence）升级后进自动恢复；session_manager（agent）升级后恢复接线零调用、无注入', async () => {
    // ③ noteAgentStart 再中止——中止对象是恢复回放 turn，升级强杀后进窄化自动恢复
    {
      const h = makeStallHarness({ abortImpl: () => new Promise(() => {}), hangDestroy: true })
      const p = h.dispatcher.abort('s1', 'convergence')
      await vi.advanceTimersByTimeAsync(ABORT_UPGRADE_WINDOW_MS)
      await h.flush()
      expect(userStoppedMarkStore.getUserStoppedSource('s1')).toBe(PROBE_STALL_AUTO_QUIT)
      h.releaseDestroy()
      await vi.advanceTimersByTimeAsync(AUTO_RECOVER_DELAY_MS)
      await p
      await h.flush()
      expect(h.order).toEqual(['destroy', 'consume', 'restore', 'inject'])
      // reason 文案分流（U3 修复断言）：判死分型可读文案（停滞 + 自动恢复在途），非用户停止谎报
      expect(h.svc.persistSessionOutcome).toHaveBeenCalledWith(
        's1', 'stopped', 'pi stalled (health probe unresponsive) — auto force-quit (probe_stall_auto_quit)',
      )
      const exited = h.published.find((m) => m.type === 'session.exited') as
        | { type: 'session.exited'; payload: { sessionId: string; code: null; reason: string } }
        | undefined
      expect(exited).toBeDefined()
      expect(exited!.payload.reason).toContain('停滞')
      expect(exited!.payload.reason).toContain('自动恢复')
      expect(exited!.payload.reason).not.toContain('User abort')
    }
    // ④ session_manager abort 工具——agent 显式停止意图：升级强杀后不进恢复、不注入
    {
      const h = makeStallHarness({ abortImpl: () => new Promise(() => {}) })
      const p = h.dispatcher.abort('s1', 'agent')
      await vi.advanceTimersByTimeAsync(ABORT_UPGRADE_WINDOW_MS)
      await vi.advanceTimersByTimeAsync(AUTO_RECOVER_DELAY_MS)
      await p
      await h.flush()
      expect(userStoppedMarkStore.getUserStoppedSource('s1')).toBe(PROBE_STALL_AUTO_QUIT)
      expect(userStoppedMarkStore.getUserStoppedSource('s1')).not.toBe('abort_timeout')
      expect(h.order).not.toContain('consume')
      expect(h.order).not.toContain('restore')
      expect(h.order).not.toContain('inject')
      // reason 文案分流（U3 修复断言）：机器发起文案（非 'User abort'），不含「自动恢复」
      // 承诺（与 V11 e 恢复接线零调用一致——恢复归 agent/用户显式重开）
      expect(h.svc.persistSessionOutcome).toHaveBeenCalledWith(
        's1', 'stopped', 'Agent abort timed out — auto force-quit (probe_stall_auto_quit)',
      )
      const exited = h.published.find((m) => m.type === 'session.exited') as
        | { type: 'session.exited'; payload: { sessionId: string; code: null; reason: string } }
        | undefined
      expect(exited).toBeDefined()
      expect(exited!.payload.reason).toContain('agent 发起的停止请求')
      expect(exited!.payload.reason).not.toContain('自动恢复')
      expect(exited!.payload.reason).not.toContain('User abort')
    }
  })
})

// ── RL13：steer 投递失败降级 warn 不阻断恢复 ─────────────────────────

describe('RL13 steer 投递失败降级 warn：恢复链（occupancy 复位、会话可用）不受影响', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(resetStallGateState)
  afterEach(() => vi.useRealTimers())

  it('成功回执路径注入失败：warn 降级（不 throw），occupancy 已复位、终态已写、完成帧已广播', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const h = makeStallHarness()
      ;(h.port.injectReasonHint as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        throw new Error('steer delivery failed')
      })
      await expect(h.dispatcher.handleSilenceJudgeDetermination('s1', JUDGE_PAYLOAD)).resolves.toBeUndefined()
      await h.flush()
      expect(h.session.occupancy?.turn).toBe('idle')
      expect(h.svc.persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'Silence judge auto abort (stall_auto)')
      expect(h.published.some((m) => m.type === 'message.complete')).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reason hint injection failed'), expect.anything())
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('升级路径恢复后注入失败：warn 降级，restore 已完成（恢复不受注入故障影响）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const h = makeStallHarness({ abortImpl: () => new Promise(() => {}) })
      ;(h.port.injectReasonHint as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        throw new Error('steer delivery failed')
      })
      const p = h.dispatcher.handleSilenceJudgeDetermination('s1', JUDGE_PAYLOAD)
      await vi.advanceTimersByTimeAsync(ABORT_UPGRADE_WINDOW_MS)
      await vi.advanceTimersByTimeAsync(AUTO_RECOVER_DELAY_MS)
      await expect(p).resolves.toBeUndefined()
      await h.flush()
      expect(h.order).toContain('consume')
      expect(h.order).toContain('restore')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reason hint injection failed'), expect.anything())
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ── steer 注入文案组装（D3：静默时长 + 在途阶段定位 + 判定依据）────────

describe('判死 steer 注入文案组装（composeStallJudgeHintText）', () => {
  it('含静默时长、在途阶段定位与判定依据三要素；[runtime] 前缀对齐 U2 形态', () => {
    const text = composeStallJudgeHintText({ sessionId: 's1', silentMs: 15 * 60_000, phase: 'stream' })
    expect(text.startsWith('[runtime]')).toBe(true)
    expect(text).toContain('15 分钟')
    expect(text).toContain('流式输出中')
    expect(text).toContain('无在途信号')
    expect(composeStallJudgeHintText({ sessionId: 's1', silentMs: 900_000, phase: 'model-first-byte' })).toContain('模型响应等待中')
  })
})
