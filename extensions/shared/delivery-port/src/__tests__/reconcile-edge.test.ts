// reconcile-edge.test.ts —— 切回边沿对账转发注册槽（completion-signal-delivery
// D8② 三入口同构的跨扩展接线件）行为锁：订阅派发 / 多域分发 / 同域覆盖（reload
// 生命周期）/ 域隔离围栏（单域 throw 不阻断其余域 + 失败清单报告）/ 空槽缺席
// 语义 / 测试重置。槽挂 globalThis（C-ext-06），跨实例共享由 Symbol.for 键保证。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	RESUME_RECONCILE_SLOT_KEY,
	_resetResumeReconcileForTest,
	dispatchResumeReconcile,
	subscribeResumeReconcile,
	type ResumeReconcileContext,
} from "../reconcile-edge.ts";

function makeCtx(): ResumeReconcileContext {
	return {
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => "/sessions/slot.jsonl",
			getSessionId: () => "sess-slot",
		},
	};
}

beforeEach(() => {
	_resetResumeReconcileForTest();
});

afterEach(() => {
	_resetResumeReconcileForTest();
});

describe("subscribeResumeReconcile / dispatchResumeReconcile", () => {
	it("订阅后派发：listener 收到 ctx 原样引用", () => {
		const listener = vi.fn();
		subscribeResumeReconcile("session-manager", listener);
		const ctx = makeCtx();

		const failures = dispatchResumeReconcile(ctx);

		expect(failures).toEqual([]);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith(ctx);
	});

	it("多域订阅全部收到（Map 插入序派发）", () => {
		const calls: string[] = [];
		subscribeResumeReconcile("session-manager", () => calls.push("session-manager"));
		subscribeResumeReconcile("subagent-workflow", () => calls.push("subagent-workflow"));

		expect(dispatchResumeReconcile(makeCtx())).toEqual([]);
		expect(calls).toEqual(["session-manager", "subagent-workflow"]);
	});

	it("同域重复订阅覆盖前值（extension reload 生命周期：新闭包覆盖旧闭包，旧订阅不再收）", () => {
		const stale = vi.fn();
		const fresh = vi.fn();
		subscribeResumeReconcile("subagent-workflow", stale);
		subscribeResumeReconcile("subagent-workflow", fresh);

		expect(dispatchResumeReconcile(makeCtx())).toEqual([]);
		expect(stale).not.toHaveBeenCalled();
		expect(fresh).toHaveBeenCalledTimes(1);
	});

	it("单域 listener throw 不阻断其余域：失败逐域收集返回（派发方 warn 留痕的报告通道）", () => {
		const boom = new Error("listener fence leak");
		const healthy = vi.fn();
		subscribeResumeReconcile("session-manager", () => {
			throw boom;
		});
		subscribeResumeReconcile("subagent-workflow", healthy);

		const failures = dispatchResumeReconcile(makeCtx());

		expect(failures).toEqual([{ domain: "session-manager", error: boom }]);
		expect(healthy).toHaveBeenCalledTimes(1);
	});

	it("空槽派发（两域扩展未启用 / 装配前）→ 空失败清单，不抛（缺席语义非错误）", () => {
		expect(dispatchResumeReconcile(makeCtx())).toEqual([]);
	});

	it("_resetResumeReconcileForTest 清空全部订阅", () => {
		const listener = vi.fn();
		subscribeResumeReconcile("session-manager", listener);
		_resetResumeReconcileForTest();

		expect(dispatchResumeReconcile(makeCtx())).toEqual([]);
		expect(listener).not.toHaveBeenCalled();
	});

	it("槽挂 globalThis（C-ext-06：Symbol.for 进程级槽，防 jiti 多实例槽分裂）", () => {
		subscribeResumeReconcile("session-manager", () => {});
		const slot = Reflect.get(globalThis, RESUME_RECONCILE_SLOT_KEY) as {
			listeners: Map<string, unknown>;
		} | undefined;
		expect(slot).toBeDefined();
		expect(slot!.listeners.has("session-manager")).toBe(true);
	});
});
