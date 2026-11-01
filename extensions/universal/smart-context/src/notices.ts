/**
 * 通知注入唯一出口（D4①：四类通知 nextTurn 化；C1：后台压缩落盘信号即时 append 化；
 * C2 复审：手动触发失败回执即时可见化）。
 *
 * 四类通知（压缩结果 onComplete / onError、阈值提醒、model_select 跨界与降档两条）从
 * `sendUserMessage(deliverAs:'steer'|'followUp')` 改为 `sendMessage(deliverAs:'nextTurn',
 * triggerTurn:false)`——通知作为 custom role 上下文随下一次 prompt 注入（语义登记
 * docs/pi-semantics.json#PS-06，verifiedWith 以该登记为准：`_pendingNextTurnMessages` 常驻至被消费、不自起 run），结构上消除「通知自起 run 抢占用户
 * 消息投递跑道」——故事 C 根因：压缩完成后通知 run 与用户消息同时 prompt()，后到者被 pi 以
 * `Agent is already processing` 拒绝。
 *
 * 落盘信号（C1 分界行实时化）是第五条投递，走另一形态：`sendMessage({triggerTurn:false})`
 * 无 deliverAs——空闲时 pi 立即 append 并 emit message_start/end（runtime 即时收到
 * customStart 帧合成对话流分界行），streaming 窗口内挂回合尾（秒级延迟，接受）。
 *
 * 手动触发失败回执（compact-start-failed / compact-busy，C2 `__taiji_compact__` 命令路径）
 * 走同一即时形态但可见（sendSmartContextImmediateNotice）：nextTurn 的 pending 队列在用户
 * 下一条消息前不可见，而这两条回执承载的是用户刚敲的 /compact 的即时失败事实——延迟到
 * 下一条消息才出现 = 失败提示与触发动作脱钩（用户已看到「后台压缩已启动」的受理 toast，
 * 假成功观感）。即时形态空闲即达（pi sendCustomMessage 空闲分支直接 append+emit），
 * streaming 中挂回合尾（与 C1 信号同窗接受）。
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
import {
	COMPACTION_ENTRY_APPENDED_SOURCE,
	SMART_CONTEXT_NOTICE_CUSTOM_TYPE,
} from "@zhushanwen/extension-protocol";

import { debugLog } from "./compact-handler.js";
import { formatK } from "./pure.js";

// customType 单源在 extension-protocol（runtime 分诊同源消费），此处 re-export 保持既有
// import 路径（本扩展历史消费方）不变
export { SMART_CONTEXT_NOTICE_CUSTOM_TYPE };

/** 通知来源（进 details.source，排障定位用）。 */
export type SmartContextNoticeSource =
	| "compact-complete"
	| "compact-failed"
	| "compact-busy"
	| "compact-start-failed"
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

/**
 * 注入一条即时可见的 smart-context 通知（失败回执路径，不自起 run）。
 *
 * 与 sendSmartContextNotice 的差别只在投递选项：无 deliverAs + `{triggerTurn:false}`——
 * pi sendCustomMessage 该形态空闲时直接 `_appendCustomMessage`（立即 append + emit，
 * 不进 `_pendingNextTurnMessages`），streaming 窗口内挂回合尾（`_pendingCustomMessages`
 * 回合尾 flush）。消费方是「用户刚敲的命令立刻失败」类回执（compact-start-failed /
 * compact-busy）：即时事实用即时通道，nextTurn 的「常驻至下一条用户消息」对它是延迟
 * 而非必达（消息内容与触发动作脱钩）。字段载荷（customType/display/details.source）
 * 与 nextTurn 形态完全一致——runtime 分诊不区分投递路径。
 */
export function sendSmartContextImmediateNotice(
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
		{ triggerTurn: false },
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
 * 后台压缩进行中幂等回执文案（C2 手动触发入口：`__taiji_compact__` 命令在后台任务
 * 进行中再触发时的用户回执）。口径与 compact_context 工具的 busy 回执逐字一致（同一
 * 互斥事实，两入口共用一份事实描述）。
 */
export function buildCompactBusyNotice(): string {
	return "后台压缩进行中，本次请求已并入该任务，无需重复触发。压缩在后台进行，你可以继续任何工作；完成后会收到一条结果消息。";
}

/**
 * 后台压缩启动失败文案（C2 手动触发入口：`__taiji_compact__` 命令路径的非互斥失败
 * ——门控拒绝 / appendCompaction 探测失败 / 无可压内容 / 参数解码失败）。reason 透传
 * startForTool 的抛错文案（自身已含原因与恢复动作，此处只加前缀定位来源）。
 */
export function buildCompactStartFailureNotice(reason: string): string {
	return `[smart-context] 后台压缩未启动：${reason}`;
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

/**
 * 后台压缩落盘信号（C1 分界行实时化）：落盘成功这个事实点的即时通知。消费方是 taiji
 * runtime（分诊 customType + details.source 命中后取 compaction entry 合成对话流分界行帧），
 * 不是用户——content 空串 + display:false（对话流不渲染，details 是信号唯一载荷）。
 * LLM 上下文路径（实况链）：该 custom_message entry 进 pi 的上下文投影，convertToLlm 将
 * role:"custom" 无条件转 user 消息（不读 display）——content 空串即映射为空文本 text block，
 * provider transform 层过滤空 text block（不耗 token、不报错），对模型净效果为零。这是
 * 空串 content 的结构性无害，不是「不进上下文」的协议保证——content 若非空即对模型可见。
 * 投递形态 `{triggerTurn:false}` 无 deliverAs：空闲时 pi 立即 append 并 emit
 * message_start/end（agent-session sendCustomMessage 末段分支），runtime 即时收到 customStart
 * 帧；streaming 窗口内挂回合尾（秒级延迟，接受并登记）。
 *
 * 失败语义（与通知投递失败同款，dmg-r1-2）：同步抛错只 debugLog 留痕、不上抛——调用点
 * （BackgroundPersistCallbacks.onPersisted）在 persistBackgroundCompaction 的 appendCompaction
 * try 块内，上抛会把已落盘的压缩改记失败并无谓递增熔断计数（成败事实被信号失败篡改）。
 * 信号丢失的最坏结果 = 分界行退回「重开会话才可见」的原状，压缩本身不受影响。
 */
export function sendCompactionPersistSignal(
	pi: Pick<ExtensionAPI, "sendMessage">,
	compactionId: string | undefined,
): void {
	try {
		pi.sendMessage(
			{
				customType: SMART_CONTEXT_NOTICE_CUSTOM_TYPE,
				content: "",
				display: false,
				details: { source: COMPACTION_ENTRY_APPENDED_SOURCE, compactionId },
			},
			{ triggerTurn: false },
		);
	} catch (error) {
		debugLog(`compaction persist signal delivery failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
