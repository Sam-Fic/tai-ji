// src/workflow-notify-reconcile.ts — workflow 域 wf-done 收尾通知的对账补投
// （completion-signal-delivery D8：subagent-workflow 域对账步与判据事实源接入，
// 与 bash/subagent 域同构处置阶梯的域侧落位）。
//
// 三重事实判据（域事实映射进共享骨架——判据逻辑零新增，真值组合单源锚定
// @zhushanwen/pi-delivery-port reconcile-judgement.ts 的 isReconcileNotifyCandidate
// （判据链收编单源，真值表测试随迁该包锁定）；本域曾按 subagent-core 先例同构
// 落位，收编轮起改直依共享包）：
//   候选 = run 已终局（isTerminal）∧ 域排除位未命中 ∧ 送达痕迹未命中 ∧
//          投递日志无该幂等键承载
//
// 判据事实源（设计 SC11）= run journal/manifest 终态事实——与 rejected 注释
// 自述的手工补偿路径同一事实源（自动化之）：
//   - manifest 面 = 主 session entries 的 workflow-record v2 注册条目
//     （WORKFLOW_RECORD_CUSTOM_TYPE：runId + recordPath 锚点——本 session 有哪些
//     run 的唯一发现通道，与 JsonlRunStore.loadAll 定界同源）；
//   - journal 面 = record 事件流（deps.settledRecordOf = store.settledRecordOf
//     单点——run-settled 帧即终局，坏行/缺失保守 miss，与通知载荷链同纪律）。
//   域过滤构造性成立（D8④ 的本域对应面）：候选源只认 workflow-record 条目，
//   该 customType 的写方仅 workflow 域（core lifecycle/finalizeRun），无跨域混装。
//
// 判据事实源磁盘化（completion-signal-delivery A1 修复的域侧同构落位，范本 =
// base-tool-enhance pending-reconcile.ts「判据事实源磁盘化」段）：manifest 面与
// 送达痕迹/投递日志两抵消事实读 session JSONL 落盘条目（readSessionFileEntries），
// 不读 pi 内存账——pi SessionManager._appendEntry 先 fileEntries.push 后 _persist、
// persist 失败（EACCES 等）无回滚，留下「幽灵内存 entry」（内存账在册、JSONL 无
// 行；pi 侧机制实锚登记 pi-semantics PS-97：dist/core/session-manager.js
// :815-820 _appendEntry / :794-814 _persist）；内存账口径曾把幽灵的痕迹/日志条目当真 → 「拒收未受理」的 run 被误判已受
// 理 → 补投结构性静默失效。磁盘事实使 delivered/journaled 语义 = 「JSONL 实际含
// 该键条目」，与受理落盘契约一物一名；sessionFile 缺席（no-persist 形态——
// _persist no-op 恒成功、无幽灵态）退化内存 entries（该形态内存账即完整事实）+
// warn 留痕。成本口径：内存账 ⊇ 盘上条目（幽灵态只会多不会少），内存预检「无
// 注册条目早退」= 盘上亦无——高频边沿（agent_settled）常态（无 workflow run）
// 零文件读，候选在册才读盘（bash 域范本同款「候选在册才读盘」形态）。journal 面
// （settledRecordOf/loadRuns）本就是独立磁盘文件，不受幽灵态影响，原样保留。
// 幽灵注册条目（workflow-record 自身落盘失败）的残余 = 磁盘口径下候选不可见的
// 保守 miss（漏补投方向）：该形态 = 注册锚点持久化断裂，重启后 manifest 面无从
// 发现该 run，对账以磁盘事实为准是其正确语义。
//
// 幂等键 = wf-done:<runId>（WORKFLOW_DONE_NOTIFY_ID_PREFIX，主路径 notifyDone
// 同构造——RL8 同锁：补投与主路径共用同一构造与投递管道）。
//
// notifiedRunIds 内存 Set 是投递侧去重窗口、不构成判据源（D8③ 登记）：rejected
// 形态下键未被受理、窗口无标记——补投不被去重拦截，受理后经 trackNotifiedRunId
// 正常入窗。
//
// payload 分层（D8⑤）：可构造段同构 + Script Result 段与 details.resultSummary
// 缺席省略。构造材料核（设计 D8.evidence）：run.state.scriptResult 唯一赋值写点
// 在 worker-message-pump 内存侧（跨重启/内存淘汰后不可达），record 流 11 种帧
// 判别联合无 scriptResult 载体，磁盘唯一落点 = 主 session 终态条目截断摘要——
// 补投侧 run 聚合经 record 流 fold 重建，scriptResult 构造性缺席，主路径构造
// 函数（buildDoneNotifyContent/buildDoneNotifyDetails，本单元导出复用）的缺席
// 省略语义（scriptResult 有值才出段）自然承接——省略的是判据源不存在的事实，
// 未虚构字段值（「不谎报」分层族）。其余可构造段（name/status/reason/outcome/
// errorCode/failedMembers/partialMembers/trace/artifactsDir/eventsJournalPath/
// notifyId）全部从 run journal/manifest 同构重建，与主路径同构构造。
//
// 入口形态（D8② 三入口编排互调本文件唯一对账函数 runNotifyReconcileMaintenance）：
//   ① session_start——workflow-events 装配链尾部（store/runsDir 就绪后）；
//   ② agent_settled——workflow-events 装配期订阅（回合收尾兜底边沿）；
//   ③ 切回补强（__taiji_bg_reconcile__）——pi 命令名全局唯一且单 handler 分发
//     （pi SDK runner.getCommand 取首个同名命中；runtime 只发 base-tool-enhance
//     注册的那一条命令，字面量契约），本扩展无切回触发源且与 base-tool-enhance
//     无依赖边（跨扩展依赖通道不存在）——经三方共同依赖包 pi-delivery-port 的
//     进程级注册槽订阅切回派发（workflow-events 装配期 subscribeResumeReconcile，
//     base-tool-enhance handler dispatchResumeReconcile 转发；subagent 域
//     SubagentService 单例直转的 A5 先例同族，reason="resume"）。
// 幂等：补投受理成功后投递日志条目（id）与送达痕迹抵消判据，下一边沿不再命中；
// 跨边沿重复对账天然收敛。

import { dirname } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	collectJournaledDeliveryIds,
	isReconcileNotifyCandidate,
	resolveReconcileFactEntries,
	type ReconcileNotifyFacts,
} from "@zhushanwen/pi-delivery-port";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import {
	WORKFLOW_RECORD_CUSTOM_TYPE,
	RUN_EVENTS_SUFFIX,
	classifyWorkflowRecordEntryData,
	type WorkflowRun,
} from "@zhushanwen/subagent-core";

import { WORKFLOW_RESULT_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";
import {
	WORKFLOW_DONE_NOTIFY_ID_PREFIX,
	notifyDone,
} from "./workflow-notify.ts";
import type { RunSettlementRecord } from "./jsonl-run-store.ts";

const logger = getLogger("subagents");

/** 本域收尾通知的送达 customType（词表单源 = extension-protocol 透传）。 */
const NOTIFY_CUSTOM_TYPE = WORKFLOW_RESULT_CUSTOM_TYPE;

/** 本域 run journal 条目的 customType（core barrel 单源）。 */
const RECORD_CUSTOM_TYPE = WORKFLOW_RECORD_CUSTOM_TYPE;

// ─── 三重事实判据骨架（收编单源 = @zhushanwen/pi-delivery-port
// reconcile-judgement.ts，本文件经 barrel import 消费；域侧只留「域事实 → 布尔」
// 映射：excludedByOrigin 恒 false——主路径 notifyDone 对全部终态 outcome 均发收尾
// 通知（D7「取消亦通知」），域过滤由候选源 customType（workflow-record）构造性
// 承载，映射见 reconcileOneCandidate）───

// ─── 域事实收集器（当前 session entries 的单次遍历事实源）───

/** unknown 值上指定键的 string 字段（非对象/缺键/非字符串一律 undefined）。 */
function stringField(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

/** 单个注册 run 的定界事实（manifest 面）。 */
export interface RegisteredWorkflowRun { // oe-exempt:20261101:framework:跨包不可达的同形结构副本（权威源 packages/subagent-core notify-reconcile.ts，载体关系登记文件头），域侧映射随本设计交付

	runId: string;
	/** record 事件流绝对路径锚点（v2 注册条目 recordPath）。 */
	recordPath: string;
}

/**
 * 从会话 entries 提取本域 v2 注册条目（manifest 面定界——与 JsonlRunStore
 * loadAll 的发现通道同源：customType + classify 判定 + recordPath 锚点后缀）。
 * 旧形态锚点（非 record 后缀 = 历史 run，loadAll 同款跳过）与畸形条目跳过——
 * 对账是通知链不是恢复侧，保守 miss 可诊断（通知链纪律同 store.settledRecordOf）。
 */
export function collectRegisteredWorkflowRuns(entries: readonly unknown[]): RegisteredWorkflowRun[] {
	const runs: RegisteredWorkflowRun[] = [];
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry.customType !== RECORD_CUSTOM_TYPE) continue;
		const classification = classifyWorkflowRecordEntryData(entry.data);
		if (classification.ok || classification.reason !== "v2") continue;
		const registered = classification.entry;
		if (registered.kind !== "registered") continue;
		if (registered.recordPath === undefined) continue;
		if (!registered.recordPath.endsWith(RUN_EVENTS_SUFFIX)) continue; // 旧形态锚点
		if (registered.runId === "") continue;
		runs.push({ runId: registered.runId, recordPath: registered.recordPath });
	}
	return runs;
}

/**
 * 从会话 entries 提取本域已送达收尾通知的幂等键集合（送达痕迹判据事实源）。
 * 判定通道两条任一命中：details.notifyId（主路径/补投 payload 携带）/ details.
 * deliveryId（port 受理时统一写入 details 的送达凭据键）。刻意不收 content
 * 文本兜底：content 内的 runId 片段会让成员结果条目误命中收尾键（宁滥勿缺的
 * 反向才是双投——痕迹收集按结构化字段精确收，与 subagent 域同款纪律）。
 */
export function collectDeliveredWorkflowNotifyIds(entries: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry.customType !== NOTIFY_CUSTOM_TYPE) continue;
		const notifyId = stringField(entry.details, "notifyId");
		if (notifyId !== undefined) ids.add(notifyId);
		const deliveryId = stringField(entry.details, "deliveryId");
		if (deliveryId !== undefined) ids.add(deliveryId);
	}
	return ids;
}

// ─── 判据事实源读侧（session JSONL 落盘条目）───

// collectJournaledDeliveryIds / readSessionFileEntries 已收编
// @zhushanwen/pi-delivery-port 单源（reconcile-judgement.ts / session-journal-
// read.ts，barrel import）——三域物理副本随判据链收编退役；读侧容错口径
// （ENOENT 常态空 / 读错误 warn + [] / 脏行单行跳过）与退化语义登记见该函数
// 头注与文件头「判据事实源磁盘化」段（PS-97）。

/** 补投幂等键（主路径 notifyDone 同构造——RL8 同锁）。 */
export function buildDoneNotifyId(runId: string): string {
	return `${WORKFLOW_DONE_NOTIFY_ID_PREFIX}${runId}`;
}

// ─── 对账编排（三入口唯一入口）───

/** 单次对账结果（日志 + 测试断言面）。 */
export interface NotifyReconcileResult { // oe-exempt:20261101:framework:跨包不可达的同形结构副本（权威源 packages/subagent-core notify-reconcile.ts，载体关系登记文件头），域侧映射随本设计交付

	/** 扫描的注册条目数（manifest 面量级）。 */
	scanned: number;
	/** 预检候选数（未被承载未被送达——含终局事实待核）。 */
	candidates: number;
	/** 补投已受理（notifyDone 返回 true——受理/幂等早退，消息已出站或已送达过）的 runId。 */
	redelivered: string[];
	/** 终局事实缺席（流缺失/损坏/无终局帧/聚合重建缺席）而跳过的 runId。 */
	skippedNotTerminal: string[];
	/** 送达痕迹命中而跳过的 runId。 */
	skippedDelivered: string[];
	/** 投递日志承载命中而跳过的 runId。 */
	skippedJournaled: string[];
}

/**
 * 对账编排（session_start / agent_settled / 切回（resume）三入口互调的单一函数）。
 * 幂等：重复执行时已补投键有投递日志承载/送达痕迹抵消，判据不再命中。失败吞掉记
 * warn（对账/补投失败无害：候选判据仍命中，下一对账边沿幂等重查）——调用方不需
 * 自行 try-catch。
 *
 * sessionFile = 当前 session JSONL 路径（pi sessionManager.getSessionFile()）——
 * manifest 面与痕迹/日志两抵消事实读它的落盘条目（磁盘事实，机制见文件头「判据
 * 事实源磁盘化」段）；undefined（no-persist 形态）退化内存 entries（现状行为）+
 * warn。journal 面（settledRecordOf/loadRuns）独立磁盘文件，不受影响。
 *
 * 成本下界（u1/u3 同款预检短路纪律）：内存预检「无注册条目早退」（内存账 ⊇ 盘上
 * 条目——幽灵态只会多不会少，早退 = 盘上亦无，高频边沿常态零文件读）；候选非空
 * 才读盘 + loadRuns（全量聚合重建，会话内 run 十级量级小文件）。
 */
// resolveFactEntries 已收编 @zhushanwen/pi-delivery-port 单源（session-journal-read.ts
// resolveReconcileFactEntries，barrel import）——no-persist 退化内存账 + warn 的域侧
// 形态两域一致，随判据链收编退役本地副本；domain 标签 = "workflow notify reconcile"。

/**
 * 预检抵消键过滤（复杂度拆出——磁盘承载两事实先行，终局事实后核）：承载判据双键
 * （本域键形态双轨——RL8 注释登记）：幂等键 wf-done:<runId>（通知 envelope id 与
 * 送达凭据）∧ 裸 runId（主路径 deliverDoneNotify 的 collectKey 申报键 = runId 本身，
 * result-collect 债权语义）——collectKey 通道只查裸键会漏「主路径成功受理」形态
 * （误补投由 port 幂等吞并，多余但无害；判据侧直接补齐）。抵消键分类记录进
 * skippedDelivered/skippedJournaled（观测面——u1/u3 终判记账语义同源），短路语义
 * 保持：被抵消键不进终判循环、不触 loadRuns。
 */
function prefilterReconcileCandidates(
	registered: readonly RegisteredWorkflowRun[],
	deliveredIds: ReadonlySet<string>,
	journaledIds: ReadonlySet<string>,
	result: NotifyReconcileResult,
): RegisteredWorkflowRun[] {
	const prefiltered: RegisteredWorkflowRun[] = [];
	for (const candidate of registered) {
		const notifyId = buildDoneNotifyId(candidate.runId);
		const delivered = deliveredIds.has(notifyId);
		const journaled = journaledIds.has(notifyId) || journaledIds.has(candidate.runId);
		if (delivered) result.skippedDelivered.push(candidate.runId);
		if (journaled) result.skippedJournaled.push(candidate.runId);
		if (!delivered && !journaled) prefiltered.push(candidate);
	}
	return prefiltered;
}

/**
 * 单候选补投终判 + 补投出口（复杂度拆出——终判循环体）：
 *  - 终局事实（journal 面）：settledRecordOf 单点——run-settled 帧在即终局；
 *    undefined（流缺失/损坏/无终局帧）= 不可判定，保守 miss 跳过（通知链纪律，
 *    与主路径载荷链同款），下一边沿幂等重查。
 *  - 补投出口 = notifyDone 直调（构造面/投递面/重提链与主路径全共用——可构造段
 *    同构由此构造性成立；artifactsDir = recordPath 锚点目录，与 store 装配 runsDir
 *    同值）。返回值 = 是否受理（A15 缺陷修复）：false = 主投与单次重提均 rejected、
 *    重提时端口重取缺席、或降级直发未送达——通知未出站（成因清单 = notifyDone 全部
 *    return false 路径；窗口幂等早退恒返回 true，不在此列）；warn 留痕 + 不计
 *    redelivered（受理假象防线：日志「已补投」必须与真实受理一致）。notifyDone 幂等
 *    早退返回 true（已通知语义）无害照计——窗口已含即上一轮补投已受理。
 */
function reconcileOneCandidate(deps: {
	reason: string;
	pi: ExtensionAPI;
	notifiedRunIds: Set<string>;
	settledRecordOf: (runId: string) => RunSettlementRecord | undefined;
}, candidate: RegisteredWorkflowRun, run: WorkflowRun, deliveredIds: ReadonlySet<string>, journaledIds: ReadonlySet<string>, result: NotifyReconcileResult): void {
	const notifyId = buildDoneNotifyId(candidate.runId);
	const settlement = deps.settledRecordOf(candidate.runId);
	if (settlement === undefined) {
		result.skippedNotTerminal.push(candidate.runId);
		return;
	}
	const facts: ReconcileNotifyFacts = {
		isTerminal: true,
		// 域排除位恒 false：主路径对全部终态发通知（无成因排除位——文件头）
		excludedByOrigin: false,
		delivered: deliveredIds.has(notifyId),
		journaled: journaledIds.has(notifyId),
	};
	if (!isReconcileNotifyCandidate(facts)) {
		if (facts.delivered) result.skippedDelivered.push(candidate.runId);
		if (facts.journaled) result.skippedJournaled.push(candidate.runId);
		return;
	}
	const accepted = notifyDone(deps.pi, candidate.runId, run, deps.notifiedRunIds, dirname(candidate.recordPath), settlement);
	if (!accepted) {
		logger.warn("workflow notify reconcile redelivery not accepted (deliver rejected after main attempt and single retry, or port absent on re-acquire / direct-send undelivered); message not dispatched, candidates retried at next reconcile edge", {
			detail: { reason: deps.reason, runId: candidate.runId, notifyId },
		});
		return;
	}
	result.redelivered.push(candidate.runId);
	logger.debug("workflow notify reconciled via delivery port", {
		detail: { reason: deps.reason, runId: candidate.runId, notifyId },
	});
}

export async function runNotifyReconcileMaintenance(deps: {
	/** 入口来源（session_start / agent_settled / resume 切回）——入口来源日志可辨。 */
	reason: string;
	/** 当前 pi（补投出口 notifyDone 的投递参数——与主路径同一投递管道）。 */
	pi: ExtensionAPI;
	/** 当前 session entries（内存账——预检短路源 + no-persist 退化事实源）。 */
	entries: readonly unknown[];
	/**
	 * 当前 session JSONL 路径（装配 = ctx.sessionManager.getSessionFile() 直通）——
	 * 判据事实源磁盘读侧；undefined = no-persist 形态退化内存账 + warn。
	 */
	sessionFile?: string;
	/** notifyDone 去重窗口（domainState.notifiedRunIds 透传——补投受理后正常入窗）。 */
	notifiedRunIds: Set<string>;
	/** 终局记录查询（装配 = JsonlRunStore.settledRecordOf 直通）。 */
	settledRecordOf: (runId: string) => RunSettlementRecord | undefined;
	/** run 聚合重建（装配 = JsonlRunStore.loadAll 直通）；仅候选非空时被调。 */
	loadRuns: () => Promise<WorkflowRun[]>;
}): Promise<NotifyReconcileResult> {
	const result: NotifyReconcileResult = {
		scanned: 0,
		candidates: 0,
		redelivered: [],
		skippedNotTerminal: [],
		skippedDelivered: [],
		skippedJournaled: [],
	};
	try {
		logger.debug("workflow notify reconcile dispatch", { detail: { reason: deps.reason } });
		// 内存预检短路（bash 域「候选在册才读盘」同款成本下界）：内存账 ⊇ 盘上条目
		// （幽灵态只会多不会少），无注册条目早退 = 盘上亦无，零文件读。
		if (collectRegisteredWorkflowRuns(deps.entries).length === 0) return result;

		const factEntries = resolveReconcileFactEntries({
			domain: "workflow notify reconcile",
			reason: deps.reason,
			entries: deps.entries,
			sessionFile: deps.sessionFile,
		});
		const registered = collectRegisteredWorkflowRuns(factEntries);
		result.scanned = registered.length;
		const deliveredIds = collectDeliveredWorkflowNotifyIds(factEntries);
		const journaledIds = collectJournaledDeliveryIds(factEntries);

		const prefiltered = prefilterReconcileCandidates(registered, deliveredIds, journaledIds, result);
		result.candidates = prefiltered.length;
		if (prefiltered.length === 0) return result;

		// 候选非空：聚合重建一次（Map 索引复用——多候选不重复读流）
		const runs = new Map<string, WorkflowRun>();
		for (const run of await deps.loadRuns()) {
			runs.set(run.runId, run);
		}
		for (const candidate of prefiltered) {
			const run = runs.get(candidate.runId);
			// run 缺席（聚合重建无此 run）= 不可判定，与 settlement 缺席同路径保守 miss
			if (run === undefined) {
				result.skippedNotTerminal.push(candidate.runId);
				continue;
			}
			reconcileOneCandidate(deps, candidate, run, deliveredIds, journaledIds, result);
		}
	} catch (err) {
		logger.warn("workflow notify reconcile failed; candidates retried at next reconcile edge", {
			detail: { reason: deps.reason, err: err instanceof Error ? err.message : String(err) },
		});
	}
	return result;
}
