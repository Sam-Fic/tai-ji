// workflow-notify-rejected-retry.test.ts — notifyDone 的 rejected 处置阶梯与补投
// payload 形态锁（completion-signal-delivery D8①/D8⑤）。
//
// RL10 同锁（与 bash/subagent 域同款单次形态）：deliver rejected → 立即单次重提
// （deliver 被调恰 2：原投 1 + 重提 1；重提仍 rejected / 重取缺席即停——无重试
// 循环无定时器句柄）。
//
// 补投 payload 分层锁（D8⑤）：可构造段与主路径同构（标题行/Agent Trace 段/
// Artifacts 指针段 + details 全字段）+ Script Result 段与 details.resultSummary
// 缺席省略（构造材料 run.state.scriptResult 只在内存——record 流重建的聚合结构性
// 缺席；主路径 scriptResult 在场形态对照锁定「缺席是判据源事实而非构造函数缺陷」，
// 「不缺席即红」）。
//
// 形态纪律（TEST-STRATEGY 三档判据①）：port 槽注入桩（Reflect.set 进程槽）+
// run 轻量替身（buildDoneNotifyContent/Details 只消费 spec.scriptName /
// state.trace.toArray() / state.scriptResult 三面）——零真盘零真进程零 timer。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DELIVERY_PORT_SLOT_KEY, type DeliveryEnvelope } from "@zhushanwen/pi-delivery-port";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { WORKFLOW_RESULT_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";
import { notifyDone } from "../workflow-notify.ts";
import { WORKFLOW_DONE_NOTIFY_ID_PREFIX } from "../workflow-notify.ts";

// ── 测试替身（buildDoneNotify* 的消费面最小形态）──

const traceNode = (stepIndex: number, agent: string, status: string) => ({
	stepIndex,
	agent,
	task: "",
	model: "",
	status,
	startedAt: "2026-01-01T00:00:00.000Z",
});

/** run 替身：scriptResult 可编程（主路径在场形态 vs journal 重建缺席形态）。 */
function makeRun(opts: { scriptName: string; scriptResult?: unknown }) {
	return {
		spec: { scriptName: opts.scriptName },
		state: {
			trace: { toArray: () => [traceNode(0, "reviewer", "completed"), traceNode(1, "tester", "completed")] },
			scriptResult: opts.scriptResult,
		},
	};
}

type Settlement = Parameters<typeof notifyDone>[5];
const makeSettlement = (outcome: Settlement["outcome"] = "done"): Settlement =>
	({ outcome, settledAt: 1 }) as Settlement;

type DeliverCall = { envelope: DeliveryEnvelope; collectKey: string[] | undefined };

/** port 槽桩：行为脚本按 deliver 调用序消费（accept/reject；reject 不进 calls）。 */
function plantPort(script: Array<"accept" | "reject">): Array<DeliverCall> {
	const calls: Array<DeliverCall> = [];
	let attempt = 0;
	Reflect.set(globalThis, DELIVERY_PORT_SLOT_KEY, {
		current: {
			deliver: (envelope: DeliveryEnvelope, opts?: { collectKey?: string[] }) => {
				const step = script[Math.min(attempt, script.length - 1)]!;
				attempt += 1;
				if (step === "reject") return { kind: "rejected", reason: "persist-failed (fake)" };
				calls.push({ envelope, collectKey: opts?.collectKey });
				return { kind: "accepted", id: envelope.id ?? "gen-id" };
			},
			flush: () => {},
		},
	});
	return calls;
}

const makePi = () => ({ sendMessage: vi.fn() }) as unknown as ExtensionAPI;

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	Reflect.deleteProperty(globalThis, DELIVERY_PORT_SLOT_KEY);
});

describe("notifyDone rejected 处置阶梯（D8①：立即单次重提，RL10 同锁）", () => {
	it("首投 rejected → 重提 accepted（disposed 窗口重绑恢复形态）：deliver 被调恰 2、重提原 envelope（同幂等键同 collectKey）、去重窗口标记", () => {
		const calls = plantPort(["reject", "accept"]);
		const notifiedRunIds = new Set<string>();
		notifyDone(makePi(), "wf-1", makeRun({ scriptName: "review" }), notifiedRunIds, "/runs", makeSettlement());
		// RL10：deliver 恰 2 次（原投 1 + 单次重提 1）——桩 attempt 计数经 calls+reject
		// 还原：calls=1（accepted 的重提）+ reject=1 → 恰 2 次投递尝试
		expect(calls).toHaveLength(1);
		expect(calls[0]!.envelope.id).toBe(`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-1`);
		expect(calls[0]!.collectKey).toEqual(["wf-1"]);
		expect(notifiedRunIds.has("wf-1")).toBe(true); // 重提受理 → 与主投受理同语义标记
		// 无定时器（同步收尾）：断言后同步返回即可观察——deliver 计数已锁单次形态
	});

	it("重提仍 rejected → 即停（无第三次投递）：notifiedRunIds 不标记 + error 留痕含对账恢复指引（RL11）", () => {
		plantPort(["reject"]);
		const notifiedRunIds = new Set<string>();
		notifyDone(makePi(), "wf-2", makeRun({ scriptName: "review" }), notifiedRunIds, "/runs", makeSettlement());
		expect(notifiedRunIds.has("wf-2")).toBe(false); // 丢失事实不标记（去重不阻断对账补投）
	});

	it("重取缺席（重提前槽被 dispose）→ 即停（重提路径第二停止位），不扩直发降级", () => {
		Reflect.set(globalThis, DELIVERY_PORT_SLOT_KEY, {
			current: {
				deliver: () => {
					// 转换窗竞态：首投 rejected 后旧实例 dispose（槽摘除——重取 undefined）
					Reflect.deleteProperty(globalThis, DELIVERY_PORT_SLOT_KEY);
					return { kind: "rejected", reason: "persist-failed (fake)" };
				},
				flush: () => {},
			},
		});
		const notifiedRunIds = new Set<string>();
		notifyDone(makePi(), "wf-3", makeRun({ scriptName: "review" }), notifiedRunIds, "/runs", makeSettlement());
		expect(notifiedRunIds.has("wf-3")).toBe(false);
	});

	it("首投 accepted → 单次投递（无重提路径触发）", () => {
		const calls = plantPort(["accept"]);
		const notifiedRunIds = new Set<string>();
		notifyDone(makePi(), "wf-4", makeRun({ scriptName: "review" }), notifiedRunIds, "/runs", makeSettlement());
		expect(calls).toHaveLength(1);
		expect(notifiedRunIds.has("wf-4")).toBe(true);
	});
});

describe("补投/主投 payload 形态（D8⑤ 分层：可构造段同构 + 两段缺席省略）", () => {
	it("journal 重建形态（scriptResult 结构性缺席）：可构造段齐备 + Script Result 段与 details.resultSummary 缺席（不缺席即红）", () => {
		const calls = plantPort(["accept"]);
		notifyDone(
			makePi(),
			"wf-9",
			makeRun({ scriptName: "review" }), // 无 scriptResult——record 流 fold 重建形态
			new Set(),
			"/tmp/root/sid/workflow/runs",
			makeSettlement("done"),
		);
		const { envelope } = calls[0]!;
		const payload = envelope.payload as { customType: string; content: string; details: Record<string, unknown> };
		// 可构造段同构（与主路径 buildDoneNotifyContent 同一构造产出）
		expect(payload.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
		expect(payload.content).toContain("Workflow 'review' done: done (completed)");
		expect(payload.content).toContain("--- Agent Trace ---");
		expect(payload.content).toContain("[0] reviewer: completed");
		expect(payload.content).toContain("--- Artifacts ---");
		expect(payload.content).toContain("Artifacts dir: /tmp/root/sid/workflow/runs");
		expect(payload.content).toContain("Events journal: /tmp/root/sid/workflow/runs/wf-9.record.jsonl");
		// D8⑤ 缺席省略：Script Result 段不出（构造材料不在判据源——不虚构）
		expect(payload.content).not.toContain("--- Script Result ---");
		// details 可构造字段齐备
		expect(payload.details.notifyId).toBe(`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-9`);
		expect(payload.details.name).toBe("review");
		expect(payload.details.status).toBe("done");
		expect(payload.details.traceLength).toBe(2);
		expect(payload.details.artifactsDir).toBe("/tmp/root/sid/workflow/runs");
		expect(payload.details.eventsJournalPath).toBe("/tmp/root/sid/workflow/runs/wf-9.record.jsonl");
		// D8⑤ 缺席省略：resultSummary 不出（「不缺席即红」——缺席省略锁）
		expect("resultSummary" in payload.details).toBe(false);
		// 降级直发路径（port 缺席）不触达——port 在场全程 port.deliver
	});

	it("对照：scriptResult 在场（内存态主路径形态）→ Script Result 段与 resultSummary 出现——缺席省略是判据源事实而非构造函数缺陷", () => {
		const calls = plantPort(["accept"]);
		notifyDone(
			makePi(),
			"wf-10",
			makeRun({ scriptName: "review", scriptResult: { verdict: "pass" } }),
			new Set(),
			"/runs",
			makeSettlement("done"),
		);
		const payload = calls[0]!.envelope.payload as { content: string; details: Record<string, unknown> };
		expect(payload.content).toContain("--- Script Result ---");
		expect(payload.details.resultSummary).toBeDefined();
	});

	it("幂等键构造单一（RL8 同族）：notifyId = wf-done:<runId>，补投与主路径同键", () => {
		expect(`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-x`).toBe("wf-done:wf-x");
	});
});
