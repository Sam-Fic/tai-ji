/**
 * session_start pending 对账 + 收殓终态通知补投（M3 session_start 维护链 +
 * unified-delivery D3 裁决 1 / 波 3；投递统一化设计的现行登记处 = ADR-0074 与
 * docs/CONTEXT.md「统一投递（unified delivery，v3）」段，语义由本文件头注释
 * 直接承载，见下）。
 *
 * 职责一（既有）：对「session entries 差集显示 active、但任务已终态」的 bt- 任务补写
 * pending:unregister entry。覆盖三类 otherwise 悬空场景：
 *  ① 进程 graceful 退出收殓时 pi API 已不可用，unregister 没写成 entry；
 *  ② 强杀后收殓侧只改 registry（标 orphaned），碰不了 session 文件；
 *  ③ fork 后任务完成通知写进新 session，旧 session 文件的 register 成僵尸。
 *
 * 收尾写法（权威路径）：直接 pi.appendEntry("pending:unregister", {id, reason,
 * status})——**appendEntry 即唯一权威路径**：appendEntry 同步入账（pi dist 实证）
 * 且不依赖 listener 存活，差集消费方 goal 从持久化 entries 算差集
 * （agent-end.ts getEntries()），对检查直接生效，无不一致窗口。（尽力补 emit 的
 * 第二写路径已随 ext-simplify-13 删除：pending unregister listener 的落盘前置
 * isPendingActive 对 entries 现算，而对账 appendEntry 同步入账先于 emit 执行，emit
 * 到达时该 id 必已注销 = 恒 no-op 死路径。）
 *
 * 职责二（终态通知对账补投，completion-signal-delivery D2/D6；收殓形态为波 3 既有
 * 子集）：对「registry 已终态 ∧ 会话 entries 无送达痕迹 ∧ 投递日志无该幂等键条目」
 * 的后台任务，逐任务经 port.deliver 补投终态通知（id = taskId 幂等键）。三重事实判据
 * 覆盖两类形态，payload 分层（D6）：
 *  - rejected 补投（本设计新增候选：exited natural/timeout）——主路径受理被拒
 *    （rejected 条目幂等键未登记、无投递日志条目，port 的差集重放结构性无从覆盖），
 *    补投 = 主路径同款 content + details + collectKey（补投的就是主路径本要发的那条
 *    通知，渲染层 GUI 呈现依赖 details 随补投补齐）；
 *  - 收殓补投（既有候选：orphaned / exited process-exit）——收殓时 pi API 不可用不
 *    投递、无投递日志条目，重放无从覆盖；本路径是其通知的唯一生产者，补投维持
 *    terminated 简报形态（无业务 details——「不谎报」既有裁决：收殓时点不存在时长/
 *    成败事实，且不存在可对齐的「主路径同一条通知」）。
 * 判据、幂等与 payload 分层的完整语义登记 = 设计文档 §3.3 D1/D2/D6/D7；判据骨架的
 * 跨域共享落点 = @zhushanwen/pi-delivery-port reconcile-judgement.ts（判据链收编
 * 单源；本域送达痕迹提取留 notify-reconcile-judgement.ts）。
 * killed 终态排除于候选（成因排除位——kill 发令方当次交互已同步获知，补投是重复
 * 刺激；kill 路径通知不入账的单点归属规则见 notify.ts 文件头）。
 *
 * 判据事实源磁盘化（A1 产品缺陷修复，completion-signal-delivery D3 验收挖出）：
 * 送达痕迹与投递日志两事实读 session JSONL 落盘条目（readSessionFileEntries），
 * 不读 pi 内存账——pi SessionManager._appendEntry 先 fileEntries.push 后 _persist、
 * persist 失败（EACCES 等）无回滚，留下「幽灵内存 entry」（内存账在册、JSONL 无行；
 * pi 侧机制实锚登记 pi-semantics PS-96：dist/core/session-manager.js :815-820
 * _appendEntry / :794-814 _persist）。
 * 投递契约 rejected = 拒收未受理、幂等键未登记（delivery-port types「条目可重试」），
 * 幽灵内存态曾把该 taskId 误判「受理已发生」→ 三重判据 journaled 位误真 → 补投
 * 结构性静默失效。磁盘事实使 journaled/delivered 语义 = 「JSONL 实际含该键条目」，
 * 与受理落盘契约一物一名；sessionFile 缺席（no-persist 形态，磁盘事实结构性不存在）
 * 退化内存 entries（该形态无 persist 失败，内存账即完整事实）+ warn 留痕。
 *
 * 三边沿入口（session_start / __taiji_bg_reconcile__ 切回 / agent_settled 回合收尾）
 * 经 index.ts 编排互调本文件的 reconcilePendingEntries——判据单一（RL12）：三入口对
 * 同一事实状态产出同一判定，跨边沿双投由 port 幂等吞并防住。agent_settled 高频边沿
 * 的成本下界 = 判据预检先行短路（registry 终态量级扫描，无候选不触 entries 全扫描）。
 *
 * 幂等体系（随载体换 port 收敛）：旧「补投标记 entry + in-flight 单飞检查」退役——
 * 防双投由 port 幂等接管（deliver 幂等预检 + 内核三级判重 + outbox/ack 终态列）：
 * 同激活双派发的第二路 deliver 同 id 被 port 吞（swallowed）；已送达任务由送达痕迹
 * 判据阻断（通知消息的 details.taskId / content bt- token 在 entries）。旧 marker
 * 「标记在而消息丢」的残余失败域随之修复：marker 不再是判据，丢失的消息按痕迹判据
 * 重投。port 缺席（装配异常窗口）= 跳过 + warn：补投有自愈通道（判据仍命中，下一
 * session_start 幂等重投），不做无幂等保护的直发兜底（双派发窗口双投）。
 *
 * 差集判据单点（ext-simplify-13）：collectActivePendingIds（protocol
 * pending-entries 模块，与 pending-notifications 检查判据同源）+ bt- 前缀过滤；
 * 送达痕迹提取单点 = notify-reconcile-judgement.ts collectDeliveredTaskIds。
 * task_id 前缀亦消费 protocol 契约常量 BACKGROUND_TASK_ID_PREFIX（§2.3，区别于
 * subagent-workflow 的 bg-/run-）。
 *
 * 执行链（index.ts session_start 链内）：收殓下沉 runtime 后（u-bte-remove）本链
 * 仅剩对账 + 收殓补投——「对账见 running+pid 活则不动作，下一 session_start 兜底」
 * 的幂等语义覆盖孤儿终态由 runtime 异步写入的时序窗口。补投先于差集收尾（先通知后
 * 清观测点），差集收尾无条件执行（幂等语义不依赖补投成败，两者无隐藏耦合）。
 */

import {
	BACKGROUND_TASK_ID_PREFIX,
	collectActivePendingIds,
	mapReasonToStatus,
} from "@zhushanwen/extension-protocol";
import { isPidAlive } from "@zhushanwen/extension-protocol/background-task";
import { collectJournaledDeliveryIds, getDeliveryPort, isReconcileNotifyCandidate, readSessionFileEntries, type ReconcileNotifyFacts } from "@zhushanwen/pi-delivery-port";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { collectDeliveredTaskIds } from "./notify-reconcile-judgement.ts";
import {
	BACKGROUND_BASH_CUSTOM_TYPE,
	buildNotificationContent,
	buildNotifyDetails,
	buildTerminatedNotificationLine,
	toPendingReason,
} from "./notify.ts";
import { getRegistryPath, readRegistry } from "./registry.ts";
import { isActiveState, isTerminalState, type RegistryEntry } from "./types.ts";

const logger = getLogger("base-tool-enhance");

/**
 * 对账依赖的最小 pi 面（结构兼容 ExtensionAPI 的子集；测试注入不造完整 pi）。
 * 投递侧已随波 3 换 port（ReconcileDeliver），本接口只剩 appendEntry 权威写路径。
 */
export interface ReconcilePi {
	appendEntry(customType: string, data?: unknown): void;
}

/**
 * port.deliver 的结构最小子集（与 @zhushanwen/pi-delivery-port 的
 * DeliveryPortHandle.deliver 结构兼容——调用方传 getDeliveryPort()!.deliver 直接
 * 赋值合法；本模块不 import port 包运行时对象，缺省值单点在 reconcilePendingEntries
 * 参数缺省表达式）。
 */
export type ReconcileDeliver = (
	envelope: {
		/** 幂等键（收殓补投恒 = taskId）。 */
		id?: string;
		/** 期望注入时机（收殓补投恒 steer 档——session_start 时 agent 空闲即起轮）。 */
		timing?: "steer" | "followUp";
		payload: {
			kind: "custom";
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		};
	},
	/** 提交选项（结构兼容 DeliveryDeliverOptions 子集）。 */
	opts?: { collectKey?: string[] },
) =>
	| { kind: "accepted"; id: string }
	| { kind: "swallowed"; reason: string }
	| { kind: "rejected"; reason: string };

/** 对账结果（日志 + 测试断言范围）。 */
export interface ReconcileResult {
	/** 补写 pending:unregister entry 的任务数。 */
	reconciled: number;
	/** 差集 active 但判据不满足（活任务 / registry 无条目）而保守跳过的 task_id。 */
	skipped: string[];
	/** 收殓终态通知经 port.deliver 补投受理（accepted）的 task_id。 */
	redelivered: string[];
}

/**
 * 对账主体（session_start 维护链入口）。收殓补投先于差集收尾；差集收尾无条件执行。
 * 每个僵尸任务 appendEntry 一次（唯一权威写路径）。
 *
 * deliver 缺省取进程级槽当前实例（session_start 已装配 port——index.ts 装配点先于
 * 本链执行）；显式传参供测试注入。sessionFile = 当前 session JSONL 路径（pi
 * sessionManager.getSessionFile()）——补投判据事实源（送达痕迹 / 投递日志）读它
 * 的落盘条目（磁盘事实）；undefined（no-persist 形态）退化内存 entries（现状行为）
 * + warn，见 deliverReapNotifications。
 */
export async function reconcilePendingEntries(
	pi: ReconcilePi,
	dataDir: string,
	sessionId: string,
	entries: unknown[],
	deliver: ReconcileDeliver | undefined = getDeliveryPort()?.deliver,
	sessionFile: string | undefined = undefined,
): Promise<ReconcileResult> {
	const result: ReconcileResult = { reconciled: 0, skipped: [], redelivered: [] };

	// ① 收殓终态通知补投（先通知后清观测点；幂等由 port 承管，同步无 await）
	deliverReapNotifications(deliver, dataDir, sessionId, entries, sessionFile, result);

	// ② 既有 pending 差集循环（无条件执行；unregister 收尾的唯一写点）
	const unsettled = collectActivePendingIds(entries, { idPrefix: BACKGROUND_TASK_ID_PREFIX });
	if (unsettled.size === 0) return result;

	const registry = readRegistry(getRegistryPath(dataDir, sessionId));
	for (const id of unsettled) {
		const entry = registry.get(id);
		if (entry === undefined) {
			// registry 无条目：终态无从判定（LRU 淘汰的终态条目其 unregister entry 应已
			// 落盘，差集里还出现 = spawn 后 registry 写失败等罕见路径）——保守不动作，
			// pending-notifications 已无任何 TTL 清理，差集残留由 next-session 对账重查收尾。
			// warn 是设计决策 6 的 LRU 淘汰重审触发观测落点（含 taskId；此前该形态零日志）
			logger.warn(
				"pending reconcile: registry has no entry for a pending bt- id (LRU-evicted or spawn-write failure); unregister stays pending",
				{ detail: { taskId: id } },
			);
			result.skipped.push(id);
			continue;
		}
		if (!isTerminalByRegistry(entry)) {
			// D12 活任务（running/killing 且 pid 活）：任务跨 session 替换续存，不收尾
			result.skipped.push(id);
			continue;
		}
		const pendingReason = settledPendingReason(entry);
		try {
			// status 经 protocol mapReasonToStatus 单点映射（ext-simplify-17 D10）：与
			// pending-notifications unregister listener 同一函数——原 status === reason 的
			// identity 假设在非 identity reason（budget_limited→failed 等）上会静默漂移
			pi.appendEntry("pending:unregister", {
				id,
				reason: pendingReason,
				status: mapReasonToStatus(pendingReason),
			});
		} catch (err) {
			logger.warn("reconcile appendEntry failed; retry on next session_start", {
				detail: { id, err: toErrorMessage(err) },
			});
			continue;
		}
		result.reconciled++;
	}
	if (result.reconciled > 0) {
		logger.debug("pending reconcile settled zombie registers", {
			detail: { reconciled: result.reconciled, skipped: result.skipped.length },
		});
	}
	return result;
}

/** 终态判据：registry 终态，或 active 状态但 pid 已判死。 */
function isTerminalByRegistry(entry: RegistryEntry): boolean {
	if (isTerminalState(entry.state)) return true;
	return isActiveState(entry.state) && !isPidAlive(entry.pid);
}

/**
 * 收尾 reason 映射（reason→status 的第二跳在写点经 protocol mapReasonToStatus 单点）：
 *  - exited：按条目 reason/exitCode 走 toPendingReason（与 exit 边沿 emit 同一映射，
 *    两路径写出的 entry 语义一致）；reason 缺失按 cancelled 处理（防御分支，正常路径
 *    finalize 必写 reason）
 *  - orphaned / running+判死：cancelled（任务非自身成败地终止/消失）
 *  返回联合随 toPendingReason 扩展（natural + 无退出码 → "unknown"，结果未知形态，
 *  foreground-idle-to-background §5 部件 5——经 mapReasonToStatus fail-visible 缺省落
 *  'unknown' status，protocol 零改动）。
 */
function settledPendingReason(
	entry: RegistryEntry,
): "completed" | "failed" | "unknown" | "time_limited" | "cancelled" {
	if (entry.state === "exited" && entry.reason !== undefined) {
		return toPendingReason(entry.reason, entry.exitCode ?? null);
	}
	return "cancelled";
}

// readSessionFileEntries 已收编 @zhushanwen/pi-delivery-port 单源
// （session-journal-read.ts，barrel import）——原 bash 域物理副本随判据链收编
// 退役；容错口径（ENOENT 常态空 / 读错误 warn + [] / 脏行单行跳过）与退化语义
// 登记见该函数头注与文件头「判据事实源磁盘化」段（PS-96）。

/**
 * 终态通知对账补投（D2：registry 全集独立遍历，不挂 pending 差集循环——差集
 * 候选 = pending:register 还挂着的任务，而「exit 边沿 unregister 已写、通知从未
 * 投出」下差集为空，挂靠即永久漏补）。逐候选经 port.deliver（幂等键 = taskId）：
 * accepted 计入 redelivered；swallowed = port 幂等命中（同 id 已在途/已终局）正常
 * 收敛；rejected = 未受理（outbox 未落）warn 留痕——判据仍命中，下一对账边沿
 * （session_start / 切回 / agent_settled）幂等重投。
 *
 * 成本预检短路（D2/D7：agent_settled 高频边沿的常态成本下界）：registry 侧事实
 * （终态 ∧ 非 killed）先行短路，无候选不触 session 文件读取；候选在册才读盘，
 * 且一次遍历产出送达痕迹 + 投递日志两集合（不双倍扫描）。
 */
function deliverReapNotifications(
	deliver: ReconcileDeliver | undefined,
	dataDir: string,
	sessionId: string,
	entries: unknown[],
	sessionFile: string | undefined,
	result: ReconcileResult,
): void {
	if (deliver === undefined) {
		// port 缺席（装配异常 / 版本混装窗口）：跳过 + warn（修复信号）。补投有自愈
		// 通道（判据仍命中，下一 session_start 重投），不做无幂等保护的直发兜底。
		logger.warn("pending reconcile reap-notify skipped: delivery port absent (assembly anomaly?); retried next session_start");
		return;
	}
	const registry = readRegistry(getRegistryPath(dataDir, sessionId));
	if (registry.size === 0) return;

	// ① 预检短路：registry 侧事实（终态 ∧ 非 killed；痕迹/日志两事实预检置空 =
	// 只查 registry 侧）——无候选即早退，session 文件读不发生（判据单一：预检与
	// 终判共用同一骨架映射 registryFacts，不另立第二套真值）
	const candidates: RegistryEntry[] = [];
	for (const entry of registry.values()) {
		if (isReapNotifyCandidate(entry)) candidates.push(entry);
	}
	if (candidates.length === 0) return;

	// ② 候选在册：事实源磁盘化（文件头「判据事实源磁盘化」段）——痕迹/日志两集合
	// 从 session JSONL 落盘条目产出（一次读文件，两集合单次遍历）；sessionFile 缺席
	// （no-persist 形态，磁盘事实结构性不存在）退化内存 entries——该形态 _persist
	// no-op 恒成功、无幽灵态，内存账即完整事实。
	const factEntries = sessionFile !== undefined
		? readSessionFileEntries(sessionFile)
		: entries;
	if (sessionFile === undefined) {
		logger.warn("reap-notify journal facts fell back to in-memory entries: session file unavailable (no-persist session?); ghost in-memory entries would misjudge journaled/delivered facts", {
			detail: { sessionId },
		});
	}
	const delivered = collectDeliveredTaskIds(factEntries);
	const journaled = collectJournaledDeliveryIds(factEntries);
	for (const entry of candidates) {
		if (!isReapNotifyCandidate(entry, delivered, journaled)) continue;
		const receipt = deliver(
			buildReapNotifyEnvelope(entry),
			// collectKey 债权申报（result-collect 域，现行登记处 = ADR-0146）：两类补投
			// 均与主链 notify.ts 同款申报——补投通知条目带键，collect 可收取（D6①②）。
			{ collectKey: [entry.taskId] },
		);
		if (receipt.kind === "accepted") {
			result.redelivered.push(entry.taskId);
		} else if (receipt.kind === "rejected") {
			logger.warn("pending reconcile reap-notify rejected by delivery port; retried next session_start", {
				detail: { taskId: entry.taskId, reason: receipt.reason },
			});
		}
	}
}

/**
 * 补投 payload 分层（D6）：rejected 补投候选（exited natural/timeout）= 主路径
 * 同款 content + details（buildNotificationContent / buildNotifyDetails 同一构造
 * ——registry 终态条目已含通知构造所需全部字段，参数侧结构子集 NotificationTaskLike
 * 由 registry 条目直接满足）；收殓补投候选（orphaned / exited process-exit）= 维持
 * terminated 简报（无业务 details——「不谎报」既有裁决：收殓时点不存在时长/成败
 * 事实，且对账路径是其唯一生产者，无「主路径同一条通知」可对齐，波 3 形态原样）。
 */
function buildReapNotifyEnvelope(entry: RegistryEntry): ReapNotifyEnvelope {
	if (isReapedForm(entry)) {
		return {
			id: entry.taskId,
			timing: "steer",
			payload: {
				kind: "custom",
				customType: BACKGROUND_BASH_CUSTOM_TYPE,
				content: buildTerminatedNotificationLine(entry),
				display: true,
			},
		};
	}
	return {
		id: entry.taskId,
		timing: "steer",
		payload: {
			kind: "custom",
			customType: BACKGROUND_BASH_CUSTOM_TYPE,
			content: buildNotificationContent(entry),
			display: true,
			details: buildNotifyDetails(entry),
		},
	};
}

/** 收殓形态判定（payload 分层用；判据层不区分两形态——三重事实同一判据）。 */
function isReapedForm(entry: RegistryEntry): boolean {
	return entry.state === "orphaned" || (entry.state === "exited" && entry.reason === "process-exit");
}

/** 补投信封（结构 = ReconcileDeliver 首参；D6 payload 分层后的两形态联合）。 */
type ReapNotifyEnvelope = Parameters<ReconcileDeliver>[0];

/**
 * 补投候选判据（D2 三重事实：终态 ∧ 送达痕迹未命中 ∧ 投递日志无该幂等键条目）。
 * 判据单一导出（RL12 行为锁：三个边沿入口对同一事实状态产出同一判定——判据本体
 * = @zhushanwen/pi-delivery-port reconcile-judgement.isReconcileNotifyCandidate
 * 骨架，本函数是 bash 域
 * registry 事实映射；delivered/journaled 缺省 = 空（只查 registry 侧事实），即
 * deliverReapNotifications ① 的预检短路形态，不另立第二套真值）。
 *
 * 成因排除位（检查点登记的表达形态 = 成因排除位，非痕迹判据覆盖）：killed 的
 * kill 发令方当次交互已同步获知结果（notify.ts kill 路径通知不入账的单点归属
 * 规则），痕迹/日志对 killed 恒未命中——不排除将结构性误报候选（N1 场景）。
 * killing / running+判死遗留不是候选（isTerminalState 排除非严格终态；退化现状
 * 由 unregister 收尾兜底，波 3 语义原样）。
 */
export function isReapNotifyCandidate(
	entry: RegistryEntry,
	delivered: ReadonlySet<string> = EMPTY_ID_SET,
	journaled: ReadonlySet<string> = EMPTY_ID_SET,
): boolean {
	return isReconcileNotifyCandidate(registryFacts(entry, delivered, journaled));
}

/** bash 域 registry 条目 → 判据骨架事实映射（预检短路与终判共用同一映射）。 */
function registryFacts(
	entry: RegistryEntry,
	delivered: ReadonlySet<string>,
	journaled: ReadonlySet<string>,
): ReconcileNotifyFacts {
	return {
		isTerminal: isTerminalState(entry.state),
		excludedByOrigin: entry.reason === "killed",
		delivered: delivered.has(entry.taskId),
		journaled: journaled.has(entry.taskId),
	};
}

/** 空事实集合常量（isReapNotifyCandidate 预检形态的缺省参数，避免逐调用建集合）。 */
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();
