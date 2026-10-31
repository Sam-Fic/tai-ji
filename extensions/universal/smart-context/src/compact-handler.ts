/**
 * session_before_compact 接管 handler（D1/D11/D12/D13 核心）+ 后台压缩任务管理（D2/D3/D4，U2）。
 *
 * 同步接管路径（session_before_compact）：三条压缩路径（agent 工具 / 用户 /compact / 内建 auto）
 * 统一经过这里：
 * - 门控未放行 / 熔断 / 生成失败 → 返回空（pi 原生生成兜底，D2/D7）
 * - same-model 模式：完整上下文 + 会话原 system prompt + tools + 末尾追加压缩指令（kv-cache 前缀命中）
 * - cross-model 模式：直接调用包导出的 compact(preparation, 压缩Model, ...)（原生组装零复刻，R4 结论）
 *
 * 后台压缩路径（agent_settled 自动触发，U2）：不经过 AgentSession（D2），本文件自管——
 * - 触发判定（D4）：agent_settled + tokens 越过 ratio×窗口 + 无进行中任务 + 门控前置 + 独立熔断未开
 * - 准备数据组装：pi prepareCompaction 不在包根导出清单（实测 undefined），按 D2 用包根原子函数
 *   组装等价数据（buildContextEntries → findCutPoint → sessionEntryToContextMessages）；
 *   settings 取 DEFAULT_COMPACTION_SETTINGS（ExtensionContext 无设置读取通道，AS10）。
 *   与 pi 原生的差异点 = AS4 已登记项：findCutPoint 原始条目视角在含 context_edit 会话中
 *   可能与 pi 投影视角（findProjectedCutPoint，不导出）有一格偏移；tokensBefore 用
 *   ctx.getContextUsage() 口径。均为已接受代价，不当缺陷修。
 * - 状态机（终态形态）：session 级「空闲 ⇄ 进行中」单态互斥，生成→校验→落盘是进行中内
 *   连续序列（无「已生成未落盘」独立态）；任务自持 AbortController。
 * - 事件取消（D3 第一层，SI4）：session_start(new/resume/fork) / session_shutdown /
 *   session_compact 到达即取消任务放弃结果；session_tree 仅观测告警（回退不取消）；
 *   session_start(startup/reload) 不取消（reload 使扩展工厂重跑、内存态自清）。
 * - 独立熔断（SI5）：后台失败独立计数，连续 ≥3（沿用 TAKEOVER_FAILURE_LIMIT）停止自动触发；
 *   与同步路径 failStreak 隔离、膨胀段记录（inflatedSegments）共享读取；被抢先取消不计入。
 *
 * 输出 CompactionResult.details 携带 {engine:"smart-context", mode, model} 标记（D1 entry 标记）。
 * model = `${model.provider}/${model.id}`（执行压缩的实际模型）——用量页 compaction 归属数据源
 * （usage-page-fixes §3.3 ①）；pi appendCompaction 对 details 逐字透传落盘（pi-semantics PS-28）。
 */

import {
	buildContextEntries,
	buildSessionContext,
	compact as nativeCompact,
	convertToLlm,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	findCutPoint,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
	CompactionEntry,
	CompactionResult,
	FileOperations,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { createLogger } from "@zhushanwen/pi-extension-logger";
import { resolveModel } from "@zhushanwen/pi-llm-shared";
import { readFileSync } from "node:fs";

import { callSameModelCompaction, projectTools } from "./llm.js";
import {
	buildSameModelInstruction,
	buildTranscriptPointer,
	CHECKPOINT_PREAMBLE,
} from "./prompts.js";
import {
	buildReinjectSection,
	collectKeptReadFiles,
	computeFileListsLike,
	estimateShadowedTokens,
	estimateTextTokens,
	formatFileOperationsLike,
	getCurrentModelId,
	isGatingActive,
	isSummaryInflated,
	pickMode,
	pickReinjectFiles,
	type FileOpsLike,
	type SmartContextConfig,
} from "./pure.js";

/** session 级接管状态（session_start 重建闭包，规范 Session 隔离）。 */
export interface TakeoverState {
	/** 接管连续失败计数（D13-3 熔断：≥3 停止接管）。 */
	failStreak: number;
	/** 收缩校验失败已记录的段（firstKeptEntryId 集合，D13-1 同段不重试）。 */
	inflatedSegments: Set<string>;
}

const TAKEOVER_FAILURE_LIMIT = 3;

export function createTakeoverState(): TakeoverState {
	return { failStreak: 0, inflatedSegments: new Set() };
}

// ──────────────────────── 后台压缩任务管理（U2：D2/D3/D4） ────────────────────────

/** 触发时刻快照（SI3）：供 U3 落盘兜底校验对账（生成窗口内快照可能失效）。 */
export interface BackgroundTaskSnapshot {
	/** 触发时刻 sessionId（D3 第二层校验①：落盘时须与触发时刻一致）。 */
	sessionId: string;
	/** 触发快照末端条目 id（D3 第二层校验②：其后的追加区间内不得出现新 compaction entry）。 */
	lastEntryId: string;
	/** 触发时刻上下文用量（观测日志用，语义以 preparation.tokensBefore 为准）。 */
	tokens: number;
}

/**
 * 进行中的后台任务（状态机「进行中」态载体；null = 空闲）。
 * 生成→校验→落盘是本态内连续序列（终态形态：无「已生成未落盘」独立态——取消语义、
 * 互斥判定、落盘时机三处机制均不因「生成已完成」产生行为差异）。
 */
export interface ActiveBackgroundTask {
	/** 任务自持 AbortController（取消通道，不与 pi 锁/信号共享）。 */
	abort: AbortController;
	/** 触发时刻快照（U3 落盘兜底校验输入）。 */
	snapshot: BackgroundTaskSnapshot;
	/**
	 * 任务收尾 promise（try/finally 保证 settle）。正常路径无人 await（fire-and-forget），
	 * 暴露它是为了测试可确定性收尾（单测判据②：await 该信号等价同步语义）与调试观测。
	 */
	done: Promise<void>;
}

/** session 级后台压缩状态（session_start 重建闭包，与 TakeoverState 同生命周期口径）。 */
export interface BackgroundCompactionState {
	/** 进行中任务（null = 空闲）。互斥判定以本字段单态判定（RL1）。 */
	active: ActiveBackgroundTask | null;
	/**
	 * 后台失败独立熔断计数（SI5）：连续 ≥TAKEOVER_FAILURE_LIMIT 停止自动触发。
	 * 与同步路径 failStreak 隔离（后台失败无 pi 原生兜底，失败语义不同）；
	 * 被抢先取消不计入（取消非失败）；递增点三类 = 生成空结果 / 收缩校验失败（U3 回报）/
	 * 异常；session 级生命周期（session_start 重建归零）。
	 */
	failureStreak: number;
}

export function createBackgroundCompactionState(): BackgroundCompactionState {
	return { active: null, failureStreak: 0 };
}

/**
 * 后台触发线判定（D4）：tokens 越过 ratio×本模型窗口（越过含等于，与 findCrossedThresholds
 * 同口径）。tokens 为 null（压缩后首响应前，R7）由调用方先短路，本函数只收有限数。
 */
export function isAutoCompactTriggered(tokens: number, contextWindow: number, ratio: number): boolean {
	if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
	return tokens >= contextWindow * ratio;
}

/** 生成完成后续段的处置回报（U3 收缩校验+落盘的裁决结果，驱动独立熔断计数）。 */
export type ContinuationOutcome =
	/** 校验通过且已落盘 → 成功清零。 */
	| "validated"
	/** 收缩校验失败（摘要膨胀）放弃落盘 → 熔断递增（递增点之二）。 */
	| "inflated"
	/** 落盘兜底校验失败（sessionId 不一致 / 被抢先压缩）放弃 → 会话态失效类放弃，非生成质量问题，计数不动。 */
	| "dropped";

/**
 * 生成完成后续段钩子（U3 接线点：收缩校验 + appendCompaction 落盘 + 补偿）。
 * U2 阶段不传（缺省仅记日志）——生成与续段的边界即本契约：续段处置经返回值回流驱动熔断计数。
 */
export type AfterGenerationHook = (
	result: CompactionResult,
	snapshot: BackgroundTaskSnapshot,
	ctx: ExtensionContext,
) => Promise<ContinuationOutcome>;

/**
 * 从单条消息提取文件操作（pi extractFileOpsFromMessage 的等价组装——该函数不在包根导出，
 * 语义按 pi compaction/utils.js 实读复刻：toolResult 侧收 nestedCalls、assistant 侧收
 * toolCall blocks，按工具名 read/write/edit 归档 path 参数）。
 */
function extractFileOpsFromAgentMessage(message: Parameters<typeof estimateTokens>[0], fileOps: FileOperations): void {
	const addFileOp = (toolName: unknown, args: unknown): void => {
		const path = isRecord(args) && typeof args.path === "string" ? args.path : undefined;
		if (!path) return;
		if (toolName === "read") fileOps.read.add(path);
		else if (toolName === "write") fileOps.written.add(path);
		else if (toolName === "edit") fileOps.edited.add(path);
	};
	if (message.role === "toolResult") {
		// codemode 脚本发起的调用记录在脚本结果上（pi 同款语义）
		const rec = isRecord(message) ? message : undefined;
		const nested = isRecord(rec?.nestedCalls) ? rec.nestedCalls : undefined;
		const calls = Array.isArray(nested?.calls) ? nested.calls : [];
		for (const call of calls) {
			const c = isRecord(call) ? call : undefined;
			addFileOp(c?.name, c?.arguments);
		}
		return;
	}
	if (message.role !== "assistant") return;
	const content = isRecord(message) ? message.content : undefined;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		const b = isRecord(block) ? block : undefined;
		if (b?.type !== "toolCall") continue;
		addFileOp(b.name, b.arguments);
	}
}

/**
 * 组装被压范围 fileOps（pi extractFileOperations 等价——不在包根导出）：上一份 compaction
 * entry（pi 原生生成的才带 details 文件清单）的累积 + 被压消息逐条提取。
 */
function collectFileOps(
	messages: ReadonlyArray<Parameters<typeof estimateTokens>[0]>,
	prevCompaction: CompactionEntry | undefined,
): FileOperations {
	const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
	if (prevCompaction && !prevCompaction.fromHook) {
		const details = isRecord(prevCompaction.details) ? prevCompaction.details : undefined;
		if (Array.isArray(details?.readFiles)) {
			for (const f of details.readFiles) if (typeof f === "string") fileOps.read.add(f);
		}
		if (Array.isArray(details?.modifiedFiles)) {
			for (const f of details.modifiedFiles) if (typeof f === "string") fileOps.edited.add(f);
		}
	}
	for (const msg of messages) extractFileOpsFromAgentMessage(msg, fileOps);
	return fileOps;
}

/**
 * 后台压缩准备数据组装（D2，prepareCompaction 不在包根导出的等价组装，~50 行）：
 * buildContextEntries 取当前活动条目列表 → findCutPoint 算切点（DEFAULT_COMPACTION_SETTINGS）
 * → sessionEntryToContextMessages 组装被压消息与上一份摘要。
 *
 * 与 pi 原生 prepareCompaction 的差异 = AS4 已登记项（不当缺陷修）：
 * - 切点用 findCutPoint（原始条目视角）：含 context_edit 的会话可能与 pi 投影视角
 *   （findProjectedCutPoint，包根不导出）有一格偏移，无 context_edit 时等价；
 * - tokensBefore 用 ctx.getContextUsage() 口径（读不到时 0 兜底——仅日志/展示语义，
 *   投影切分正确性不依赖它）。
 * 返回 undefined = 无可压（条目不足 / 刚压缩完 / 全量在保留预算内）。
 */
export function buildBackgroundPreparation(
	ctx: ExtensionContext,
): SessionBeforeCompactEvent["preparation"] | undefined {
	let entries: readonly SessionEntry[];
	try {
		entries = ctx.sessionManager.getEntries();
	} catch (error) {
		debugLog(`background preparation: entries read failed: ${toErrorMessage(error)}`);
		return undefined;
	}
	const contextEntries = buildContextEntries([...entries]);
	if (contextEntries.length === 0) return undefined;
	// 末条是 compaction = 刚压缩完（appendCompaction 挂 leaf），无可压（prepareCompaction 同款前置）
	if (contextEntries[contextEntries.length - 1].type === "compaction") return undefined;

	// 最新 compaction 是活动列表首条（buildContextEntries 切分语义）；更早 compaction 的
	// 摘要已被它收编，previousSummary 只取最新一份（prepareCompaction 同款边界）
	let previousSummary: string | undefined;
	let boundaryStart = 0;
	const head = contextEntries[0];
	if (head?.type === "compaction") {
		previousSummary = head.summary;
		boundaryStart = 1;
	}

	const cutPoint = findCutPoint(contextEntries, boundaryStart, contextEntries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
	const firstKeptEntry = contextEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) return undefined;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	// 区间内的老 compaction entry 过滤（其投影贡献为空消息，AS6——仅最新 compaction 贡献摘要，
	// 原始视角组装须显式对齐，否则上一份摘要消息会混入被压段重复提交）
	const shadowedEntries = contextEntries.slice(boundaryStart, historyEnd).filter((e) => e.type !== "compaction");
	const turnPrefixEntries = cutPoint.isSplitTurn
		? contextEntries.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex).filter((e) => e.type !== "compaction")
		: [];
	const messagesToSummarize = shadowedEntries.flatMap(sessionEntryToContextMessages);
	const turnPrefixMessages = turnPrefixEntries.flatMap(sessionEntryToContextMessages);
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

	const prevCompaction = head?.type === "compaction" ? head : undefined;
	const fileOps = collectFileOps(messagesToSummarize, prevCompaction);
	if (cutPoint.isSplitTurn) {
		// split-turn 时 turnPrefix 也在压缩范围（prepareCompaction 同款提取）
		const prefixOps = collectFileOps(turnPrefixMessages, undefined);
		for (const key of ["read", "written", "edited"] as const) {
			for (const f of prefixOps[key]) fileOps[key].add(f);
		}
	}

	const tokensBefore = ctx.getContextUsage()?.tokens ?? 0;
	return {
		firstKeptEntryId: firstKeptEntry.id,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		// ExtensionContext 无 pi 设置读取通道（AS10）：用包根常量对齐基线，与用户自定义
		// pi 压缩设置的漂移为已接受代价（四要素登记见设计 AS10）
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

/**
 * 后台压缩任务管理器（U2）：触发判定 + 互斥 + 独立熔断 + 事件取消。
 *
 * state 为 session 级闭包（index.ts 在 session_start 重建后经 getState 读当前代容器——
 * 旧代任务的回调写旧闭包对象，对新状态天然无害）。afterGeneration 是 U3 续段接线点，
 * U2 阶段缺省不传。
 */
export function createBackgroundCompactionManager(
	pi: ExtensionAPI,
	getState: () => BackgroundCompactionState,
	loadConfigFn: () => SmartContextConfig,
	afterGeneration?: AfterGenerationHook,
) {
	/**
	 * 事件取消（D3 第一层）：有进行中任务则 abort 放弃结果并回空闲。
	 * 被取消不计入熔断（取消非失败——被抢先时结果本就不应落盘，D3 审讯结论）。
	 */
	const cancelActive = (reason: string): void => {
		const state = getState();
		const task = state.active;
		if (!task) return;
		state.active = null;
		task.abort.abort();
		debugLog(`background compaction cancelled: ${reason} (sessionId=${task.snapshot.sessionId})`);
	};

	/** 触发判定 + 启动（D4）。返回是否启动（供日志；判定全部前置短路）。 */
	const maybeStart = (ctx: ExtensionContext): boolean => {
		const state = getState();

		// 互斥（RL1）：任务进行中不再触发（生成→校验→落盘连续序列占用同一「进行中」态）
		if (state.active) return false;

		const config = loadConfigFn();
		const modelId = getCurrentModelId(ctx.model);
		// 门控前置（D4）：enabled 与 excludedModels，与同步接管同款判定
		if (!isGatingActive(config, modelId)) return false;

		// 独立熔断（SI5）：连续失败 ≥3 停止自动触发（只影响本入口，工具/手动路径不受影响）
		if (state.failureStreak >= TAKEOVER_FAILURE_LIMIT) {
			debugLog("background compaction circuit breaker open, skipping auto trigger");
			return false;
		}

		// 触发线（D4）：tokens 越过 ratio×窗口；读不到用量（压缩后首响应前）跳过本轮
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return false;
		if (!isAutoCompactTriggered(usage.tokens, usage.contextWindow, config.autoCompactThresholdRatio)) return false;

		// 准备数据组装（D2）：无可压（刚压缩完/预算内）→ 不触发
		const preparation = buildBackgroundPreparation(ctx);
		if (!preparation) return false;

		const entriesTail = ctx.sessionManager.getEntries();
		const snapshot: BackgroundTaskSnapshot = {
			sessionId: ctx.sessionManager.getSessionId(),
			lastEntryId: entriesTail[entriesTail.length - 1]?.id ?? "",
			tokens: usage.tokens,
		};

		// 任务自持 AbortController；异步序列 fire-and-forget（正常路径无人 await）。
		// state.active 赋值与 runBackgroundTask 调用同处一个同步帧：run 的续段都在微任务，
		// 不会在赋值前看到空 active（单线程事件循环顺序保证）
		const abort = new AbortController();
		const input: GenerationInput = {
			preparation,
			// 触发时刻快照（SI3）：branch 条目流随 preparation 组装自同一 entries 视图
			branchEntries: [...entriesTail],
			customInstructions: undefined,
			signal: abort.signal,
		};
		const mode = pickMode(config, modelId);
		// state.active 赋值与 runBackgroundTask 调用同处一个同步帧：run 的续段都在微任务，
		// 不会在赋值前看到空 active（单线程事件循环顺序保证）；task 引用先落地再回填 done，
		// run 的 finally 凭引用判「是否仍是自己」，构造性排除误清后继任务的竞态
		const task: ActiveBackgroundTask = { abort, snapshot, done: Promise.resolve() };
		state.active = task;
		task.done = runBackgroundTask(pi, ctx, config, mode, input, abort, state, snapshot, afterGeneration, task);
		debugLog(
			`background compaction started: mode=${mode} tokens=${usage.tokens} window=${usage.contextWindow} ` +
				`ratio=${config.autoCompactThresholdRatio} firstKept=${preparation.firstKeptEntryId}`,
		);
		return true;
	};

	return { maybeStart, cancelActive };
}

/**
 * 后台任务执行序列（「进行中」态内的连续序列）：生成 → 续段钩子（U3）。
 * 结局四类：cancelled（放弃结果，计数不动）/ empty（生成空结果，递增①）/ error（异常，递增③）/
 * 生成成功 → afterGeneration 处置回报（validated 清零 / inflated 递增② / dropped 不动）。
 * 任一结局回空闲（try/finally）。旧代闭包场景：写入的是捕获的旧 state 对象，无害。
 */
async function runBackgroundTask(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: SmartContextConfig,
	mode: "same-model" | "cross-model",
	input: GenerationInput,
	abort: AbortController,
	state: BackgroundCompactionState,
	snapshot: BackgroundTaskSnapshot,
	afterGeneration?: AfterGenerationHook,
	task?: ActiveBackgroundTask,
): Promise<void> {
	try {
		const result = mode === "same-model"
			? await generateSameMode(pi, ctx, input)
			: await generateCrossMode(ctx, config, input);

		// 被抢先取消：放弃结果（取消非失败，SI5 递增点不含取消）
		if (abort.signal.aborted) {
			debugLog(`background compaction discarded result after cancellation (sessionId=${snapshot.sessionId})`);
			return;
		}
		// 递增点①：生成空结果
		if (!result) {
			state.failureStreak += 1;
			warnLog("background compaction produced no result", { failureStreak: state.failureStreak });
			return;
		}

		// 生成成功 → 续段（U3 接线：收缩校验 + 落盘 + 补偿）。U2 缺省仅日志。
		if (!afterGeneration) {
			debugLog(
				`background compaction generated (continuation not wired yet): firstKept=${result.firstKeptEntryId}`,
			);
			state.failureStreak = 0;
			return;
		}
		const outcome = await afterGeneration(result, snapshot, ctx);
		if (abort.signal.aborted) {
			debugLog(`background compaction continuation discarded after cancellation (sessionId=${snapshot.sessionId})`);
			return;
		}
		if (outcome === "validated") {
			state.failureStreak = 0;
		} else if (outcome === "inflated") {
			state.failureStreak += 1;
			warnLog("background compaction summary inflated, rejected by continuation", { failureStreak: state.failureStreak });
		} else {
			debugLog(`background compaction dropped by continuation (stale snapshot, sessionId=${snapshot.sessionId})`);
		}
	} catch (error) {
		// 取消引发的异常（abort 竞态）不算失败
		if (abort.signal.aborted) {
			debugLog(`background compaction errored after cancellation (sessionId=${snapshot.sessionId})`);
			return;
		}
		// 递增点③：异常
		state.failureStreak += 1;
		warnLog("background compaction error", { error: toErrorMessage(error), failureStreak: state.failureStreak });
	} finally {
		// 回空闲：凭引用判「active 仍是本任务」才清（跨代写旧闭包对象无害；同代不误清后继）
		if (task && state.active === task) state.active = null;
	}
}


/** 统一 logger（@zhushanwen/pi-extension-logger：debug 文件日志 / warn 走 appendEntry 持久化）。 */
const logger = createLogger("smart-context");

/** 开发调试日志（TAIJI_AGENT_DEBUG=1 时写文件，默认 no-op；logging-conventions 统一通道）。 */
export function debugLog(message: string): void {
	logger.debug(message);
}

/** 内部降级/失败（事后排查价值，appendEntry 持久化不进 LLM 上下文）。 */
function warnLog(message: string, data?: unknown): void {
	logger.warn(message, data);
}

/** 压缩引擎标记（D1 entry 标记，details 字段直接落 compaction entry）。 */
export interface SmartContextDetails {
	engine: "smart-context";
	mode: "same-model" | "cross-model";
	/** 执行压缩的模型 `${provider}/${modelId}`（用量归属数据源，usage-page-fixes §3.3 ①）。 */
	model: string;
}

/** sessionManager 上会话文件字段/方法的宽松形状（D13-4，消费侧可选链兜底）。 */
interface SessionManagerSessionFileLike {
	getSessionFile?: () => string | undefined;
	sessionFile?: string;
}

/**
 * sessionManager 会话文件访问形状的运行时检查（D13-4）：
 * 只收窄到对象（字段存在性/类型由消费侧可选链 + ?? 兜底，与原语义一致）。
 */
function isSessionManagerSessionFileLike(sm: unknown): sm is SessionManagerSessionFileLike {
	return typeof sm === "object" && sm !== null;
}

/**
 * session 文件路径（transcript 回查指针用，D13-4）：从 sessionManager 推导。
 * getSessionFile 若不可得则返回空串（指针省略，不失败）。
 */
function getSessionFilePath(ctx: ExtensionContext): string {
	// 经 unknown 再检查：sessionFile 是 sessionManager 的类型未暴露字段（宽于其声明）
	const sm: unknown = ctx.sessionManager;
	const accessor = isSessionManagerSessionFileLike(sm) ? sm : undefined;
	try {
		return accessor?.getSessionFile?.() ?? accessor?.sessionFile ?? "";
	} catch {
		return "";
	}
}

/** 读文件做重注入（D13-11）：读失败/空内容返回空串（逐文件降级）。 */
function readFileForReinject(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/**
 * 组装 summary 后处理（两模式共用，D13-1/4/9/11 + D11-2）：
 * preamble + 模型摘要 + fileOps 清单 + 文件重注入节 + transcript 指针。
 */
function assembleSummary(
	summaryText: string,
	fileOps: FileOpsLike,
	branchEntries: ReadonlyArray<unknown>,
	firstKeptEntryId: string,
	sessionFilePath: string,
): string {
	const { readFiles, modifiedFiles } = computeFileListsLike(fileOps);
	let summary = `${CHECKPOINT_PREAMBLE}\n\n${summaryText}`;
	summary += formatFileOperationsLike(readFiles, modifiedFiles);

	// D13-11 文件重注入：只读文件取最近 ≤5 个（保留段已有的跳过）
	const keptReads = collectKeptReadFiles(branchEntries, firstKeptEntryId);
	const candidates = pickReinjectFiles(readFiles, keptReads);
	if (candidates.length > 0) {
		const contents = candidates.map((p) => ({ path: p, content: readFileForReinject(p) }));
		summary += buildReinjectSection(contents);
	}

	if (sessionFilePath !== "") {
		summary += buildTranscriptPointer(sessionFilePath);
	}
	return summary;
}

/**
 * 压缩生成的显式输入（U1 解耦）：从 SessionBeforeCompactEvent 摘出生成逻辑实际消费的字段。
 * 后台压缩路径（D2）没有事件对象，组装等价字段直接传入——生成逻辑与事件载体解耦，
 * same-model / cross-model 两模式共用此形状（各取所需字段）。
 * preparation 类型经索引派生：CompactionPreparation 不在 SDK 包根导出清单。
 */
interface GenerationInput {
	preparation: SessionBeforeCompactEvent["preparation"];
	branchEntries: SessionBeforeCompactEvent["branchEntries"];
	customInstructions: SessionBeforeCompactEvent["customInstructions"];
	signal: SessionBeforeCompactEvent["signal"];
}

/**
 * same-model 生成（D12）：完整上下文 + 会话原 system prompt + tools + 追加压缩指令。
 * 返回 null = 失败（调用方走 D7 回退）。
 */
async function generateSameMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	input: GenerationInput,
): Promise<CompactionResult | null> {
	const model = ctx.model;
	if (!model) {
		debugLog("same-mode: no current model");
		return null;
	}
	const { preparation, branchEntries, customInstructions, signal } = input;
	// AgentMessage[]（含 bash/custom 等扩展消息）→ 标准 Message[]（与主会话请求同源转换，
	// convertToLlm 是 pi host 默认实现——同样的输入产生同样的输出，前缀缓存对齐的前提）
	const fullMessages = convertToLlm(buildSessionContext(branchEntries).messages);
	const instructionMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: buildSameModelInstruction(customInstructions) }],
		timestamp: Date.now(),
	};
	const tools = projectTools(pi.getAllTools());
	const result = await callSameModelCompaction(ctx, {
		model,
		systemPrompt: ctx.getSystemPrompt() ?? "",
		messages: [...fullMessages, instructionMessage],
		tools,
		signal,
		sessionId: ctx.sessionManager.getSessionId(),
	});
	if (!result.ok) {
		warnLog("same-mode call failed", { error: result.error });
		return null;
	}
	// D13-2 max-tokens 截断 fail-closed：不完整 checkpoint 不采用
	if (result.stopReason === "length") {
		debugLog("same-mode: summary truncated by max-tokens, rejecting");
		return null;
	}
	if (result.text === "") {
		debugLog("same-mode: empty summary text");
		return null;
	}
	const sessionFile = getSessionFilePath(ctx);
	const summary = assembleSummary(
		result.text,
		preparation.fileOps,
		branchEntries,
		preparation.firstKeptEntryId,
		sessionFile,
	);
	return {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		usage: result.usage as CompactionResult["usage"],
		details: {
			engine: "smart-context",
			mode: "same-model",
			model: `${model.provider}/${model.id}`,
		} satisfies SmartContextDetails,
	};
}

/**
 * cross-model 生成（D12）：调用包导出的原生 compact()，仅替换 model + auth。
 * split-turn 双段合并 / fileOps 追加 / previousSummary 透传全部原生（R4 静态结论，零复刻）。
 * 返回 null = 失败（调用方走 D7 回退）。
 */
async function generateCrossMode(
	ctx: ExtensionContext,
	config: SmartContextConfig,
	input: GenerationInput,
): Promise<CompactionResult | null> {
	const model = resolveModel(ctx, config.compactModel);
	if (!model) {
		debugLog("cross-mode: compact model not available, falling back");
		return null;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		warnLog("cross-mode auth failed", { error: auth.error });
		return null;
	}
	// ProviderHeaders 值可为 null；nativeCompact 的 headers 参数是 Record<string, string>——
	// 过滤 null 值（运行时清洗而非 cast）
	const headers = auth.headers
		? Object.fromEntries(
			Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		)
		: undefined;
	const result = await nativeCompact(
		input.preparation,
		model,
		auth.apiKey,
		headers,
		input.customInstructions,
		input.signal,
		undefined,
		undefined,
		auth.env,
	);
	// D13-2：原生 compact 内部对截断的处理沿用原生语义；此处补 engine 标记
	return {
		...result,
		details: {
			...(result.details as object | undefined),
			engine: "smart-context",
			mode: "cross-model",
			model: `${model.provider}/${model.id}`,
		} as SmartContextDetails,
	};
}

/**
 * session_before_compact handler 工厂。
 *
 * state 为 session 级闭包（由 src/index.ts 在 session_start 重建后传入）。
 * 返回类型省略标注、由函数体对象字面量推断（{} / {compaction}）——SDK SessionBeforeCompactResult
 * 不在包根导出（仅深层 dist 路径可见），显式标注该名不可 import；推断形状与 SDK 逐字段同形，
 * 注册点 pi.on() 的 ExtensionHandler 泛型按结构兼容校验。
 */
export function createBeforeCompactHandler(
	pi: ExtensionAPI,
	getState: () => TakeoverState,
	loadConfigFn: () => SmartContextConfig,
) {
	return async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		const config = loadConfigFn();
		const currentModelId = getCurrentModelId(ctx.model);

		// D5 门控：禁用/排除 → 空返回（pi 原生生成）
		if (!isGatingActive(config, currentModelId)) return {};
		const state = getState();

		// D13-3 熔断：连续失败 ≥3 → 本 session 停止接管
		if (state.failStreak >= TAKEOVER_FAILURE_LIMIT) {
			debugLog("takeover circuit breaker open, falling back to native");
			return {};
		}
		// D13-1 收缩校验失败段不重试
		if (state.inflatedSegments.has(event.preparation.firstKeptEntryId)) {
			debugLog("segment previously inflated, skipping takeover");
			return {};
		}

		// D12 模式判定（现场热判，切模型/改配置后下次压缩即生效）
		const mode = pickMode(config, currentModelId);

		try {
			// 薄包装（U1 解耦）：事件对象摘出生成逻辑消费的字段，两模式共用同一输入形状
			const input: GenerationInput = {
				preparation: event.preparation,
				branchEntries: event.branchEntries,
				customInstructions: event.customInstructions,
				signal: event.signal,
			};
			const result = mode === "same-model"
				? await generateSameMode(pi, ctx, input)
				: await generateCrossMode(ctx, config, input);

			if (!result) {
				state.failStreak += 1;
				return {}; // D7 回退：pi 原生生成兜底
			}

			// D13-1 收缩校验：摘要 ≥ 被压段 → 拒绝落盘 + 记录该段
			const summaryTokens = estimateTextTokens(result.summary);
			const shadowedTokens = estimateShadowedTokens(event.preparation.messagesToSummarize);
			if (isSummaryInflated(summaryTokens, shadowedTokens)) {
				state.inflatedSegments.add(event.preparation.firstKeptEntryId);
				state.failStreak += 1;
				warnLog("summary inflated, rejecting takeover", { summaryTokens, shadowedTokens });
				return {};
			}

			state.failStreak = 0;
			debugLog(
				`takeover ok: mode=${mode} reason=${event.reason} summaryTokens=${summaryTokens} shadowedTokens=${shadowedTokens}`,
			);
			return { compaction: result };
		} catch (error) {
			state.failStreak += 1;
			warnLog("takeover error, falling back to native", { error: toErrorMessage(error) });
			return {}; // D7 回退
		}
	};
}
