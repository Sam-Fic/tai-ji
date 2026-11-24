/**
 * 路由条件求值纯函数（provider-aggregation D5/D6/D7/D12/D13）。
 *
 * 行为契约 = docs/design/provider-aggregation-route-matrix.md（穷举矩阵两表：端点可选性
 * 矩阵 + 全体候选状态 → 路由结果矩阵；表行数以契约文件为准，本注释不计数——加行不再漂移）；
 * 逐格断言在 src/__tests__/route-matrix.test.ts（RL2）。本模块零 IO、零时钟
 * 读取、零目录访问——时间（now）/ 额度快照（quotaByProviderId）/ 终局观察（messages）/
 * 链内失败计数（failures）/ pi 重试预算（maxRetries）全部由调用方注入（AX3 求值输入
 * 最小化：同输入必同输出），pi 侧组装在 src/index.ts。
 *
 * 语义总则（route-matrix.md 总则 1-6 + 总则 2 的求值模式维度段，落点标注）：
 * 1. 端点按配置顺序求值，命中第一个「条件全满足」的端点；无候选 → 路由失败（index.ts
 *    闭包层 throw，错误逐端点列明落选原因——AX5）。
 * 2. 时间窗：墙钟本地时区落格判断（boolean[7][48]，行 = 周一..周日 ISO 序、列 = 半小时
 *    格——坐标系契约见 @taiji/shared AggregationTimeWindowTable）；特殊日期优先于周表
 *    （D13 双型：exclude 全天窗外 / include 仅指定区间判窗内、其余回落周表；同一日期
 *    多条覆盖取第一条匹配）。
 * 3. 额度：缓存已用百分比的剩余换算（100 − pct）≥ 阈值判满足；数据缺失/过期（快照
 *    undefined）时按满足处理（fail-open，D5 矩阵行 6/12——未知不判死，真耗尽由 D6
 *    重试感知纠正）。
 * 4. 两条件并存（combo）需同时满足（矩阵行 7-12）。
 * 5. 重试透传与终局 failover（D6 修订，方案 B）：reason=retry 的求值在闭包层
 *    （index.ts）原样返回上一失败端点——重试归属在途请求的延续，不复查条件（直连模型
 *    同型），pi 的重试预算真正打到上游；终局失败由 decideRoute 的终局观察感知：预算
 *    用尽（failures ≥ maxRetries）→ 该端点 burnt（软避让 = 选择层偏好，不是端点条件），
 *    fail-fast（账户/凭据类，pi 不重试）→ 不 burnt（主端点错误持续可见，不漂移）。
 * 6. 端点供给侧状态（凭据、provider 启停）不在求值输入（AX3/矩阵总则 6）——本模块
 *    不预判任何供给侧事实。
 * 7. mode（D12）：simple 跳过全部条件判断依次兜底（route-matrix.md 总则 2 的求值模式维度段「下表仅适用于 advanced」）。
 *    burnt 软避让不是端点条件而是选择层偏好——D6 修订「每个请求（user/continuation/retry
 *    同型）都按路由规则完整重算」对 simple 同样成立：simple 模式下 burnt 端点同样被软
 *    避让（条件不判，避让照判）。
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AggregationMember, AggregationRoute } from "@zhushanwen/extension-protocol/aggregation";
import { AGGREGATION_PROVIDER_ID, TIME_WINDOW_DAYS, TIME_WINDOW_SLOTS_PER_DAY } from "@zhushanwen/extension-protocol/aggregation";
import { PI_THINKING_LEVELS } from "@taiji/shared/pi-preset";

/** 端点额度快照（route 求值的额度输入形态）。由 index.ts 经 QuotaCacheReader 组装
 * （quota-cache.json 新鲜条目投影）；map 缺 provider 键 / undefined = 未知。 */
export interface RouteQuotaSnapshot { // oe-exempt:20261106:framework:评测输入契约，单实现为设计终态
	/** 缓存首窗口已用百分比（0-100；磁盘形态直投，判定侧做剩余换算——口径权威 =
	 * shared quota-types.ts QuotaWindow.pct「已用百分比」，declarative-engine 各 via
	 * 全部转成已用落缓存，2026-11-07 真机核实 bigmodel percentage = 已用）。 */
	percent: number
}

/** 百分比满刻度（缓存 pct 口径 0-100；剩余 = 满刻度 − 已用）。 */
const QUOTA_PCT_FULL_SCALE = 100

/** 落选原因词表（AX5 逐端点列明；文案映射见 MEMBER_BLOCK_REASON_LABELS）。 */
export type MemberBlockReason = "time-window-out" | "quota-below-threshold"

export const MEMBER_BLOCK_REASONS: readonly MemberBlockReason[] = [
	"time-window-out",
	"quota-below-threshold",
]

/** 落选原因的面向用户文案（矩阵行 3/5/10 的「落选原因」列；组合时以「 + 」并列）。 */
export const MEMBER_BLOCK_REASON_LABELS: Record<MemberBlockReason, string> = {
	"time-window-out": "时间窗外",
	"quota-below-threshold": "额度低于阈值",
}

/** 单个端点的一次求值评估。 */
export type MemberEvaluation = {
	/** 端点在路由 members 数组中的下标。 */
	memberIndex: number
	/** 端点复合串 `<providerId>/<modelId>`（与配置悬空标记 memberRef 同形）。 */
	memberRef: string
} & (
	| { available: true; reasons: [] }
	| { available: false; reasons: MemberBlockReason[] }
)

/** 路由求值输入（AX3 输入清单：配置 + 墙钟 + 额度快照，无其他持久状态）。 */
export interface EvaluateRouteInput { // oe-exempt:20261106:framework:评测输入契约，单实现为设计终态
	route: AggregationRoute
	/** 求值墙钟（本地时区语义——构造方决定时区，本模块只用本地取值）。 */
	now: Date
	/** providerId → 额度快照；undefined 或缺 provider 键 = 数据未知（fail-open）。 */
	quotaByProviderId?: ReadonlyMap<string, RouteQuotaSnapshot>
}

/** 路由求值结果：候选序（条件全满足的端点下标，按配置顺序）或全落选明细。 */
export type RouteEvaluation =
	| { outcome: "candidates", memberIndexes: readonly number[] }
	| { outcome: "no-candidate", members: readonly MemberEvaluation[] }

/** pi 七档全集与档位序（单源 = @taiji/shared/pi-preset PI_THINKING_LEVELS——序锚
 * pi-ai dist/models.js:680，off < minimal < low < medium < high < xhigh < max；
 * D7 向上取档的序基准）。pi 增删档位只改 shared 单点：删档方向由消费侧残余
 * 手抄副本对本类型的编译期断言红灯（增档不触发——并集扩宽不产生不相容），
 * 增档方向由 scripts/check-thinking-levels.mjs T4 对账兜住（pre-commit 按
 * pnpm-lock.yaml / pi-preset.ts 等触发文件挂载）。 */
export const THINKING_LEVEL_ORDER: readonly ModelThinkingLevel[] = PI_THINKING_LEVELS;

/** 每小时分钟数（墙钟落格与 `HH:mm` 解析共用的换算锚）。 */
const MINUTES_PER_HOUR = 60
/** 一天小时数（格宽推导的钟表锚）。 */
const HOURS_PER_DAY = 24
/** 时间窗格分钟跨度（单源推导 = 24*60 分钟 / TIME_WINDOW_SLOTS_PER_DAY 格，单源 =
 * @zhushanwen/extension-protocol/aggregation TIME_WINDOW 常量——坐标契约：格 c 覆盖 [c*30,(c+1)*30) 分钟）。 */
const TIME_WINDOW_SLOT_MINUTES = (HOURS_PER_DAY * MINUTES_PER_HOUR) / TIME_WINDOW_SLOTS_PER_DAY
/** ISO 星期换算：JS getDay 以周日=0，表行 0 = 周一——偏移 6 后对一周天数取模。 */
const ISO_WEEKDAY_OFFSET = 6
/** 一周天数（= 时间窗表行数，单源 = @zhushanwen/extension-protocol/aggregation TIME_WINDOW_DAYS——落格模数与表行数同源）。 */
const DAYS_PER_WEEK = TIME_WINDOW_DAYS
/** 本地日期 `YYYY-MM-DD` 的位宽（年份 4 位，月/日各 2 位补零）。 */
const LOCAL_DATE_YEAR_DIGITS = 4
const LOCAL_DATE_PART_DIGITS = 2

function isKnownThinkingLevel(value: string): value is ModelThinkingLevel {
	return (THINKING_LEVEL_ORDER as readonly string[]).includes(value)
}

/** `HH:mm` → 当日分钟数（specials include 区间判断用；形态由读取侧 TIME_PATTERN 校验）。 */
function parseHHmmToMinutes(value: string): number {
	const [h, m] = value.split(":")
	return Number(h) * MINUTES_PER_HOUR + Number(m)
}

/** 本地日期 `YYYY-MM-DD`（不用 toISOString——那是 UTC 视角，会漂移本地日期归属）。 */
function formatLocalDate(now: Date): string {
	const y = String(now.getFullYear()).padStart(LOCAL_DATE_YEAR_DIGITS, "0")
	const m = String(now.getMonth() + 1).padStart(LOCAL_DATE_PART_DIGITS, "0")
	const d = String(now.getDate()).padStart(LOCAL_DATE_PART_DIGITS, "0")
	return `${y}-${m}-${d}`
}

/**
 * 时间窗判断（矩阵行 2/3；D13 specials 覆盖周表）。
 *
 * - specials：第一条 date 匹配本地的覆盖生效——exclude 全天判窗外；include 仅
 *   [from, to) 判窗内（from < to 由读取侧校验强制，同日内区间）。
 * - 无匹配 → 周表 boolean[7][48] 落格：行 = (getDay()+6)%7（0=周一..6=周日，ISO 序）、
 *   列 = floor(当日分钟/30)（格 c 覆盖 [c*30,(c+1)*30) 分钟）。
 * - window 条件但表缺失（type=window 而无 window 字段——校验层不按 type 拒绝字段留驻）
 *   = 无约束判满足（fail-open 同族：缺失数据不判死）。
 */
export function isWithinTimeWindow(route: AggregationRoute, member: AggregationMember, now: Date): boolean {
	const dateKey = formatLocalDate(now)
	const special = route.specials.find(s => s.date === dateKey)
	if (special !== undefined) {
		if (special.mode === "exclude") return false
		const { from, to } = special
		if (from !== undefined && to !== undefined) {
			const minutes = now.getHours() * MINUTES_PER_HOUR + now.getMinutes()
			if (minutes >= parseHHmmToMinutes(from) && minutes < parseHHmmToMinutes(to)) return true
		}
		// include 区间外（或区间缺失的防御分支）不判死——回落周表判定（D13「其余回落周表」，V11 语义）。
	}
	if (member.window === undefined) return true
	const isoWeekday = (now.getDay() + ISO_WEEKDAY_OFFSET) % DAYS_PER_WEEK
	const slot = Math.floor((now.getHours() * MINUTES_PER_HOUR + now.getMinutes()) / TIME_WINDOW_SLOT_MINUTES)
	return member.window[isoWeekday]?.[slot] === true
}

/**
 * 额度条件判断（矩阵行 4/5/6）。快照未知 → 满足（fail-open，D5）；快照已知 → 剩余换算
 * （100 − percent）≥ thresholdPercent 判满足——快照 percent 是缓存已用百分比（口径权威
 * = shared quota-types.ts QuotaWindow.pct；2026-11-07 真机核实 bigmodel TOKENS_LIMIT
 * percentage = 已用：TIME_LIMIT 条目 usage=1000 / currentValue=867 / remaining=133 /
 * percentage=86 ≈ currentValue/usage，剩余方向应为 13，已用口径实锤），阈值语义 = 剩余
 * ≥ 阈值可选用（thresholdPercent 100 = 剩余须满格 → 真实账号恒不满足，V3 恒耗尽技巧）。
 * member 无 quota 声明（type=quota 而 quota 字段留空）= 无阈值可判 → 满足（无从判死，
 * 不猜阈值）。
 */
export function isQuotaConditionSatisfied(
	member: AggregationMember,
	quotaByProviderId: ReadonlyMap<string, RouteQuotaSnapshot> | undefined,
): boolean {
	const quota = member.quota
	if (quota === undefined) return true
	const snapshot = quotaByProviderId?.get(member.providerId)
	if (snapshot === undefined) return true
	return QUOTA_PCT_FULL_SCALE - snapshot.percent >= quota.thresholdPercent
}

/** 单端点单条件维度的落选原因收集（advanced 模式；simple 由本函数短路）。 */
function collectMemberBlockReasons(route: AggregationRoute, member: AggregationMember, input: EvaluateRouteInput): MemberBlockReason[] {
	const reasons: MemberBlockReason[] = []
	// D12：simple 模式跳过全部条件判断依次兜底（route-matrix.md 总则 2 的求值模式维度段）。
	if (route.mode === "simple") return reasons
	switch (member.type) {
		case "none":
			break
		case "window":
			if (!isWithinTimeWindow(route, member, input.now)) reasons.push("time-window-out")
			break
		case "quota":
			if (!isQuotaConditionSatisfied(member, input.quotaByProviderId)) reasons.push("quota-below-threshold")
			break
		case "combo":
			if (!isWithinTimeWindow(route, member, input.now)) reasons.push("time-window-out")
			if (!isQuotaConditionSatisfied(member, input.quotaByProviderId)) reasons.push("quota-below-threshold")
			break
	}
	return reasons
}

/**
 * 路由求值（矩阵「全体候选状态 → 路由结果」的纯函数半边；enabled/deleted 两条闭包态
 * 在 index.ts 闭包层先行短路，不进本函数）。
 *
 * 返回候选序（条件全满足的端点下标，保持配置顺序——decideRoute 在其上叠加 burnt 软
 * 避让偏好，index.ts 闭包层按偏好序解析物理模型，第一个可解析的即本次命中）或全落选
 * 明细（no-candidate，供闭包层组合 AX5 逐端点错误）。
 */
export function evaluateRoute(input: EvaluateRouteInput): RouteEvaluation {
	const { route } = input
	const evaluations: MemberEvaluation[] = route.members.map((member, memberIndex) => {
		const reasons = collectMemberBlockReasons(route, member, input)
		const ref = memberRef(member)
		return reasons.length === 0
			? { memberIndex, memberRef: ref, available: true as const, reasons: [] as [] }
			: { memberIndex, memberRef: ref, available: false as const, reasons }
	})
	const candidates = evaluations.filter(e => e.available).map(e => e.memberIndex)
	if (candidates.length === 0) return { outcome: "no-candidate", members: evaluations }
	return { outcome: "candidates", memberIndexes: candidates }
}

// ── D6 修订（方案 B）：retry 透传的终局观察 + burnt 软避让 + router state 迁移 ──────

/** 成员复合串（`<providerId>/<modelId>`——与 MemberEvaluation.memberRef / 悬空标记同形）。 */
export function memberRef(member: AggregationMember): string {
	return `${member.providerId}/${member.modelId}`
}

/**
 * 终局观察的最小消息视图（pi LLM 形态 assistant 消息的结构化窄面）。
 *
 * pi 的 convertToLlm 对 assistant 消息原样透传（core/messages.js：case "assistant": return m），
 * provider/model/stopReason/errorMessage 全量在场；user/toolResult 等角色无这些字段，
 * 窄面按可选接收（role 唯一必填——扫描只认 assistant）。
 */
export interface RouteObservationMessage { // oe-exempt:20261124:framework:观察输入结构化窄面，单实现为设计终态
	role: string
	provider?: string
	model?: string
	stopReason?: string
}

/**
 * 路由 router state（pi 持久化在 session branch 的 virtual-model-state 条目；契约见
 * virtual-models.d.ts ModelRouteRequest.state / VirtualModelStateData）。
 *
 * 只持 burnt（终局失败标记）—— burnt 是跨轮次的路由偏好事实（历史里只有最后一跳结局，
 * 更早的 burn 不可从 messages 重导），必须持久化。链内失败计数（failures）生命周期 =
 * 活跃重试链（秒级），活扩展闭包内存（index.ts AggregationState.failures），不进
 * session 历史。
 */
export interface RouteFailoverState { // oe-exempt:20261124:framework:router state 契约，单实现为设计终态
	/**
	 * 已用尽 pi 重试预算仍终局失败的端点 memberRef 集。
	 *
	 * 有序集：插入序 = burn 序——全部候选 burnt 时取序最旧的重探并移到序尾（坏端点
	 * 交替重探，恢复即被成功观察清 mark；无时间机制，ADR-0190 白名单外不建时间决策）。
	 */
	burnt: readonly string[]
}

/** 解析 router state 的 burnt 集（防御：持久化 JSON 形态不可信——坏形状按空集，保序不抛）。 */
export function parseFailoverState(state: unknown): ReadonlySet<string> {
	if (typeof state !== "object" || state === null) return new Set()
	if (!("burnt" in state)) return new Set()
	const burnt: unknown = state.burnt
	if (!Array.isArray(burnt)) return new Set()
	return new Set(burnt.filter((ref): ref is string => typeof ref === "string"))
}

/** decideRoute 输入（AX3 同族：条件输入 + 终局观察 + 状态，无其他隐式来源）。 */
export interface DecideRouteInput { // oe-exempt:20261124:framework:评测输入契约，单实现为设计终态
	route: AggregationRoute
	/** 求值墙钟（本地时区语义）。 */
	now: Date
	/** providerId → 额度快照；undefined 或缺 provider 键 = 数据未知（fail-open）。 */
	quotaByProviderId?: ReadonlyMap<string, RouteQuotaSnapshot>
	/** 路由回调收到的会话消息（终局观察源——最近一条物理模型 assistant 消息的结局）。 */
	messages: readonly RouteObservationMessage[]
	/** 当前 burnt 集（parseFailoverState(request.state)；有序 = burn 序）。 */
	burnt: ReadonlySet<string>
	/** 各端点链内已观察连续失败次数（闭包内存；retry 透传时递增）。 */
	failures: ReadonlyMap<string, number>
	/** pi 的重试预算（pi.getSettings().retry?.maxRetries ?? 3）——终局失败判「用尽」的尺。 */
	maxRetries: number
	/**
	 * 本次求值是否为链边界（user / continuation：新回合起点，上一链已终断）。
	 *
	 * 非边界的两个形态**不做终局观察**（入参 burnt/failures 原样用于软避让）：
	 * - retry 落 normal-selection 的求值（失败端点已不在配置/目录）——链在途；
	 * - direct 求值（链中压缩摘要 / 扩展调用，pi 不传 state）——夹在「retry bump」与
	 *   下一次 stream 之间，其 messages 已被 _omitRecoveryAttempt 剔除失败 attempt，
	 *   看到的是链前陈旧投影：按它观察会抹掉在途链的预算记账（修剪复审 F1：failover
	 *   永不发生）或按陈旧成功结局反向清 burn。观察只在链边界跑（终局失败/成功/取消
	 *   都是回合级事实）。
	 */
	chainBoundary: boolean
}

/**
 * decideRoute 结果：选中候选偏好序（含迁移后状态）或无候选明细（闭包层组合 AX5 错误）。
 *
 * memberIndexes 是偏好序而非单点：未 burnt 候选按配置序在前、burnt 候选降序尾（ burnt
 * 只重排不删候选）；闭包层按序解析物理模型，第一个可解析的即命中——部分候选悬空
 * （provider 已删/模型已移除）时静默落选续试的既有语义（AX5）不变。
 */
export type RouteDecision =
	| { outcome: "selected", memberIndexes: readonly number[], burnt: ReadonlySet<string>, failures: ReadonlyMap<string, number> }
	| { outcome: "no-candidate", members: readonly MemberEvaluation[], burnt: ReadonlySet<string>, failures: ReadonlyMap<string, number> }

/**
 * 终局观察（方案 B 的事实源）：从消息尾向前找最近一条**物理模型** assistant 消息。
 *
 * 跳过路由自身失败的消息（provider = AGGREGATION_PROVIDER_ID 的虚拟模型消息——pi 的
 * handleRunFailure 用 _state.model 构造，路由失败时 selection 仍是虚拟模型），使观察在
 * 「连续多轮路由失败」后仍可凭更早的物理结局**幂等重导**：burn 不因选择层抛错（无候选 /
 * 悬空）而丢，也不需要闭包镜像——观察永远从会话事实重算。
 *
 * 计数生命周期 = 活跃重试链：只有「最近物理结局 = 本成员 F 的终局 error」时 F 的计数是
 * 活的（该链刚在 F 上烧完预算）；其余一切形态（成功 / 取消 / 未知结局 / 非成员 / 无物理
 * 消息）都意味着本路由的链已终断——计数整体退役。缺这条退役路径时，被观察跳过（模型切走
 * 切回、端点移出配置）孤立的旧计数会把后续账户类 fail-fast 误判成「预算用尽」→ 误 burn +
 * 向候选漂移（修剪发现 P1；T9 实机锁定）。burn 时保留 F 的计数作重导证据（已 burnt 的
 * 重导幂等，不会二次误判），其余成员计数退役（单活链，其余必陈旧）。
 *
 * 结局语义（stopReason 值域 = pi-ai StopReason 联合 pending/stop/length/toolUse/error/
 * aborted/deferred——未知值不猜测：按「非失败亦非康复」保守处理，burnt 不动、计数退役）：
 * - error + 成员 F：终局失败。failures[F] ≥ maxRetries（pi 重试预算真用尽）→ burnt F
 *   （计数保留作重导证据）；否则（fail-fast：账户/凭据类，pi 压根没重试）→ 不 burnt、
 *   计数退役——主端点错误持续可见，不向候选漂移（方案 B 与方案 A 的分界）。
 * - stop/toolUse/length：成功出站 → 清 F 的 burnt + 计数退役（端点康复，重新成为首选）。
 * - aborted：用户取消在途链 → 计数退役，burnt 不动（取消不是端点事实）。
 * - 非本路由成员（用户中途换过模型）：无观察——计数退役（链已终断），burnt 保持入参。
 */
function observeTerminalOutcome(
	messages: readonly RouteObservationMessage[],
	members: readonly AggregationMember[],
	burnt: ReadonlySet<string>,
	failures: ReadonlyMap<string, number>,
	maxRetries: number,
	chainBoundary: boolean,
): { burnt: ReadonlySet<string>, failures: ReadonlyMap<string, number> } {
	// 非链边界求值（retry 落 normal-selection / direct）：不观察——投影是被 _omitRecoveryAttempt
	// 剔除失败 attempt 后的在途形态，按它迁移状态会抹掉活链记账或按陈旧结局反向清 burn（修剪复审 F1）
	if (!chainBoundary) return { burnt, failures }
	const last = findLastPhysicalOutcome(messages)
	if (last === undefined) return { burnt, failures: retireCounts(failures) }
	const index = members.findIndex(m => m.providerId === last.provider && m.modelId === last.model)
	if (index < 0) return { burnt, failures: retireCounts(failures) } // 非本路由成员——无观察
	const ref = memberRef(members[index]!)
	if (last.stopReason === "error") {
		// 终局失败：预算用尽 → burnt（计数保留作重导证据，其余退役）；fail-fast → 不 burnt、计数退役
		if ((failures.get(ref) ?? 0) >= maxRetries) {
			if (burnt.has(ref)) return { burnt, failures: retireOthers(failures, ref) } // 已 burnt——幂等（顺序不变，不产生新 state）
			return { burnt: appendRef(burnt, ref), failures: retireOthers(failures, ref) }
		}
		return { burnt, failures: retireCounts(failures) }
	}
	// 非 error：已知成功结局清 burnt（端点康复）；取消与未知值只退役计数、不反向清理偏好
	const recovered = SUCCESSFUL_STOP_REASONS.includes(last.stopReason ?? "")
	return { burnt: recovered ? withoutRef(burnt, ref) : burnt, failures: retireCounts(failures) }
}

/** 已知成功出站结局（清 burnt = 端点康复）——pi-ai StopReason 值域内的非错误非取消值。 */
const SUCCESSFUL_STOP_REASONS: readonly string[] = ["stop", "toolUse", "length"]

/** 计数整体退役（链终断）；空集原引用返回（无变化不制造新对象）。 */
function retireCounts(failures: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
	return failures.size === 0 ? failures : new Map()
}

/** 仅保留 keepRef 的计数（burn 重导证据），其余退役；无需裁剪时原引用返回。 */
function retireOthers(failures: ReadonlyMap<string, number>, keepRef: string): ReadonlyMap<string, number> {
	const kept = failures.get(keepRef)
	if (kept === undefined) return retireCounts(failures)
	if (failures.size === 1) return failures
	return new Map([[keepRef, kept]])
}

/** 从消息尾向前找最近一条物理模型 assistant 消息（跳过 provider = AGGREGATION_PROVIDER_ID 的虚拟模型消息）。 */
function findLastPhysicalOutcome(messages: readonly RouteObservationMessage[]): RouteObservationMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message?.role !== "assistant") continue
		if (message.provider === AGGREGATION_PROVIDER_ID) continue // 路由自身失败（虚拟模型消息）——跳过
		return message
	}
	return undefined
}

/** 集合去成员（保持其余元素序；成员不在集中原引用返回——无变化不制造新对象）。 */
function withoutRef(refs: ReadonlySet<string>, ref: string): ReadonlySet<string> {
	if (!refs.has(ref)) return refs
	const next = new Set(refs)
	next.delete(ref)
	return next
}

/** 集合追加成员（已存在则不动——保持原 burn 序，保证幂等重导不扰乱轮换公平）。 */
function appendRef(refs: ReadonlySet<string>, ref: string): ReadonlySet<string> {
	if (refs.has(ref)) return refs
	const next = new Set(refs)
	next.add(ref)
	return next
}

/**
 * 轮换重探：burn 序（有序集插入序）最旧的**候选**端点优先重探，并移到 burn 序尾。
 *
 * 全部候选 burnt 时命中（两个坏端点交替重探而不是固定锤配置序首个——恢复者不被饿死）；
 * 单端点时退化为原样重探（≡ 直连模型：每轮都真试，错误真实呈现）。
 */
function rotateOldestBurnt(burnt: ReadonlySet<string>, candidateIndexes: readonly number[], refs: readonly string[]): { memberIndex: number, burnt: ReadonlySet<string> } {
	const candidateRefs = new Set(candidateIndexes.map(i => refs[i]))
	let oldestRef: string | undefined
	for (const ref of burnt) {
		if (candidateRefs.has(ref)) {
			oldestRef = ref
			break
		}
	}
	// 不变量：本路径调用方保证全部候选已 burnt，oldestRef 必存在；防御性回落配置序首个
	const memberIndex = oldestRef !== undefined ? candidateIndexes.find(i => refs[i] === oldestRef)! : candidateIndexes[0]!
	if (oldestRef === undefined) return { memberIndex, burnt }
	const rotated = new Set(burnt)
	rotated.delete(oldestRef)
	rotated.add(oldestRef) // 移到序尾——下次轮换让位给下一个坏端点
	// 序列未变（单候选 / oldest 已在序尾）→ 返回原引用：pi 的 state 落盘门禁是引用比较，
	// 内容等值的新对象会被每个请求 append 一条恒等条目（修剪发现 P3；T10 实机锁定）
	if (sameSequence(rotated, burnt)) return { memberIndex, burnt }
	return { memberIndex, burnt: rotated }
}

/** 两个有序集序列逐元素相等（插入序一致）。 */
function sameSequence(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false
	const left = [...a]
	const right = [...b]
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false
	}
	return true
}

/**
 * 路由决策（方案 B）：终局观察（状态迁移，仅链边界）→ 条件求值（硬闸）→ burnt 软避让。
 *
 * 条件矩阵部分（evaluateRoute）原样复用——burnt 不参与条件判定，只在候选集内重排
 * 偏好：未 burnt 候选（配置序）优先；全部候选 burnt → 轮换重探（见 rotateOldestBurnt）。
 */
export function decideRoute(input: DecideRouteInput): RouteDecision {
	const { route, now, quotaByProviderId, messages, burnt: burntIn, failures: failuresIn, maxRetries, chainBoundary } = input
	// ① 终局观察（状态迁移——无观察时原引用返回，闭包层据此跳转 state 落盘）
	const observed = observeTerminalOutcome(messages, route.members, burntIn, failuresIn, maxRetries, chainBoundary)
	// ② 条件求值（硬闸，与 burn 无关——矩阵 12 行逐格语义不变）
	const evaluation = evaluateRoute({ route, now, quotaByProviderId })
	if (evaluation.outcome === "no-candidate") {
		return { outcome: "no-candidate", members: evaluation.members, burnt: observed.burnt, failures: observed.failures }
	}
	// ③ burnt 软避让：未 burnt 候选按配置序优先，burnt 候选降队尾（软避让 = 排序偏好，
	// 永不删候选——首选全部悬空时闭包层仍可按序落到 burnt 端点，保留 AX5 既有韧性）。
	const refs = route.members.map(memberRef)
	const preferred = evaluation.memberIndexes.filter(i => !observed.burnt.has(refs[i]!))
	if (preferred.length > 0) {
		const demoted = evaluation.memberIndexes.filter(i => observed.burnt.has(refs[i]!))
		return { outcome: "selected", memberIndexes: [...preferred, ...demoted], burnt: observed.burnt, failures: observed.failures }
	}
	// ④ 全部候选 burnt → 轮换重探（burn 序最旧候选优先，移到序尾）
	const rotated = rotateOldestBurnt(observed.burnt, evaluation.memberIndexes, refs)
	return {
		outcome: "selected",
		memberIndexes: [rotated.memberIndex, ...evaluation.memberIndexes.filter(i => i !== rotated.memberIndex)],
		burnt: rotated.burnt,
		failures: observed.failures,
	}
}

/** 单端点支持档位集（member.levels 声明：key 存在且 value ≠ null = 支持；按档位序输出）。 */
export function endpointThinkingLevels(member: AggregationMember): ModelThinkingLevel[] {
	return unionThinkingLevels([member])
}

/**
 * 路由档位并集声明（D7：虚拟模型 thinkingLevels = 各端点支持档位的并集，目录呈现用）。
 * 非法档位字面量（手编配置漂移）过滤不注册——pi 侧对未知档位的容忍度是内部实现细节，
 * 不作为注册输入。空并集（全部端点 levels 缺省/空）→ []，调用方省略 thinkingLevels
 * 字段（pi 缺省 ["off"]——档位未声明 = 不声明，不猜测端点能力）。
 */
export function unionThinkingLevels(members: readonly AggregationMember[]): ModelThinkingLevel[] {
	const supported = new Set<string>()
	for (const member of members) {
		if (member.levels === undefined || member.levels === null) continue
		for (const [level, mapped] of Object.entries(member.levels)) {
			if (mapped === null) continue
			if (isKnownThinkingLevel(level)) supported.add(level)
		}
	}
	return THINKING_LEVEL_ORDER.filter(level => supported.has(level))
}

/**
 * 档位向上取映射（D7，用户裁决方向：向上取——实际思考量 ≥ 所选档位）。
 *
 * - 端点支持所选档 → 原样。
 * - 不支持 → 按档位序取「高于所选档的最近支持档」（选 low、端点支持 {off, medium} → medium）。
 * - 所选档高于端点全部支持档 → 端点最高支持档（选 high、端点最高 medium → medium——
 *   「向上」取到顶即端点最高）。
 * - 支持集空（端点档位未声明）→ 所选档原样透传（无声明 = 不干预，端点能力由 pi 出站层
 *   自行处理；猜测映射会引入设计外行为）。
 */
export function resolveThinkingLevel(selected: ModelThinkingLevel, supported: readonly ModelThinkingLevel[]): ModelThinkingLevel {
	if (supported.length === 0) return selected
	const supportedSet = new Set(supported)
	if (supportedSet.has(selected)) return selected
	const selectedIndex = THINKING_LEVEL_ORDER.indexOf(selected)
	for (let i = selectedIndex + 1; i < THINKING_LEVEL_ORDER.length; i++) {
		if (supportedSet.has(THINKING_LEVEL_ORDER[i])) return THINKING_LEVEL_ORDER[i]
	}
	return supported[supported.length - 1]
}
