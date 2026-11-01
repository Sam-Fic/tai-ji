// workflow-notify-reconcile.test.ts — workflow 域通知对账步的判据与补投编排
// （completion-signal-delivery D8：SC11 run journal/manifest 事实源 + 域过滤构造性
// + 预检短路成本下界 + 幂等收敛）。
//
// 全部逻辑层（TEST-STRATEGY 三档判据①②）：entries 注入 + settledRecordOf/loadRuns
// 注入桩（编排 deps 面零真盘）+ notifyDone 经 vi.mock 部分替身（补投出口观察点）。
// entries 形态锚定落盘契约（workflow-record v2 条目 / workflow-result 通知条目
// / delivery-port outbox-ack v2 条目）。
//
// 覆盖面（验收条款 3「域过滤与四项读取规则判据单测」本域对应 + 验收条款 4
// 检查点机械项）：判据真值表（骨架同构对拍）；manifest 面（v2 注册条目提取 +
// recordPath 锚点后缀防旧形态 + settled/畸形跳过）；域过滤构造性（候选源只认
// workflow-record customType——写方单域）；送达痕迹双通道（notifyId/deliveryId）；
// 投递日志承载（id ∪ collectKey）；终局事实核（settledRecordOf undefined =
// skippedNotTerminal 保守 miss）；预检短路（候选空零 loadRuns）；幂等收敛；
// rejected 注释自述的手工补偿路径同一事实源（SC11）自动化锁。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workflow-notify.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../workflow-notify.ts")>();
	return { ...actual, notifyDone: vi.fn() };
});

import { ACK_CUSTOM_TYPE, OUTBOX_CUSTOM_TYPE } from "@zhushanwen/pi-delivery-port";
import { WORKFLOW_RECORD_CUSTOM_TYPE, RUN_EVENTS_SUFFIX } from "@zhushanwen/subagent-core";

import { WORKFLOW_RESULT_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";
import { notifyDone } from "../workflow-notify.ts";
import {
	buildDoneNotifyId,
	collectDeliveredWorkflowNotifyIds,
	collectJournaledDeliveryIds,
	collectRegisteredWorkflowRuns,
	isReconcileNotifyCandidate,
	runNotifyReconcileMaintenance,
	type ReconcileNotifyFacts,
} from "../workflow-notify-reconcile.ts";

// notifyDone 是跨用例共享的模块 mock——调用历史每用例清零（not.toHaveBeenCalled
// 断言的口径 = 本用例内零调用）
beforeEach(() => {
	vi.clearAllMocks();
});

// ── entries 构造（落盘契约锚定形态）──

function registeredEntry(runId: string, recordPath = `/runs/${runId}${RUN_EVENTS_SUFFIX}`): unknown {
	return {
		type: "custom",
		customType: WORKFLOW_RECORD_CUSTOM_TYPE,
		data: {
			v: 2,
			kind: "registered",
			runId,
			workflowName: "review",
			scriptName: "review",
			slug: "review",
			startedAt: 1,
			recordPath,
		},
	};
}

function settledEntry(runId: string): unknown {
	return {
		type: "custom",
		customType: WORKFLOW_RECORD_CUSTOM_TYPE,
		data: { v: 2, kind: "settled", runId, reason: "completed", outcome: "done", settledAt: 2, callCount: 1, usedTokens: 0 },
	};
}

function notifyEntry(notifyId: string): unknown {
	return {
		type: "custom",
		customType: WORKFLOW_RESULT_CUSTOM_TYPE,
		content: "x",
		display: true,
		details: { notifyId, runId: "unrelated", name: "x", status: "done", traceLength: 1 },
	};
}

function outboxEntry(id: string, collectKey?: string[]): unknown {
	return {
		type: "custom",
		customType: OUTBOX_CUSTOM_TYPE,
		data: {
			v: 2,
			id,
			timing: "steer",
			payload: { kind: "custom", customType: WORKFLOW_RESULT_CUSTOM_TYPE, content: "x", display: true },
			recordedAt: 1,
			...(collectKey !== undefined ? { collectKey } : {}),
		},
	};
}

function ackEntry(id: string): unknown {
	return { type: "custom", customType: ACK_CUSTOM_TYPE, data: { v: 2, id, outcome: "delivered" } };
}

/** 编排 deps 最小形态：终局事实注入 + 聚合重建注入（零真盘）。 */
function makeDeps(entries: unknown[], opts?: { settlement?: unknown; runs?: unknown[] }) {
	return {
		reason: "test",
		pi: { sendMessage: vi.fn() },
		entries,
		notifiedRunIds: new Set<string>(),
		// 显式传 settlement: undefined = 「终局事实缺席」形态（in 判定不回退默认值）
		settledRecordOf: vi.fn(() =>
			opts && "settlement" in opts ? opts.settlement : { outcome: "done", settledAt: 1 },
		),
		loadRuns: vi.fn(async () => opts?.runs ?? [makeRun("wf-1")]),
	};
}

function makeRun(runId: string) {
	return {
		runId,
		spec: { scriptName: "review" },
		state: {
			trace: { toArray: () => [{ stepIndex: 0, agent: "reviewer", task: "", model: "", status: "completed", startedAt: "" }] },
			scriptResult: undefined,
		},
	};
}

// ── 骨架真值表（同构对拍）──

describe("isReconcileNotifyCandidate 骨架真值表（跨域同构——u1 单源对拍）", () => {
	const base: ReconcileNotifyFacts = {
		isTerminal: true,
		excludedByOrigin: false,
		delivered: false,
		journaled: false,
	};
	const truthTable: Array<[Partial<ReconcileNotifyFacts>, boolean, string]> = [
		[{ ...base }, true, "rejected 丢失形态（四事实全命中）→ 候选"],
		[{ isTerminal: false }, false, "run 未终局（无 run-settled 帧）→ 非候选"],
		[{ excludedByOrigin: true }, false, "域排除位命中 → 非候选"],
		[{ delivered: true }, false, "送达痕迹命中 → 非候选"],
		[{ journaled: true }, false, "投递日志承载命中 → 非候选"],
	];
	for (const [facts, expected, label] of truthTable) {
		it(label, () => {
			expect(isReconcileNotifyCandidate({ ...base, ...facts })).toBe(expected);
		});
	}
});

// ── manifest 面（SC11）──

describe("collectRegisteredWorkflowRuns（manifest 面定界——loadAll 发现通道同源）", () => {
	it("v2 注册条目提取 runId + recordPath；settled 条目/畸形条目/词表外条目跳过", () => {
		const runs = collectRegisteredWorkflowRuns([
			registeredEntry("wf-a"),
			settledEntry("wf-b"),
			{ type: "custom", customType: WORKFLOW_RECORD_CUSTOM_TYPE, data: { broken: true } },
			{ type: "custom", customType: "pending:register", data: { id: "x", type: "workflow" } }, // 域外条目
			null,
		]);
		expect(runs).toEqual([{ runId: "wf-a", recordPath: `/runs/wf-a${RUN_EVENTS_SUFFIX}` }]);
	});

	it("recordPath 锚点后缀防旧形态（旧 journal 锚点 = 历史 run，与 loadAll 同款跳过）", () => {
		const runs = collectRegisteredWorkflowRuns([
			registeredEntry("wf-legacy", "/runs/wf-legacy.events.jsonl"),
			registeredEntry("wf-new"),
		]);
		expect(runs).toEqual([{ runId: "wf-new", recordPath: `/runs/wf-new${RUN_EVENTS_SUFFIX}` }]);
	});
});

// ── 送达痕迹 / 投递日志承载 ──

describe("送达痕迹与投递日志承载收集器", () => {
	it("collectDeliveredWorkflowNotifyIds 双通道（details.notifyId / details.deliveryId），域外 customType 不收", () => {
		const ids = collectDeliveredWorkflowNotifyIds([
			notifyEntry("wf-done:wf-a"),
			{ type: "custom", customType: WORKFLOW_RESULT_CUSTOM_TYPE, details: { deliveryId: "wf-done:wf-b" } },
			{ type: "custom", customType: "other-notify", details: { notifyId: "wf-done:wf-c" } }, // 域外不收
		]);
		expect(ids.has("wf-done:wf-a")).toBe(true);
		expect(ids.has("wf-done:wf-b")).toBe(true);
		expect(ids.has("wf-done:wf-c")).toBe(false);
	});

	it("collectJournaledDeliveryIds 展开条目 id ∪ collectKey 键集 + ack 终局并入 + 畸形跳过", () => {
		const ids = collectJournaledDeliveryIds([
			outboxEntry("wf-done:wf-a", ["wf-a"]),
			ackEntry("wf-done:wf-b"),
			{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { broken: true } },
		]);
		expect(ids.has("wf-done:wf-a")).toBe(true);
		expect(ids.has("wf-a")).toBe(true); // collectKey 承载键
		expect(ids.has("wf-done:wf-b")).toBe(true);
		expect(ids.size).toBe(3);
	});

	it("buildDoneNotifyId（RL8 同族：补投与主路径同幂等键构造）", () => {
		expect(buildDoneNotifyId("wf-a")).toBe("wf-done:wf-a");
	});
});

// ── 编排：预检短路 / 幂等收敛 / 终局事实核 / 域过滤构造性 ──

describe("runNotifyReconcileMaintenance 编排", () => {
	it("正类：registered + 无痕迹无承载 + 终局帧在 + 聚合重建 → 恰 1 补投（notifyDone 出口被调）", async () => {
		const deps = makeDeps(
			[registeredEntry("wf-1"), settledEntry("wf-1")],
			{ runs: [makeRun("wf-1")] },
		);
		const result = await runNotifyReconcileMaintenance(deps);
		expect(result.scanned).toBe(1);
		expect(result.candidates).toBe(1);
		expect(result.redelivered).toEqual(["wf-1"]);
		expect(vi.mocked(notifyDone)).toHaveBeenCalledTimes(1);
		const args = vi.mocked(notifyDone).mock.calls[0]!;
		expect(args[1]).toBe("wf-1"); // runId
		expect(args[4]).toBe("/runs"); // artifactsDir = recordPath 锚点目录（dirname）
		expect(args[5]).toEqual({ outcome: "done", settledAt: 1 }); // settlement 直通
	});

	it("送达痕迹命中 → 零补投（skippedDelivered）", async () => {
		const deps = makeDeps([registeredEntry("wf-1"), notifyEntry("wf-done:wf-1")]);
		const result = await runNotifyReconcileMaintenance(deps);
		expect(result.redelivered).toEqual([]);
		expect(result.skippedDelivered).toEqual(["wf-1"]);
		expect(deps.loadRuns).not.toHaveBeenCalled(); // 预检短路：痕迹抵消后零 record 读
	});

	it("投递日志承载命中（id / collectKey 双通道）→ 零补投", async () => {
		const idCase = await runNotifyReconcileMaintenance(
			makeDeps([registeredEntry("wf-1"), outboxEntry("wf-done:wf-1")]),
		);
		expect(idCase.redelivered).toEqual([]);
		expect(idCase.skippedJournaled).toEqual(["wf-1"]);

		const keyCase = await runNotifyReconcileMaintenance(
			makeDeps([registeredEntry("wf-2"), outboxEntry("unrelated-entry", ["wf-2"])]),
		);
		expect(keyCase.redelivered).toEqual([]);
		expect(keyCase.skippedJournaled).toEqual(["wf-2"]);
	});

	it("预检短路：无注册条目（或全部被抵消）→ loadRuns 零调用（record 读零成本——常态边沿）", async () => {
		const emptyDeps = makeDeps([]);
		const empty = await runNotifyReconcileMaintenance(emptyDeps);
		expect(empty.candidates).toBe(0);
		expect(emptyDeps.loadRuns).not.toHaveBeenCalled();

		const suppressedDeps = makeDeps([registeredEntry("wf-1"), ackEntry("wf-done:wf-1")]);
		const allSuppressed = await runNotifyReconcileMaintenance(suppressedDeps);
		expect(allSuppressed.candidates).toBe(0);
		expect(suppressedDeps.loadRuns).not.toHaveBeenCalled();
	});

	it("终局事实缺席（settledRecordOf undefined：流缺失/损坏/无终局帧）→ skippedNotTerminal 保守 miss，不补投", async () => {
		const deps = makeDeps([registeredEntry("wf-1")], { settlement: undefined });
		const result = await runNotifyReconcileMaintenance(deps);
		expect(result.candidates).toBe(1);
		expect(result.redelivered).toEqual([]);
		expect(result.skippedNotTerminal).toEqual(["wf-1"]);
		expect(vi.mocked(notifyDone)).not.toHaveBeenCalled();
	});

	it("幂等收敛：补投受理后（outbox 条目落盘）下一边沿零补投", async () => {
		const entries = [registeredEntry("wf-1")];
		const first = await runNotifyReconcileMaintenance(makeDeps(entries));
		expect(first.redelivered).toEqual(["wf-1"]);
		const second = await runNotifyReconcileMaintenance(makeDeps([...entries, outboxEntry("wf-done:wf-1")]));
		expect(second.redelivered).toEqual([]);
		expect(second.skippedJournaled).toEqual(["wf-1"]);
	});

	it("域过滤构造性：pending:register 的 workflow 条目（跨域混装形态）不进候选源——manifest 面只认 workflow-record customType", async () => {
		const result = await runNotifyReconcileMaintenance(
			makeDeps([
				{ type: "custom", customType: "pending:register", data: { id: "wf-1", type: "workflow", name: "wf-1" } },
				{ type: "custom", customType: "pending:unregister", data: { id: "wf-1", reason: "completed" } },
			]),
		);
		expect(result.scanned).toBe(0);
		expect(result.candidates).toBe(0);
	});

	it("多 run 批量：终局与在途混合（一个终局一个未终局）→ 恰补投终局者", async () => {
		const deps = makeDeps(
			[registeredEntry("wf-a"), registeredEntry("wf-b")],
			{
				runs: [makeRun("wf-a"), makeRun("wf-b")],
				settlement: undefined, // 默认 settlement 桩恒返回——改用按 runId 分流桩
			},
		);
		deps.settledRecordOf.mockImplementation((runId: string) =>
			runId === "wf-a" ? { outcome: "done", settledAt: 1 } : undefined, // wf-b 无终局帧
		);
		const result = await runNotifyReconcileMaintenance(deps);
		expect(result.redelivered).toEqual(["wf-a"]);
		expect(result.skippedNotTerminal).toEqual(["wf-b"]);
	});

	it("loadRuns 抛错（store 损坏穿透）→ 编排整体吞掉记 warn 不上抛（对账失败无害，下一边沿幂等重查）", async () => {
		const deps = makeDeps([registeredEntry("wf-1")]);
		deps.loadRuns.mockRejectedValue(new Error("record stream corrupted"));
		await expect(runNotifyReconcileMaintenance(deps)).resolves.toMatchObject({ candidates: 1, redelivered: [] });
	});
});
