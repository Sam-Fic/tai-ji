/**
 * 路由求值穷举矩阵单测（RL2 / 验收 A1；T3 定名 route-matrix.test）。
 *
 * 行为契约 = docs/design/provider-aggregation-route-matrix.md：端点可选性矩阵 12 行逐格 + 全体候选状态
 * 多端点叠加（纯函数半边；enabled/deleted 两条闭包态在 aggregation-hot-reload.test）
 * + D7 档位向上取映射 + D12 mode 维度 + D13 特殊日期双型 + 时间窗落格边界 + D6 修订
 * （方案 B）终局观察 / burnt 软避让 / 轮换重探。
 * 求值函数为纯函数（now / 额度快照 / 终局观察消息 / 链内失败计数 / pi 重试预算全注入——
 * AX3），本文件零 fs、零子进程。
 */

import { describe, expect, it } from "vitest";

import { AGGREGATION_PROVIDER_ID, type AggregationMember, type AggregationRoute, type AggregationTimeWindowTable } from "@taiji/shared";

import {
	decideRoute,
	endpointThinkingLevels,
	evaluateRoute,
	isWithinTimeWindow,
	MEMBER_BLOCK_REASONS,
	MEMBER_BLOCK_REASON_LABELS,
	memberRef,
	parseFailoverState,
	resolveThinkingLevel,
	unionThinkingLevels,
	type DecideRouteInput,
	type RouteDecision,
	type RouteObservationMessage,
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

function evaluate(input: { route: AggregationRoute, now: Date, quotaByProviderId?: ReadonlyMap<string, RouteQuotaSnapshot> }) {
	return evaluateRoute(input)
}

// ── D6 修订（方案 B）fixture：终局观察 + burnt 软避让 ────────────────────────

/** 物理模型 assistant 消息（终局观察的最小视图——pi convertToLlm 对 assistant 原样透传）。 */
function outcome(provider: string, model: string, stopReason: string): RouteObservationMessage {
	return { role: "assistant", provider, model, stopReason }
}

/** 路由自身失败消息（pi handleRunFailure 用 _state.model 构造——provider = 虚拟 provider）。 */
function virtualError(routeId: string): RouteObservationMessage {
	return { role: "assistant", provider: AGGREGATION_PROVIDER_ID, model: routeId, stopReason: "error" }
}

/** decideRoute 调用（缺省：无观察消息 / 空 burnt / 空计数 / maxRetries=3 / 链边界）。 */
function decide(overrides: Partial<DecideRouteInput> & { route: AggregationRoute }): RouteDecision {
	return decideRoute({
		now: NOW_MONDAY_10,
		messages: [],
		burnt: new Set(),
		failures: new Map(),
		maxRetries: 3,
		chainBoundary: true,
		...overrides,
	})
}

/** 双端点路由（a 无条件 / b 无条件——failover 行为与条件矩阵正交，用例集中看 burn 逻辑）。 */
function twoMemberRoute(): AggregationRoute {
	return route({
		members: [
			member({ id: "a", providerId: "zhipu", modelId: "glm", type: "none" }),
			member({ id: "b", providerId: "opencode-go", modelId: "zai-glm", type: "none" }),
		],
	})
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
})

// ── D6 修订（方案 B）：终局观察 + burnt 软避让 + 轮换重探 ─────────────────────

describe("D6 修订：终局观察与 burnt 软避让（decideRoute）", () => {
	const GLM = "zhipu/glm"
	const ZAI = "opencode-go/zai-glm"

	it("无观察消息 → 按配置序命中首个候选（现状不回归）", () => {
		const result = decide({ route: twoMemberRoute() })
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes).toEqual([0, 1])
	})

	it("终局 error + 无链内计数（fail-fast：账户/凭据类，pi 压根没重试）→ 不 burnt，仍选该端点", () => {
		const result = decide({ route: twoMemberRoute(), messages: [outcome("zhipu", "glm", "error")] })
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes).toEqual([0, 1])
		expect([...result.burnt]).toEqual([])
	})

	it("终局 error + failures ≥ maxRetries（pi 重试预算用尽）→ burnt 该端点，failover 到候选", () => {
		const result = decide({
			route: twoMemberRoute(),
			messages: [outcome("zhipu", "glm", "error")],
			failures: new Map([[GLM, 3]]),
		})
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes).toEqual([1, 0]) // zai-glm 优先，glm 降序尾（软避让不删候选）
		expect([...result.burnt]).toEqual([GLM])
		// burn 后计数保留作幂等重导证据（原样透出）
		expect(result.failures.get(GLM)).toBe(3)
	})

	it("burn 幂等重导：同一终局 error 再次求值 → 仍 burnt 且同引用（闭包层据此跳过 state 落盘）", () => {
		const first = decide({ route: twoMemberRoute(), messages: [outcome("zhipu", "glm", "error")], failures: new Map([[GLM, 3]]) })
		if (first.outcome !== "selected") throw new Error("unreachable")
		const second = decide({
			route: twoMemberRoute(),
			messages: [outcome("zhipu", "glm", "error")],
			burnt: first.burnt,
			failures: first.failures,
		})
		expect(second.outcome).toBe("selected")
		if (second.outcome !== "selected") return
		expect(second.memberIndexes[0]).toBe(1)
		expect(second.burnt).toBe(first.burnt)
	})

	it("burnt 经 router state 持久化后，无观察消息也生效（跨轮次软避让）", () => {
		const result = decide({ route: twoMemberRoute(), burnt: new Set([GLM]) })
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes).toEqual([1, 0])
	})

	it("burnt 与条件正交：条件硬闸决定候选集（burn 不救活窗外端点、不制造 no-candidate）", () => {
		const windowed = route({
			members: [
				member({ id: "a", providerId: "zhipu", modelId: "glm", type: "window", window: windowTable([]) }),
				member({ id: "b", providerId: "opencode-go", modelId: "zai-glm", type: "none" }),
			],
		})
		// a 窗外不在候选集——burn 标记对它无意义；b 是唯一候选
		const r1 = decide({ route: windowed, burnt: new Set([GLM]) })
		expect(r1.outcome).toBe("selected")
		if (r1.outcome === "selected") expect(r1.memberIndexes).toEqual([1])
		// b 也 burnt → 唯一候选仍被重探（软偏好不制造 no-candidate——单端点 ≡ 直连每轮真试）
		const r2 = decide({ route: windowed, burnt: new Set([ZAI]) })
		expect(r2.outcome).toBe("selected")
		if (r2.outcome === "selected") expect(r2.memberIndexes).toEqual([1])
		// 全部端点条件落选 → no-candidate（矩阵既有语义，与 burn 无关）
		const quotaed = route({
			members: [
				member({ id: "a", providerId: "zhipu", modelId: "glm", type: "window", window: windowTable([]) }),
				member({ id: "b", providerId: "opencode-go", modelId: "zai-glm", type: "quota", quota: { thresholdPercent: 50 } }),
			],
		})
		const r3 = decide({ route: quotaed, burnt: new Set([GLM, ZAI]), quotaByProviderId: quotaMap([["opencode-go", 90]]) })
		expect(r3.outcome).toBe("no-candidate")
	})

	it("成功观察（stop/toolUse/length）→ 清 burnt + 计数（端点康复，重新成为首选）", () => {
		for (const stopReason of ["stop", "toolUse", "length"]) {
			const result = decide({
				route: twoMemberRoute(),
				messages: [outcome("zhipu", "glm", stopReason)],
				burnt: new Set([GLM]),
				failures: new Map([[GLM, 3]]),
			})
			expect(result.outcome).toBe("selected")
			if (result.outcome !== "selected") continue
			expect(result.memberIndexes).toEqual([0, 1])
			expect([...result.burnt]).toEqual([])
			expect(result.failures.size).toBe(0)
		}
	})

	it("aborted → 不观察：burnt 不动、链内计数作废（用户取消不是端点事实）", () => {
		const result = decide({
			route: twoMemberRoute(),
			messages: [outcome("zhipu", "glm", "aborted")],
			burnt: new Set([ZAI]),
			failures: new Map([[GLM, 2]]),
		})
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes).toEqual([0, 1]) // ZAI 仍 burnt 被避让，GLM 恢复首选
		expect([...result.burnt]).toEqual([ZAI])
		expect(result.failures.size).toBe(0)
	})

	it("虚拟模型 error（路由自身失败）→ 跳过，向前找最近物理结局（连续多轮路由失败后幂等重导）", () => {
		const result = decide({
			route: twoMemberRoute(),
			messages: [outcome("zhipu", "glm", "error"), virtualError("route-a")],
			failures: new Map([[GLM, 3]]),
		})
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes[0]).toBe(1)
		expect([...result.burnt]).toEqual([GLM])
	})

	it("全部消息都是虚拟 error → 无物理结局可观察（burnt 保持入参）", () => {
		const result = decide({ route: twoMemberRoute(), messages: [virtualError("route-a"), virtualError("route-a")] })
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes).toEqual([0, 1])
	})

	// ── 修剪修复（P1）：链内计数的退役路径——计数生命周期 = 活跃重试链 ──────────────

	it("计数退役：最近物理结局是非本路由成员的消息（模型切走切回）→ 旧计数作废，不误烧", () => {
		const stale = decide({
			route: twoMemberRoute(),
			messages: [outcome("zhipu", "glm", "error"), outcome("other-provider", "other-model", "stop")],
			failures: new Map([[GLM, 3]]),
		})
		expect(stale.outcome).toBe("selected")
		if (stale.outcome !== "selected") return
		expect(stale.failures.size).toBe(0) // 旧计数 3 已退役——切走轮次终断了本路由的链
		expect([...stale.burnt]).toEqual([])
		// 退役后同端点再遇账户类 fail-fast（pi 不重试，本链计数 0）→ 不 burnt（fail-fast 分界）
		const failFast = decide({
			route: twoMemberRoute(),
			messages: [outcome("zhipu", "glm", "error")],
			failures: stale.failures,
		})
		expect(failFast.outcome).toBe("selected")
		if (failFast.outcome !== "selected") return
		expect([...failFast.burnt]).toEqual([])
		expect(failFast.memberIndexes).toEqual([0, 1])
	})

	it("计数退役：无物理消息可观察 → 旧计数作废（证据已不可考）", () => {
		const result = decide({ route: twoMemberRoute(), failures: new Map([[GLM, 3]]) })
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.failures.size).toBe(0)
	})

	it("burn 时保留 F 的计数作重导证据、其余成员计数退役（单活链，其余必陈旧）", () => {
		const result = decide({
			route: twoMemberRoute(),
			messages: [outcome("zhipu", "glm", "error")],
			failures: new Map([[GLM, 3], [ZAI, 1]]),
		})
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect([...result.burnt]).toEqual([GLM])
		expect(result.failures.size).toBe(1)
		expect(result.failures.get(GLM)).toBe(3)
	})

	it("burn 后端点康复（成功出站）→ 清 burnt 且计数整体退役（证据计数一并作废）", () => {
		const burned = decide({ route: twoMemberRoute(), messages: [outcome("zhipu", "glm", "error")], failures: new Map([[GLM, 3]]) })
		if (burned.outcome !== "selected") throw new Error("unreachable")
		const recovered = decide({
			route: twoMemberRoute(),
			messages: [outcome("zhipu", "glm", "stop")],
			burnt: burned.burnt,
			failures: burned.failures,
		})
		expect(recovered.outcome).toBe("selected")
		if (recovered.outcome !== "selected") return
		expect([...recovered.burnt]).toEqual([])
		expect(recovered.failures.size).toBe(0)
		// 康复后再遇账户类 fail-fast：无旧计数可误判 → 不 burnt
		const failFast = decide({ route: twoMemberRoute(), messages: [outcome("zhipu", "glm", "error")], failures: recovered.failures })
		if (failFast.outcome !== "selected") throw new Error("unreachable")
		expect([...failFast.burnt]).toEqual([])
	})

	// ── 修剪修复（P9）：未知 stopReason 保守处理（不猜「康复」反向清理偏好） ──────────

	it("未知 stopReason（pending/deferred/未来值）→ 不清 burnt、计数退役（值域外不猜测）", () => {
		for (const stopReason of ["pending", "deferred", "some-future-reason"]) {
			const result = decide({
				route: twoMemberRoute(),
				// 未知结局落在已 burnt 的成员身上——若按「成功」处理会反向清掉 burn
				messages: [outcome("opencode-go", "zai-glm", stopReason)],
				burnt: new Set([ZAI]),
				failures: new Map([[GLM, 2]]),
			})
			expect(result.outcome).toBe("selected")
			if (result.outcome !== "selected") continue
			expect([...result.burnt]).toEqual([ZAI]) // 不动既有 burn
			expect(result.failures.size).toBe(0) // 链已终断——计数退役
		}
	})

	// ── 修剪修复（P3）：轮换重探的引用纪律——序列未变返回原引用 ──────────────────

	it("单候选全 burnt 轮换 → 序列不变返回原引用（pi 落盘门禁是引用比较，防每请求重复 append）", () => {
		const single = route({ members: [member({ id: "a", providerId: "zhipu", modelId: "glm", type: "none" })] })
		const burntIn = new Set([GLM])
		const result = decide({ route: single, burnt: burntIn })
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes).toEqual([0]) // 仍重探唯一候选（≡ 直连每轮真试）
		expect(result.burnt).toBe(burntIn) // 同引用——闭包层据此跳过 state 落盘
	})

	it("双候选全 burnt 轮换 → 序列真变化仍产出新序（坏端点交替，回归锁定）", () => {
		const result = decide({ route: twoMemberRoute(), burnt: new Set([GLM, ZAI]) })
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes[0]).toBe(0)
		expect([...result.burnt]).toEqual([ZAI, GLM])
	})

	// ── 修剪复审修复（F1）：非链边界求值不观察——在途投影不迁移状态 ──────────────

	it("非链边界（direct 链中压缩 / retry 落 normal-selection）→ 不观察：在途计数不抹、burnt 不动", () => {
		// 形态 ①：链在途的 direct 求值——投影里失败 attempt 已被剔除，只剩链前旧消息
		// （他模型成功）。修复前：retireCounts 抹掉活链计数 → 终局 error 判 fail-fast → 永不 failover
		const duringChain = decide({
			route: twoMemberRoute(),
			messages: [outcome("other-provider", "other-model", "stop")],
			failures: new Map([[GLM, 1]]),
			chainBoundary: false,
		})
		expect(duringChain.outcome).toBe("selected")
		if (duringChain.outcome !== "selected") return
		expect(duringChain.failures.get(GLM)).toBe(1) // 在途计数原样保留
		expect([...duringChain.burnt]).toEqual([])
		// 形态 ②：非边界求值看到本成员陈旧成功结局——不清 burnt（修复前会反向清掉持久 burn）
		const staleSuccess = decide({
			route: twoMemberRoute(),
			messages: [outcome("zhipu", "glm", "stop")],
			burnt: new Set([GLM]),
			chainBoundary: false,
		})
		expect(staleSuccess.outcome).toBe("selected")
		if (staleSuccess.outcome !== "selected") return
		expect([...staleSuccess.burnt]).toEqual([GLM]) // 持久 burn 不被在途投影反向清
		// 形态 ③：非边界求值看到本成员终局 error——不抢跑 burn（回合级事实只由边界观察）
		const staleError = decide({
			route: twoMemberRoute(),
			messages: [outcome("zhipu", "glm", "error")],
			failures: new Map([[GLM, 3]]),
			chainBoundary: false,
		})
		expect(staleError.outcome).toBe("selected")
		if (staleError.outcome !== "selected") return
		expect([...staleError.burnt]).toEqual([]) // 不在途抢跑——下一链边界观察才 burnt
		expect(staleError.failures.get(GLM)).toBe(3)
	})

	it("非本路由成员的物理 error（用户中途换过模型）→ 无观察，不误清既有 burn", () => {
		const result = decide({
			route: twoMemberRoute(),
			messages: [outcome("other-provider", "other-model", "error")],
			burnt: new Set([GLM]),
		})
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes).toEqual([1, 0])
		expect([...result.burnt]).toEqual([GLM])
	})

	it("全部候选 burnt → 轮换重探：burn 序最旧的候选优先并移到序尾（坏端点交替，恢复者不被饿死）", () => {
		const result = decide({ route: twoMemberRoute(), burnt: new Set([GLM, ZAI]) })
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes[0]).toBe(0) // GLM burn 序最旧 → 优先重探
		expect([...result.burnt]).toEqual([ZAI, GLM]) // GLM 移到序尾
		// 下一轮：ZAI 成为最旧 → 重探 ZAI
		const next = decide({ route: twoMemberRoute(), burnt: result.burnt })
		if (next.outcome !== "selected") throw new Error("unreachable")
		expect(next.memberIndexes[0]).toBe(1)
		expect([...next.burnt]).toEqual([GLM, ZAI])
	})

	it("simple 模式下 burnt 软避让同样生效（burn 不是条件，条件不判避让照判）", () => {
		const result = decide({ route: route({ mode: "simple", members: twoMemberRoute().members }), burnt: new Set([GLM]) })
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes).toEqual([1, 0])
	})

	it("maxRetries=0（pi 重试停用）→ 任何终局 error 即 burnt（预算零容限，failover 即时生效）", () => {
		const result = decide({
			route: twoMemberRoute(),
			messages: [outcome("zhipu", "glm", "error")],
			maxRetries: 0,
		})
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes).toEqual([1, 0])
		expect([...result.burnt]).toEqual([GLM])
	})

	it("无候选 + 终局观察烧掉端点 → burn 仍随决策透出（throw 路径无 state 出口，下一轮幂等重导——T6 场景的单测锚）", () => {
		const windowed = route({
			members: [
				member({ id: "a", providerId: "zhipu", modelId: "glm", type: "window", window: windowTable([]) }),
				member({ id: "b", providerId: "opencode-go", modelId: "zai-glm", type: "window", window: windowTable([]) }),
			],
		})
		const result = decide({
			route: windowed,
			messages: [outcome("zhipu", "glm", "error")],
			failures: new Map([[GLM, 3]]),
		})
		expect(result.outcome).toBe("no-candidate")
		if (result.outcome !== "no-candidate") return
		expect([...result.burnt]).toEqual([GLM]) // burn 已算出——恢复配置后下一轮求值重导，不依赖闭包镜像
		expect(result.failures.get(GLM)).toBe(3)
	})

	it("轮换重探跳过非候选 burnt 引用：窗外端点的旧 burn 不占用重探位（候选内取最旧）", () => {
		const mixed = route({
			members: [
				member({ id: "a", providerId: "zhipu", modelId: "glm", type: "window", window: windowTable([]) }),
				member({ id: "b", providerId: "opencode-go", modelId: "zai-glm", type: "none" }),
			],
		})
		// GLM 窗外不在候选集但 burn 序更旧——轮换只能在候选（ZAI）内取
		const result = decide({ route: mixed, burnt: new Set([GLM, ZAI]) })
		expect(result.outcome).toBe("selected")
		if (result.outcome !== "selected") return
		expect(result.memberIndexes[0]).toBe(1) // 重探唯一候选 ZAI
		expect([...result.burnt]).toEqual([GLM, ZAI]) // ZAI 移到序尾（GLM 保持最旧，恢复窗口后仍先避让）
	})
})

describe("parseFailoverState（router state 防御解析）", () => {
	it("坏形状（undefined / null / 非对象 / burnt 非数组 / 元素非字符串）→ 空集或过滤", () => {
		expect([...parseFailoverState(undefined)]).toEqual([])
		expect([...parseFailoverState(null)]).toEqual([])
		expect([...parseFailoverState("burnt")]).toEqual([])
		expect([...parseFailoverState({})]).toEqual([])
		expect([...parseFailoverState({ burnt: "zhipu/glm" })]).toEqual([])
		expect([...parseFailoverState({ burnt: ["ok", 7, null] })]).toEqual(["ok"])
	})

	// 修剪修复（P6）：JSON 可达输入空间全枚举——行为侧零抛，形状矩阵逐形态锁定
	it("输入形态矩阵（33 形态枚举：state 标量/数组、burnt 标量/对象/嵌套、空白串、重复、未来字段）→ 零抛，语义如注", () => {
		const shapes: Array<[unknown, string[]]> = [
			// state 自身形态
			[true, []],
			[false, []],
			[42, []],
			[0, []],
			[[], []],
			[["a/1"], []],
			[[{ burnt: [] }], []],
			// burnt 字段形态
			[{ burnt: null }, []],
			[{ burnt: true }, []],
			[{ burnt: 42 }, []],
			[{ burnt: {} }, []],
			[{ burnt: { a: "ref" } }, []],
			[{ burnt: [] }, []],
			// 元素形态：嵌套 / 空白串（空白串是合法串——不匹配任何成员即惰性，放行不过滤）
			[{ burnt: [["a/1"]] }, []],
			[{ burnt: [{ ref: "a/1" }] }, []],
			[{ burnt: [""] }, [""]],
			[{ burnt: ["  "] }, ["  "]],
			[{ burnt: ["\n"] }, ["\n"]],
			// 重复元素去重（Set 语义）
			[{ burnt: ["a/1", "a/1"] }, ["a/1"]],
			// 未来字段（版本演进预留）不影响解析
			[{ burnt: ["a/1"], version: 2, extra: { x: 1 } }, ["a/1"]],
			// 原型污染字样按普通串处理（JSON.parse 不产生 __proto__ 自有属性）
			[{ burnt: ["__proto__", "constructor"] }, ["__proto__", "constructor"]],
		]
		for (const [input, expected] of shapes) {
			expect([...parseFailoverState(input)]).toEqual(expected)
		}
	})

	it("合法数组 → 集（保序——burn 序是轮换公平的基准）", () => {
		expect([...parseFailoverState({ burnt: ["a/1", "b/2"] })]).toEqual(["a/1", "b/2"])
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
