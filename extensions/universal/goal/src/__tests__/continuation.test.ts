/**
 * goal continuation 行为测试（agent_end 自动续发，验收 §4 A10 的单测）
 *
 * [行为锁定 2026-11-04] 轮次活性熔断（连发 50 次封顶 + 无进展退避 + setTimeout
 * 延迟续发）已删除。当前锁定的发送决策面：
 * a. 有产出（tokenDelta>0）的非 defer 轮 → agent_end 立即发 followUp continuation；
 * b. 空 turn（tokenDelta≤0）→ 不发（去抖仍生效）；
 * c. defer 通知：pending 集合不变的连续 defer 轮中通知条数不增长。
 *
 * fake pi/ctx（不 import Pi SDK 真实实现，harness 对齐 __tests__/event-adapter.test.ts）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { handleAgentEnd } from "../adapters/event-handlers/agent-end";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import { createGoalSession, type GoalSession } from "../session";

// ── Fake pi / ctx（entries 数组可变，模拟 append-only 会话流）──

interface RecordedCall { // oe-exempt:20261105:test:测试夹具单实现接口（fake harness 形态，Rule of Three 不适用）
	kind: "appendState" | "appendHistory" | "notify" | "sendContext";
	payload?: unknown;
	text?: string;
	level?: string;
	content?: unknown;
	customType?: unknown;
	display?: unknown;
}

interface FakeHarness { // oe-exempt:20261105:test:测试夹具单实现接口（fake harness 形态，Rule of Three 不适用）
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	entries: unknown[];
	piCalls: RecordedCall[];
	ctxCalls: RecordedCall[];
}

function makeHarness(): FakeHarness {
	const piCalls: RecordedCall[] = [];
	const ctxCalls: RecordedCall[] = [];
	const entries: unknown[] = [];

	const pi = {
		appendEntry(customType: string, data?: unknown): void {
			piCalls.push({ kind: customType === "goal-history" ? "appendHistory" : "appendState", payload: data });
		},
		sendMessage(message: unknown, options?: unknown): void {
			const msg = message as { content?: unknown; customType?: unknown; display?: unknown };
			piCalls.push({ kind: "sendContext", content: msg.content, customType: msg.customType, display: msg.display, payload: options });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		signal: { aborted: false } as AbortSignal,
		getContextUsage: () => null,
		ui: {
			notify: (text: string, level: string) => ctxCalls.push({ kind: "notify", text, level }),
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => undefined,
			// W4 读侧过滤①消费口（agent-end countActiveFromEntries 传基准）
			getSessionId: () => "test-session",
		},
	} as unknown as ExtensionContext;

	return { pi, ctx, entries, piCalls, ctxCalls };
}

// ── 辅助 ─────────────────────────────────────────────

function makeRunningState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		timeStartedAt: 0, // 关闭时间累计口径（本文件不断言耗时）
		...overrides,
	};
}

/** pending:register custom entry（对齐 countActiveFromEntries 读取契约） */
function pendingRegisterEntry(id: string): unknown {
	return { type: "custom", customType: "pending:register", data: { id, type: "subagent", name: "worker" } };
}

/** 实际发出的 continuation（followUp custom message）计数 */
function followUpSends(h: FakeHarness): RecordedCall[] {
	return h.piCalls.filter(
		(c) => c.kind === "sendContext" && (c.payload as { deliverAs?: string } | undefined)?.deliverAs === "followUp",
	);
}

function notifyTexts(h: FakeHarness, level?: string): string[] {
	return h.ctxCalls.filter((c) => c.kind === "notify" && (!level || c.level === level)).map((c) => c.text!);
}

/** 模拟一个 turn 结束：tokenDelta 注入 + agent_end */
async function runTurn(
	h: FakeHarness,
	session: GoalSession,
	opts: { tokenDelta: number },
): Promise<void> {
	const state = session.state!;
	state.tokensUsed += opts.tokenDelta;
	await handleAgentEnd(h.pi, session, h.ctx);
}

// ── 断言 a：有产出的轮立即续发（无退避、无封顶）────────

describe("continuation 立即续发（无退避定时器、无封顶停发）", () => {
	it("连续有产出（tokenDelta>0）的轮 → 每轮立即发 followUp，无延迟无上限", async () => {
		vi.useFakeTimers();
		try {
			const h = makeHarness();
			const session = createGoalSession();
			session.state = makeRunningState();

			for (let i = 0; i < 60; i++) {
				await runTurn(h, session, { tokenDelta: 200 });
			}
			// 删除后语义：连发不封顶（原 50 次熔断已删），每轮 agent_end 即发
			expect(followUpSends(h)).toHaveLength(60);
			// 无 setTimeout 延迟路径：fake timers 推进不产生额外发送
			vi.advanceTimersByTime(700_000);
			expect(followUpSends(h)).toHaveLength(60);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── 断言 b：空 turn 去抖 ─────────────────────────────

describe("空 turn 去抖", () => {
	it("tokenDelta≤0 的轮 → 不发 continuation（循环自然停止点）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeRunningState();

		await runTurn(h, session, { tokenDelta: 0 });
		await runTurn(h, session, { tokenDelta: 0 });
		expect(followUpSends(h)).toHaveLength(0);
	});
});

// ── 断言 c：defer 通知去重 ───────────────────────────

describe("defer 通知去重", () => {
	it("pending 集合不变的连续 defer 轮中通知条数不增长；集合变化才再发", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeRunningState();
		h.entries.push(pendingRegisterEntry("bg-1"));

		for (let i = 0; i < 3; i++) {
			await runTurn(h, session, { tokenDelta: 200 });
		}
		expect(followUpSends(h)).toHaveLength(0); // defer 轮不发 continuation
		const waitNotifies = () => notifyTexts(h).filter((t) => t.includes("waiting"));
		expect(waitNotifies()).toHaveLength(1); // 集合不变 → 3 轮只通知 1 次
		expect(waitNotifies()[0]).toContain("1 background task");

		// 集合变化（新增 bg-2）→ 再通知一次（含新计数）
		h.entries.push(pendingRegisterEntry("bg-2"));
		await runTurn(h, session, { tokenDelta: 200 });
		expect(waitNotifies()).toHaveLength(2);
		expect(waitNotifies()[1]).toContain("2 background task");

		// 集合再次不变 → 不增长
		await runTurn(h, session, { tokenDelta: 200 });
		expect(waitNotifies()).toHaveLength(2);
	});
});
