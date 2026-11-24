/**
 * 配置热重读集成测试（RL4 / 验收 A4；T3 定名 aggregation-hot-reload.test）。
 *
 * 覆盖断言（impl-plan A4 行）：mtime 重注册幂等（编辑替换）/ 求值前重读不新增注册
 * （新 id 忽略，D1 ③）/ 删除 = 保持注册 + 闭包显式失败（D9/AS22）/ 损坏隔离呈报 +
 * 扩展保持旧注册 / 停用与文件消失的闭包失败态 / 同 id 重建恢复链 / session_start
 * 对账（新增 id 补注册 + contextWindow 元数据补齐）/ 零配置零注册 / route 闭包端到端
 * （物理模型解析 + D7 档位映射 + D6 修订 retry 透传与终局 failover）。
 *
 * 形态（TEST-STRATEGY 三档判据）：真实 fs 限 os.tmpdir() 白名单内 mkdtemp 自建自删；
 * 确定性同步化——mtime 用 utimesSync 显式错开（不依赖真实时钟精度，判据 i 类处置），
 * 求值墙钟用 fake timers 固定（时间注入）；pi 侧用 mock（无真子进程）。全同步无等待
 * 窗口，高负载下耗时与单测常态一致。
 */

import { mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionVirtualModel, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { AGGREGATION_PROVIDER_ID, type AggregationTimeWindowTable } from "@taiji/shared";

import providerAggregationFactory from "../index.ts";

// ── fixture ──────────────────────────────────────────────────────────────────

/** 固定求值墙钟：2026-11-02（周一）10:00 本地时间。 */
const NOW = new Date(2026, 10, 2, 10, 0, 0)

/** 显式错开的 mtime 序列（确定性驱动 mtime 门，不依赖真实时钟精度）。 */
const [T1, T2, T3] = [1_000_001, 2_000_002, 3_000_003]

/** boolean[7][48] 时间窗表（涂 true 的 [day, slot] 格）。 */
function windowTable(cells: Array<[day: number, slot: number]>): AggregationTimeWindowTable {
	const table: AggregationTimeWindowTable = Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => false as boolean))
	for (const [day, slot] of cells) table[day][slot] = true
	return table
}

/** 全 false 表（端点任何时刻都在窗外）。 */
const EMPTY_WINDOW = windowTable([])
/** 仅周一 10:00 格可用（NOW 所在格）。 */
const MONDAY_10_WINDOW = windowTable([[0, 20]])

const ROUTE_A = {
	id: "route-a",
	name: "Route A",
	modelId: "route-a",
	enabled: true,
	mode: "advanced",
	members: [
		{ id: "e1", providerId: "zhipu", modelId: "glm", type: "none" },
		{ id: "e2", providerId: "opencode-go", modelId: "zai-glm", type: "none" },
	],
	specials: [],
} as const

const ROUTE_B = {
	id: "route-b",
	name: "Route B",
	modelId: "route-b",
	enabled: true,
	mode: "advanced",
	members: [{ id: "e1", providerId: "zhipu", modelId: "glm", type: "none" }],
	specials: [],
} as const

/** 端点物理模型（contextWindow 故意不齐：zhipu 200k / opencode-go 128k——最小值断言）。 */
const PHYSICAL_MODELS: Array<{ provider: string, id: string, contextWindow: number }> = [
	{ provider: "zhipu", id: "glm", contextWindow: 200_000 },
	{ provider: "opencode-go", id: "zai-glm", contextWindow: 128_000 },
]

function createMockPi() {
	const registered = new Map<string, ExtensionVirtualModel>()
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>>()
	const pi = {
		registerVirtualModel: vi.fn((model: ExtensionVirtualModel) => {
			registered.set(`${model.provider}/${model.id}`, model)
		}),
		unregisterVirtualModel: vi.fn((provider: string, id: string) => {
			registered.delete(`${provider}/${id}`)
		}),
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => {
			handlers.set(event, handler)
		}),
		appendEntry: vi.fn(),
		getSettings: vi.fn(() => ({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 } })),
	}
	return { pi: pi as unknown as ExtensionAPI, registered, handlers, registerVirtualModel: pi.registerVirtualModel, unregisterVirtualModel: pi.unregisterVirtualModel }
}

function createMockCtx(): ExtensionContext {
	return {
		modelRegistry: {
			find: vi.fn((provider: string, modelId: string) =>
				PHYSICAL_MODELS.find(m => m.provider === provider && m.id === modelId) as unknown as Model | undefined),
		},
	} as unknown as ExtensionContext
}

function routeRequest(overrides?: Partial<ModelRouteRequest>): ModelRouteRequest {
	return {
		model: { provider: AGGREGATION_PROVIDER_ID, id: "route-a" } as unknown as Model,
		thinkingLevel: "off",
		reason: "user",
		messages: [],
		...overrides,
	}
}

// ── 装置 ─────────────────────────────────────────────────────────────────────

let tmpDir: string
let configPath: string

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "provider-aggregation-test-"))
	configPath = join(tmpDir, "providers.json")
	vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function writeConfig(routes: ReadonlyArray<unknown>, mtimeMs: number): void {
	// providers.json 顶层形态：routes 键值 = { version, routes: [...] }（D2：外层键与内层
	// 集合字段同名）；其余顶层键（version/providers/scopedModels）本扩展不消费，fixture 不写。
	writeFileSync(configPath, JSON.stringify({ version: 1, routes: { version: 1, routes } }), "utf8")
	utimesSync(configPath, new Date(mtimeMs), new Date(mtimeMs))
}

function writeCorruptConfig(mtimeMs: number): void {
	writeFileSync(configPath, "this is not json {", "utf8")
	utimesSync(configPath, new Date(mtimeMs), new Date(mtimeMs))
}

async function runSessionStart(handlers: Map<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>>, ctx: ExtensionContext): Promise<void> {
	const handler = handlers.get("session_start")
	expect(handler).toBeDefined()
	await handler?.(undefined, ctx)
}

/** 求值 route-a 闭包（命中端点的物理模型 id + 档位 + router state；闭包 throw 时透传异常）。 */
function routeVia(registered: Map<string, ExtensionVirtualModel>, routeId: string, ctx: ExtensionContext, request?: ModelRouteRequest): { modelId: string, thinkingLevel: string, state: unknown } {
	const definition = registered.get(`${AGGREGATION_PROVIDER_ID}/${routeId}`)
	expect(definition).toBeDefined()
	const result = definition?.route(routeRequest(request), ctx)
	if (result instanceof Promise) throw new Error("route closure must be synchronous for this fixture")
	return { modelId: result.model.id, thinkingLevel: result.thinkingLevel, state: result.state }
}

// ── 工厂期注册与 session_start 对账 ──────────────────────────────────────────

describe("工厂期注册（D1 ①）", () => {
	it("配置全集注册为虚拟模型（含 enabled=false 条目——保持注册语义，D9 停用侧）；工厂期无目录不声明 contextWindow", () => {
		writeConfig([ROUTE_A, { ...ROUTE_B, enabled: false }], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		expect(registered.size).toBe(2)
		expect(registered.has(`${AGGREGATION_PROVIDER_ID}/route-a`)).toBe(true)
		expect(registered.has(`${AGGREGATION_PROVIDER_ID}/route-b`)).toBe(true)
		const definition = registered.get(`${AGGREGATION_PROVIDER_ID}/route-a`)
		expect(definition?.name).toBe(ROUTE_A.name)
		expect(definition?.contextWindow).toBeUndefined()
	})

	it("thinkingLevels = 端点档位并集（D7 声明半边）；空并集省略字段", () => {
		writeConfig(
			[
				{
					...ROUTE_A,
					members: [
						{ id: "e1", providerId: "zhipu", modelId: "glm", type: "none", levels: { off: "x", low: "y" } },
						{ id: "e2", providerId: "opencode-go", modelId: "zai-glm", type: "none", levels: { medium: "z" } },
					],
				},
			],
			T1,
		)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		expect(registered.get(`${AGGREGATION_PROVIDER_ID}/route-a`)?.thinkingLevels).toEqual(["off", "low", "medium"])
	})

	it("零配置环境零注册（V8：无 routes 域 = 空集 = 零行为），session_start 正常完成", async () => {
		const { pi, registered, handlers } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		expect(registered.size).toBe(0)
		await expect(runSessionStart(handlers, createMockCtx())).resolves.toBeUndefined()
		expect(registered.size).toBe(0)
	})
})

describe("session_start 对账（D1 ②）", () => {
	it("为全部已注册条目补齐 contextWindow = 各端点 contextWindow 最小值（D7/D4 ⑤）", async () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered, handlers } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		await runSessionStart(handlers, createMockCtx())
		expect(registered.get(`${AGGREGATION_PROVIDER_ID}/route-a`)?.contextWindow).toBe(128_000)
	})

	it("覆盖工厂期之后的新增条目（新 id 在会话加载窗口补注册——D1 ③「下次会话加载可用」后半边）", async () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered, handlers } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		writeConfig([ROUTE_A, ROUTE_B], T2)
		await runSessionStart(handlers, createMockCtx())
		expect(registered.has(`${AGGREGATION_PROVIDER_ID}/route-b`)).toBe(true)
	})
})

// ── mtime 门与求值前重读（RL4 核心断言） ─────────────────────────────────────

describe("route 求值前 mtime 重读（D1 ③）", () => {
	it("mtime 未变化不重读不重注册（无定时器形态：重读只由求值时机驱动）", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered, registerVirtualModel } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const callsAfterFactory = registerVirtualModel.mock.calls.length
		routeVia(registered, "route-a", createMockCtx())
		routeVia(registered, "route-a", createMockCtx())
		expect(registerVirtualModel.mock.calls.length).toBe(callsAfterFactory)
	})

	it("同 id 编辑幂等替换：mtime 变化触发重注册，运行中会话下一请求按新定义求值（V5 单测半边）", () => {
		writeConfig(
			[
				{
					...ROUTE_A,
					members: [
						// v1：端点 e1 周一 10:00 可用 → 命中 zhipu/glm
						{ id: "e1", providerId: "zhipu", modelId: "glm", type: "window", window: MONDAY_10_WINDOW },
						{ id: "e2", providerId: "opencode-go", modelId: "zai-glm", type: "none" },
					],
				},
			],
			T1,
		)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		expect(routeVia(registered, "route-a", ctx).modelId).toBe("glm")

		// v2 编辑：e1 时间窗涂空（周一 10:00 不可用）→ 命中兜底端点 e2
		writeConfig(
			[
				{
					...ROUTE_A,
					members: [
						{ id: "e1", providerId: "zhipu", modelId: "glm", type: "window", window: EMPTY_WINDOW },
						{ id: "e2", providerId: "opencode-go", modelId: "zai-glm", type: "none" },
					],
				},
			],
			T2,
		)
		expect(routeVia(registered, "route-a", ctx).modelId).toBe("zai-glm")
		expect(registered.size).toBe(1) // 幂等替换：仍是同一条目
	})

	it("求值前重读不新增注册：运行中新建的路由 id 被忽略（D1 ③），session_start 后可用（RL8 单测半边）", async () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered, handlers } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		writeConfig([ROUTE_A, ROUTE_B], T2)
		routeVia(registered, "route-a", createMockCtx()) // 触发求值前重读
		expect(registered.has(`${AGGREGATION_PROVIDER_ID}/route-b`)).toBe(false)
		await runSessionStart(handlers, createMockCtx())
		expect(registered.has(`${AGGREGATION_PROVIDER_ID}/route-b`)).toBe(true)
	})
})

// ── 闭包失败态（D9/AX5——不静默回落） ───────────────────────────────────────

describe("删除 = 保持注册 + 闭包显式失败（D9 删除侧 / AS22）", () => {
	it("条目消失：不调 unregisterVirtualModel，闭包 throw「已删除」带恢复指引", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered, unregisterVirtualModel } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		writeConfig([], T2)
		const ctx = createMockCtx()
		expect(() => routeVia(registered, "route-a", ctx)).toThrow(/已删除/)
		expect(unregisterVirtualModel).not.toHaveBeenCalled()
		expect(registered.has(`${AGGREGATION_PROVIDER_ID}/route-a`)).toBe(true)
	})

	it("同一 id 重新创建：下次求值前重读以新定义幂等替换，无需换模型即恢复（D1 ③）", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		writeConfig([], T2)
		const ctx = createMockCtx()
		expect(() => routeVia(registered, "route-a", ctx)).toThrow(/已删除/)
		writeConfig(
			[{ ...ROUTE_A, members: [{ id: "e1", providerId: "zhipu", modelId: "glm-5-3", type: "none" }] }],
			T3,
		)
		// 目录里补新端点模型（重建后的定义引用不同模型 id——验证「新定义」生效而非旧缓存）
		const rebuiltCtx = {
			modelRegistry: {
				find: vi.fn((provider: string, modelId: string) =>
					modelId === "glm-5-3" ? ({ provider, id: modelId, contextWindow: 100_000 }) as unknown as Model : undefined),
			},
		} as unknown as ExtensionContext
		expect(routeVia(registered, "route-a", rebuiltCtx).modelId).toBe("glm-5-3")
	})

	it("文件消失（absent）= 全部已注册条目标记删除态，保持注册", () => {
		writeConfig([ROUTE_A, ROUTE_B], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		rmSync(configPath)
		const ctx = createMockCtx()
		expect(() => routeVia(registered, "route-a", ctx)).toThrow(/已删除/)
		expect(() => routeVia(registered, "route-b", ctx)).toThrow(/已删除/)
		expect(registered.size).toBe(2)
	})
})

describe("停用 = 保持注册 + 闭包显式失败（D9 停用侧）", () => {
	it("enabled 翻转为 false：保持注册，闭包 throw「已停用」；重新启用后闭包恢复", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		writeConfig([{ ...ROUTE_A, enabled: false }], T2)
		expect(() => routeVia(registered, "route-a", ctx)).toThrow(/已停用/)
		expect(registered.has(`${AGGREGATION_PROVIDER_ID}/route-a`)).toBe(true)
		writeConfig([ROUTE_A], T3)
		expect(routeVia(registered, "route-a", ctx).modelId).toBe("glm")
	})
})

// ── 损坏隔离（RL4：损坏呈报 + 扩展保持旧注册继续路由） ──────────────────────

describe("配置损坏 = 保持旧注册继续路由", () => {
	it("corrupt：warn 呈报，闭包按上一有效定义求值不失败", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const warnSpy = vi.spyOn(getLogger("provider-aggregation"), "warn")
		writeCorruptConfig(T2)
		const ctx = createMockCtx()
		expect(routeVia(registered, "route-a", ctx).modelId).toBe("glm")
		expect(warnSpy).toHaveBeenCalled()
		expect(warnSpy.mock.calls[0]?.[0]).toContain("corrupt")
	})

	it("损坏期间的注册集不随损坏内容漂移（保持旧注册），文件修复后重读恢复", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		writeCorruptConfig(T2)
		writeConfig([ROUTE_B], T3) // 修复（route-a 被删、route-b 新增）
		const ctx = createMockCtx()
		expect(() => routeVia(registered, "route-a", ctx)).toThrow(/已删除/) // 修复版里无 route-a
		expect(registered.has(`${AGGREGATION_PROVIDER_ID}/route-b`)).toBe(false) // 新增 id 不在求值前路径注册
	})
})

// ── stat 故障 = 保持旧注册继续路由（RL4 读失败族：非 ENOENT stat 故障不入 absent 删除态） ──

describe("stat 故障 = 保持旧注册继续路由", () => {
	it("非 ENOENT stat 故障（自指 symlink → ELOOP）：warn 呈报，闭包按上一有效定义求值，不标删除态；故障持续不重复 warn", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const warnSpy = vi.spyOn(getLogger("provider-aggregation"), "warn")
		// 「存在但 stat 失败」的最小确定性构造：configPath 替换为自指 symlink，statSync 抛 ELOOP（非 ENOENT）
		rmSync(configPath)
		symlinkSync(configPath, configPath)
		const ctx = createMockCtx()
		expect(routeVia(registered, "route-a", ctx).modelId).toBe("glm") // 保持旧注册继续路由
		expect(routeVia(registered, "route-a", ctx).modelId).toBe("glm") // 第二次求值：签名 sentinel 去重不重复消费
		expect(warnSpy).toHaveBeenCalledTimes(1)
		expect(warnSpy.mock.calls[0]?.[0]).toContain("stat failed")
	})

	it("stat 恢复后下次求值重读收敛（sentinel 与 mtime 签名必然不同）：按恢复后的新定义路由", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		rmSync(configPath)
		symlinkSync(configPath, configPath)
		const ctx = createMockCtx()
		expect(routeVia(registered, "route-a", ctx).modelId).toBe("glm")
		unlinkSync(configPath) // stat 故障解除（unlink 不追随 symlink）
		writeConfig(
			[
				{
					...ROUTE_A,
					members: [
						{ id: "e1", providerId: "zhipu", modelId: "glm", type: "window", window: EMPTY_WINDOW },
						{ id: "e2", providerId: "opencode-go", modelId: "zai-glm", type: "none" },
					],
				},
			],
			T3,
		)
		expect(routeVia(registered, "route-a", ctx).modelId).toBe("zai-glm") // 新定义已消费（e1 窗外 → 兜底 e2）
	})
})

// ── route 闭包端到端（物理模型解析 + D7 档位映射 + D6 修订 retry 透传与 failover） ──

describe("route 闭包端到端", () => {
	it("命中端点返回物理模型对象（ctx.modelRegistry.find 解析；AX2：虚拟条目永不出站）", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		const result = routeVia(registered, "route-a", ctx)
		expect(result.modelId).toBe("glm") // 第一个端点无条件命中
		expect(findSpyCalls(ctx)).toContainEqual(["zhipu", "glm"])
	})

	it("D7 档位向上取：所选档端点不支持 → 映射到端点最近支持档（请求层输出）", () => {
		writeConfig(
			[
				{
					...ROUTE_A,
					members: [
						{ id: "e1", providerId: "zhipu", modelId: "glm", type: "none", levels: { medium: "x", high: "y" } },
					],
				},
			],
			T1,
		)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		// 用户选 off（pi 缺省/目录声明）而端点最低支持 medium → 落 medium
		expect(routeVia(registered, "route-a", ctx, { thinkingLevel: "off" }).thinkingLevel).toBe("medium")
		// 用户选 low → 向上取 medium
		expect(routeVia(registered, "route-a", ctx, { thinkingLevel: "low" }).thinkingLevel).toBe("medium")
		// 用户选 max（高于端点全部支持档）→ 端点最高 high
		expect(routeVia(registered, "route-a", ctx, { thinkingLevel: "max" }).thinkingLevel).toBe("high")
	})

	it("D6 修订 retry 透传端到端：reason=retry 且 failed 指向第一端点 → 原样返回该端点（不复查条件）", () => {
		writeConfig(
			[
				{
					...ROUTE_A,
					// e1 窗外：透传不复查条件——重试归属在途请求的延续（直连模型同型）
					members: [
						{ id: "e1", providerId: "zhipu", modelId: "glm", type: "window", window: EMPTY_WINDOW },
						{ id: "e2", providerId: "opencode-go", modelId: "zai-glm", type: "none" },
					],
				},
			],
			T1,
		)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		const failedMessage = { stopReason: "error", errorMessage: "524 origin timeout" } as unknown as AssistantMessage
		const result = routeVia(registered, "route-a", ctx, {
			reason: "retry",
			failed: {
				model: { provider: "zhipu", id: "glm" } as unknown as Model,
				thinkingLevel: "off",
				message: failedMessage,
			},
		})
		expect(result.modelId).toBe("glm") // 窗外端点仍被透传命中（不换端点、不复查条件）
	})

	it("D6 修订 failover 端到端：链内计数达到 maxRetries 后终局失败 → burnt 并换候选端点", async () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		const failedMessage = { stopReason: "error", errorMessage: "524 origin timeout" } as unknown as AssistantMessage
		const failedGlm = {
			model: { provider: "zhipu", id: "glm" } as unknown as Model,
			thinkingLevel: "off",
			message: failedMessage,
		}
		// pi 重试预算 3 次：retry 求值透传 glm 并各计一次失败（maxRetries=3 来自 mock getSettings）
		for (let i = 0; i < 3; i++) {
			expect(routeVia(registered, "route-a", ctx, { reason: "retry", failed: failedGlm }).modelId).toBe("glm")
		}
		// 终局失败后的下一轮求值：messages 带 glm 的终局 error → 预算用尽 → burnt → 换 zai-glm
		const afterFailure = routeVia(registered, "route-a", ctx, {
			reason: "user",
			messages: [{ role: "assistant", provider: "zhipu", model: "glm", stopReason: "error" } as unknown as Message],
		})
		expect(afterFailure.modelId).toBe("zai-glm")
		expect(afterFailure.state).toEqual({ burnt: ["zhipu/glm"] })
		// burnt 经 router state 回传：无观察消息也保持避让
		const nextTurn = routeVia(registered, "route-a", ctx, {
			reason: "user",
			state: afterFailure.state,
		})
		expect(nextTurn.modelId).toBe("zai-glm")
		expect(nextTurn.state).toBeUndefined() // 无变化不落 state 条目
	})

	it("D6 修订 fail-fast 不换端点端到端：终局 error 但无链内计数（pi 没重试）→ 仍选原端点", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		const result = routeVia(registered, "route-a", ctx, {
			reason: "user",
			messages: [{ role: "assistant", provider: "zhipu", model: "glm", stopReason: "error" } as unknown as Message],
		})
		expect(result.modelId).toBe("glm") // 账户类 fail-fast：主端点错误持续可见，不向候选漂移
		expect(result.state).toBeUndefined()
	})

	it("D6 修订 retry 停用端到端：settings.retry.enabled=false → 预算读 0 → 终局 error 即 burnt failover（题面 §3.6 行为后果）", () => {
		writeConfig([ROUTE_A], T1)
		const base = createMockPi()
		const pi = {
			...base.pi,
			getSettings: vi.fn(() => ({ retry: { enabled: false, maxRetries: 3, baseDelayMs: 2000 } })),
		} as unknown as ExtensionAPI
		// mock 的 registerVirtualModel 仍写回 base.registered（展开复制的是同一函数引用）
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		const result = routeVia(base.registered, "route-a", ctx, {
			reason: "user",
			messages: [{ role: "assistant", provider: "zhipu", model: "glm", stopReason: "error" } as unknown as Message],
		})
		expect(result.modelId).toBe("zai-glm") // 停用 = 零次重试：首败即超预算 → burnt → failover
		expect(result.state).toEqual({ burnt: ["zhipu/glm"] })
	})

	it("retry 但 failed 端点已不在配置（链中路过配置被改）→ 落正常选择", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		const result = routeVia(registered, "route-a", ctx, {
			reason: "retry",
			failed: {
				model: { provider: "zhipu", id: "removed-model" } as unknown as Model,
				thinkingLevel: "off",
				message: { stopReason: "error" } as unknown as AssistantMessage,
			},
		})
		expect(result.modelId).toBe("glm") // 正常选择：配置序首个候选
	})

	it("候选端点全部不可解析（悬空端点）→ 闭包显式失败，错误列明端点与恢复指引（AX5 运行时半边）", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const emptyCtx = {
			modelRegistry: { find: vi.fn(() => undefined) },
		} as unknown as ExtensionContext
		expect(() => routeVia(registered, "route-a", emptyCtx)).toThrow(/不在当前模型目录/)
	})

	it("retry 透传边界：failed 端点在配置内但目录不可解析（链中路过 provider 被删）→ 落正常选择", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const partialCtx = {
			// zhipu/glm 已不在目录（provider 被删）；opencode-go/zai-glm 仍在
			modelRegistry: { find: vi.fn((provider: string, modelId: string) =>
				(provider === "opencode-go" && modelId === "zai-glm"
					? PHYSICAL_MODELS.find(m => m.provider === provider && m.id === modelId)
					: undefined) as unknown as Model) },
		} as unknown as ExtensionContext
		const result = routeVia(registered, "route-a", partialCtx, {
			reason: "retry",
			failed: {
				model: { provider: "zhipu", id: "glm" } as unknown as Model,
				thinkingLevel: "off",
				message: { stopReason: "error" } as unknown as AssistantMessage,
			},
		})
		expect(result.modelId).toBe("zai-glm") // 透传目标不可解析 → 正常选择落到下一个候选
	})

	it("预算读取边界：retry.enabled=true 且 maxRetries=0（显式零容限）→ 终局 error 即 burnt", () => {
		writeConfig([ROUTE_A], T1)
		const base = createMockPi()
		const pi = {
			...base.pi,
			getSettings: vi.fn(() => ({ retry: { enabled: true, maxRetries: 0, baseDelayMs: 2000 } })),
		} as unknown as ExtensionAPI
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		const result = routeVia(base.registered, "route-a", ctx, {
			reason: "user",
			messages: [{ role: "assistant", provider: "zhipu", model: "glm", stopReason: "error" } as unknown as Message],
		})
		expect(result.modelId).toBe("zai-glm")
		expect(result.state).toEqual({ burnt: ["zhipu/glm"] })
	})

	// ── 修剪修复（P2）：retry 落到正常选择时，被消耗的重试预算记在被选中端点头上 ──────

	it("修剪修复 P2：失败端点已不在配置（链中改配置）→ 正常选择接替的那次重试也计数，预算不漏记", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		const failedRemoved = {
			model: { provider: "zhipu", id: "removed-model" } as unknown as Model,
			thinkingLevel: "off",
			message: { stopReason: "error" } as unknown as AssistantMessage,
		}
		// 链中配置把 m1 改指向别的模型：第一次 retry 的 failed 不在配置 → 落正常选择（选中 glm）
		expect(routeVia(registered, "route-a", ctx, { reason: "retry", failed: failedRemoved }).modelId).toBe("glm")
		// 后续两次 retry 走透传（failed = glm ∈ 配置）——合计 3 次链内计数
		const failedGlm = {
			model: { provider: "zhipu", id: "glm" } as unknown as Model,
			thinkingLevel: "off",
			message: { stopReason: "error" } as unknown as AssistantMessage,
		}
		expect(routeVia(registered, "route-a", ctx, { reason: "retry", failed: failedGlm }).modelId).toBe("glm")
		expect(routeVia(registered, "route-a", ctx, { reason: "retry", failed: failedGlm }).modelId).toBe("glm")
		// 终局失败后的下一轮：计数 3 ≥ maxRetries 3 → burnt failover（修复前漏记首次 → 计数 2 → 误判 fail-fast）
		const afterFailure = routeVia(registered, "route-a", ctx, {
			reason: "user",
			messages: [{ role: "assistant", provider: "zhipu", model: "glm", stopReason: "error" } as unknown as Message],
		})
		expect(afterFailure.modelId).toBe("zai-glm")
		expect(afterFailure.state).toEqual({ burnt: ["zhipu/glm"] })
	})

	// ── 修剪修复（P4）：state 写回裁剪到当前配置成员（手改/fork 注入的 ref 不放大携带） ──

	it("修剪修复 P4：写回前 burnt 裁剪到配置成员——非配置 ref 不随 burn 写回放大携带", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		// 入参 state 含手改注入的非配置 ref（ghost/evil）与合法 ref
		const result = routeVia(registered, "route-a", ctx, {
			reason: "user",
			state: { burnt: ["ghost/evil", "zhipu/glm"] },
			messages: [{ role: "assistant", provider: "zhipu", model: "glm", stopReason: "error" } as unknown as Message],
		})
		// burn 已发生（入参即 burnt）→ 集合变化来自 ghost 裁剪 → 写回只含配置成员
		expect(result.modelId).toBe("zai-glm")
		expect(result.state).toEqual({ burnt: ["zhipu/glm"] })
	})

	it("修剪修复 P4（无裁剪不写盘）：入参 state 全为配置成员且无 burn 变化 → 不落 state", () => {
		writeConfig([ROUTE_A], T1)
		const { pi, registered } = createMockPi()
		providerAggregationFactory(pi, { configPath })
		const ctx = createMockCtx()
		const result = routeVia(registered, "route-a", ctx, {
			reason: "user",
			state: { burnt: ["zhipu/glm"] },
		})
		expect(result.modelId).toBe("zai-glm") // 软避让仍生效
		expect(result.state).toBeUndefined() // 无变化——引用纪律守住，不刷条目
	})
})

/** 取 mock ctx 里 modelRegistry.find 的全部调用参数（物理模型解析轨迹断言用）。 */
function findSpyCalls(ctx: ExtensionContext): Array<[string, string]> {
	return (ctx.modelRegistry.find as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>
}
