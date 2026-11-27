// create-model-param.test.ts — create_managed_session 的 `model` 参数接线
//
// 覆盖三层：① 协议载荷透传（payload.params.model）；② 前置校验在 select 通道往返
// **之前**拦掉未命中模型（不产生 runtime 调用、不创建会话）；③ 校验的数据源是
// ctx.modelRegistry（含聚合路由条目）；④ details.summary 折叠态带模型。

import { describe, it, expect, vi } from "vitest";
import { SESSION_MANAGER_MARKER } from "@zhushanwen/extension-protocol";
import registerExtension from "../index.ts";

const CATALOG = [
	{ provider: "deepseek", id: "deepseek-v4-pro" },
	{ provider: "aggregation", id: "route-3" },
];

/** 带 modelRegistry 的 harness（ctx 最小面 = registerSessionTool execute 实际消费的成员）。 */
function createHarness() {
	const registered: Array<{ name: string; execute: Function }> = [];
	const selectMock = vi.fn().mockResolvedValue('{"sessionId":"s1","modelId":"deepseek/deepseek-v4-pro"}');
	const pi = {
		registerTool: (tool: { name: string; execute: Function }) => registered.push(tool),
		on: vi.fn(),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
	};
	registerExtension(pi as never);
	const ctx = {
		mode: "rpc" as const,
		hasUI: true,
		ui: { select: selectMock },
		modelRegistry: { getAvailable: () => CATALOG },
	};
	return { registered, selectMock, ctx };
}

function createTool(harness: ReturnType<typeof createHarness>) {
	const tool = harness.registered.find((t) => t.name === "create_managed_session");
	if (!tool) throw new Error("create_managed_session not registered");
	return tool;
}

describe("create_managed_session model 参数", () => {
	it("model 进 payload.params（协议 additive 字段透传）", async () => {
		const h = createHarness();
		await createTool(h).execute(
			"call-1",
			{ cwd: "/work", model: "deepseek/deepseek-v4-pro" },
			undefined,
			undefined,
			h.ctx,
		);
		const payload = JSON.parse(h.selectMock.mock.calls[0][1][0]);
		expect(payload.action).toBe("create");
		expect(payload.params.model).toBe("deepseek/deepseek-v4-pro");
		expect(payload.params.cwd).toBe("/work");
		// marker 通道语义不变（validate 前置不改变传输面）
		expect(h.selectMock.mock.calls[0][0]).toBe(SESSION_MANAGER_MARKER);
	});

	it("不传 model → payload.params.model 缺省（旧行为逐字节一致）", async () => {
		const h = createHarness();
		await createTool(h).execute("call-1", { cwd: "/work" }, undefined, undefined, h.ctx);
		const payload = JSON.parse(h.selectMock.mock.calls[0][1][0]);
		expect(payload.params.model).toBeUndefined();
		expect("model" in payload.params).toBe(false);
	});

	it("聚合路由条目放行（ctx.modelRegistry 含 registerVirtualModel 条目）", async () => {
		const h = createHarness();
		await createTool(h).execute(
			"call-1",
			{ cwd: "/work", model: "aggregation/route-3" },
			undefined,
			undefined,
			h.ctx,
		);
		expect(h.selectMock).toHaveBeenCalledTimes(1);
	});

	it("未命中模型 → throw 且零 runtime 往返（创建前拦截，不建会话）", async () => {
		const h = createHarness();
		await expect(
			createTool(h).execute(
				"call-1",
				{ cwd: "/work", model: "deepseek/ds-pro" },
				undefined,
				undefined,
				h.ctx,
			),
		).rejects.toThrow(/is not an available model/);
		expect(h.selectMock).not.toHaveBeenCalled();
	});

	it("大小写不符 → throw（不放行 pi 模糊引擎可解析的歧义值）", async () => {
		const h = createHarness();
		await expect(
			createTool(h).execute(
				"call-1",
				{ cwd: "/work", model: "DeepSeek/deepseek-v4-pro" },
				undefined,
				undefined,
				h.ctx,
			),
		).rejects.toThrow(/is not an available model/);
		expect(h.selectMock).not.toHaveBeenCalled();
	});

	it("ctx 无 modelRegistry（旧 harness / 宿主未提供）→ fail-open 不阻断创建", async () => {
		const h = createHarness();
		const bareCtx = { mode: "rpc" as const, hasUI: true, ui: { select: h.selectMock } };
		await createTool(h).execute(
			"call-1",
			{ cwd: "/work", model: "deepseek/ds-pro" },
			undefined,
			undefined,
			bareCtx as never,
		);
		expect(h.selectMock).toHaveBeenCalledTimes(1);
	});

	it("details.summary 折叠态带模型（GUI 对话流与 pi TUI 同源消费）", async () => {
		const h = createHarness();
		const result = await createTool(h).execute(
			"call-1",
			{ cwd: "/work", label: "research", model: "deepseek/deepseek-v4-pro" },
			undefined,
			undefined,
			h.ctx,
		);
		expect(result.details?.summary).toBe('Created session "research" · deepseek/deepseek-v4-pro');
	});

	it("无 model 时 summary 形态不变（回归锚）", async () => {
		const h = createHarness();
		const result = await createTool(h).execute("call-1", { cwd: "/work" }, undefined, undefined, h.ctx);
		expect(result.details?.summary).toBe("Created session s1");
	});
});
