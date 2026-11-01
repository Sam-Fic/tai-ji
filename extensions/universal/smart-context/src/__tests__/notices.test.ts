// src/__tests__/notices.test.ts
//
// U5/D6 通知文案构建纯函数（buildCompactCompleteNotice / buildCompactFailureNotice）。
// 投递形态断言（customType/display/{triggerTurn:false, deliverAs:"nextTurn"}）在装配层
// 覆盖：index-reminder-delivery.test.ts（提醒/模型通知）+ compact-handler.test.ts（压缩
// 完成/失败通知全接线），本文件只锁文案内容与条件分支。

import { describe, expect, it } from "vitest";

import { buildCompactCompleteNotice, buildCompactFailureNotice } from "../notices.js";

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

	it("dropped（校验放弃/探测失败）：说明会话状态变化与未落盘", () => {
		const text = buildCompactFailureNotice({ outcome: "dropped" });
		expect(text).toContain("会话状态已变化");
		expect(text).toContain("未落盘");
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

	it("未达熔断：empty/error 带重试行；inflated/dropped 不带（放弃类无需重试指引）", () => {
		expect(buildCompactFailureNotice({ outcome: "empty", failureStreak: 1 })).toContain("重试");
		expect(buildCompactFailureNotice({ outcome: "inflated" })).not.toContain("重试");
		expect(buildCompactFailureNotice({ outcome: "dropped" })).not.toContain("重试");
	});
});
