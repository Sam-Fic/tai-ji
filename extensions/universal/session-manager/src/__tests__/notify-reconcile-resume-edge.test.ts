// notify-reconcile-resume-edge.test.ts —— session-manager 域切回边沿订阅装配锁
// （completion-signal-delivery D8② 三入口同构的切回补强边沿，U2 修复回归）：
// extension load 装配期经 pi-delivery-port 进程级注册槽订阅切回派发——漏挂 =
// 「进程存活 + rejected + 用户切走再切回」场景补投不触发的缺陷形态（入口①②
// 在该场景不可达：切回不重发 session_start、无新回合则 agent_settled 不达）。
//
// 观察点：mock ./notify-reconcile.ts 的 runNotifyReconcileMaintenance（编排本体
// 行为在 notify-reconcile.test.ts 直测权威，本文件只锁装配接线面）——default
// export 执行后 dispatchResumeReconcile（真实槽）应驱动本域闭包以 reason="resume"
// 调编排，且 deps 的 entries / sessionFile 从派发 ctx 现读。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reconcileMock } = vi.hoisted(() => ({
	reconcileMock: vi.fn(() => ({
		scanned: 0,
		candidates: 0,
		redelivered: [],
		skippedDelivered: [],
		skippedJournaled: [],
	})),
}));

vi.mock("../notify-reconcile.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../notify-reconcile.ts")>();
	return { ...actual, runNotifyReconcileMaintenance: reconcileMock };
});

import {
	_resetResumeReconcileForTest,
	dispatchResumeReconcile,
	type ResumeReconcileContext,
} from "@zhushanwen/pi-delivery-port";

import registerExtension from "../index.ts";

function makeMockPi() {
	return {
		registerTool: vi.fn(),
		on: vi.fn(),
		appendEntry: vi.fn(),
	} as never;
}

function makeEdgeCtx(): ResumeReconcileContext {
	return {
		sessionManager: {
			getEntries: () => [{ customType: "pending:register", data: { id: "sm-r1", type: "session", name: "worker" } }],
			getSessionFile: () => "/sessions/edge.jsonl",
			getSessionId: () => "sess-edge",
		},
	};
}

beforeEach(() => {
	_resetResumeReconcileForTest();
	reconcileMock.mockClear();
});

afterEach(() => {
	_resetResumeReconcileForTest();
});

describe("session-manager 域切回边沿订阅（D8② 入口③，U2 修复）", () => {
	it("extension load 后切回派发 → 本域对账闭包以 reason=resume 调编排，deps 从派发 ctx 现读", () => {
		registerExtension(makeMockPi());
		const ctx = makeEdgeCtx();

		const failures = dispatchResumeReconcile(ctx);

		expect(failures).toEqual([]);
		expect(reconcileMock).toHaveBeenCalledTimes(1);
		const deps = reconcileMock.mock.calls[0][0] as {
			reason: string;
			entries: readonly unknown[];
			sessionFile: string | undefined;
		};
		expect(deps.reason).toBe("resume");
		expect(deps.entries).toEqual(ctx.sessionManager.getEntries());
		expect(deps.sessionFile).toBe("/sessions/edge.jsonl");
	});

	it("重复 load（同进程 session 替换形态）覆盖旧订阅：派发只打新闭包一次（无死 handler 双派发）", () => {
		registerExtension(makeMockPi());
		registerExtension(makeMockPi());

		expect(dispatchResumeReconcile(makeEdgeCtx())).toEqual([]);
		expect(reconcileMock).toHaveBeenCalledTimes(1);
	});

	it("未 load 本扩展时空槽派发零调用（扩展禁用形态，缺席语义非错误）", () => {
		expect(dispatchResumeReconcile(makeEdgeCtx())).toEqual([]);
		expect(reconcileMock).not.toHaveBeenCalled();
	});
});
