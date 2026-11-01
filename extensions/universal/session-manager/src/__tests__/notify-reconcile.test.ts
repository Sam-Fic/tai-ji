// notify-reconcile.test.ts — session-manager 域通知对账步的判据与补投形态
// （completion-signal-delivery D8：SC10 pending 表派生视图四项读取规则 + 域过滤
// + 骨架简报补投形态锁）。
//
// 全部同步逻辑层（TEST-STRATEGY 三档判据①：entries 注入 + submitNotify spy——
// 零真盘零真进程零 timer）；entries 形态锚定落盘契约（pending:register 三键 +
// type、pending:unregister { id, reason, status }、managed-session-notify 通知条目
// details、delivery-port outbox/ack v2 条目 data）。
//
// 覆盖面（验收条款 3「域过滤与四项读取规则判据单测」+ 验收条款 4 检查点机械项）：
//   真值表（骨架同构对拍 u1 四态）；① 全量 entries 现算（已注销条目仍是判据对象、
//   active 条目非候选）；② 静默注销类原词排除（cancelled/orphaned）；③(a) 合批非首
//   成员承载反查（批首 collectKey 键集 ∪ 条目 id）；③(b) 死亡新闻对排除（同
//   (label, reason∈{exited,deleted}) 已送达——跨 label 不误伤）；④ 域过滤（四域
//   混装互斥排除）；补投形态（骨架简报：label/status 两事实入文、不含 sessionId、
//   fulfills=0——D8⑤/R-1 锁）；幂等收敛（补投受理后 journal 承载抵消）；死亡槽
//   内存态缺席不阻断补投（判据不读死亡槽——SC10 登记）。

import { describe, expect, it, vi } from "vitest";

import { PENDING_REGISTER_ENTRY_TYPE, PENDING_UNREGISTER_ENTRY_TYPE } from "@zhushanwen/extension-protocol";
import { ACK_CUSTOM_TYPE, OUTBOX_CUSTOM_TYPE } from "@zhushanwen/pi-delivery-port";

import { MANAGED_SESSION_NOTIFY_CUSTOM_TYPE } from "../notify-content.ts";
import {
	collectDeliveredDeathPairs,
	collectDeliveredManagedNotifyIds,
	collectJournaledDeliveryIds,
	collectUnregisterReasons,
	buildManagedReconcileBriefing,
	isReconcileNotifyCandidate,
	runNotifyReconcileMaintenance,
	type ReconcileNotifyFacts,
} from "../notify-reconcile.ts";

// ── entries 构造（落盘契约锚定形态）──

function registerEntry(id: string, type = "session", name = `label-${id}`): unknown {
	return {
		type: "custom",
		customType: PENDING_REGISTER_ENTRY_TYPE,
		data: { id, type, name, registeredAt: 1, sessionId: "parent-s" },
	};
}

function unregisterEntry(id: string, reason: string): unknown {
	return {
		type: "custom",
		customType: PENDING_UNREGISTER_ENTRY_TYPE,
		data: { id, reason, status: "completed" },
	};
}

/** 本域已送达通知条目（主路径/补投 payload 落盘形态：details 携 notifyId）。 */
function notifyEntry(notifyId: string, label: string, reason: string): unknown {
	return {
		type: "custom",
		customType: MANAGED_SESSION_NOTIFY_CUSTOM_TYPE,
		content: `Managed session "${label}" (child-s) finished with status "${reason}".`,
		display: true,
		details: { notifyId, sessionId: "child-s", reason, fulfills: 2, label },
	};
}

/** 投递日志 outbox v2 条目（受理落盘；collectKey = 债权键集申报）。 */
function outboxEntry(id: string, collectKey?: string[]): unknown {
	return {
		type: "custom",
		customType: OUTBOX_CUSTOM_TYPE,
		data: {
			v: 2,
			id,
			timing: "steer",
			payload: { kind: "custom", customType: MANAGED_SESSION_NOTIFY_CUSTOM_TYPE, content: "x", display: true },
			recordedAt: 1,
			...(collectKey !== undefined ? { collectKey } : {}),
		},
	};
}

function ackEntry(id: string): unknown {
	return { type: "custom", customType: ACK_CUSTOM_TYPE, data: { v: 2, id, outcome: "delivered" } };
}

/** 对账编排输入的最小形态（submitNotify 默认受理成功）。 */
function makeDeps(entries: unknown[], submitNotify = vi.fn(() => true)) {
	return { reason: "test", entries, submitNotify };
}

// ── 骨架真值表（同构对拍：终态 ∧ 未排除 ∧ 无痕迹 ∧ 无承载）──

describe("isReconcileNotifyCandidate 骨架真值表（跨域同构——u1 单源对拍）", () => {
	const base: ReconcileNotifyFacts = {
		isTerminal: true,
		excludedByOrigin: false,
		delivered: false,
		journaled: false,
	};
	const truthTable: Array<[Partial<ReconcileNotifyFacts>, boolean, string]> = [
		[{ ...base }, true, "rejected 丢失形态（四事实全命中）→ 候选"],
		[{ isTerminal: false }, false, "在途/未注销 → 非候选"],
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

// ── 四项读取规则①：全量 entries 现算（注销条目是判据对象）──

describe("四项读取规则① 取数形态（pending 表派生视图）", () => {
	it("正类：应投递而 rejected（register+unregister 全量对 + 无痕迹无承载）→ 恰 1 补投", () => {
		const submit = vi.fn(() => true);
		const result = runNotifyReconcileMaintenance(
			makeDeps([registerEntry("sm-1"), unregisterEntry("sm-1", "completed")], submit),
		);
		expect(result.candidates).toBe(1);
		expect(result.redelivered).toEqual(["sm-1"]);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("注销条目仍是判据对象（非 active 视图）：已注销键出候选——与 active 差集读法结构性区分", () => {
		// 同一 entries 若按 active 差集读（register−unregister），sm-1 消失、
		// 候选不可达；全量现算读法下 sm-1 是候选——本用例锁「候选非空」即锁读法。
		const submit = vi.fn(() => true);
		const result = runNotifyReconcileMaintenance(
			makeDeps([registerEntry("sm-1"), unregisterEntry("sm-1", "exited")], submit),
		);
		expect(result.candidates).toBe(1);
	});

	it("active 条目（无 unregister）非候选：新闻未到达，不虚构补投", () => {
		const submit = vi.fn(() => true);
		const result = runNotifyReconcileMaintenance(makeDeps([registerEntry("sm-live")], submit));
		expect(result.candidates).toBe(0);
		expect(submit).not.toHaveBeenCalled();
	});
});

// ── 四项读取规则②：静默注销类原词排除 ──

describe("四项读取规则② 静默注销类排除（unregister reason 原词分流）", () => {
	it.each(["cancelled", "orphaned"] as const)(
		"reason=%s（例外1 静默注销族）→ 零补投",
		(reason) => {
			const submit = vi.fn(() => true);
			const result = runNotifyReconcileMaintenance(
				makeDeps([registerEntry("sm-q"), unregisterEntry("sm-q", reason)], submit),
			);
			expect(result.candidates).toBe(0);
			expect(submit).not.toHaveBeenCalled();
		},
	);

	it("collectUnregisterReasons 读 reason 原词（非解析枚举——stopped/exited/deleted 不被折叠）", () => {
		const reasons = collectUnregisterReasons([
			unregisterEntry("sm-a", "stopped"),
			unregisterEntry("sm-b", "exited"),
			unregisterEntry("sm-c", "cancelled"),
			{ type: "custom", customType: PENDING_UNREGISTER_ENTRY_TYPE, data: { id: "sm-bad" } }, // 缺 reason
			{ type: "custom", customType: "other", data: { id: "sm-x", reason: "completed" } }, // 词表外条目
		]);
		expect(reasons.get("sm-a")).toBe("stopped");
		expect(reasons.get("sm-b")).toBe("exited");
		expect(reasons.get("sm-c")).toBe("cancelled");
		expect(reasons.has("sm-bad")).toBe(false);
		expect(reasons.has("sm-x")).toBe(false);
	});
});

// ── 四项读取规则③：三类「无独立主路径投递」形态排除 ──

describe("四项读取规则③(a) 合批非首成员排除（承载反查：journal id ∪ collectKey 键集）", () => {
	it("批首成功受理形态：成员键被批首条目 collectKey 承载 → 成员零补投；批首自身有条目 id → 整批零补投", () => {
		const submit = vi.fn(() => true);
		const result = runNotifyReconcileMaintenance(
			makeDeps(
				[
					registerEntry("sm-head"),
					registerEntry("sm-member"),
					outboxEntry("sm-head", ["sm-head", "sm-member"]), // 批首条目承载两键
					unregisterEntry("sm-head", "completed"),
					unregisterEntry("sm-member", "completed"),
				],
				submit,
			),
		);
		expect(result.candidates).toBe(2);
		expect(result.redelivered).toEqual([]); // 双双被承载反查排除
		expect(submit).not.toHaveBeenCalled();
	});

	it("批首 rejected 形态（无条目无承载）：成员键反查不命中也不虚构——成员与批首磁盘同形态时保持判据单义（残余边界登记见实现注释）", () => {
		// 批首 rejected 是正类（补投对象）；成员键在同批 rejected 形态下无任何承载
		// 事实可辨——本用例锁定该形态下判据的行为面（成员与批首同样出候选），
		// 残余边界（重复刺激级）已在实现注释呈报。
		const submit = vi.fn(() => true);
		const result = runNotifyReconcileMaintenance(
			makeDeps(
				[registerEntry("sm-head"), registerEntry("sm-member"), unregisterEntry("sm-head", "completed"), unregisterEntry("sm-member", "completed")],
				submit,
			),
		);
		expect(result.candidates).toBe(2);
		expect(result.redelivered).toEqual(["sm-head", "sm-member"]);
	});

	it("collectJournaledDeliveryIds 展开 collectKey 键集（承载反查的事实源）+ ack 终局并入", () => {
		const ids = collectJournaledDeliveryIds([
			outboxEntry("sm-head", ["sm-head", "sm-member"]),
			ackEntry("sm-acked"),
			{ type: "custom", customType: OUTBOX_CUSTOM_TYPE, data: { broken: true } }, // 畸形跳过
		]);
		expect(ids.has("sm-head")).toBe(true);
		expect(ids.has("sm-member")).toBe(true); // 承载键
		expect(ids.has("sm-acked")).toBe(true);
		expect(ids.size).toBe(3);
	});
});

describe("四项读取规则③(b) 死亡新闻对排除（死亡槽去重的判据侧磁盘投影）", () => {
	it("同 (label, exited) 新闻已送达 → 后续批键（同 label 同 reason）零补投", () => {
		const submit = vi.fn(() => true);
		const result = runNotifyReconcileMaintenance(
			makeDeps(
				[
					registerEntry("sm-later", "session", "research"), // 后续批键，label 同前批
					notifyEntry("sm-earlier", "research", "exited"), // 前批死亡新闻已送达
					unregisterEntry("sm-later", "exited"),
				],
				submit,
			),
		);
		expect(result.candidates).toBe(1);
		expect(result.redelivered).toEqual([]); // 死亡对命中排除
		expect(result.skippedDelivered).toEqual(["sm-later"]);
	});

	it("同 (label, deleted) 同款排除；死亡对只作用于死亡类 reason——completed 后续批不误吞", () => {
		const submit = vi.fn(() => true);
		const deleted = runNotifyReconcileMaintenance(
			makeDeps(
				[registerEntry("sm-d", "session", "research"), notifyEntry("sm-d0", "research", "deleted"), unregisterEntry("sm-d", "deleted")],
				submit,
			),
		);
		expect(deleted.redelivered).toEqual([]);

		const completed = runNotifyReconcileMaintenance(
			makeDeps(
				[registerEntry("sm-c", "session", "research"), notifyEntry("sm-c0", "research", "completed"), unregisterEntry("sm-c", "completed")],
				submit,
			),
		);
		// 结果新闻无槽去重语义：同 label 的 completed 已送达不构成对——rejected 待补投候选保留
		expect(completed.redelivered).toEqual(["sm-c"]);
	});

	it("不同 label 不误伤：label B 的死亡新闻已送达不阻断 label A 的待补投死亡新闻", () => {
		const submit = vi.fn(() => true);
		const result = runNotifyReconcileMaintenance(
			makeDeps(
				[registerEntry("sm-a", "session", "alpha"), notifyEntry("sm-b0", "beta", "exited"), unregisterEntry("sm-a", "exited")],
				submit,
			),
		);
		expect(result.redelivered).toEqual(["sm-a"]);
	});

	it("collectDeliveredDeathPairs 只收死亡类 reason（exited/deleted）", () => {
		const pairs = collectDeliveredDeathPairs([
			notifyEntry("sm-1", "alpha", "exited"),
			notifyEntry("sm-2", "beta", "deleted"),
			notifyEntry("sm-3", "gamma", "completed"),
		]);
		expect([...pairs]).toEqual(["alpha\u0000exited", "beta\u0000deleted"]); // 键分隔符 NUL（转义形态断言）
		expect(pairs.has("gamma\u0000completed")).toBe(false); // 结果新闻不进死亡对
	});
});

// ── 四项读取规则④：域过滤（pending 表四域混装互斥排除）──

describe("四项读取规则④ 域过滤（只取 type==='session'）", () => {
	it.each([
		["bash", "bt-1"],
		["subagent", "rec-1"],
		["workflow", "wf-1"],
	] as const)("跨域条目 type=%s → 零补投（跨域三重全命中误报的互斥排除）", (type, id) => {
		const submit = vi.fn(() => true);
		const result = runNotifyReconcileMaintenance(
			makeDeps([registerEntry(id, type, `name-${id}`), unregisterEntry(id, "completed")], submit),
		);
		expect(result.candidates).toBe(0);
		expect(submit).not.toHaveBeenCalled();
	});
});

// ── 幂等收敛与补投出口语义 ──

describe("对账幂等与补投出口", () => {
	it("补投受理后的下一对账边沿零补投：outbox 条目承载抵消判据（跨边沿幂等）", () => {
		const entries = [registerEntry("sm-1"), unregisterEntry("sm-1", "completed")];
		const first = runNotifyReconcileMaintenance(makeDeps(entries, vi.fn(() => true)));
		expect(first.redelivered).toEqual(["sm-1"]);
		// 补投受理 → outbox 条目落盘（id = notifyId）——下一边沿的 entries 已含承载事实
		const entriesAfter = [...entries, outboxEntry("sm-1")];
		const second = runNotifyReconcileMaintenance(makeDeps(entriesAfter, vi.fn(() => true)));
		expect(second.redelivered).toEqual([]);
		expect(second.skippedJournaled).toEqual(["sm-1"]);
	});

	it("送达痕迹抵消（details.notifyId / details.deliveryId 双通道）", () => {
		const ids = collectDeliveredManagedNotifyIds([
			notifyEntry("sm-1", "alpha", "completed"), // details.notifyId
			{
				type: "custom",
				customType: MANAGED_SESSION_NOTIFY_CUSTOM_TYPE,
				details: { deliveryId: "sm-2" }, // port 受理凭据键
			},
		]);
		expect(ids.has("sm-1")).toBe(true);
		expect(ids.has("sm-2")).toBe(true);
	});

	it("submitNotify false（port 缺席/重提链失败）→ 不计 redelivered，候选判据保留（下一边沿幂等重查）", () => {
		const submit = vi.fn(() => false);
		const result = runNotifyReconcileMaintenance(
			makeDeps([registerEntry("sm-1"), unregisterEntry("sm-1", "completed")], submit),
		);
		expect(result.candidates).toBe(1);
		expect(result.redelivered).toEqual([]);
	});

	it("畸形 entries 元素容错（null/词表外条目跳过——容错形态对齐 protocol 扫描纪律）", () => {
		const submit = vi.fn(() => true);
		const result = runNotifyReconcileMaintenance(
			makeDeps([null, 42, registerEntry("sm-1"), unregisterEntry("sm-1", "failed")], submit),
		);
		expect(result.redelivered).toEqual(["sm-1"]);
	});
});

// ── 补投形态：骨架简报（D8⑤ + R-1）──

describe("补投形态（D8⑤ 骨架简报 + R-1 不调主路径构造）", () => {
	it("骨架简报：label/status 两事实入文、不含 sessionId 段、details.fulfills 取 0、notifyId = 候选键", () => {
		const submit = vi.fn(() => true);
		const result = runNotifyReconcileMaintenance(
			makeDeps([registerEntry("sm-9", "session", "research"), unregisterEntry("sm-9", "exited")], submit),
		);
		expect(result.redelivered).toEqual(["sm-9"]);
		expect(submit).toHaveBeenCalledWith(
			"sm-9",
			'Managed session "research" finished with status "exited".',
			{ notifyId: "sm-9", reason: "exited", fulfills: 0, label: "research" },
		);
	});

	it("buildManagedReconcileBriefing 独立构造（R-1）：不产 sessionId 字段、fulfills 恒 0（无债权申报不虚构笔数）", () => {
		const briefing = buildManagedReconcileBriefing("sm-9", "research", "failed");
		expect(Object.keys(briefing.details).sort()).toEqual(["fulfills", "label", "notifyId", "reason"]);
		expect(briefing.details.fulfills).toBe(0);
		expect(briefing.content).toContain('"research"');
		expect(briefing.content).toContain('"failed"');
		expect(briefing.content).not.toContain("("); // 无 (sessionId) 段——主路径形态的缺席省略
	});
});

// ── 死亡槽内存态不参与判据（SC10 登记）──

describe("死亡槽 (sessionId, deathSeq) 内存态缺席不阻断补投", () => {
	it("判据不读死亡槽：重启后死亡槽清空的形态下，rejected 死亡新闻仍出候选并补投", () => {
		// entries 不含任何死亡槽信息（运行期内存态）——判据照常出候选
		const submit = vi.fn(() => true);
		const result = runNotifyReconcileMaintenance(
			makeDeps([registerEntry("sm-d", "session", "research"), unregisterEntry("sm-d", "exited")], submit),
		);
		expect(result.redelivered).toEqual(["sm-d"]);
	});
});
