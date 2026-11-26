/**
 * same-model 压缩调用通道测试（C-pi-19）。
 *
 * 事故背景（2026-11-23，会话 01a2077f）：会话模型是 provider-aggregation 的虚拟模型
 * （`aggregation/step-5-preview`，`api === "pi-virtual"`），本文件被测函数原先经
 * `@earendil-works/pi-ai/compat` 的 `completeSimple` 发请求——compat 是静态目录分发层
 * （按 `model.api` 查 api registry），不认识 `pi-virtual`，恒抛
 * `No API provider registered for api: pi-virtual`；后台压缩因此连续失败三次熔断，
 * 且错误只进 warn 日志、用户只看到「摘要生成未返回结果」。
 *
 * 本文件的防线（形态选择：直接驱动真实实装，不 mock 通道本身）：
 * 1. 生产通道必须是 `ctx.modelRegistry.streamSimple` —— 每例都断言该 mock 被调用、
 *    且兼容层（compat）不参与（本模块已无 compat import，编译期即锁）；
 * 2. 虚拟模型（api="pi-virtual"）原样交给 registry（由 pi 侧 `isVirtualModel` 分支 route）；
 * 3. 失败诊断：`stopReason="error"` 且 content 为空时取 `errorMessage`
 *    （lazyStream setup 失败的唯一载荷），否则错误原因全丢。
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callSameModelCompaction, projectTools } from "../llm.ts";

/** 记录调用参数的 streamSimple 替身（返回 pi 的 AssistantMessageEventStream 的最小子集）。 */
const streamSimple = vi.fn<(model: unknown, context: unknown, options?: unknown) => { result: () => Promise<unknown> }>();

function resolveWith(message: unknown): void {
	streamSimple.mockImplementation(() => ({ result: async () => message }));
}

function makeModel(overrides: { provider?: string; id?: string; api?: string } = {}): Model<never> {
	return {
		provider: overrides.provider ?? "zai",
		id: overrides.id ?? "glm",
		api: overrides.api ?? "openai-completions",
	} as unknown as Model<never>;
}

function makeCtx(auth: unknown, thinkingLevel?: string): ExtensionContext {
	return {
		thinkingLevel,
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () => auth),
			streamSimple,
		},
	} as unknown as ExtensionContext;
}

/** 最小可用的调用入参（各例只覆盖关心的字段）。 */
function makeOpts(overrides: Partial<Parameters<typeof callSameModelCompaction>[1]> = {}) {
	return {
		model: makeModel(),
		systemPrompt: "sys",
		messages: [],
		tools: [],
		...overrides,
	};
}

beforeEach(() => {
	streamSimple.mockReset();
});

describe("same-model 调用通道（C-pi-19：经 ctx.modelRegistry，不直连 compat）", () => {
	it("成功 → 经 modelRegistry.streamSimple 发起，context 带 systemPrompt/tools，options 带 apiKey", async () => {
		resolveWith({ stopReason: "stop", content: [{ type: "text", text: "  summary body  " }] });
		const ctx = makeCtx({ ok: true, apiKey: "k" });

		const result = await callSameModelCompaction(ctx, makeOpts({ tools: [{ name: "t", description: "d", parameters: {} } as never] }));

		expect(result).toEqual({ ok: true, text: "summary body", usage: undefined, stopReason: "stop" });
		expect(streamSimple).toHaveBeenCalledTimes(1);
		const [callModel, callContext, callOptions] = streamSimple.mock.calls[0]!;
		expect((callModel as { id: string }).id).toBe("glm");
		expect(callContext).toMatchObject({
			systemPrompt: "sys",
			messages: [],
			tools: [{ name: "t", description: "d" }],
		});
		expect(callOptions).toMatchObject({ apiKey: "k" });
	});

	it("聚合虚拟模型（api=pi-virtual）原样交给 registry —— 由 pi 侧 isVirtualModel 分支完成路由", async () => {
		resolveWith({ stopReason: "stop", content: [{ type: "text", text: "s" }] });
		const virtual = makeModel({ provider: "aggregation", id: "step-5-preview", api: "pi-virtual" });

		const result = await callSameModelCompaction(makeCtx({ ok: true, apiKey: "k" }), makeOpts({ model: virtual }));

		expect(result.ok).toBe(true);
		// 事故回归点：模型对象必须原样递给 registry（它认识 pi-virtual）；显示层 provider/id 不变
		expect((streamSimple.mock.calls[0]![0] as { api: string }).api).toBe("pi-virtual");
		expect((streamSimple.mock.calls[0]![0] as { provider: string }).provider).toBe("aggregation");
	});

	it("reasoning 与会话同值透传（虚拟模型分支用它求路由档位；缺省会被算成 off → 前缀缓存 miss）", async () => {
		resolveWith({ stopReason: "stop", content: [{ type: "text", text: "s" }] });

		await callSameModelCompaction(makeCtx({ ok: true, apiKey: "k" }, "max"), makeOpts({ reasoning: "max" }));

		expect(streamSimple.mock.calls[0]![2]).toMatchObject({ reasoning: "max" });
	});

	it("reasoning 未提供 → options 不含该字段（条件 spread，与主会话缺省对齐）", async () => {
		resolveWith({ stopReason: "stop", content: [{ type: "text", text: "s" }] });

		await callSameModelCompaction(makeCtx({ ok: true, apiKey: "k" }), makeOpts());

		expect("reasoning" in (streamSimple.mock.calls[0]![2] as object)).toBe(false);
	});
});

describe("失败归一与诊断载荷", () => {
	it("stopReason=error 且 content 空 → error 取 errorMessage（虚拟模型路由失败的唯一诊断载荷）", async () => {
		resolveWith({
			stopReason: "error",
			content: [],
			errorMessage: '模型路由 "step-5-preview"（Step）：当前无可用端点',
		});

		const result = await callSameModelCompaction(makeCtx({ ok: true, apiKey: "k" }), makeOpts());

		expect(result).toEqual({
			ok: false,
			error: '模型路由 "step-5-preview"（Step）：当前无可用端点',
			stopReason: "error",
		});
	});

	it("content 有错误文本时优先于 errorMessage（provider 把错误写进 text 块的既有形态）", async () => {
		resolveWith({
			stopReason: "error",
			content: [{ type: "text", text: "429 rate limited" }],
			errorMessage: "fallback",
		});

		const result = await callSameModelCompaction(makeCtx({ ok: true, apiKey: "k" }), makeOpts());

		expect(result).toMatchObject({ ok: false, error: "429 rate limited" });
	});

	it("stopReason=aborted 同样归一为失败（调用方不落半截 checkpoint）", async () => {
		resolveWith({ stopReason: "aborted", content: [] });

		const result = await callSameModelCompaction(makeCtx({ ok: true, apiKey: "k" }), makeOpts());

		expect(result).toMatchObject({ ok: false, error: "stopReason=aborted", stopReason: "aborted" });
	});

	it("stopReason=length 仍 ok:true（截断 fail-closed 是调用方职责，D13-2）", async () => {
		resolveWith({ stopReason: "length", content: [{ type: "text", text: "half" }] });

		const result = await callSameModelCompaction(makeCtx({ ok: true, apiKey: "k" }), makeOpts());

		expect(result).toMatchObject({ ok: true, text: "half", stopReason: "length" });
	});

	it("无当前模型 → {ok:false, error:'no current model'}，不发起调用", async () => {
		const result = await callSameModelCompaction(makeCtx({ ok: true }), makeOpts({ model: undefined }));

		expect(result).toEqual({ ok: false, error: "no current model" });
		expect(streamSimple).not.toHaveBeenCalled();
	});

	it("凭证失败 → {ok:false} 携 auth 错误，不发起调用", async () => {
		const result = await callSameModelCompaction(makeCtx({ ok: false, error: "no key" }), makeOpts());

		expect(result).toEqual({ ok: false, error: "no key" });
		expect(streamSimple).not.toHaveBeenCalled();
	});

	it("通道抛出 → 归一为 {ok:false}（含虚拟模型未注册等 setup 异常），不向上抛", async () => {
		streamSimple.mockImplementation(() => {
			throw new Error("Virtual model aggregation/x is not registered.");
		});

		const result = await callSameModelCompaction(makeCtx({ ok: true, apiKey: "k" }), makeOpts());

		expect(result).toMatchObject({ ok: false, error: "Virtual model aggregation/x is not registered." });
	});
});

describe("projectTools（缓存对齐派生视图）", () => {
	it("三字段直取：name/description/parameters 原样透传（不改造 schema）", () => {
		const parameters = { type: "object", properties: { a: { type: "string" } } };

		expect(projectTools([{ name: "t", description: "d", parameters } as never])).toEqual([
			{ name: "t", description: "d", parameters },
		]);
	});
});
