// src/__tests__/pending-reconcile.test.ts —— M3 session_start 对账单元
// + 终态通知对账补投（completion-signal-delivery D2/D6 三重事实判据；收殓形态 =
// unified-delivery 波 3 既有子集；投递统一化设计的现行登记处 =
// ADR-0074 与 docs/CONTEXT.md「统一投递（unified delivery，v3）」段）：
//  - bt- 差集（protocol collectActivePendingIds 单点消费）/ 三类僵尸场景 appendEntry
//    权威路径（唯一写路径，无 emit）/ 活任务与缺条目保守跳过
//  - 终态补投候选 = 三重磁盘事实（registry 终态 ∧ 送达痕迹未命中 ∧ 投递日志无该
//    幂等键条目；killed 成因排除位）。payload 分层（D6）：rejected 补投（exited
//    natural/timeout——主路径受理被拒、投递日志无条目，差集重放结构性无从覆盖）=
//    主路径同款 content + details + collectKey；收殓补投（orphaned / process-exit，
//    无投递日志条目形态）维持 terminated 简报、无 details（「不谎报」既有裁决，
//    断言不删）
//  - killed 成因排除位：kill 发令方当次交互已同步获知结果（notify.ts kill 路径
//    通知不入账单点归属规则），补投是重复刺激（N1 场景）
//  - 旧补投标记 / in-flight 单飞检查随波 3 退役：防双投由 port 幂等接管（deliver
//    幂等预检 + 内核三级判重 + outbox/ack 终态列）——本文件锁定「marker 在场不再
//    阻断重投」（痕迹缺失即重投，旧 marker「标记在而消息丢」残余失败域随之修复）
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BACKGROUND_TASK_ID_PREFIX,
	collectActivePendingIds,
	mapReasonToStatus,
} from "@zhushanwen/extension-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
}));

import {
	isReapNotifyCandidate,
	reconcilePendingEntries,
	type ReconcileDeliver,
	type ReconcilePi,
} from "../background/pending-reconcile.ts";
import {
	BACKGROUND_BASH_CUSTOM_TYPE,
	buildNotificationContent,
	buildNotifyDetails,
} from "../background/notify.ts";
import { getRegistryPath, writeRegistryEntry } from "../background/registry.ts";
import type { RegistryEntry } from "../background/types.ts";

const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-reconcile-"));
const SESSION_ID = "sess-reconcile";

type DeliverEnvelope = Parameters<ReconcileDeliver>[0];

function createMockPi(overrides: Partial<Pick<ReconcilePi, "appendEntry">> = {}): ReconcilePi {
	return {
		appendEntry: vi.fn(),
		...overrides,
	};
}

/** port.deliver 替身（缺省恒 accepted；receiptKind 覆盖受理结果分型）。 */
function createMockDeliver(receiptKind: "accepted" | "swallowed" | "rejected" = "accepted"): ReconcileDeliver {
	return vi.fn((envelope: DeliverEnvelope): ReturnType<ReconcileDeliver> => {
		if (receiptKind === "accepted") return { kind: "accepted", id: envelope.id ?? "" };
		if (receiptKind === "swallowed") return { kind: "swallowed", reason: "already-seen" };
		return { kind: "rejected", reason: "persist-failed" };
	});
}

function makeRegistryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		taskId: "bt-1700000000-zomb01",
		pid: 99999,
		command: "sleep 3600",
		outputFile: "/tmp/out.log",
		startedAt: 1_700_000_000_000,
		state: "orphaned",
		ownerPiPid: 1,
		sessionId: SESSION_ID,
		...overrides,
	};
}

/** 已死 pid：spawnSync 同步等待退出 + libuv reap，返回时 pid 必已终止。 */
function deadPid(): number {
	const result = spawnSync("true");
	if (result.pid === undefined) throw new Error("no pid acquired for dead-pid probe");
	return result.pid;
}

function registerEntry(id: string) {
	return { customType: "pending:register", data: { id, type: "bash", name: "sleep 3600" } };
}

/** 送达消息 entry（custom_message 落盘形态，供痕迹判重的「痕迹在」用例）。 */
function deliveredEntry(taskId: string) {
	return {
		type: "custom_message",
		customType: BACKGROUND_BASH_CUSTOM_TYPE,
		content: `[background-bash] ${taskId} finished (exit 0, 5s): pnpm test`,
		details: { taskId },
		display: true,
	};
}

/** 旧版补投标记 entry（波 3 机制退役后判据不再消费——反向断言用）。 */
function legacyMarkerEntry(taskId: string) {
	return {
		type: "custom",
		customType: "background-bash:reconciled",
		data: { taskId, reconciledAt: 1 },
	};
}

/** 投递日志 outbox entry（journal v2 落盘形态——port 受理前 appendEntry 写入）。 */
function journaledOutboxEntry(id: string) {
	return {
		type: "custom",
		customType: "delivery-port-outbox",
		data: {
			v: 2,
			id,
			timing: "steer",
			payload: {
				kind: "custom",
				customType: BACKGROUND_BASH_CUSTOM_TYPE,
				content: `notify ${id}`,
				display: true,
			},
			recordedAt: 1,
		},
	};
}

/** 投递日志终局 entry（ack 列——delivered 终局形态）。 */
function journaledAckEntry(id: string) {
	return {
		type: "custom",
		customType: "delivery-port-ack",
		data: { v: 2, id, outcome: "delivered" },
	};
}

afterEach(() => {
	rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	vi.clearAllMocks();
});

describe("bt- diff via protocol collectActivePendingIds (single-source diff core)", () => {
	// 差集本体单点在 protocol pending-entries（ext-simplify-13 D3，与 pending 检查
	// 判据同源）；此处锁定 bte 对账消费方的语义（idPrefix = BACKGROUND_TASK_ID_PREFIX）
	it("collects bt- registers without a matching unregister", () => {
		const ids = collectActivePendingIds(
			[
				registerEntry("bt-a"),
				registerEntry("bt-b"),
				{ customType: "pending:unregister", data: { id: "bt-b", reason: "completed" } },
			],
			{ idPrefix: BACKGROUND_TASK_ID_PREFIX },
		);
		expect([...ids]).toEqual(["bt-a"]);
	});

	it("ignores non-bt ids (subagent bg-/run- namespace not ours)", () => {
		const ids = collectActivePendingIds(
			[registerEntry("bg-1"), registerEntry("run-x-1"), registerEntry("bt-a")],
			{ idPrefix: BACKGROUND_TASK_ID_PREFIX },
		);
		expect([...ids]).toEqual(["bt-a"]);
	});

	it("dedupes repeated registers and tolerates malformed entries", () => {
		const ids = collectActivePendingIds(
			[
				null,
				undefined,
				{ customType: "pending:register" }, // data 缺失
				{ customType: "pending:register", data: { id: 42 } }, // id 非字符串
				registerEntry("bt-a"),
				registerEntry("bt-a"),
				{ customType: "other" },
			],
			{ idPrefix: BACKGROUND_TASK_ID_PREFIX },
		);
		expect([...ids]).toEqual(["bt-a"]);
	});

	it("register→unregister→register same id stays settled (global cancellation)", () => {
		const ids = collectActivePendingIds(
			[
				registerEntry("bt-a"),
				{ customType: "pending:unregister", data: { id: "bt-a", reason: "completed" } },
				registerEntry("bt-a"),
			],
			{ idPrefix: BACKGROUND_TASK_ID_PREFIX },
		);
		expect(ids.size).toBe(0);
	});
});

describe("reconcile scenario ①: graceful-exit leftover (registry exited, entry never written)", () => {
	it("appends pending:unregister {id, reason, status} matching pending-notifications entry shape", async () => {
		const entry = makeRegistryEntry({
			taskId: "bt-1700000000-zomb01",
			state: "exited",
			reason: "natural",
			exitCode: 0,
		});
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);

		expect(result.reconciled).toBe(1);
		// 落盘形态逐字段对齐 pending-notifications index.ts unregister listener：{id, reason, status}
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "completed",
			status: "completed",
		});
	});

	it("maps exited reason/exitCode through the same mapping as the exit edge", async () => {
		const cases: Array<[RegistryEntry, string]> = [
			[makeRegistryEntry({ state: "exited", reason: "natural", exitCode: 3 }), "failed"],
			// natural + 无退出码 = 结果未知形态（转后台任务 reparent 无父权，退出码结构性
			// 不可得——foreground-idle-to-background §5 部件 5）：session_start 对账落
			// reason/status 双 unknown，与 exit 边沿同引 toPendingReason 单点
			[makeRegistryEntry({ state: "exited", reason: "natural", exitCode: null }), "unknown"],
			[makeRegistryEntry({ state: "exited", reason: "timeout", exitCode: null }), "time_limited"],
			[makeRegistryEntry({ state: "exited", reason: "killed", exitCode: null }), "cancelled"],
			[makeRegistryEntry({ state: "exited", reason: "process-exit", exitCode: null }), "cancelled"],
		];
		for (const [entry, expectedReason] of cases) {
			writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
			const pi = createMockPi();
			await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);
			// status 断言按「权威映射(reason)」而非 reason 本身表述（D10：identity 假设消除）
			expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
				id: entry.taskId,
				reason: expectedReason,
				status: mapReasonToStatus(expectedReason),
			});
		}
	});
});

describe("entry status maps via protocol mapReasonToStatus (D10 single-source, identity assumption removed)", () => {
	// bte 写侧 status 与 pending-notifications unregister listener 同引 protocol 单点
	// （ext-simplify-17 D10）——原 status: reason 的 identity 假设在非 identity reason
	// （budget_limited→failed 等）上会静默漂移，映射表演化时两写侧不再可能分叉。
	// settle 产域各值当前恰为 identity 映射，但断言范围按「status === mapReasonToStatus
	// (reason)」表述：映射表日后改任何一行的口径，本组用例随实现同源自洽。
	it("appended status equals the authoritative mapping for every reason the settle path can produce", () => {
		// settledPendingReason 全产域：exited 三分支（natural 按 exitCode 分流 completed/
		// failed/unknown——null = 结果未知形态；timeout；killed|process-exit 经
		// toPendingReason）+ orphaned/判死兜底 cancelled + reason 缺失防御分支。
		// unknown 经 mapReasonToStatus 的 fail-visible 缺省档返回 'unknown'（词表未显式
		// 登记该键、走 default，结果仍 identity）
		const settleReasons = ["completed", "failed", "time_limited", "cancelled", "unknown"] as const;
		for (const reason of settleReasons) {
			expect(mapReasonToStatus(reason)).toBe(reason); // 当前口径下各值均为 identity 映射
		}
	});

	it("non-identity reasons exist in the authoritative mapping — identity assumption is provably gone", () => {
		// 这些 reason 上 status ≠ reason 本身：若写侧仍持 identity 假设（status: reason），
		// settle 产域将来扩展到这些值时落盘 entry 会静默漂移；现实现单点映射自动正确
		expect(mapReasonToStatus("budget_limited")).toBe("failed");
		expect(mapReasonToStatus("interrupted")).toBe("aborted");
		expect(mapReasonToStatus("interrupted-by-restart")).toBe("aborted");
		expect(mapReasonToStatus("interrupted-by-parent")).toBe("aborted");
		expect(mapReasonToStatus("reopened")).toBe("completed");
		// 词表外 reason 缺省 unknown（fail-visible——fail-open=completed 已废除，登记处见文件头）
		expect(mapReasonToStatus("some-future-reason")).toBe("unknown");
	});
});

describe("reconcile scenario ②: collector-only orphan (registry orphaned, session file untouched)", () => {
	it("appends unregister with cancelled for orphaned entries", async () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);

		expect(result.reconciled).toBe(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "cancelled",
			status: "cancelled",
		});
	});
});

describe("reconcile scenario ③: running entry whose pid is already dead (fact-terminal)", () => {
	it("appends unregister with cancelled when kill(pid,0) says dead", async () => {
		const entry = makeRegistryEntry({ state: "running", pid: deadPid() });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);

		expect(result.reconciled).toBe(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "cancelled",
			status: "cancelled",
		});
	});
});

describe("conservative no-op paths", () => {
	it("running entry with LIVE pid is not settled (D12 task survives session replacement)", async () => {
		const entry = makeRegistryEntry({ state: "running", pid: process.pid }); // 当前测试进程 = 活 pid
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);

		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual([entry.taskId]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("registry has no entry for the id → skip (terminal state unverifiable) + warn (decision-6 LRU observation)", async () => {
		const pi = createMockPi();
		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry("bt-unknown")], undefined);
		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual(["bt-unknown"]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		// 决策 6：LRU 淘汰重审触发的观测落点——warn 含 taskId（此前该形态零日志）
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"pending reconcile: registry has no entry for a pending bt- id (LRU-evicted or spawn-write failure); unregister stays pending",
			{ detail: { taskId: "bt-unknown" } },
		);
	});

	it("entries with no bt- register → early no-op", async () => {
		const pi = createMockPi();
		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			{ customType: "pending:register", data: { id: "bg-1", type: "subagent" } },
			{ customType: "user" },
		], undefined);
		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual([]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("unsettled set empty (unregister already present) → no unregister write", async () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();
		// 送达消息随 entries 在（正常投递形态：unregister 由 exit 边沿写、消息已送达）——
		// 补投被痕迹锚阻断；本用例锁定「差集空 → 无 unregister 写点」的既有语义
		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			registerEntry(entry.taskId),
			{ customType: "pending:unregister", data: { id: entry.taskId, reason: "cancelled" } },
			deliveredEntry(entry.taskId),
		], undefined);
		expect(result.reconciled).toBe(0);
		expect(pi.appendEntry).not.toHaveBeenCalledWith("pending:unregister", expect.anything());
	});
});

describe("best-effort emit removed (ext-simplify-13 D5: appendEntry is the sole authority)", () => {
	it("reconcile never touches pi.events (the emit path is deleted, not just disabled)", async () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi() as ReconcilePi & { events: { emit: ReturnType<typeof vi.fn> } };
		pi.events = { emit: vi.fn() };

		// 送达消息在（痕迹锚阻断补投）：appendEntry 恰 1 次 = 差集收尾的 unregister
		await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			registerEntry(entry.taskId),
			deliveredEntry(entry.taskId),
		], undefined);

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.events.emit).not.toHaveBeenCalled();
	});
});

describe("appendEntry failure tolerance", () => {
	it("one appendEntry throw does not block the remaining zombie (count only successful)", async () => {
		const first = makeRegistryEntry({ taskId: "bt-1700000000-zomb01", state: "orphaned" });
		const second = makeRegistryEntry({ taskId: "bt-1700000000-zomb02", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), first);
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), second);
		const appendEntry = vi.fn((customType: string, data?: unknown) => {
			if (customType === "pending:unregister" && (data as { id: string }).id === first.taskId) {
				throw new Error("append failed");
			}
		});
		const pi = createMockPi({ appendEntry });

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			registerEntry(first.taskId),
			registerEntry(second.taskId),
		], undefined);

		expect(result.reconciled).toBe(1); // 仅 unregister 第二条成功计数
		expect(result.skipped).toEqual([]);
	});
});

// ============================================================================
// 收殓终态通知补投（unified-delivery D3 裁决 1 / 波 3，登记处见文件头：对账路径 = 收殓终态
// 通知的唯一生产者，载体 = port.deliver）
// ============================================================================

describe("reap-notify: candidates (reaped terminal × trace absent) via port.deliver", () => {
	it("single orphaned: one deliver per task with id=taskId, terminated wording, NO details", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-orph01", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [], deliver);

		expect(deliver).toHaveBeenCalledTimes(1);
		const envelope = deliver.mock.calls[0][0] as DeliverEnvelope;
		expect(envelope.id).toBe(entry.taskId);
		expect(envelope.timing).toBe("steer");
		expect(envelope.payload.customType).toBe(BACKGROUND_BASH_CUSTOM_TYPE);
		expect(envelope.payload.display).toBe(true);
		expect(envelope.payload.content).toContain(
			`${entry.taskId} was terminated when the session went down (exit code unknown)`,
		);
		expect(envelope.payload.content).toContain(`Output file: ${entry.outputFile}`);
		expect(envelope.payload.content).toContain("use bash_output to check the output before rerunning");
		// 收殓终态无业务 details（old decision 3 保持：无时长、不谎报成败）
		expect(envelope.payload).not.toHaveProperty("details");
		expect(envelope.payload.content).not.toMatch(/\d+[smh]/);
		// collectKey 债权申报 = [taskId]（result-collect 域，现行登记处 = ADR-0146：
		// 对账补投条目带键，与主链 notify.ts 同款，collect 可收取收殓终态）
		const opts = deliver.mock.calls[0][1] as { collectKey?: string[] } | undefined;
		expect(opts?.collectKey).toEqual([entry.taskId]);
		expect(result.redelivered).toEqual([entry.taskId]);
	});

	it("single exited process-exit: same terminated wording (not failed/finished)", async () => {
		const entry = makeRegistryEntry({
			taskId: "bt-1700000000-pexit1",
			state: "exited",
			reason: "process-exit",
			exitCode: null,
		});
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		const envelope = deliver.mock.calls[0][0] as DeliverEnvelope;
		expect(envelope.payload.content).toContain("was terminated when the session went down");
		// 不谎报：收殓终止不渲染成主路径的 failed/finished 形态
		expect(envelope.payload.content).not.toContain("failed (exit");
		expect(envelope.payload.content).not.toContain("finished (exit");
	});

	it("multiple reaped tasks: per-task deliver (merge branch retired — one id one envelope for port idempotency)", async () => {
		const first = makeRegistryEntry({ taskId: "bt-1700000000-orph02", state: "orphaned" });
		const second = makeRegistryEntry({ taskId: "bt-1700000000-pexit2", state: "exited", reason: "process-exit", exitCode: null });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), first);
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), second);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

	// 逐任务信封（旧合并单条形态退役）：port 幂等键/送达凭据/差集逐条处理完毕全链锚定
	// 「单 id 单消息」——合并形态需造合成 id 且部分处理完毕必然双投
		expect(deliver).toHaveBeenCalledTimes(2);
		const envelopes = deliver.mock.calls.map(
			(c) => c[0] as DeliverEnvelope,
		);
		expect(envelopes.map((e) => e.id)).toEqual([first.taskId, second.taskId]);
		for (const envelope of envelopes) {
			expect(envelope.payload.content).toContain(`${envelope.id} was terminated`);
		}
		expect(result.redelivered).toEqual([first.taskId, second.taskId]);
	});
});

describe("reap-notify: rejected redelivery candidates (exited natural/timeout, main-path payload)", () => {
	it("exited natural with no trace and no journal entry IS re-notified with main-path-equivalent payload (D6①)", async () => {
		const entry = makeRegistryEntry({
			taskId: "bt-1700000000-genu01",
			state: "exited",
			reason: "natural",
			exitCode: 0,
			durationMs: 192_000,
			tailSummary: "Tests: 42 passed",
		});
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		// rejected 补投（completion-signal-delivery D2/D6①）：主路径受理被拒时投递日志
		// 无条目、差集重放结构性无从覆盖——对账补投的就是主路径本要发的那条通知，
		// content/details 与主链（notify.ts）同一构造单点（registry 条目直接满足
		// NotificationTaskLike 参数子集）
		expect(deliver).toHaveBeenCalledTimes(1);
		const envelope = deliver.mock.calls[0][0] as DeliverEnvelope;
		expect(envelope.id).toBe(entry.taskId);
		expect(envelope.timing).toBe("steer");
		expect(envelope.payload.customType).toBe(BACKGROUND_BASH_CUSTOM_TYPE);
		expect(envelope.payload.content).toBe(buildNotificationContent(entry));
		expect(envelope.payload.details).toEqual(buildNotifyDetails(entry));
		const opts = deliver.mock.calls[0][1] as { collectKey?: string[] } | undefined;
		expect(opts?.collectKey).toEqual([entry.taskId]);
		expect(result.redelivered).toEqual([entry.taskId]);
	});

	it("exited timeout is re-notified the same way (D6①: same content/details constructors)", async () => {
		const entry = makeRegistryEntry({
			taskId: "bt-1700000000-time01",
			state: "exited",
			reason: "timeout",
			exitCode: null,
			durationMs: 15_000,
		});
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		expect(deliver).toHaveBeenCalledTimes(1);
		const envelope = deliver.mock.calls[0][0] as DeliverEnvelope;
		expect(envelope.payload.content).toBe(buildNotificationContent(entry));
		expect(envelope.payload.details).toEqual(buildNotifyDetails(entry));
	});
});

describe("reap-notify: exclusion criteria (journaled/trace/killed/active excluded)", () => {
	it("exited reason=killed is NOT re-notified (cause exclusion slot — kill requester already knows, N1)", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-kill01", state: "exited", reason: "killed", exitCode: null });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		expect(deliver).not.toHaveBeenCalled();
		expect(result.redelivered).toEqual([]);
	});

	it("killing leftover with dead pid is NOT re-notified (strict terminal filter; unregister settle covers)", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-killg01", state: "killing", pid: deadPid() });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		// 差集侧：宽判据把 killing+判死当事实终态收尾 unregister（既有语义保持）
		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], deliver);
		expect(result.reconciled).toBe(1);
		// 补投侧：killing 遗留实为被杀任务，不补投
		expect(deliver).not.toHaveBeenCalled();
	});

	it("running leftover with dead pid is NOT re-notified (exit-edge write-failure domain, unregister covers)", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-rund01", state: "running", pid: deadPid() });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], deliver);
		expect(result.reconciled).toBe(1);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("delivered trace present (notify message in entries) → no re-notify", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-have01", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [deliveredEntry(entry.taskId)], deliver);

		expect(deliver).not.toHaveBeenCalled();
		expect(result.redelivered).toEqual([]);
	});

	it("legacy reconciled marker present WITHOUT trace → still re-notified (marker retired; lost message re-delivered)", async () => {
		// 波 3 反向锁：旧 marker 不再是判据——「marker 写了但消息实际丢失」的旧机制
		// 残余失败域（旧决策 6 登记边界）在痕迹判据下被顺带修复
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-mark01", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [legacyMarkerEntry(entry.taskId)], deliver);

		expect(deliver).toHaveBeenCalledTimes(1);
		expect(result.redelivered).toEqual([entry.taskId]);
	});

	it("non-reaped registry only: running with live pid and no pending diff → nothing at all", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-live01", state: "running", pid: process.pid });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		expect(deliver).not.toHaveBeenCalled();
		expect(result.reconciled).toBe(0);
	});
});

describe("reap-notify: receipt handling & port absence (idempotence owned by port)", () => {
	it("swallowed receipt (port idempotency hit) → not counted, silent (normal convergence)", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-dbl001", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver("swallowed");

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		expect(deliver).toHaveBeenCalledTimes(1);
		expect(result.redelivered).toEqual([]);
		expect(loggerMock.warn).not.toHaveBeenCalledWith(
			"pending reconcile reap-notify rejected by delivery port; retried next session_start",
			expect.anything(),
		);
	});

	it("rejected receipt (not journaled) → warn with taskId, retried next session_start", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-rej001", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver("rejected");

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		expect(result.redelivered).toEqual([]);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"pending reconcile reap-notify rejected by delivery port; retried next session_start",
			{ detail: { taskId: entry.taskId, reason: "persist-failed" } },
		);
	});

	it("delivery port absent → warn once, zero submission; pending diff pass unaffected", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-abs001", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);

		expect(loggerMock.warn).toHaveBeenCalledWith(
			"pending reconcile reap-notify skipped: delivery port absent (assembly anomaly?); retried next session_start",
		);
		expect(result.redelivered).toEqual([]);
		// 差集收尾无条件执行（缺席只影响补投，不拖垮对账）
		expect(result.reconciled).toBe(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", expect.anything());
	});
});

// ── RL3：三重判据四态真值表（V3 场景单测化；每态各归各通道，completion-signal-delivery D2）──
describe("RL3: triple-fact judgement truth table (four states, each owned by its channel)", () => {
	async function runTruthTable(entries: unknown[]): Promise<ReturnType<typeof createMockDeliver>> {
		const entry = makeRegistryEntry({
			taskId: "bt-1700000000-rl3001",
			state: "exited",
			reason: "natural",
			exitCode: 0,
			durationMs: 5_000,
		});
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();
		await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, entries, deliver);
		return deliver;
	}

	it("state① rejected loss (terminal × no trace × no journal entry) → re-notify exactly once", async () => {
		const deliver = await runTruthTable([]);
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("state② accepted in-flight (journal entry, no trace yet) → NOT re-notified (outbox replay owns it)", async () => {
		// 受理已发生（投递日志有条目）未送达 = port 差集重放的职责——补投与重放职责
		// 不重叠（D2 采用段；重投被幂等吞并徒增 swallowed warn 噪音）
		const deliver = await runTruthTable([journaledOutboxEntry("bt-1700000000-rl3001")]);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("state③ main path delivered-and-terminal (outbox + ack) → NOT re-notified", async () => {
		const deliver = await runTruthTable([
			journaledOutboxEntry("bt-1700000000-rl3001"),
			journaledAckEntry("bt-1700000000-rl3001"),
		]);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("state④ delivered trace present (notify message in entries) → NOT re-notified", async () => {
		const deliver = await runTruthTable([deliveredEntry("bt-1700000000-rl3001")]);
		expect(deliver).not.toHaveBeenCalled();
	});
});

// ── RL12：判据单一导出行为锁（判据面；三入口共享同一函数的编排面在 maintenance-once.test.ts）──
describe("RL12: single exported judgement — same facts, same verdict from any edge", () => {
	it("isReapNotifyCandidate is deterministic per (entry, delivered, journaled); exclusion/trace/journal facts are orthogonal", () => {
		const entry = makeRegistryEntry({
			taskId: "bt-1700000000-judg01",
			state: "exited",
			reason: "natural",
			exitCode: 0,
		});
		const empty = new Set<string>();
		// 同一事实状态任意次调用恒同输出（三边沿入口共用本函数——不存在第二套真值）
		expect(isReapNotifyCandidate(entry, empty, empty)).toBe(true);
		expect(isReapNotifyCandidate(entry, empty, empty)).toBe(true);
		// 三事实正交：任一命中即非候选
		expect(isReapNotifyCandidate(entry, new Set([entry.taskId]), empty)).toBe(false);
		expect(isReapNotifyCandidate(entry, empty, new Set([entry.taskId]))).toBe(false);
		// 排除位：killed 即便三重其余全缺也非候选（N1）
		const killedEntry = makeRegistryEntry({
			taskId: "bt-1700000000-judg02",
			state: "exited",
			reason: "killed",
			exitCode: null,
		});
		expect(isReapNotifyCandidate(killedEntry, empty, empty)).toBe(false);
	});
});
