// reconcile-judgement.test.ts —— 对账补投判据链收编单源的行为锁（原 bash 域
// notify-reconcile-judgement.test.ts 骨架段 + session-manager / subagent-workflow
// 域真值表对拍段随判据链收编迁此，三域物理副本退役）：三重事实骨架真值表 / 投递
// 日志幂等键提取（v2 id + collectKey 键集展开 + v1 兼容读 + ack 终局并入 + 畸形
// 跳过）/ session JSONL 磁盘读侧容错（ENOENT 常态空 / 读错误 warn + 空 / 脏行
// 单行跳过）。域侧只剩「域事实 → 布尔」映射与编排测试（各域 __tests__）。

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
}));

import {
	collectJournaledDeliveryIds,
	isReconcileNotifyCandidate,
	type ReconcileNotifyFacts,
} from "../reconcile-judgement.ts";
import { readSessionFileEntries } from "../session-journal-read.ts";
import { readSessionFileEntries as indexExport } from "../index.ts";

// 测试 fixture 的通知条目 customType（与 bash 域 BACKGROUND_BASH_CUSTOM_TYPE 同词表
// ——判据对通知条目形态不敏感，只按结构化字段收集；此处仅作非投递日志条目的占位）。
const BACKGROUND_BASH_CUSTOM_TYPE = "background-bash";

const TASK_ID = "bt-1700000000-abcd12";
const OTHER_TASK_ID = "bt-1700000000-efgh34";

afterEach(() => {
	loggerMock.warn.mockClear();
});

// ── 三重事实判据骨架真值表（跨域单源——bash / session-manager / subagent-workflow
// 域侧映射进同一组合；原三域真值表对拍段的单点归并）──

describe("isReconcileNotifyCandidate 骨架真值表（判据链收编单源）", () => {
	const base: ReconcileNotifyFacts = {
		isTerminal: true,
		excludedByOrigin: false,
		delivered: false,
		journaled: false,
	};
	const truthTable: Array<[Partial<ReconcileNotifyFacts>, boolean, string]> = [
		[{ ...base }, true, "rejected 丢失形态（四事实全命中）→ 候选"],
		[{ isTerminal: false }, false, "在途/未终局 → 非候选"],
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

// ── 投递日志幂等键提取（事实三事实源；原 judgement.test.ts「journal entry shapes」
// 段 + session-manager/workflow 域 collectKey 展开用例的归并）──

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

	it("v2 outbox collectKey 键集展开（承载反查——条目 id ≠ 业务键的承载形态，session-manager 合批成员键 / workflow 裸 runId 双源）", () => {
		const ids = collectJournaledDeliveryIds([
			journaledOutboxEntry("batch-head-key", { collectKey: [TASK_ID, OTHER_TASK_ID] }),
		]);
		expect([...ids].sort()).toEqual(["batch-head-key", TASK_ID, OTHER_TASK_ID].sort());
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
			{ type: "custom_message", customType: BACKGROUND_BASH_CUSTOM_TYPE, content: `x ${TASK_ID}`, details: { taskId: TASK_ID } }, // 通知条目——非投递日志
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

// ── session JSONL 磁盘读侧容错（原三域 readSessionFileEntries 容错段的单点归并；
// 口径登记见 session-journal-read.ts 函数头注）──

describe("readSessionFileEntries（磁盘读侧容错）", () => {
	const DATA_DIR = mkdtempSync(join(tmpdir(), "port-readfile-"));

	it("文件缺失（ENOENT，首条对话消息前常态）→ 空数组（静默，无 warn）", () => {
		expect(readSessionFileEntries(join(DATA_DIR, "no-such-file.jsonl"))).toEqual([]);
		expect(loggerMock.warn).not.toHaveBeenCalled();
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

	it("barrel 导出与实现模块同一符号（单源单实例）", () => {
		expect(indexExport).toBe(readSessionFileEntries);
	});
});
