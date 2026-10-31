/**
 * 通知注入唯一出口（D4①：四类通知 nextTurn 化）。
 *
 * 四类通知（压缩结果 onComplete / onError、阈值提醒、model_select 跨界与降档两条）从
 * `sendUserMessage(deliverAs:'steer'|'followUp')` 改为 `sendMessage(deliverAs:'nextTurn',
 * triggerTurn:false)`——通知作为 custom role 上下文随下一次 prompt 注入（语义登记
 * docs/pi-semantics.json#PS-06，verifiedWith 以该登记为准：`_pendingNextTurnMessages` 常驻至被消费、不自起 run），结构上消除「通知自起 run 抢占用户
 * 消息投递跑道」——故事 C 根因：压缩完成后通知 run 与用户消息同时 prompt()，后到者被 pi 以
 * `Agent is already processing` 拒绝。
 *
 * 语义定性（设计 D4「C-ext-19 合规定性」四类两分）：
 * - 阈值提醒 / model_select 两条 = **提醒语义**（与 scheduler 2026-09-15 逐条处理完毕先例同类：
 *   提醒不承载必须必达的结果）；
 * - 压缩结果 onComplete / onError = **结果语义**，本改造是**存量域内改判而非新建
 *   at-most-once 通道**：原 steer 通道即 at-most-once 且自起 run，nextTurn 化后必达性
 *   （常驻至被消费）与运行侧（不自起 run）同时持平或改善；账本化正向要求的完整迁移维持
 *   pi-boundary-reliability 附录 B 挂着不处理不变（设计 §1.3 Out）。
 *
 * 已接受代价（设计 D4 四要素）：阈值提醒不再于 agent 空闲时立即生效，改为随用户下一条消息
 * 注入——pi 内建 overflow/threshold 自动压缩兜底在场，无人在场时上下文可能持续增长。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatK } from "./pure.js";

/** 通知的 customType（taiji 侧按此识别 system 消息来源；pi TUI display 恒 true）。 */
export const SMART_CONTEXT_NOTICE_CUSTOM_TYPE = "smart-context";

/** 通知来源（进 details.source，排障定位用）。 */
export type SmartContextNoticeSource =
	| "compact-complete"
	| "compact-failed"
	| "threshold-reminder"
	| "model-switch"
	| "model-downshift";

/**
 * 注入一条 smart-context 通知（nextTurn 投递路径，不自起 run）。
 *
 * `deliverAs:'nextTurn'` 是投递路径之一（pi 实装分支序：nextTurn 分支先命中，`triggerTurn`
 * 不再参与判定）；`triggerTurn:false` 是意图的显式声明（双写防未来实现分支序漂移）。
 * `display:true` 使通知在对话流可见——可见性按投递路径区分（D4①）：compact-result 两条（complete/
 * failed）改造前即 display:true 系统消息，可见性保持；阈值提醒/模型跨界/downshift 三条
 * 改造前 display:false 静默（只进 LLM 上下文，不进对话流），随 nextTurn 投递路径统一转
 * display:true 可见。
 */
export function sendSmartContextNotice(
	pi: Pick<ExtensionAPI, "sendMessage">,
	text: string,
	source: SmartContextNoticeSource,
): void {
	pi.sendMessage(
		{
			customType: SMART_CONTEXT_NOTICE_CUSTOM_TYPE,
			content: text,
			display: true,
			details: { source },
		},
		{ triggerTurn: false, deliverAs: "nextTurn" },
	);
}

/** 完成通知数据（U5：D6 完成通知的组装输入；token 数为压缩前后口径）。 */
export interface CompactCompleteNoticeInput {
	/** 本次压缩的模式（与生成入口判定同源）。 */
	mode: "same-model" | "cross-model";
	/** 压缩前上下文 token（触发快照口径）。 */
	tokensBefore: number;
	/** 压缩后上下文 token（estimatedTokensAfter 或「保留段 + 摘要」估算，接线层定口径）。 */
	tokensAfter: number;
}

/**
 * 后台压缩完成通知文案（D6：落盘成功后投递，含压缩前后 token 数与模式）。
 * 「下一条消息起生效」语义登记 GL3/AS3：投影按请求现算，无需用户操作。
 */
export function buildCompactCompleteNotice(input: CompactCompleteNoticeInput): string {
	return (
		`[smart-context] 后台压缩完成（${input.mode} 模式）：上下文 ` +
		`${formatK(input.tokensBefore)} → ${formatK(input.tokensAfter)} tokens。` +
		`下一条消息起将使用压缩后的上下文。`
	);
}

/** 失败通知数据（U5：D6 失败通知的组装输入；条件 = 校验放弃/探测失败/生成空结果/异常/熔断）。 */
export interface CompactFailureNoticeInput {
	/** 失败终局（dropped 涵盖落盘兜底校验放弃与 appendCompaction 探测失败两类）。 */
	outcome: "inflated" | "dropped" | "empty" | "error";
	/** outcome=error 时的错误消息。 */
	error?: string;
	/** 失败类终局的独立熔断计数（文案展示用）。 */
	failureStreak?: number;
	/** 递增后计数达到熔断阈值：自动触发已暂停（工具路径不受影响，SI5）。 */
	circuitBreakerOpen?: boolean;
}

/** 失败原因行（按终局给短语与恢复动作；「上下文保持原样」是各终局共同的不变量）。 */
function compactFailureReasonLine(input: CompactFailureNoticeInput): string {
	switch (input.outcome) {
		case "inflated":
			return "后台压缩已放弃：生成的摘要未缩小上下文（无净收益），结果未落盘，上下文保持原样。";
		case "dropped":
			return "后台压缩已放弃：生成期间会话状态已变化（被其他压缩抢先或会话已切换），结果未落盘，上下文保持原样。";
		case "empty":
			return "后台压缩失败：摘要生成未返回结果，上下文保持原样。";
		case "error":
			return `后台压缩失败：${input.error ?? "未知错误"}，上下文保持原样。`;
	}
}

/**
 * 后台压缩失败通知文案（D6：失败不静默）。熔断达到阈值时附加一行说明（同一次失败
 * 只投一条通知，熔断语义并入该条——不重复投递）。
 */
export function buildCompactFailureNotice(input: CompactFailureNoticeInput): string {
	const lines = [`[smart-context] ${compactFailureReasonLine(input)}`];
	if (input.circuitBreakerOpen) {
		lines.push(
			`已连续失败 ${input.failureStreak ?? "?"} 次，本会话自动触发压缩已暂停（compact_context 工具仍可手动调用）。`,
		);
	} else if (input.outcome === "empty" || input.outcome === "error") {
		lines.push("可稍后重试（调用 compact_context），或忽略本轮继续工作。");
	}
	return lines.join("\n");
}
