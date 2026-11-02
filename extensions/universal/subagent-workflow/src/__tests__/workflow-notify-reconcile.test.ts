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

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
}));

vi.mock("../workflow-notify.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../workflow-notify.ts")>();
	// 默认替身 = 受理（返回 true）：本文件主体测编排判据面，notifyDone 出口按受理
	// 语义替身（A15 修复后编排按返回值分流——undefined 会误入「未受理」分支）。
	// 「未受理不计 redelivered」的编排分支在底部专门 describe 用 mockReturnValue 覆盖。
	return { ...actual, notifyDone: vi.fn((): boolean => true) };
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
	readSessionFileEntries,
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
function makeDeps(entries: unknown[], opts?: { settlement?: unknown; runs?: unknown[]; sessionFile?: string }) {
	return {
		reason: "test",
		pi: { sendMessage: vi.fn() },
		entries,
		sessionFile: opts?.sessionFile, // undefined = no-persist 退化内存账（现状行为）
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

// ── A1 产品缺陷修复回归（域侧同构）：判据事实源磁盘化 ──
// 缺陷链（与 bash 域范本同构，范本 = base-tool-enhance pending-reconcile.test.ts
// 「disk-fact journal source」describe）：pi SessionManager._appendEntry 先
// fileEntries.push 后 _persist、persist 失败（真机注入形态 = session JSONL
// chmod 0444，EACCES 挡写不挡读）无回滚 → 幽灵内存 entry（内存账在册、JSONL 无
// 行）；判据曾消费 getEntries() 内存账 → delivered/journaled 误真 → 补投静默失效。
// 修复后事实源 = session JSONL 落盘条目（deps.sessionFile，workflow-events.ts 经
// getSessionFile() 传入）；manifest 面（候选源）同盘上口径。单测模拟形态 = 内存
// entries 与磁盘文件不一致（幽灵态的定义特征），与真机 chmod 注入同族（同是
// 「内存有、盘上无」的产物）。journal 面（settledRecordOf/loadRuns）独立磁盘文件
// 不受幽灵态影响，注入桩原样。
describe("判据事实源磁盘化（幽灵内存 entry 回归，A1 域侧同构修复）", () => {
	const DATA_DIR = mkdtempSync(join(tmpdir(), "wf-reconcile-"));
	const SESSION_FILE = join(DATA_DIR, "session.jsonl");

	/** 写 session JSONL（pi _persist 落盘形态：每条 entry 一行 JSON.stringify）。 */
	function writeSessionFile(lines: unknown[]): void {
		mkdirSync(DATA_DIR, { recursive: true });
		writeFileSync(SESSION_FILE, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : ""));
	}

	it("幽灵 in-memory outbox entry（内存有、盘上无）→ 补投发生（A1 回归本体）", async () => {
		// 磁盘事实：JSONL 只含注册条目（EACCES 实况——outbox persist 被挡，盘上无
		// 该键任何受理行）；内存账多一条幽灵 outbox entry
		writeSessionFile([registeredEntry("wf-1")]);
		const ghostEntries = [registeredEntry("wf-1"), outboxEntry("wf-done:wf-1")];
		const deps = makeDeps(ghostEntries, { sessionFile: SESSION_FILE });

		const result = await runNotifyReconcileMaintenance(deps);
		// 幽灵 journaled 不再误真：补投放行（内存账口径曾沿幽灵态静默吞补投）
		expect(result.redelivered).toEqual(["wf-1"]);
		expect(vi.mocked(notifyDone)).toHaveBeenCalledTimes(1);
	});

	it("幽灵 delivered trace（内存通知条目、盘上无）→ 补投发生（delivered 事实读盘）", async () => {
		writeSessionFile([registeredEntry("wf-1")]);
		const ghostEntries = [registeredEntry("wf-1"), notifyEntry("wf-done:wf-1")];
		const deps = makeDeps(ghostEntries, { sessionFile: SESSION_FILE });

		const result = await runNotifyReconcileMaintenance(deps);
		expect(result.redelivered).toEqual(["wf-1"]);
	});

	it("outbox entry 在盘上 → 零补投（journaled 读盘正命中，磁盘事实正向抵消）", async () => {
		// entries 形态 = 重启后内存账从盘重建的一致形态（内存账 ⊇ 盘上条目是运行时
		// 构造性前提——人工构造「内存空、盘上有」会撞内存预检短路早退，非真实形态）
		const diskAndMemory = [registeredEntry("wf-1"), outboxEntry("wf-done:wf-1")];
		writeSessionFile(diskAndMemory);
		const deps = makeDeps(diskAndMemory, { sessionFile: SESSION_FILE });

		const result = await runNotifyReconcileMaintenance(deps);
		expect(result.redelivered).toEqual([]);
		expect(result.skippedJournaled).toEqual(["wf-1"]);
		expect(deps.loadRuns).not.toHaveBeenCalled(); // 短路保持：盘上抵消后零 record 读
	});

	it("幽灵 registered 条目（内存注册条目、盘上无）→ manifest 面按盘上口径 scanned=0，零补投（口径锁）", async () => {
		// 口径锁（文件头「判据事实源磁盘化」段残余登记）：注册锚点落盘失败 = 持久化
		// 断裂，重启后 manifest 面无从发现该 run——磁盘口径下候选不可见的保守 miss
		writeSessionFile([]); // 盘上无任何注册条目
		const deps = makeDeps([registeredEntry("wf-1")], { sessionFile: SESSION_FILE });

		const result = await runNotifyReconcileMaintenance(deps);
		expect(result.scanned).toBe(0);
		expect(result.candidates).toBe(0);
		expect(vi.mocked(notifyDone)).not.toHaveBeenCalled();
	});

	it("sessionFile 缺席（no-persist 形态）→ 退化内存账 + warn（现状行为；该形态无幽灵态，内存账即完整事实）", async () => {
		// no-persist 形态 _persist no-op 恒成功：内存 outbox = 真受理 → 不补投
		const inMemoryEntries = [registeredEntry("wf-1"), outboxEntry("wf-done:wf-1")];
		const deps = makeDeps(inMemoryEntries); // 不传 sessionFile

		const result = await runNotifyReconcileMaintenance(deps);
		expect(result.redelivered).toEqual([]);
		expect(result.skippedJournaled).toEqual(["wf-1"]);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("fell back to in-memory entries"),
			expect.anything(),
		);
	});

	it("session file 不可读（chmod 0000，读侧 EACCES）→ 盘事实按空 + warn（保守 miss，manifest 面与抵消事实同按空）", async () => {
		writeSessionFile([registeredEntry("wf-1")]);
		chmodSync(SESSION_FILE, 0o000);
		const deps = makeDeps([registeredEntry("wf-1")], { sessionFile: SESSION_FILE });
		try {
			const result = await runNotifyReconcileMaintenance(deps);
			// 读失败宽容口径（warn 即修复信号）：候选源与抵消事实同按空 → 零补投；
			// 下一对账边沿环境修复后幂等重查
			expect(result.redelivered).toEqual([]);
			expect(loggerMock.warn).toHaveBeenCalledWith(
				expect.stringContaining("disk entries treated as empty"),
				expect.anything(),
			);
		} finally {
			chmodSync(SESSION_FILE, 0o644);
		}
	});
});

// ── readSessionFileEntries 容错（JSONL 读侧；口径登记见函数头注）──

describe("readSessionFileEntries（磁盘读侧容错）", () => {
	const DATA_DIR = mkdtempSync(join(tmpdir(), "wf-readfile-"));

	it("文件缺失（ENOENT，首条对话消息前常态）→ 空数组", () => {
		expect(readSessionFileEntries(join(DATA_DIR, "no-such-file.jsonl"))).toEqual([]);
	});

	it("脏行跳过、合法行解析（JSONL 逐行容错）", () => {
		mkdirSync(DATA_DIR, { recursive: true });
		const file = join(DATA_DIR, "dirty.jsonl");
		writeFileSync(
			file,
			['{"type":"custom","customType":"x"}', "not-json", "", '{"type":"message"}'].join("\n"),
		);
		const entries = readSessionFileEntries(file);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toEqual({ type: "custom", customType: "x" });
	});

	it("不可读文件（chmod 0000）→ 空 + warn（宽容口径：磁盘事实不可得 = 无条目）", () => {
		mkdirSync(DATA_DIR, { recursive: true });
		const file = join(DATA_DIR, "locked.jsonl");
		writeFileSync(file, "{}\n");
		chmodSync(file, 0o000);
		try {
			expect(readSessionFileEntries(file)).toEqual([]);
			expect(loggerMock.warn).toHaveBeenCalledWith(
				expect.stringContaining("disk entries treated as empty"),
				expect.anything(),
			);
		} finally {
			chmodSync(file, 0o644);
		}
	});
});

// ── A15 缺陷修复回归：补投出口按 notifyDone 受理结果分流 ──
// 缺陷形态（A15 真机 6 红实证）：主路径 rejected 被 runSettledEffects 无条件
// track 进去重窗口 → 补投 notifyDone 幂等早退静默返回 → 编排 reconciled 日志
// 照打（受理假象）——port 侧零受理行、消息从未出站。修复后编排按返回值分流：
// false（未受理）不计 redelivered + warn 留痕（修复信号）；true 才计受理。
describe("补投出口受理分流（A15 缺陷修复回归）", () => {
	it("notifyDone 返回 false（主投与单次重提均 rejected 等受理未发生形态）→ 不计 redelivered + warn 留痕（受理假象防线）", async () => {
		vi.mocked(notifyDone).mockReturnValueOnce(false);
		const deps = makeDeps([registeredEntry("wf-1")]);

		const result = await runNotifyReconcileMaintenance(deps);

		expect(vi.mocked(notifyDone)).toHaveBeenCalledTimes(1);
		// 未受理不计 redelivered：受理日志与真实受理一致（A15 的「reconciled 照打」
		// 假阳性不再发生）
		expect(result.redelivered).toEqual([]);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("redelivery not accepted"),
			expect.objectContaining({ detail: expect.objectContaining({ runId: "wf-1", notifyId: "wf-done:wf-1" }) }),
		);
		expect(loggerMock.debug).not.toHaveBeenCalledWith(
			"workflow notify reconciled via delivery port",
			expect.anything(),
		);
	});

	it("notifyDone 返回 true（受理）→ redelivered 计入 + 受理 debug 照打", async () => {
		const deps = makeDeps([registeredEntry("wf-1")]);

		const result = await runNotifyReconcileMaintenance(deps);

		expect(result.redelivered).toEqual(["wf-1"]);
		expect(loggerMock.debug).toHaveBeenCalledWith("workflow notify reconciled via delivery port", {
			detail: { reason: "test", runId: "wf-1", notifyId: "wf-done:wf-1" },
		});
	});
});
