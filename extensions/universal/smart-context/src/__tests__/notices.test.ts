// src/__tests__/notices.test.ts
//
// U5/D6 通知文案构建纯函数（buildCompactCompleteNotice / buildCompactFailureNotice）。
// 投递形态断言（customType/display/{triggerTurn:false, deliverAs:"nextTurn"}）在装配层
// 覆盖：index-reminder-delivery.test.ts（提醒/模型通知）+ compact-handler.test.ts（压缩
// 完成/失败通知全接线），本文件只锁文案内容与条件分支。
//
// C1 落盘信号（sendCompactionPersistSignal）的形态在本文件直测：它是 runtime 分诊消费的
// 机器信号（非用户可见通知），字段与投递选项是跨层契约，漂移即分界行链路断。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { COMPACTION_ENTRY_APPENDED_SOURCE, SMART_CONTEXT_NOTICE_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";

import {
	buildCompactCompleteNotice,
	buildCompactFailureNotice,
	sendCompactionPersistSignal,
	sendSmartContextImmediateNotice,
	sendSmartContextNotice,
} from "../notices.js";

describe("buildCompactCompleteNotice（U5/D6 完成通知：压缩前后 token 数与模式）", () => {
	it("含模式、前后 token（formatK 口径）与下一条消息生效语义", () => {
		const text = buildCompactCompleteNotice({ mode: "same-model", tokensBefore: 190_000, tokensAfter: 45_000 });
		expect(text).toContain("[smart-context]");
		expect(text).toContain("后台压缩完成");
		expect(text).toContain("same-model");
		expect(text).toContain("190K");
		expect(text).toContain("45K");
		expect(text).toContain("下一条消息");
	});

	it("cross-model 模式名照原样展示", () => {
		const text = buildCompactCompleteNotice({ mode: "cross-model", tokensBefore: 1_234_500, tokensAfter: 200_000 });
		expect(text).toContain("cross-model");
		expect(text).toContain("1234.5K");
	});
});

describe("buildCompactFailureNotice（U5/D6 失败通知：四终局原因行，不静默）", () => {
	it("inflated（收缩校验放弃）：说明无净收益与未落盘", () => {
		const text = buildCompactFailureNotice({ outcome: "inflated" });
		expect(text).toContain("未缩小上下文");
		expect(text).toContain("未落盘");
		expect(text).toContain("[smart-context]");
	});

	it("dropped（被抢先）：说明另一轮压缩已生效，不声称「上下文保持原样」", () => {
		const text = buildCompactFailureNotice({ outcome: "dropped", droppedReason: "preempted" });
		expect(text).toContain("另一轮压缩已先行落盘");
		expect(text).toContain("未再写入");
		expect(text).not.toContain("上下文保持原样"); // 上下文已被较新压缩结果改变
	});

	it("dropped（会话已切换）：说明切换事实，不声称「上下文保持原样」", () => {
		const text = buildCompactFailureNotice({ outcome: "dropped", droppedReason: "session-mismatch" });
		expect(text).toContain("会话已切换");
		expect(text).toContain("未落盘");
		expect(text).toContain("不受本次压缩影响");
		expect(text).not.toContain("上下文保持原样");
	});

	it("dropped（写入接口不可用）：上下文确实未被触碰，如实声明保持原样", () => {
		const text = buildCompactFailureNotice({ outcome: "dropped", droppedReason: "persist-unavailable" });
		expect(text).toContain("写入接口不可用");
		expect(text).toContain("上下文保持原样");
	});

	it("dropped（未细分缺省）：只说会话状态变化与未落盘，不声称保持原样", () => {
		const text = buildCompactFailureNotice({ outcome: "dropped" });
		expect(text).toContain("会话状态已变化");
		expect(text).toContain("未落盘");
		expect(text).not.toContain("上下文保持原样");
	});

	it("empty（生成空结果）：带重试指引", () => {
		const text = buildCompactFailureNotice({ outcome: "empty" });
		expect(text).toContain("未返回结果");
		expect(text).toContain("compact_context");
	});

	it("error（异常）：错误消息嵌入文案", () => {
		const text = buildCompactFailureNotice({ outcome: "error", error: "connect ECONNREFUSED" });
		expect(text).toContain("connect ECONNREFUSED");
		expect(text).toContain("compact_context");
	});

	it("熔断达到阈值：附加「自动触发已暂停」行（并入本条，不另发通知）", () => {
		const text = buildCompactFailureNotice({ outcome: "empty", failureStreak: 3, circuitBreakerOpen: true });
		expect(text).toContain("连续失败 3 次");
		expect(text).toContain("自动触发压缩已暂停");
		expect(text).toContain("compact_context 工具仍可手动调用"); // SI5：工具路径不受熔断影响
	});

	it("未达熔断：empty/error 带重试行；inflated/dropped（含各细分原因）不带（放弃类无需重试指引）", () => {
		expect(buildCompactFailureNotice({ outcome: "empty", failureStreak: 1 })).toContain("重试");
		expect(buildCompactFailureNotice({ outcome: "inflated" })).not.toContain("重试");
		for (const droppedReason of ["preempted", "session-mismatch", "persist-unavailable"] as const) {
			expect(buildCompactFailureNotice({ outcome: "dropped", droppedReason })).not.toContain("重试");
		}
		expect(buildCompactFailureNotice({ outcome: "dropped" })).not.toContain("重试");
	});
});

describe("落盘信号词表值锚定（extension-protocol SSOT，contract.notify-custom-types 先例同款）", () => {
	it("SMART_CONTEXT_NOTICE_CUSTOM_TYPE === 'smart-context'（历史 session JSONL 已有该 customType entry，改值 = 跨侧破坏性变更）", () => {
		expect(SMART_CONTEXT_NOTICE_CUSTOM_TYPE).toBe("smart-context");
	});

	it("COMPACTION_ENTRY_APPENDED_SOURCE === 'compaction-entry-appended'（runtime 分诊 details.source 字节契约）", () => {
		expect(COMPACTION_ENTRY_APPENDED_SOURCE).toBe("compaction-entry-appended");
	});
});

describe("sendSmartContextImmediateNotice（C2 手动触发失败回执：即时可见投递）", () => {
	function makePi(): { pi: ExtensionAPI; sendMessage: ReturnType<typeof vi.fn> } {
		const sendMessage = vi.fn();
		return { pi: { sendMessage } as unknown as ExtensionAPI, sendMessage };
	}

	it("投递选项无 deliverAs（{triggerTurn:false}）——空闲即达，不进 nextTurn pending 队列", () => {
		const { pi, sendMessage } = makePi();
		sendSmartContextImmediateNotice(pi, "后台压缩未启动：原因", "compact-start-failed");
		const [message, options] = sendMessage.mock.calls[0]!;
		// toEqual 全量锁投递选项：无 deliverAs = pi sendCustomMessage 分支序不走
		// _pendingNextTurnMessages（nextTurn 通道），空闲分支直接 _appendCustomMessage
		// （立即 append + emit，用户当下可见——失败回执与触发动作不脱钩）
		expect(options).toEqual({ triggerTurn: false });
		// 消息载荷与 nextTurn 形态一致：customType 单源常量 + display:true 可见 + source 定位
		expect(message).toEqual({
			customType: SMART_CONTEXT_NOTICE_CUSTOM_TYPE,
			content: "后台压缩未启动：原因",
			display: true,
			details: { source: "compact-start-failed" },
		});
	});

	it("busy 回执同一即时形态（source=compact-busy）", () => {
		const { pi, sendMessage } = makePi();
		sendSmartContextImmediateNotice(pi, "后台压缩进行中", "compact-busy");
		const [, options] = sendMessage.mock.calls[0]!;
		expect(options).toEqual({ triggerTurn: false });
	});

	it("对照：sendSmartContextNotice（其余通知）保持 nextTurn 不动", () => {
		const { pi, sendMessage } = makePi();
		sendSmartContextNotice(pi, "后台压缩完成", "compact-complete");
		const [, options] = sendMessage.mock.calls[0]!;
		expect(options).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
	});
});

describe("sendCompactionPersistSignal（C1 落盘信号：runtime 分诊消费的机器信号）", () => {
	function makePi(impl?: () => void): { pi: ExtensionAPI; sendMessage: ReturnType<typeof vi.fn> } {
		const sendMessage = vi.fn(impl);
		return { pi: { sendMessage } as unknown as ExtensionAPI, sendMessage };
	}

	it("形态契约：customType 单源常量 + display:false + content 空串 + details{source, compactionId} + {triggerTurn:false} 无 deliverAs", () => {
		const { pi, sendMessage } = makePi();
		sendCompactionPersistSignal(pi, "entry-1");

		expect(sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = sendMessage.mock.calls[0]!;
		expect(message).toEqual({
			customType: SMART_CONTEXT_NOTICE_CUSTOM_TYPE,
			content: "",
			display: false,
			details: { source: COMPACTION_ENTRY_APPENDED_SOURCE, compactionId: "entry-1" },
		});
		// toEqual 全量锁投递选项：无 deliverAs（空闲时 pi 立即 append 并 emit，秒级直达）
		expect(options).toEqual({ triggerTurn: false });
	});

	it("compactionId undefined 透传（形状声明保守允许；runtime 侧降级尾部兜底）", () => {
		const { pi, sendMessage } = makePi();
		sendCompactionPersistSignal(pi, undefined);

		expect(sendMessage.mock.calls[0]![0].details).toEqual({
			source: COMPACTION_ENTRY_APPENDED_SOURCE,
			compactionId: undefined,
		});
	});

	it("sendMessage 同步抛错 → 内吞不上抛（上抛会把已落盘的压缩改记失败，dmg-r1-2 同语义）", () => {
		const { pi, sendMessage } = makePi(() => {
			throw new Error("boom");
		});
		expect(() => sendCompactionPersistSignal(pi, "entry-1")).not.toThrow();
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});
});
