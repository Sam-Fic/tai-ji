import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// mock pi SDK：接管路径的单测不触网（same-mode 输入链 + cross-mode 原生组装都替换）。
// importOriginal 保留真实模块（含 pure.js 依赖的 estimateTokens），其余覆盖项在后
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	buildSessionContext: (entries: unknown[]) => ({ messages: [{ role: "user", content: "history" }] }),
	convertToLlm: (messages: unknown[]) => messages,
	compact: vi.fn(),
}));
vi.mock("../llm.js", () => ({
	callSameModelCompaction: vi.fn(),
	projectTools: (tools: unknown[]) => tools.map((t) => ({ name: (t as { name: string }).name })),
}));
// 配置加载覆写（U5 工具端到端用例经 index.ts 缺省 gatingProbe 消费本函数——真实实现读
// agentDir 磁盘配置，测试必须确定且不触真实数据目录）：其余纯函数保持实装
vi.mock("../pure.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../pure.js")>();
	return {
		...actual,
		loadSmartContextConfig: vi.fn(() => actual.normalizeSmartContextConfig({})),
	};
});

import { compact as nativeCompact, buildContextEntries, buildSessionProjection, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import { callSameModelCompaction } from "../llm.js";
import {
	buildBackgroundPreparation,
	createBackgroundCompactionManager,
	createBackgroundCompactionState,
	createBeforeCompactHandler,
	createTakeoverState,
	isAutoCompactTriggered,
	persistBackgroundCompaction,
	validateBackgroundPersist,
	type AfterGenerationHook,
	type BackgroundCompactionState,
	type BackgroundTaskSettlement,
	type BackgroundTaskSnapshot,
} from "../compact-handler.js";
import smartContextExtension from "../index.js";
import { normalizeSmartContextConfig, type SmartContextConfig } from "../pure.js";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

// assistant 消息形态锁定为单 text 块：必填标量字段补齐 + content 不得追加 thinking/toolCall
// 块——追加会抬高 shadowedTokens（收缩校验分母），使「新旧口径数值等价」断言静默失效
function makeEvent(overrides?: Partial<SessionBeforeCompactEvent["preparation"]>): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: [
				{ role: "user", content: "x".repeat(4_000), timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "text", text: "y".repeat(4_000) }],
					api: "openai-completions",
					provider: "zai",
					model: "glm",
					usage: {
						input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
			],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 500_000,
			fileOps: { read: new Set(["/a.ts"]), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			...overrides,
		},
		branchEntries: [],
		customInstructions: undefined,
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	};
}

function makeCtx(crossModel?: { provider: string; id: string } | null): ExtensionContext {
	return {
		model: { provider: "zai", id: "glm" },
		getSystemPrompt: () => "sys",
		sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
			// resolveRef 精确匹配：仅 (provider,id) 同时命中时返回模型（配合 hasConfiguredAuth 放行）
			find: (provider: string, id: string) =>
				crossModel && provider === crossModel.provider && id === crossModel.id ? crossModel : null,
			hasConfiguredAuth: () => crossModel != null,
		},
	} as unknown as ExtensionContext;
}

function makePi(): ExtensionAPI {
	return { getAllTools: () => [] } as unknown as ExtensionAPI;
}

const mockedCall = vi.mocked(callSameModelCompaction);
const mockedNative = vi.mocked(nativeCompact);

function makeHandler(config: SmartContextConfig) {
	const state = createTakeoverState();
	const handler = createBeforeCompactHandler(makePi(), () => state, () => config);
	return { handler, state };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("session_before_compact 接管 handler", () => {
	it("门控未放行（disabled / 排除命中）→ 空返回（pi 原生生成）", async () => {
		const disabled = makeHandler(normalizeSmartContextConfig({ enabled: false }));
		await expect(disabled.handler(makeEvent(), makeCtx())).resolves.toEqual({});

		const excluded = makeHandler(
			normalizeSmartContextConfig({ excludedModels: ["zai/glm"] }),
		);
		await expect(excluded.handler(makeEvent(), makeCtx())).resolves.toEqual({});
		expect(mockedCall).not.toHaveBeenCalled();
	});

	it("same-model 成功 → compaction 带 engine/mode/model 标记 + preamble + fileOps 清单 + transcript 指针", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "summary body", usage: { input: 1, output: 2 } });
		const { handler } = makeHandler(normalizeSmartContextConfig({ compactModel: { type: "ref", ref: "" } }));
		const decision = await handler(makeEvent(), makeCtx());
		// details.model = `${ctx.model.provider}/${ctx.model.id}`（用量页 compaction 归属数据源，pi-semantics PS-28）
		expect(decision.compaction?.details).toEqual({ engine: "smart-context", mode: "same-model", model: "zai/glm" });
		expect(decision.compaction?.summary).toContain("summary body");
		// D13-9 preamble 在最前；D11-2 fileOps；D13-4 transcript
		expect(decision.compaction?.summary.startsWith("This is an automatically generated checkpoint")).toBe(true);
		expect(decision.compaction?.summary).toContain("<read-files>");
		expect(decision.compaction?.summary).toContain("/tmp/s1.jsonl");
		// cache-key 一致性：调用参数含 systemPrompt + tools（mock 收到的 options）
		expect(mockedCall.mock.calls[0][1].systemPrompt).toBe("sys");
	});

	it("max-tokens 截断 fail-closed（D13-2）→ 空返回 + failStreak +1", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "half...", stopReason: "length" });
		const { handler, state } = makeHandler(normalizeSmartContextConfig({}));
		await expect(handler(makeEvent(), makeCtx())).resolves.toEqual({});
		expect(state.failStreak).toBe(1);
	});

	it("cross-model：resolveModel 不可用 → 空返回（D7 回退）", async () => {
		const { handler } = makeHandler(
			normalizeSmartContextConfig({ compactModel: { type: "ref", ref: "xiaomi/mimo" } }),
		);
		// modelRegistry.find 未命中 mimo → resolveModel 返回 null → generateCrossMode D7 静默回退
		const ctx = makeCtx();
		await expect(handler(makeEvent(), ctx)).resolves.toEqual({});
		expect(mockedNative).not.toHaveBeenCalled();
	});

	it("cross-model 成功 → details.model=compactModel 解析结果，native details 字段保留", async () => {
		mockedNative.mockResolvedValue({
			summary: "native checkpoint",
			firstKeptEntryId: "kept-1",
			tokensBefore: 500_000,
			usage: {
				input: 5, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			details: { nativeMarker: "keep" },
		});
		const { handler } = makeHandler(
			normalizeSmartContextConfig({ compactModel: { type: "ref", ref: "xiaomi/mimo" } }),
		);
		const decision = await handler(makeEvent(), makeCtx({ provider: "xiaomi", id: "mimo" }));
		// details.model = `${resolveModel(...).provider}/${id}`（用量页 compaction 归属数据源，pi-semantics PS-28）；native details 字段原样保留（spread 增量，不改变其他字段）
		expect(decision.compaction?.details).toEqual({
			engine: "smart-context",
			mode: "cross-model",
			model: "xiaomi/mimo",
			nativeMarker: "keep",
		});
		// nativeCompact 收到的 model 就是解析结果（details.model 与实际执行模型同源）
		expect(mockedNative.mock.calls[0][1]).toEqual({ provider: "xiaomi", id: "mimo" });
	});

	it("收缩校验失败（摘要 ≥ 被压段）→ 拒绝 + 同段记录不重试（D13-1）", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "z".repeat(10_000) });
		const { handler, state } = makeHandler(normalizeSmartContextConfig({}));
		const event = makeEvent({ messagesToSummarize: [{ role: "user", content: "x".repeat(400), timestamp: 0 }] });
		await expect(handler(event, makeCtx())).resolves.toEqual({});
		expect(state.inflatedSegments.has("kept-1")).toBe(true);
		// 同段第二次直接跳过（不再调 LLM）
		mockedCall.mockClear();
		await expect(handler(event, makeCtx())).resolves.toEqual({});
		expect(mockedCall).not.toHaveBeenCalled();
	});

	it("连续失败 3 次熔断（D13-3）→ 第 4 次起直接空返回", async () => {
		mockedCall.mockResolvedValue({ ok: false, text: "", error: "boom" });
		const { handler, state } = makeHandler(normalizeSmartContextConfig({}));
		for (let i = 0; i < 3; i++) {
			await expect(handler(makeEvent(), makeCtx())).resolves.toEqual({});
		}
		expect(state.failStreak).toBe(3);
		mockedCall.mockClear();
		await expect(handler(makeEvent(), makeCtx())).resolves.toEqual({});
		expect(mockedCall).not.toHaveBeenCalled(); // 熔断后不再尝试
	});
});

// ──────────────────────── U2：后台压缩任务管理（组装对照 / RL1 / 触发线） ────────────────────────

/** 大文本（每条约 7.5K tokens@chars/4）：驱动 findCutPoint 在 20000 保留预算内落点可控。 */
const BIG = "x".repeat(30_000);

function makeUserEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: text, timestamp: 0 },
	} as SessionEntry;
}

function makeAssistantEntry(
	id: string,
	parentId: string | null,
	text: string,
	toolCall?: { name: string; path: string },
): SessionEntry {
	const content: Array<Record<string, unknown>> = [{ type: "text", text }];
	if (toolCall) content.push({ type: "toolCall", id: `${id}-tc`, name: toolCall.name, arguments: { path: toolCall.path } });
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "zai",
			model: "glm",
			usage: {
				input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	} as SessionEntry;
}

function makeCompactionEntry(
	id: string,
	parentId: string | null,
	firstKeptEntryId: string,
	details?: { readFiles: string[]; modifiedFiles: string[] },
): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		summary: "PREV SUMMARY",
		firstKeptEntryId,
		tokensBefore: 123,
		...(details ? { details } : {}),
	} as SessionEntry;
}

/** 样例 A（无 compaction）：3 轮对话，第 1 轮含 read 工具调用；切点预期落在第 3 轮 user（e3）。 */
function sampleEntriesNoCompaction(): SessionEntry[] {
	const e1 = makeUserEntry("e1", null, BIG);
	const e2 = makeAssistantEntry("e2", "e1", BIG, { name: "read", path: "/a.ts" });
	const e3 = makeUserEntry("e3", "e2", BIG);
	const e4 = makeAssistantEntry("e4", "e3", BIG);
	const e5 = makeUserEntry("e5", "e4", BIG);
	return [e1, e2, e3, e4, e5];
}

/** 样例 B（既有 compaction entry）：PREV(c0) → k1..k4；切点预期落在 k3。 */
function sampleEntriesWithCompaction(): SessionEntry[] {
	const c0 = makeCompactionEntry("c0", null, "k1", { readFiles: ["/c.ts"], modifiedFiles: [] });
	const k1 = makeUserEntry("k1", "c0", BIG);
	const k2 = makeAssistantEntry("k2", "k1", BIG, { name: "edit", path: "/b.ts" });
	const k3 = makeUserEntry("k3", "k2", "y".repeat(60_000));
	const k4 = makeAssistantEntry("k4", "k3", "y".repeat(60_000));
	return [c0, k1, k2, k3, k4];
}

/**
 * 投影边界对照（验收①核心断言）：组装切分（摘要头 + 被压段 + turnPrefix + 保留段）与
 * buildSessionProjection 全量投影消息逐条一致（无 context_edit 场景应等价，AS4）。
 */
function expectMatchesProjection(entries: SessionEntry[], prep: NonNullable<ReturnType<typeof buildBackgroundPreparation>>): void {
	const projection = buildSessionProjection(entries);
	const contextEntries = buildContextEntries(entries);
	const keptIndex = contextEntries.findIndex((e) => e.id === prep.firstKeptEntryId);
	expect(keptIndex).toBeGreaterThan(0);
	const kept = contextEntries
		.slice(keptIndex)
		.filter((e) => e.type !== "compaction")
		.flatMap(sessionEntryToContextMessages);
	const head = contextEntries[0];
	const summaryHead = head?.type === "compaction" ? sessionEntryToContextMessages(head) : [];
	expect([...summaryHead, ...prep.messagesToSummarize, ...prep.turnPrefixMessages, ...kept])
		.toEqual(projection.messages);
}

/** U2 组装/管理器共用的 ctx：entries + usage + sessionId（appendCompaction mock 供 U3 落盘链路）。 */
function makeBgCtx(entries: SessionEntry[], usage: { tokens: number | null; contextWindow: number } | null): ExtensionContext {
	return {
		model: { provider: "zai", id: "glm" },
		getSystemPrompt: () => "sys",
		getContextUsage: () => (usage ? { ...usage, percent: null } : undefined),
		sessionManager: {
			getSessionId: () => "s1",
			getSessionFile: () => "/tmp/s1.jsonl",
			getEntries: () => entries,
			appendCompaction: vi.fn(() => "entry-persisted"),
		},
		modelRegistry: {},
	} as unknown as ExtensionContext;
}

/** 取 ctx.sessionManager 上的 appendCompaction mock（运行时形状，类型声明层不可见——AS1）。 */
function getAppendMock(ctx: ExtensionContext): Mock {
	return (ctx.sessionManager as unknown as { appendCompaction: Mock }).appendCompaction;
}

function makeBgManager(
	bgState: BackgroundCompactionState,
	config: SmartContextConfig,
	afterGeneration?: AfterGenerationHook,
	getInflatedSegments?: () => ReadonlySet<string>,
	onSettled?: (settlement: BackgroundTaskSettlement) => void,
	isCtxStale?: () => boolean,
) {
	const manager = createBackgroundCompactionManager(
		makePi(),
		() => bgState,
		() => config,
		afterGeneration,
		getInflatedSegments,
		onSettled,
		isCtxStale,
	);
	return manager;
}

/** 默认触发行情（200k 窗口 95% > 0.9 线）。 */
const TRIGGER_USAGE = { tokens: 190_000, contextWindow: 200_000 };
const BELOW_USAGE = { tokens: 100_000, contextWindow: 200_000 };

/** 生成期挂起控制器：mock callSameModelCompaction 挂起直到 release。返回同一对象引用（release 后续赋值可见）。 */
function holdGeneration(): { release: (ok: boolean) => void } {
	const handle = {
		release: (_ok: boolean) => {
			throw new Error("release called before generation started");
		},
	};
	mockedCall.mockImplementation(
		() =>
			new Promise<{ ok: boolean; text: string; usage: { input: number; output: number } }>((resolve) => {
				handle.release = (ok) => resolve({ ok, text: "bg summary", usage: { input: 1, output: 2 } });
			}),
	);
	return handle;
}

describe("后台压缩准备数据组装（U2 验收①：buildContextEntries 投影边界对照）", () => {
	it("样例 A（无 compaction）：切点=第 3 轮 user、非 split-turn、被压段=[e1,e2]、fileOps 收 read、settings=默认常量", () => {
		const entries = sampleEntriesNoCompaction();
		const ctx = makeBgCtx(entries, TRIGGER_USAGE);
		const prep = buildBackgroundPreparation(ctx);
		expect(prep).toBeDefined();
		// findCutPoint：倒序累计到 e2 越过 20000 预算 → 切在 e3（user，轮首）→ 非分轮
		expect(prep!.firstKeptEntryId).toBe("e3");
		expect(prep!.isSplitTurn).toBe(false);
		expect(prep!.turnPrefixMessages).toEqual([]);
		expect(prep!.messagesToSummarize.map((m) => m.role)).toEqual(["user", "assistant"]);
		// fileOps：e2 的 toolCall read /a.ts
		expect([...prep!.fileOps.read]).toEqual(["/a.ts"]);
		// tokensBefore = ctx.getContextUsage() 口径（AS4 登记差异）
		expect(prep!.tokensBefore).toBe(TRIGGER_USAGE.tokens);
		// settings = DEFAULT_COMPACTION_SETTINGS 快照（AS10：无设置读取通道）
		expect(prep!.settings).toEqual({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 });
		expectMatchesProjection(entries, prep!);
	});

	it("样例 B（既有 compaction entry）：previousSummary 取最新一份、被压段不混入旧摘要、fileOps 合并 prev details", () => {
		const entries = sampleEntriesWithCompaction();
		const ctx = makeBgCtx(entries, TRIGGER_USAGE);
		const prep = buildBackgroundPreparation(ctx);
		expect(prep).toBeDefined();
		expect(prep!.previousSummary).toBe("PREV SUMMARY");
		expect(prep!.firstKeptEntryId).toBe("k3");
		// 被压段 = 保留段之前的活动条目（k1,k2）——旧 compaction 摘要不混入
		expect(prep!.messagesToSummarize.map((m) => m.role)).toEqual(["user", "assistant"]);
		// fileOps：prev details（pi 原生，非 fromHook）read /c.ts + k2 edit /b.ts
		expect([...prep!.fileOps.read]).toContain("/c.ts");
		expect([...prep!.fileOps.edited]).toContain("/b.ts");
		expectMatchesProjection(entries, prep!);
	});

	it("不可压场景：全量在保留预算内 / 末条是 compaction → undefined（不触发）", () => {
		const small = [
			makeUserEntry("s1", null, "hi"),
			makeAssistantEntry("s2", "s1", "hello"),
		];
		expect(buildBackgroundPreparation(makeBgCtx(small, TRIGGER_USAGE))).toBeUndefined();

		const justCompacted = [makeCompactionEntry("c9", null, "c9")];
		expect(buildBackgroundPreparation(makeBgCtx(justCompacted, TRIGGER_USAGE))).toBeUndefined();
	});

	it("system message 剔除（pi compaction.js:50-53 同款）：被压段混入 system 不进摘要输入", () => {
		// system message 条目真实产生（agent-session system prompt sections 变化时落盘）；
		// pi 原生 getMessagesFromProjectedEntryForCompaction 剔除 system role（prompt 状态非
		// 对话内容，compaction entry 的 systemMessage 承载其回放）。本用例锁定扩展组装同款
		// 剔除：无 context_edit 场景被压消息与 pi prepareCompaction 逐条一致（不混入 system）
		const sysEntry: SessionEntry = {
			type: "message",
			id: "sys1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "system", content: "SYS PROMPT STATE", timestamp: 0 },
		} as SessionEntry;
		const [e1, ...rest] = sampleEntriesNoCompaction();
		const entries = [sysEntry, { ...e1, parentId: "sys1" }, ...rest];

		const prep = buildBackgroundPreparation(makeBgCtx(entries, TRIGGER_USAGE));
		expect(prep).toBeDefined();
		// 切点不因前置 system 条目移动（保留段倒序累计阈值不变）
		expect(prep!.firstKeptEntryId).toBe("e3");
		// 被压段 = [sys1, e1, e2] → 剔除 system 后 [e1, e2]（与 pi 原生组装等价）
		expect(prep!.messagesToSummarize.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("被压段仅 system 消息 → undefined（与 pi 原生 prepareCompaction 同判无可压）", () => {
		// e2 加大（60K chars）驱动切点回退到 e1：被压段 = [sys1] 仅 system，过滤后空 →
		// 无可压返回 undefined；pi 原生 prepareCompaction 对同条目流同判（探针对照实跑）
		const sysEntry: SessionEntry = {
			type: "message",
			id: "sys1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "system", content: "SYS PROMPT STATE", timestamp: 0 },
		} as SessionEntry;
		const entries = [
			sysEntry,
			makeUserEntry("e1", "sys1", BIG),
			makeAssistantEntry("e2", "e1", "y".repeat(60_000)),
			makeUserEntry("e3", "e2", "tail"),
			makeAssistantEntry("e4", "e3", "tail"),
			makeUserEntry("e5", "e4", "tail"),
		];
		expect(buildBackgroundPreparation(makeBgCtx(entries, TRIGGER_USAGE))).toBeUndefined();
	});
});

describe("后台触发线判定（U2 验收③）", () => {
	it("0.9 默认 × 窗口百分比：压线即触发、线下一档不触发、非法入参不触发", () => {
		const config = normalizeSmartContextConfig({});
		expect(config.autoCompactThresholdRatio).toBe(0.9);
		expect(isAutoCompactTriggered(180_000, 200_000, config.autoCompactThresholdRatio)).toBe(true);
		expect(isAutoCompactTriggered(179_999, 200_000, config.autoCompactThresholdRatio)).toBe(false);
		expect(isAutoCompactTriggered(Number.NaN, 200_000, 0.9)).toBe(false);
		expect(isAutoCompactTriggered(180_000, 0, 0.9)).toBe(false);
	});

	it("manager 门控前置：disabled / 排除模型命中 → 不启动", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "s", usage: { input: 1, output: 2 } });
		const disabled = makeBgManager(createBackgroundCompactionState(), normalizeSmartContextConfig({ enabled: false }));
		expect(disabled.maybeStart(makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE))).toBe(false);

		const excluded = makeBgManager(
			createBackgroundCompactionState(),
			normalizeSmartContextConfig({ excludedModels: ["zai/glm"] }),
		);
		expect(excluded.maybeStart(makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE))).toBe(false);
		expect(mockedCall).not.toHaveBeenCalled();
	});

	it("manager 触发线：越过启动并进入「进行中」；未越过 / 用量未知不启动；收尾回空闲", async () => {
		const gen = holdGeneration();
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}));
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		expect(manager.maybeStart(ctx)).toBe(true);
		expect(bgState.active).not.toBeNull();
		expect(mockedCall).toHaveBeenCalledTimes(1);
		// 互斥（RL1）：进行中再触发不启动
		expect(manager.maybeStart(makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE))).toBe(false);
		expect(mockedCall).toHaveBeenCalledTimes(1);

		gen.release(true);
		await bgState.active?.done;
		expect(bgState.active).toBeNull();

		// 未越过触发线 / 用量未知（R7 null 窗口期）→ 不启动
		expect(manager.maybeStart(makeBgCtx(sampleEntriesNoCompaction(), BELOW_USAGE))).toBe(false);
		expect(manager.maybeStart(makeBgCtx(sampleEntriesNoCompaction(), { tokens: null, contextWindow: 200_000 }))).toBe(false);
	});
});

describe("后台事件取消与独立熔断（U2 验收②：RL1）", () => {
	it("事件取消各分支（index.ts 接线）：new/resume/fork 取消、startup/reload 不取消、shutdown/compact 取消、tree 仅告警", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const hookPi = {
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
				handlers.set(name, handler);
			},
			getAllTools: () => [],
			registerTool: vi.fn(), registerCommand: vi.fn(),
			sendMessage: vi.fn(),
			appendEntry: vi.fn(),
		} as unknown as ExtensionAPI;
		smartContextExtension(hookPi);

		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		const launched: Array<{ release: (ok: boolean) => void; signal: AbortSignal }> = [];
		// launch：agent_settled 启动一个挂起的任务（不 release——保持「进行中」供事件取消）
		const launch = (): void => {
			const gen = holdGeneration();
			handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
			const signal = mockedCall.mock.calls[mockedCall.mock.calls.length - 1][1].signal;
			expect(signal.aborted).toBe(false);
			launched.push({ release: gen.release, signal });
		};
		// drain：释放全部挂起任务并等微任务链收尾（被取消任务的 resolve 结果被放弃）
		const drain = async (): Promise<void> => {
			for (const t of launched) t.release(true);
			launched.length = 0;
			for (let i = 0; i < 6; i++) await Promise.resolve();
		};

		// 段 1：startup / reload 不取消（D3/SI4——生产中 reload 会重跑工厂使旧任务随旧闭包
		// 消亡，因此只断言「事件本身不触发 abort」）；session_tree 仅观测告警，不取消
		launch();
		handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
		handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
		handlers.get("session_tree")!({ type: "session_tree", newLeafId: "e1", oldLeafId: "e5" }, ctx);
		expect(launched[0].signal.aborted).toBe(false);

		// 段 2：session_start(new) 取消（startup/reload 重建状态容器后，agent_settled 在新
		// 容器上再启动是合法序列——此处 new 的取消作用于当前容器内的任务）
		launch();
		handlers.get("session_start")!({ type: "session_start", reason: "new" }, ctx);
		expect(launched[1].signal.aborted).toBe(true);

		// 段 3：session_start(resume) 取消
		launch();
		handlers.get("session_start")!({ type: "session_start", reason: "resume" }, ctx);
		expect(launched[2].signal.aborted).toBe(true);

		// 段 4：session_shutdown 取消
		launch();
		handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(launched[3].signal.aborted).toBe(true);

		// 段 5：session_compact 取消（其他压缩抢先落盘；后台路径自身落盘不发该事件）
		launch();
		handlers.get("session_compact")!({ type: "session_compact" }, ctx);
		expect(launched[4].signal.aborted).toBe(true);

		// 段 6：session_start(fork) 取消
		launch();
		handlers.get("session_start")!({ type: "session_start", reason: "fork" }, ctx);
		expect(launched[5].signal.aborted).toBe(true);

		await drain();
	});

	it("被抢先取消不计入熔断、结果被放弃（取消非失败，SI5）", async () => {
		const gen = holdGeneration();
		const bgState = createBackgroundCompactionState();
		const afterGen = vi.fn().mockResolvedValue("validated");
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), afterGen);
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		expect(manager.maybeStart(ctx)).toBe(true);
		const done = bgState.active?.done;
		manager.cancelActive("session_compact");
		expect(bgState.active).toBeNull();
		gen.release(true);
		await done;
		expect(bgState.failureStreak).toBe(0);
		expect(afterGen).not.toHaveBeenCalled(); // 生成结果随取消放弃，续段不执行
	});

	it("独立熔断：后台连续失败 3 次停止自动触发；与同步 failStreak 隔离；成功清零", async () => {
		const bgState = createBackgroundCompactionState();
		const takeover = createTakeoverState();
		takeover.failStreak = 3; // 同步路径已熔断——后台独立计数不受影响
		const manager = createBackgroundCompactionManager(makePi(), () => bgState, () => normalizeSmartContextConfig({}));

		mockedCall.mockResolvedValue({ ok: false, text: "", error: "boom" });
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		for (let i = 0; i < 3; i++) {
			expect(manager.maybeStart(ctx)).toBe(true);
			await bgState.active?.done;
		}
		expect(bgState.failureStreak).toBe(3);
		expect(mockedCall).toHaveBeenCalledTimes(3);
		// 第 4 次起熔断挡住（尽管同步 failStreak=3 与后台互不干扰）
		expect(manager.maybeStart(ctx)).toBe(false);
		expect(mockedCall).toHaveBeenCalledTimes(3);
		expect(takeover.failStreak).toBe(3);

		// 计数归零后恢复触发（session_start 重建闭包同口径）
		bgState.failureStreak = 0;
		mockedCall.mockResolvedValue({ ok: true, text: "s", usage: { input: 1, output: 2 } });
		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;
		expect(bgState.failureStreak).toBe(0);
	});

	it("续段回报驱动计数（U3 接口契约）：validated 清零 / inflated 递增 / dropped 不动", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "bg summary", usage: { input: 1, output: 2 } });
		const afterGen = vi.fn();
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), afterGen as unknown as AfterGenerationHook);
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		bgState.failureStreak = 2;
		afterGen.mockResolvedValue("validated");
		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;
		expect(bgState.failureStreak).toBe(0); // 成功清零

		afterGen.mockResolvedValue("inflated");
		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;
		expect(bgState.failureStreak).toBe(1); // 递增点②：收缩校验失败（U3 回报）

		afterGen.mockResolvedValue({ outcome: "dropped", reason: "preempted" });
		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;
		expect(bgState.failureStreak).toBe(1); // 会话态失效类放弃：计数不动

		// 续段收到的快照含 U3 落盘校验所需字段（sessionId / lastEntryId）
		const snapshot = afterGen.mock.calls[0][1];
		expect(snapshot.sessionId).toBe("s1");
		expect(snapshot.lastEntryId).toBe("e5");
	});

	it("异常递增（递增点③）：生成抛错 → failureStreak+1，任务回空闲", async () => {
		mockedCall.mockRejectedValue(new Error("boom"));
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}));
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;
		expect(bgState.failureStreak).toBe(1);
		expect(bgState.active).toBeNull();
	});
});

// ──────────────────────── U3：落盘兜底校验 + appendCompaction 直调 + 档位重置补偿 ────────────────────────

/** 校验器/落盘直调共用的 CompactionResult 底座（短摘要 = 不膨胀；details 为 same-model 标记）。 */
function makeCompactionResult(overrides?: Partial<CompactionResult>): CompactionResult {
	return {
		summary: "bg summary",
		firstKeptEntryId: "e3",
		tokensBefore: TRIGGER_USAGE.tokens,
		usage: { input: 1, output: 2 },
		details: { engine: "smart-context", mode: "same-model", model: "zai/glm" },
		...overrides,
	};
}

/** 校验器直测共用的快照底座（shadowedTokens=4000：摘要 ≥4000 tokens 即膨胀）。 */
function makeSnapshot(overrides?: Partial<BackgroundTaskSnapshot>): BackgroundTaskSnapshot {
	return {
		sessionId: "s1",
		lastEntryId: "e5",
		tokens: TRIGGER_USAGE.tokens,
		compactionIds: [],
		shadowedTokens: 4_000,
		...overrides,
	};
}

describe("落盘兜底校验器（U3 验收①：RL2 逐项反例 + 通过用例）", () => {
	it("通过用例：sessionId 一致 + 无未知 compaction + 摘要不膨胀 → ok", () => {
		expect(validateBackgroundPersist(makeSnapshot(), sampleEntriesNoCompaction(), "s1", makeCompactionResult()))
			.toEqual({ ok: true });
	});

	it("反例① sessionId 变更（会话已替换）→ session-mismatch", () => {
		expect(validateBackgroundPersist(makeSnapshot(), sampleEntriesNoCompaction(), "s2", makeCompactionResult()))
			.toEqual({ ok: false, reason: "session-mismatch" });
	});

	it("反例② 快照末端之后出现新 compaction entry（未知 id = 被抢先）→ preempted", () => {
		const entries = [...sampleEntriesNoCompaction(), makeCompactionEntry("c-rival", "e5", "e5")];
		expect(validateBackgroundPersist(makeSnapshot(), entries, "s1", makeCompactionResult()))
			.toEqual({ ok: false, reason: "preempted" });
	});

	it("通过② 既有 compaction（快照已知 id 集合内）不误判被抢先", () => {
		const entries = sampleEntriesWithCompaction(); // 含 c0（触发时刻已在 branch 上）
		const snapshot = makeSnapshot({ lastEntryId: "k4", compactionIds: ["c0"] });
		expect(validateBackgroundPersist(snapshot, entries, "s1", makeCompactionResult()))
			.toEqual({ ok: true });
	});

	it("通过②b 回退丢弃锚点（session_tree 落盘侧断言）：锚点不在当前 branch、无新 compaction → 落盘放行（V4：回退不取消）", () => {
		// 回退后 branch = [e1, n1]：锚点 e5 已被丢弃（不在 entries 中），且无抢先 compaction
		const entriesAfterRollback = [makeUserEntry("e1", null, BIG), makeUserEntry("n1", "e1", "continue")];
		expect(validateBackgroundPersist(makeSnapshot(), entriesAfterRollback, "s1", makeCompactionResult()))
			.toEqual({ ok: true });
	});

	it("反例②b 回退后新分支被抢先压缩（未知 id）→ preempted（防错位 entry 落盘，AX3）", () => {
		const entriesAfterRollback = [
			makeUserEntry("e1", null, BIG),
			makeCompactionEntry("c-other", "e1", "e1"),
		];
		expect(validateBackgroundPersist(makeSnapshot(), entriesAfterRollback, "s1", makeCompactionResult()))
			.toEqual({ ok: false, reason: "preempted" });
	});

	it("反例③ 摘要膨胀（摘要 token ≥ 被压段，SI6）→ summary-inflated", () => {
		const inflated = makeCompactionResult({ summary: "z".repeat(20_000) }); // 20000 chars → 5000 tokens ≥ 4000
		expect(validateBackgroundPersist(makeSnapshot(), sampleEntriesNoCompaction(), "s1", inflated))
			.toEqual({ ok: false, reason: "summary-inflated" });
	});

	it("通过③ 摘要略小于被压段 → ok（收缩校验放行）", () => {
		const compactEnough = makeCompactionResult({ summary: "y".repeat(8_000) }); // 2000 tokens < 4000
		expect(validateBackgroundPersist(makeSnapshot(), sampleEntriesNoCompaction(), "s1", compactEnough))
			.toEqual({ ok: true });
	});
});

describe("appendCompaction 直调链路（U3 验收②③：RL3 存在性探测 + D6 档位重置）", () => {
	it("落盘成功：参数口径与 pi 原生一致（fromHook=true、usage/details 透传）、onPersisted 回调、validated 清零", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "bg summary", usage: { input: 3, output: 4 } });
		const bgState = createBackgroundCompactionState();
		const onPersisted = vi.fn();
		const hook: AfterGenerationHook = (result, snapshot, ctx) =>
			persistBackgroundCompaction(ctx, result, snapshot, { onPersisted });
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), hook);
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		expect(manager.maybeStart(ctx)).toBe(true);
		expect(getAppendMock(ctx)).not.toHaveBeenCalled(); // 生成完成前不落盘
		await bgState.active?.done;

		expect(getAppendMock(ctx)).toHaveBeenCalledTimes(1);
		const [summary, firstKept, tokensBefore, details, fromHook, usage] = getAppendMock(ctx).mock.calls[0];
		expect(firstKept).toBe("e3"); // 样例 A 切点（快照范围落 entry）
		expect(summary).toContain("bg summary");
		expect(tokensBefore).toBe(TRIGGER_USAGE.tokens); // preparation.tokensBefore = getContextUsage() 口径
		expect(details).toEqual({ engine: "smart-context", mode: "same-model", model: "zai/glm" });
		expect(fromHook).toBe(true); // 与同步接管路径落盘口径一致
		expect(usage).toEqual({ input: 3, output: 4 }); // usage 随 entry 写入（D6 用量归因消费侧照读）
		expect(onPersisted).toHaveBeenCalledTimes(1); // D6 档位重置补偿回调
		// C1：onPersisted 携带落盘 entry id（接线层组装落盘信号的 compactionId 数据源）
		expect(onPersisted).toHaveBeenCalledWith("entry-persisted");
		expect(bgState.failureStreak).toBe(0); // validated 清零
		expect(bgState.active).toBeNull();
	});

	it("RL3 前置探测：appendCompaction 缺失 → 不启动任务（生成费用零浪费）", () => {
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}));
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		delete (ctx.sessionManager as { appendCompaction?: unknown }).appendCompaction;
		expect(manager.maybeStart(ctx)).toBe(false);
		expect(mockedCall).not.toHaveBeenCalled();
		expect(bgState.active).toBeNull();
	});

	it("RL3 落盘侧探测：appendCompaction 缺失 → 放弃落盘、不抛错（dropped/persist-unavailable），补偿回调不触发", async () => {
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		delete (ctx.sessionManager as { appendCompaction?: unknown }).appendCompaction;
		const onPersisted = vi.fn();
		const outcome = await persistBackgroundCompaction(ctx, makeCompactionResult(), makeSnapshot(), { onPersisted });
		expect(outcome).toEqual({ outcome: "dropped", reason: "persist-unavailable" });
		expect(onPersisted).not.toHaveBeenCalled();
	});

	it("校验① session-mismatch（落盘侧链路）：触发后 sessionId 已换 → dropped 且 reason 原样透传", async () => {
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		const onPersisted = vi.fn();
		const outcome = await persistBackgroundCompaction(
			ctx,
			makeCompactionResult(),
			// 触发时刻快照属旧会话（s-old），落盘时 ctx 已是 s1 → 校验① 放弃
			makeSnapshot({ sessionId: "s-old" }),
			{ onPersisted },
		);
		expect(outcome).toEqual({ outcome: "dropped", reason: "session-mismatch" });
		expect(getAppendMock(ctx)).not.toHaveBeenCalled();
		expect(onPersisted).not.toHaveBeenCalled();
	});

	it("被抢先（校验②链路）：落盘前出现新 compaction → 放弃，appendCompaction 不调、档位不重置、计数不动；settlement 透传 preempted", async () => {
		const entries = sampleEntriesNoCompaction();
		const bgState = createBackgroundCompactionState();
		const onPersisted = vi.fn();
		const onSettled = vi.fn();
		const hook: AfterGenerationHook = (result, snapshot, ctx) =>
			persistBackgroundCompaction(ctx, result, snapshot, { onPersisted });
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), hook, undefined, onSettled);
		const ctx = makeBgCtx(entries, TRIGGER_USAGE);
		mockedCall.mockResolvedValue({ ok: true, text: "bg summary", usage: { input: 1, output: 2 } });

		expect(manager.maybeStart(ctx)).toBe(true);
		// 生成窗口内被抢先：同步接管路径压了一条新 compaction entry（未知 id）
		entries.push(makeCompactionEntry("c-rival", "e5", "e5"));
		await bgState.active?.done;

		expect(getAppendMock(ctx)).not.toHaveBeenCalled();
		expect(onPersisted).not.toHaveBeenCalled();
		expect(bgState.failureStreak).toBe(0); // dropped：会话态失效类放弃，计数不动
		expect(bgState.active).toBeNull();
		// verdict.reason 原样传出（通知文案分派依据——preempted 下上下文已被较新压缩结果改变）
		expect(onSettled.mock.calls[0]![0]).toMatchObject({ outcome: "dropped", droppedReason: "preempted" });
	});

	it("摘要膨胀（校验③链路）：放弃落盘 + 膨胀段记录回调 + 同段不再触发（共享读取）", async () => {
		const entries = sampleEntriesNoCompaction();
		const bgState = createBackgroundCompactionState();
		const onInflated = vi.fn();
		const hook: AfterGenerationHook = (result, snapshot, ctx) =>
			persistBackgroundCompaction(ctx, result, snapshot, { onInflated });
		const manager = makeBgManager(
			bgState,
			normalizeSmartContextConfig({}),
			hook,
			// 膨胀段共享读取（模拟 index.ts 接线：读 state.takeover.inflatedSegments 同一集合）
			() => new Set(onInflated.mock.calls.map((call) => call[0] as string)),
		);
		const ctx = makeBgCtx(entries, TRIGGER_USAGE);
		// 摘要 80000 chars → 20000 tokens ≥ 被压段（两条 BIG ≈ 15000+ tokens）
		mockedCall.mockResolvedValue({ ok: true, text: "z".repeat(80_000), usage: { input: 1, output: 2 } });

		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;

		expect(getAppendMock(ctx)).not.toHaveBeenCalled();
		expect(onInflated).toHaveBeenCalledWith("e3"); // 样例 A 切点段被记录（与同步路径共享集合语义）
		expect(bgState.failureStreak).toBe(1); // inflated：递增点②
		expect(mockedCall).toHaveBeenCalledTimes(1);

		// 同段防重：膨胀段未消 → 不再触发防反复烧钱
		expect(manager.maybeStart(makeBgCtx(entries, TRIGGER_USAGE))).toBe(false);
		expect(mockedCall).toHaveBeenCalledTimes(1);
	});

	it("档位重置补偿（U3 验收③，D6）：落盘成功后 firedThresholds 清空，同档重新提醒（index.ts 全接线）", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const sendMessage = vi.fn();
		const hookPi = {
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
				handlers.set(name, handler);
			},
			getAllTools: () => [],
			registerTool: vi.fn(), registerCommand: vi.fn(),
			sendMessage,
			appendEntry: vi.fn(),
		} as unknown as ExtensionAPI;
		smartContextExtension(hookPi);

		// 行情：450K/500K 窗口 → 450_000 = 0.9×500_000 压线触发后台任务，且 ≥ 400K 第一档提醒
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), { tokens: 450_000, contextWindow: 500_000 });
		handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

		// 第一次 settle：越档提醒（fired 记 400K 档）+ 后台任务启动（挂起）
		const gen = holdGeneration();
		handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(mockedCall).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledTimes(1); // 第一档提醒投递
		gen.release(true);
		// 落盘链路全微任务：drain 到 appendCompaction 被调，再 drain 续段尾部（onPersisted 回流
		// 与 U5 终局通知）
		for (let i = 0; i < 50 && getAppendMock(ctx).mock.calls.length === 0; i++) await Promise.resolve();
		expect(getAppendMock(ctx)).toHaveBeenCalledTimes(1); // 落盘成功（补偿的前置事实）
		for (let i = 0; i < 50; i++) await Promise.resolve();

		// U5/D6 完成通知：落盘成功 → compact-complete 经 nextTurn 投递（不自起回合），
		// 含压缩前后 token 数与模式（D6）。C1 落盘信号在 onPersisted 事实点先行投递
		//（display:false 机器信号，分界行数据源），完成通知随后，两条互不替代
		expect(sendMessage).toHaveBeenCalledTimes(3);
		const [signalMessage, signalOptions] = sendMessage.mock.calls[1]!;
		expect(signalMessage).toMatchObject({
			customType: "smart-context",
			display: false,
			details: { source: "compaction-entry-appended", compactionId: "entry-persisted" },
		});
		expect(signalOptions).toEqual({ triggerTurn: false }); // 空闲投递：无 deliverAs，pi 立即 append
		const [completeMessage, completeOptions] = sendMessage.mock.calls[2]!;
		expect(completeMessage).toMatchObject({
			customType: "smart-context",
			display: true,
			details: { source: "compact-complete" },
		});
		expect(String(completeMessage.content)).toContain("后台压缩完成");
		expect(String(completeMessage.content)).toContain("same-model");
		expect(String(completeMessage.content)).toContain("450K"); // tokensBefore = 触发行情
		expect(completeOptions).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });

		// 第二次 settle：420K 越第一档但低于触发线（450K，不启动新任务）→ fired 已清 → 同档重新提醒
		handlers.get("agent_settled")!(
			{ type: "agent_settled" },
			makeBgCtx(sampleEntriesNoCompaction(), { tokens: 420_000, contextWindow: 500_000 }),
		);
		expect(sendMessage).toHaveBeenCalledTimes(4); // +1 提醒（firedThresholds 清空的直接行为证据）
		expect(sendMessage.mock.calls[3]![0]).toMatchObject({ details: { source: "threshold-reminder" } });
		expect(mockedCall).toHaveBeenCalledTimes(1); // 未越触发线，不重复启动任务
	});
});

// ──────────────────────── U5：工具路径启动（接线残项：startForTool 实装 BackgroundCompactionControls） ────────────────────────

describe("工具路径启动（U5：互斥 + 门控前置，跳过触发线/熔断/膨胀段）", () => {
	it("门控前置：disabled → 抛错（不触 LLM 不启动）；探测失败 → 抛错", () => {
		const manager = makeBgManager(createBackgroundCompactionState(), normalizeSmartContextConfig({ enabled: false }));
		expect(() => manager.startForTool(makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE))).toThrow(/门控拒绝/);

		const noProbeState = createBackgroundCompactionState();
		const noProbeManager = makeBgManager(noProbeState, normalizeSmartContextConfig({}));
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		delete (ctx.sessionManager as { appendCompaction?: unknown }).appendCompaction;
		expect(() => noProbeManager.startForTool(ctx)).toThrow(/appendCompaction 不可用/);
		expect(mockedCall).not.toHaveBeenCalled();
		expect(noProbeManager.isActive()).toBe(false);
	});

	it("manual 来源跳过门控：enabled=false 时手动启动成功（用户意志，与旧 pi 原生手动压缩对齐）", async () => {
		const bgState = createBackgroundCompactionState();
		// enabled=false：tool 来源抛「门控拒绝」（上一用例锁定），manual 来源照常启动
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({ enabled: false }));
		mockedCall.mockResolvedValue({ ok: true, text: "s", usage: { input: 1, output: 2 } });
		expect(manager.startForTool(makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE), undefined, "manual")).toBe(true);
		expect(mockedCall).toHaveBeenCalledTimes(1);
		await bgState.active?.done;
	});

	it("互斥（RL1）：任务进行中 startForTool 返回 false（U4 契约幂等语义）且不触 LLM；收尾回空闲", async () => {
		const gen = holdGeneration();
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}));
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		// 自动入口占位：进行中 → isActive true、工具路径 false
		expect(manager.maybeStart(ctx)).toBe(true);
		expect(manager.isActive()).toBe(true);
		expect(manager.startForTool(makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE))).toBe(false);
		expect(mockedCall).toHaveBeenCalledTimes(1);

		gen.release(true);
		await bgState.active?.done;
		expect(manager.isActive()).toBe(false);
	});

	it("跳过触发线（工具显式请求不受 D4 约束）：未越线行情 maybeStart 拒绝、startForTool 照常启动", async () => {
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}));
		mockedCall.mockResolvedValue({ ok: true, text: "s", usage: { input: 1, output: 2 } });
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), BELOW_USAGE); // 100K/200K = 50% < 0.9 线

		expect(manager.maybeStart(ctx)).toBe(false); // 自动入口：触发线挡住（对照）
		expect(manager.startForTool(ctx)).toBe(true); // 工具入口：显式请求放行
		expect(mockedCall).toHaveBeenCalledTimes(1);
		await bgState.active?.done;
	});

	it("跳过独立熔断（SI5：熔断仅停自动触发）：连续失败 3 次后 maybeStart 拒绝、startForTool 照常启动", async () => {
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}));
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		mockedCall.mockResolvedValue({ ok: false, text: "", error: "boom" });
		for (let i = 0; i < 3; i++) {
			expect(manager.maybeStart(ctx)).toBe(true);
			await bgState.active?.done;
		}
		expect(bgState.failureStreak).toBe(3);
		expect(manager.maybeStart(ctx)).toBe(false); // 自动入口：熔断挡住（对照）

		mockedCall.mockResolvedValue({ ok: true, text: "s", usage: { input: 1, output: 2 } });
		expect(manager.startForTool(ctx)).toBe(true); // 工具入口：不受熔断影响
		await bgState.active?.done;
		expect(bgState.failureStreak).toBe(0); // 成功清零
	});

	it("跳过膨胀段拦截（显式请求不拦，落盘侧校验仍生效）：同段已 inflated，maybeStart 拒绝、startForTool 照常启动", async () => {
		const bgState = createBackgroundCompactionState();
		const inflated = new Set(["e3"]); // 样例 A 切点段已记录膨胀
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), undefined, () => inflated);
		mockedCall.mockResolvedValue({ ok: true, text: "s", usage: { input: 1, output: 2 } });
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		expect(manager.maybeStart(ctx)).toBe(false); // 自动入口：膨胀段挡住（对照）
		expect(manager.startForTool(ctx)).toBe(true);
		await bgState.active?.done;
	});

	it("custom_instructions 透传到生成输入（same-model 指令的 Additional focus 段）", async () => {
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}));
		mockedCall.mockResolvedValue({ ok: true, text: "s", usage: { input: 1, output: 2 } });
		expect(manager.startForTool(makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE), "保留验证结果")).toBe(true);
		const instruction = mockedCall.mock.calls[0]![1].messages.at(-1) as { content: Array<{ text: string }> };
		expect(instruction.content[0]!.text).toContain("保留验证结果");
		await bgState.active?.done;
	});

	it("无可压内容（刚压缩完/预算内）→ 抛错（诚实失败，不谎报互斥幂等）", () => {
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}));
		const compacted = [makeCompactionEntry("c9", null, "c9")];
		expect(() => manager.startForTool(makeBgCtx(compacted, TRIGGER_USAGE))).toThrow(/没有可压缩内容/);
		expect(mockedCall).not.toHaveBeenCalled();
	});

	it("工具触发端到端（index.ts 注入形态）：compact_context execute 真实走通到 U2 任务启动", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const registerTool = vi.fn();
		const hookPi = {
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
				handlers.set(name, handler);
			},
			getAllTools: () => [],
			registerTool,
			registerCommand: vi.fn(),
			sendMessage: vi.fn(),
			appendEntry: vi.fn(),
		} as unknown as ExtensionAPI;
		smartContextExtension(hookPi);
		expect(registerTool).toHaveBeenCalledTimes(1);
		const tool = registerTool.mock.calls[0]![0] as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: undefined,
				onUpdate: undefined,
				ctx: ExtensionContext,
			) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
		};

		// 行情：420K ≥ 最低提醒档 400K（A9 护栏放行）、42% < 0.9 触发线——工具显式请求不受触发线约束
		mockedCall.mockResolvedValue({ ok: true, text: "s", usage: { input: 1, output: 2 } });
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), { tokens: 420_000, contextWindow: 1_000_000 });
		const result = await tool.execute("t1", {}, undefined, undefined, ctx);
		expect(result.content[0]!.text).toContain("压缩已启动"); // GL1 立即回执
		expect(mockedCall).toHaveBeenCalledTimes(1); // 真实走通：U2 任务已启动并进入生成
		expect(mockedCall.mock.calls[0]![1].signal.aborted).toBe(false);
		for (let i = 0; i < 50; i++) await Promise.resolve(); // 任务收尾 drain
		expect(mockedCall).toHaveBeenCalledTimes(1);
	});
});

// ──────────────────────── U5：终局通知回调（D6 呈现半边：每个终局恰一次，cancelled 除外） ────────────────────────

describe("终局通知回调 onSettled（U5：D6 失败不静默、不重复）", () => {
	it("validated：恰一次回调，载荷含 result/shadowedTokens/mode/sessionId", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "bg summary", usage: { input: 1, output: 2 } });
		const onSettled = vi.fn();
		const hook: AfterGenerationHook = (result, snapshot, ctx) => persistBackgroundCompaction(ctx, result, snapshot);
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), hook, undefined, onSettled);
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;

		expect(onSettled).toHaveBeenCalledTimes(1); // 每任务恰一条通知（不重复）
		const settlement = onSettled.mock.calls[0]![0] as BackgroundTaskSettlement;
		expect(settlement.outcome).toBe("validated");
		expect(settlement.mode).toBe("same-model");
		expect(settlement.sessionId).toBe("s1");
		expect(settlement.result?.tokensBefore).toBe(TRIGGER_USAGE.tokens);
		expect(settlement.shadowedTokens).toBeGreaterThan(0);
		expect(settlement.failureStreak).toBeUndefined();
	});

	it("inflated：回调带递增计数；dropped（校验放弃/探测失败同分支）：回调无计数字段", async () => {
		const onSettled = vi.fn();
		const bgState = createBackgroundCompactionState();
		const afterGen = vi.fn();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), afterGen as unknown as AfterGenerationHook, undefined, onSettled);
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		// inflated（递增点②）：载荷带 failureStreak 与 result
		mockedCall.mockResolvedValue({ ok: true, text: "bg summary", usage: { input: 1, output: 2 } });
		afterGen.mockResolvedValue("inflated");
		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;
		expect(onSettled.mock.calls[0]![0]).toMatchObject({ outcome: "inflated", failureStreak: 1, circuitBreakerOpen: false });

		// dropped（校验放弃与探测失败在 settlement 层同一 "dropped" 分支——通知文案按 droppedReason 分派）：
		// 计数不动、无 failureStreak 字段，droppedReason 原样透传
		afterGen.mockResolvedValue({ outcome: "dropped", reason: "session-mismatch" });
		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;
		const dropped = onSettled.mock.calls[1]![0] as BackgroundTaskSettlement;
		expect(dropped.outcome).toBe("dropped");
		expect(dropped.droppedReason).toBe("session-mismatch");
		expect(dropped.failureStreak).toBeUndefined();
		expect(dropped.circuitBreakerOpen).toBeUndefined();
		expect(bgState.failureStreak).toBe(1); // dropped 不递增
	});

	it("empty（递增点①）与 error（递增点③）：各回调一次，载荷带错误/计数", async () => {
		const onSettled = vi.fn();
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), undefined, undefined, onSettled);
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		mockedCall.mockResolvedValue({ ok: false, text: "", error: "boom" });
		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;
		expect(onSettled.mock.calls[0]![0]).toMatchObject({ outcome: "empty", failureStreak: 1, circuitBreakerOpen: false });

		mockedCall.mockRejectedValue(new Error("boom"));
		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;
		const errorSettlement = onSettled.mock.calls[1]![0] as BackgroundTaskSettlement;
		expect(errorSettlement.outcome).toBe("error");
		expect(errorSettlement.error).toContain("boom");
		expect(errorSettlement.failureStreak).toBe(2);
		expect(onSettled).toHaveBeenCalledTimes(2);
	});

	it("熔断标记：第 3 次失败 circuitBreakerOpen=true（自动触发将暂停，SI5）", async () => {
		const onSettled = vi.fn();
		const bgState = createBackgroundCompactionState();
		bgState.failureStreak = 2;
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), undefined, undefined, onSettled);
		mockedCall.mockResolvedValue({ ok: false, text: "", error: "boom" });
		expect(manager.maybeStart(makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE))).toBe(true);
		await bgState.active?.done;
		expect(onSettled.mock.calls[0]![0]).toMatchObject({ outcome: "empty", failureStreak: 3, circuitBreakerOpen: true });
	});

	it("cancelled（事件取消）：不回调通知（取消非失败，D3；session_compact 抢先场景不弹噪音）", async () => {
		const onSettled = vi.fn();
		const gen = holdGeneration();
		const bgState = createBackgroundCompactionState();
		const afterGen = vi.fn().mockResolvedValue("validated");
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), afterGen as unknown as AfterGenerationHook, undefined, onSettled);
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		expect(manager.maybeStart(ctx)).toBe(true);
		const done = bgState.active?.done;
		manager.cancelActive("session_compact");
		gen.release(true);
		await done;
		expect(onSettled).not.toHaveBeenCalled();
	});

	it("index.ts 全接线：生成失败 → compact-failed 通知经 nextTurn 投递（不自起回合）", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const sendMessage = vi.fn();
		const hookPi = {
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
				handlers.set(name, handler);
			},
			getAllTools: () => [],
			registerTool: vi.fn(), registerCommand: vi.fn(),
			sendMessage,
			appendEntry: vi.fn(),
		} as unknown as ExtensionAPI;
		smartContextExtension(hookPi);

		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
		mockedCall.mockResolvedValue({ ok: false, text: "", error: "boom" });
		handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		// 任务收尾全微任务链（生成 → 续段 → settlement → 通知）
		for (let i = 0; i < 50; i++) await Promise.resolve();

		expect(sendMessage).toHaveBeenCalledTimes(1); // 失败通知（不静默），无提醒（行情未越档不叠加）
		const [message, options] = sendMessage.mock.calls[0]!;
		expect(message).toMatchObject({
			customType: "smart-context",
			display: true,
			details: { source: "compact-failed" },
		});
		expect(String(message.content)).toContain("后台压缩失败");
		expect(options).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
	});

	it("index.ts 全接线：连续失败 3 次 → 第 3 条通知含熔断语义（各失败恰一条不重复）", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const sendMessage = vi.fn();
		const hookPi = {
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
				handlers.set(name, handler);
			},
			getAllTools: () => [],
			registerTool: vi.fn(), registerCommand: vi.fn(),
			sendMessage,
			appendEntry: vi.fn(),
		} as unknown as ExtensionAPI;
		smartContextExtension(hookPi);

		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
		mockedCall.mockResolvedValue({ ok: false, text: "", error: "boom" });
		for (let i = 0; i < 3; i++) {
			handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
			for (let j = 0; j < 50; j++) await Promise.resolve();
		}
		expect(sendMessage).toHaveBeenCalledTimes(3); // 每次失败一条，不重复不静默
		expect(String(sendMessage.mock.calls[0]![0].content)).not.toContain("自动触发压缩已暂停");
		expect(String(sendMessage.mock.calls[1]![0].content)).not.toContain("自动触发压缩已暂停");
		expect(String(sendMessage.mock.calls[2]![0].content)).toContain("自动触发压缩已暂停"); // 熔断并入第 3 条
		expect(String(sendMessage.mock.calls[2]![0].content)).toContain("compact_context 工具仍可手动调用");
	});
});

// ──────────────────────── C-pi-17：后台压缩落盘段 stale ctx 防线（dmg-r1-1）────────────────────────

describe("落盘段 stale ctx 防线（C-pi-17：guardStaleCtx 接入，dmg-r1-1）", () => {
	it("isCtxStale 命中 → 放弃落盘回报 dropped（session-mismatch：代际防线语义同会话已切换）：appendCompaction 不调、补偿回调不触发", async () => {
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		const onPersisted = vi.fn();
		const onInflated = vi.fn();
		const outcome = await persistBackgroundCompaction(
			ctx,
			makeCompactionResult(),
			makeSnapshot(),
			{ onPersisted, onInflated },
			() => true,
		);
		expect(outcome).toEqual({ outcome: "dropped", reason: "session-mismatch" });
		expect(getAppendMock(ctx)).not.toHaveBeenCalled();
		expect(onPersisted).not.toHaveBeenCalled();
		expect(onInflated).not.toHaveBeenCalled();
	});

	it("isCtxStale=false（缺省同语义）→ 正常路径零行为变化：照常落盘回报 validated", async () => {
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		const onPersisted = vi.fn();
		const outcome = await persistBackgroundCompaction(
			ctx,
			makeCompactionResult(),
			makeSnapshot(),
			{ onPersisted },
			() => false,
		);
		expect(outcome).toBe("validated");
		expect(getAppendMock(ctx)).toHaveBeenCalledTimes(1);
		expect(onPersisted).toHaveBeenCalledTimes(1);
	});

	it("非 stale 落盘异常仍原样上抛（检查不吞真实 bug）→ 交由 runBackgroundTask 递增点③", async () => {
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		getAppendMock(ctx).mockImplementation(() => {
			throw new Error("append boom");
		});
		await expect(
			persistBackgroundCompaction(ctx, makeCompactionResult(), makeSnapshot(), undefined, () => false),
		).rejects.toThrow(/append boom/);
	});

	it("manager 注入位把 isCtxStale 转交续段钩子（第四参）；续段判 stale → 放弃落盘、计数不动", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "bg summary", usage: { input: 1, output: 2 } });
		const seen: Array<(() => boolean) | undefined> = [];
		const hook: AfterGenerationHook = (result, snapshot, ctx, isCtxStale) => {
			seen.push(isCtxStale);
			return persistBackgroundCompaction(ctx, result, snapshot, undefined, isCtxStale);
		};
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), hook, undefined, undefined, () => true);
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		expect(manager.maybeStart(ctx)).toBe(true);
		await bgState.active?.done;

		expect(seen).toHaveLength(1);
		expect(seen[0]).toBeTypeOf("function");
		expect(getAppendMock(ctx)).not.toHaveBeenCalled(); // stale → 放弃落盘
		expect(bgState.failureStreak).toBe(0); // dropped：会话态失效类放弃，计数不动
		expect(bgState.active).toBeNull();
	});

	it("index.ts 全接线：session 替换后旧代任务的落盘段判 stale → 放弃落盘、不发通知", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const sendMessage = vi.fn();
		const makeHookPi = () =>
			({
				on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
					handlers.set(name, handler);
				},
				getAllTools: () => [],
				registerTool: vi.fn(), registerCommand: vi.fn(),
				sendMessage,
				appendEntry: vi.fn(),
			}) as unknown as ExtensionAPI;

		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);
		smartContextExtension(makeHookPi()); // 第 1 代
		handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
		const gen = holdGeneration();
		handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(mockedCall).toHaveBeenCalledTimes(1);

		// session 替换：pi 重跑 extension factory（模块级 sessionGeneration 递增 → 第 1 代的
		// isCtxStale 从此判 stale；handler map 被第 2 代覆写，故第 1 代的 agent_settled 已先行取用）
		smartContextExtension(makeHookPi());
		handlers
			.get("session_start")!({ type: "session_start", reason: "startup" }, makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE));

		gen.release(true);
		for (let i = 0; i < 50; i++) await Promise.resolve();

		expect(getAppendMock(ctx)).not.toHaveBeenCalled(); // 第 1 代落盘段判 stale → 放弃
		expect(sendMessage).not.toHaveBeenCalled(); // 通知链路同一 stale 窗口降级，不谎报成败
	});
});

// ──────────────────────── settle 错误边界（dmg-r1-2）────────────────────────

describe("settle 错误边界（dmg-r1-2：通知失败不改写压缩成败事实）", () => {
	it("validated 终局的通知抛错（非 stale 上抛）→ 落盘事实保留、熔断计数不动、不二次投递", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "bg summary", usage: { input: 1, output: 2 } });
		const onSettled = vi.fn(() => {
			throw new Error("notice delivery boom");
		});
		const hook: AfterGenerationHook = (result, snapshot, ctx) => persistBackgroundCompaction(ctx, result, snapshot);
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), hook, undefined, onSettled);
		const ctx = makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE);

		expect(manager.maybeStart(ctx)).toBe(true);
		await expect(bgState.active?.done).resolves.toBeUndefined();

		expect(getAppendMock(ctx)).toHaveBeenCalledTimes(1); // 落盘成功（事实未被通知失败篡改）
		expect(bgState.failureStreak).toBe(0); // 不递增熔断
		expect(onSettled).toHaveBeenCalledTimes(1); // 恰一次通知（不改走 error 终局重复投递）
	});

	it("error 终局的通知也抛错 → done 仍 resolve（防 unhandled rejection），递增点③照常", async () => {
		// 契约锁：settle 内吞是主防线（通知失败不改写成败事实），task.done 的 .catch 是末梢
		// 兜底（防未预见抛漏泄漏为无人 await 的 rejection）——两者同时失守时本用例转红。
		mockedCall.mockRejectedValue(new Error("boom"));
		const onSettled = vi.fn(() => {
			throw new Error("notice boom");
		});
		const bgState = createBackgroundCompactionState();
		const manager = makeBgManager(bgState, normalizeSmartContextConfig({}), undefined, undefined, onSettled);
		expect(manager.maybeStart(makeBgCtx(sampleEntriesNoCompaction(), TRIGGER_USAGE))).toBe(true);

		await expect(bgState.active?.done).resolves.toBeUndefined();
		expect(bgState.failureStreak).toBe(1); // 递增点③照常（通知失败不影响失败计数本身）
		expect(bgState.active).toBeNull();
	});
});
