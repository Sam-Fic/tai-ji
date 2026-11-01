// src/__tests__/notify-reconcile-judgement.test.ts —— 收殓终态补投的送达痕迹提取
// （unified-delivery D3 裁决 1，现行登记处 = ADR-0074 与 docs/CONTEXT.md『统一投递』段）：collectDeliveredTaskIds 五形态（正常消息/fork 副本/
// 缺 details 旧消息/非 bash 通知/killed 无痕迹任务）+ content 双落盘形态容错。
// 旧补投标记（background-bash:reconciled）随波 3 补投机制退役：防双投由 port 幂等
// 接管，marker 判据/读写形态及其测试一并删除（反向锁见 pending-reconcile.test.ts
// 「legacy reconciled marker present WITHOUT trace → still re-notified」用例）
import { describe, expect, it } from "vitest";

import { BACKGROUND_BASH_CUSTOM_TYPE } from "../background/notify.ts";
import {
	collectDeliveredTaskIds,
	collectJournaledDeliveryIds,
	isReconcileNotifyCandidate,
} from "../background/notify-reconcile-judgement.ts";

const TASK_ID = "bt-1700000000-abcd12";
const OTHER_TASK_ID = "bt-1700000000-efgh34";

/** 送达消息 entry（pi CustomMessageEntry 落盘形态：type=custom_message + customType）。 */
function deliveredEntry(overrides: {
	taskId?: string;
	details?: unknown;
	content?: unknown;
	customType?: string;
} = {}): Record<string, unknown> {
	const taskId = overrides.taskId ?? TASK_ID;
	return {
		type: "custom_message",
		customType: overrides.customType ?? BACKGROUND_BASH_CUSTOM_TYPE,
		content: overrides.content ?? `[background-bash] ${taskId} finished (exit 0, 3m12s): pnpm test\nFull output: /tmp/out/${taskId}.log`,
		details: "details" in overrides ? overrides.details : { taskId, endReason: "natural", exitCode: 0 },
		display: true,
	};
}

describe("collectDeliveredTaskIds: five entry shapes (design §5 U1)", () => {
	it("normal delivered message: hits via details.taskId and content both", () => {
		const ids = collectDeliveredTaskIds([deliveredEntry()]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("fork copy (same shape carried into the forked session): hits identically", () => {
		// fork 复制 session 文件时送达消息原样带走——同形态命中是决策 5 的构造性来源
		const ids = collectDeliveredTaskIds([
			{ type: "user", content: "hello" }, // fork 前的旧消息
			deliveredEntry(), // 复制带来的送达消息
			{ type: "user", content: "after fork" },
		]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("legacy message without details: hits via content token alone", () => {
		const ids = collectDeliveredTaskIds([
			deliveredEntry({ details: undefined }),
		]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("non-bash notification (different customType, content mentions bt- token): does NOT hit", () => {
		const ids = collectDeliveredTaskIds([
			deliveredEntry({ customType: "subagent-bg-notify" }),
			deliveredEntry({ customType: "managed-session-notify", details: undefined }),
		]);
		expect(ids.size).toBe(0);
	});

	it("killed task with no delivery message: naturally absent (empty entries side)", () => {
		// kill 路径不产通知（notify.ts 单点归属规则）——entries 无该任务消息，集合不含它，
		// 补投判据的排除由 registry reason=killed 承担（执行器侧用例），此处锁定痕迹面为空
		const ids = collectDeliveredTaskIds([
			deliveredEntry(), // 只有别的任务的送达消息
			{ type: "custom", customType: "pending:unregister", data: { id: OTHER_TASK_ID, reason: "cancelled" } },
		]);
		expect(ids.has(TASK_ID)).toBe(true);
		expect(ids.has(OTHER_TASK_ID)).toBe(false);
	});
});

describe("collectDeliveredTaskIds: content落盘形态与脏数据容错", () => {
	it("TextContent[] content form (appendCustomMessageEntry accepts arrays) hits via text blocks", () => {
		const ids = collectDeliveredTaskIds([
			deliveredEntry({
				details: undefined,
				content: [{ type: "text", text: `[background-bash] ${TASK_ID} finished (exit 0, 5s): pnpm test` }],
			}),
		]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("malformed entries (null / primitives / wrong field types) are skipped, not fatal", () => {
		const ids = collectDeliveredTaskIds([
			null,
			undefined,
			42,
			"custom_message",
			{ customType: BACKGROUND_BASH_CUSTOM_TYPE }, // content/details 均缺
			{ customType: BACKGROUND_BASH_CUSTOM_TYPE, content: 123, details: "no" },
			deliveredEntry({ details: { taskId: 42 } }), // details.taskId 非字符串 → 只剩 content 通道
		]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("multiple messages across tasks collect all ids", () => {
		const ids = collectDeliveredTaskIds([
			deliveredEntry(),
			deliveredEntry({ taskId: OTHER_TASK_ID, details: undefined }),
		]);
		expect([...ids].sort()).toEqual([TASK_ID, OTHER_TASK_ID].sort());
	});
});

// ── 三重事实判据：投递日志幂等键提取（事实三事实源）+ 骨架真值
//（completion-signal-delivery D2；bash 域消费在 pending-reconcile.test.ts 真值表组）──

/** 投递日志 outbox entry（journal v2 落盘形态——port 受理前 appendEntry 写入）。 */
function journaledOutboxEntry(id: string, dataOverrides: Record<string, unknown> = {}) {
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
			...dataOverrides,
		},
	};
}

describe("collectJournaledDeliveryIds: journal entry shapes (fact-three source, D2)", () => {
	it("v2 outbox entry hits via data.id", () => {
		const ids = collectJournaledDeliveryIds([journaledOutboxEntry(TASK_ID)]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("legacy v1 ledger entry (subagent-bg-notify-ledger) hits via notifyId mapping", () => {
		const ids = collectJournaledDeliveryIds([
			{
				type: "custom",
				customType: "subagent-bg-notify-ledger",
				data: { v: 1, notifyId: TASK_ID, content: "c", record: {} },
			},
		]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("ack terminal entry hits (defensive union with outbox in the same pass)", () => {
		const ids = collectJournaledDeliveryIds([
			{
				type: "custom",
				customType: "delivery-port-ack",
				data: { v: 2, id: TASK_ID, outcome: "delivered" },
			},
		]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("malformed / non-journal entries are skipped (tolerance aligned with port scanJournal)", () => {
		const ids = collectJournaledDeliveryIds([
			null,
			42,
			deliveredEntry(), // custom_message 通知条目——非投递日志
			{ type: "custom", customType: "delivery-port-outbox", data: { v: 2 } }, // data 畸形
			{ type: "custom", customType: "delivery-port-outbox" }, // data 缺失
			journaledOutboxEntry(TASK_ID),
		]);
		expect([...ids]).toEqual([TASK_ID]);
	});

	it("multiple ids across entries collect all", () => {
		const ids = collectJournaledDeliveryIds([
			journaledOutboxEntry(TASK_ID),
			journaledOutboxEntry(OTHER_TASK_ID),
		]);
		expect([...ids].sort()).toEqual([TASK_ID, OTHER_TASK_ID].sort());
	});
});

describe("isReconcileNotifyCandidate: triple-fact skeleton truth (D2, cross-domain shared semantics)", () => {
	const base = { isTerminal: true, excludedByOrigin: false, delivered: false, journaled: false };

	it("candidate only when terminal ∧ not excluded ∧ no trace ∧ no journal entry", () => {
		expect(isReconcileNotifyCandidate(base)).toBe(true);
		expect(isReconcileNotifyCandidate({ ...base, isTerminal: false })).toBe(false);
		expect(isReconcileNotifyCandidate({ ...base, excludedByOrigin: true })).toBe(false);
		expect(isReconcileNotifyCandidate({ ...base, delivered: true })).toBe(false);
		expect(isReconcileNotifyCandidate({ ...base, journaled: true })).toBe(false);
	});
});
