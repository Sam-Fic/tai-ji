// model-param.test.ts — create_managed_session 的 `model` 前置校验
//
// 覆盖四类：① 精确匹配放行（含聚合路由条目形态）；② 未命中 / 大小写不符 →
// throw 且错误文本列出可用模型（agent 可一次重发自纠）；③ fail-open 三态
// （source 缺席 / getAvailable 抛错 / 空目录）不阻断创建；④ 清单截断上限。

import { describe, it, expect } from "vitest";
import { assertModelAvailable } from "../model-param.ts";

/** 目录 stub（duck 类型：只提供 getAvailable，结构满足形参） */
function source(models: Array<{ provider: string; id: string }>) {
	return { getAvailable: () => models };
}

const CATALOG: Array<{ provider: string; id: string }> = [
	{ provider: "deepseek", id: "deepseek-v4-pro" },
	{ provider: "aggregation", id: "route-3" },
	{ provider: "anthropic", id: "claude-sonnet-5" },
];

describe("assertModelAvailable", () => {
	it("undefined → 放行（缺省 = 默认模型档，不校验）", () => {
		expect(() => assertModelAvailable(undefined, source(CATALOG))).not.toThrow();
	});

	it("全等匹配 → 放行（provider 与 id 均区分大小写）", () => {
		expect(() => assertModelAvailable("deepseek/deepseek-v4-pro", source(CATALOG))).not.toThrow();
	});

	it("聚合路由条目（registerVirtualModel 注册形态）→ 放行", () => {
		expect(() => assertModelAvailable("aggregation/route-3", source(CATALOG))).not.toThrow();
	});

	it("未命中 → throw，错误文本列可用模型 + 精确匹配要求 + 省略指引", () => {
		expect(() => assertModelAvailable("deepseek/ds-pro", source(CATALOG))).toThrow(
			/model "deepseek\/ds-pro" is not an available model/,
		);
		try {
			assertModelAvailable("deepseek/ds-pro", source(CATALOG));
			expect.unreachable("should have thrown");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("deepseek/deepseek-v4-pro");
			expect(msg).toContain("aggregation/route-3");
			expect(msg).toContain("case-sensitive");
			expect(msg).toContain('Omit "model"');
		}
	});

	it("大小写不符 → throw（pi 模糊引擎会解析到别的条目，agent 侧不放行歧义）", () => {
		expect(() => assertModelAvailable("DeepSeek/deepseek-v4-pro", source(CATALOG))).toThrow(
			/is not an available model/,
		);
	});

	it("缺 provider 段 / 空串 → throw（不是可用目录条目）", () => {
		expect(() => assertModelAvailable("deepseek-v4-pro", source(CATALOG))).toThrow();
		expect(() => assertModelAvailable("", source(CATALOG))).toThrow();
	});

	it("fail-open：source 缺席 → 不阻断（宿主未提供 registry）", () => {
		expect(() => assertModelAvailable("whatever/x", undefined)).not.toThrow();
	});

	it("fail-open：getAvailable 抛错 → 不阻断（不把宿主故障升级成参数错误）", () => {
		const broken = {
			getAvailable(): Array<{ provider: string; id: string }> {
				throw new Error("registry not ready");
			},
		};
		expect(() => assertModelAvailable("whatever/x", broken)).not.toThrow();
	});

	it("fail-open：空目录 → 不阻断（无法证明无效即放行，子进程自行 surfaced）", () => {
		expect(() => assertModelAvailable("whatever/x", source([]))).not.toThrow();
	});

	it("可用模型超过上限时错误文本截断（防超长清单撑爆上下文）", () => {
		const many = Array.from({ length: 25 }, (_, i) => ({ provider: "p", id: `m${i}` }));
		try {
			assertModelAvailable("p/nope", source(many));
			expect.unreachable("should have thrown");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("Available models (25)");
			expect(msg).toContain("m19"); // 第 20 条在场
			expect(msg).not.toContain("m20"); // 第 21 条被截断
			expect(msg).toContain("…");
		}
	});
});
