// src/__tests__/index-generation.test.ts
//
// U5 工具接线装配回归：index.ts 注册点向 registerCompactContextTool 注入 deps.background
// （BackgroundCompactionControls 契约：isActive/start），工具路径与 agent_settled 自动
// 触发共享同一 session 级互斥容器（RL1）——未注入时工具 execute 在门控与阈值检查后抛
// 「后台压缩未接线」（fail-fast，tool.test.ts 覆盖），本文件守住注册点真的注入了。
//
// 本文件前身是 G1 deps.isCtxStale live 绑定装配回归：compact_context 纯触发化（U4）后
// 工具不再持有异步回调（旧 ctx.compact onComplete/onError 路径删除），isCtxStale 过渡
// 字段随 U5 注入 background 一并退役——代际分诊仅剩事件回调内的 guardStaleCtx 消费
// （闭包内读变量绑定，天然 live），无快照风险点，故该回归对象消亡、本文件改守注入契约。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger（compact-handler 顶层 createLogger；同 scheduler index-generation 形态）
const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

// 装配捕获：mock tool.js，逐次登记 index.ts 传入的 deps（同 scheduler 捕获 runtime 构造第三参）
interface CapturedDeps {
	background?: { isActive: () => boolean; start: (ctx: ExtensionContext, customInstructions?: string) => boolean };
}
const { registerCompactContextToolCalls } = vi.hoisted(() => ({
	registerCompactContextToolCalls: [] as Array<{ deps?: CapturedDeps }>,
}));
vi.mock("../tool.js", () => ({
	registerCompactContextTool: (_pi: unknown, deps?: CapturedDeps) => {
		registerCompactContextToolCalls.push({ deps });
	},
}));

import smartContextExtension from "../index.js";

/** 最小 fake pi：装配路径只消费 on（事件接线）；registerTool/sendMessage 兜底。 */
function createMockPi(): {
	pi: ExtensionAPI
	events: Map<string, (...args: unknown[]) => void>
} {
	const events = new Map<string, (...args: unknown[]) => void>();
	const pi = {
		registerTool: vi.fn(),
		on: (event: string, handler: (...args: unknown[]) => void) => events.set(event, handler),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	return { pi, events };
}

/** 触发 session_start（handler 重建 session 级闭包状态，ctx 仅 seed 用——空 entries 安全）。 */
function fireSessionStart(events: Map<string, (...args: unknown[]) => void>): void {
	const sessionStart = events.get("session_start");
	expect(sessionStart).toBeDefined();
	sessionStart!({ type: "session_start" }, {} as ExtensionContext);
}

describe("U5: 工具注册 background 契约注入（接线残项落地）", () => {
	beforeEach(() => {
		registerCompactContextToolCalls.length = 0;
	});

	it("deps.background 注入且 isActive/start 均为函数；isCtxStale 过渡字段不再传", () => {
		const { pi, events } = createMockPi();
		smartContextExtension(pi);
		expect(registerCompactContextToolCalls).toHaveLength(1);
		const background = registerCompactContextToolCalls[0]!.deps?.background;
		expect(background).toBeDefined();
		expect(background!.isActive).toBeTypeOf("function");
		expect(background!.start).toBeTypeOf("function");
		// 过渡字段退役断言：注册点不得再传 isCtxStale（tool.ts deps 已无该字段）
		expect("isCtxStale" in (registerCompactContextToolCalls[0]!.deps ?? {})).toBe(false);

		// 互斥查询可用：装配后（未 fire session_start 亦有初始状态容器）无进行中任务
		expect(background!.isActive()).toBe(false);
		// fire 后 controls 仍可用（闭包经 getState 读当前代容器，非快照）
		fireSessionStart(events);
		expect(background!.isActive()).toBe(false);
	});

	it("factory 重跑（session 替换拓扑）：两代各自拿到独立 controls，均读各自代容器", () => {
		const first = createMockPi();
		smartContextExtension(first.pi);
		fireSessionStart(first.events);
		const second = createMockPi();
		smartContextExtension(second.pi);
		fireSessionStart(second.events);

		expect(registerCompactContextToolCalls).toHaveLength(2);
		const firstBackground = registerCompactContextToolCalls[0]!.deps!.background!;
		const secondBackground = registerCompactContextToolCalls[1]!.deps!.background!;
		// 两代 controls 各自可调用且空闲（工厂重跑后旧代任务随旧闭包消亡，isActive 恒 false）
		expect(firstBackground.isActive()).toBe(false);
		expect(secondBackground.isActive()).toBe(false);
	});
});
