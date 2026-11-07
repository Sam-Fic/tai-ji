/**
 * 额度求值接线测试（D3/SC5 M2 增量；V3 单测半边）。
 *
 * 覆盖断言：quota-cache.json 种子 → route 求值消费（种子 pct = 缓存已用百分比口径，
 * 判定按剩余换算 100 − pct ≥ threshold，矩阵行 4）/ 剩余低于阈值 → 额度触发切换到兜底
 * 端点（矩阵行 5，V3「100 恒耗尽」单测半边）/ 数据不新鲜 → 快照不含该 provider →
 * fail-open（矩阵行 6）/ resetSec 跨窗 → 同上 / 文件缺失 / 损坏 → 快照空 fail-open /
 * mtime 门（同签名不重读——内容变 mtime 未变时旧快照继续生效）/ pct 非有限数值
 * （null=无限）→ 未知 fail-open。
 *
 * 形态（TEST-STRATEGY 三档判据）：真实 fs 限 os.tmpdir() 白名单内 mkdtemp 自建自删；
 * mtime 用 utimesSync 显式错开（不依赖真实时钟精度），求值墙钟用 fake timers 固定；
 * pi 侧用 mock（无真子进程）。全同步无等待窗口。
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionVirtualModel, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { AGGREGATION_PROVIDER_ID, AGGREGATION_QUOTA_FRESHNESS_MS } from "@taiji/shared";

import providerAggregationFactory from "../index.ts";

// ── fixture ──────────────────────────────────────────────────────────────────

/** 固定求值墙钟（fake timers 锚点；种子 lastFetchAt 相对该值推算新鲜度）。 */
const NOW = new Date(2026, 10, 2, 10, 0, 0)

/** 显式错开的 mtime 序列（确定性驱动 mtime 门，不依赖真实时钟精度）。 */
const [T1, T2, T3] = [1_000_001, 2_000_002, 3_000_003]

const PROVIDER = "zhipu"

const ROUTE = {
	id: "quota-route",
	name: "Quota Route",
	modelId: "quota-route",
	enabled: true,
	mode: "advanced",
	members: [
		{ id: "ep-a", providerId: PROVIDER, modelId: "glm", type: "quota", quota: { thresholdPercent: 80 } },
		{ id: "ep-b", providerId: "opencode-go", modelId: "zai-glm", type: "none" },
	],
	specials: [],
} as const

/** 端点物理模型（route 命中后的返回目标）。 */
const PHYSICAL_MODELS: Array<{ provider: string, id: string }> = [
	{ provider: PROVIDER, id: "glm" },
	{ provider: "opencode-go", id: "zai-glm" },
]

/** quota-cache.json 种子形态（与 runtime QuotaCache 磁盘形态一致——quota-cache-reader.ts 镜像）。 */
function quotaSeed(percent: number, lastFetchAt: number, resetSecs: Array<number | null> = [null, null, null]): string {
	return JSON.stringify({
		providers: {
			[PROVIDER]: {
				data: { label: "seed", wins: resetSecs.map(resetSec => ({ pct: percent, resetSec })) },
				lastFetchAt,
			},
		},
	})
}

function createMockPi() {
	const registered = new Map<string, ExtensionVirtualModel>()
	const pi = {
		registerVirtualModel: vi.fn((model: ExtensionVirtualModel) => {
			registered.set(`${model.provider}/${model.id}`, model)
		}),
		unregisterVirtualModel: vi.fn(),
		on: vi.fn(),
		appendEntry: vi.fn(),
	}
	return { pi: pi as unknown as ExtensionAPI, registered }
}

function createMockCtx(): ExtensionContext {
	return {
		modelRegistry: {
			find: vi.fn((provider: string, modelId: string) =>
				PHYSICAL_MODELS.find(m => m.provider === provider && m.id === modelId) as unknown as Model | undefined),
		},
	} as unknown as ExtensionContext
}

function routeRequest(): ModelRouteRequest {
	return {
		model: { provider: AGGREGATION_PROVIDER_ID, id: ROUTE.id } as unknown as Model,
		thinkingLevel: "off",
		reason: "user",
		messages: [],
	}
}

// ── 装置 ─────────────────────────────────────────────────────────────────────

let tmpDir: string
let configPath: string
let quotaCachePath: string

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "provider-aggregation-quota-test-"))
	configPath = join(tmpDir, "providers.json")
	quotaCachePath = join(tmpDir, "quota-cache.json")
	vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function writeConfig(routes: ReadonlyArray<unknown>, mtimeMs: number): void {
	writeFileSync(configPath, JSON.stringify({ version: 1, routes: { version: 1, routes } }), "utf8")
	utimesSync(configPath, new Date(mtimeMs), new Date(mtimeMs))
}

function writeQuotaCache(content: string, mtimeMs: number): void {
	writeFileSync(quotaCachePath, content, "utf8")
	utimesSync(quotaCachePath, new Date(mtimeMs), new Date(mtimeMs))
}

/** 求值 route 闭包（命中端点的物理模型 id）。 */
function routeVia(registered: Map<string, ExtensionVirtualModel>, ctx: ExtensionContext): string {
	const definition = registered.get(`${AGGREGATION_PROVIDER_ID}/${ROUTE.id}`)
	expect(definition).toBeDefined()
	const result = definition?.route(routeRequest(), ctx)
	if (result instanceof Promise) throw new Error("route closure must be synchronous for this fixture")
	return result.model.id
}

/** 装配扩展（config routes + quotaCachePath 注入）。 */
function setup(): Map<string, ExtensionVirtualModel> {
	writeConfig([ROUTE], T1)
	const { pi, registered } = createMockPi()
	providerAggregationFactory(pi, { configPath, quotaCachePath })
	return registered
}

// ── 接线断言 ─────────────────────────────────────────────────────────────────

describe("额度快照接线（D3/SC5 M2）", () => {
	it("新鲜种子（pct=20 即剩余 80）+ 阈值 80 → 剩余换算 ≥ threshold 判满足，命中额度端点（矩阵行 4）", () => {
		const registered = setup()
		writeQuotaCache(quotaSeed(20, NOW.getTime() - 1_000), T1)
		expect(routeVia(registered, createMockCtx())).toBe("glm")
	})

	it("剩余 80 < 阈值 100 → 额度端点落选切换兜底端点（矩阵行 5，V3 恒耗尽技巧单测半边）", () => {
		const registered = setup()
		writeQuotaCache(quotaSeed(20, NOW.getTime() - 1_000), T1)
		const ctx = createMockCtx()
		expect(routeVia(registered, ctx)).toBe("glm")
		// 编辑阈值 100（mtime 错开）：下一请求按新定义求值 → 剩余 80 < 100 落选 → 兜底 ep-b
		writeConfig([{ ...ROUTE, members: [{ id: "ep-a", providerId: PROVIDER, modelId: "glm", type: "quota", quota: { thresholdPercent: 100 } }, { id: "ep-b", providerId: "opencode-go", modelId: "zai-glm", type: "none" }] }], T2)
		expect(routeVia(registered, ctx)).toBe("zai-glm")
	})

	it("数据不新鲜（超 AGGREGATION_QUOTA_FRESHNESS_MS）→ 快照不含该 provider → fail-open 命中（矩阵行 6）", () => {
		const registered = setup()
		writeQuotaCache(quotaSeed(90, NOW.getTime() - AGGREGATION_QUOTA_FRESHNESS_MS - 1), T1)
		// 已用 90 → 剩余 10 < 阈值 80（若数据新鲜会落选），但数据过期判未知 → 该端点不因额度落选
		expect(routeVia(registered, createMockCtx())).toBe("glm")
	})

	it("resetSec 跨窗（重置点已过）→ 快照判未知 → fail-open 命中（RL3 联合判定）", () => {
		const registered = setup()
		// lastFetchAt 60s 前（仍在 600s 新鲜窗内），resetSec=30 → 重置点（取数后 30s）已过
		// → 快照描述已结束周期的余量 → 判未知（pct=90 若新鲜会按剩余 10 < 80 落选）
		writeQuotaCache(quotaSeed(90, NOW.getTime() - 60_000, [30, null, null]), T1)
		expect(routeVia(registered, createMockCtx())).toBe("glm")
	})

	it("文件缺失 → 快照空 → fail-open 命中（fail-open 语义保持）", () => {
		const registered = setup()
		expect(routeVia(registered, createMockCtx())).toBe("glm")
	})

	it("文件损坏（非 JSON）→ 快照空 fail-open + warn 呈报一次（签名消费不重复报）", () => {
		const registered = setup()
		const warnSpy = vi.spyOn(getLogger("provider-aggregation"), "warn")
		writeQuotaCache("this is not json {", T1)
		const ctx = createMockCtx()
		expect(routeVia(registered, ctx)).toBe("glm")
		expect(routeVia(registered, ctx)).toBe("glm")
		const quotaWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes("quota cache"))
		expect(quotaWarns).toHaveLength(1)
	})

	it("mtime 门：内容变而 mtime 未变 → 不重读，上一快照继续生效（SI3 信号与目标同源）", () => {
		const registered = setup()
		writeQuotaCache(quotaSeed(20, NOW.getTime() - 1_000), T1)
		const ctx = createMockCtx()
		expect(routeVia(registered, ctx)).toBe("glm")
		// 覆写内容（pct 90 即剩余 10，若重读会落选）但 mtime 拨回 T1——写侧原子写必然更新
		// mtime，此形态只在测试里构造：门未触发 = 不重读 = 快照仍是 pct 20 → 继续命中 ep-a。
		writeQuotaCache(quotaSeed(90, NOW.getTime() - 1_000), T1)
		expect(routeVia(registered, ctx)).toBe("glm")
		// mtime 真变化（T3）→ 重读 pct 90（剩余 10 < 80）→ 落选切兜底
		writeQuotaCache(quotaSeed(90, NOW.getTime() - 1_000), T3)
		expect(routeVia(registered, ctx)).toBe("zai-glm")
	})

	it("pct 非有限数值（null = 无限/未订阅）→ 不投影 = 未知 fail-open 命中", () => {
		const registered = setup()
		writeFileSync(quotaCachePath, JSON.stringify({
			providers: { [PROVIDER]: { data: { label: "seed", wins: [{ pct: null, resetSec: null }] }, lastFetchAt: NOW.getTime() - 1_000 } },
		}), "utf8")
		utimesSync(quotaCachePath, new Date(T1), new Date(T1))
		expect(routeVia(registered, createMockCtx())).toBe("glm")
	})
})
