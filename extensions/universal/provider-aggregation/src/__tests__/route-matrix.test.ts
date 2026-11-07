/**
 * 路由求值穷举矩阵单测（RL2 / 验收 A1；T3 定名 route-matrix.test）。
 *
 * 行为契约 = 行为契约 docs/design/provider-aggregation-route-matrix.md：端点可选性矩阵 12 行逐格 + 全体候选状态
 * 多端点叠加（纯函数半边；enabled/deleted 两条闭包态在 aggregation-hot-reload.test）
 * + D7 档位向上取映射 + D12 mode 维度 + D13 特殊日期双型 + 时间窗落格边界。
 * 求值函数为纯函数（now / 额度快照 / 重试信号全注入——AX3），本文件零 fs、零子进程。
 */

import { describe, expect, it } from "vitest";

import type { AggregationMember, AggregationRoute, AggregationTimeWindowTable } from "@taiji/shared";

import {
	evaluateRoute,
	endpointThinkingLevels,
	isWithinTimeWindow,
	MEMBER_BLOCK_REASONS,
	MEMBER_BLOCK_REASON_LABELS,
	resolveThinkingLevel,
	unionThinkingLevels,
	type EvaluateRouteInput,
	type RouteQuotaSnapshot,
} from "../router.ts";

// ── fixture ──────────────────────────────────────────────────────────────────

/** 固定求值墙钟：2026-11-02（周一，getDay=1 → ISO 行 0）10:00 本地时间——落格 slot 20。 */
const NOW_MONDAY_10 = new Date(2026, 10, 2, 10, 0, 0)

function windowTable(cells: Array<[day: number, slot: number]>): AggregationTimeWindowTable {
	const table: AggregationTimeWindowTable = Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => false as boolean))
	for (const [day, slot] of cells) table[day][slot] = true
	return table
}

/** 周一 10:00 所在格（行 0 / 列 20）可用的表。 */
const MONDAY_10_WINDOW = windowTable([[0, 20]])

function member(opts: Partial<AggregationMember>): AggregationMember {
	return {
		id: "m1",
		providerId: "zhipu",
		modelId: "glm-5.3-flash",
		type: "none",
		...opts,
	}
}

function route(opts: Partial<AggregationRoute>): AggregationRoute {
	return {
		id: "route-a",
		name: "Route A",
		modelId: "route-a",
		enabled: true,
		mode: "advanced",
		members: [member({})],
		specials: [],
		...opts,
	}
}

function quotaMap(entries: Array<[providerId: string, percent: number]>): ReadonlyMap<string, RouteQuotaSnapshot> {
	return new Map(entries.map(([providerId, percent]) => [providerId, { percent }]))
}

function evaluate(input: EvaluateRouteInput) {
	return evaluateRoute(input)
}

/** 矩阵单格断言：单端点路由的评估结果。 */
function expectSingleMember(input: EvaluateRouteInput, expected: { available: true } | { available: false, reasons: string[] }) {
	const result = evaluate(input)
	if (expected.available) {
		expect(result.outcome).toBe("candidates")
		if (result.outcome === "candidates") expect(result.memberIndexes).toEqual([0])
		return
	}
	expect(result.outcome).toBe("no-candidate")
	if (result.outcome === "no-candidate") {
		const first = result.members[0]
		expect(first.available).toBe(false)
		if (!first.available) {
			expect(first.reasons.map(r => MEMBER_BLOCK_REASON_LABELS[r])).toEqual(expected.reasons)
		}
	}
}

// ── 端点可选性矩阵（route-matrix.md 12 行逐格） ─────────────────────────────

describe("端点可选性矩阵（route-matrix.md 行 1-12）", () => {
	const base = { route: route({}), now: NOW_MONDAY_10 } as const

	it("行 1：无条件端点恒可选（兜底端点形态）", () => {
		expectSingleMember({ ...base, route: route({ members: [member({ type: "none" })] }) }, { available: true })
	})

	it("行 2：仅时间窗，在窗内 → 可选", () => {
		expectSingleMember(
			{ ...base, route: route({ members: [member({ type: "window", window: MONDAY_10_WINDOW })] }) },
			{ available: true },
		)
	})

	it("行 3：仅时间窗，在窗外 → 不可选（时间窗外）", () => {
		expectSingleMember(
			{ ...base, route: route({ members: [member({ type: "window", window: windowTable([]) })] }) },
			{ available: false, reasons: ["时间窗外"] },
		)
	})

	it("行 4：仅额度阈值，剩余 ≥ 阈值（新鲜）→ 可选", () => {
		// quotaMap 值 = 缓存已用百分比（QuotaWindow.pct 口径）；已用 20 → 剩余 80 = 阈值（边界含等号）→ 可选。
		expectSingleMember(
			{
				...base,
				route: route({ members: [member({ type: "quota", quota: { thresholdPercent: 80 } })] }),
				quotaByProviderId: quotaMap([["zhipu", 20]]),
			},
			{ available: true },
		)
	})

	it("行 5：仅额度阈值，剩余 < 阈值（新鲜）→ 不可选（额度低于阈值）", () => {
		expectSingleMember(
			{
				...base,
				route: route({ members: [member({ type: "quota", quota: { thresholdPercent: 80 } })] }),
				quotaByProviderId: quotaMap([["zhipu", 21]]),
			},
			{ available: false, reasons: ["额度低于阈值"] },
		)
	})

	it("行 6：仅额度阈值，数据缺失/过期（未知）→ 可选（fail-open）", () => {
		// 数据未知两种形态：额度映射整体缺省 / 映射内无该 provider 键——都按满足处理。
		expectSingleMember(
			{ ...base, route: route({ members: [member({ type: "quota", quota: { thresholdPercent: 80 } })] }) },
			{ available: true },
		)
		expectSingleMember(
			{
				...base,
				route: route({ members: [member({ type: "quota", quota: { thresholdPercent: 80 } })] }),
				quotaByProviderId: quotaMap([["other-provider", 5]]),
			},
			{ available: true },
		)
	})

	it("行 7：时间窗+额度，窗内 + 剩余 ≥ 阈值（新鲜）→ 可选", () => {
		expectSingleMember(
			{
				...base,
				route: route({ members: [member({ type: "combo", window: MONDAY_10_WINDOW, quota: { thresholdPercent: 80 } })] }),
				quotaByProviderId: quotaMap([["zhipu", 10]]),
			},
			{ available: true },
		)
	})

	it("行 8：时间窗+额度，窗内 + 剩余 < 阈值（新鲜）→ 不可选（额度低于阈值）", () => {
		expectSingleMember(
			{
				...base,
				route: route({ members: [member({ type: "combo", window: MONDAY_10_WINDOW, quota: { thresholdPercent: 80 } })] }),
				quotaByProviderId: quotaMap([["zhipu", 90]]),
			},
			{ available: false, reasons: ["额度低于阈值"] },
		)
	})

	it("行 9：时间窗+额度，窗外 + 剩余 ≥ 阈值（新鲜）→ 不可选（时间窗外）", () => {
		expectSingleMember(
			{
				...base,
				route: route({ members: [member({ type: "combo", window: windowTable([]), quota: { thresholdPercent: 80 } })] }),
				quotaByProviderId: quotaMap([["zhipu", 10]]),
			},
			{ available: false, reasons: ["时间窗外"] },
		)
	})

	it("行 10：时间窗+额度，窗外 + 剩余 < 阈值（新鲜）→ 不可选（时间窗外 + 额度低于阈值）", () => {
		expectSingleMember(
			{
				...base,
				route: route({ members: [member({ type: "combo", window: windowTable([]), quota: { thresholdPercent: 80 } })] }),
				quotaByProviderId: quotaMap([["zhipu", 90]]),
			},
			{ available: false, reasons: ["时间窗外", "额度低于阈值"] },
		)
	})

	it("行 11：时间窗+额度，窗外 + 数据未知 → 不可选（时间窗确定性失败优先，额度未知不挽救）", () => {
		expectSingleMember(
			{
				...base,
				route: route({ members: [member({ type: "combo", window: windowTable([]), quota: { thresholdPercent: 80 } })] }),
			},
			{ available: false, reasons: ["时间窗外"] },
		)
	})

	it("行 12：时间窗+额度，窗内 + 数据未知 → 可选（fail-open）", () => {
		expectSingleMember(
			{
				...base,
				route: route({ members: [member({ type: "combo", window: MONDAY_10_WINDOW, quota: { thresholdPercent: 80 } })] }),
			},
			{ available: true },
		)
	})
})

// ── 全体候选状态 → 路由结果（多端点叠加，纯函数半边） ────────────────────────

describe("全体候选状态 → 路由结果（route-matrix.md 多端点叠加）", () => {
	it("存在 ≥1 个可选端点 → 命中顺序最前的可选端点", () => {
		const result = evaluate({
			route: route({
				members: [
					member({ id: "a", providerId: "zhipu", modelId: "glm", type: "window", window: windowTable([]) }),
					member({ id: "b", providerId: "opencode-go", modelId: "zai-glm", type: "none" }),
				],
			}),
			now: NOW_MONDAY_10,
		})
		expect(result).toEqual({ outcome: "candidates", memberIndexes: [1] })
	})

	it("全部端点不可选 → no-candidate 且逐端点列明落选原因", () => {
		const result = evaluate({
			route: route({
				members: [
					member({ id: "a", type: "window", window: windowTable([]) }),
					member({ id: "b", providerId: "opencode-go", modelId: "zai-glm", type: "quota", quota: { thresholdPercent: 50 } }),
				],
			}),
			now: NOW_MONDAY_10,
			// 已用 90 → 剩余 10 < 阈值 50 → 额度落选
			quotaByProviderId: quotaMap([["opencode-go", 90]]),
		})
		expect(result.outcome).toBe("no-candidate")
		if (result.outcome !== "no-candidate") return
		expect(result.members.map(m => MEMBER_BLOCK_REASON_LABELS[m.reasons[0]] ?? "")).toEqual(["时间窗外", "额度低于阈值"])
	})

	it("retry 且上一失败端点 ∈ 可选集 → 从候选中移除该端点后求值", () => {
		const result = evaluate({
			route: route({
				members: [
					member({ id: "a", providerId: "zhipu", modelId: "glm", type: "none" }),
					member({ id: "b", providerId: "opencode-go", modelId: "zai-glm", type: "none" }),
				],
			}),
			now: NOW_MONDAY_10,
			retryExclude: { providerId: "zhipu", modelId: "glm" },
		})
		expect(result).toEqual({ outcome: "candidates", memberIndexes: [1] })
	})

	it("retry 排除后为空 → no-candidate，落选原因 = 上一失败端点本轮排除（闭包层据此报「上一端点失败且无其他可用端点」）", () => {
		const result = evaluate({
			route: route({ members: [member({ id: "a", providerId: "zhipu", modelId: "glm", type: "none" })] }),
			now: NOW_MONDAY_10,
			retryExclude: { providerId: "zhipu", modelId: "glm" },
		})
		expect(result.outcome).toBe("no-candidate")
		if (result.outcome !== "no-candidate") return
		expect(result.members[0]).toMatchObject({ available: false, reasons: ["retry-excluded"] })
	})

	it("retry 排除不写持久黑名单：同一输入去掉 retryExclude 后端点恢复可选（仅本次有效，SI4）", () => {
		const input = {
			route: route({ members: [member({ id: "a", providerId: "zhipu", modelId: "glm", type: "none" })] }),
			now: NOW_MONDAY_10,
		}
		expect(evaluate({ ...input, retryExclude: { providerId: "zhipu", modelId: "glm" } }).outcome).toBe("no-candidate")
		expect(evaluate({ ...input }).outcome).toBe("candidates")
	})
})

// ── D12 求值模式（simple 短路 / advanced 分流） ─────────────────────────────

describe("D12 求值模式", () => {
	const conditionalMembers = (): AggregationMember[] => [
		member({ id: "a", type: "window", window: windowTable([]) }),
		member({ id: "b", providerId: "opencode-go", modelId: "zai-glm", type: "quota", quota: { thresholdPercent: 99 } }),
	]

	it("advanced 模式按条件分流（同配置下条件不满足则落到后面的端点）", () => {
		const result = evaluate({ route: route({ mode: "advanced", members: conditionalMembers() }), now: NOW_MONDAY_10 })
		expect(result).toEqual({ outcome: "candidates", memberIndexes: [1] })
	})

	it("simple 模式跳过全部条件判断（条件数据保留不参与求值）；候选序 = 全部端点按配置序，命中取首个", () => {
		const result = evaluate({ route: route({ mode: "simple", members: conditionalMembers() }), now: NOW_MONDAY_10 })
		expect(result).toEqual({ outcome: "candidates", memberIndexes: [0, 1] })
	})

	it("simple 模式下重试排除仍生效（D6「每个请求同型完整重算」——排除后取下一个兜底端点）", () => {
		const result = evaluate({
			route: route({ mode: "simple", members: conditionalMembers() }),
			now: NOW_MONDAY_10,
			retryExclude: { providerId: "zhipu", modelId: "glm-5.3-flash" },
		})
		expect(result).toEqual({ outcome: "candidates", memberIndexes: [1] })
	})
})

// ── D13 特殊日期双型（specials 优先于周表） ─────────────────────────────────

describe("D13 特殊日期双型", () => {
	const memberWithWindow = member({ type: "window", window: MONDAY_10_WINDOW })

	it("exclude 型：该日全天判窗外（周表该格可用也被覆盖）", () => {
		const r = route({
			members: [memberWithWindow],
			specials: [{ id: "s1", date: "2026-11-02", mode: "exclude" }],
		})
		expect(isWithinTimeWindow(r, memberWithWindow, NOW_MONDAY_10)).toBe(false)
	})

	it("include 型：该日仅 [from, to) 判窗内（周表该格 false 也窗内）", () => {
		const r = route({
			members: [memberWithWindow],
			specials: [{ id: "s1", date: "2026-11-02", mode: "include", from: "09:00", to: "12:00" }],
		})
		expect(isWithinTimeWindow(r, memberWithWindow, NOW_MONDAY_10)).toBe(true)
	})

	it("include 型：区间外回落周表判定（周表该时刻格可用 → 窗内；不可用 → 窗外，V11 语义）", () => {
		// include 区间 09:00-10:00；求值时刻 10:30（区间外，格 21）→ 按周表该格判定。
		const include9to10 = [{ id: "s1", date: "2026-11-02", mode: "include", from: "09:00", to: "10:00" }] as const
		const memberWith1030 = member({ type: "window", window: windowTable([[0, 21]]) })
		const windowOn = route({ members: [memberWith1030], specials: [...include9to10] })
		const emptyWindowMember = member({ type: "window", window: windowTable([]) })
		const windowOff = route({ members: [emptyWindowMember], specials: [...include9to10] })
		expect(isWithinTimeWindow(windowOn, memberWith1030, new Date(2026, 10, 2, 10, 30))).toBe(true)
		expect(isWithinTimeWindow(windowOff, emptyWindowMember, new Date(2026, 10, 2, 10, 30))).toBe(false)
	})

	it("同一日期多条覆盖取第一条匹配（spec 已知限制）", () => {
		const r = route({
			members: [memberWithWindow],
			specials: [
				{ id: "s1", date: "2026-11-02", mode: "exclude" },
				{ id: "s2", date: "2026-11-02", mode: "include", from: "00:00", to: "23:59" },
			],
		})
		expect(isWithinTimeWindow(r, memberWithWindow, NOW_MONDAY_10)).toBe(false)
	})

	it("无匹配特殊日期 → 回落周表；include 型缺区间（读取侧已拦的防御分支）→ 同「其余」语义回落周表", () => {
		const r = route({ members: [memberWithWindow], specials: [{ id: "s1", date: "2026-11-03", mode: "exclude" }] })
		expect(isWithinTimeWindow(r, memberWithWindow, NOW_MONDAY_10)).toBe(true)
		const broken = route({
			members: [memberWithWindow],
			specials: [{ id: "s1", date: "2026-11-02", mode: "include" }],
		})
		expect(isWithinTimeWindow(broken, memberWithWindow, NOW_MONDAY_10)).toBe(true)
	})
})

// ── 时间窗落格与星期归属（AggregationTimeWindowTable 坐标契约） ─────────────

describe("时间窗落格（本地时区，格 c 覆盖 [c*30,(c+1)*30) 分钟）", () => {
	const memberWithWindow = member({ type: "window", window: MONDAY_10_WINDOW })
	const r = route({ members: [memberWithWindow] })

	it("列边界：00:00 → 格 0；00:29 → 格 0；00:30 → 格 1；23:59 → 格 47", () => {
		const table = windowTable([[0, 0], [0, 1], [0, 47]])
		const m = member({ type: "window", window: table })
		const rr = route({ members: [m] })
		expect(isWithinTimeWindow(rr, m, new Date(2026, 10, 2, 0, 0))).toBe(true)
		expect(isWithinTimeWindow(rr, m, new Date(2026, 10, 2, 0, 29))).toBe(true)
		expect(isWithinTimeWindow(rr, m, new Date(2026, 10, 2, 0, 30))).toBe(true)
		expect(isWithinTimeWindow(rr, m, new Date(2026, 10, 2, 23, 59))).toBe(true)
		expect(isWithinTimeWindow(rr, m, new Date(2026, 10, 2, 1, 0))).toBe(false)
	})

	it("行归属：ISO 序（行 0 = 周一 .. 行 6 = 周日），getDay 的周日=0 映射到行 6", () => {
		// 2026-11-08 是周日（getDay=0）——只涂行 6（周日）该格。
		const table = windowTable([[6, 20]])
		const m = member({ type: "window", window: table })
		const rr = route({ members: [m] })
		expect(isWithinTimeWindow(rr, m, new Date(2026, 10, 8, 10, 0))).toBe(true)
		expect(isWithinTimeWindow(rr, m, new Date(2026, 10, 7, 10, 0))).toBe(false) // 周六（行 5）不命中
		expect(isWithinTimeWindow(r, memberWithWindow, new Date(2026, 10, 3, 10, 0))).toBe(false) // 周二（行 1）不命中周一格
	})

	it("window 条件但表缺失 = 无约束判满足（fail-open 同族；校验层不按 type 拒绝字段留驻）", () => {
		const m = member({ type: "window" })
		expect(isWithinTimeWindow(route({ members: [m] }), m, NOW_MONDAY_10)).toBe(true)
	})
})

// ── D7 thinking level 映射（并集声明 + 向上取档） ───────────────────────────

describe("D7 thinking level 并集声明", () => {
	it("路由 thinkingLevels = 各端点支持档位的并集（按档位序输出）", () => {
		const members = [
			member({ levels: { off: "x", low: "y" } }),
			member({ providerId: "opencode-go", modelId: "zai-glm", levels: { medium: "z", low: "w" } }),
		]
		expect(unionThinkingLevels(members)).toEqual(["off", "low", "medium"])
	})

	it("null 键 = 该端点不支持该档位（不进并集）；非法档位字面量过滤不注册", () => {
		const members = [
			member({ levels: { low: null, high: "y" } }),
			member({ providerId: "opencode-go", modelId: "zai-glm", levels: { ultra: "z", minimal: "w" } }),
		]
		expect(unionThinkingLevels(members)).toEqual(["minimal", "high"])
	})

	it("levels 缺省（端点档位未知）→ 空并集 []（调用方省略 thinkingLevels 字段，不猜测能力）", () => {
		expect(unionThinkingLevels([member({}), member({ levels: null })])).toEqual([])
		expect(unionThinkingLevels([member({ levels: { low: null } })])).toEqual([])
	})

	it("endpointThinkingLevels 取单端点支持档", () => {
		expect(endpointThinkingLevels(member({ levels: { off: "x", high: "y" } }))).toEqual(["off", "high"])
	})
})

describe("D7 档位向上取映射（resolveThinkingLevel）", () => {
	it("所选档端点支持 → 原样", () => {
		expect(resolveThinkingLevel("medium", ["off", "minimal", "low", "medium", "high"])).toBe("medium")
	})

	it("所选档不支持 → 按档位序向上取最近支持档", () => {
		expect(resolveThinkingLevel("low", ["off", "medium", "high"])).toBe("medium")
		expect(resolveThinkingLevel("minimal", ["high", "xhigh"])).toBe("high")
	})

	it("off 特例：off 为档位序最低值，向上取即端点最低支持档", () => {
		expect(resolveThinkingLevel("off", ["minimal", "low"])).toBe("minimal")
	})

	it("所选档高于端点全部支持档 → 取到顶即端点最高支持档", () => {
		expect(resolveThinkingLevel("high", ["off", "minimal", "medium"])).toBe("medium")
		expect(resolveThinkingLevel("max", ["high"])).toBe("high")
	})

	it("支持集空（端点档位未声明）→ 所选档原样透传（不干预，不猜映射）", () => {
		expect(resolveThinkingLevel("high", [])).toBe("high")
	})
})

// ── 词表完整性（MEMBER_BLOCK_REASONS 与文案映射同键集） ─────────────────────

describe("落选原因词表完整性", () => {
	it("MEMBER_BLOCK_REASONS 与 MEMBER_BLOCK_REASON_LABELS 键集一致（AX5 文案映射无缺键）", () => {
		expect(Object.keys(MEMBER_BLOCK_REASON_LABELS).sort()).toEqual([...MEMBER_BLOCK_REASONS].sort())
	})
})
