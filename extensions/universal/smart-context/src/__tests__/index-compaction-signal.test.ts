// src/__tests__/index-compaction-signal.test.ts
//
// C1 分界行实时化（feat-compaction-closure）：后台压缩落盘信号在 index.ts 装配点的端到端
// 回归。信号挂在「落盘成功」事实点（BackgroundPersistCallbacks.onPersisted，携带 entry id），
// 不在终局回调点——分界行帧的数据源（compactionId）只有落盘现场有。
//
// 本文件锁三件事：
//   ① validated 终局（persist 成功）→ sendMessage 落盘信号恰一条（形态见 notices 单测，
//      此处锁装配链路真正发出 + 先于完成通知）；
//   ② 失败终局（生成空结果）→ 无落盘信号（失败通知照旧，不混入信号帧判据）；
//   ③ 信号投递同步抛错 → 不改写压缩成败（完成通知照常投递，dmg-r1-2 同语义）。
//
// 信号→分界行帧的后半段（runtime 分诊合成）由 runtime 包单测覆盖，两端以 extension-protocol
// 词表常量对齐（值漂移结构性不可能）。

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

// 工具注册短路（本文件只测后台压缩信号链路装配；工具装配由 index-generation.test.ts 覆盖）
vi.mock("../tool.js", () => ({
	registerCompactContextTool: vi.fn(),
}));

// same-model 生成替换（不触网；成功/空结果按用例改写）
const { callSameModelCompactionMock } = vi.hoisted(() => ({
	callSameModelCompactionMock: vi.fn(),
}));
vi.mock("../llm.js", () => ({
	callSameModelCompaction: callSameModelCompactionMock,
	projectTools: (tools: unknown[]) => tools.map((t) => ({ name: (t as { name: string }).name })),
}));

// 配置冻结（不随本机 ~/.taiji 配置漂移）：默认基底（enabled + 0.9 触发线）
vi.mock("../pure.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../pure.js")>();
	return {
		...actual,
		loadSmartContextConfig: () => actual.normalizeSmartContextConfig({}),
	};
});

import { COMPACTION_ENTRY_APPENDED_SOURCE, SMART_CONTEXT_NOTICE_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";

import smartContextExtension from "../index.js";

/** 最小 fake pi：本文件消费 on / sendMessage / getAllTools（same-mode 生成投影工具清单）。 */
function createMockPi(): { pi: ExtensionAPI; events: Map<string, (...args: unknown[]) => void>; sendMessage: ReturnType<typeof vi.fn> } {
	const events = new Map<string, (...args: unknown[]) => void>();
	const sendMessage = vi.fn();
	const pi = {
		registerTool: vi.fn(),
		getAllTools: () => [],
		on: (event: string, handler: (...args: unknown[]) => void) => events.set(event, handler),
		sendMessage,
	} as unknown as ExtensionAPI;
	return { pi, events, sendMessage };
}

const BIG = "x".repeat(30_000);

function makeUserEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: BIG, timestamp: 0 },
	} as SessionEntry;
}

function makeAssistantEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: BIG }],
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

/** 触发行情上下文（190k/200k > 0.9 线；entries 3 轮足够切出被压段）。 */
function makeCtx(entries: SessionEntry[], tokens = 190_000): ExtensionContext {
	return {
		model: { provider: "zai", id: "glm" },
		getSystemPrompt: () => "sys",
		getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: null }),
		sessionManager: {
			getSessionId: () => "s1",
			getSessionFile: () => "/tmp/s1.jsonl",
			getEntries: () => entries,
			appendCompaction: vi.fn(() => "entry-persisted"),
		},
	} as unknown as ExtensionContext;
}

function fireSessionStart(mock: ReturnType<typeof createMockPi>, ctx: ExtensionContext): void {
	mock.events.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
}

function settle(mock: ReturnType<typeof createMockPi>, ctx: ExtensionContext): void {
	mock.events.get("agent_settled")!({ type: "agent_settled" }, ctx);
}

/** 信号帧判据（details.source 双判据的扩展侧写点）。 */
function isPersistSignal(call: unknown[]): boolean {
	const [message] = call as [{ customType?: string; details?: { source?: string } }];
	return message?.customType === SMART_CONTEXT_NOTICE_CUSTOM_TYPE
		&& message?.details?.source === COMPACTION_ENTRY_APPENDED_SOURCE;
}

describe("C1: 后台压缩落盘信号装配（validated 事实点发出）", () => {
	beforeEach(() => {
		callSameModelCompactionMock.mockReset();
	});

	it("persist 成功 → 信号恰一条（compactionId=appendCompaction 返回值）+ 先于完成通知（nextTurn）", async () => {
		callSameModelCompactionMock.mockResolvedValue({ ok: true, text: "bg summary", usage: { input: 1, output: 2 } });
		const mock = createMockPi();
		const entries = [makeUserEntry("e1", null), makeAssistantEntry("e2", "e1"), makeUserEntry("e3", "e2"), makeAssistantEntry("e4", "e3"), makeUserEntry("e5", "e4")];
		smartContextExtension(mock.pi);
		const ctx = makeCtx(entries);
		fireSessionStart(mock, ctx);

		settle(mock, ctx);
		// 后台任务落盘段全微任务：等信号帧出现（完成通知随后，nextTurn 投递）
		await vi.waitFor(() => {
			expect(mock.sendMessage.mock.calls.filter(isPersistSignal)).toHaveLength(1);
		});

		const signal = mock.sendMessage.mock.calls.find(isPersistSignal)!;
		const [message, options] = signal as [{ customType: string; content: string; display: boolean; details: { compactionId?: string } }, unknown];
		expect(message.customType).toBe(SMART_CONTEXT_NOTICE_CUSTOM_TYPE);
		expect(message.display).toBe(false);
		expect(message.details.compactionId).toBe("entry-persisted");
		// 空闲投递：无 deliverAs（pi 立即 append + emit，runtime 即时收 customStart 帧）
		expect(options).toEqual({ triggerTurn: false });
		// 完成通知（D6 既有语义）在信号之后照常投递，两条互不替代
		await vi.waitFor(() => {
			expect(mock.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
		});
		const notice = mock.sendMessage.mock.calls.find((call) => !isPersistSignal(call));
		expect(notice).toBeDefined();
		expect((notice as [{ details?: { source?: string } }])[0].details?.source).toBe("compact-complete");
	});

	it("生成空结果（empty 终局）→ 无落盘信号（失败通知照旧）", async () => {
		callSameModelCompactionMock.mockResolvedValue({ ok: false, text: "", error: "boom" });
		const mock = createMockPi();
		const entries = [makeUserEntry("e1", null), makeAssistantEntry("e2", "e1"), makeUserEntry("e3", "e2"), makeAssistantEntry("e4", "e3"), makeUserEntry("e5", "e4")];
		smartContextExtension(mock.pi);
		const ctx = makeCtx(entries);
		fireSessionStart(mock, ctx);

		settle(mock, ctx);
		await vi.waitFor(() => {
			expect(mock.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
		});

		expect(mock.sendMessage.mock.calls.filter(isPersistSignal)).toHaveLength(0);
		const only = mock.sendMessage.mock.calls[0] as [{ details?: { source?: string } }];
		expect(only[0].details?.source).toBe("compact-failed");
	});

	it("信号投递同步抛错 → 不改写压缩成败（完成通知照常投递）", async () => {
		callSameModelCompactionMock.mockResolvedValue({ ok: true, text: "bg summary", usage: { input: 1, output: 2 } });
		const mock = createMockPi();
		const entries = [makeUserEntry("e1", null), makeAssistantEntry("e2", "e1"), makeUserEntry("e3", "e2"), makeAssistantEntry("e4", "e3"), makeUserEntry("e5", "e4")];
		smartContextExtension(mock.pi);
		const ctx = makeCtx(entries);
		fireSessionStart(mock, ctx);
		// 信号发送点同步抛错：onPersisted 在 appendCompaction try 块内，上抛会把已落盘
		// 的压缩改记失败（递增点③）——内吞后任务应仍走 validated 终局
		mock.sendMessage.mockImplementation((message: { details?: { source?: string } }) => {
			if (message?.details?.source === COMPACTION_ENTRY_APPENDED_SOURCE) throw new Error("signal boom");
		});

		settle(mock, ctx);
		await vi.waitFor(() => {
			// 信号抛错被内吞后任务仍走 validated 终局：完成通知照常投递，且不产生失败通知
			//（error 终局会经递增点③改投 compact-failed——成败事实被信号失败篡改的回归形态）
			const sources = mock.sendMessage.mock.calls.map((call) => (call[0] as { details?: { source?: string } }).details?.source);
			expect(sources).toContain("compact-complete");
			expect(sources).not.toContain("compact-failed");
		});
	});
});
