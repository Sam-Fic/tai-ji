// src/__tests__/index-manual-compact-command.test.ts
//
// C2 /compact 后台化（feat-compaction-closure）：`__taiji_compact__` 内部命令（GUI 手动
// 压缩的扩展侧触发入口）装配与回执契约。runtime 收到 session.compactBackground RPC 后经
// client.prompt fire-and-forget 发 `/__taiji_compact__ <encoded>`（session-service），本
// 文件锁命令 handler 的四件事：
//   ① 启动成功：经后台管理器 startForTool（manual 来源）启动，不投通知（GUI 提示由
//      runtime reply → renderer toast 承载，不双投）；
//   ② customInstructions percent 编码可逆：args = encodeURIComponent 原文（含空格/引号），
//      解码后透传给压缩生成（input.customInstructions）；
//   ③ busy 幂等：后台任务进行中再触发 → 通知通道投递「进行中已并入」回执（口径与
//      compact_context 工具 busy 回执一致），不重复启动；
//   ④ 启动失败（门控拒绝 / args 解码失败）：通知通道投递失败文案（含原因），不上抛
//      （重抛只进 pi emitError 日志，通知才是用户可达呈现）。
//
// runtime 侧契约（RPC handler 受理即 reply / session-service fire-and-forget 投递）由
// runtime 包单测覆盖；两侧以命令名字面量对齐（跨包字符串契约，改名必须同批）。

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

// 工具注册短路（本文件只测手动命令入口；工具装配由 index-generation.test.ts 覆盖）
vi.mock("../tool.js", () => ({
	registerCompactContextTool: vi.fn(),
}));

// same-model 生成替换（不触网；用例经 resolve/reject/挂起控制任务终局与 busy 窗口）
const { callSameModelCompactionMock } = vi.hoisted(() => ({
	callSameModelCompactionMock: vi.fn(),
}));
vi.mock("../llm.js", () => ({
	callSameModelCompaction: callSameModelCompactionMock,
	projectTools: (tools: unknown[]) => tools.map((t) => ({ name: (t as { name: string }).name })),
}));

// 配置冻结（不随本机 ~/.taiji 配置漂移）：默认基底（enabled + 0.9 触发线）；门控拒绝
// 用例经 enable(false) 局部改写
vi.mock("../pure.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../pure.js")>();
	let enabledOverride: boolean | undefined;
	return {
		...actual,
		loadSmartContextConfig: () => {
			const base = actual.normalizeSmartContextConfig(
				enabledOverride === undefined ? {} : { enabled: enabledOverride },
			);
			enabledOverride = undefined;
			return base;
		},
		// 门控拒绝用例的写入口（测试内 import 本模块后调用；生产代码不消费）
		__testSetEnabledOnce: (v: boolean) => {
			enabledOverride = v;
		},
	};
});

import { SMART_CONTEXT_NOTICE_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";

import smartContextExtension from "../index.js";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

/** 最小 fake pi：捕获 registerCommand 的 handler（本文件被测对象）。 */
function createMockPi(): {
	pi: ExtensionAPI;
	commands: Map<string, CommandHandler>;
	sendMessage: ReturnType<typeof vi.fn>;
} {
	const commands = new Map<string, CommandHandler>();
	const sendMessage = vi.fn();
	const pi = {
		registerTool: vi.fn(),
		registerCommand: (name: string, reg: { handler: CommandHandler }) => commands.set(name, reg.handler),
		getAllTools: () => [],
		on: vi.fn(),
		sendMessage,
	} as unknown as ExtensionAPI;
	return { pi, commands, sendMessage };
}

// 单条 120k 字符（≈30k tokens）> keepRecentTokens 保留预算（pi 默认 20k）——保证手动
// 入口（不受触发线约束，低 tokens 也启动）的被压段非空（buildBackgroundPreparation 判据）。
const BIG = "x".repeat(120_000);

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
		} as unknown as SessionEntry["message"],
	} as SessionEntry;
}

/** 手动入口不受触发线约束（startForTool 跳过 D4 ratio 判定）——低 tokens 上下文即可启动。 */
function makeCtx(entries: SessionEntry[], tokens: number | null = 1_000): ExtensionContext {
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

/** 三轮可压行情（与 index-compaction-signal 同款最小 entries 集）。 */
function makeCompressibleEntries(): SessionEntry[] {
	return [
		makeUserEntry("e1", null),
		makeAssistantEntry("e2", "e1"),
		makeUserEntry("e3", "e2"),
	];
}

async function setup(overrides?: { enabled?: boolean }): Promise<{
	pi: ReturnType<typeof createMockPi>["pi"];
	handler: CommandHandler;
	sendMessage: ReturnType<typeof createMockPi>["sendMessage"];
}> {
	const mock = createMockPi();
	smartContextExtension(mock.pi);
	const handler = mock.commands.get("__taiji_compact__");
	expect(handler).toBeDefined();
	if (overrides?.enabled !== undefined) {
		const pure = await import("../pure.js") as unknown as { __testSetEnabledOnce: (v: boolean) => void };
		pure.__testSetEnabledOnce(overrides.enabled);
	}
	return { pi: mock, handler: handler!, sendMessage: mock.sendMessage };
}

/** 通知帧判据（notices 单测锁形态，此处锁装配链路真正发出）。 */
function noticeCalls(sendMessage: ReturnType<typeof vi.fn>): string[] {
	return sendMessage.mock.calls
		.filter((c) => (c[0] as { customType?: string }).customType === SMART_CONTEXT_NOTICE_CUSTOM_TYPE)
		.map((c) => (c[0] as { content: string }).content);
}

describe("__taiji_compact__ 命令（C2 手动触发入口）", () => {
	beforeEach(() => {
		callSameModelCompactionMock.mockReset();
		callSameModelCompactionMock.mockResolvedValue({
			summary: "compressed summary",
			firstKeptEntryId: "e3",
			tokensBefore: 30_000,
			estimatedTokensAfter: 1_000,
		});
	});

	it("注册为内部命令（__ 双下划线前缀，前端 internal-command-filter 过滤）", async () => {
		const { pi } = await setup();
		expect([...pi.commands.keys()]).toEqual(["__taiji_compact__"]);
	});

	it("空 args 启动成功：不经通知回执（GUI 提示由 runtime reply → renderer 承载）", async () => {
		const { handler, sendMessage } = await setup();
		await handler("", makeCtx(makeCompressibleEntries()));
		// 启动成功不投任何 smart-context 通知
		expect(noticeCalls(sendMessage)).toHaveLength(0);
		// 手动入口不受触发线约束（startForTool 语义）：低 tokens 上下文照样启动
		expect(callSameModelCompactionMock).toHaveBeenCalledTimes(1);
	});

	it("customInstructions percent 解码透传（含空格/引号可逆，烘进摘要指令消息）", async () => {
		const { handler } = await setup();
		const instructions = '保留 关键决策 与 "引号" 内容';
		await handler(encodeURIComponent(instructions), makeCtx(makeCompressibleEntries()));
		// 生成入参：callSameModelCompaction(ctx, { messages, ... })——customInstructions 经
		// buildSameModelInstruction 烘进末条指令消息（Additional focus 段），原文逐字可检索
		const input = callSameModelCompactionMock.mock.calls[0]?.[1] as {
			messages: Array<{ content: Array<{ text?: string }> }>;
		};
		const lastMessage = input.messages.at(-1);
		const instructionText = lastMessage?.content.map((p) => p.text ?? "").join("");
		expect(instructionText).toContain(instructions);
	});

	it("busy 幂等：任务进行中再触发 → 通知通道投递「进行中已并入」回执，不重复启动", async () => {
		const { handler, sendMessage } = await setup();
		// 第一发：生成挂起（任务 active）
		let release!: (v: unknown) => void;
		callSameModelCompactionMock.mockImplementationOnce(
			() => new Promise((resolve) => { release = resolve }),
		);
		await handler("", makeCtx(makeCompressibleEntries()));
		expect(callSameModelCompactionMock).toHaveBeenCalledTimes(1);
		// 第二发：busy 回执（口径与 compact_context 工具 busy 回执逐字一致）
		await handler("", makeCtx(makeCompressibleEntries()));
		const notices = noticeCalls(sendMessage);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("后台压缩进行中");
		expect(notices[0]).toContain("已并入该任务");
		expect(callSameModelCompactionMock).toHaveBeenCalledTimes(1); // 未重复启动
		release({ summary: "s", firstKeptEntryId: "e3", tokensBefore: 30_000 });
	});

	it("门控拒绝（enabled=false）→ 通知通道失败文案，不上抛", async () => {
		const { handler, sendMessage } = await setup({ enabled: false });
		await expect(handler("", makeCtx(makeCompressibleEntries()))).resolves.toBeUndefined();
		const notices = noticeCalls(sendMessage);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("后台压缩未启动");
		expect(notices[0]).toContain("不在放行范围");
		expect(callSameModelCompactionMock).not.toHaveBeenCalled();
	});

	it("args 解码失败（非法 percent 编码）→ 通知通道失败文案（协议异常可操作呈现）", async () => {
		const { handler, sendMessage } = await setup();
		await handler("%zz-not-percent", makeCtx(makeCompressibleEntries()));
		const notices = noticeCalls(sendMessage);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("后台压缩未启动");
		expect(notices[0]).toContain("解码失败");
		expect(callSameModelCompactionMock).not.toHaveBeenCalled();
	});
});
