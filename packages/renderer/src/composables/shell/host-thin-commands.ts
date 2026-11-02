/**
 * host-thin-commands —— 宿主薄命令表与执行体（tray-panel-interact §3.3 D4 / U3 段 2）。
 *
 * 独立叶子模块（对齐 notify-toast.ts / ui-response-feedback.ts 先例）：useExtensionHostBridge
 * 的 commandExecutor 分叉单点消费本模块；壳层 toast + i18n + session api 依赖不进 core
 * （core headless 不持 UI）。
 *
 * 四条 id 前缀 taiji. 的宿主域命令：action-bar commandId 命中后直转 session 域 RPC
 * （session.subagentAction / session.workflowAction——已实装且被 SubagentTab 续聊/中止
 * 消费，设计 AS5），不经 plugin.executeCommand（后者是 provider 型插件 worker 链，pi 扩展
 * 侧命令不在其命令表，设计 AS4 分叉）。全程不开 agent turn：subagentAction 直连不经 LLM；
 * workflowAction 是 runtime 拼 /workflows 命令注入、命令轮无模型调用。
 *
 * 失败契约（AX4 失败半边 / RL6）：RPC reject → 错误 toast（失败原因 + 恢复指引），不写行
 * 状态、不乐观翻转——行状态事实源是扩展进程 RecordStore 全量重推（SC5/SC7），宿主只读；
 * SubagentTab store 的 cancelSubagent 乐观翻边归 drawer 详情页自己回滚，托盘行不复制该形态。
 */
import { HOST_PLUGIN_ID, toErrorMessage, type CommandRegistry } from '@taiji/core'
import { getBoundSessionId } from '@taiji/core/domain/drawer'
import i18n from '@/i18n'
import { useToast } from '@/composables/useToast'
import { session as sessionApi } from '@/api'

/** 非 setup 上下文可用的翻译窄口（subagent-composer-lane 同款：vue-i18n 复杂重载 cast 成单签名）。 */
const tFn = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

/** 宿主命令 id 前缀（与 BUILTIN_NAMESPACE 的 ui. 同思路：id 前缀区分宿主域，防与插件命令表撞名）。 */
const HOST_COMMAND_PREFIX = 'taiji.'

/** 宿主薄命令记录：标题 + RPC 失败回执键 + 执行体。 */
type HostThinCommand = {
  title: string
  /** RPC 失败 toast 的 i18n key（失败原因 + 恢复指引）。 */
  failureKey: string
  /** 执行体；sessionId 由调用方传入（drawer 域绑定的焦点会话）。 */
  run: (sessionId: string, args: Record<string, unknown>) => Promise<void>
}

/** 协议 args 归一（action-bar args 只许标量）：非对象 → 空对象（参数缺失由 hostStringArg fail-fast 出声）。 */
function toScalarArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) return {}
  return args as Record<string, unknown>
}

/** 薄命令标量参数读取：缺失 / 空串 / 非字符串 → throw（按钮声明缺失不静默降级成空 RPC）。 */
function hostStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(tFn('shell.hostCommand.missingArg', { param: key }))
  }
  return value
}

/**
 * 宿主薄命令表（D4）：id → 记录。参数映射（按钮 args → transport 词表）：
 * - subagentCancel：args.recordId → subagentAction('cancel', { subagentId })——record.id
 *   即 subagentId，值同一仅键名映射（设计 D4 实读依据）；
 * - subagentRetry：args.slug + args.task → subagentAction('start', ...)（同任务重派发新记录）；
 * - workflowAbort / workflowResume：args.runId → workflowAction('abort' | 'resume', runId)。
 */
const HOST_THIN_COMMANDS = new Map<string, HostThinCommand>([
  [
    'taiji.subagentCancel',
    {
      title: '取消子代理',
      failureKey: 'shell.hostCommand.cancelFailed',
      run: (sessionId, args) =>
        sessionApi.subagentAction(sessionId, 'cancel', { subagentId: hostStringArg(args, 'recordId') }),
    },
  ],
  [
    'taiji.subagentRetry',
    {
      title: '重试子代理',
      failureKey: 'shell.hostCommand.retryFailed',
      run: (sessionId, args) =>
        sessionApi.subagentAction(sessionId, 'start', {
          slug: hostStringArg(args, 'slug'),
          task: hostStringArg(args, 'task'),
        }),
    },
  ],
  [
    'taiji.workflowAbort',
    {
      title: '中止工作流',
      failureKey: 'shell.hostCommand.abortFailed',
      run: (sessionId, args) => sessionApi.workflowAction(sessionId, 'abort', hostStringArg(args, 'runId')),
    },
  ],
  [
    'taiji.workflowResume',
    {
      title: '续跑工作流',
      failureKey: 'shell.hostCommand.resumeFailed',
      run: (sessionId, args) => sessionApi.workflowAction(sessionId, 'resume', hostStringArg(args, 'runId')),
    },
  ],
])

/**
 * commandExecutor 分叉入口（壳层 commandExecutor.execute 单点调用）：id 命中薄命令表
 * （taiji. 前缀 + 表内）→ 执行并返回 true；未命中 → 返回 false，调用方回落既有 provider 链
 * （scheduler-manager 三按钮实证零变化）。taiji. 前缀的 id 永不泄漏进 provider 链。
 *
 * sessionId 取 drawer 域绑定的焦点会话（托盘面板分区恒等于焦点会话）；RPC reject → 错误
 * toast（失败原因 + 恢复指引，RL6），不写行状态、不乐观翻转。
 */
export async function executeHostThinCommand(id: string, args: unknown): Promise<boolean> {
  if (!id.startsWith(HOST_COMMAND_PREFIX)) return false
  const cmd = HOST_THIN_COMMANDS.get(id)
  if (cmd === undefined) return false
  const sessionId = getBoundSessionId()
  if (sessionId === null) {
    // 结构态失败（托盘面板未挂载到会话）：文案自带恢复指引，不套命令专属失败键
    useToast().error(tFn('shell.hostCommand.noTargetSession'))
    return true
  }
  try {
    await cmd.run(sessionId, toScalarArgs(args))
  } catch (e) {
    useToast().error(tFn(cmd.failureKey, { error: toErrorMessage(e) }), { sessionId })
  }
  return true
}

/**
 * 宿主薄命令登记（init 装配点、CommandRegistry 创建后调用）：四条 taiji.* 命令进表——
 * action-bar commandId 的解析前提（RL2：未注册时 CommandRegistry.execute 发 ERR6 error
 * 事件出声，不静默失效）与 commandExecutor 分叉查表的命中源。幂等（registerCommand 同 id
 * 覆盖），重复 init 无害。
 *
 * 可见性结论（设计待验证检查点）：type 缺省 'command'，CommandPopover 合并源
 * resolveSlashCommands 只收 slashCommand 型 → 薄命令不进 slash 命令面板可见集；
 * CommandRecord.title 当前零渲染消费方，取宿主自持中文标题（对齐 scheduler-manager
 * 插件命令注册的 title 字面量先例）。
 */
export function registerHostThinCommands(commandRegistry: CommandRegistry): void {
  for (const [id, thin] of HOST_THIN_COMMANDS) {
    commandRegistry.registerCommand({ id, title: thin.title, pluginId: HOST_PLUGIN_ID })
  }
}
