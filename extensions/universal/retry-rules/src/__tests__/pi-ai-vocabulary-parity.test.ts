/**
 * pi-ai 词表对拍测试（架构腐化审计 retry-rules.md 候选 1 的机器锁）。
 *
 * 本扩展的功能命脉：evaluateRetryRules 命中后 appendRetryMarker 向 errorMessage 追加
 * 锚文本 `rate limit 429 too many requests`，靠 pi-ai 原生重试循环的词表匹配
 * （isRetryableAssistantError）从文本内容识别出「可重试」。此前该前提只有
 * rules.ts:165-167 的人工核对快照（标注 1.0.0 实装），无任何机器锁——pi-ai 升级
 * 调整词表时锚文本静默失效 = 扩展整体功能归零且无测试红。
 *
 * 对拍形态说明：pi-ai 的 RETRYABLE / NON_RETRYABLE 词表正则**不是导出成员**
 * （dist/utils/retry.js 实装核对：两个 pattern 均为模块私有 const），导出面只有
 * isRetryableAssistantError / retryAssistantCall / retryDelayMs /
 * DEFAULT_MAX_AGENT_RETRY_DELAY_MS。故本测试以导出函数做行为级对拍——
 * isRetryableAssistantError 返回 true 当且仅当「命中 RETRYABLE 词表 且 不命中
 * NON_RETRYABLE 词表」（NON_RETRYABLE 先检，命中即否决），恰好完整覆盖锚文本
 * 成立所需的两个前提。
 *
 * 不做逐成员断言（如单独测 `rate.?limit` / `429` / `too many requests` 各自在场）：
 * 锚文本的冗余度（三条任一命中即触发）是缓冲而非契约，逐成员断言会在 pi-ai 合法
 * 收窄词表（只要仍命中一条）时误报。本测试只锁真正的不变量：改写后的消息必被
 * pi-ai 判为可重试。
 *
 * @earendil-works/pi-ai 仅测试面消费（devDependencies 直引，与
 * retry-rules-validation-parity.test.ts import @taiji/shared 同款先例，bundle
 * 自包含不受影响）。单包环境未安装该 devDependency 时本文件 import 即失败
 * （不 skip）——先补装 `@earendil-works/pi-ai`（版本对齐根 node_modules 实装）再跑。
 */
import { describe, expect, it } from "vitest";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";

import {
	appendRetryMarker,
	evaluateRetryRules,
	RETRY_REWRITE_MARKER,
	type RetryableErrorRule,
} from "../rules.ts";

/**
 * pi-ai isRetryableAssistantError 的最小消费面探针（dist/utils/retry.js 实装只读
 * stopReason / errorMessage 两字段）；AssistantMessage 完整接口字段众多，探针做
 * 结构收窄传参（测试面收窄，不改运行时行为）。
 */
type ProbeMessage = { stopReason: "error"; errorMessage: string };

function probe(errorMessage: string): Parameters<typeof isRetryableAssistantError>[0] {
	return { stopReason: "error", errorMessage } as unknown as Parameters<typeof isRetryableAssistantError>[0];
}

/** pi-ai 侧判定：该 errorMessage 是否会被原生重试循环判为可重试。 */
function piAiRetryable(errorMessage: string): boolean {
	return isRetryableAssistantError(probe(errorMessage));
}

/**
 * 矩阵原文分两组：
 * - 「词表外原文」：pi-ai 词表本身不命中（改写前 false）——锚文本是命中的唯一来源，
 *   证明扩展机制在起作用而非原文自带可重试性；
 * - 「词表内原文」：常见限流原文本身已命中（改写前 true）——改写后必须保持 true
 *   （不因追加标记而意外跌出词表或撞上 NON_RETRYABLE）。
 */
const ORIGINALS_OUTSIDE_VOCABULARY: { label: string; message: string }[] = [
	{ label: "会员 RPM 限流原文（builtin 规则的真实命中形态）", message: "membership rpm limit exceeded: 101/100 resets 2026-10-23T12:00:00.000Z" },
	{ label: "上游容量故障原文", message: "Unknown upstream provider failure" },
	{ label: "JSON 错误码原文（jsonPath 通道的真实命中形态，无状态码前缀）", message: '{"error":{"code":"1302","message":"tokens per minute limited"}}' },
];

const ORIGINALS_INSIDE_VOCABULARY: { label: string; message: string }[] = [
	{ label: "Rate limit 文本", message: "Rate limit reached, please retry later" },
	{ label: "Too Many Requests 文本", message: "Too Many Requests" },
	{ label: "网络错误文本", message: "Connection error while calling provider" },
	{ label: "服务端 5xx 文本", message: "provider returned 503 Service Unavailable" },
	{ label: "带 429 前缀的 JSON 错误码原文（jsonPath 通道的真实落盘形态）", message: '429: {"error":{"code":"1302","message":"tokens per minute limited"}}' },
];

describe("pi-ai 词表对拍：锚文本命中 RETRYABLE 词表（改写后必触发原生重试）", () => {
	it("锚文本单独作为 errorMessage 即命中（RETRYABLE 词表包含限流语义成员）", () => {
		expect(piAiRetryable(RETRY_REWRITE_MARKER)).toBe(true);
	});

	it("改写幂等形态（原文已带标记）同样命中", () => {
		const once = appendRetryMarker("some provider failure");
		const twice = appendRetryMarker(once);
		expect(twice).toBe(once);
		expect(piAiRetryable(twice)).toBe(true);
	});

	for (const { label, message } of ORIGINALS_OUTSIDE_VOCABULARY) {
		it(`词表外原文改写后命中：${label}`, () => {
			expect(piAiRetryable(message), "改写前应不命中（该原文不在 pi-ai 词表内）").toBe(false);
			expect(piAiRetryable(appendRetryMarker(message)), "改写后必须命中（锚文本是命中的唯一来源）").toBe(true);
		});
	}

	for (const { label, message } of ORIGINALS_INSIDE_VOCABULARY) {
		it(`词表内原文改写后保持命中：${label}`, () => {
			expect(piAiRetryable(message)).toBe(true);
			expect(piAiRetryable(appendRetryMarker(message))).toBe(true);
		});
	}

	it("端到端链路：evaluateRetryRules 命中 → appendRetryMarker → pi-ai 判可重试", () => {
		const rateRule: RetryableErrorRule = {
			id: "parity-rate",
			name: "对拍限流规则",
			verdict: "retryable",
			match: [{ kind: "pattern", pattern: "rpm limit exceeded" }],
			class: "provider",
			source: "custom",
		};
		const original = ORIGINALS_OUTSIDE_VOCABULARY[0].message;
		const decision = evaluateRetryRules(original, [rateRule]);
		expect(decision).toEqual({ action: "rewrite" });
		const rewritten = decision.action === "rewrite" ? appendRetryMarker(original) : original;
		expect(piAiRetryable(rewritten), "扩展判 rewrite 的消息必须被 pi-ai 原生重试循环接受").toBe(true);
	});
});

describe("pi-ai 词表对拍：改写消息不命中 NON_RETRYABLE 词表", () => {
	// isRetryableAssistantError 先检 NON_RETRYABLE（命中即否决返回 false）再检 RETRYABLE，
	// 故「返回 true」本身即证明整条改写消息（原文 + 锚文本）不命中任何 NON_RETRYABLE
	// 成员——上面全部 true 断言已覆盖。此处再补锚文本与常见限流原文的直接否决反证。
	it("锚文本不含任何 NON_RETRYABLE 成员（billing / quota 类词均不在场）", () => {
		expect(RETRY_REWRITE_MARKER).not.toMatch(/billing|quota|budget|insufficient/i);
		expect(piAiRetryable(RETRY_REWRITE_MARKER)).toBe(true);
	});

	it("常见限流原文 + 锚文本的组合仍为 true（组合文本不意外触发否决词表）", () => {
		for (const { message } of [...ORIGINALS_OUTSIDE_VOCABULARY, ...ORIGINALS_INSIDE_VOCABULARY]) {
			expect(piAiRetryable(appendRetryMarker(message))).toBe(true);
		}
	});
});

describe("pi-ai 词表对拍：账户类硬约束否决锚文本（跨包次序锁）", () => {
	// pi-ai 先检 NON_RETRYABLE：账户类原文（insufficient_quota / billing 等）即使被追加
	// 锚文本也判不可重试——锚文本机制无法击穿账户类硬约束。这与本扩展判定管线第一层
	// non_retryable 排除是同族语义（账户类错误永不误重试），两侧任一失去该次序都应
	// 在此红灯（pi-ai 升级若调整否决次序 = 本扩展「保守不误重试」前提失效）。
	const NON_RETRYABLE_ORIGINALS: { label: string; message: string }[] = [
		{ label: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details (insufficient_quota)" },
		{ label: "billing", message: "Your billing plan has expired" },
		{ label: "quota exceeded", message: "quota exceeded for this organization" },
	];

	for (const { label, message } of NON_RETRYABLE_ORIGINALS) {
		it(`账户类原文（${label}）追加锚文本后仍不可重试（NON_RETRYABLE 先检否决）`, () => {
			expect(piAiRetryable(message)).toBe(false);
			expect(piAiRetryable(appendRetryMarker(message)), "锚文本不得击穿账户类硬约束").toBe(false);
		});
	}
});
