/**
 * MessageDispatcher — 从 session-service 巨石拆出的消息派发职责。
 *
 * 负责:sendMessage / abort / compact + sendMessageHook 注册 + bash 通道（BashDispatcher
 * 协作类持有）。
 *
 * [投递所有权内核 u2] 用户消息路径（sendMessage）**内核化**：投递所有权移交
 * SessionDeliveryRegistry（D1 单一所有者）——本类保留「BeforeSend hook 拦截 + 入口 touch +
 * 错误范围编排」，投递交由 `registry.submit()`（lane 判定 + 裸标记 + 内核 FIFO + 两阶段回执
 * 全在注册表/内核侧）。退役路径：busy 预检（rejectBusyPrecheck）、send.rejected 广播（budy
 * 类拒绝转译）、markSessionActive 三副作用（迁至注册表 deliverOne 的出站交接点，§3.4+ 表）、
 * skill 注入（迁至同一交接点——注入器所有权随出站交接点走）。保留范围：BeforeSend hook
 * （提交前）、入口 touchActivity（idle-pi-reclamation D6-1）。pi busy 类拒绝识别函数
 * classifyPromptRejection 定义与消费均在注册表（session-delivery-registry.ts）。
 * [occupancy D2 拒绝转译] 错误分类迁移后由注册表的出站交接 catch 面消费（D6）。
 * [HISTORICAL] sendSubagentMessage(marker 拼装分支)已删除(composer 四符号设计 D2)——
 * 定向消息改走 session-service.subagentAction 直发 client.prompt,不经本骨架。
 * [MF-1-8 退役] steerMessage / followUpMessage 转发路径已删除——renderer/core 消费方经
 * delivery.submit 统一提交（u3b），协议侧 message.steer / message.follow_up 条目随
 * runtime transport 路由删除同批退役（u5a 退役条件兑现）。
 * 注：bash 通道（sendBash / abortBash）不经 LLM turn、不经投递内核，行为不变
 * （设计 §1.3 In/Out：bash 通道不在本期改造面）；[MF-1-10] 实现整体搬移至
 * bash-dispatcher.ts，本类构造持有并保持公开签名不变。
 *
 * 依赖经构造注入:svc(dispatcher 窄接口 IDispatcherSessionOps,按消费者收窄——
 * 调用点实测 6 方法,见 session-internal.ts)、
 * pm(getClient / 进程操作)、messageBus(发布,wave:perf-w09 接口收敛——
 * dispatcher 只依赖 publish 抽象,broker 依赖已删除:命令编排消息全部是
 * session 级 push 型,单通道走 bus 定向发布,broadcast 双写路径已收敛)。
 * delivery（[MF-1-7 装配收编] 投递注册表）：经 setDeliveryRegistry 后置注入（组合根装配序：
 * 注册表创建晚于 SessionService/本类构造，后置注入对齐 setMessageBus 先例）——原进程内
 * 活动槽（getActiveDeliveryRegistry）已删除，依赖在 setter 可见。
 */
import type { IDispatcherSessionOps } from './session-internal.js'
import { runDestroyStepIsolated } from './session-entry-removal.js'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { IPiEngine, IProcessManager } from '../ports/pi-engine.js'
import type {
  SendMessageHook,
  ForceQuitSource,
  SessionOccupancy,
  IManagedSessionView,
} from './types.js'
import { isGeneratingTurn, PROBE_STALL_AUTO_QUIT } from './types.js'
import { getSessionLogsDir } from '@taiji/shared/paths'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import { toErrorMessage } from '../../utils/errors.js'
import { applySessionOccupancyTransition, IDLE_SESSION_OCCUPANCY, userStoppedGate } from './event-interpreter.js'
import { buildOutboundChildEnv } from '../../infra/spawn-env.js'
import type { SessionDeliveryRegistry, DeliverySubmitResult } from './session-delivery-registry.js'
import type { DeliveryIntent } from '@zhushanwen/session-delivery'
import type { SendPromptReason } from '@taiji/shared'
import { BashDispatcher, type InternalBashDispatchReceipt } from './bash-dispatcher.js'
// [pi-stall-detection U4] 判死载荷与 steer 注入文案（静默判定矩阵单源，D3）。
import { composeStallJudgeHintText, type StallJudgePayload } from './event-interpreter-silence.js'

/**
 * abort 发起方分型（U2 修复）：userStopped 拦截链复用 abort 完整链时区分「用户操作」
 * 与「runtime 自动拦截」的终态语义。默认 'user'（全部既有调用方零改动保持用户语义）；
 * 'convergence' 仅由 session-service 的 userStoppedGate.configure 接线传入（userStopped
 * 标记存活期 agent_start 挂点的 re-abort 通路）。[ADR-0122] 原定义在 abort-liveness.ts
 *（三级阶梯），该编排链随 RPC 墙钟超时退役后类型迁入本文件。
 *
 * [pi-stall-detection U2] 'agent'：机器/agent 发起的 abort（session_manager abort 工具
 * 通路）——升级窗窗满强杀时置机器判死分型而非用户分型（agent 主动停止不是用户操作，
 * 置 abort_timeout = 终态谎报；D2① 消费方裁决 ④。facade→handler 的 'agent' 传参接线随
 * U4 agent_stop 分型候选裁决同批落地，本单元先落 dispatcher 侧分型语义）。
 *
 * [pi-stall-detection U4 / D3] 'stall_auto'：第 2 层静默判定矩阵的判死自动 abort——机器
 * 判定无用户意图参与，升级窗窗满强杀置判死强杀分型（与第 1 层共用 PROBE_STALL_AUTO_QUIT，
 * 不新增第三分型、不复用 abort_timeout 用户停止分型，RL16）；升级后进窄化自动恢复接线
 *（同 'convergence' 恢复语义——判死自动恢复是设计内承诺，与 agent 显式停止意图相反）；
 * 成功回执路径（abort 即达——LLM 请求类悬挂对 abort 信号即时生效）经 reasonHint 携带的
 * steer 注入完成「agent 循环带着提示继续」。
 */
export type AbortSource = 'user' | 'convergence' | 'agent' | 'stall_auto'

/**
 * [pi-stall-detection U2 / D2①] abort 升级窗：协作式 abort RPC 的有界等待上限——窗内
 * 回执走既有成功/显式失败路径；窗满未回执 = 对挂死对象协作式请求已证不可达，自动升级
 * forceQuitSession 完成用户已表达的停止意图（AX4 停止意图有界完成）。
 *
 * 量级依据（SI7 处置② / RL9）：正常协作式 abort 秒级回执（LLM 流/压缩/摘要被
 * AbortController 即刻取消、MCP signal 转发即抛、bash 杀进程树）——10s 远大于正常值、
 * 不会误触发。初值 10-15s 量级取 10s；终值按正常 abort 回执实测上界校准（U2 检查点，
 * V1/V5 剧本 + p0-interrupt-cancel 复跑回填）。export 供测试（SR6 + RL9 常量护栏）。
 */
export const ABORT_UPGRADE_WINDOW_MS = 10_000

/**
 * [pi-stall-detection U2] 判死自动恢复触发链参数（新建链，D2②；实施期校准检查点）：
 * - AUTO_RECOVER_DELAY_MS：强杀收尾完成到 restore 调用的延迟——过短强杀现场未落盘
 *   （session.exited 广播/renderer 过渡态处理未完成），过长用户空等。初值 1s；
 * - AUTO_RECOVER_MAX_ATTEMPTS：恢复尝试上限（防恢复持续失败时静默循环），耗尽降级
 *   死亡发声 + 用户手动重开（回写 D2 恢复段承诺）。初值 2 次（首次 + 1 重试）。
 * export 供测试（SR6）。
 */
export const AUTO_RECOVER_DELAY_MS = 1_000
/** 秒 ↔ 毫秒换算（日志可读化换算用，no-magic-numbers）。 */
const MS_PER_SECOND = 1_000
export const AUTO_RECOVER_MAX_ATTEMPTS = 2

/** sample 取证 execFile 的超时上限（sample 本体 2s 采样 + 启动/落盘余量）。 */
const STALL_SAMPLE_EXEC_TIMEOUT_MS = 10_000

/** 用户停止升级强杀（abort_timeout）终态 entry 诊断文案 / session.exited 用户可见文案。 */
const ABORT_TIMEOUT_OUTCOME_REASON = 'User abort timed out — auto force-quit (abort_timeout)'
const ABORT_TIMEOUT_EXIT_REASON =
  '停止请求未被 pi 确认（等待窗内无回执），已自动强制终止该会话。重新打开该 session 即可恢复（历史完整）。'

/** 判死强杀（probe_stall_auto_quit）终态 entry 诊断文案 / session.exited 用户可见文案。 */
const STALL_OUTCOME_REASON = 'pi stalled (health probe unresponsive) — auto force-quit (probe_stall_auto_quit)'
const STALL_EXIT_REASON =
  '会话停滞：pi 未响应健康探测，已自动终止进程并尝试自动恢复；若未自动恢复请重新打开该 session（历史完整）。'

/**
 * agent 发起（session_manager abort 工具）的 abort 悬挂升级强杀终态 entry 诊断文案 /
 * session.exited 用户可见文案（判死分型）：agent 显式停止意图，升级后不进自动恢复、
 * 不注入 steer（V11 e / RL16 恢复分流），恢复归 agent/用户显式重开——文案不含
 * 「尝试自动恢复」承诺，与显式重开的在途事实一致。
 */
const AGENT_ABORT_TIMEOUT_OUTCOME_REASON = 'Agent abort timed out — auto force-quit (probe_stall_auto_quit)'
const AGENT_ABORT_TIMEOUT_EXIT_REASON =
  'agent 发起的停止请求未被 pi 确认（等待窗内无回执），已自动强制终止该会话。重新打开该 session 即可恢复（历史完整）。'

/** 恢复成功后经 steer 注入的原因提示（AX6 显式呈报：agent 循环带着死因上下文继续）。 */
const STALL_REASON_HINT =
  '[runtime] 上一回合因 pi 停滞（未响应健康探测）被自动终止，会话已恢复。请根据上下文继续处理未完成的任务。'

/**
 * abort 升级窗窗满的专用错误（内部通道标记：区分「窗满升级」与「abort 显式失败」——
 * 后者走既有 catch 收尾分支）。不导出：分型只在 abort 编排内部消费。
 */
class AbortUpgradeWindowError extends Error {
  constructor() {
    super('abort upgrade window elapsed without pi acknowledgement')
    this.name = 'AbortUpgradeWindowError'
  }
}

/** abort promise 的有界等待包装：窗内 settle 透传（成功/失败原样），窗满抛升级错误。 */
function abortWithUpgradeWindow(client: IPiEngine, windowMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AbortUpgradeWindowError()), windowMs)
    // then 双分支都挂载：窗满后迟到的 abort 回执（pi 恢复响应或 exit 链 rejectAll）对已
    // settle 的包装 promise 是 no-op，且不产生 unhandledRejection。
    client.abort().then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** sample 取证执行器形态（缺省 = macOS `sample <pid> 2 -file <path>`；测试注入桩）。 */
export type StallSampleRunner = (pid: number, outputPath: string) => Promise<void>

const defaultRunStallSample: StallSampleRunner = (pid, outputPath) =>
  new Promise<void>((resolve, reject) => {
    // macOS sample：2 秒采样调用栈落文件（D6）。超时由 execFile timeout 承担（SIGTERM →
    // error 回调 reject → 调用方降级留痕，不阻断强杀）。
    execFile('sample', [String(pid), '2', '-file', outputPath], { timeout: STALL_SAMPLE_EXEC_TIMEOUT_MS, env: buildOutboundChildEnv({ parentEnv: process.env }) }, (err) =>
      err ? reject(err) : resolve(),
    )
  })

/**
 * 停滞自动处置链端口（pi-stall-detection U2，组合根经 setStallAutoDisposePort 后置注入；
 * 对齐 setMessageBus / setDeliveryRegistry 先例——恢复执行/注入/发声依赖 respawn 编排器
 * 与组合根闭包，均晚于 dispatcher 构造）。dispatcher 不直接 import session-service（模块
 * 依赖单向性），恢复执行与标记分型消费经本端口注入。
 */
export interface StallAutoDisposePort {
  /** 恢复执行（组合根 = facade.restoreSession，经 respawn.ensureRestored join 单源收敛）。 */
  restoreSession: (sessionId: string) => Promise<unknown>
  /** 恢复成功后的死因提示注入（组合根 = client.prompt(text, undefined, 'steer')）。 */
  injectReasonHint: (sessionId: string, reasonText: string) => Promise<void>
  /** 恢复失败降级死亡发声（组合根 = speakSessionDeath 闭包，对齐 crashExit 'terminal' 路径）。 */
  reportDeath: (sessionId: string) => void
  /** 判死分型标记的同权消费（组合根 = consumeUserStoppedMarkOfSource(sid, [判死分型])）。 */
  consumeAutoRecoveryMark: (sessionId: string) => boolean
  /** sample 取证执行（缺省 defaultRunStallSample）；测试注入桩（RL12 三分支）。 */
  runStallSample?: StallSampleRunner
  /** 平台探测（缺省 process.platform）；测试注入非 darwin 测跳过分支（RL12 平台分支）。 */
  platform?: () => NodeJS.Platform
}

// sendMessage 回执 reason 词表 SSOT = shared SendPromptReason（msg-pipeline-debloat
// D4-6 单点收敛，原 5 处手写词表归一；busy/compacting/bash 退役值收窄裁决与值语义见
// shared 定义处）。运行侧分支只看 blocked——插件/调用方不得依赖 reason 精确值做行为
// 分支。本类型经 @taiji/shared 出口供 interfaces / session-api / session-service /
// plugin-sdk 同源消费。

/**
 * sendSystemCommand 的判别结果（消息撤回 D1/D8）：编排按 kind 映射错误码——
 * 'sent' = prompt resolve（完成确认由调用方 get_entries 校验，受理口径不反映执行结果）；
 * 'extension-missing' = requireCommand 探测耗尽（fail-closed，命令串未进模型）；
 * 'pi-reclaimed' = ensureActive 拉活失败（终态码，区别于命令真缺失）；
 * 'error' = prompt 抛错（传输级；pi 侧 command 执行错误不发此形态——command 抛错只发
 * extension error 事件、prompt 照常成功 'sent'，缺陷面由调用方事后校验兜住）。
 */
export type SystemCommandOutcome =
  | { kind: 'sent' }
  | { kind: 'extension-missing' }
  | { kind: 'pi-reclaimed' }
  | { kind: 'error'; message: string }

export class MessageDispatcher {
  private sendMessageHook: SendMessageHook | null = null
  /** per-session 受理串行链（hook 竞态顺序封闭，见 sendMessage；settled 后自清）。 */
  private readonly sendMessageChains = new Map<string, Promise<unknown>>()

  /**
   * bash 通道协作实例（[MF-1-10] 实现在 bash-dispatcher.ts，本类构造持有；公开方法
   * sendBash/abortBash/flushPendingBashResults 签名不变，session-service 消费方零改动）。
   */
  private readonly bash: BashDispatcher

  /**
   * 投递注册表（[MF-1-7 装配收编]）：经 setDeliveryRegistry 后置注入（组合根装配序所迫，
   * 对齐 setMessageBus 后置注入先例）。未接线时 submitToKernel 显式失败（不静默）。
   */
  private delivery?: SessionDeliveryRegistry

  /**
   * 强杀编排 in-flight 注册表（sessionId → Promise；pi-stall-detection U2 双入口并发幂等，
   * U2 检查点「升级强杀 × 右键 / restore 兜底并发」）：并发到达的第二调用方 join 同一
   * Promise（单次编排、单次 markUserStopped 置位、单次 session.exited 广播），对齐
   * pi-respawn.ensureRestored 的 join 语义先例。
   */
  private readonly forceQuitInFlight = new Map<string, Promise<void>>()

  /**
   * 停滞自动处置链端口（pi-stall-detection U2；组合根后置注入，null = 未接线——恢复链
   * 显式留痕降级，强杀编排本体不依赖端口）。
   */
  private stallAutoDisposePort: StallAutoDisposePort | null = null

  constructor(
    private readonly svc: IDispatcherSessionOps,
    private readonly pm: IProcessManager,
    private readonly workspaceService: WorkspaceService,
    private messageBus?: IMessageBus,
  ) {
    this.bash = new BashDispatcher({
      ensureActive: (sessionId) => this.svc.ensureActive(sessionId),
      getSessionByClient: (client) => this.svc.getSessionByClient(client),
      getSession: (sessionId) => this.svc.getSession(sessionId),
      getClient: (sessionId) => this.pm.getClient(sessionId),
      getMessageBus: () => this.messageBus,
      notifyHoldRelease: (sessionId) => this.delivery?.notifyHoldRelease(sessionId),
    })
  }

  /**
   * 后置注入 / 回填 MessageBus（SessionService.setMessageBus 同步回填调用）。
   *
   * bus 的两条注入通道：①构造参数（index.ts 构造 SessionService 时传导）；
   * ②SessionService.setMessageBus 后置注入路径——该路径下 dispatcher 已构造（bus 为
   * undefined），必须回填，否则全部 session 级发布静默 no-op（null-safe 但消息丢失）。
   */
  setMessageBus(bus: IMessageBus): void {
    this.messageBus = bus
  }

  /**
   * 后置注入投递注册表（[MF-1-7 装收编] 组合根经 SessionService 同名转发调用；注册表创建
   * 晚于本类构造，此 setter 是唯一注入通道）。幂等覆盖（同实例重复注入无害）。
   */
  setDeliveryRegistry(registry: SessionDeliveryRegistry): void {
    this.delivery = registry
  }

  /**
   * 后置注入停滞自动处置链端口（pi-stall-detection U2；组合根经 SessionService 同名转发
   * 调用）。null = 拆除（测试隔离）。
   */
  setStallAutoDisposePort(port: StallAutoDisposePort | null): void {
    this.stallAutoDisposePort = port
  }

  /** 注册消息发送前 hook(PluginService 调用,实现 beforeSend 拦截)。 */
  setSendMessageHook(hook: SendMessageHook): void {
    this.sendMessageHook = hook
  }

  /**
   * 用户消息发送入口（message.send / delivery.submit RPC / plugin-service / handoff 通路）
   * ——「入口 touch + BeforeSend hook + 内核提交」的唯一组合点，两条 RPC 入口共用同一
   * veto/transform 面（tech-design must-fix ①：hook 不得旁路出第二个提交通道）。
   *
   * 返回 { blocked: true } 表示消息被 BeforeSend hook 拦截（已广播 message.error 错误气泡），
   * 调用方（session-message-handler）必须据此走 error envelope（带请求 id）让 renderer
   * pending.reject，不得 reply success（round7 must-fix #3：避免「composer 清空 + 错误气泡」矛盾态）。
   *
   * [投递所有权内核 u2] 三层职责（D1 单一所有者）：①入口同步 touch（idle 回收防误杀）
   * ②BeforeSend hook 拦截（提交前，唯一 veto 面；受理阶段一次语义——内核投递执行点
   * requeue/rebuild/adopt 可重入，重投不得重复过 hook，防 transform 双重改写）③内核提交
   * `registry.submit()`（lane 判定 + 裸标记 + 内核 FIFO + 两阶段回执），受理回执经
   * receipt 透出供 delivery.submit reply 使用。
   * busy 预检与 send.rejected 已退役——排队取代拒绝（D5）：暂不可收时态（compacting / bash）
   * 由内核持有，settled 边沿/对账器驱动投递，消息不再被拒回 renderer。
   *
   * [hook 竞态顺序封闭（复审 R2）] 同 session 并发提交按 per-session 链串行：hook 是异步
   * 等待（Worker RPC，单 handler 5s 超时），而 WS 分发逐帧 fire-and-forget——不串行时
   * hook 完成序可倒置内核提交序（内核 FIFO 保提交序而非发送序，G1/V6 可违）。串行化让
   * 到达序 = 提交序；链只含 hook + 同步内核提交（有界：hook 数 × 5s），settled 后自清。
   *
   * rejected 返回值保留为类型完备（恒 undefined）——handler 的 message.status{rejected}
   * ack 分支自此不可达，protocol 条目退役归 u5。
   *
   * [plugin-header-action-modal-points D6/u5a] requireCommand 透传（可选，既有调用方零改动）：
   * 插件写路径的前置原子校验，插入点见 runAcceptance 内注释。回执 reason 词表见 SendPromptReason。
   */
  async sendMessage(sessionId: string, content: string, images?: Array<{ data: string; mimeType: string }>, clientUuid?: string, requireCommand?: string): Promise<{ blocked: boolean; rejected?: boolean; receipt?: DeliverySubmitResult; reason?: SendPromptReason }> {
    // ── per-session 受理串行链（到达序 = 内核提交序）──
    // 前驱失败不毒化链（catch 吞 rejection，错误范围已由链内各层自广播）。
    const prev = this.sendMessageChains.get(sessionId) ?? Promise.resolve()
    const run = prev.catch(() => undefined).then(() => this.runAcceptance(sessionId, content, images, clientUuid, requireCommand))
    this.sendMessageChains.set(sessionId, run)
    run.then(
      () => this.releaseSendChain(sessionId, run),
      () => this.releaseSendChain(sessionId, run),
    )
    return run
  }

  /** 受理段（hook + requireCommand 校验 + 内核提交）——仅经 per-session 串行链进入。 */
  private async runAcceptance(
    sessionId: string,
    content: string,
    images?: Array<{ data: string; mimeType: string }>,
    clientUuid?: string,
    requireCommand?: string,
  ): Promise<{ blocked: boolean; rejected?: boolean; receipt?: DeliverySubmitResult; reason?: SendPromptReason }> {
    // ── BeforeSend hook（提交前唯一拦截点）──
    // blocked: 已广播 message.error（错误气泡），此处返回 {blocked:true} 让 handler 改发 error envelope。
    // modifiedContent: hook 改写后的文本（transform 语义，Fix-1），未改写时回退原文。
    // [D6/u5a] reason:'hook-blocked' 为回执面增量（hook 管道既有 reason 已随 message.error 上浮）。
    const hookOutcome = await this.runBeforeSendHook(sessionId, content)
    if (hookOutcome.blocked) {
      return { blocked: true, reason: 'hook-blocked' }
    }

    // ── requireCommand 原子校验（plugin-header-action-modal-points D6/u5a）──
    // 插件写路径前置校验：未命中 → 拒发回执（reason='command-missing'），不广播
    // message.error——回执机制（E14）就是它的反馈面，命令串不进模型、对话流无新消息。
    // 校验位置 = hook 之后、内核提交之前。单次探测（ADR-0122：原 500ms×6 就绪轮询已删，
    // 拒发 = 显式上报，重发决策归调用方）。
    if (requireCommand !== undefined) {
      const available = await this.ensureCommandAvailable(sessionId, requireCommand)
      if (!available) {
        console.warn(
          `[message-dispatcher] requireCommand "${requireCommand}" not registered, rejecting send (reason=command-missing), sid=${sessionId}`,
        )
        return { blocked: true, rejected: true, reason: 'command-missing' }
      }
    }

    const receipt = this.submitToKernel(sessionId, hookOutcome.modifiedContent ?? content, { images, clientUuid })
    // [dmg-r1-1 跨回合终态放行] 内核受理成功 = 新回合周期开启：清上一回合的终态 sidecar，
    // 使本周期终态（新回合完成 done / 失败 error / 再次 abort stopped）不被第一终态优先
    // 检查拦截（否则用户 abort 后继续对话，重启后侧栏永久滞留旧终态——失真根因）。
    // 放在 hook/requireCommand 全通过后：被拦截的提交不开启新周期，旧终态保留。
    // submit 失败（registry 未接线的显式失败）同样保留旧终态。同回合并发竞态（abort vs
    // pi 自发 agent_end）不经本受理点，persistSessionOutcome 的先写者赢保护原样生效。
    if (receipt) {
      this.svc.clearSessionOutcome(sessionId)
    }
    return { blocked: false, receipt }
  }

  /**
   * requireCommand 探测（plugin-header-action-modal-points D6/u5a）：直连
   * client.getCommands()（不走 sessionService.getCommands 的 markDirty 查询语义——那是
   * UI 状态查询范围路径）。单次探测（ADR-0122：500ms×6 就绪轮询已删）；client 未附着 =
   * 未命中（拒发由调用方收尾）；探测 RPC 失败视同未命中，warn 留排查线索（非静默吞）。
   */
  private async ensureCommandAvailable(sessionId: string, requireCommand: string): Promise<boolean> {
    const client = this.pm.getClient(sessionId)
    if (!client) return false
    try {
      const commands = await client.getCommands()
      return commands.some((c) => c.name === requireCommand)
    } catch (e) {
      console.warn(`[message-dispatcher] requireCommand probe failed:`, toErrorMessage(e))
      return false
    }
  }

  /** 串行链尾自清：本 run 仍是链尾时释放槽位（跨 session 恒不互相阻塞）。 */
  private releaseSendChain(sessionId: string, run: Promise<unknown>): void {
    if (this.sendMessageChains.get(sessionId) === run) {
      this.sendMessageChains.delete(sessionId)
    }
  }

  /**
   * 系统信令入口（消息撤回设计 D1：sendSystemCommand）——与用户消息链路（sendMessage）
   * 刻意分流的旁路通道，供 runtime 编排对 pi 触发 extension command（`/` 前缀 prompt——
   * pi 同步执行、不进模型、无 turn，P2 前提）。
   *
   * 分流契约（D1 逐条）：
   * - **不经 runBeforeSendHook**：系统指令不是用户消息，不暴露给插件 veto/transform 改写侧
   *   （hook 的 transform 可破坏命令形态，D1 否决记录的第三缺陷）；
   * - **不经 registry.submit**：无裸标记尾附（标记会污染 command args 使 navigateTree throw）、
   *   无内核条目、无投递路径判定——信令不被 hold/排队（撤回编排自持 revoking hold，若经内核
   *   提交会自锁死等）；
   * - **复用 ensureCommandAvailable 探测**（requireCommand 语义保留：命令未注册 fail-closed
   *   extension-missing，命令串不进模型）；
   * - **前置 ensureActive 交接 + 入口 touchActivity**：restore 的唯一触发点在内核出站交接，
   *   旁路必须自带——否则「发错消息隔久回来撤」形态下 pi 已被空闲回收，纯探测耗尽误报
   *   extension-missing 且诊断错位；touch 防「探测+prompt 在途窗口被回收器误杀」。
   *
   * 返回判别结果（不 throw——编排按 kind 映射 D8 错误码；'error' = prompt 抛错等传输级
   * 失败，编排归 nav-failed 可重试）。
   */
  async sendSystemCommand(
    sessionId: string,
    commandLine: string,
    requireCommand?: string,
  ): Promise<SystemCommandOutcome> {
    // ── ensureActive 交接（旁路自带的 restore 触发点；拉活失败 = pi-reclaimed 终态码）──
    let client: IPiEngine
    try {
      client = await this.svc.ensureActive(sessionId)
    } catch (e) {
      console.error(`[message-dispatcher] sendSystemCommand: ensureActive failed, sid=${sessionId}`, toErrorMessage(e))
      return { kind: 'pi-reclaimed' }
    }
    if (requireCommand !== undefined) {
      const available = await this.ensureCommandAvailable(sessionId, requireCommand)
      if (!available) {
        console.warn(
          `[message-dispatcher] sendSystemCommand: command "${requireCommand}" not registered (fail-closed), sid=${sessionId}`,
        )
        return { kind: 'extension-missing' }
      }
    }
    try {
      await client.prompt(commandLine)
    } catch (e) {
      console.error(`[message-dispatcher] sendSystemCommand: prompt failed, sid=${sessionId}`, toErrorMessage(e))
      return { kind: 'error', message: toErrorMessage(e) }
    }
    return { kind: 'sent' }
  }

  /**
   * 内核提交（提交路径共用）：取 setDeliveryRegistry 装配的注册表（[MF-1-7] 组合根单例）
   * → `submit`（受理口径，D9⑤：同步返回受理回执，不等送达）。
   *
   * 装配缺失（无注册表 = 组合根未接线）：显式失败（message.error 广播 + 返回 undefined），
   * 不静默丢消息（"失败要出声"）。
   */
  private submitToKernel(
    sessionId: string,
    content: string,
    opts: { images?: Array<{ data: string; mimeType: string }>; clientUuid?: string; intent?: DeliveryIntent },
  ): DeliverySubmitResult | undefined {
    const registry = this.delivery
    if (!registry) {
      const errMsg = 'delivery registry not wired (composition root)'
      console.error(`[message-dispatcher] submit rejected: ${errMsg}, sid=${sessionId}`)
      this.messageBus?.publish(sessionId, { type: 'message.error', payload: { sessionId, message: `消息未发送：${errMsg}` } })
      return undefined
    }
    const result = registry.submit(sessionId, {
      content,
      ...(opts.images !== undefined && { images: opts.images }),
      ...(opts.clientUuid !== undefined && { clientUuid: opts.clientUuid }),
      ...(opts.intent !== undefined && { intent: opts.intent }),
    })
    console.log(
      `[message-dispatcher] submitted to delivery kernel: sid=${sessionId}, id=${result.clientUuid}, lane=${result.lane}, state=${result.state}`,
    )
    return result
  }

  /**
   * 运行 BeforeSend hook：返回 { blocked: true } 时调用方应中止发送；
   * 返回 { modifiedContent } 时调用方应以改写后的文本发送（transform 语义，Fix-1）。
   * 统一处理 hook 拦截（blocked）与 hook 自身异常（广播 message.error 后视作 blocked）。
   */
  private async runBeforeSendHook(
    sessionId: string,
    hookContent: string,
  ): Promise<{ blocked: boolean; modifiedContent?: string }> {
    if (!this.sendMessageHook) return { blocked: false }
    try {
      const hookResult = await this.sendMessageHook(sessionId, hookContent)
      if (hookResult?.blocked) {
        const msg = { type: 'message.error' as const, payload: { sessionId, message: hookResult.reason ?? 'Message blocked by plugin hook' } }
        this.messageBus?.publish(sessionId, msg)
        return { blocked: true }
      }
      if (typeof hookResult?.modifiedContent === 'string') {
        return { blocked: false, modifiedContent: hookResult.modifiedContent }
      }
      return { blocked: false }
    } catch (e) {
      console.error('[message-dispatcher] sendMessage hook error:', e)
      const msg = { type: 'message.error' as const, payload: { sessionId, message: 'Plugin hook error: ' + (toErrorMessage(e)) } }
      this.messageBus?.publish(sessionId, msg)
      return { blocked: true }
    }
  }

  /**
   * 中止 session 当前 turn（协作式 abort RPC）：成功 → occupancy #9 idle 复位 + stopped 终态
   * 写入 + message.complete{aborted} 收尾广播；失败 → 显式上报收尾（occupancy 复位 + stopped
   * 终态 + error 广播）。
   * [ADR-0122 退役登记] abort RPC 超时三级阶梯（chat-domain-v1x-liveness-governance W7/D3，
   * 含 FROZEN_EVENT_SILENCE_MS 10min 保守窗——推翻 crash-forensics 附录 E 对 abort 阶梯
   * 兜底的背书）已随 RPC 墙钟超时整体删除。
   * [pi-stall-detection U2 / D2①] 停止升级链：abort await 施加有界等待（ABORT_UPGRADE_WINDOW_MS
   * 升级窗）——窗内回执走既有成功路径；窗满未回执 = 对挂死对象协作式请求已证不可达，自动
   * 升级 forceQuitSession 完成停止意图（AX4 有界完成；PI 卡死形态从无限悬挂变有界收敛）。
   * 升级 source 分型：'user' → abort_timeout（用户停止分型，K2 语义不变）；'convergence'/
   * 'agent'/'stall_auto'（机器路径）→ probe_stall_auto_quit（机器判定无用户意图参与，不置
   * 用户分型——RL3 机器路径断言落点）；升级 reason 文案随分型同路分流（见升级分支内注释）。
   * 用户路径升级后恢复归用户显式重开（dead 标记 + restore 路径，历史完整）。
   *
   * [U2 修复] source 分型（默认 'user' 既有调用方零改动）：'convergence' 由收敛环通路传入
   * （session-service gate.configure 接线），成功路径终态 reason 写 'Convergence abort (auto)'
   * ——收敛环掐的是 runtime 自动收敛的补发 turn，终态/日志不得谎报用户操作语义。'agent'
   * （session_manager abort 工具）同理写 'Agent aborted (session_manager)'。aborted 完成帧
   * 广播各种 source 均保持不变（前端 no-op，U2 明确不动广播逻辑）。
   *
   * [chat-flow-consistency abort 入口三分型（design-turn-statemachine 缺陷 2 + 缺陷 10，
   * 同批落地）] 成功路径按入口快照 turnAtEntry 分三型：
   * - 型 1「有回合可中止」（turnAtEntry ∈ {dispatching, generating}）：现状路径不变
   *   （'idle' 转移 + stopped 终态 + complete{aborted} 广播 + reconcile）。
   * - 型 2「压缩取消」（compactionCancel，原分支语义保留）：不写终态、不广播、**不动
   *   turn**（'idle' 调用已移入型 1——缺陷 10：原实现在判型前无条件复位 turn，settling+
   *   compacting 时把 settling 提前旁路为 idle；压缩取消期 turn 原值只能是 idle/settling，
   *   settling 留给 agent_settled 收口，compacting 维由 pi compaction_end{aborted} 事件复位）。
   * - 型 3「收尾窗口无回合可中止」（turnAtEntry = settling，含已空闲）：pi 侧 abort 对
   *   idle/settling 幂等 no-op——不写 stopped 终态（done 已写，覆盖即谎报「回合被中止」）、
   *   不广播 complete{aborted}（无实体可收尾）、occupancy 不动（settling 留给 agent_settled
   *   的 'idle' 转移正常收口）、reconcile('abort-idle') 照跑（队列滞留回收幂等无害）。
   * 入口快照在 await 前取——事件流与 RPC reply 到达序不定，await 后读会漂移。
   *
   * [pi-stall-detection U4 / D3] opts.reasonHint：'stall_auto'（静默判死自动 abort）携带的
   * steer 注入文案——成功回执路径（abort 即达）在收尾后经自动处置端口注入（agent 循环带
   * 着死因提示继续）；悬挂升级路径经 scheduleAutoRecovery 携带同文案（恢复成功后注入）。
   * 两路径互斥（升级即强杀，成功路径不可达），无双注入。
   */
  async abort(sessionId: string, source: AbortSource = 'user', opts?: { reasonHint?: string }): Promise<void> {
    const client = this.getClientOrThrow(sessionId)
    // 中止意图快照先于 await 取（事件流与 RPC reply 到达序不定，await 后读会因
    // compaction_end / agent_settled 已处理而漂移）。压缩期无回合在跑（¬isGenerating）时
    // 用户的「停止」中止的是压缩流程而非回合——成功路径走压缩取消语义（见方法头注）。
    const activeAtEntry = this.svc.getSessionByClient(client)
    const entryOcc = activeAtEntry?.occupancy
    const compactionCancel =
      source === 'user' && !!activeAtEntry && entryOcc?.compacting === true && !isGeneratingTurn(entryOcc.turn)
    // 型 1 判定（有回合可中止）：dispatching/generating 两相；settling/idle 归型 3。
    const turnAbortableAtEntry = isGeneratingTurn(entryOcc?.turn)
    try {
      // [pi-stall-detection U2] 有界等待包装：窗内 settle 透传（成功/显式失败原样走既有
      // 路径）；窗满抛 AbortUpgradeWindowError → 升级分支。迟到的 abort 回执经包装内
      // then 双分支消费，无 unhandledRejection；悬挂 pending 表项随强杀 exit 链 rejectAll 清理。
      await abortWithUpgradeWindow(client, ABORT_UPGRADE_WINDOW_MS)
    } catch (e) {
      if (e instanceof AbortUpgradeWindowError) {
        // 升级窗窗满：协作式请求不可达已证，自动升级强杀完成停止意图（编排唯一实现
        // forceQuitSession；幂等 join 防与右键/restore 兜底双杀）。
        const upgradeSource: ForceQuitSource = source === 'user' ? 'abort_timeout' : PROBE_STALL_AUTO_QUIT
        // 升级文案随 upgradeSource 分流（D2 消费裁决：判死分型 reason 含「会话停滞已
        // 自动终止与恢复」语义、机器路径套用户停止文案 = 终态谎报）：user →
        // ABORT_TIMEOUT_*；convergence/stall_auto（升级后进窄化自动恢复）→ STALL_*；
        // agent（显式停止意图、不进自动恢复——V11 e）→ AGENT_ABORT_TIMEOUT_*（不含
        // 自动恢复承诺，「重新打开即可恢复」与显式重开事实一致）。
        const [outcomeReason, exitReason] =
          source === 'user'
            ? [ABORT_TIMEOUT_OUTCOME_REASON, ABORT_TIMEOUT_EXIT_REASON]
            : source === 'agent'
              ? [AGENT_ABORT_TIMEOUT_OUTCOME_REASON, AGENT_ABORT_TIMEOUT_EXIT_REASON]
              : [STALL_OUTCOME_REASON, STALL_EXIT_REASON]
        console.warn(
          `[message-dispatcher] abort hung past upgrade window (${ABORT_UPGRADE_WINDOW_MS}ms, source=${source}) — escalating to forceQuitSession (source=${upgradeSource}), sid=${sessionId}`,
        )
        await this.forceQuitSession(sessionId, outcomeReason, exitReason, upgradeSource)
        // 恢复语义按入口分型（D2① 消费方裁决 ①③④ + U4 判死分流）：① 用户停止 → 显式
        // 重开（不进自动恢复）；③ convergence（noteAgentStart 掐的是恢复回放 turn）→ 升级
        // 强杀后进窄化自动恢复（再次恢复属同一恢复过程）；④ agent 显式停止 → 不进自动恢复
        // （自动接回与意图相悖，防强杀-恢复循环；恢复归 agent/用户显式重开）；② 静默判死
        // （stall_auto，U4/RL16）→ 进窄化自动恢复（判死自动恢复是设计内承诺）——reasonHint
        // 随恢复链注入（恢复成功后 steer）。
        if (source === 'convergence' || source === 'stall_auto') this.scheduleAutoRecovery(sessionId, opts?.reasonHint)
        return
      }
      // [HISTORICAL] abort await 失败也必须广播终态（规则 #3）：否则前端 isStreaming / runtime
      // isGenerating 永不复位，UI 卡在「思考中」。失败信号来源 = pi 进程退出/流错误经 exit/error
      // 事件链 rejectAll（rpc-client.ts），靠这条收尾；窗满悬挂不再走此路径（上方升级分支承接）。
      const errMsg = toErrorMessage(e)
      console.error(`[message-dispatcher] abort failed (source=${source}): sessionId=${sessionId}`, errMsg)
      // 先取 active 再 destroy——destroySession 会删 processes/clientToId 条目，
      // 之后再经 getSessionByClient 反查会拿 undefined。
      const active = this.svc.getSessionByClient(client)
      if (active) {
        // occupancy #9（D2 迁移）：abort await 失败收尾 → 'idle' 行（进入此分支的都是 pi 已
        // 退出/流错误等显式失败，agent_settled 不会再到达，turn 不能停留在
        // dispatching/generating/settling）。
        applySessionOccupancyTransition(active, this.messageBus, 'idle')
      }

      // 非超时错误（EPIPE / 进程已退出 / RPC 显式失败等）：显式上报收尾（规则 #3）。
      // W4：abort 失败（异常退出）写 stopped 终态
      this.svc.persistSessionOutcome(sessionId, 'stopped', `Abort failed: ${errMsg}`)
      const abortErrMsg = { type: 'message.error' as const, payload: { sessionId, message: `Abort failed: ${errMsg}` } }
      this.messageBus?.publish(sessionId, abortErrMsg)
      return
    }
    // [HISTORICAL] abort 成功后必须主动广播 message.complete{stopReason:'aborted'} + 复位
    // occupancy。不能依赖 pi 自发 agent_end——pi 卡死（静默不退出）时永远不会发。
    // session-message-handler 的 message.status{status:'aborted'} reply 走 pending 通道，
    // 只让 renderer 的 abort() Promise resolve，不触发 chat store 的 message.complete 收尾
    // 逻辑（chat-message-effects 只认 'message.complete' type），isStreaming 仍为 true。
    // 广播流式 message.complete 让前端正常收尾（与 sendPrompt 错误路径广播 message.error 对称）。
    // [缺陷 10] 'idle' 转移只允许在型 1（有回合被中止）内调用——型 2/型 3 不动 turn：
    // compactionCancel 期 turn 原值 idle/settling；settling 由 agent_settled 正常收口。
    const active = this.svc.getSessionByClient(client)
    if (active && turnAbortableAtEntry) {
      applySessionOccupancyTransition(active, this.messageBus, 'idle')
    }
    // 型 2（压缩取消）/ 型 3（收尾窗口/已空闲，无回合可中止）：无 turn 被中止 → 不写 stopped
    // 终态、不广播 message.complete{aborted}（理由见方法头注）；队列对账照跑（压缩期/收尾期
    // 排队的消息按对账器正常投出）。
    if (!turnAbortableAtEntry) {
      if (compactionCancel) {
        console.warn(`[message-dispatcher] compaction cancel accepted (no turn in flight), sid=${sessionId}`)
      } else {
        console.warn(`[message-dispatcher] abort no-op (turn not abortable at entry), sid=${sessionId}`)
      }
      void this.delivery?.reconcile(sessionId, 'abort-idle')
      return
    }
    // W4：abort 写 stopped 终态。[U2] reason 按发起方分型：收敛环 re-abort（restore-abort
    // 收敛环掐补发 turn / 掐 idle pi）是 runtime 自动收敛而非用户操作，写区分性文案——
    // 终态 entry 是「谁 stopped 了 session」的权威记录，语义不得谎报。'agent'（session_manager
    // abort 工具）同理：agent 发起的显式停止不是用户操作。
    // [第一终态优先] persistSessionOutcome 统一层已带已有终态跳过（abort 与 pi 自发 agent_end
    // 并发的竞态兜底：done 先写则本写跳过——回合自然完成）。
    if (source === 'convergence') {
      console.warn(`[message-dispatcher] convergence abort (runtime auto, userStopped convergence loop), sid=${sessionId}`)
      this.svc.persistSessionOutcome(sessionId, 'stopped', 'Convergence abort (auto)')
    } else if (source === 'agent') {
      console.warn(`[message-dispatcher] agent abort accepted (session_manager tool), sid=${sessionId}`)
      this.svc.persistSessionOutcome(sessionId, 'stopped', 'Agent aborted (session_manager)')
    } else if (source === 'stall_auto') {
      // [pi-stall-detection U4] 静默判死自动 abort 成功回执（abort 信号即时生效形态——LLM
      // 请求类悬挂）：机器判定终态，文案区分于用户停止。
      console.warn(`[message-dispatcher] silence judge auto abort accepted (T elapsed, no in-flight signal), sid=${sessionId}`)
      this.svc.persistSessionOutcome(sessionId, 'stopped', 'Silence judge auto abort (stall_auto)')
    } else {
      console.warn(`[message-dispatcher] user abort accepted, sid=${sessionId}`)
      this.svc.persistSessionOutcome(sessionId, 'stopped', 'User aborted')
    }
    const completeMsg = { type: 'message.complete' as const, payload: { sessionId, stopReason: 'aborted' as const } }
    this.messageBus?.publish(sessionId, completeMsg)
    // [pi-stall-detection U4 / D3 / RL13] 判死 steer 注入（成功回执路径）：agent 循环带着
    // 死因提示继续。fire-and-forget——投递失败 warn 降级，不阻断恢复（occupancy 已复位、
    // 会话可用不受影响）；端口未接线（存量测试形态）静默跳过。悬挂升级路径的注入由
    // scheduleAutoRecovery 携带 reasonHint（互斥——升级即强杀，本路径不可达）。
    if (source === 'stall_auto' && opts?.reasonHint) {
      const hint = opts.reasonHint
      void this.stallAutoDisposePort?.injectReasonHint(sessionId, hint).catch((e: unknown) => {
        console.warn(`[message-dispatcher] stall reason hint injection failed (non-blocking, recovery already done), sid=${sessionId}:`, toErrorMessage(e))
      })
    }
    // [投递所有权内核 u2 / D3 触发点③ + D10 子形态] abort 完成 → occupancy 已复位 idle →
    // 对账器本轮回收 pi 槽位滞留（abort 不清 pi 队列，F5）并立即重投，避免用户消息滞留
    // 等下一次发送才被顺带取走（故事 B 形态）。fire-and-forget（对账内部自节流/幂等）。
    void this.delivery?.reconcile(sessionId, 'abort-idle')
  }

  /**
   * forceQuit —— 强制退出 session：跳过协作式 abort RPC，直接杀 pi 进程并走强杀收敛编排
   *（forceQuitSession）。
   *
   * 到达入口：① 用户右键「强制退出」（session.forceQuit RPC——pi 卡在 processing，前端
   * isGenerating 已丢失 / retry 窗口等不一致态，Composer 无 stop 按钮可用、新 prompt 被 pi
   * 拒绝）；② restore-abort 收敛环失败兜底（session-lifecycle applyRestoreAbortConvergence
   * 的 forceQuitFallback 注入，AS7 ②路径）。abort 悬挂升级链（pi-stall-detection U2 / D2①）
   * 与探测判死自动强杀不经本方法——它们在 abort 编排 / handleStallDetermination 内部直达
   * forceQuitSession 同一编排。
   *
   * session.exited 广播后前端标记 dead，点击 dead session 走 restore 重开（历史完整）。
   */
  async forceQuit(sessionId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      // 不在活跃进程表（已退出 / 未 spawn）：无可杀对象。菜单入口对 dead/idle
      // 历史 session 隐藏，此分支是「菜单渲染后 session 恰好退出」的竞态兜底。
      // [U3 修复] 早退也须置 userStopped 标记：用户点「强制退出」的意图与进程死活无关
      // （与 K1 同源）——无 client 时 pi 可能已自行 spawn 恢复链（restore replay turn），
      // 缺标记会让后续 restore 的收敛环不设防，被杀的旧执行复活。
      // [code-harden RT-4#1] 幂等成功仅限「无条目或占用已复位」：条目还在且 occupancy≠idle
      // 时，占用态已卡死且事件源已断（无进程可再产生 agent_settled）——按「幂等成功」返回
      // 是假成功（前端 isGenerating/turn 派生视图永久滞留），必须继续走 forceQuitSession 完整
      // 收敛链（stopped 终态 + full-reset + session.exited + removeEntry）。
      const session = this.svc.getSession(sessionId)
      const occ = session?.occupancy ?? IDLE_SESSION_OCCUPANCY
      const occupied = occ.turn !== 'idle' || occ.compacting || occ.bash
      if (!session || !occupied) {
        console.log(`[message-dispatcher] forceQuit: session ${sessionId} not active, nothing to kill (userStopped mark still set)`)
        userStoppedGate.markUserStopped(sessionId, 'user_force_quit')
        return
      }
      console.warn(`[message-dispatcher] forceQuit: session ${sessionId} has no live process but occupancy not idle (turn=${occ.turn}${occ.compacting ? ', compacting' : ''}${occ.bash ? ', bash' : ''}) — running convergence chain instead of idempotent success`)
      await this.forceQuitSession(sessionId, 'User forced quit', '用户强制退出，进程已终止。重新打开该 session 即可恢复（历史完整）。', 'user_force_quit')
      return
    }
    // D5①（session-dead-structural-fixes）：kill 路径全量日志 K1——含调用源（kill_source）
    // 与触发信号链（谁发起、为什么），exit 143 类进程死亡可从此行回溯到发起方。
    console.warn(`[message-dispatcher] force quit requested by user, killing session ${sessionId} (kill_source=user_force_quit | who: user via session.forceQuit RPC | chain: skip abort -> SIGTERM destroy -> persist stopped -> occupancy reset -> session.exited)`)
    // D4 置位分型 K1：用户强制退出 = 「用户要停」，置标记。
    await this.forceQuitSession(sessionId, 'User forced quit', '用户强制退出，进程已终止。重新打开该 session 即可恢复（历史完整）。', 'user_force_quit')
  }

  /**
   * 停滞判定自动处置链入口（pi-stall-detection U2 / D2②；组合根 onSilentAbort 接线点，
   * 经 SessionService.handleStallDetermination 转发）：按第 0 层进程存活信号分型分流——
   * - 进程死（exit 链已到达 / client 缺失）：维持既有协作式 abort 显式收尾路由（abort 即拒
   *   → 显式失败收尾广播——AS9 链路逐点不变，崩溃恢复不回潮 outOfScope ④）；
   * - 进程存活（事件循环挂死形态，3 次观测超时 = get_state 同步内存读强不变量被破坏，
   *   确定性停滞、无误杀范围）：sample 取证（D6）→ 判死强杀（source=probe_stall_auto_quit，
   *   置位判死分型标记）→ 窄化自动恢复触发链（标记分型消费 → facade.restoreSession →
   *   注入原因提示；恢复失败降级死亡发声 + 用户手动重开）。
   */
  async handleStallDetermination(sessionId: string): Promise<void> {
    const client = this.pm.getClient(sessionId)
    if (!client || client.exited) {
      console.warn(
        `[message-dispatcher] stall determination: process already dead (${client ? 'exit arrived' : 'no client'}) — keeping existing explicit-failure route, sid=${sessionId}`,
      )
      await this.abort(sessionId)
      return
    }
    console.warn(`[message-dispatcher] stall determination: pi alive but stalled (health probe unresponsive) — auto-dispose chain starting, sid=${sessionId}`)
    // D6：强杀前 sample 调用栈取证（尽力而为，失败不阻断强杀——AX4 有界完成优先）。
    await this.captureStallForensics(sessionId, client)
    // 判死强杀（编排唯一实现；置位判死分型标记，收尾三步 finally 必达——SI8 前提①）。
    await this.forceQuitSession(sessionId, STALL_OUTCOME_REASON, STALL_EXIT_REASON, PROBE_STALL_AUTO_QUIT)
    // 窄化自动恢复触发链（SI8 ②③：分型消费 → 恢复执行；fire-and-forget——强杀编排已完成，
    // 恢复链内部自带延迟 / 重试上限 / 失败降级发声，异常不外溢）。
    this.scheduleAutoRecovery(sessionId)
  }

  /**
   * 强杀前死因取证（pi-stall-detection U2 / D6）：macOS `sample <pid> 2 -file <path>` 采样
   * 调用栈，产物落会话存储树 logs 域（getSessionLogsDir = ext-sessions/<sessionId>/logs/，
   * 随会话删除整树自动回收，ADR-0151）；非 macOS / 无 pid 跳过留痕；执行失败（非零退出 /
   * 超时）warn 留痕一行、不阻断强杀（AX4）。返回产物路径（成功）或 null（跳过/失败）。
   */
  private async captureStallForensics(sessionId: string, client: IPiEngine): Promise<string | null> {
    const port = this.stallAutoDisposePort
    const platform = port?.platform?.() ?? process.platform
    if (platform !== 'darwin') {
      console.log(`[message-dispatcher] stall forensics skipped: sample unsupported on ${platform} (non-macOS), sid=${sessionId}`)
      return null
    }
    const pid = client.pid
    if (pid === null) {
      console.log(`[message-dispatcher] stall forensics skipped: no live pid, sid=${sessionId}`)
      return null
    }
    const logsDir = getSessionLogsDir(sessionId)
    const outPath = join(logsDir, `stall-sample-${Date.now()}.txt`)
    try {
      await mkdir(logsDir, { recursive: true })
      await (port?.runStallSample ?? defaultRunStallSample)(pid, outPath)
      console.log(`[message-dispatcher] stall forensics saved: ${outPath} (pid=${pid}, sid=${sessionId})`)
      return outPath
    } catch (e) {
      console.warn(`[message-dispatcher] stall forensics failed (non-blocking, force-quit proceeds), sid=${sessionId}:`, toErrorMessage(e))
      return null
    }
  }

  /**
   * 窄化自动恢复触发链调度（pi-stall-detection U2 / D2②；新建链——AS17 核实「死亡边沿 →
   * 自动调恢复」现状不存在，新建的是触发链、恢复执行本体复用 pi-respawn 簿记组件经
   * facade.restoreSession 收敛）。fire-and-forget：强杀编排已完成，恢复链失败有降级路径。
   *
   * [pi-stall-detection U4] reasonHint：恢复成功后注入的 steer 文案——判死升级链
   *（stall_auto）携带静默判死文案（D3：恢复后 agent 循环带着死因上下文继续），缺省回落
   * 第 1 层探测判死文案（STALL_REASON_HINT）。
   */
  private scheduleAutoRecovery(sessionId: string, reasonHint?: string): void {
    void this.runAutoRecovery(sessionId, reasonHint)
  }

  /**
   * 自动恢复触发链本体（SI8 三前提对账）：① 强杀收尾三步已完成（调用点在 forceQuitSession
   * await 之后——finally 必达，构造性满足）；② 判死分型标记被接线消费（restore 前消费——
   * 标记不清则 restore-abort 收敛环与 noteAgentStart 把恢复掐掉；用户分型不被消费、恢复归
   * 用户显式重开）；③ 恢复执行就绪（port.restoreSession = facade.restoreSession，join 单源）。
   * 延迟 / 重试上限（AUTO_RECOVER_DELAY_MS / AUTO_RECOVER_MAX_ATTEMPTS）实施期校准；重试
   * 只重试 restore（标记首次已消费，重试恢复不被门禁拦截）；重试耗尽降级死亡发声 + 用户
   * 手动重开（不静默循环——D2 恢复段承诺）。
   */
  private async runAutoRecovery(sessionId: string, reasonHint?: string): Promise<void> {
    const port = this.stallAutoDisposePort
    if (!port) {
      console.error(`[message-dispatcher] stall auto-recovery port not wired — session ${sessionId} stays dead (manual reopen; recovery chain skipped)`)
      return
    }
    try {
      // SI8 ②：分型消费（置位者即消费者的同权消费，D2 显式裁决）。消费不到 = 标记为用户
      // 分型（双入口并发用户先到 / 既有用户停止标记在场）或已清——用户意图优先，不自动恢复。
      if (!port.consumeAutoRecoveryMark(sessionId)) {
        console.warn(`[message-dispatcher] auto-recovery skipped: userStopped mark is not machine-verdict type (user intent takes precedence), sid=${sessionId}`)
        return
      }
      for (let attempt = 1; attempt <= AUTO_RECOVER_MAX_ATTEMPTS; attempt += 1) {
        await delay(AUTO_RECOVER_DELAY_MS)
        try {
          await port.restoreSession(sessionId)
          console.warn(`[message-dispatcher] auto-recovery restored session ${sessionId} (attempt ${attempt}) — injecting reason hint`)
          try {
            // [pi-stall-detection U4] 注入文案按到达入口分型：判死升级链（stall_auto）携带
            // 静默判死文案，第 1 层探测判死回落 STALL_REASON_HINT（RL13 失败 warn 降级）。
            await port.injectReasonHint(sessionId, reasonHint ?? STALL_REASON_HINT)
          } catch (e) {
            // best-effort 降级：恢复已完成、注入失败不回滚恢复（RL13 warn 降级路径）
            console.warn(`[message-dispatcher] reason hint injection failed (non-blocking, recovery already done), sid=${sessionId}:`, toErrorMessage(e))
          }
          return
        } catch (e) {
          // best-effort 降级：单次恢复失败重试下一轮（上限 AUTO_RECOVER_MAX_ATTEMPTS，耗尽走死亡发声）
          console.error(`[message-dispatcher] auto-recovery attempt ${attempt}/${AUTO_RECOVER_MAX_ATTEMPTS} failed, sid=${sessionId}:`, toErrorMessage(e))
        }
      }
      console.error(`[message-dispatcher] auto-recovery exhausted (${AUTO_RECOVER_MAX_ATTEMPTS} attempts) — degrading to death announcement + manual reopen, sid=${sessionId}`)
      port.reportDeath(sessionId)
    } catch (e) {
      // best-effort 降级：恢复链整体异常不向调用方传播（判死强杀已终局，会话已回 idle 态）
      console.error(`[message-dispatcher] auto-recovery chain escaped (sessionId=${sessionId}):`, e)
    }
  }

  /**
   * 第 2 层静默判死入口（pi-stall-detection U4 / D3；组合根 onStallJudge 接线点，经
   * SessionService.handleSilenceJudgeDetermination 转发）：静默矩阵判定（超 T + 无在途
   * 信号 + 无豁免锚点 + 非 backoff 宽限）后自动 abort——
   * - abort 复用 U2 有界等待（升级窗）：pi 事件循环活可接收——abort 信号贯穿 SDK 请求即时
   *   生效（成功回执路径）→ stopped 终态 + occupancy 复位 + steer 注入（reasonHint 携带
   *   静默时长/在途阶段/判定依据——D3「agent 循环带着提示继续」）；
   * - 无自愈窗判死目标形态（C4 族——工具永不返回）abort 对 pi 同样悬挂（pi 侧 waitForIdle，
   *   AS4/SI7）→ 窗满升级走判死强杀分型（source=PROBE_STALL_AUTO_QUIT，不置 abort_timeout
   *   用户分型——RL16）→ 判死自动恢复接线接回会话（标记分型消费 + restore）→ 恢复后注入。
   *   悬挂升级在本层不是边缘兜底：它是 C4 形态获得自动出口的必经路径（D3 原文）。
   */
  async handleSilenceJudgeDetermination(sessionId: string, payload: StallJudgePayload): Promise<void> {
    console.warn(
      `[message-dispatcher] silence judge determination: auto-aborting stalled turn (silent=${Math.round(payload.silentMs / MS_PER_SECOND)}s, phase=${payload.phase}), sid=${sessionId}`,
    )
    await this.abort(sessionId, 'stall_auto', { reasonHint: composeStallJudgeHintText(payload) })
  }

  /**
   * 强杀收敛编排（终态编排唯一实现，pi-stall-detection U2 到达入口清点）：到达入口 = ①
   * forceQuit（用户右键 RPC / restore-abort 收敛环失败兜底 forceQuitFallback，AS7 既有两条）
   * + ② 停止升级链（abort 悬挂超窗，source=abort_timeout，D2① 主案）+ ③ 第 1 层探测判死
   * 自动处置（handleStallDetermination，source=probe_stall_auto_quit）+ ④ 机器 abort 路径
   * 悬挂升级（source=probe_stall_auto_quit，D2① 消费方 ③④）。编排 = detach → destroy →
   * persist stopped → 广播 session.exited → removeEntry。收敛需手动编排而非依赖 pm.onSessionExit
   * 回调：kill 路径的 exit 事件被双层检查拦截（rpc-client.kill 置 _killing 跳过 exitCallback；
   * process-manager 的 exit 回调按 processes.has 拦截 intentional destroy），不会传播到
   * session-service 的 onSessionExit 收敛链。编排与 lifecycle.delete / onSessionExit 回调同构，
   * 非新发明。
   *
   * [pi-stall-detection U2] 双入口并发幂等（U2 检查点）：并发到达的第二调用方 join 同一
   * in-flight Promise（单次编排、单次置位、单次 session.exited），对齐 pi-respawn
   * ensureRestored join 先例——升级强杀与右键/restore 兜底并发时不双杀。
   *
   * outcomeReason 进终态 entry（诊断）；exitReason 经 session.exited 广播给用户（可操作指引；
   * 判死分型文案在强杀调用点组装为可读文案，renderer/scanner 零映射分支改动——D2 消费裁决）。
   *
   * [D4] source 为置位分型（K1 user_force_quit / K2 abort_timeout 用户分型；K9
   * probe_stall_auto_quit 机器判死分型）：编排开头置 userStopped 标记（宿主 =
   * user-stopped-mark-store.ts 模块级 Map，独立于 ManagedSession 生命周期——尾步
   * removeSessionEntry 删条目后标记仍可被 restore 读到；session-service re-export 保持
   * 拆分前 import 兼容）。标记驱动 restore-abort 收敛环：被杀的旧执行（notify
   * replay / 补发路径）不得自动复活；K9 判死分型标记由自动恢复接线按 source 分型消费（RL15）。
   *
   * [code-harden RT-4#1] 失败语义：编排体 try/finally——detach / destroy / persist 失败
   * 降级为日志，不再阻断收敛；三步终态（full-reset / session.exited 广播 / removeEntry）
   * 在 finally 中必达（占位派生视图复位 + 前端 dead 标记 + 条目摘除），任一步异常只落日志 +
   * crash journal 登记（runDestroyStepIsolated，reason=destroy-chain-step-failed），不沿调用链上抛。
   * 本链刻意不含 respawn.schedule / config.sessions（用户手动强杀结构性不触发自动恢复，
   * 见 registerSessionExitHandler 注释——respawn 承诺只挂 onSessionExit 链；判死分型的窄化
   * 自动恢复由调用点之后的独立触发链承担，不在本编排内）。
   */
  private async forceQuitSession(sessionId: string, outcomeReason: string, exitReason: string, source: ForceQuitSource): Promise<void> {
    const inFlight = this.forceQuitInFlight.get(sessionId)
    if (inFlight) {
      console.warn(`[message-dispatcher] forceQuitSession already in flight — joining (idempotent single kill), sid=${sessionId}, requested source=${source}`)
      return inFlight
    }
    const run = this.runForceQuitSession(sessionId, outcomeReason, exitReason, source)
    this.forceQuitInFlight.set(sessionId, run)
    void run
      .catch(() => undefined)
      .then(() => {
        if (this.forceQuitInFlight.get(sessionId) === run) this.forceQuitInFlight.delete(sessionId)
      })
    return run
  }

  /** 强杀编排体（经 forceQuitSession 的 in-flight join 包装进入；一次会话窗口恰跑一次）。 */
  private async runForceQuitSession(sessionId: string, outcomeReason: string, exitReason: string, source: ForceQuitSource): Promise<void> {
    userStoppedGate.markUserStopped(sessionId, source)
    try {
      // 先 detach 再 destroy——destroySession 会删 processes/clientToId 条目，
      // 之后再经 getSessionByClient 反查会拿 undefined。
      this.svc.detachSession(sessionId)
      await this.pm.destroySession(sessionId)
      // stopped 终态须在 removeSessionEntry 前写（persistSessionOutcome 内部按 id 查
      // sessions Map，条目删除后静默跳过）。
      this.svc.persistSessionOutcome(sessionId, 'stopped', outcomeReason)
    } catch (e: unknown) {
      // detach/destroy/persist 失败只降级日志：收敛（终态三步）必须继续。
      console.error(`[message-dispatcher] forceQuitSession pre-terminal steps failed (sessionId=${sessionId}):`, e)
    } finally {
      // occupancy #10（D2 迁移，forceQuit/abort 超时收敛路径）：进程被强杀后 agent_settled /
      // compaction_end 永不到达，'full-reset' 行四维全复位（turn 机器 idle 行 + compacting/
      // bash/handingOff 布尔维全 false patch，结构上不再有「只复位一边」）——session.exited
      // 广播前发，且必须在 removeSessionEntry（内部 bus.clearSession）之前，否则帧送空集合。
      runDestroyStepIsolated('full-reset', sessionId, () => {
        const exiting = this.svc.getSession(sessionId)
        if (exiting) applySessionOccupancyTransition(exiting, this.messageBus, 'full-reset')
      })
      // session.exited 须在 removeSessionEntry 前发（其后 messageBus.clearSession 清空
      // 订阅者集合，再发等于消息被丢弃，前端一条也收不到）。code=null：强杀场景退出码未知，
      // 与 shared 协议「被信号杀死无退出码」语义一致。前端 handleSessionExited 会把
      // reason 作为 error 消息插入聊天流 + toast（与 pi 崩溃路径同一入口）。
      runDestroyStepIsolated('session.exited', sessionId, () => {
        const exitedMsg = { type: 'session.exited' as const, payload: { sessionId, code: null, reason: exitReason } }
        this.messageBus?.publish(sessionId, exitedMsg)
      })
      runDestroyStepIsolated('removeSessionEntry', sessionId, () => {
        this.svc.removeSessionEntry(sessionId)
      })
    }
  }

  /**
   * 直接执行 bash 命令（pi bash RPC，不经 LLM turn）——[MF-1-10] 委托 BashDispatcher
   * （实现整体搬移至 bash-dispatcher.ts；公开签名与行为逐字保持，时序不变量见彼处）。
   */
  sendBash(
    sessionId: string,
    command: string,
    excludeFromContext?: boolean,
  ): Promise<InternalBashDispatchReceipt> {
    return this.bash.sendBash(sessionId, command, excludeFromContext)
  }

  /**
   * [W1 fix-chat-flow-order D2] 按 sessionId 定向 flush bash 待落列——[MF-1-10] 委托
   * BashDispatcher（session-service 经 EventInterpreter.onAgentSettled 调用，签名不变）。
   */
  flushPendingBashResults(sessionId: string): void {
    this.bash.flushPendingBashResults(sessionId)
  }

  /**
   * 取消进行中的 bash 执行（pi abort_bash）——[MF-1-10] 委托 BashDispatcher（sent 回执
   * 真实化语义保持，见彼处方法头）。
   */
  abortBash(sessionId: string): Promise<{ sent: boolean }> {
    return this.bash.abortBash(sessionId)
  }

  /**
   * abort 共享的「getClient → 空抛」骨架。报错串保持 abort 历史形态（无前缀，测试锚定文本）；
   * bash 通道（abortBash）的同款骨架随 MF-1-10 搬移至 BashDispatcher（报错串逐字一致）。
   */
  private getClientOrThrow(sessionId: string): IPiEngine {
    const client = this.pm.getClient(sessionId)
    if (!client) {
      throw new Error(`Session ${sessionId} not found`)
    }
    return client
  }

  /**
   * busy 预检的拒绝原因（null = 不忙）。判定序 = compacting 优先（A 置位后 B 进来预检
   * 能看到）、bash 次之、生成中最后——文案与 rejectIfBusy 的 warn 日志共用。
   */
  private busyCompactReason(
    occ: SessionOccupancy | undefined,
  ): 'compaction already running' | 'bash running' | 'agent generating' | null {
    if (occ?.compacting === true) return 'compaction already running'
    if (occ?.bash === true) return 'bash running'
    if (isGeneratingTurn(occ?.turn)) return 'agent generating'
    return null
  }

  /**
   * [W3 + M4] busy 预检：与 sendBash 预检的 occupancy.compacting 拒绝对称 + 防并发 compact 重入。
   * 补 compacting 维：A 置位（interpreter 从 compaction_start 事件）后，B 进来预检若无 compacting
   * 看不到 A → 两个 client.compact RPC 并发 → 双 compaction 事件流。补上后事件层 P-dedup by construction 成立。
   *
   * 事件驱动（M4）：compaction 生命周期广播全删——由 interpreter 从 compaction_start/compaction_end
   * 唯一编排（session.compacting / message.compactionSummary / session.compacted / 对话流错误提示）。
   * dispatcher 退化为「预检 + RPC 触发 + 失败复位」三件事。
   */
  private rejectCompactIfBusy(sessionId: string, active: IManagedSessionView | undefined): void {
    const reason = this.busyCompactReason(active?.occupancy)
    if (reason === null) return
    const errMsg = `Cannot compact while ${reason}`
    console.warn(`[message-dispatcher] compact preemptive reject (busy), sid=${sessionId}, reason=${reason}`)
    // 对话流内联呈现（msg-pipeline-debloat D4-2）：busy 拒绝的可见部分从 renderer toast
    // 改为对话流 system 提示条目——走 message.stream_warn（非终结性提示通道：仅追加
    // system 消息、不调 finalizeSession，正在流式的 turn 不受影响；runtime 自产提示、
    // pi 无 entry 的正确入流形态）。不能用 message.error——其终态 effect 会把生成中的
    // assistant 误收尾为 error。renderer catch 见 compact_busy 分类码抑制 toast，双呈现
    // 不叠加。零生命周期广播不变：不广播 session.compacted{error}（预检在 RPC 前，pi
    // 未发 compaction_start，interpreter 状态机不参与）。
    this.messageBus?.publish(sessionId, { type: 'message.stream_warn', payload: { sessionId, content: errMsg } })
    // throw 扁平错误携带分类码（WorktreeService 同款 Object.assign 模式）→ handler
    // error envelope 原样透传 → renderer catch 按分类码路由（抑制 toast）。
    throw Object.assign(new Error(errMsg), { code: 'compact_busy' })
  }

  async compact(sessionId: string, customInstructions?: string): Promise<void> {
    const startTime = Date.now()
    const client = this.pm.getClient(sessionId)
    if (!client) {
      console.error('[message-dispatcher] compact: session not found, sessionId=' + sessionId)
      throw new Error(`Session ${sessionId} not found`)
    }

    console.log('[message-dispatcher] compact: start, sessionId=' + sessionId + ', customInstructions=' + (customInstructions ? `"${customInstructions}"` : '(none)'))

    const active = this.svc.getSessionByClient(client)
    // [chat-flow-consistency D1] 派生三布尔已删，忙闲读口 = occupancy 派生（isGeneratingTurn /
    // compacting / bash 维），语义与原读点逐字等价。
    this.rejectCompactIfBusy(sessionId, active)

    // [RT-4#10] 预检与置位原子化：预检通过后立即写 'compacting-start'（原语义 = 只在 pi
    // compaction_start 事件回流后由 interpreter 置位，事件往返窗内第二个 compact 的预检
    // 仍读 false → 两连发双双通过 → 双 compaction 事件流）。事件回流时 interpreter 的
    // 'compacting-start' 经原语全等去重幂等（不双写）。RPC 为同步等待压缩完成（pi 1.0.0
    // agent-session.js compact() await 全程），finally 的 'compacting-end' 复位与
    // compaction_end 事件三路对称复位语义保持。
    if (active) {
      applySessionOccupancyTransition(active, this.messageBus, 'compacting-start')
    }

    // 事件驱动（M4）：不广播 session.compacting——由 interpreter 从 compaction_start 事件驱动
    // （置位例外见上方 [RT-4#10]：预检互斥窗口要求 dispatcher 侧先行）。dispatcher 做 RPC 触发 + 失败复位。
    try {
      await client.compact(customInstructions)
      console.log('[message-dispatcher] compact: complete, sessionId=' + sessionId + ', elapsed=' + (Date.now() - startTime) + 'ms')
    } catch (e) {
      const errMsg = toErrorMessage(e)
      console.error('[message-dispatcher] compact: failed, sid=' + sessionId + ', err=' + errMsg + ', elapsed=' + (Date.now() - startTime) + 'ms')
      // 零广播：不广播 session.compacted{error}。pi 手动 compact 失败必发 compaction_end{errorMessage}
      // （agent-session.js:1464-1483 无静默路径），interpreter 统一编排失败提示（session.compacted{error} +
      // message.error 对话流提示）。此处只传播 RPC error，复位交由下方 finally（兜底防 transport 级失败
      // ——RPC 未达 pi / pi 来不及发 compaction_end——时 session 卡死）。
      throw e
    } finally {
      // 兜底复位：interpreter 的 compaction_end 是复位主力（三路对称），此处防 transport 级失败时
      // interpreter 未触发 compaction_end 导致 session 卡死。[RT-4#10] 置位移到预检后，本复位
      // 从「对 false 幂等无害」变为真实复位路径（成功路径与 compaction_end 事件幂等去重）。
      if (active) {
        // occupancy #6 兜底（D2 迁移，'compacting-end' 行）：transport 级失败时 compaction_end
        //（#6）不到达，compacting 维度在此镜像复位（派生 isCompacting=false；对未置位场景幂等无害）。
        applySessionOccupancyTransition(active, this.messageBus, 'compacting-end')
        // [MF-1-9] compacting 复位边沿：唤醒投递内核持有期等待者（兜底复位也是边沿源——
        // pi compaction_end 事件不可达时，这里是 compacting hold 释放的唯一信号）。
        this.delivery?.notifyHoldRelease(sessionId)
      }
    }
  }
}
