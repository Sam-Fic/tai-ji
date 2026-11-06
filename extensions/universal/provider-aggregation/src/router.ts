/**
 * 路由条件求值纯函数（provider-aggregation D5/D6/D7/D12/D13）。
 *
 * 行为契约 = 行为契约 docs/design/provider-aggregation-route-matrix.md（穷举矩阵：端点可选性 12 行 + 全体候选状态
 * 5 行）；逐格断言在 src/__tests__/route-matrix.test.ts（RL2）。本模块零 IO、零时钟
 * 读取、零目录访问——时间（now）/ 额度快照（quotaByProviderId）/ 重试信号（retryExclude）
 * 全部由调用方注入（AX3 求值输入最小化：同输入必同输出），pi 侧组装在 src/index.ts。
 *
 * 语义总则（route-matrix.md 总则 1-6 + 总则 2 的求值模式维度段，落点标注）：
 * 1. 端点按配置顺序求值，命中第一个「条件全满足」的端点；无候选 → 路由失败（index.ts
 *    闭包层 throw，错误逐端点列明落选原因——AX5）。
 * 2. 时间窗：墙钟本地时区落格判断（boolean[7][48]，行 = 周一..周日 ISO 序、列 = 半小时
 *    格——坐标系契约见 @taiji/shared AggregationTimeWindowTable）；特殊日期优先于周表
 *    （D13 双型：exclude 全天窗外 / include 仅指定区间判窗内、其余回落周表；同一日期
 *    多条覆盖取第一条匹配）。
 * 3. 额度：缓存百分比 ≥ 阈值判满足；数据缺失/过期（快照 undefined）时按满足处理
 *    （fail-open，D5 矩阵行 6/12——未知不判死，真耗尽由 D6 重试感知纠正）。
 * 4. 两条件并存（combo）需同时满足（矩阵行 7-12）。
 * 5. 重试排除（D6）：reason=retry 的上一失败端点本轮临时不可用，排除后照常按序求值；
 *    仅作用于本次选择，不写持久黑名单（SI4 假阳性收窄）。
 * 6. 端点供给侧状态（凭据、provider 启停）不在求值输入（AX3/矩阵总则 6）——本模块
 *    不预判任何供给侧事实。
 * 7. mode（D12）：simple 跳过全部条件判断依次兜底（route-matrix.md 总则 2 的求值模式维度段「下表仅适用于 advanced」）；
 *    重试排除不是端点条件而是选择层排除——D6「每个请求（user/continuation/retry 同型）
 *    都按路由规则完整重算」对 simple 同样成立，故 simple 模式下上一失败端点仍被排除、
 *    取下一个兜底端点。
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AggregationMember, AggregationRoute } from "@taiji/shared/aggregation";

/** 端点额度快照（route 求值的额度输入形态）。由 index.ts 经 QuotaCacheReader 组装
 * （quota-cache.json 新鲜条目投影）；map 缺 provider 键 / undefined = 未知。 */
export interface RouteQuotaSnapshot { // oe-exempt:20261106:framework:评测输入契约，单实现为设计终态
	/** 套餐剩余百分比（0-100）。 */
	percent: number
}

/** 落选原因词表（AX5 逐端点列明；文案映射见 MEMBER_BLOCK_REASON_LABELS）。 */
export type MemberBlockReason = "time-window-out" | "quota-below-threshold" | "retry-excluded"

export const MEMBER_BLOCK_REASONS: readonly MemberBlockReason[] = [
	"time-window-out",
	"quota-below-threshold",
	"retry-excluded",
]

/** 落选原因的面向用户文案（矩阵行 3/5/10 的「落选原因」列；组合时以「 + 」并列）。 */
export const MEMBER_BLOCK_REASON_LABELS: Record<MemberBlockReason, string> = {
	"time-window-out": "时间窗外",
	"quota-below-threshold": "额度低于阈值",
	"retry-excluded": "上一失败端点本轮排除",
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

/** 路由求值输入（AX3 输入清单：配置 + 墙钟 + 额度快照 + 重试信号，无其他持久状态）。 */
export interface EvaluateRouteInput { // oe-exempt:20261106:framework:评测输入契约，单实现为设计终态
	route: AggregationRoute
	/** 求值墙钟（本地时区语义——构造方决定时区，本模块只用本地取值）。 */
	now: Date
	/** providerId → 额度快照；undefined 或缺 provider 键 = 数据未知（fail-open）。 */
	quotaByProviderId?: ReadonlyMap<string, RouteQuotaSnapshot>
	/** reason=retry 时的上一失败端点（物理模型 provider/id），本轮临时排除（D6）。 */
	retryExclude?: { providerId: string, modelId: string }
}

/** 路由求值结果：候选序（条件全满足的端点下标，按配置顺序）或全落选明细。 */
export type RouteEvaluation =
	| { outcome: "candidates", memberIndexes: readonly number[] }
	| { outcome: "no-candidate", members: readonly MemberEvaluation[] }

/** pi 七档全集与档位序（pi-ai EXTENDED_THINKING_LEVELS，dist/models.js:680——
 * off < minimal < low < medium < high < xhigh < max；D7 向上取档的序锚）。 */
export const THINKING_LEVEL_ORDER: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]

/** 每小时分钟数（墙钟落格与 `HH:mm` 解析共用的换算锚）。 */
const MINUTES_PER_HOUR = 60
/** 时间窗半小时格的分钟跨度（坐标契约：格 c 覆盖 [c*30,(c+1)*30) 分钟）。 */
const TIME_WINDOW_SLOT_MINUTES = 30
/** ISO 星期换算：JS getDay 以周日=0，表行 0 = 周一——偏移 6 后对 7 取模。 */
const ISO_WEEKDAY_OFFSET = 6
const DAYS_PER_WEEK = 7
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
 * 额度条件判断（矩阵行 4/5/6）。快照未知 → 满足（fail-open，D5）；快照已知 →
 * percent ≥ thresholdPercent。member 无 quota 声明（type=quota 而 quota 字段留空）
 * = 无阈值可判 → 满足（无从判死，不猜阈值）。
 */
export function isQuotaConditionSatisfied(
	member: AggregationMember,
	quotaByProviderId: ReadonlyMap<string, RouteQuotaSnapshot> | undefined,
): boolean {
	const quota = member.quota
	if (quota === undefined) return true
	const snapshot = quotaByProviderId?.get(member.providerId)
	if (snapshot === undefined) return true
	return snapshot.percent >= quota.thresholdPercent
}

/** 单端点单条件维度的落选原因收集（advanced 模式；simple 由本函数短路）。 */
function collectMemberBlockReasons(route: AggregationRoute, member: AggregationMember, input: EvaluateRouteInput): MemberBlockReason[] {
	const reasons: MemberBlockReason[] = []
	if (
		input.retryExclude !== undefined
		&& input.retryExclude.providerId === member.providerId
		&& input.retryExclude.modelId === member.modelId
	) {
		reasons.push("retry-excluded")
	}
	// D12：simple 模式跳过全部条件判断依次兜底（route-matrix.md 总则 2 的求值模式维度段）——重试排除不是条件，先行生效。
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
 * 返回候选序（条件全满足、未被重试排除的端点下标，保持配置顺序——index.ts 按序解析
 * 物理模型，第一个可解析的即本次命中）或全落选明细（no-candidate，供闭包层组合
 * AX5 逐端点错误）。
 */
export function evaluateRoute(input: EvaluateRouteInput): RouteEvaluation {
	const { route } = input
	const evaluations: MemberEvaluation[] = route.members.map((member, memberIndex) => {
		const reasons = collectMemberBlockReasons(route, member, input)
		return reasons.length === 0
			? { memberIndex, memberRef: `${member.providerId}/${member.modelId}`, available: true as const, reasons: [] as [] }
			: { memberIndex, memberRef: `${member.providerId}/${member.modelId}`, available: false as const, reasons }
	})
	const candidates = evaluations.filter(e => e.available).map(e => e.memberIndex)
	if (candidates.length === 0) return { outcome: "no-candidate", members: evaluations }
	return { outcome: "candidates", memberIndexes: candidates }
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
