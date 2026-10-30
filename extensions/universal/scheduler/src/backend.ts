import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getDeliveryPort } from '@zhushanwen/pi-delivery-port'
import {
  readSchedulerStore,
  writeSchedulerStore,
} from '@zhushanwen/extension-protocol/scheduler-store'
import { getLogger } from '@zhushanwen/pi-extension-logger'

import type { ScheduledTask } from './types.js'

const logger = getLogger('scheduler')

// ── SchedulerBackend 接口 ──

/**
 * sendMessage 的 msg 形状（ext-simplify-17 B5）：与 pi 的 CustomMessage 鸭子对齐
 * （customType/display 必填）——pi 根入口不导出 CustomMessage，鸭子解耦只能文件内收敛，
 * 接口与实现两处共用（测试 mock-backend 持结构兼容的内联签名，不引用本 alias）。
 */
interface SchedulerMessage {
  content: string
  customType: string
  display: boolean
}

/** sendMessage 的 opts 形状：steer 直投选项（scheduler-steer-direct-dispatch 投递模型）。 */
interface SchedulerSendOptions {
  deliverAs?: 'steer'
  triggerTurn?: boolean
}

/**
 * 运行时协作后端抽象（依赖反转）。SchedulerRuntime 只依赖此接口：
 * 不触碰任务库文件、不持有 pi。
 *
 * - deliverDispatch: 到期 dispatch 的投递入口（unified-delivery 迁移，2026-10-25
 *   裁决）——生产实现经投递端口 port.deliver，注入参数与直发逐字一致，失败语义
 *   forget。详见方法注释。
 * - persistTasks: 任务集全量快照落盘（任务库与会话事实分离，2026-10-30 裁决）。
 *   生产实现 = 独立 JSON 快照文件的原子替换写；pi 会话 JSONL 只承载 dispatch 注入
 *   消息与用户对话，不承载任务数据。失败必须被调用方 try-catch（落盘失败语义：
 *   runtime 捕获后 logger.warn + 不 rethrow，内存态已更新，下写点重试）
 * - now: 时间源（测试可注入固定值）
 *
 * 读路径不在接口：loadTasks 由 PiSchedulerBackend 类方法承担（非接口成员），内部
 * 委托 readSchedulerStore 一次 JSON.parse（文件不存在 = 空任务集，正常路径），由
 * index.ts 装配点调用后经 runtime.loadTasks(tasks) 注入。
 *
 * delivery handle 不在本接口（ext-simplify-08 L2）：backend 自身不消费，由装配点经
 * SchedulerRuntime 构造器直传。
 */
export interface SchedulerBackend {
  /**
   * 到期 dispatch 的投递入口（unified-delivery 迁移）。生产实现经投递端口
   * port.deliver（getDeliveryPort 进程级槽，同 bash / session-manager / workflow /
   * notifier 四条提交链接入形态）：
   *
   * - 注入参数逐字一致：port 内部对 steer 档条目调用 host.sendMessage，
   *   形态与直发兜底完全相同（同 customType / content / display，
   *   deliverAs steer 档 + triggerTurn 直唤参数），仅 details 追加端口送达凭据
   *   deliveryId。
   * - 失败语义 forget（2026-10-25 裁决）：受理后注入失败端口首败即弃（落 discard
   *   终局，不重投）——重试由 scheduler 既有「failed 记账 + 下个 tick 重试」单通道
   *   承载，避免双通道重投造成用户重复提醒。
   * - 幂等键（idempotencyKey，必填）：调用方构造的每轮唯一键
   *   `${taskId}:${dispatchEpoch}`——taskId 恒定，裸 taskId 会被端口按终局条目
   *   永久判重吞掉（从第二轮起任务永不再提醒），epoch 必须含轮次维度。
   *
   * 返回语义：resolve = 已受理（accepted；swallowed = 同轮重复提交，消息已在
   * 系统内，受理即记账）；throw = 端口拒收（rejected：persist-failed / disposed
   * ——未受理未落账，幂等键未登记），调用方走 failed 记账，下个 tick 重试合法。
   * port 缺席（装配异常窗口）：降级直发 pi.sendMessage（原路径逐字不变 + warn
   * 留痕，at-most-once，仅覆盖装配异常窗口）。
   */
  deliverDispatch(msg: SchedulerMessage, opts: SchedulerSendOptions | undefined, idempotencyKey: string): Promise<void>
  /** 任务集全量快照落盘（快照语义见类注释；失败 throw，调用方降级）。 */
  persistTasks(tasks: ScheduledTask[]): void
  now(): number
}

/**
 * ctx.sessionManager 的最小可识别形状（duck-typed）。真实 ExtensionContext.sessionManager
 * 返回 pi 的 SessionManager（getSessionFile(): string|undefined），结构兼容本接口。
 * PiSchedulerBackend 只依赖这一个方法（快照 sessionFile 冗余字段来源）。
 */
export interface SchedulerBackendCtx {
  sessionManager: {
    getSessionFile(): string | undefined
  }
}

/**
 * 生产后端：任务库快照文件读写（唯一持久化通道）+ 投递端口 dispatch + Date.now()。
 *
 * 持久化（scheduler-redesign 方案 B，2026-10-30 裁决）：任务定义与调度记账写独立
 * JSON 快照（按 owner sessionId 分片、原子替换写），**不写 pi 会话 JSONL**——会话
 * JSONL 只承载 dispatch 注入消息（会话事实，到点注入时对话必然已存在，消息自身即
 * 过 pi 首写门控）与用户对话；任务数据不进会话流，故无首写门控依赖。
 *
 * storeFilePath 由装配点（index.ts session_start）经 schedulerStoreFilePath(
 * getAgentDir(), ctx.cwd, sessionId) 推导后注入——backend 不持有路径推导知识，
 * 测试注入临时目录路径即可全行为覆盖（设计 §6.2「TaskStore 是纯 FS 模块，注入
 * 路径即可测」）。
 */
export class PiSchedulerBackend implements SchedulerBackend {
  private ctx: SchedulerBackendCtx
  private pi: Pick<ExtensionAPI, 'sendMessage'>
  private readonly storeFilePath: string

  constructor(
    ctx: SchedulerBackendCtx,
    pi: Pick<ExtensionAPI, 'sendMessage'>,
    storeFilePath: string,
  ) {
    this.ctx = ctx
    this.pi = pi
    this.storeFilePath = storeFilePath
  }

  /**
   * 读路径：一次 JSON.parse 重建任务集（非接口成员，由装配点 session_start 调用）。
   * - 文件不存在（missing）→ 空任务集（新 session / fork / 从未建任务，正常路径）
   * - 损坏（corrupt）→ store 模块已改名留证 + warn（注入），空任务集继续（调度
   *   不中断，与旧「恢复失败显式降级」语义一致）
   * - 其他读错误（EACCES 等）上抛——装配点 catch 显式降级（warn + 空任务集继续
   *   装配），不在这里折叠成静默空集
   */
  loadTasks(): ScheduledTask[] {
    const read = readSchedulerStore(this.storeFilePath, {
      warn: (message, context) => logger.warn(message, context),
    })
    if (read.kind === 'ok') return read.tasks
    return []
  }

  /** 写路径：全量快照 + 原子替换（tmp → rename）。sessionFile 冗余字段供排障对账。 */
  persistTasks(tasks: ScheduledTask[]): void {
    writeSchedulerStore(this.storeFilePath, {
      sessionFile: this.ctx.sessionManager.getSessionFile(),
      tasks,
    })
  }

  /**
   * 到期 dispatch 的投递入口（unified-delivery 迁移；接口契约见 SchedulerBackend
   * .deliverDispatch 注释）。port.deliver 同步返回受理回执：
   * - accepted：受理即记账（受理前已落投递日志 outbox，注入直达 pi 唯一队列）。
   *   注入期失败（受理后 sendMessage throw）不在此上抛——端口按 forget 首败即弃
   *   （2026-10-25 裁决），该轮提醒丢失为已裁决代价（丢一轮 << 重投造成重复提醒）。
   * - swallowed：同轮重复提交（幂等键命中在途/终局条目）——消息已在系统内，
   *   按已受理返回（重复走 failed 记账会双通道重投）。
   * - rejected（persist-failed / disposed）：未受理未落账——throw 给 runtime 走
   *   既有 catch（模型恢复 + failed 记账 + 下个 tick 重试，单通道重试）。
   *
   * timing 恒 'steer'（scheduler-steer-direct-dispatch 投递模型：dispatch 只有
   * steer 一档，端口翻译为 host.sendMessage 的 steer 档同参形态，
   * 与直发兜底参数逐字一致）。
   *
   * 槽语义（同 bash notify.ts D17 形态）：getDeliveryPort() 在调用时点读进程级槽，
   * session_start 重绑后指向当代端口实例；scheduler runtime 的 stale 检查
   * （guardStaleCtx + isCtxStale）在 tick 层拦截旧代调用，本方法不再重复分诊。
   */
  async deliverDispatch(
    msg: SchedulerMessage,
    opts: SchedulerSendOptions | undefined,
    idempotencyKey: string,
  ): Promise<void> {
    const port = getDeliveryPort()
    if (port !== undefined) {
      const receipt = port.deliver(
        {
          id: idempotencyKey,
          timing: 'steer',
          payload: { kind: 'custom', customType: msg.customType, content: msg.content, display: msg.display },
        },
        { onFailure: 'forget' },
      )
      if (receipt.kind === 'rejected') {
        throw new Error(`scheduler dispatch rejected by delivery port (${receipt.reason}; key=${idempotencyKey})`)
      }
      return
    }
    // port 缺席（base-tool-enhance session_start 装配异常 / 版本混装窗口，生产不可达
    // 常态）：直发兜底——与迁移前 sendMessage 原路径逐字一致（at-most-once），warn 即修复信号。
    logger.warn(
      'delivery port not bound - scheduler dispatch falls back to direct send (no dedupe / no durability; check base-tool-enhance session_start bindDeliveryPort wiring)',
      { idempotencyKey },
    )
    await this.pi.sendMessage(msg, opts)
  }

  now(): number {
    return Date.now()
  }
}
