// notify-delivery-discipline.test.ts — recordManagedNotify 的投递接入纪律
// （unified-delivery 波 2：投递路径切 pi 半区投递端口后的消费纪律锁）。
//
// 覆盖（原 notify-ledger-discipline.test.ts 场景的 port 形态对位——账本装配纪律
// ①②③④与 stale 检查随账本退役：bind/recover 收敛由 pi-delivery-port 套件的
// 「重复 bind 替换并 dispose 旧实例」锁定，stale 注入 throw → 内核 retain 由其
// 「注入 throw → retain 留账」锁定，compaction 接线随 append-only 契约裁决删除）：
//   ⑤ 消费点经 getDeliveryPort() 动态查槽（禁缓存实例引用——后 bind 方 dispose
//      旧实例后缓存引用的 deliver 静默 rejected，对半概率丢全部通知的 D3⑤ 同律）；
//   通道 = managed-session-notify 外部通道（payload.customType，port 批组隔离恒
//   逐条不合批）；槽空降级（port 缺席 → warn + false，STANDARDS §11.1）；port
//   rejected（persist-failed）→ warn + false（幂等键未登记，watch 重试合法）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoggerModuleMock, getLoggerMock } from "./helpers/logger-mock.ts";

vi.mock("@zhushanwen/pi-extension-logger", () => createLoggerModuleMock());

const loggerMock = getLoggerMock();

import { recordManagedNotify } from "../notify-delivery.ts";
import type { ManagedNotifyDetails } from "../notify-content.ts";
import { DELIVERY_PORT_SLOT_KEY } from "@zhushanwen/pi-delivery-port";

// pi-delivery-port 进程级槽（C-ext-06；recordManagedNotify 的消费入口）。
const PORT_SLOT_KEY = DELIVERY_PORT_SLOT_KEY;

/** recordManagedNotify 的最小合法 details（ManagedNotifyDetails 收紧后的测试桩形状）。 */
function makeDetails(notifyId: string): ManagedNotifyDetails {
	return { notifyId, sessionId: "s-test", reason: "completed", fulfills: 1, label: "test" };
}

type DeliverCall = {
	id: string | undefined;
	customType: string;
	content: string;
	details: unknown;
	collectKey: string[] | undefined;
};

/**
 * 桩行为脚本项：accept（受理）| reject（拒收）。序列按 deliver 调用序消费（耗尽
 * 后循环末项）——「首投 rejected、重提 accepted」的 disposed 窗口重绑恢复形态用
 * ["reject", "accept"] 表达。reject 行为不进 calls（calls 只收受理）——重提单次
 * 形态的计数经「deliver 被调次数」断言（attempt 封装在桩内，calls 长度 +
 * rejected 次数还原总调次）。
 */
type DeliverStep = "accept" | "reject";

function plantPort(behavior: DeliverStep | DeliverStep[] = "accept"): Array<DeliverCall> {
	const calls: Array<DeliverCall> = [];
	const script = Array.isArray(behavior) ? behavior : [behavior];
	let attempt = 0;
	Reflect.set(globalThis, PORT_SLOT_KEY, {
		current: {
			deliver: (
				envelope: {
					id?: string;
					payload: { customType: string; content: string; details?: unknown };
				},
				opts?: { collectKey?: string[] },
			) => {
				const step = script[Math.min(attempt, script.length - 1)]!;
				attempt += 1;
				if (step === "reject") return { kind: "rejected", reason: "persist-failed (fake)" };
				calls.push({
					id: envelope.id,
					customType: envelope.payload.customType,
					content: envelope.payload.content,
					details: envelope.payload.details,
					collectKey: opts?.collectKey,
				});
				return { kind: "accepted", id: envelope.id ?? "gen-id" };
			},
			flush: () => {},
		},
	});
	return calls;
}

beforeEach(() => {
	loggerMock.warn.mockClear();
});

afterEach(() => {
	// 摘除槽注入——防泄漏到同文件后续用例（生产槽由 base-tool-enhance session_start 装配）。
	Reflect.deleteProperty(globalThis, PORT_SLOT_KEY);
});

describe("recordManagedNotify 投递接入纪律（unified-delivery 波 2：port 消费方）", () => {
	it("槽空（port 未装配）→ 降级 false + warn 留痕（通知类接入点降级，非静默吞）", () => {
		Reflect.deleteProperty(globalThis, PORT_SLOT_KEY);
		expect(recordManagedNotify("sm-x", "content", makeDetails("sm-x"), ["sm-x"])).toBe(false);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("delivery port not bound"),
			expect.objectContaining({ notifyId: "sm-x" }),
		);
	});

	it("port 在 → 动态查槽投递：id = notifyId、payload.customType = managed-session-notify（外部通道）、details 原样、collectKey 键集透传", () => {
		const delivered = plantPort();
		const details = makeDetails("sm-a");
		expect(recordManagedNotify("sm-a", "hello", details, ["sm-a", "sm-b"])).toBe(true);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]!.id).toBe("sm-a");
		expect(delivered[0]!.customType).toBe("managed-session-notify");
		expect(delivered[0]!.content).toBe("hello");
		expect(delivered[0]!.details).toBe(details);
		// collectKey 债权键集申报（result-collect 设计 §3.4）：批内全部债权键原样透传
		expect(delivered[0]!.collectKey).toEqual(["sm-a", "sm-b"]);
	});

	it("port rejected（persist-failed）→ 立即单次重提（D8①）：deliver 被调恰 2（原投 1 + 重提 1）、无第三次投递（RL10 单次形态同锁）、重提仍 rejected → false + warn 含对账恢复指引", () => {
		plantPort("reject");
		expect(recordManagedNotify("sm-rej", "content", makeDetails("sm-rej"), ["sm-rej"])).toBe(false);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("delivery port rejected notification"),
			expect.objectContaining({ notifyId: "sm-rej" }),
		);
		// RL10：重提仍 rejected 即停（无重试循环无定时器）——warn 文案含单次语义与
		// 对账边沿恢复指引（RL11 同族：持久成因不静默重试）
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("notify retry rejected after the single re-acquire attempt"),
			expect.objectContaining({ notifyId: "sm-rej" }),
		);
	});

	it("rejected 后单次重提 accepted（disposed 窗口重绑恢复形态）→ true：重提原 envelope（同幂等键同 collectKey 申报）受理即恢复", () => {
		const delivered = plantPort(["reject", "accept"]);
		expect(recordManagedNotify("sm-retry", "hello", makeDetails("sm-retry"), ["sm-retry"])).toBe(true);
		// 原投 rejected（不进 calls）+ 重提 accepted（进 calls）= 恰 1 条受理
		expect(delivered).toHaveLength(1);
		expect(delivered[0]!.id).toBe("sm-retry");
		expect(delivered[0]!.content).toBe("hello");
		expect(delivered[0]!.collectKey).toEqual(["sm-retry"]);
		// 无第三次投递（重提受理即收尾——RL10 的收尾语义）
		expect(loggerMock.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("retry rejected"),
			expect.anything(),
		);
	});

	it("投递异常（port.deliver 抛错）→ warn 留痕不外抛（不拖垮 watch 应答编排，unregister 照常）", () => {
		Reflect.set(globalThis, PORT_SLOT_KEY, {
			current: {
				deliver: () => {
					throw new Error("session context is no longer active (assertActive)");
				},
				flush: () => {},
			},
		});
		expect(() => recordManagedNotify("sm-throw", "content", makeDetails("sm-throw"), ["sm-throw"])).not.toThrow();
		expect(recordManagedNotify("sm-throw-2", "content", makeDetails("sm-throw-2"), ["sm-throw-2"])).toBe(false);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("notify delivery failed"),
			expect.objectContaining({ notifyId: "sm-throw-2" }),
		);
	});

	it("rejected 后重取缺席（重提前槽被 dispose）→ 即停转对账兜底 + warn（重提路径第二停止位，不扩直发降级）", () => {
		Reflect.set(globalThis, PORT_SLOT_KEY, {
			current: {
				deliver: () => {
					// 模拟转换窗竞态：主投 rejected 后旧实例被 dispose（槽摘除——
					// 重提的 getDeliveryPort() 将取到 undefined）
					Reflect.deleteProperty(globalThis, PORT_SLOT_KEY);
					return { kind: "rejected", reason: "persist-failed (fake)" };
				},
				flush: () => {},
			},
		});
		expect(recordManagedNotify("sm-absent", "content", makeDetails("sm-absent"), ["sm-absent"])).toBe(false);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("delivery port absent on re-acquire"),
			expect.objectContaining({ notifyId: "sm-absent" }),
		);
	});
});
