/**
 * engine/liveness.ts 纯函数测试 — defer 通知去重判定单元
 *
 * 覆盖：pending 集合变化判定。行为级 defer 去重（经 handleAgentEnd）
 * 见 circuit-breaker.test.ts。
 */
import { describe, expect, it } from "vitest";

import { pendingSetChanged } from "../engine/liveness";
import { createGoalState } from "../engine/goal";

// ── pending 集合变化 ─────────────────────────────────

describe("pendingSetChanged", () => {
	it("集合相同（含顺序不同）→ 无变化", () => {
		expect(pendingSetChanged(["a", "b"], ["b", "a"])).toBe(false);
		expect(pendingSetChanged([], [])).toBe(false);
	});

	it("首次进入 defer（last 为空）或有增删 → 变化", () => {
		expect(pendingSetChanged(["a"], [])).toBe(true);
		expect(pendingSetChanged(["a"], ["a", "b"])).toBe(true);
		expect(pendingSetChanged(["a", "c"], ["a", "b"])).toBe(true);
	});
});

// ── createGoalState 初始化 ───────────────────────────

describe("createGoalState — defer 去重锚初始化", () => {
	it("新 goal 的 defer 去重锚从空集开始", () => {
		const state = createGoalState("obj");
		expect(state.lastDeferredPendingIds).toEqual([]);
	});
});
