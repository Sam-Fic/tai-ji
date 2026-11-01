/**
 * session_before_compact 接管 handler（上一代接管设计核心：门控 / 双模式生成 / 收缩校验 / 熔断）+ 后台压缩任务管理（D2/D3/D4，U2）。
 *
 * 编号消歧：本文件旧段（接管 handler 与其状态、组装与生成的注释）引用的
 * D1（entry 标记）/D2/D7/D11/D12/D13-x/R4/R7/§8.3 指上一代 smart-context 接管设计
 * 与 pi 观察级清单（文档已不在可达域，按注释内联语义理解）；裸 D2-D6/SI/UD/RL/AS
 * 指本设计（async-compaction）。两套编号同名不同义，凡与上下文对不上的按旧号处理。
 *
 * 同步接管路径（session_before_compact）：三条压缩路径（agent 工具 / 用户 /compact / 内建 auto）
 * 统一经过这里：
 * - 门控未放行 / 熔断 / 生成失败 → 返回空（pi 原生生成兜底，接管设计 D2/D7）
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
 * - 落盘兜底校验 + appendCompaction 直调 + 档位重置补偿（U3：D3 第二层 / D2 / D6）：
 *   validateBackgroundPersist 三项校验（sessionId 一致 / 无被抢先 compaction / 收缩校验）
 *   任一失败放弃落盘；persistBackgroundCompaction 直调 sessionManager.appendCompaction
 *   （local 形状声明 + 存在性探测，fromHook=true 与同步接管一致）；落盘成功经回调清
 *   firedThresholds（D6，与 session_compact 监听共用）。
 * - 独立熔断（SI5）：后台失败独立计数，连续 ≥3（沿用 TAKEOVER_FAILURE_LIMIT）停止自动触发；
 *   与同步路径 failStreak 隔离、膨胀段记录（inflatedSegments）共享读取；被抢先取消不计入。
 * - 工具路径启动（U5 接线残项）：startForTool = compact_context 显式请求（互斥 + 门控前置，
 *   跳过触发线与独立熔断——SI5 两者仅约束自动触发；非互斥失败抛错不谎报幂等）。
 * - 终局通知（U5/D6 呈现半边）：runBackgroundTask 各终局回调 onSettled 恰一次
 *   （cancelled 不回调），接线层（index.ts）组装完成/失败文案经 nextTurn 投递。
 *
 * 输出 CompactionResult.details 携带 {engine:"smart-context", mode, model} 标记（接管设计 D1：entry 标记）。
 * model = `${model.provider}/${model.id}`（执行压缩的实际模型）——用量页 compaction 归属数据源
 * （pi-semantics.json PS-28：appendCompaction 对 details 逐字透传落盘，归属字段必然随 entry 落盘）。
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
	SessionBeforeCompactResult,
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
	/** 触发快照末端条目 id（观测/遗留字段：生产逻辑零消费——校验②由 compactionIds 集合判定承担，见其注释；测试快照断言在用）。 */
	lastEntryId: string;
	/** 触发时刻上下文用量（观测/遗留字段：生产逻辑零消费——启动日志与触发线判定均取 launchTask 入参 usageTokens；语义以 preparation.tokensBefore 为准）。 */
	tokens: number;
	/**
	 * 触发时刻 branch 上全部 compaction entry id（D3 第二层校验②的已知集合）：
	 * 校验②落地为「当前 branch 上出现未知 id 的 compaction = 被抢先」——锚点条目可定位时
	 * 与「快照末端之后区间扫描」等价（锚点之前的公共前缀条目 id 全部已知）；锚点被
	 * navigateTree 回退丢弃时（V4：回退不取消、结果应正常落盘）区间无定义，集合判定
	 * 是它的时序无关自然延伸（runlog U3 决策 A1）。
	 */
	compactionIds: string[];
	/**
	 * 触发时刻预计算的被压段 token（收缩校验③分母）：被压范围来自触发快照，分母在触发
	 * 时刻定死，续段无需 preparation 穿透（runlog U3 决策 A2，AfterGenerationHook 契约不动）。
	 */
	shadowedTokens: number;
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
 * 同口径）。tokens 为 null（压缩后首响应前，pi 观察级 R7——旧编号，见文件头注消歧）由调用方先短路，
 * 本函数只收有限数。
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
 * 后台任务终局描述（U5 通知接线点：D6 补偿的呈现半边）。
 * runBackgroundTask 在每个终局点回调 onSettled 恰一次（cancelled 事件取消除外——
 * D3：取消非失败，且 session_compact 抢先场景用户刚完成一次手动压缩，再弹通知是噪音）。
 * 接线层（index.ts）据此组装完成/失败文案经 nextTurn 投递；每次任务至多一条通知（不重复）。
 */
export interface BackgroundTaskSettlement {
	/** 任务触发时刻的 sessionId（stale 分诊与排障）。 */
	sessionId: string;
	/** 任务终局（语义同 ContinuationOutcome + 生成层结局）。 */
	outcome:
		/** 校验通过且已落盘 → 完成通知。 */
		| "validated"
		/** 收缩校验失败放弃落盘 → 失败通知（递增点②）。 */
		| "inflated"
		/** 落盘兜底校验失败或 appendCompaction 探测失败，放弃落盘 → 失败通知（计数不动）。 */
		| "dropped"
		/** 生成空结果 → 失败通知（递增点①）。 */
		| "empty"
		/** 生成异常 → 失败通知（递增点③）。 */
		| "error";
	/** 本次任务的模式（完成通知展示「压缩前后 token 数与模式」，D6）。 */
	mode: "same-model" | "cross-model";
	/** validated/inflated 时携带：生成的压缩结果（tokensBefore/summary/estimatedTokensAfter 通知数据源）。 */
	result?: CompactionResult;
	/** validated/inflated 时携带：触发快照的被压段 token（压缩后 token 估算输入）。 */
	shadowedTokens?: number;
	/** error 时携带：错误消息。 */
	error?: string;
	/** 失败类终局（empty/inflated/error）：递增后的独立熔断计数。 */
	failureStreak?: number;
	/** 失败类终局：递增后计数达到熔断阈值（自动触发将暂停，工具路径不受影响，SI5）。 */
	circuitBreakerOpen?: boolean;
}

// ──────────────────────── 落盘兜底校验 + appendCompaction 直调（U3：D3 第二层 / D2 / D6） ────────────────────────

/** 落盘兜底校验失败原因（可辨识：驱动 ContinuationOutcome 与日志）。 */
export type PersistCheckFailure =
	/** 校验①：sessionId 与触发时刻不一致（会话已替换的兜底对账）。 */
	| "session-mismatch"
	/** 校验②：快照已知集合之外出现 compaction entry（被抢先压缩）。 */
	| "preempted"
	/** 校验③：摘要膨胀（isSummaryInflated，压缩无净收益）。 */
	| "summary-inflated";

/** 校验结果（纯数据：ok=false 时携带失败原因，放弃必留日志由调用方落地）。 */
export type PersistCheckVerdict = { ok: true } | { ok: false; reason: PersistCheckFailure };

/**
 * 落盘兜底校验器（D3 第二层，覆盖事件取消与落盘之间的竞态窗口）：纯函数、可穷举单测（RL2）。
 * 三项任一失败放弃落盘、等下轮触发：
 * ①sessionId 与触发时刻一致（防御性——taiji 每 session 独立进程下无自然触发场景，护栏 pi 裸跑形态）；
 * ②当前 branch 上无快照已知集合之外的 compaction entry（被抢先的时序无关判定，runlog U3 决策 A1——
 *   锚点可定位时等价于「快照末端之后区间扫描」，锚点被回退丢弃时集合判定仍可裁决）；
 * ③收缩校验 isSummaryInflated（SI6：摘要 token ≥ 被压段 token 即放弃，分母取触发快照预计算值）。
 */
export function validateBackgroundPersist(
	snapshot: BackgroundTaskSnapshot,
	entriesNow: ReadonlyArray<SessionEntry>,
	sessionIdNow: string,
	result: CompactionResult,
): PersistCheckVerdict {
	// ①会话已替换（session_start/shutdown 事件层取消未达的竞态窗口兜底）
	if (sessionIdNow !== snapshot.sessionId) {
		return { ok: false, reason: "session-mismatch" };
	}
	// ②被抢先压缩：未知 id 的 compaction 必为触发后新增（触发时刻 branch 上的已知集合之外）
	for (const entry of entriesNow) {
		if (entry.type === "compaction" && !snapshot.compactionIds.includes(entry.id)) {
			return { ok: false, reason: "preempted" };
		}
	}
	// ③收缩校验：摘要不小于被压段 → 落盘使上下文不降反升，放弃（膨胀段记录由调用方经回调共享）
	const summaryTokens = estimateTextTokens(result.summary);
	if (isSummaryInflated(summaryTokens, snapshot.shadowedTokens)) {
		return { ok: false, reason: "summary-inflated" };
	}
	return { ok: true };
}

/**
 * SessionManager.appendCompaction 的局部形状声明（AS1：ExtensionContext.sessionManager 类型上是
 * ReadonlySessionManager——Pick 收窄不含 appendCompaction，运行时是完整 SessionManager 实例）。
 * 参数序与类型按 pi dist 实读核对：session-manager.d.ts:271
 * `appendCompaction<T>(summary, firstKeptEntryId, tokensBefore, details?, fromHook?, usage?): string`，
 * usage 与 CompactionResult["usage"] 同为 pi-ai Usage（任务书 U3 checkpoint 兑现）。
 */
interface AppendCompactionLike {
	appendCompaction?: (
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details?: unknown,
		fromHook?: boolean,
		usage?: CompactionResult["usage"],
	) => string | undefined;
}

/** sessionManager 的运行时收窄检查（RL3：只收窄到对象，方法存在性单独探测）。 */
function asAppendCompactionHost(sm: unknown): AppendCompactionLike | undefined {
	return typeof sm === "object" && sm !== null ? (sm as AppendCompactionLike) : undefined;
}

/** persistBackgroundCompaction 的补偿回调（D6）：由接线层（index.ts）注入 session 级状态操作。 */
export interface BackgroundPersistCallbacks {
	/** 落盘成功补偿：清空已提醒档位（与 session_compact 事件监听共用同一段逻辑，D6）。 */
	onPersisted?: () => void;
	/** 收缩校验失败的膨胀段记录（D3：与同步路径 inflatedSegments 共享读取，同段不再触发防反复烧钱）。 */
	onInflated?: (firstKeptEntryId: string) => void;
}

/**
 * 落盘续段（U3 主体：存在性探测 → 三项兜底校验 → appendCompaction 直调 → 补偿回调）。
 *
 * 探测（RL3）：`typeof === "function"` 存在性探测，缺失放弃落盘、记日志、不抛错（观察级依赖
 * UD1/UD8 的运行时对账；maybeStart 另有前置探测省生成费用，两处语义不同见其注释）。
 * 落盘（D2/AX2）：直调 sessionManager.appendCompaction，参数口径与 pi 原生压缩流程一致
 * （agent-session.js:2199），fromHook=true 与同步接管路径一致；挂载点（leaf）由 pi 依落盘
 * 时刻 branch 决定、不干预（AS6：压缩期间新条目天然衔接进保留段）；usage/details 随 entry
 * 写入（D6 用量归因消费侧照读）。不伪造 pi 事件（UD6：appendCompaction 纯追加无事件）。
 * 落盘异常不在此吞——debugLog 标注阶段后原样上抛，由 runBackgroundTask 异常递增点③收口。
 */
export async function persistBackgroundCompaction(
	ctx: ExtensionContext,
	result: CompactionResult,
	snapshot: BackgroundTaskSnapshot,
	callbacks?: BackgroundPersistCallbacks,
): Promise<ContinuationOutcome> {
	const host = asAppendCompactionHost(ctx.sessionManager);
	// RL3 存在性探测：方法缺失 = pi 观察级依赖失效，放弃落盘不抛错（绝不静默）
	if (!host || typeof host.appendCompaction !== "function") {
		warnLog("background compaction persist skipped: sessionManager.appendCompaction unavailable");
		return "dropped";
	}

	// D3 第二层：三项兜底校验（entriesNow 与 appendCompaction 之间无 await——单线程事件循环
	// 同步帧内连续执行，校验与落盘之间构造性无竞态）
	const sessionIdNow = ctx.sessionManager.getSessionId();
	const entriesNow = ctx.sessionManager.getEntries();
	const verdict = validateBackgroundPersist(snapshot, entriesNow, sessionIdNow, result);
	if (!verdict.ok) {
		if (verdict.reason === "summary-inflated") {
			callbacks?.onInflated?.(result.firstKeptEntryId);
			warnLog("background compaction persist rejected: summary inflated", {
				summaryTokens: estimateTextTokens(result.summary),
				shadowedTokens: snapshot.shadowedTokens,
			});
			return "inflated";
		}
		debugLog(`background compaction persist rejected: ${verdict.reason} (sessionId=${snapshot.sessionId})`);
		return "dropped";
	}

	try {
		const entryId = host.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			true, // fromHook：与同步接管路径落盘口径一致（pi 同参位传 fromExtension=true）
			result.usage,
		);
		callbacks?.onPersisted?.();
		debugLog(
			`background compaction persisted: entry=${entryId ?? "?"} firstKept=${result.firstKeptEntryId} ` +
				`sessionId=${snapshot.sessionId}`,
		);
		return "validated";
	} catch (error) {
		debugLog(`background compaction persist error: ${toErrorMessage(error)}`);
		throw error;
	}
}

/**
 * 从单条消息提取文件操作（pi extractFileOpsFromMessage 的等价组装——该函数不在包根导出，
 * 语义按 pi compaction/utils.js 实读复刻：toolResult 侧收 nestedCalls、assistant 侧收
 * toolCall blocks，按工具名 read/write/edit 归档 path 参数）。按 role 分派到两侧提取，
 * 分派外的形态不计（collectToolResultFileOps / collectAssistantToolCallOps / addFileOp）。
 */
function extractFileOpsFromAgentMessage(message: Parameters<typeof estimateTokens>[0], fileOps: FileOperations): void {
	if (message.role === "toolResult") {
		collectToolResultFileOps(message, fileOps);
		return;
	}
	if (message.role !== "assistant") return;
	collectAssistantToolCallOps(message, fileOps);
}

/** toolResult 侧提取：codemode 脚本发起的调用记录在脚本结果上（pi 同款语义，nestedCalls）。 */
function collectToolResultFileOps(message: Parameters<typeof estimateTokens>[0], fileOps: FileOperations): void {
	const rec = isRecord(message) ? message : undefined;
	const nested = isRecord(rec?.nestedCalls) ? rec.nestedCalls : undefined;
	const calls = Array.isArray(nested?.calls) ? nested.calls : [];
	for (const call of calls) {
		const c = isRecord(call) ? call : undefined;
		addFileOp(fileOps, c?.name, c?.arguments);
	}
}

/** assistant 侧提取：content 内 toolCall blocks（按工具名归档 path 参数）。
 *  入参 = AgentMessage 联合的 assistant 变体（role 分派处窄化后传入，content 才含
 *  toolCall block 联合成员）。 */
function collectAssistantToolCallOps(
	message: Extract<Parameters<typeof estimateTokens>[0], { role: "assistant" }>,
	fileOps: FileOperations,
): void {
	const content = isRecord(message) ? message.content : undefined;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		const b = isRecord(block) ? block : undefined;
		if (b?.type !== "toolCall") continue;
		addFileOp(fileOps, b.name, b.arguments);
	}
}

/** 工具名 → fileOps 分桶：read/written/edited 归档 path 参数（无 path 参数或其余工具名不计）。 */
function addFileOp(fileOps: FileOperations, toolName: unknown, args: unknown): void {
	const path = isRecord(args) && typeof args.path === "string" ? args.path : undefined;
	if (!path) return;
	if (toolName === "read") fileOps.read.add(path);
	else if (toolName === "write") fileOps.written.add(path);
	else if (toolName === "edit") fileOps.edited.add(path);
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
 * system role 消息剔除与 pi 原生一致（compaction.js:50-53 同款过滤，见组装处注释），
 * 不属于差异项。
 * 返回 undefined = 无可压（条目不足 / 刚压缩完 / 全量在保留预算内 / 被压段仅 system 消息）。
 * 组装流程拆为 loadPreparationContext（条目装载 + 无可压前置判定）/
 * sliceCompressionEntries + toNonSystemMessages（被压段组装）/
 * collectCompressedFileOps（fileOps 汇总），本函数只做编排（圈复杂度门禁阈值 15）。
 */
export function buildBackgroundPreparation(
	ctx: ExtensionContext,
): SessionBeforeCompactEvent["preparation"] | undefined {
	const loaded = loadPreparationContext(ctx);
	if (!loaded) return undefined;
	const { contextEntries, previousSummary, boundaryStart } = loaded;

	const cutPoint = findCutPoint(contextEntries, boundaryStart, contextEntries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
	const firstKeptEntry = contextEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) return undefined;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const { shadowedEntries, turnPrefixEntries } = sliceCompressionEntries(contextEntries, boundaryStart, cutPoint, historyEnd);
	// system role 消息剔除（pi getMessagesFromProjectedEntryForCompaction 同款，compaction.js
	// :50-53——system message 是 prompt 状态非对话内容，compaction entry 的 systemMessage 承载
	// 其回放；不剔除会使摘要 LLM 输入混入 system 消息、与 pi 原生组装（已过滤）不同分布）
	const messagesToSummarize = toNonSystemMessages(shadowedEntries);
	const turnPrefixMessages = toNonSystemMessages(turnPrefixEntries);
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

	const head = contextEntries[0];
	const prevCompaction = head?.type === "compaction" ? head : undefined;
	const fileOps = collectCompressedFileOps(messagesToSummarize, turnPrefixMessages, prevCompaction, cutPoint.isSplitTurn);

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

/** [buildBackgroundPreparation 拆分] 条目装载 + 无可压前置判定：getEntries 读失败 /
 *  零活动条目 / 末条是 compaction（刚压缩完，appendCompaction 挂 leaf，prepareCompaction
 *  同款前置）→ undefined。同时定 previousSummary 与 boundaryStart——最新 compaction 是
 *  活动列表首条（buildContextEntries 切分语义）；更早 compaction 的摘要已被它收编，
 *  previousSummary 只取最新一份（prepareCompaction 同款边界）。 */
function loadPreparationContext(ctx: ExtensionContext) {
	let entries: readonly SessionEntry[];
	try {
		entries = ctx.sessionManager.getEntries();
	} catch (error) {
		debugLog(`background preparation: entries read failed: ${toErrorMessage(error)}`);
		return undefined;
	}
	const contextEntries = buildContextEntries([...entries]);
	if (contextEntries.length === 0) return undefined;
	if (contextEntries[contextEntries.length - 1].type === "compaction") return undefined;
	let previousSummary: string | undefined;
	let boundaryStart = 0;
	const head = contextEntries[0];
	if (head?.type === "compaction") {
		previousSummary = head.summary;
		boundaryStart = 1;
	}
	return { contextEntries, previousSummary, boundaryStart };
}

/** [buildBackgroundPreparation 拆分] 被压段切片：shadowedEntries = [boundaryStart, historyEnd)
 *  内老 compaction 过滤（其投影贡献为空消息，AS6——仅最新 compaction 贡献摘要，原始视角
 *  组装须显式对齐，否则上一份摘要消息会混入被压段重复提交）；turnPrefixEntries =
 *  split-turn 时 [turnStartIndex, firstKeptEntryIndex) 段（同款 compaction 过滤，
 *  非 split-turn 为空）。 */
function sliceCompressionEntries(
	contextEntries: SessionEntry[],
	boundaryStart: number,
	cutPoint: ReturnType<typeof findCutPoint>,
	historyEnd: number,
) {
	const shadowedEntries = contextEntries.slice(boundaryStart, historyEnd).filter((e) => e.type !== "compaction");
	const turnPrefixEntries = cutPoint.isSplitTurn
		? contextEntries.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex).filter((e) => e.type !== "compaction")
		: [];
	return { shadowedEntries, turnPrefixEntries };
}

/** [buildBackgroundPreparation 拆分] system role 消息剔除（pi getMessagesFromProjectedEntryForCompaction
 *  同款，compaction.js:50-53——system message 是 prompt 状态非对话内容，compaction entry 的
 *  systemMessage 承载其回放；不剔除会使摘要 LLM 输入混入 system 消息、与 pi 原生组装（已过滤）不同分布）。 */
function toNonSystemMessages(entries: SessionEntry[]) {
	return entries.flatMap(sessionEntryToContextMessages).filter((message) => message.role !== "system");
}

/** [buildBackgroundPreparation 拆分] 被压范围 fileOps：被压消息逐条提取（collectFileOps，
 *  pi extractFileOperations 等价）+ split-turn 时 turnPrefix 也在压缩范围
 *  （prepareCompaction 同款提取，前缀 fileOps 并回主集合）。 */
function collectCompressedFileOps(
	messagesToSummarize: ReadonlyArray<Parameters<typeof estimateTokens>[0]>,
	turnPrefixMessages: ReadonlyArray<Parameters<typeof estimateTokens>[0]>,
	prevCompaction: CompactionEntry | undefined,
	isSplitTurn: boolean,
): FileOperations {
	const fileOps = collectFileOps(messagesToSummarize, prevCompaction);
	if (!isSplitTurn) return fileOps;
	const prefixOps = collectFileOps(turnPrefixMessages, undefined);
	for (const key of ["read", "written", "edited"] as const) {
		for (const f of prefixOps[key]) fileOps[key].add(f);
	}
	return fileOps;
}

/**
 * 后台压缩任务管理器（U2/U3/U5）：触发判定 + 互斥 + 独立熔断 + 事件取消 + 膨胀段共享读取
 * + 工具路径启动 + 终局通知回调。
 *
 * state 为 session 级闭包（index.ts 在 session_start 重建后经 getState 读当前代容器——
 * 旧代任务的回调写旧闭包对象，对新状态天然无害）。afterGeneration 是 U3 续段接线点；
 * onSettled 是 U5 通知接线点（每个终局恰一次，cancelled 除外）；getInflatedSegments 提供
 * 膨胀段共享读取（D3：与同步路径 inflatedSegments 同一集合，同段不再触发防反复烧钱），
 * 缺省视为空集。
 *
 * 两个启动入口共享同一「进行中」单态容器（RL1）：maybeStart = agent_settled 自动触发
 * （互斥 + 门控 + 探测 + 熔断 + 触发线 + 膨胀段全判定）；startForTool = compact_context
 * 工具显式请求（互斥 + 门控前置，跳过触发线与独立熔断——SI5：两者仅约束自动触发入口）。
 */
export function createBackgroundCompactionManager(
	pi: ExtensionAPI,
	getState: () => BackgroundCompactionState,
	loadConfigFn: () => SmartContextConfig,
	afterGeneration?: AfterGenerationHook,
	getInflatedSegments?: () => ReadonlySet<string>,
	onSettled?: (settlement: BackgroundTaskSettlement) => void,
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

	/** 互斥查询（RL1）：单态判定，工具路径契约 BackgroundCompactionControls.isActive 的实装。 */
	const isActive = (): boolean => getState().active !== null;

	/**
	 * appendCompaction 前置存在性探测（U3）：缺失 = pi 观察级依赖失效（UD1/UD8）的恒定
	 * 状态，拦截在生成前省一次全量生成费用；落盘侧另有存在性探测兜底（RL3，语义不同——
	 * 此处「不启动任务」、彼处「放弃结果」，运行中 pi 包不变故两者判定恒一致）。
	 */
	const appendCompactionAvailable = (ctx: ExtensionContext): boolean => {
		const sm: unknown = ctx.sessionManager;
		return Boolean(sm && typeof (sm as AppendCompactionLike).appendCompaction === "function");
	};

	/**
	 * 共用启动段（快照 → AbortController → runBackgroundTask）：互斥兜底由本函数自检
	 * （两入口已前置判定，此处兜 isActive 与 start 之间的同帧竞态）。state.active 赋值与
	 * runBackgroundTask 调用同处一个同步帧：run 的续段都在微任务，不会在赋值前看到空
	 * active（单线程事件循环顺序保证）；task 引用先落地再回填 done，run 的 finally 凭
	 * 引用判「是否仍是自己」，构造性排除误清后继任务的竞态。
	 */
	const launchTask = (
		ctx: ExtensionContext,
		config: SmartContextConfig,
		modelId: string,
		preparation: SessionBeforeCompactEvent["preparation"],
		usageTokens: number,
		customInstructions: string | undefined,
		source: "auto" | "tool",
	): boolean => {
		const state = getState();
		if (state.active) return false;

		const entriesTail = ctx.sessionManager.getEntries();
		const snapshot: BackgroundTaskSnapshot = {
			sessionId: ctx.sessionManager.getSessionId(),
			lastEntryId: entriesTail[entriesTail.length - 1]?.id ?? "",
			tokens: usageTokens,
			compactionIds: entriesTail.filter((e) => e.type === "compaction").map((e) => e.id),
			shadowedTokens: estimateShadowedTokens(preparation.messagesToSummarize),
		};

		// 任务自持 AbortController；异步序列 fire-and-forget（正常路径无人 await）
		const abort = new AbortController();
		const input: GenerationInput = {
			preparation,
			// 触发时刻快照（SI3）：branch 条目流随 preparation 组装自同一 entries 视图
			branchEntries: [...entriesTail],
			customInstructions,
			signal: abort.signal,
		};
		const mode = pickMode(config, modelId);
		const task: ActiveBackgroundTask = { abort, snapshot, done: Promise.resolve() };
		state.active = task;
		task.done = runBackgroundTask(pi, ctx, config, mode, input, abort, state, snapshot, afterGeneration, onSettled, task);
		debugLog(
			`background compaction started(${source}): mode=${mode} tokens=${usageTokens} ` +
				`firstKept=${preparation.firstKeptEntryId}`,
		);
		return true;
	};

	/** 触发判定 + 启动（D4 自动入口）。返回是否启动（供日志；判定全部前置短路）。 */
	const maybeStart = (ctx: ExtensionContext): boolean => {
		const state = getState();

		// 互斥（RL1）：任务进行中不再触发（生成→校验→落盘连续序列占用同一「进行中」态）
		if (state.active) return false;

		const config = loadConfigFn();
		const modelId = getCurrentModelId(ctx.model);
		// 门控前置（D4）：enabled 与 excludedModels，与同步接管同款判定
		if (!isGatingActive(config, modelId)) return false;

		if (!appendCompactionAvailable(ctx)) {
			debugLog("background compaction skipped: sessionManager.appendCompaction unavailable");
			return false;
		}

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

		// 膨胀段共享读取（D3/SI6）：该段收缩校验曾失败 → 同段不再触发防反复烧钱
		if (getInflatedSegments?.().has(preparation.firstKeptEntryId)) {
			debugLog(`background compaction skipped: segment previously inflated (firstKept=${preparation.firstKeptEntryId})`);
			return false;
		}

		return launchTask(ctx, config, modelId, preparation, usage.tokens, undefined, "auto");
	};

	/**
	 * 工具路径启动（U5 接线残项）：compact_context 工具显式请求的后台任务启动，即
	 * tool.ts BackgroundCompactionControls 契约的 start 实装。
	 *
	 * 与自动入口的判定差异（§3.1 入口矩阵①）：
	 * - 保留：互斥（撞上返回 false——工具按幂等处理，U4 契约唯一 false 语义）与
	 *   isGatingActive 门控前置（工具 execute 已现场校验过，此处防御双检——配置热改
	 *   窗口兜底）；
	 * - 跳过：触发线（D4 ratio×窗口——显式请求即用户/agent 决策，不受自动触发线约束）
	 *   与独立熔断（SI5：熔断仅停自动触发）；
	 * - 不做膨胀段拦截：膨胀段（D3/SI6）防的是「同段反复自动触发反复烧钱」，工具显式
	 *   请求是知情决策（可带 custom_instructions 改善摘要），不拦——落盘侧收缩校验仍会
	 *   放弃膨胀结果并经通知回报。
	 *
	 * 失败语义：非互斥原因不可启动（门控拒绝 / appendCompaction 探测失败 / 无可压内容）
	 * 抛错而非返回 false——false 在工具侧按「后台压缩进行中」幂等回执处理，非互斥失败
	 * 返回 false 会撒谎回执；抛错经工具 execute 上浮为失败回执（诚实、可操作）。
	 */
	const startForTool = (ctx: ExtensionContext, customInstructions?: string): boolean => {
		if (isActive()) return false;

		const config = loadConfigFn();
		const modelId = getCurrentModelId(ctx.model);
		if (!isGatingActive(config, modelId)) {
			throw new Error(
				`compact_context 后台压缩启动被门控拒绝：当前模型 ${modelId} 不在放行范围（enabled/excludedModels）。` +
					`可在 taiji 设置页或 smart-context-ext-config skill 中调整后重试。`,
			);
		}
		if (!appendCompactionAvailable(ctx)) {
			throw new Error(
				"compact_context 后台压缩启动失败：sessionManager.appendCompaction 不可用（pi 会话接口缺失，观察级依赖失效）。" +
					"请升级或回退 pi 版本后重试。",
			);
		}

		const preparation = buildBackgroundPreparation(ctx);
		if (!preparation) {
			throw new Error(
				"compact_context 后台压缩未启动：当前上下文没有可压缩内容（刚压缩过，或全部上下文在保留预算内）。",
			);
		}

		return launchTask(ctx, config, modelId, preparation, ctx.getContextUsage()?.tokens ?? 0, customInstructions, "tool");
	};

	return { maybeStart, cancelActive, isActive, startForTool };
}

/**
 * 后台任务执行序列（「进行中」态内的连续序列）：生成 → 续段钩子（U3）。
 * 结局四类：cancelled（放弃结果，计数不动）/ empty（生成空结果，递增①）/ error（异常，递增③）/
 * 生成成功 → afterGeneration 处置回报（validated 清零 / inflated 递增② / dropped 不动）。
 * 任一结局回空闲（try/finally）。旧代闭包场景：写入的是捕获的旧 state 对象，无害。
 * 终局通知（U5/D6）：onSettled 在每个终局点回调恰一次（cancelled 不回调——取消非失败，
 * 不在 D6 失败通知清单；afterGeneration 未接线的开发中间态也不回调，不撒谎成功）。
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
	onSettled?: (settlement: BackgroundTaskSettlement) => void,
	task?: ActiveBackgroundTask,
): Promise<void> {
	/** 终局回调适配：sessionId/mode 由本闭包统一补齐，接线层只消费终局语义与数据载荷。 */
	const settle = (settlement: Omit<BackgroundTaskSettlement, "sessionId" | "mode">): void => {
		onSettled?.({ ...settlement, sessionId: snapshot.sessionId, mode });
	};
	try {
		const result = mode === "same-model"
			? await generateSameMode(pi, ctx, input)
			: await generateCrossMode(ctx, config, input);

		// 被抢先取消：放弃结果（取消非失败，SI5 递增点不含取消；不发终局通知）
		if (abort.signal.aborted) {
			debugLog(`background compaction discarded result after cancellation (sessionId=${snapshot.sessionId})`);
			return;
		}
		// 递增点①：生成空结果
		if (!result) {
			state.failureStreak += 1;
			warnLog("background compaction produced no result", { failureStreak: state.failureStreak });
			settle({
				outcome: "empty",
				failureStreak: state.failureStreak,
				circuitBreakerOpen: state.failureStreak >= TAKEOVER_FAILURE_LIMIT,
			});
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
			settle({ outcome, result, shadowedTokens: snapshot.shadowedTokens });
		} else if (outcome === "inflated") {
			state.failureStreak += 1;
			warnLog("background compaction summary inflated, rejected by continuation", { failureStreak: state.failureStreak });
			settle({
				outcome,
				result,
				shadowedTokens: snapshot.shadowedTokens,
				failureStreak: state.failureStreak,
				circuitBreakerOpen: state.failureStreak >= TAKEOVER_FAILURE_LIMIT,
			});
		} else {
			debugLog(`background compaction dropped by continuation (stale snapshot, sessionId=${snapshot.sessionId})`);
			settle({ outcome: "dropped" });
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
		settle({
			outcome: "error",
			error: toErrorMessage(error),
			failureStreak: state.failureStreak,
			circuitBreakerOpen: state.failureStreak >= TAKEOVER_FAILURE_LIMIT,
		});
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
	/** 执行压缩的模型 `${provider}/${modelId}`（用量页 compaction 归属数据源，pi-semantics PS-28：details 逐字透传落盘）。 */
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
 * 返回类型显式标注 SessionBeforeCompactResult（{}/ {compaction}）——该名在 SDK
 * 包根以 export type 提供（dist/index.d.ts:8 导出清单），import type 可用（tsc
 * --strict 单文件探针实编译通过）。
 */
export function createBeforeCompactHandler(
	pi: ExtensionAPI,
	getState: () => TakeoverState,
	loadConfigFn: () => SmartContextConfig,
) {
	return async (event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<SessionBeforeCompactResult> => {
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
