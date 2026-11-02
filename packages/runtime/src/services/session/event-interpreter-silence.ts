/**
 * SilenceMatrix — 第 2 层静默判定矩阵（pi-stall-detection U4 / D3）。
 *
 * [协作对象，T4 拆分范式] 从 event-interpreter.ts 同域新建：帧流事件三分类消费（AS16）+
 * 静默累计（锚点暂停非重置）+ 在途阶段定位 + T/T_hint 单源推导 + 提示广播 + 判死触发。
 * 生命期与 PingProbe 同构：turn-start 启动（占用中）、agent_settled finally / dispose /
 * 第 1 层判定接管 停止（settled/dispose 停止）。
 *
 * [判定权落 runtime（D3 A 级裁决）] T = idleBackgroundSec + 300s 与 T_hint = T − 60s 的
 * 推导单源在本模块（review-main#1 双阈值裁决）；renderer 辅助提示只消费广播帧
 *（session.stall_hint），不复制推导。判死触发经 onJudge 回调上抛（组合根接线
 * message-dispatcher.handleSilenceJudgeDetermination：自动 abort 复用 U2 有界等待 +
 * 悬挂升级判死强杀分型 + steer 注入原因提示），本模块不做任何终止动作。
 *
 * [四层收窄（SI2 假阳性防线）] 判死须同时满足：① 静默超 T（盖过默认自愈窗与转后台窗，
 * 超界配置会话不装配判死分支——RL14）；② 无在途信号（tool_execution_update /
 * bash_execution_update / message_update 等帧流边沿刷新计时——RL11）；③ 无豁免锚点
 *（ask_user pending / compacting——锚点暂停计时非重置，RL5）；④ 非 backoff 宽限窗
 *（summarization_retry_scheduled 载荷 delayMs——RL11）。
 *
 * [转后台防护（C1/C2 格，无锚点形态）] 前台命令静默 idleBackgroundSec 后转后台 = 工具
 * 调用早退（[TAIJI-FG-BG] 标记 → tool_execution_end 帧刷新计时）；pending 后台任务无
 * 帧流信号可锚（pending 态在扩展任务存储，完成通知经 steer 注入开新回合），不设豁免
 * 锚点——防线 = ① T 公式恒盖过转后台窗 + 早退边沿帧刷新计时 + 转后台关闭
 *（idleBackgroundSec=null）不装配判死分支（RL14）。转后台后同回合仍占用且静默超 T
 * 照常判死（占用回合的持续静默即停滞目标形态；pi 整体挂死由第 1 层探测兜底）。
 *
 * [ADR-0122 射程登记] 时间度量是判定载体的依据与前台空闲转后台先例同构（AS5）：
 * 静默 = 输出流的缺失，否定性信号无事件可发；阈值由自愈窗覆盖公式推出（非猜测量级）。
 * 退役条件：pi 若提供回合推进心跳/在途状态推送等确定性信号，本矩阵的时间判定可整体替换。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerMessage } from '@taiji/shared'
import { getPiAgentDir, getSettingsPath, getMcpConfigPath } from '../../infra/pi/pi-paths.js'
import { PI_EVENT } from '../../infra/pi/pi-protocol.js'
import type { StallMatrixEvent } from './types.js'

/**
 * T_hint 提前量（D3 双阈值裁决：T_hint = T − 60s）。初值 60s；提示形态落点定稿后如需
 * 校准，只改本常量（单一调整点——T 与 T_hint 同源联动，review-main#1）。
 */
export const SILENCE_HINT_LEAD_MS = 60_000

/**
 * T 覆盖公式常量分量（AS13 默认模型请求自愈窗 300s——httpIdleTimeoutMs 默认值）。
 * T = idleBackgroundSec + 300s 的「300s」即本常量；自愈窗实际配置值超界处置见
 * resolveStallMatrixArms（AS13/AS15 决策边界）。
 */
export const MODEL_WINDOW_FALLBACK_MS = 300_000

/** base-tool-enhance idleBackgroundSec 默认值（AS5：600s 转后台；与扩展 config.ts DEFAULT 同源）。 */
export const DEFAULT_IDLE_BACKGROUND_SEC = 600

/** MCP 工具调用默认超时（AS12：DEFAULT_TIMEOUT_SECONDS = 60s；条目可经 config.timeout 覆盖）。 */
export const DEFAULT_MCP_TIMEOUT_MS = 60_000

/** 静默检查 tick（D3：runtime 侧秒级定时检查一个/会话，仅占用中启动）。 */
export const SILENCE_TICK_MS = 1_000

/** extension-ui 交互式方法（阻塞 agent 循环等待用户应答的子集——notify 是 fire-and-forget，不阻塞）。 */
const INTERACTIVE_UI_METHODS: ReadonlySet<string> = new Set(['confirm', 'select', 'input', 'editor'])

// ── 阈值单源推导（RL4）─────────────────────────────────────────────────

/** 静默双阈值（T 判死 / T_hint 提示），单源推导出口。 */
export interface SilenceThresholds { // oe-exempt:20261101:framework:静默判定阈值参数形状（T/T_hint 联动推导消费，实施期校准演进）
  judgeMs: number
  hintMs: number
}

/**
 * T/T_hint 单源联动推导（RL4 绿灯断言区）：
 * - T = idleBackgroundSec + 300s（等式）；
 * - T 恒大于每个单段合法静默窗（逐窗不等式，不叠加求和）：T > idleBackgroundSec（差值
 *   300s 恒正）、T > 默认模型窗 300s（idleBackgroundSec 归一化 floor ≥ 1）、T > 默认 MCP
 *   窗 60s；自愈窗实际配置值超界的处置在分支装配层（resolveStallMatrixArms），不在本式；
 * - T_hint = T − 60s（等式）+ T_hint < T + T_hint > idleBackgroundSec（300s > 提前量 60s
 *   恒成立——任意合法 idleBackgroundSec 下不破）。
 *
 * summarization backoff 窗不进本覆盖公式（retry.ts 退避上界是用户可配置项非设计内常量），
 * 由 summarization_retry_scheduled 载荷 delayMs 豁免承担（RL11）。
 */
/** 秒 ↔ 毫秒换算（no-magic-numbers）。 */
const MS_PER_SECOND = 1_000
/** 分钟 ↔ 毫秒换算（no-magic-numbers）。 */
const MS_PER_MINUTE = 60_000

export function deriveSilenceThresholds(idleBackgroundSec: number): SilenceThresholds {
  const judgeMs = (idleBackgroundSec + MODEL_WINDOW_FALLBACK_MS / MS_PER_SECOND) * MS_PER_SECOND
  return { judgeMs, hintMs: judgeMs - SILENCE_HINT_LEAD_MS }
}

// ── 配置快照与分支装配（RL14 / AS13 / AS15）────────────────────────────

/**
 * 静默判定矩阵的配置快照（读侧产出、纯函数消费——测试注入快照即确定性）。
 * 字段语义（未设统一 null，区别于 0 类显式值）：
 * - idleBackgroundSec：base-tool-enhance 配置；null = 用户显式关闭转后台（前台命令静默无界）；
 * - httpIdleTimeoutMs：pi settings 全局+项目合并值；null = 未设（默认 300s 生效）；0 = 禁用（AS15）；
 * - providerTimeoutMs：pi settings retry.provider.timeoutMs；null = 未设（跟随全局）；
 * - mcpMaxTimeoutMs：mcp.json 各条目生效 timeout 最大值；null = 无条目/文件缺失（默认 60s 计入）。
 */
export interface StallMatrixConfigSnapshot { // oe-exempt:20261101:framework:AS11 联动通道的配置快照形状（三配置源合并产物），实施期字段随裁决演进
  idleBackgroundSec: number | null
  httpIdleTimeoutMs: number | null
  providerTimeoutMs: number | null
  mcpMaxTimeoutMs: number | null
}

/** 矩阵分支装配结果（RL14：提示分支恒装配；判死分支按配置分型）。 */
export interface StallMatrixArms { // oe-exempt:20261101:framework:静默判定矩阵武装清单（AS16 逐事件分类的运行时载体），事件清单演进同扩
  /** 提示分支（session.stall_hint 广播）——恒装配（降级形态 = 只装配提示分支）。 */
  hint: true
  /** 判死分支（onJudge 触发）——禁用/超界/转后台关闭配置 = false（AS13/AS15/RL14 降级）。 */
  judge: boolean
  judgeMs: number
  hintMs: number
}

/**
 * 分支装配（AS13/AS15 决策边界的实装落点，U4 实施期裁决 = 主案超界降级，不采纳配置联动
 * 候选——理由登记 runlog/deviations：联动需 T 折叠自愈窗实际生效值，装配语义随 pi 配置
 * 语义漂移；降级判定只需要同一份只读快照，复杂度低一档且两案读侧成本相同）。
 *
 * 判死分支不装配的三类配置形态（RL14 断言对象）：
 * ① httpIdleTimeoutMs = 0（AS15 禁用：模型请求无 pi 自愈窗，SDK timeout ≈ 24.8 天）；
 * ② 自愈窗实际配置值 ≥ T（AS13 超界：provider.timeoutMs 生效值或 MCP 条目最大生效值盖过
 *    覆盖公式——合法自愈中的请求会在 T 处被误判死；等号同样降级，与 RL4 边界点口径一致
 *   「重合即不覆盖」）；
 * ③ idleBackgroundSec = null（U4 裁决登记：用户关闭转后台 = 前台命令静默窗无界，C1/C2 格
 *    的「转后台帧刷新 + T 盖过转后台窗」防线双双失效——与 AS15 同型的禁用形态，AX5 收窄）。
 *
 * 提示分支在三类降级形态下照常装配（温和提示非判定动作，AX5 约束的是判定类动作）；
 * 阈值统一取覆盖公式 T_hint——降级形态下提示可能落在大自愈窗内（呈现噪音，与
 * idleBackgroundSec ≤ 60s 边界同族，U4 裁决：接受呈现噪音，不建第二参数）。
 */
export function resolveStallMatrixArms(snap: StallMatrixConfigSnapshot): StallMatrixArms {
  const thresholds = deriveSilenceThresholds(snap.idleBackgroundSec ?? DEFAULT_IDLE_BACKGROUND_SEC)
  if (snap.idleBackgroundSec === null || snap.httpIdleTimeoutMs === 0) {
    return { hint: true, judge: false, ...thresholds }
  }
  const T = thresholds.judgeMs
  const modelWindowMs = snap.providerTimeoutMs ?? snap.httpIdleTimeoutMs ?? MODEL_WINDOW_FALLBACK_MS
  const mcpMaxMs = snap.mcpMaxTimeoutMs ?? DEFAULT_MCP_TIMEOUT_MS
  if (modelWindowMs >= T || mcpMaxMs >= T) {
    return { hint: true, judge: false, ...thresholds }
  }
  return { hint: true, judge: true, ...thresholds }
}

// ── 生产配置读侧（AS11 联动通道核实结论 = 可达）────────────────────────

/** 读一个 JSON 文件为 Record（缺失/解析失败/非对象 → null——配置读侧全面 best-effort）。 */
function readJsonRecord(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * idleBackgroundSec 归一化（镜像 extensions/universal/base-tool-enhance config.ts 语义，
 * 不 import 扩展包——runtime 不依赖扩展 npm 包）：undefined/缺失 → 默认 600；显式 null →
 * null（用户关闭）；正有限数 → max(1, floor)；其余坏值 → 默认 600。
 */
function normalizeIdleBackgroundSec(raw: unknown): number | null {
  if (raw === null) return null
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.max(1, Math.floor(raw))
  return DEFAULT_IDLE_BACKGROUND_SEC
}

/** 数值键读取：有限数且 ≥ min 才生效，否则 null（未设语义）。 */
function readFiniteNumber(value: unknown, min: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : null
}

/**
 * pi settings 全局 + 项目级最小合并（只折叠本模块消费的两键：httpIdleTimeoutMs 标量替换；
 * retry / retry.provider 两层浅合并——pi settings-manager deepMergeObjects 的同族最小实现，
 * 语义锚 settings-manager.ts:195-251 亲读）。任一文件缺失/损坏按缺失处理。
 */
function readMergedPiSettings(cwd: string | undefined): Record<string, unknown> {
  const globalSettings = readJsonRecord(getSettingsPath()) ?? {}
  const projectSettings = cwd ? readJsonRecord(join(cwd, '.pi', 'settings.json')) ?? {} : {}
  const merged: Record<string, unknown> = { ...globalSettings }
  if (projectSettings['httpIdleTimeoutMs'] !== undefined) {
    merged['httpIdleTimeoutMs'] = projectSettings['httpIdleTimeoutMs']
  }
  const gRetry = typeof globalSettings['retry'] === 'object' && globalSettings['retry'] !== null
    ? globalSettings['retry'] as Record<string, unknown> : {}
  const pRetry = typeof projectSettings['retry'] === 'object' && projectSettings['retry'] !== null
    ? projectSettings['retry'] as Record<string, unknown> : {}
  if (Object.keys(pRetry).length > 0) {
    const gProvider = typeof gRetry['provider'] === 'object' && gRetry['provider'] !== null
      ? gRetry['provider'] as Record<string, unknown> : {}
    const pProvider = typeof pRetry['provider'] === 'object' && pRetry['provider'] !== null
      ? pRetry['provider'] as Record<string, unknown> : {}
    merged['retry'] = { ...gRetry, ...pRetry, provider: { ...gProvider, ...pProvider } }
  }
  return merged
}

/**
 * MCP 各条目生效 timeout 最大值（毫秒）。合并语义锚 pi mcp/config.ts：全局
 * `<agentDir>/mcp.json` + 项目 `<cwd>/.pi/mcp.json`——项目同名条目「含 command/url/type =
 * 整体替换；否则仅覆盖 enabled/exposure/toolExposure（保留全局 timeout）」；enabled=false
 * 条目不参与（server 不连接，其窗无意义）。条目未配 timeout → 默认 60s 计入（AS12）。
 *
 * 编排三段（复杂度拆解：读两侧 → 合并 → 求最大值，逐段独立 helper）。
 */
function readMcpServersAt(path: string | undefined): Record<string, unknown> {
  const doc = path === undefined ? null : readJsonRecord(path)
  const servers = doc?.['mcpServers']
  return typeof servers === 'object' && servers !== null
    ? servers as Record<string, unknown>
    : {}
}

/** 项目同名条目合并（含 command/url/type = 整体替换；否则字段级覆盖）。 */
function mergeMcpServers(
  globalServers: Record<string, unknown>,
  projectServers: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  const effective = new Map<string, Record<string, unknown>>()
  for (const [name, config] of Object.entries(globalServers)) {
    if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
      effective.set(name, config as Record<string, unknown>)
    }
  }
  for (const [name, config] of Object.entries(projectServers)) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) continue
    const entry = config as Record<string, unknown>
    const isReplacement = entry['command'] !== undefined || entry['url'] !== undefined || entry['type'] !== undefined
    if (isReplacement) {
      effective.set(name, entry)
    } else {
      const base = effective.get(name)
      if (base) effective.set(name, { ...base, ...entry })
    }
  }
  return effective
}

function readMcpMaxTimeoutMs(cwd: string | undefined): number | null {
  const globalServers = readMcpServersAt(getMcpConfigPath())
  const projectServers = readMcpServersAt(cwd ? join(cwd, '.pi', 'mcp.json') : undefined)
  const effective = mergeMcpServers(globalServers, projectServers)

  let max: number | null = null
  for (const entry of effective.values()) {
    if (entry['enabled'] === false) continue
    const timeoutSec = readFiniteNumber(entry['timeout'], Number.EPSILON) ?? DEFAULT_MCP_TIMEOUT_MS / MS_PER_SECOND
    const ms = timeoutSec * MS_PER_SECOND
    if (max === null || ms > max) max = ms
  }
  return max
}

/**
 * 生产读侧（AS11 联动通道）：直读 base-tool-enhance 扩展配置 + pi settings + mcp.json。
 * 路径与 pi 进程解析同锚——runtime spawn pi 时显式注入 PI_CODING_AGENT_DIR =
 * getPiAgentDir()（infra/subagent-control/engine-launch-env.ts:85），pi 侧
 * getAgentDir()（尊重同名 env）解析到同一目录；taiji 侧 settings/mcp 路径推导
 * SSOT = infra/pi/pi-paths.ts（getSettingsPath / getMcpConfigPath）。
 *
 * 读取时点 = 会话 adapter 构造（每会话一次，小文件同步读）；配置热改对新会话生效
 *（RL14 配置值切换联动 = 按会话启动读取，不做进程内热重载通道）。
 * renderer 侧无需配置通道：T/T_hint 单源 runtime、提示信号经广播携带（D3 / review-main#1）
 * ——AS11 的降级三候选裁决因通道可达自动免除（检查点原文）。
 */
export function readStallMatrixConfigSnapshot(cwd: string | undefined): StallMatrixConfigSnapshot {
  const agentDir = getPiAgentDir()
  const extConfig = readJsonRecord(join(agentDir, 'config', 'base-tool-enhance-ext-config.json'))
  const settings = readMergedPiSettings(cwd)
  return {
    idleBackgroundSec: normalizeIdleBackgroundSec(extConfig?.['idleBackgroundSec']),
    httpIdleTimeoutMs: readFiniteNumber(settings['httpIdleTimeoutMs'], 0),
    providerTimeoutMs: (() => {
      const retry = typeof settings['retry'] === 'object' && settings['retry'] !== null
        ? settings['retry'] as Record<string, unknown> : {}
      const provider = typeof retry['provider'] === 'object' && retry['provider'] !== null
        ? retry['provider'] as Record<string, unknown> : {}
      // 0/负数是写侧必拒值（合法域 1-600000），读侧按未设处理（跟随全局）——对齐
      // llm-retry-config-helper isPositiveFiniteNumber 语义。
      return readFiniteNumber(provider['timeoutMs'], Number.EPSILON)
    })(),
    mcpMaxTimeoutMs: readMcpMaxTimeoutMs(cwd),
  }
}

// ── AS16 三分类装配（事件 → 矩阵动作）────────────────────────────────

/** 矩阵对单个中间事件的动作分类（AS16 三分类的 kind 级落位）。 */
export type StallEventAction =
  | 'refresh' // 在途信号：刷新静默计时（帧流恢复，RL11）
  | 'refresh-tool' // 在途信号 + 在途阶段定位「工具执行中」（MCP 自愈中 / 本地工具）
  | 'refresh-model-first-byte' // 在途信号 + 定位「模型首字节前自愈中」（turn_start 后无 message_start）
  | 'anchor-compacting' // 豁免锚点置位：compacting（compaction_start，计时暂停）
  | 'anchor-release' // 豁免锚点解除 + 刷新：compaction_end（锚点消失后从既有静默时长继续——先解除再刷新）
  | 'ask-user-anchor' // 豁免锚点置位：ask_user pending（交互式 extension-ui 请求）
  | 'backoff' // 带窗在途：summarization backoff 宽限（delayMs）
  | 'filtered' // 过滤帧：用户元操作/旁路事件，不证明回合推进，不计时（AS16③）
  | 'settle' // run 级联结束：生命期终止（occupied 窗收口）

/**
 * AS16 全清单逐事件落位表（23 + 补录 1 = 24 类 pi 事件；测试逐行断言）。
 *
 * 可达性注记（三分类装配核实检查点）：summarization_retry_attempt_start / finished 维持
 * NULL_EVENTS（compaction 形态由 compacting 锚整体覆盖；branchSummary 形态发生在树操作
 * RPC——非回合占用期矩阵不武装）；queue_update 维持 NULL_EVENTS（AS16③ 过滤帧，翻译层
 * 丢弃即「不计时」的实现形态）；其余事件均经翻译层产出中间事件到达矩阵。
 */
export const STALL_MATRIX_EVENT_ASSEMBLY: ReadonlyArray<{
  event: string
  action: StallEventAction | 'covered-by-anchor' | 'out-of-occupancy'
  note: string
}> = [
  { event: PI_EVENT.agentStart, action: 'refresh', note: '基座①；hook kind 到达' },
  { event: PI_EVENT.turnStart, action: 'refresh-model-first-byte', note: '基座①；llm-request-start kind——「模型首字节前自愈中」定位锚' },
  { event: PI_EVENT.messageStart, action: 'refresh', note: '基座①；turn-start kind（assistant turn 开始）' },
  { event: PI_EVENT.messageUpdate, action: 'refresh', note: '基座①；message kind（text/thinking delta 等流帧）——「流式输出中」' },
  { event: 'message_end', action: 'refresh', note: '基座①；message kind（+trace-trigger 同源刷新）' },
  { event: PI_EVENT.toolExecutionStart, action: 'refresh-tool', note: '基座①；tool-call-start/index kind——「工具执行中」' },
  { event: PI_EVENT.toolExecutionUpdate, action: 'refresh-tool', note: '基座①；message kind（tool_call_update）——MCP 自愈中（AS12 60s 窗 + progress 续命）' },
  { event: PI_EVENT.toolExecutionEnd, action: 'refresh-tool', note: '基座①；tool-call-end kind' },
  { event: PI_EVENT.turnEnd, action: 'refresh', note: '基座①；turn-usage kind' },
  { event: 'agent_end(willRetry)', action: 'refresh', note: '基座①；turn-end kind——willRetry 形态同样刷新（重试间隙是真实推进边界）' },
  { event: 'agent_settled', action: 'settle', note: '基座①；生命期终止（占用收口）——settle 动作' },
  { event: PI_EVENT.queueUpdate, action: 'filtered', note: '③ 过滤帧；翻译层 NULL_EVENTS 丢弃 = 不计时的实现形态（插话/队列元操作）' },
  { event: PI_EVENT.compactionStart, action: 'anchor-compacting', note: '② 豁免锚点置位（C8 格）；compaction-start kind' },
  { event: 'compaction_end(aborted/willRetry)', action: 'anchor-release', note: '② 锚点解除 + 刷新；compaction-end kind' },
  { event: PI_EVENT.autoRetryStart, action: 'refresh', note: '①；message kind（auto_retry_start）——模型自愈窗的重试帧' },
  { event: PI_EVENT.autoRetryEnd, action: 'refresh', note: '①；message kind（auto_retry_end）' },
  { event: 'entry_appended', action: 'filtered', note: '③ 过滤帧（旁路 entry 追加——record-entry-appended kind，不计时）' },
  { event: PI_EVENT.bashExecutionUpdate, action: 'refresh-tool', note: '①（U4 补录翻译）；bash-execution-update kind——连续流式命令的假阳性防线' },
  { event: PI_EVENT.sessionInfoChanged, action: 'filtered', note: '③ 过滤帧（会话改名）；session-renamed kind 不进矩阵' },
  { event: PI_EVENT.thinkingLevelChanged, action: 'filtered', note: '③ 过滤帧（思考档位调整）；thinking-level kind 不进矩阵' },
  { event: PI_EVENT.summarizationRetryScheduled, action: 'backoff', note: '② 带窗在途：载荷 delayMs 宽限（RL11；T 覆盖公式不含 backoff 窗）' },
  { event: PI_EVENT.summarizationRetryAttemptStart, action: 'covered-by-anchor', note: 'compaction 形态由 compacting 锚整体覆盖；branchSummary 形态在树操作 RPC（非占用期矩阵不武装）——NULL_EVENTS 维持' },
  { event: PI_EVENT.summarizationRetryFinished, action: 'covered-by-anchor', note: '同上（NULL_EVENTS 维持）' },
  { event: PI_EVENT.extensionUiRequest, action: 'ask-user-anchor', note: '② 豁免锚点置位：交互式方法（confirm/select/input/editor）= ask_user pending（C7 格）；notify 不阻塞不置锚' },
]

/**
 * kind → 矩阵动作查找表（AS16 全清单的 kind 级落位；表驱动替换原 18-case switch——
 * 逐 case 语义不变，switch 圈复杂度 19 拆解）。表外 kind（message 族 text/thinking
 * delta、tool_call_update、auto_retry_*、complete/error 等对话内容流帧 + turn-start /
 * turn-usage / turn-end / hook / subagent-stream / llm-first-output）= 在途信号
 * （pi 进程在产出 = 回合推进证据），由 ?? 'refresh' 兜底。
 */
const STALL_KIND_TO_ACTION: Partial<Record<StallMatrixEvent['kind'], StallEventAction>> = {
  'llm-request-start': 'refresh-model-first-byte',
  'tool-call-index': 'refresh-tool',
  'tool-call-start': 'refresh-tool',
  'tool-call-end': 'refresh-tool',
  'bash-execution-update': 'refresh-tool',
  'compaction-start': 'anchor-compacting',
  'compaction-end': 'anchor-release',
  'extension-ui': 'ask-user-anchor',
  'summarization-retry-scheduled': 'backoff',
  'agent-settled': 'settle',
  'session-renamed': 'filtered',
  'thinking-level': 'filtered',
  'record-entry-appended': 'filtered',
  noop: 'filtered',
  'session-manager-ui': 'filtered',
  'canvas-ui': 'filtered',
  'trace-trigger': 'filtered',
  'record-reconcile-trigger': 'filtered',
}

/** kind 级分类（observe 内部消费；导出供测试逐 kind 断言）。 */
export function stallMatrixActionForKind(kind: StallMatrixEvent['kind']): StallEventAction {
  return STALL_KIND_TO_ACTION[kind] ?? 'refresh'
}

/**
 * 事件级分类（observe 消费入口——kind 级之上叠加 message 帧子类型防护）：
 * 'extension.dialog'（交互式对话框交付帧，与同批 extension-ui kind 事件配对产出——
 * dialogRequestEvents 双事件序）按过滤处理：它是 ask_user 锚点的交付本体而非回合推进
 * 证据，若按 refresh 处理会在锚点置位的同批次内立即清除锚点（refresh 清 ask_user 锚的
 * 语义 = 「agent 已继续」，交付帧不满足该语义）。
 */
export function stallMatrixActionForEvent(ev: StallMatrixEvent): StallEventAction {
  if (ev.kind === 'message' && ev.message.type === 'extension.dialog') return 'filtered'
  return stallMatrixActionForKind(ev.kind)
}

// ── 在途阶段与判死载荷 ───────────────────────────────────────────────

/** 在途阶段定位（D3：按「静默前最后事件」定位——steer 注入与提示文案的呈现依据）。 */
export type StallPhase = 'tool' | 'model-first-byte' | 'stream'

/** 判死载荷（上抛组合根 → dispatcher.handleSilenceJudgeDetermination）。 */
export interface StallJudgePayload { // oe-exempt:20261101:framework:判死判定载荷契约（steer 注入与取证共享的结构化判定结论），单实现常态
  sessionId: string
  /** 判死时刻的累计静默时长（毫秒）。 */
  silentMs: number
  /** 静默前最后在途阶段。 */
  phase: StallPhase
}

/** 阶段中文定位（判死 steer 注入文案的「在途阶段定位」成分）。 */
export function describeStallPhase(phase: StallPhase): string {
  switch (phase) {
    case 'tool':
      return '工具执行中'
    case 'model-first-byte':
      return '模型响应等待中'
    case 'stream':
      return '流式输出中'
  }
}

/**
 * 判死 steer 注入文案（D3：含静默时长、在途阶段定位与判定依据；AX6 显式呈报——agent
 * 循环带着死因上下文继续）。[runtime] 前缀对齐 U2 STALL_REASON_HINT 形态。
 */
export function composeStallJudgeHintText(payload: StallJudgePayload): string {
  const minutes = Math.round(payload.silentMs / MS_PER_MINUTE)
  return (
    `[runtime] 上一回合已静默约 ${minutes} 分钟（最后活动阶段：${describeStallPhase(payload.phase)}），` +
    '超过判定阈值且无在途信号、无豁免锚点，已被自动终止；会话保持可用。' +
    '请检查上下文中未完成的任务并继续处理。'
  )
}

// ── SilenceMatrix 本体 ───────────────────────────────────────────────

export interface SilenceMatrixDeps { // oe-exempt:20261101:framework:矩阵依赖注入端口（ports 接口先立单实现常态，本仓架构偏好）
  sessionId: string
  /** WS 帧发送（session.stall_hint 广播路径）。 */
  send: (msg: ServerMessage) => void
  /** 配置快照（构造时读定——配置联动按会话启动生效）。 */
  configSnapshot: StallMatrixConfigSnapshot
  /** 判死回调（组合根接线 dispatcher.handleSilenceJudgeDetermination）。 */
  onJudge: (payload: StallJudgePayload) => void
}

/**
 * 静默判定矩阵（第 2 层判定权威）。
 *
 * 计时形态：秒级 tick 内做「增量累计 + 阈值判定」——silentMs 只在「无锚点 && 非 backoff」
 * 的 tick 间隙增长（锚点暂停非重置：锚点消失后从既有静默时长继续，RL5「锚点进出不洗掉
 * 计时」的构造性实现）。帧流边沿（refresh 动作）清零重计。
 */
export class SilenceMatrix {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  /** 累计静默（毫秒；只在非锚点非 backoff 间隙增长，refresh 清零）。 */
  private silentMs = 0
  /** 上次 tick 时刻（增量累计基准）。 */
  private lastTickAt = 0
  /** 静默前最后在途阶段（定位锚）。 */
  private phase: StallPhase = 'stream'
  /** 提示已发标志（去重 + 清除边沿判定）。 */
  private hintSent = false
  /** 豁免锚点：compacting（compaction_start→end 窗口）。 */
  private compacting = false
  /** 豁免锚点：ask_user pending（交互式 UI 请求在场；帧流恢复即解除）。 */
  private askUser = false
  /** backoff 宽限截止时刻（null = 无宽限窗）。 */
  private backoffUntil: number | null = null
  /** 分支装配（构造时按快照求值一次）。 */
  private readonly arms: StallMatrixArms

  constructor(private readonly deps: SilenceMatrixDeps) {
    this.arms = resolveStallMatrixArms(deps.configSnapshot)
  }

  /** 分支装配只读视图（测试/组合根诊断用）。 */
  get resolvedArms(): StallMatrixArms {
    return this.arms
  }

  /**
   * 启动（turn-start 挂点——占用中）。幂等（先 stop 再重置，PingProbe.start 同款）。
   * RL14 装配在构造时固定：judge=false 时本实例只承担提示分支（判死判定恒不触发）。
   */
  start(): void {
    this.stop()
    this.silentMs = 0
    this.lastTickAt = Date.now()
    this.phase = 'stream'
    this.hintSent = false
    this.compacting = false
    this.askUser = false
    this.backoffUntil = null
    this.running = true
    this.timer = setInterval(() => this.tick(), SILENCE_TICK_MS)
  }

  /** 停止（agent_settled finally / dispose / 第 1 层判定接管）。幂等；未清提示顺带清除。 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    const wasRunning = this.running
    this.running = false
    if (wasRunning && this.hintSent) this.clearHint()
  }

  /**
   * 帧流事件消费（interpret 循环单点喂入，含快速路径）。未武装时零开销早退。
   * 副作用面 = 内部计时态 + session.stall_hint 广播；永不抛错路径由调用侧 try 隔离兜底。
   */
  observe(ev: StallMatrixEvent): void {
    if (!this.running) return
    const action = stallMatrixActionForEvent(ev)
    switch (action) {
      case 'refresh':
        this.refresh('stream')
        return
      case 'refresh-tool':
        this.refresh('tool')
        return
      case 'refresh-model-first-byte':
        this.refresh('model-first-byte')
        return
      case 'anchor-compacting':
        // 锚点置位：暂停计时（不清零——锚点消失后从既有静默时长继续）。
        this.compacting = true
        return
      case 'anchor-release':
        // 先解除锚点再刷新（compaction_end = 压缩完成，回合推进证据）。
        this.compacting = false
        this.refresh('stream')
        return
      case 'ask-user-anchor':
        if (ev.kind === 'extension-ui' && INTERACTIVE_UI_METHODS.has(ev.method)) {
          this.askUser = true
        }
        return
      case 'backoff':
        if (ev.kind === 'summarization-retry-scheduled') {
          // delayMs 缺失/畸形（null）→ 不给宽限（fail-safe 收窄，不放大豁免）。
          this.backoffUntil = ev.delayMs !== null ? Date.now() + ev.delayMs : null
        }
        return
      case 'settle':
        this.stop()
        return
      case 'filtered':
        return
    }
  }

  /** 秒级 tick：增量累计（锚点/backoff 间隙冻结）+ 提示边沿 + 判死触发。 */
  private tick(): void {
    const now = Date.now()
    const anchored = this.compacting || this.askUser
    const inBackoff = this.backoffUntil !== null && now < this.backoffUntil
    if (!anchored && !inBackoff) {
      this.silentMs += now - this.lastTickAt
    }
    this.lastTickAt = now
    if (anchored || inBackoff) return
    // 提示边沿（T_hint；提示分支恒装配——RL14 降级形态只装配提示分支）。
    if (!this.hintSent && this.silentMs >= this.arms.hintMs) {
      this.hintSent = true
      this.deps.send({
        type: 'session.stall_hint',
        payload: { sessionId: this.deps.sessionId, active: true, silentMs: this.silentMs, phase: this.phase },
      })
    }
    // 判死触发（T + 分支装配判定；单回合至多一次——先停再上抛）。
    if (this.arms.judge && this.silentMs >= this.arms.judgeMs) {
      const payload: StallJudgePayload = {
        sessionId: this.deps.sessionId,
        silentMs: this.silentMs,
        phase: this.phase,
      }
      this.stop()
      this.deps.onJudge(payload)
    }
  }

  /** 帧流恢复：清提示（边沿）+ 计时重置 + ask_user 锚解除（agent 继续即等待终结）。 */
  private refresh(phase: StallPhase): void {
    this.phase = phase
    if (this.hintSent) this.clearHint()
    this.hintSent = false
    this.silentMs = 0
    this.backoffUntil = null
    this.askUser = false
    this.lastTickAt = Date.now()
  }

  /** 清除边沿广播（active=false——帧流恢复即清除 / 判死后清除，RL5）。 */
  private clearHint(): void {
    this.deps.send({
      type: 'session.stall_hint',
      payload: { sessionId: this.deps.sessionId, active: false, silentMs: 0, phase: this.phase },
    })
  }
}
