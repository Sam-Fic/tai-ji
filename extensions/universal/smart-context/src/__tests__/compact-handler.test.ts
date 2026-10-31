import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { compact as nativeCompact, buildContextEntries, buildSessionProjection, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { callSameModelCompaction } from "../llm.js";
import {
	buildBackgroundPreparation,
	createBackgroundCompactionManager,
	createBackgroundCompactionState,
	createBeforeCompactHandler,
	createTakeoverState,
	isAutoCompactTriggered,
	type AfterGenerationHook,
	type BackgroundCompactionState,
} from "../compact-handler.js";
import smartContextExtension from "../index.js";
import { normalizeSmartContextConfig, type SmartContextConfig } from "../pure.js";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

// assistant 消息形态锁定为单 text 块（设计 §8.3）：必填标量字段补齐 + content 不得追加
// thinking/toolCall 块——追加会抬高 shadowedTokens，使「新旧口径数值等价」声明静默失效
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
		// details.model = `${ctx.model.provider}/${ctx.model.id}`（§3.3 ①，用量归属数据源）
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
		// details.model = `${resolveModel(...).provider}/${id}`（§3.3 ①）；native details 字段原样保留（spread 增量，不改变其他字段）
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

/** U2 组装/管理器共用的 ctx：entries + usage + sessionId。 */
function makeBgCtx(entries: SessionEntry[], usage: { tokens: number | null; contextWindow: number } | null): ExtensionContext {
	return {
		model: { provider: "zai", id: "glm" },
		getSystemPrompt: () => "sys",
		getContextUsage: () => (usage ? { ...usage, percent: null } : undefined),
		sessionManager: {
			getSessionId: () => "s1",
			getSessionFile: () => "/tmp/s1.jsonl",
			getEntries: () => entries,
		},
		modelRegistry: {},
	} as unknown as ExtensionContext;
}

function makeBgManager(
	bgState: BackgroundCompactionState,
	config: SmartContextConfig,
	afterGeneration?: AfterGenerationHook,
) {
	const manager = createBackgroundCompactionManager(makePi(), () => bgState, () => config, afterGeneration);
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
			registerTool: vi.fn(),
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

		afterGen.mockResolvedValue("dropped");
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
