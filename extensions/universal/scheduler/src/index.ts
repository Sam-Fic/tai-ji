import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import type { GuiContext } from '@zhushanwen/extension-protocol'
import { schedulerStoreFilePath } from '@zhushanwen/extension-protocol/scheduler-store'
import { toErrorMessage } from '@zhushanwen/pi-ext-guards'
import { getLogger } from '@zhushanwen/pi-extension-logger'

import { PiSchedulerBackend } from './backend.js'
import { registerScheduleCommand } from './commands.js'
import { readUiLocale } from './i18n.js'
import { abortPendingScheduleForms } from './interaction.js'
import { renderScheduleToolResult } from './render-result.js'
import { SchedulerRuntime, type SchedulerModelOps } from './runtime.js'
import { SchedulerService } from './service.js'
import {
  buildScheduleControlSummary,
  buildScheduleSummary,
  controlGuidelines,
  handleSchedule,
  handleScheduleControl,
  ScheduleControlParams,
  type ScheduleControlParamsT,
  scheduleGuidelines,
  ScheduleParams,
  type ScheduleParamsT,
  withScheduleSummary,
} from './tool.js'
import { computeTasksFingerprint, setSchedulerWidget } from './widget.js'
import type { ScheduledTask } from './types.js'

// G1（代际检测，S9/R3-M1）：session 代际计数器。必须声明在模块级而非 factory 体内：
// pi 每次 session 替换（newSession/fork/switchSession）都重跑 extension factory 函数体
// （loader.ts loadExtension 无条件 `await factory(api)`；extensionCache 只缓存 factory
// 函数对象、不缓存执行结果）——闭包级声明每次重跑即重置，各代 runtime 的 isCtxStale 恒
// false（R3 实测证伪的回归）。模块级声明下，extensionCache 命中期间（同 cwd 未 reload）
// factory 是同一函数对象、共享同一模块环境绑定，计数器跨 factory 重跑保留递增：新闭包的
// session_start 递增本计数器，各代 runtime 构造时捕获的代数从此小于模块值 → isCtxStale
// 生效——stale 分诊不依赖 pi 错误文案（Error message 非契约 API，pi 升级改文案即静默失效）。
//
// 残余盲区（reload）：显式 reload / cwd 变化触发 clearExtensionCache → jiti 重新 import
// （moduleCache:false）产生全新模块环境，本计数器随新环境重置；旧闭包引用的是旧模块环境的
// 绑定，永不再递增 → 其 isCtxStale 恒 false。该盲区由两道既有防线覆盖：pi 在替换前 await
// fire session_shutdown（F1 stopScheduler 主防线，teardownCurrent）+ runtime 侧
// STALE_CTX_MARKER 文案兜底（F2 catch 分诊）。
let sessionGeneration = 0

/**
 * 任务恢复失败累计计数（gap4：读侧流级错误不折叠成静默空集）。session_start
 * 装配点对恢复失败显式降级（warn + 空任务集继续装配）时递增，计数随 warn 一起输出
 * ——重复失败（跨 session 替换持续失败）在日志里可见。与 sessionGeneration 同理声明
 * 在模块级：跨 factory 重跑累计，闭包级每次重跑即归零。
 */
let schedulerRecoveryFailures = 0

/** 包内既有 logger（与其它模块同源）。 */
const logger = getLogger('scheduler')

/**
 * pi-scheduler extension factory。
 * 注册 schedule + schedule_control 两个 tool、/schedule command、session 事件。
 *
 * service 生命周期：在 session_start 中创建（依赖 ctx），factory 顶层只声明为 null。
 * tool/command 的 execute/handler 通过 getService() 延迟读取，避免在 factory 顶层
 * 捕获 null——那时 session_start 尚未触发，service! 非空断言会骗过编译器但运行时是 null。
 */
export default function schedulerExtension(pi: ExtensionAPI): void {
  let service: SchedulerService | null = null
  // D1 指纹跳推的推送状态（scheduler widget 推送修正设计 D1-b）。
  // **必须声明在 factory 闭包内（extension 实例态），禁模块级**：模块级跨 session 残留会让
  // 新会话继承旧会话的指纹——session_start 的首帧（含清屏帧）被跳推，widget 面板
  // 空窗；模块级 vs 闭包级的语义差异在本包有实证（见上方 sessionGeneration 注释）。
  // 生命周期：session_start 装配新会话实例时重置（refreshWidgetState 调用点）。
  let lastWidgetFingerprint: string | null = null

  const getService = (): SchedulerService => {
    if (!service) throw new Error('Scheduler not initialized: session not started')
    return service
  }

  pi.on('session_start', (_event, ctx: ExtensionContext) => {
    // G1：先递增模块级代数再装配——自此同模块环境内所有前代 runtime 的 isCtxStale 返回
    // true（stale）。myGeneration 是本 handler 的代数，注入的比对闭包读实时模块级
    // sessionGeneration 与之比较（factory 重跑的新闭包与本闭包共享同一模块绑定）。
    sessionGeneration += 1
    const myGeneration = sessionGeneration
    // F1（治本）：session 替换/重入时先停上一代 runtime 的 tick interval——dispatch 的 await
    // 窗口与 session 替换交错时旧 session_shutdown 可能永远等不到（timer 泄漏源头）。
    // stopScheduler 幂等，shutdown 已停过再停一次无副作用。
    service?.runtime.stopScheduler()
    // 任务库分片路径（任务库与会话事实分离）：getAgentDir() 官方数据目录 + cwd workspace
    // 隔离 + sessionId 分片。--no-session 的判据是 getSessionFile() 为空：pi 在该模式下
    // 仍生成进程内 UUID sessionId（每次启动都不同），但会话不落盘、sessionFile 不设置。
    // 分片键据此归一固定值 'no-session'——任务仍持久化（方案 B：写盘不依赖 pi 会话
    // 首写门控），且跨重启命中同一分片恢复。持久会话按 sessionId 分片（resume 同 id
    // 同文件恢复，fork 新 id → 新分片空任务集）；非路径安全的 sessionId 同样归一，
    // 避免 schedulerStoreFilePath 的 fail-fast 在装配点抛出。
    const sessionId = ctx.sessionManager.getSessionId()
    const shardKey = ctx.sessionManager.getSessionFile() === undefined || !/^[A-Za-z0-9_-]+$/.test(sessionId)
      ? 'no-session'
      : sessionId
    const storePath = schedulerStoreFilePath(getAgentDir(), ctx.cwd, shardKey)
    // 装配点：backend（快照文件读写 + 投递端口）→ runtime（内存态 + 调度）→ service（业务入口）
    const backend = new PiSchedulerBackend(ctx, pi, storePath)

    // G1：注入代际比对（本 runtime 建立时的代数 vs 实时代数），供 tick 前置检查与
    // F2 catch 分诊判定 stale——不依赖 pi 错误文案。
    // U4 模型控制接口（设计 D3）：runtime 只见 'provider/id' ref（与 task.model 同域），pi 的
    // Model 对象解析封在本闭包。setModelByRef 契约 = 不 throw、失败返回 false（ref 非法 /
    // modelRegistry.find 无命中 / pi setModel false / 意外异常统一折叠）。
    const modelOps: SchedulerModelOps = {
      getCurrentModelRef: () => {
        const m = ctx.model
        return m ? `${m.provider}/${m.id}` : undefined
      },
      setModelByRef: async (ref: string) => {
        try {
          const slash = ref.indexOf('/')
          if (slash <= 0 || slash === ref.length - 1) return false
          const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1))
          if (!model) return false
          return await pi.setModel(model)
        } catch {
          return false
        }
      },
      isIdle: () => ctx.isIdle(),
    }
    const runtime = new SchedulerRuntime(backend, () => sessionGeneration !== myGeneration, modelOps)
    // 任务库直读恢复（一次 JSON.parse 重建任务集；missing/corrupt 在 backend 内折叠为
    // 空任务集，流级错误在此显式降级）。scheduler 是辅助功能：不 catch 的话抛错点之后的
    // 装配体（startScheduler / service / schedule tool）整段被跳过，恢复失败升级成整套
    // 扩展不可用。空任务集是显式降级而非「成功恢复出无任务」，排障经本 warn 定位。
    // RPC 模式下 session_start 每代触发两次（见 pi runner 的 rebindSession 双路）——重复
    // 读同一文件无副作用，天然无害。
    try {
      runtime.loadTasks(backend.loadTasks())
    } catch (err) {
      schedulerRecoveryFailures += 1
      logger.warn('scheduler task recovery failed; starting with empty task set (scheduled reminders inactive until session restart)', {
        detail: { err: toErrorMessage(err), recoveryFailures: schedulerRecoveryFailures },
      })
    }
    // W2：tick 后回调刷新 widget（节奏对齐 TICK_INTERVAL_MS）
    runtime.onAfterTick(() => refreshWidget(ctx))
    runtime.startScheduler()

    service = new SchedulerService(runtime, () => backend.now(), (task) => {
      // 创建确认 = UI 反馈（任务库分离裁决：不再制造模型轮——写盘不依赖会话门控，
      // 无需合成 assistant 应答）。命令路径的创建 notify 由 interaction 层就近发出
      // （openScheduleFormAsync 内），tool 路径的回执是 tool result 本身；本汇聚点只补
      // widget 即时刷新（不等 30s tick）——任务徽标/列表立即可见。
      void task
      refreshWidget(ctx)
    })

    // 注册 widget（SDK setWidget 第一重载：直接传 string[]）。初始渲染一次，
    // 后续随每次 tickScheduler 末尾的 onAfterTick 回调刷新（推送频率由指纹跳推判定，
    // 见 refreshWidget）。
    // 新会话实例起点重置推送状态：首帧（含空任务清屏帧）必推，不继承前代指纹。
    lastWidgetFingerprint = null
    refreshWidget(ctx)
  })

  // U4 dispatch 模型切换恢复的唯一事件挂点：agent_settled = run 完全沉降（无 retry/
  // compaction/queued continuation）后的 isIdle 复核兑现（D1 归属简化——不挂 agent_start/
  // turn_start/message_start/turn_end/agent_end，runtime 无 turnIndex 归属状态机；end 后仍
  // 可能有自动续跑 turn，恢复只认 settled，见 runtime.handleRunSettled 注释）。
  pi.on('agent_settled', () => service?.runtime.handleRunSettled())

  pi.on('session_shutdown', async () => {
    // 命令路径挂起表单的收尾：session_shutdown
    //（reason ∈ quit/reload/new/resume/fork）→ abort 挂起的表单交互（不创建、不 toast）。
    // taiji 内「切到另一会话」不触发本事件，表单保留且仍有效（有意行为）。
    abortPendingScheduleForms()
    // 快照模式下任务集已随每次变更原子落盘（无收尾 flush 需求）；仅停止 scheduler tick。
    if (service) {
      service.runtime.stopScheduler()
    }
  })

  // 注册 schedule tool（触发反转：直建，不再弹确认表单——人侧表单入口在 /schedule 命令）。
  // execute 内联闭包：从 SDK 全签名 (toolCallId, params, signal, onUpdate, ctx) 提取
  // 转调 handleSchedule 直建流（预校验 → abort 检查 → service.create）。
  // 错误路径 throw（W4）：pi 对 execute throw 置 isError:true（agent-loop.js:581-588；
  // 1.0.0 起返回值 isError:true 也被尊重，本工具恒走 throw 路径两版语义等价）；
  // getService() 未初始化异常穿透到这里，包装
  // 'Error: Scheduler not initialized' 格式（R3 格式保持）。
  pi.registerTool({
    name: 'schedule',
    label: 'Schedule',
    description:
      'Create a scheduled task that fires a message at intervals or cron schedule. ' +
      'The task is created immediately (no confirmation form). It is a session-scoped reminder, ' +
      'not a system cron job — it only fires while this session stays open. ' +
      'The response includes the task id and next run time(s).',
    parameters: ScheduleParams,
    promptGuidelines: scheduleGuidelines,
    async execute(
      _toolCallId: string,
      params: ScheduleParamsT,
      signal: AbortSignal | undefined,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      try {
        const result = await handleSchedule(getService(), params, signal)
        // 收起态一行摘要：details 追加 summary（现有字段保留），GUI 收起态与 TUI 折叠态共用
        return withScheduleSummary(result, buildScheduleSummary(params, result))
      } catch (err) {
        throw new Error(`Error: ${toErrorMessage(err)}`)
      }
    },

    renderResult(result: unknown, options: { expanded: boolean }, theme: Theme) {
      return renderScheduleToolResult(result, options, theme)
    },
  })

  // 注册 schedule_control tool（错误路径同上：throw 让 pi 置 isError）
  pi.registerTool({
    name: 'schedule_control',
    label: 'Schedule Control',
    description: 'Manage scheduled tasks: list, toggle, delete, or run immediately.',
    parameters: ScheduleControlParams,
    promptGuidelines: controlGuidelines,
    async execute(
      _toolCallId: string,
      params: ScheduleControlParamsT,
      _signal: AbortSignal | undefined,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      try {
        const result = await handleScheduleControl(getService(), params)
        // 收起态一行摘要：同 schedule
        return withScheduleSummary(result, buildScheduleControlSummary(params, result))
      } catch (err) {
        throw new Error(`Error: ${toErrorMessage(err)}`)
      }
    },

    renderResult(result: unknown, options: { expanded: boolean }, theme: Theme) {
      return renderScheduleToolResult(result, options, theme)
    },
  })

  // 注册 /schedule 命令。传 getter 而非 service 实例：factory 执行时
  // service 还是 null。
  registerScheduleCommand(pi, () => service)

  /**
   * 重新计算并推送 scheduler widget（双模：GUI 结构化 meta + TUI 文本行）。
   * 读外层 service 变量而非 getService()：session_start 尚未触发时刷新不应报错，直接跳过。
   * `ctx as GuiContext`：pi 的 `ExtensionContext` 与协议包最小结构（mode/hasUI/ui.setWidget）
   * 静态不完全兼容，先例见 todo/src/index.ts makeRefreshDisplay。
   *
   * 推送频率判定（scheduler widget 推送修正设计 D1-b）：
   * - D1 指纹跳推：任务集稳定指纹（computeTasksFingerprint，字段集含 kind/locale）与上次
   *   实际推送相同 → 跳过推送。时间流逝不是状态变化，任务集不变期间零推送
   *   （rpc/tui 两模式同效——判定在 setWidgetDual 之前）。
   * - fail-open：指纹计算异常即推送（宁可多推不可漏显）。
   */
  function refreshWidget(ctx: ExtensionContext): void {
    if (!service) return
    const result = service.list()
    if (!result.success || !result.data) return
    const tasks: ScheduledTask[] = result.data.tasks
    const locale = readUiLocale()

    let fingerprint: string
    try {
      fingerprint = computeTasksFingerprint(tasks, locale)
    } catch (err) {
      // fail-open（辅助显示侧的降级 ≠ 吞错）：指纹异常说明序列化路径有 bug，跳推判定不可信
      // → 直接推送保显示正确；缓存失效（null）使下一帧也必推。
      logger.warn('widget fingerprint computation failed, pushing anyway', { error: toErrorMessage(err) })
      lastWidgetFingerprint = null
      setSchedulerWidget(ctx as GuiContext, tasks)
      return
    }

    if (fingerprint === lastWidgetFingerprint) return

    setSchedulerWidget(ctx as GuiContext, tasks)
    lastWidgetFingerprint = fingerprint
  }
}
