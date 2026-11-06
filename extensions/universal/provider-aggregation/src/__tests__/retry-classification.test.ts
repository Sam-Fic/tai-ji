/**
 * retry 触发条件回归测试（RL6 / 验收 A6；T3 定名 retry-classification.test）。
 *
 * 锁定前提 AS13（D6 适用范围的机器红灯）：pi 自动重试按错误分类触发——瞬态错误
 * （429 限速 / 过载 / 5xx）触发重试并在重试请求的 route 调用中携带 reason=retry 与
 * failed（D6 生效窗口）；配额耗尽类文案被 pi 判为不可重试直接 fail-fast，无重算机会
 * （D6 适用边界——该场景由额度条件路由预防层与失败结构化呈现承担，AS15）。
 *
 * 判定源 = pi 实装版 pi-ai 的 isRetryableAssistantError（dist/utils/retry.js，NON
 * 先于 RETRY 判定）——本测试是对上游行为的对账锁：pi 升级改变分类清单时红灯提醒
 * 复核 D6 适用范围。真机侧厂商错误形态记录（zhipu 高峰限速 / 额度耗尽实际报什么）
 * 是 AS15 关闭点，随 M2 实施期义务执行，不在本测试覆盖范围。
 */

import { describe, expect, it } from "vitest";

import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";

/** 构造 pi 判定链的输入形态：stopReason=error + 厂商错误文案（其余字段判定链不读）。 */
function errorOf(errorMessage: string): AssistantMessage {
	return { stopReason: "error", errorMessage } as unknown as AssistantMessage
}

describe("瞬态错误 → pi 自动重试（D6 生效窗口：重试请求携带 retry 信号）", () => {
	it("429 限速形态（zhipu 高峰限速的预期形态，AS15 待真机确认）→ 可重试", () => {
		expect(isRetryableAssistantError(errorOf("429 Too Many Requests"))).toBe(true)
		expect(isRetryableAssistantError(errorOf("HTTP 429: rate limit exceeded"))).toBe(true)
	})

	it("过载与 5xx 瞬态形态 → 可重试", () => {
		expect(isRetryableAssistantError(errorOf("The provider is overloaded"))).toBe(true)
		expect(isRetryableAssistantError(errorOf("currently experiencing high demand"))).toBe(true)
		expect(isRetryableAssistantError(errorOf("500 Internal Server Error"))).toBe(true)
	})
})

describe("配额/订阅耗尽文案 → pi 不重试（D6 适用边界：无 retry 路由机会）", () => {
	it("OpenAI quota 语义（insufficient_quota）→ 不可重试", () => {
		expect(isRetryableAssistantError(errorOf("insufficient_quota: You have exceeded your quota"))).toBe(false)
	})

	it("通用配额耗尽文案（quota exceeded / out of budget / billing）→ 不可重试", () => {
		expect(isRetryableAssistantError(errorOf("quota exceeded for this plan"))).toBe(false)
		expect(isRetryableAssistantError(errorOf("You are out of budget"))).toBe(false)
		expect(isRetryableAssistantError(errorOf("billing limit reached"))).toBe(false)
	})

	it("opencode go 订阅限制文案（GoUsageLimitError / FreeUsageLimitError / Monthly usage limit reached）→ 不可重试", () => {
		expect(isRetryableAssistantError(errorOf("GoUsageLimitError: monthly limit reached"))).toBe(false)
		expect(isRetryableAssistantError(errorOf("FreeUsageLimitError"))).toBe(false)
		expect(isRetryableAssistantError(errorOf("Monthly usage limit reached"))).toBe(false)
	})

	it("NON 清单先于 RETRY 判定：文案同时含 429 与配额耗尽词 → 按不可重试（AS13 判定序）", () => {
		expect(isRetryableAssistantError(errorOf("429 insufficient_quota"))).toBe(false)
	})
})

describe("非错误停因 → 无重试（无 retry 信号产生）", () => {
	it("stopReason 非 error → 不可重试（正常完成/中止不产生 retry 路由）", () => {
		expect(isRetryableAssistantError({ stopReason: "stop", errorMessage: undefined } as unknown as AssistantMessage)).toBe(false)
	})

	it("stopReason=error 但无 errorMessage → 不可重试", () => {
		expect(isRetryableAssistantError({ stopReason: "error", errorMessage: undefined } as unknown as AssistantMessage)).toBe(false)
	})
})
