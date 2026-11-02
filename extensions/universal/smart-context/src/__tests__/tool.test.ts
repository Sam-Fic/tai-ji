import { beforeEach, describe, expect, it, vi } from "vitest";

// mock 配置加载（工具测试不落盘）
vi.mock("../pure.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../pure.js")>();
	return {
		...actual,
		loadSmartContextConfig: vi.fn(),
	};
});

import { DEFAULT_SMART_CONTEXT_CONFIG, loadSmartContextConfig } from "../pure.js";
import { registerCompactContextTool, type BackgroundCompactionControls } from "../tool.js";
import { countCompactions } from "../pure.js";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

interface RegisteredTool {
	name: string;
	/** pi SDK 的 exposure 缺省值 "direct"（常驻）——不写字段时 SDK 侧默认（pi-semantics PS-91），本视图可缺省。 */
	exposure?: string;
	parameters: { type?: string };
	renderResult?: (result: unknown, options: { expanded: boolean }, theme: Theme) => { render: (width: number) => string[] };
	execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

function makePi(): { pi: ExtensionAPI; tools: RegisteredTool[] } {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerTool: (t: RegisteredTool) => tools.push(t),
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

/** ctx.compact 恒为 spy：RL5 交互断言——execute 不再触碰压缩执行路径，被调用即红。 */
function makeCtx(): ExtensionContext {
	return {
		model: { provider: "zai", id: "glm" },
		getContextUsage: () => ({ tokens: 450_000, contextWindow: 1_000_000 }),
		sessionManager: { getEntries: () => [] },
		compact: vi.fn(),
	} as unknown as ExtensionContext;
}

interface BackgroundSpies {
	isActive: ReturnType<typeof vi.fn<() => boolean>>;
	start: ReturnType<typeof vi.fn<(ctx: ExtensionContext, customInstructions?: string) => boolean>>;
}

/** 后台任务依赖注入桩（BackgroundCompactionControls 契约的测试替身）。 */
function makeBackground(
	{ active = false, startResult = true }: { active?: boolean; startResult?: boolean } = {},
): { controls: BackgroundCompactionControls; spies: BackgroundSpies } {
	const isActive = vi.fn((): boolean => active);
	const start = vi.fn((_ctx: ExtensionContext, _customInstructions?: string): boolean => startResult);
	return { controls: { isActive, start }, spies: { isActive, start } };
}

const mockedLoad = vi.mocked(loadSmartContextConfig);

beforeEach(() => {
	vi.clearAllMocks();
	mockedLoad.mockReturnValue(DEFAULT_SMART_CONTEXT_CONFIG);
});

describe("compact_context 工具（U4 纯触发化：后台任务触发 + 立即回执）", () => {
	it("parameters 顶层为 Type.Object（OpenAI 兼容红线）", () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi);
		expect(tools[0].parameters.type).toBe("object");
		expect(tools[0].name).toBe("compact_context");
	});

	// exposure 重划终态锚（C-ext-05，2026-10-23 ADR-0136）：direct 常驻 = 注册时不写
	// exposure 字段（SDK 缺省 direct，pi-semantics PS-91）——误写 "deferred" 会把压缩入口
	// 从模型默认可见集收走（tool_search 才可激活），此处红。
	it("exposure 注册终态：direct 常驻——不写 exposure 字段（SDK 缺省 direct）", () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("compact_context");
		expect(tools[0]!.exposure).toBeUndefined();
	});

	// V7 工具路径回归：门控拒绝回现状文案，且不触达后台任务（无后台任务启动）
	it("门控拒绝（排除命中）→ throw 带原因与恢复指引（D5），不触达后台任务（V7）", async () => {
		mockedLoad.mockReturnValue({ ...DEFAULT_SMART_CONTEXT_CONFIG, excludedModels: ["zai/glm"] });
		const { pi, tools } = makePi();
		const { controls, spies } = makeBackground();
		registerCompactContextTool(pi, { gatingProbe: () => ({ active: false, modelId: "zai/glm" }), background: controls });
		await expect(tools[0].execute("t1", {}, undefined, undefined, makeCtx())).rejects.toThrow(/已配置为排除/);
		expect(spies.isActive).not.toHaveBeenCalled();
		expect(spies.start).not.toHaveBeenCalled();
	});

	it("门控拒绝（禁用）→ throw 带恢复指引（D5）", async () => {
		mockedLoad.mockReturnValue({ ...DEFAULT_SMART_CONTEXT_CONFIG, enabled: false });
		const { pi, tools } = makePi();
		registerCompactContextTool(pi, { gatingProbe: () => ({ active: false, modelId: "zai/glm" }) });
		await expect(tools[0].execute("t1", {}, undefined, undefined, makeCtx())).rejects.toThrow(/已禁用/);
	});

	// A9 成本护栏（UC-12）：checkToolThresholdGuard 保留的既有用例
	it("阈值保护：低于最低档 throw 带用量数据（D6）", async () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi, { usageProbe: () => ({ tokens: 38_000, contextWindow: 1_000_000 }) });
		await expect(tools[0].execute("t1", {}, undefined, undefined, makeCtx())).rejects.toThrow(/38K/);
	});

	it("阈值保护：tokens null → 用量未知拒绝（D6 null 分支）", async () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi, { usageProbe: () => ({ tokens: null, contextWindow: 1_000_000 }) });
		await expect(tools[0].execute("t1", {}, undefined, undefined, makeCtx())).rejects.toThrow(/用量未知/);
	});

	// RL5 单测半边：工具触发路径不再掐断进行中回合——mock 层断言不再调用压缩执行
	// 路径（ctx.compact 的 abort 副作用随之消失）+ 启动后台任务后立即回执（GL1）
	it("RL5：execute 不触碰 ctx.compact 压缩执行路径（交互断言）+ 启动后台任务立即回执", async () => {
		const { pi, tools } = makePi();
		const { controls, spies } = makeBackground();
		const ctx = makeCtx();
		registerCompactContextTool(pi, { getEntries: () => [{ type: "message" }], background: controls });
		const result = await tools[0].execute("t1", {}, undefined, undefined, ctx);
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(spies.start).toHaveBeenCalledTimes(1);
		expect(spies.start.mock.calls[0]?.[0]).toBe(ctx);
		expect(result.content[0].text).toContain("压缩已启动");
		expect(result.content[0].text).toContain("后台进行");
		expect(result.content[0].text).toContain("可以继续任何工作");
		// 等待指引退役：不再要求「引用早期上下文的操作等结果消息到达」
		expect(result.content[0].text).not.toContain("等结果消息");
		expect(result.details).toMatchObject({ mode: "same-model", compactionCount: 1 });
	});

	it("custom_instructions 透传给后台启动；空白串归一为 undefined", async () => {
		const { pi, tools } = makePi();
		const { controls, spies } = makeBackground();
		registerCompactContextTool(pi, { background: controls });
		await tools[0].execute("t1", { custom_instructions: "保留验证结果" }, undefined, undefined, makeCtx());
		expect(spies.start.mock.calls[0]?.[1]).toBe("保留验证结果");
		await tools[0].execute("t1", { custom_instructions: "   " }, undefined, undefined, makeCtx());
		expect(spies.start.mock.calls[1]?.[1]).toBeUndefined();
	});

	// RL1 互斥幂等：已有后台任务进行中 → 幂等成功回执（不是错误），不再启动
	it("互斥幂等：后台任务进行中 →「后台压缩进行中」成功回执，不再启动新任务", async () => {
		const { pi, tools } = makePi();
		const { controls, spies } = makeBackground({ active: true });
		registerCompactContextTool(pi, { background: controls });
		const result = await tools[0].execute("t1", {}, undefined, undefined, makeCtx());
		expect(result.content[0].text).toContain("后台压缩进行中");
		expect(result.content[0].text).toContain("可以继续任何工作");
		expect(spies.start).not.toHaveBeenCalled();
		// 无新任务启动，压缩序号不变
		expect(result.details).toMatchObject({ compactionCount: 0 });
	});

	it("竞态兜底：isActive 空闲但 start 返回 false（互斥撞上）→ 同幂等回执", async () => {
		const { pi, tools } = makePi();
		const { controls } = makeBackground({ startResult: false });
		registerCompactContextTool(pi, { background: controls });
		const result = await tools[0].execute("t1", {}, undefined, undefined, makeCtx());
		expect(result.content[0].text).toContain("后台压缩进行中");
	});

	// 接线缺失 fail-fast：不撒谎回执、不静默降级（BackgroundCompactionControls 契约）
	it("background 未注入（生产接线缺失）→ 门控与阈值检查后抛「后台压缩未接线」", async () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi, { getEntries: () => [{ type: "message" }] });
		await expect(tools[0].execute("t1", {}, undefined, undefined, makeCtx())).rejects.toThrow(/后台压缩未接线/);
	});

	it("renderResult 接线（C-ext-05）：注册定义携带函数成员 + 折叠态输出 details.summary 一行", async () => {
		const { pi, tools } = makePi();
		const { controls } = makeBackground();
		registerCompactContextTool(pi, { background: controls });
		const tool = tools[0];
		expect(typeof tool.renderResult).toBe("function");
		const result = await tool.execute("t1", {}, undefined, undefined, makeCtx());
		const renderTheme = { fg: (_token: string, text: string) => text } as unknown as Theme;
		const lines = tool.renderResult!(result, { expanded: false }, renderTheme).render(400);
		// Text.render 按宽度 pad，trim 后断言（折叠态 = details.summary 一行；U5 文案：
		// 工具返回时任务刚启动，「已完成」语义由完成通知承载）
		expect(lines.length).toBe(1);
		expect(lines[0].trim()).toBe("后台压缩已启动");
	});

	it("countCompactions 只数 compaction entries", () => {
		expect(countCompactions([{ type: "message" }, { type: "compaction" }, { type: "compaction" }])).toBe(2);
	});
});
