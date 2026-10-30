/**
 * scheduler-manager —— taiji builtin plugin（任务管理面板；数据范围零 scheduler 专属会话 API）。
 *
 * 点位使用：
 * - headerAction：本会话启用任务数徽标（空任务无数字）+ 入口可见性（hidden）——
 *   任务清单为空推 hidden=true（宿主渲染端整体不渲染该入口，与 disabled 灰置正交；
 *   声明侧静态形状由 core builtinContributions 承担），有任务推 false 恢复显示。
 *   刷新触发 = 写命令成功后的主动拉取 + 周期轮询 + onDidActivateSession 补充拉取
 *   （「任务集合可能变化」的时点统一汇聚在 pushTreeAndBadge → pushHeaderAction
 *   出口，非写入驱动）；读失败态不重算 hidden（保持上次值，「读取中」语义）。
 *   入口点击由宿主渲染端直开 workflow-viz overlay 定时任务 tab（activation 声明驱动
 *   分派，不经插件命令链）；本插件只经 views.update 持续推树，overlay 的 ViewHost
 *   消费（SCHEDULER_MODAL_VIEW_ID 分区）。内容树严格按 §3.1.1 字段操作对账表组装，表外零元素（G6）。
 * - action-bar：每任务三动作（暂停/恢复 toggle、立即执行 run、删除 rm）。
 * - 数据范围（任务库直读，2026-10-30 任务库分离改线）：scheduler 扩展把任务定义与
 *   记账写独立 JSON 快照（`<piAgentDir>/scheduler/<root>/<segments>/<sessionId>.json`，
 *   原子替换写），不再写会话 JSONL custom entry——本插件数据源从「readEntries 游标
 *   增量拉取 + replayFoldEntries 折叠 + 游标失效重拉 + 撤回镜像重建」整条链改为
 *   直读该快照文件：sessions.get(sessionId) 取 cwd → schedulerStoreFilePath 推导
 *   路径 → readSchedulerStore 一次 JSON.parse。读写两侧共用 extension-protocol
 *   store 模块（路径推导与文件形状构造性一致）。快照读取不依赖 pi 进程存活——
 *   dead/恢复中会话的任务列表照常可读。
 * - 刷新触发：任务库写入不产生会话 entry（无失效信号可订阅），改三通道——
 *   ① 写命令成功后主动 scheduleRefresh（本插件写路径自己发起）；
 *   ② 周期轮询（POLL_INTERVAL_MS，覆盖对话内 schedule tool 创建/删除与到点 dispatch
 *     的记账变化；非活跃会话无 pi 进程、快照不变，轮询读同一文件成本为一次小文件读）；
 *   ③ onDidActivateSession 补充拉取（切换会话即时刷新）。
 *
 * 写路径（设计 §3.3 D6）：三个动作（toggle/run/delete，overlay 树内 action-bar 按钮）
 * 只拼白名单子命令字面量 on|off|rm|run + 快照中存在的 8 位 hex id（快照无该 id →
 * TASK_NOT_FOUND 行内提示、不发命令，E5——防 /schedule 参数路由落空进创建分支，
 * §2.4 坑 3），经 sendMessage({requireCommand: 'schedule'}) 原子校验后发 /schedule 命令；
 * 回执 {accepted, reason?} 驱动行内 notice（E7/E14；运行态分支只看 accepted，reason 仅
 * 文案）。不乐观更新——快照由三通道刷新收敛（不撒谎）。
 *
 * 按钮灰置（E13，插件侧判定）：getCommands(sessionId) 查 'schedule' 命令名（纯查询）
 * → 未注册 = disabled + tooltip（宿主渲染端按 availability 三态合成 i18n tooltip，
 * SDK 无 i18n 能力、插件不推文案）；SESSION_NOT_ACTIVE = 无法判定 → 保持上次值
 * （首次缺省可点，失败由 E14 写路径兜底）；会话激活后重判。
 *
 * 写命令的 sessionId 来源：树内 action-bar 点击链（ViewHost onClick →
 * CommandRegistry.execute(commandId)）不携带会话上下文，插件以 onDidActivateSession
 * 维护焦点会话（渲染端焦点会话 = 最后一次 session.switch 成功会话；首屏 landing→
 * selectSession 亦经 switch）+ activate 时 sessions.list() 取 lastActiveAt 最大者
 * 兜底冷启动竞态（显式 list API，不用 getActive()——其语义是"正在生成的会话"）。
 *
 * 生命周期：镜像挂点 = 会话首次需要徽标/列表时（ensureMirror 唯一入口；didCreate /
 * didActivate / 冷启动 list() 三来源汇聚于此）；会话销毁由 onDidDestroySession 拆订阅
 * 清镜像；轮询 timer 与 Worker 侧资源全部入 Disposable 由 runtime 清理族兜底。
 */
import type { PluginContext } from '../../../packages/runtime/src/services/plugin-service/plugin-types.js'
// 共享模块导入形态：**相对路径直指包源码**，不用裸包名（含 store 子出口）。
// 根因（P4 真机实测）：dev 形态 runtime 以 tsx 运行，Worker 的 import 对产物
// index.js 走 tsx 的 .js→.ts 映射、实际加载 .ts 源码——resources/plugins 不在
// pnpm workspace、目录链上无 node_modules，裸包名 '@zhushanwen/extension-protocol'
// 在源码形态下解析不到（ERR_MODULE_NOT_FOUND，打包版走产物不受影响）。相对路径在
// 两种形态下都成立：esbuild --bundle 把包源码内联进产物（自包含），tsx 直接编译 .ts。
// prepare-builtin-plugins.sh 的 --alias 保留作裸包名兜底，不再被本插件消费。
import {
  SCHEDULER_MODAL_VIEW_ID,
  formatSchedule,
  formatRelativeTime,
} from '../../../packages/extension-protocol/src/index.ts'
import {
  readSchedulerStore,
  schedulerStoreFilePath,
} from '../../../packages/extension-protocol/src/extensions/scheduler/store.ts'
import type {
  ScheduledTask,
  GuiComponent,
  StatItem,
  TreeItem,
} from '../../../packages/extension-protocol/src/index.ts'
// taiji 内嵌 pi agent 目录 SSOT（PI_CODING_AGENT_DIR 对应值 `<dataDir>/agent`）：
// 与 runtime spawn pi 时注入的 env 同源推导——插件 worker 与 runtime 主进程共享 env，
// 推导结果构造性一致；scheduler 扩展（pi 进程内经官方 getAgentDir() 读注入 env）
// 与本插件写读两侧落同一目录。
import { getPiAgentDir } from '../../../packages/shared/src/paths.ts'

/** 插件可用 API 面（Phase2AgentAPI 的本地别名，签名可读性） */
type Api = PluginContext['api']
/** SDK Disposable 结构别名（dispose(): void） */
interface DisposableLike {
  dispose(): void
}

// ── 常量 ─────────────────────────────────────────────────────────

const HEADER_ACTION_ID = 'scheduler-manager.open'
// 面板树视图 id（overlay 定时任务 tab 的 ViewHost 消费分区）：单源 =
// extension-protocol SCHEDULER_MODAL_VIEW_ID（scheduler 契约单点导出），renderer
// ViewHost 侧同源 import——双端各持字面量漂移即分区静默 miss，已收敛。
/** per-session 任务上限（scheduler runtime MAX_TASKS 同值；统计行分母，E8） */
const MAX_TASKS = 50
/** pi 侧 /schedule 扩展命令名（requireCommand 与 E13 判定同源） */
const SCHEDULE_COMMAND_NAME = 'schedule'

/** 快照刷新防抖合并窗口（ms）：写后连续触发合并成一次读取 */
const READ_DEBOUNCE_MS = 200
/**
 * 周期轮询间隔（ms）：任务库写入不产生会话 entry（无失效信号），轮询兜覆盖——
 * 对话内 schedule tool 创建/删除、到点 dispatch 记账、扩展侧任何快照落盘。
 * 读成本 = 一次会话元信息查询 + 一个小 JSON 文件读，10s 量级可忽略。
 * 导出供测试 import 复用（fake timers 推进量与生产节奏同源）。
 */
export const POLL_INTERVAL_MS = 10_000

const EMPTY_HINT =
  '本会话还没有定时任务 —— 在对话里说，或手敲 /schedule <排期> <内容> 创建。'

// ── 纯函数（无状态、可独立冒烟：id 校验 / 命令串白名单 / 排序 / 树组装）─────────

/** 写路径允许的四个子命令字面量（/schedule 参数路由落空会进创建分支，§2.4 坑 3） */
export type ScheduleWriteSubcommand = 'on' | 'off' | 'rm' | 'run'

const WRITE_SUBCOMMANDS: readonly ScheduleWriteSubcommand[] = ['on', 'off', 'rm', 'run']

/** 任务 id 形态守卫：8 位 hex（pi 侧 taskId 生成形态，u-probe P2 实测核对） */
export function isValidTaskId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}$/.test(id)
}

/**
 * 构造 /schedule 写命令串。白名单子命令 + 8 位 hex id 双重校验，任一不过返回 null
 * （调用方必须不发命令——脏输入拼进 /schedule 会漏进模型或误建任务）。
 */
export function buildScheduleCommand(sub: ScheduleWriteSubcommand, taskId: string): string | null {
  if (!WRITE_SUBCOMMANDS.includes(sub)) return null
  if (!isValidTaskId(taskId)) return null
  return `/schedule ${sub} ${taskId}`
}

/**
 * 展示排序（设计 §3.1.1）：启用的按 nextRunAt 升序在前，停用的按创建序垫后
 * （与扩展文本视图 ●启用/○停用 语义对齐；service.list() 不排序，插件自己排）。
 */
export function sortTasksForDisplay(tasks: ScheduledTask[]): ScheduledTask[] {
  const enabled = tasks.filter((t) => t.enabled).sort((a, b) => a.nextRunAt - b.nextRunAt)
  const disabled = tasks.filter((t) => !t.enabled).sort((a, b) => a.createdAt - b.createdAt)
  return [...enabled, ...disabled]
}

/**
 * nextRunAt 两态文案（仅 enabled 时显示）：已过期 → 「即将触发」（插件侧文案——
 * formatRelativeTime 对过去时间返回 "4m ago"，拼成"下次 4m ago"是反话）；未来 →
 * 「下次 」+ 共享格式化器（±5s 窗口内返回 "now"，即设计的两态「下次 now / 即将触发」）。
 */
export function formatNextRunLabel(task: ScheduledTask, now: number = Date.now()): string {
  if (task.nextRunAt <= now) return '即将触发'
  return `下次 ${formatRelativeTime(task.nextRunAt, now)}`
}

/** 每任务 list-tree 行：name 标题 + 排期/下次（或已停用）+ 执行次数/上次成败 +（失败时）原因 */
export function buildTaskRows(task: ScheduledTask, now: number = Date.now()): TreeItem[] {
  const rows: TreeItem[] = [{ label: task.name, depth: 0 }]
  rows.push({
    label: task.enabled
      ? `${formatSchedule(task.schedule, task.kind)} · ${formatNextRunLabel(task, now)}`
      : `${formatSchedule(task.schedule, task.kind)} · 已停用`,
    depth: 1,
  })
  const runParts = [`已执行 ${task.runCount} 次`]
  if (task.lastRunAt !== undefined) {
    const mark =
      task.lastStatus === 'failed' ? ' · 失败' : task.lastStatus === 'success' ? ' · 成功' : ''
    runParts.push(`上次 ${formatRelativeTime(task.lastRunAt, now)}${mark}`)
  }
  rows.push({ label: runParts.join(' · '), depth: 1 })
  // lastError 仅失败时追加一行原因（任务级单值"最近一次"，不是逐条历史）
  if (task.lastStatus === 'failed' && task.lastError) {
    rows.push({ label: task.lastError, depth: 1 })
  }
  return rows
}

/** 每任务 action-bar：暂停/恢复 + 立即执行 + 删除（danger）。args 只含标量（AP-3 校验）。 */
export function buildTaskActions(task: ScheduledTask): GuiComponent {
  return {
    type: 'action-bar',
    props: {
      items: [
        {
          id: `t:${task.id}:toggle`,
          label: task.enabled ? '暂停' : '恢复',
          commandId: 'scheduler-manager.toggle',
          args: { id: task.id, enabled: !task.enabled },
        },
        { id: `t:${task.id}:run`, label: '立即执行', commandId: 'scheduler-manager.run', args: { id: task.id } },
        {
          id: `t:${task.id}:del`,
          label: '删除',
          kind: 'danger',
          commandId: 'scheduler-manager.delete',
          args: { id: task.id },
        },
      ],
    },
  }
}

/**
 * 面板内容树（§3.1.1 对账表逐项：stats-line 统计行 + 每任务「list-tree 行 +
 * action-bar 操作」一对 + 至多 1 行 ansi-text（空态提示或操作 notice），零表外元素）。
 */
export function buildModalTree(tasks: ScheduledTask[], opts?: { notice?: string }): GuiComponent[] {
  const enabledCount = tasks.filter((t) => t.enabled).length
  const stats: GuiComponent = {
    type: 'stats-line',
    props: {
      items: [
        { label: '启用', value: String(enabledCount) },
        { label: '停用', value: String(tasks.length - enabledCount) },
        { label: '共', value: `${tasks.length} / 上限 ${MAX_TASKS}` },
      ] satisfies StatItem[],
    },
  }
  if (tasks.length === 0) {
    return [stats, { type: 'ansi-text', props: { lines: [opts?.notice ?? EMPTY_HINT] } }]
  }
  const children: GuiComponent[] = [stats]
  for (const task of sortTasksForDisplay(tasks)) {
    children.push({ type: 'list-tree', props: { items: buildTaskRows(task) } })
    children.push(buildTaskActions(task))
  }
  if (opts?.notice) children.push({ type: 'ansi-text', props: { lines: [opts.notice] } })
  return children
}

// ── 错误判定（对齐 runtime 形态：错误码优先，message 兜底）────────────────────

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** SESSION_NOT_ACTIVE（getCommands 的 live-only 拒绝，错误码 + message 双匹配） */
function isSessionNotActive(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  if (code === 'SESSION_NOT_ACTIVE') return true
  return /SESSION_NOT_ACTIVE/.test(toMessage(e))
}

// ── per-session 镜像（快照任务集 / 防抖 / E13 判定值）────────────────────────

interface ReadFailure {
  reason: string
}

interface SessionMirror {
  sessionId: string
  /** 最近一次快照读取结果（数据唯一入口 = 任务库快照文件直读） */
  tasks: ScheduledTask[]
  debounceTimer: ReturnType<typeof setTimeout> | null
  refreshInFlight: Promise<void> | null
  readFailure: ReadFailure | null
  /** E13 上次判定值：null = 未判定（首次缺省可点）；true/false = 上次 disabled 值（unknown 态保持） */
  commandDisabled: boolean | null
  /** 徽标当前值（空任务 undefined；读失败态保持上次值——全量覆盖语义下插件每次重推完整状态） */
  badge?: string
  /**
   * 入口可见性当前值（true = 任务清单为空，宿主整体不渲染该入口；undefined = 尚未
   * 判定不推，渲染端按缺省 false 显示）。与 badge 同源同刷新节奏：读失败态不重算
   * （undefined 期间或上次值原样重推 = 保持上次值），数据恢复后随下一轮刷新收敛。
   */
  hidden?: boolean
  /**
   * 最近一次操作结果（行内 notice，至多 1 行）。清零点 = 写命令成功路径（setNoticeAndPush
   * null）；overlay 常驻形态下 notice 停留到下一次写操作（成功清零或新提示覆盖）。
   */
  notice: string | null
  disposables: DisposableLike[]
}

const mirrors = new Map<string, SessionMirror>()
/** 渲染端焦点会话（open 链无会话上下文，见头注；didActivate 维护 + list() 兜底） */
let focusSessionId: string | null = null

function teardownMirror(sessionId: string): void {
  const mirror = mirrors.get(sessionId)
  if (!mirror) return
  if (mirror.debounceTimer) clearTimeout(mirror.debounceTimer)
  mirror.debounceTimer = null
  for (const d of mirror.disposables) {
    try {
      d.dispose()
    } catch (e) {
      // 释放失败不阻断其余清理（订阅表由 runtime clearForSession 兜底）；出声留诊断
      console.warn('[scheduler-manager] dispose failed during teardown:', toMessage(e))
    }
  }
  mirrors.delete(sessionId)
}

/**
 * 镜像挂点 = 会话首次需要徽标/列表时（didActivate / 冷启动兜底两入口汇聚于此）。
 * badge 更新与面板树推送依赖同一刷新链（树持续推送，不随入口显隐挂解）。
 */
function ensureMirror(api: Api, sessionId: string, sink: DisposableLike[]): SessionMirror {
  const existing = mirrors.get(sessionId)
  if (existing) return existing
  const mirror: SessionMirror = {
    sessionId,
    tasks: [],
    debounceTimer: null,
    refreshInFlight: null,
    readFailure: null,
    commandDisabled: null,
    notice: null,
    disposables: [],
  }
  mirrors.set(sessionId, mirror)
  scheduleRefresh(api, sessionId)
  void reevaluateCommandAvailability(api, mirror)
  return mirror
}

/** 刷新触发 → 防抖合并 → 一次快照读取（写后主动 / 轮询 / 激活信号三通道共用出口）。 */
function scheduleRefresh(api: Api, sessionId: string): void {
  const mirror = mirrors.get(sessionId)
  if (!mirror) return
  if (mirror.debounceTimer) clearTimeout(mirror.debounceTimer)
  mirror.debounceTimer = setTimeout(() => {
    mirror.debounceTimer = null
    void refresh(api, sessionId)
  }, READ_DEBOUNCE_MS)
}

/** 并发触发共享一次读取（in-flight 复用） */
function refresh(api: Api, sessionId: string): Promise<void> {
  const mirror = mirrors.get(sessionId)
  if (!mirror) return Promise.resolve()
  if (mirror.refreshInFlight) return mirror.refreshInFlight
  mirror.refreshInFlight = doRefresh(api, mirror).finally(() => {
    mirror.refreshInFlight = null
  })
  return mirror.refreshInFlight
}

/**
 * 快照直读：sessions.get 取 cwd（workspace 分片键）→ schedulerStoreFilePath 推导
 * 路径 → readSchedulerStore 一次 JSON.parse。missing / corrupt 按 store 模块语义折叠
 * 为空任务集（corrupt 已由 store 模块 warn 留证）；会话元信息缺失 / fs 错误 →
 * 读失败态提示（不渲染陈旧行、不显示假空态）。快照读取不依赖 pi 进程存活——
 * dead / 恢复中会话照常可读（任务库分离红利）。
 */
async function doRefresh(api: Api, mirror: SessionMirror): Promise<void> {
  try {
    const info = await api.sessions.get(mirror.sessionId)
    let tasks: ScheduledTask[] = []
    if (info?.cwd) {
      const filePath = schedulerStoreFilePath(getPiAgentDir(), info.cwd, mirror.sessionId)
      const read = readSchedulerStore(filePath)
      if (read.kind === 'ok') tasks = read.tasks
    } else {
      // 会话元信息不可得（已删除的 session 目录等）：按读失败态提示，不静默当空集
      throw new Error(`session metadata unavailable (cwd missing for ${mirror.sessionId})`)
    }
    mirror.readFailure = null
    mirror.tasks = tasks
    await pushTreeAndBadge(api, mirror)
  } catch (e) {
    mirror.readFailure = { reason: toMessage(e) }
    await pushTreeAndBadge(api, mirror)
  }
}

/**
 * 推面板树（overlay 定时任务 tab ViewHost 消费）+ headerAction 徽标（每轮数据刷新统一出口）。
 * 读失败态 = 列表区提示（不渲染陈旧行、不显示假空态）；徽标保持上次值。
 */
async function pushTreeAndBadge(api: Api, mirror: SessionMirror): Promise<void> {
  const failure = mirror.readFailure
  let tree: GuiComponent[]
  if (failure) {
    tree = [
      { type: 'ansi-text', props: { lines: [`任务库读取失败：${failure.reason} —— 稍后自动重试；若持续失败请检查数据目录权限`] } },
    ]
  } else {
    const tasks = mirror.tasks
    tree = buildModalTree(tasks, { notice: mirror.notice ?? undefined })
    const enabledCount = tasks.filter((t) => t.enabled).length
    mirror.badge = enabledCount > 0 ? String(enabledCount) : undefined
    // 「无任务不显示」：任务清单为空 → 入口整体不渲染（hidden=true）；有任务恢复显示。
    // 读失败分支不重算（保持上次值，与徽标「读取中」语义一致）。
    mirror.hidden = tasks.length === 0
  }
  try {
    await api.views.update(SCHEDULER_MODAL_VIEW_ID, tree, { sessionId: mirror.sessionId })
  } catch (e) {
    // best-effort：ViewHost 分区可能尚未挂载（overlay tab 未打开），不重抛——下一轮刷新推送重试收敛
    console.warn('[scheduler-manager] views.update failed:', toMessage(e))
  }
  await pushHeaderAction(api, mirror)
}

/** headerAction 推送（字段级当前值全量重推——store set 为全量覆盖，保持语义由插件侧维护） */
async function pushHeaderAction(api: Api, mirror: SessionMirror): Promise<void> {
  try {
    await api.ui.updateHeaderAction(HEADER_ACTION_ID, {
      sessionId: mirror.sessionId,
      ...(mirror.badge !== undefined ? { badge: mirror.badge } : {}),
      ...(mirror.commandDisabled !== null ? { disabled: mirror.commandDisabled } : {}),
      ...(mirror.hidden !== undefined ? { hidden: mirror.hidden } : {}),
    })
  } catch (e) {
    // best-effort：徽标推送失败不重抛——下一轮刷新推送重试收敛
    console.warn('[scheduler-manager] updateHeaderAction failed:', toMessage(e))
  }
}

/**
 * E13 按钮灰置（插件侧判定，残留风险 #6 主修）：getCommands('schedule') 纯查询。
 * 未注册 → disabled；SESSION_NOT_ACTIVE → 无法判定（保持上次值，首次缺省可点）；
 * tooltip 文案由宿主渲染端按 availability 三态合成 i18n（SDK 无 i18n，插件不推）。
 */
async function reevaluateCommandAvailability(api: Api, mirror: SessionMirror): Promise<void> {
  try {
    const commands = await api.sessions.getCommands(mirror.sessionId)
    mirror.commandDisabled = !commands.some((c) => c.name === SCHEDULE_COMMAND_NAME)
  } catch (e) {
    if (!isSessionNotActive(e)) {
      // 其他查询错误：不动判定（保持上次值），但出声留诊断——静默 return 是排查黑洞
      // （按钮灰置异常时无任何宿主侧痕迹可循）
      console.warn(
        `[scheduler-manager] getCommands failed (session=${mirror.sessionId}); keeping last availability:`,
        toMessage(e),
      )
      return
    }
    // SESSION_NOT_ACTIVE：commandDisabled 不变（null = 首次缺省可点；有值 = 保持）
  }
  await pushHeaderAction(api, mirror)
}

// ── 写路径（E5 白名单 + E7/E14 回执文案）────────────────────────

interface WriteArgs {
  id: string
  enabled?: boolean
}

/** action-bar args 收窄（runtime E6 已保证标量；这里只取域值，不信任多余字段） */
function parseWriteArgs(args: unknown): WriteArgs | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  if (!isValidTaskId(record.id)) return null
  return {
    id: record.id,
    ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
  }
}

function subcommandFor(action: 'toggle' | 'run' | 'delete', enabled: boolean): ScheduleWriteSubcommand {
  if (action === 'toggle') return enabled ? 'on' : 'off'
  if (action === 'run') return 'run'
  return 'rm'
}

/** 设置行内 notice（null = 清除陈旧提示）并推一次树（写路径回执统一出口） */
async function setNoticeAndPush(api: Api, sessionId: string, notice: string | null): Promise<void> {
  const mirror = mirrors.get(sessionId)
  if (!mirror) return
  mirror.notice = notice
  await pushTreeAndBadge(api, mirror)
}

async function handleWrite(
  api: Api,
  action: 'toggle' | 'run' | 'delete',
  args: unknown,
): Promise<void> {
  const sessionId = focusSessionId
  if (!sessionId) return
  const mirror = mirrors.get(sessionId)
  const parsed = parseWriteArgs(args)
  const fallbackSub = subcommandFor(action, parsed?.enabled === true)
  if (!parsed) {
    await setNoticeAndPush(api, sessionId, `操作未生效：无效的任务标识（/schedule ${fallbackSub} <8位id>）`)
    return
  }
  // E5：快照无该 id → TASK_NOT_FOUND，不发命令 + 重新拉取
  if (!mirror || !mirror.tasks.some((t) => t.id === parsed.id)) {
    await setNoticeAndPush(api, sessionId, '任务已不存在，列表已刷新')
    scheduleRefresh(api, sessionId)
    return
  }
  const sub = subcommandFor(action, parsed.enabled === true)
  const content = buildScheduleCommand(sub, parsed.id)
  if (!content) {
    // 理论不可达（args 与快照已双校验）——白名单防线兜底，绝不发脏命令
    await setNoticeAndPush(api, sessionId, `操作未生效：无效的任务标识（/schedule ${sub} ${parsed.id}）`)
    return
  }
  try {
    const receipt = await api.sessions.sendMessage({
      sessionId,
      role: 'user',
      content,
      requireCommand: SCHEDULE_COMMAND_NAME,
    })
    if (receipt.accepted) {
      // 写成功：旧失败 notice 必须清掉再推——不清则下一次刷新会把陈旧
      // 「操作未生效」与已变更行一起重推（操作已生效却仍挂失败提示）。主动 push 让
      // 清除立即可见（重复推送幂等）；数据不乐观更新，快照仍由三通道刷新收敛。
      await setNoticeAndPush(api, sessionId, null)
      return
    }
    // 回执失败：reason 是诊断/文案，行为分支只看 accepted（E7 词表纪律）。
    // 除 command-missing 外的失败统一走通用重试文案。
    const line =
      receipt.reason === 'command-missing'
        ? '命令不可用，操作未生效 —— 若持续失败，请到 设置 → 扩展检查 该会话的 scheduler 扩展'
        : '操作未生效，请重试'
    await setNoticeAndPush(api, sessionId, line)
  } catch (e) {
    const msg = toMessage(e)
    await setNoticeAndPush(
      api,
      sessionId,
      `操作未生效：${msg}（可手敲 /schedule ${sub} ${parsed.id} 重试）`,
    )
  }
}

// ── 激活入口 ─────────────────────────────────────────────────────

export async function activate(context: PluginContext): Promise<void> {
  const { api } = context
  const sink = context.subscriptions

  // 焦点会话追踪（写命令链 sessionId 唯一来源）+ 激活补充拉取（切换会话即时刷新）
  sink.push(
    api.sessions.onDidActivateSession((session) => {
      focusSessionId = session.id
      const mirror = ensureMirror(api, session.id, sink)
      // 已存在镜像若停在读失败态，激活信号 = 新证据（会话刚被宿主触达），立即重拉自愈；
      // 新建镜像的首次拉取已由 ensureMirror 武装，此处不重复
      if (mirror.readFailure !== null) scheduleRefresh(api, session.id)
    }),
  )
  // 新建会话补挂点（ADR-0097 拉为主改造配套）：session.create 不触发 didActivate
  //（runtime handleSessionCreate 只 reply + 广播会话列表），无镜像则收不到刷新触发
  // ——新会话首轮 /schedule 创建任务后按钮与面板将不出现（漏显示），直到用户切走
  // 再切回。didCreate 即建镜像，首拉推 hidden=true（新会话零任务）。
  sink.push(
    api.sessions.onDidCreateSession((session) => {
      ensureMirror(api, session.id, sink)
    }),
  )
  sink.push(api.sessions.onDidDestroySession((session) => teardownMirror(session.id)))

  // 周期轮询（任务库写入无会话 entry 失效信号，轮询兜覆盖对话内创建/删除与到点记账）：
  // 只轮询有镜像的会话；无镜像 = 从未需要徽标/列表，不主动建镜像（保持懒挂点语义）。
  const pollTimer = setInterval(() => {
    for (const mirror of mirrors.values()) {
      refresh(api, mirror.sessionId)
    }
  }, POLL_INTERVAL_MS)
  sink.push({
    dispose: () => clearInterval(pollTimer),
  })

  // 命令注册（id 与 builtinContributions 声明逐字一致；'.' 合法、':' 被
  // INVALID_COMMAND_ID 拒——复合键 = pluginId:commandId，声明/注册两端同串对上）。
  // toggle/run/delete 服务 overlay 定时任务 tab 树内 action-bar 写操作按钮；
  // open 命令已随插件 modal 链退役（入口点击改道 overlay 直开，不经命令链）。
  await api.commands.register(
    { id: 'scheduler-manager.toggle', title: '暂停/恢复定时任务' },
    (args) => handleWrite(api, 'toggle', args),
  )
  await api.commands.register(
    { id: 'scheduler-manager.run', title: '立即执行定时任务' },
    (args) => handleWrite(api, 'run', args),
  )
  await api.commands.register(
    { id: 'scheduler-manager.delete', title: '删除定时任务' },
    (args) => handleWrite(api, 'delete', args),
  )

  // 冷启动兜底：插件激活晚于首屏 selectSession 时补焦点会话与徽标
  // （显式 list API——设计 AP-4「主动 pull 用 list()/get(sessionId) 的显式会话」）
  try {
    const sessions = await api.sessions.list()
    if (sessions.length > 0) {
      const latest = sessions.reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a))
      focusSessionId = latest.id
      ensureMirror(api, latest.id, sink)
    }
  } catch (e) {
    // best-effort 兜底失败：焦点会话由 onDidActivateSession 主通路补上，不中断插件激活
    console.warn('[scheduler-manager] cold-start list() failed:', toMessage(e))
  }

  console.log('[scheduler-manager] activated: headerAction + overlay tree consumer ready (task-store polling)')
}
