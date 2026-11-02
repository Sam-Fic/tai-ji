// src/notify-reconcile.ts — managed session 死亡/结果通知的对账补投
// （completion-signal-delivery D8：session-manager 域对账步与判据事实源接入，
// 与 bash/subagent 域同构处置阶梯的域侧落位）。
//
// 三重事实判据（域事实映射进共享骨架——判据逻辑零新增，真值组合单源锚定
// base-tool-enhance background/notify-reconcile-judgement.ts 的
// isReconcileNotifyCandidate；跨扩展无依赖通道（本包 package.json 不依赖
// base-tool-enhance），按 subagent-core notify-reconcile.ts 先例同构落位，
// 真值表测试逐行对拍锁定）：
//   候选 = 应投递而未送达（isTerminal）∧ 域排除位未命中 ∧ 送达痕迹未命中 ∧
//          投递日志无该幂等键承载
//
// 判据事实源磁盘化（completion-signal-delivery A1 修复的域侧同构落位，范本 =
// base-tool-enhance pending-reconcile.ts「判据事实源磁盘化」段）：判据全部事实
// 源——pending 表派生视图（设计 SC10）+ 送达痕迹 / 投递日志 / 死亡新闻对三个辅助
// 源——读 session JSONL 落盘条目（readSessionFileEntries），不读 pi 内存账。pi
// SessionManager._appendEntry 先 fileEntries.push 后 _persist、persist 失败
// （EACCES 等）无回滚，留下「幽灵内存 entry」（内存账在册、JSONL 无行）；内存账
// 口径曾把幽灵的送达痕迹/投递日志条目当真 → 「拒收未受理」的键被误判已受理 →
// 补投结构性静默失效。磁盘事实使 delivered/journaled 语义 = 「JSONL 实际含该键
// 条目」，与受理落盘契约一物一名；sessionFile 缺席（no-persist 形态——_persist
// no-op 恒成功、无幽灵态）退化内存 entries（该形态内存账即完整事实）+ warn 留痕。
// 成本口径：内存账 ⊇ 盘上条目（幽灵态只会多不会少），内存预检「无 register 条目
// 早退」= 盘上亦无——高频边沿（agent_settled）常态（无 managed session 债权）零
// 文件读，候选在册才读盘（bash 域范本同款「候选在册才读盘」形态）。
// 幽灵候选源（register/unregister 条目自身落盘失败）的残余 = 磁盘口径下候选不可
// 见的保守 miss（漏补投方向，与「漏补投优于重复投」既有取向一致）：该形态 =
// 债权登记持久化断裂，重启后任何恢复通道都无从发现，对账以磁盘事实为准是其正确
// 语义；盘上无注销条目 = 「债权在途」不虚构补投。
//
// 四项读取规则（D8③ 本域判据的落地细则，逐项落实）：
//   ① 取数形态 = pending:register/unregister 全量 entries 现算（经 protocol
//     scanPendingEntries 单点，registerEntries 含已注销条目）——非 active 视图
//     （applyPendingDiff 差集会把注销条目滤掉；rejected 场景 flushBatch 尾部
//     无条件注销后条目从 active 视图消失，按 active 读则候选结构性不可达，
//     与 D8①「注销语义不动、恢复责任移交对账层」矛盾）。已注销条目恰是判据
//     对象：注销存在 = 新闻已到达并被处理过 = 「应投递而 rejected」的必要事实。
//   ② 静默注销类排除依据 = pending:unregister entry 的 reason 原词
//     （cancelled/orphaned——例外1 上游分流逐笔即时注销，非补投对象）。经
//     resolveSettlementReason 的解析枚举不可用（stopped/exited/deleted 同被
//     折叠为 cancelled，四项分流失真）——本文件自扫 unregister 条目 data.reason
//     原词（PENDING_UNREGISTER_ENTRY_TYPE 词表单点自 protocol）。
//   ③ 三类「注销 reason 为应投递类而无独立主路径投递」形态排除（候选只认
//     flushBatch 正常路径批首的独立投递键）：
//     (a) 合批非首成员——成员键随批首条目 collectKey 键集申报承载（批首成功
//         受理形态），承载反查命中即排除。实现 = 投递日志条目 id 集 ∪ 条目
//         collectKey 键集展开。
//     (b) 死亡槽重复后续批——同死亡新闻已由前批投递送达（flushBatch 例外2
//         早退分支，unregister-only）。死亡槽 (sessionId, deathSeq) 是运行期
//         去重内存态、不参与判据（SC10 登记）；其判据侧磁盘投影 = 死亡新闻对
//         (label, reason∈{exited,deleted}) 已有送达通知条目（送达通知
//         details.label/details.reason 携带两事实）。后续批键的 register name
//         与前批 label 同源（同 session 债权的 armSessionNotify 同 name），对
//         命中即排除。只限死亡类 reason（exited/deleted）：结果新闻无槽去重
//         语义，同 session 两次 send 的两条 completed 新闻是两个独立新闻，按
//         对排除会误吞待补投候选。残余边界：label 用户可重复（两个 session
//         同 label）时对命中可能漏补投——「漏补投优于重复投」保守方向，与
//         送达痕迹判据同款取向。前批亦 rejected 的变体（死亡对无痕迹）后续批
//         键保留候选 = 伴生误报（三重叠加极边缘），显式登记不建排除位。
//     (c) sessionId 缺失防御批——flushBatch 早退分支（warn 留痕 unregister-only）。
//         判据源四源（pending 表 / 投递日志 / 送达痕迹 / 死亡对）均无「应答缺
//         sessionId」的任何落盘标记（设计原文自认「无区分标记」）：键未被任何
//         条目承载恰是该形态的定义特征，与 rejected 批首磁盘同形态。排除的
//         机器化实现不可达（强行区分需新增落盘——撞 D2 零新增落盘否决；或
//         时间启发式——违反 ADR-0122）。实施期裁决 = 不建排除位，残余呈报：
//         可达性 = D-4 协议不变量违反（fail-closed 应答 reason 恒 cancelled
//         走静默注销；应投递类 reason 却缺 sessionId = runtime 双重违例，生产
//         不可达常态且触发即有 flushBatch warn 留痕的漂移信号）；残余危害 =
//         补投一条骨架简报（label/status 两事实真实，重复刺激级），方向低于
//         漏补投。(c) 形态按上述可达性论证登记为已接受残余（对账结果不建
//         计数字段）。
//   ④ 域过滤 = 判据只取 register type === "session" 条目。pending 表混装四域
//     写方（protocol 写方注释登记），跨域条目不过滤则「无独立主路径投递键 →
//     三重判据结构性全命中」的误报形态跨域成立（subagent record id ≠ 其通知
//     键 notifyId、workflow runId ≠ wf-done 投递键、bash 条目与本域判据及
//     base-tool-enhance 域判据重复扫同一域）。域内先例 = recoverStaleRegisters
//     的 type === "session" 判定（watch-coordinator 同款）。
//
// payload 分层（D8⑤ + R-1 条款）：本域补投 = 骨架简报形态——判据源不含
// watch 应答内存 payload（fulfills/exitCode/stderrTail/sessionFilePath 全部
// 不落盘），主路径 content 构造 buildManagedNotifyContent 的 sessionId 为必填
// 且取值应为 managed 子会话 id（register entry 落盘的 sessionId 是 listener 侧
// 父会话 id，两值不同物，取用即谎报）——补投不调主路径构造（R-1），骨架文案
// 独立构造：label（register entry 的 name，域内既有先例 = 重启收尾路径同源）+
// status（unregister reason）两事实入文，诊断字段按主路径缺席省略语义全部省略，
// details.fulfills 取 0（0 = 无债权申报，不虚构笔数——主路径 0/undefined 不出行
// 语义同源）。省略的都是判据源不存在的事实，未虚构字段值（「不谎报」分层族）。
//
// 入口形态（D8② 三入口编排互调本文件唯一对账函数 runNotifyReconcileMaintenance）：
//   ① session_start——index.ts 既有 handler（重启收尾路径之后）；
//   ② agent_settled——index.ts 装配期订阅（回合收尾兜底边沿）；
//   ③ 切回补强（__taiji_bg_reconcile__）——pi 命令名全局唯一且单 handler 分发
//     （pi SDK runner.getCommand 取首个同名命中；runtime 只发 base-tool-enhance
//     注册的那一条命令，字面量契约），本扩展无切回触发源且与 base-tool-enhance
//     无依赖边（跨扩展依赖通道不存在）——经三方共同依赖包 pi-delivery-port 的
//     进程级注册槽订阅切回派发（index.ts 装配期 subscribeResumeReconcile，
//     base-tool-enhance handler dispatchResumeReconcile 转发；subagent 域
//     SubagentService 单例直转的 A5 先例同族，reason="resume"）。
// 幂等：补投受理成功后投递日志条目（id + collectKey）与送达痕迹抵消判据，
// 下一边沿不再命中；跨边沿重复对账天然收敛。

import {
	PENDING_UNREGISTER_ENTRY_TYPE,
	scanPendingEntries,
} from "@zhushanwen/extension-protocol";
import {
	ACK_CUSTOM_TYPE,
	V1_ACK_CUSTOM_TYPE,
	V1_OUTBOX_CUSTOM_TYPE,
	OUTBOX_CUSTOM_TYPE,
	mapV1OutboxData,
	readAckId,
	readOutboxDataV2,
} from "@zhushanwen/pi-delivery-port";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { readFileSync } from "node:fs";

import { MANAGED_SESSION_NOTIFY_CUSTOM_TYPE } from "./notify-content.ts";

const logger = getLogger("session-manager");

/** 脏行 warn 留痕的截断长度（taste/no-magic-numbers 抽常量） */
const DIRTY_LINE_SNIPPET_LEN = 120;

/** 本域通知的送达 customType（域内单源 = notify-content.ts 导出的透传）。 */
const NOTIFY_CUSTOM_TYPE = MANAGED_SESSION_NOTIFY_CUSTOM_TYPE;

/**
 * 应投递类注销 reason 词表（watch-coordinator 攒批窗入窗词表的同源清单——
 * flushBatch 投递后按原词注销的五类；exception2 早退批与防御批按同词注销）。
 * 在册 = 该键的新闻已被 watch 应答处理（应投递而未送达候选的必要事实）。
 */
const DELIVERABLE_UNREGISTER_REASONS: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"stopped",
	"exited",
	"deleted",
]);

/** 死亡新闻类 reason（死亡槽去重的范围词表——死亡对排除只作用于这两类）。 */
const DEATH_NEWS_REASONS: ReadonlySet<string> = new Set(["exited", "deleted"]);

/** 静默注销类 reason（例外1 上游分流的注销词——AS20 域内边界）。 */
const SILENT_UNREGISTER_REASONS: ReadonlySet<string> = new Set(["cancelled", "orphaned"]);

// ─── 三重事实判据骨架（同构落位，锚定 u1 单源）───

/**
 * 三重事实判据的输入（与 base-tool-enhance notify-reconcile-judgement /
 * subagent-core notify-reconcile 两处同构——字段结构逐一锚定；真值组合由
 * 真值表测试与 bash 域对拍锁定，判据演化不产生第二套真值逻辑）。
 */
export interface ReconcileNotifyFacts { // oe-exempt:20261101:framework:跨包不可达的同形结构副本（权威源 packages/subagent-core notify-reconcile.ts，载体关系登记文件头），域侧映射随本设计交付

	/** 事实一：应投递的新闻已到达且未送达（已注销 ∧ reason 应投递类）。 */
	isTerminal: boolean;
	/** 域排除位（「主路径不发者排除」原理）：静默注销类 ∨ 域过滤未命中。真 = 非候选。 */
	excludedByOrigin: boolean;
	/** 事实二：送达痕迹命中（键的通知消息已在会话 entries ∨ 死亡新闻对已送达）。 */
	delivered: boolean;
	/** 事实三：投递日志已承载该键（条目 id 命中 ∪ collectKey 键集命中）。 */
	journaled: boolean;
}

/**
 * 三重事实判据（骨架真值组合：应投递 ∧ 未排除 ∧ 无痕迹 ∧ 无日志承载）。
 * 与 bash/subagent 域同一真值组合（判据语义单源的域侧同构落位——跨扩展无
 * 依赖通道，真值表测试逐行对拍锁定）。
 */
export function isReconcileNotifyCandidate(facts: ReconcileNotifyFacts): boolean {
	return facts.isTerminal && !facts.excludedByOrigin && !facts.delivered && !facts.journaled;
}

// ─── 域事实收集器（当前 session entries 的单次遍历事实源）───

/** unknown 值上指定键的 string 字段（非对象/缺键/非字符串一律 undefined）。 */
function stringField(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

/**
 * pending:unregister 条目的原词 reason 视图（id → reason 末次值）。四项规则②
 * 的落位：scanPendingEntries.unregisterSettlements 是解析枚举（stopped/exited/
 * deleted 同折叠 cancelled），四项分流失真——本收集器读 data.reason 原词
 * （落盘契约 { id, reason, status } 的 reason 位，词表单点 = protocol
 * PENDING_UNREGISTER_ENTRY_TYPE）。
 */
export function collectUnregisterReasons(entries: readonly unknown[]): Map<string, string> {
	const reasons = new Map<string, string>();
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry.customType !== PENDING_UNREGISTER_ENTRY_TYPE) continue;
		const data = entry.data;
		if (data === null || typeof data !== "object") continue;
		const id = stringField(data, "id");
		const reason = stringField(data, "reason");
		if (id === undefined || reason === undefined) continue;
		reasons.set(id, reason); // 同 id 多条注销取末次（与 protocol 视图同口径）
	}
	return reasons;
}

/**
 * 从会话 entries 提取本域已送达通知的幂等键集合（送达痕迹判据事实源）。
 * 判定通道两条任一命中：details.notifyId（主路径/骨架补投 payload 携带）/
 * details.deliveryId（port 受理时统一写入 details 的送达凭据键）。刻意不收
 * content 文本兜底：content 内的 label 片段会让跨键条目误命中（宁滥勿缺的
 * 反向才是双投——痕迹收集按结构化字段精确收，与 subagent 域同款纪律）。
 */
export function collectDeliveredManagedNotifyIds(entries: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry.customType !== NOTIFY_CUSTOM_TYPE) continue;
		const details = entry.details;
		const notifyId = stringField(details, "notifyId");
		if (notifyId !== undefined) ids.add(notifyId);
		const deliveryId = stringField(details, "deliveryId");
		if (deliveryId !== undefined) ids.add(deliveryId);
	}
	return ids;
}

/**
 * 从会话 entries 提取已送达死亡新闻的对集合（(label, reason)——死亡槽去重的
 * 判据侧磁盘投影，(b) 排除位事实源）。只收死亡类 reason（exited/deleted）；
 * label 取 details.label（register name 同源事实）。
 */
export function collectDeliveredDeathPairs(entries: readonly unknown[]): Set<string> {
	const pairs = new Set<string>();
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry.customType !== NOTIFY_CUSTOM_TYPE) continue;
		const details = entry.details;
		const label = stringField(details, "label");
		const reason = stringField(details, "reason");
		if (label === undefined || reason === undefined) continue;
		if (!DEATH_NEWS_REASONS.has(reason)) continue;
		pairs.add(`${label}\u0000${reason}`);
	}
	return pairs;
}

/**
 * 从会话 entries 提取投递日志已登记的幂等键与承载键集（事实三事实源，(a)
 * 承载反查的载体）。outbox（受理落盘，collectKey 键集随条目申报——合批成员
 * 键的承载事实源）与 ack/discard（终局列）v2/v1 四类 entry 兼容读；解析复用
 * port 包单点（readOutboxDataV2 / mapV1OutboxData / readAckId），宽容口径与
 * port scanJournal 一致：data 畸形按无条目——误判「无承载」的残余风险由 port
 * 幂等预检承接（补投重投被 swallowed 吞并，无实害）。
 */
export function collectJournaledDeliveryIds(entries: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry["type"] !== "custom") continue;
		switch (entry["customType"]) {
			case OUTBOX_CUSTOM_TYPE: {
				const record = readOutboxDataV2(entry["data"]);
				if (record === undefined) break;
				ids.add(record.id);
				if (record.collectKey !== undefined) {
					for (const key of record.collectKey) ids.add(key);
				}
				break;
			}
			case V1_OUTBOX_CUSTOM_TYPE: {
				// v1 存量（旧通知账本）兼容读；scannedAt 只填 record.recordedAt 元数据，
				// 本判据只取 id——传 0 保持纯函数无时钟依赖
				const record = mapV1OutboxData(entry["data"], 0);
				if (record !== undefined) ids.add(record.id);
				break;
			}
			case ACK_CUSTOM_TYPE:
			case V1_ACK_CUSTOM_TYPE: {
				const id = readAckId(entry["data"]);
				if (id !== undefined) ids.add(id);
				break;
			}
			default:
				break;
		}
	}
	return ids;
}

// ─── 判据事实源读侧（session JSONL 落盘条目）───

/**
 * 读 session JSONL 文件的落盘条目（判据事实源的磁盘读侧；动机与退化语义见文件头
 * 「判据事实源磁盘化」段，与 base-tool-enhance pending-reconcile.ts 同名函数同构
 * 落位——跨扩展无依赖通道，域侧副本）。pi _persist 落盘形态 = 每条 entry 一行
 * JSON.stringify，逐行 parse 产出与 getEntries() 同构的条目数组。
 *
 * 容错口径（与 collectJournaledDeliveryIds「data 畸形按无条目」宽容口径同源）：
 *  - ENOENT → []：session 首条对话消息前文件不存在（pi _persist 首次 flush 前置
 *    条件），常态非异常；
 *  - 其他读错误（EACCES 等）→ warn + []：磁盘事实不可得按「无条目」，候选源与
 *    抵消事实同按空（保守 miss + warn 修复信号——按内存账退化则会沿幽灵态静默
 *    吞补投，即 A1 缺陷形态本身）；
 *  - 脏行（JSON.parse 失败 / 非对象）单行跳过（JSONL 容错纪律，protocol
 *    pending-entries 扫描同款）。
 */
export function readSessionFileEntries(sessionFile: string): unknown[] {
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
		logger.warn("reconcile journal facts read failed; disk entries treated as empty (candidates retried at next reconcile edge)", {
			detail: { sessionFile, err: toErrorMessage(err) },
		});
		return [];
	}
	const entries: unknown[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed !== null && typeof parsed === "object") entries.push(parsed);
		} catch (e) {
			// 脏行跳过：单行损坏不拖垮整盘事实；warn 留痕（taste/no-silent-catch）
			logger.warn("session JSONL 脏行跳过（对账事实按其余行继续）", { detail: { line: line.slice(0, DIRTY_LINE_SNIPPET_LEN), error: toErrorMessage(e) } });
		}
	}
	return entries;
}

// ─── 骨架简报 payload（D8⑤ + R-1：独立构造，不调主路径 buildManagedNotifyContent）───

/**
 * 补投 details 形态（骨架简报）：ManagedNotifyDetails 的子集——sessionId 缺席
 * （判据源无 managed 子会话 id 事实，父会话 id 取用即谎报），fulfills 恒 0
 * （无债权申报）。core extractNotifyRecords 读侧只消费 notifyId 与 reason，
 * sessionId 缺席不影响消费（notify-content.ts 既有注释登记）。
 */
export interface ManagedReconcileNotifyDetails { // oe-exempt:20261101:framework:跨包不可达的同形结构副本（权威源 packages/subagent-core notify-reconcile.ts，载体关系登记文件头），域侧映射随本设计交付

	notifyId: string;
	reason: string;
	fulfills: number;
	label: string;
}

/**
 * 骨架简报构造（D8⑤ 裁决的独立构造位——R-1：禁止调 buildManagedNotifyContent
 * 主路径构造，其 sessionId 为必填且只能取父会话 id 即谎报）。文案只承载判据源
 * 可构造的两事实：label（register entry 的 name）与 status（unregister reason
 * 原词）；诊断字段按主路径缺席省略语义省略（判据源不存在的事实不虚构）。
 */
export function buildManagedReconcileBriefing(
	notifyId: string,
	label: string,
	reason: string,
): { content: string; details: ManagedReconcileNotifyDetails } {
	return {
		content: `Managed session "${label}" finished with status "${reason}".`,
		details: { notifyId, reason, fulfills: 0, label },
	};
}

// ─── 对账编排（三入口唯一入口）───

/** 单次对账结果（日志 + 测试断言面）。 */
export interface NotifyReconcileResult { // oe-exempt:20261101:framework:跨包不可达的同形结构副本（权威源 packages/subagent-core notify-reconcile.ts，载体关系登记文件头），域侧映射随本设计交付

	/** 扫描的 register 条目总数（全量 entries 现算口径）。 */
	scanned: number;
	/** 预检候选数（应投递 ∧ 排除位未命中——含 (a)(b) 承载/死亡对两事实待核）。 */
	candidates: number;
	/** 补投已提交（submitNotify 已调）的 notifyId。 */
	redelivered: string[];
	/** 送达痕迹/死亡对命中而跳过的 notifyId。 */
	skippedDelivered: string[];
	/** 投递日志承载命中而跳过的 notifyId。 */
	skippedJournaled: string[];
}

/**
 * 对账编排（session_start / agent_settled / 切回（resume）三入口互调的单一函数；
 * 同步——entries 现算 + deliver 同步受理，毫秒级）。幂等：重复执行时已补投键有
 * 投递日志承载/送达痕迹抵消，判据不再命中。失败吞掉记 warn（对账/补投失败无害：候选判据
 * 仍命中，下一对账边沿幂等重查）——调用方不需自行 try-catch。
 *
 * sessionFile = 当前 session JSONL 路径（pi sessionManager.getSessionFile()）——
 * 判据全部事实源读它的落盘条目（磁盘事实，机制见文件头「判据事实源磁盘化」段）；
 * undefined（no-persist 形态）退化内存 entries（现状行为）+ warn。
 */
/**
 * 判据事实源解析（复杂度拆出）：五源判据事实全部从 session JSONL 落盘条目产出；
 * sessionFile 缺席（no-persist 形态，磁盘事实结构性不存在）退化内存 entries——
 * 该形态 _persist no-op 恒成功、无幽灵态，内存账即完整事实。
 */
function resolveFactEntries(deps: {
	reason: string;
	entries: readonly unknown[];
	sessionFile?: string;
}): readonly unknown[] {
	if (deps.sessionFile !== undefined) return readSessionFileEntries(deps.sessionFile);
	logger.warn("managed notify reconcile journal facts fell back to in-memory entries: session file unavailable (no-persist session?); ghost in-memory entries would misjudge delivered/journaled facts", {
		detail: { reason: deps.reason },
	});
	return deps.entries;
}

/**
 * 预检过滤（复杂度拆出——四项规则①-④）：全量落盘条目现算（scanPendingEntries 单点
 * ——registerEntries 含已注销条目，非 active 差集视图）后的四项规则：
 *  ① 域过滤：只取 type === "session" 条目（registerTypes 首见视图；跨域条目互斥
 *     排除——防四域混装的跨域三重全命中误报）；
 *  ② 静默注销类排除（unregister reason 原词分流）+ 应投递类词表过滤（非在册词 =
 *     词表外/防御形态，不虚构）；无注销条目 = 债权仍在途（新闻未到达）。
 */
function prefilterManagedCandidates(
	scan: ReturnType<typeof scanPendingEntries>,
	unregisterReasons: ReadonlyMap<string, string>,
): Array<{ notifyId: string; label: string; reason: string }> {
	const prefiltered: Array<{ notifyId: string; label: string; reason: string }> = [];
	for (const { data } of scan.registerEntries) {
		const notifyId = stringField(data, "id");
		if (notifyId === undefined) continue;
		if (scan.registerTypes.get(notifyId) !== "session") continue;
		const reason = unregisterReasons.get(notifyId);
		if (reason === undefined) continue;
		if (SILENT_UNREGISTER_REASONS.has(reason)) continue;
		if (!DELIVERABLE_UNREGISTER_REASONS.has(reason)) continue;
		const name = stringField(data, "name");
		prefiltered.push({ notifyId, label: name ?? notifyId, reason });
	}
	return prefiltered;
}

/**
 * 单候选补投终判 + 补投出口（复杂度拆出——终判循环体）：facts 三事实（isTerminal /
 * excludedByOrigin 预检已保证）+ delivered 双源（(a) 通知幂等键已送达 ∧ (b) 死亡对
 * 排除：死亡类 reason 且同 (label, reason) 新闻已送达）+ journaled（载荷键已落盘）。
 * submitNotify false（port 缺席/重提链失败）不留痕跳过：判据仍命中，下一对账边沿
 * 幂等重查；true（accepted/swallowed）→ 已投递。
 */
function reconcileOneManagedCandidate(deps: {
	reason: string;
	submitNotify: (notifyId: string, content: string, details: ManagedReconcileNotifyDetails) => boolean;
}, candidate: { notifyId: string; label: string; reason: string }, deliveredIds: ReadonlySet<string>, deathPairs: ReadonlySet<string>, journaledIds: ReadonlySet<string>, result: NotifyReconcileResult): void {
	const facts: ReconcileNotifyFacts = {
		isTerminal: true, // 预检已保证：已注销 ∧ reason 应投递类
		excludedByOrigin: false, // 预检已保证：域过滤命中 ∧ 非静默注销类
		delivered:
			deliveredIds.has(candidate.notifyId) ||
			(DEATH_NEWS_REASONS.has(candidate.reason) &&
				deathPairs.has(`${candidate.label}\u0000${candidate.reason}`)),
		journaled: journaledIds.has(candidate.notifyId),
	};
	if (!isReconcileNotifyCandidate(facts)) {
		if (facts.delivered) result.skippedDelivered.push(candidate.notifyId);
		if (facts.journaled) result.skippedJournaled.push(candidate.notifyId);
		return;
	}
	const briefing = buildManagedReconcileBriefing(
		candidate.notifyId,
		candidate.label,
		candidate.reason,
	);
	const accepted = deps.submitNotify(
		candidate.notifyId,
		briefing.content,
		briefing.details,
	);
	if (accepted) {
		result.redelivered.push(candidate.notifyId);
		logger.debug("managed notify reconciled via delivery port", {
			detail: { reason: deps.reason, notifyId: candidate.notifyId },
		});
	}
}

export function runNotifyReconcileMaintenance(deps: {
	/** 入口来源（session_start / agent_settled / resume 切回）——入口来源日志可辨。 */
	reason: string;
	/** 当前 session entries（内存账——预检短路源 + no-persist 退化事实源）。 */
	entries: readonly unknown[];
	/**
	 * 当前 session JSONL 路径（装配 = ctx.sessionManager.getSessionFile() 直通）——
	 * 判据事实源磁盘读侧；undefined = no-persist 形态退化内存账 + warn。
	 */
	sessionFile?: string;
	/** 补投出口（装配注入 = recordManagedNotify 直通——补投与主路径共用投递管道）。 */
	submitNotify: (notifyId: string, content: string, details: ManagedReconcileNotifyDetails) => boolean;
}): NotifyReconcileResult {
	const result: NotifyReconcileResult = {
		scanned: 0,
		candidates: 0,
		redelivered: [],
		skippedDelivered: [],
		skippedJournaled: [],
	};
	try {
		// 内存预检短路（bash 域「候选在册才读盘」同款成本下界）：内存账 ⊇ 盘上条目
		// （幽灵态只会多不会少），无 register 条目早退 = 盘上亦无，零文件读。
		const memScan = scanPendingEntries(deps.entries);
		if (memScan.registerEntries.length === 0) return result;

		const factEntries = resolveFactEntries(deps);
		// 四项规则①：全量落盘条目现算（scanPendingEntries 单点——registerEntries
		// 含已注销条目，非 active 差集视图）；四源辅助事实同盘单次遍历全产
		const scan = scanPendingEntries(factEntries);
		const unregisterReasons = collectUnregisterReasons(factEntries);
		const deliveredIds = collectDeliveredManagedNotifyIds(factEntries);
		const deathPairs = collectDeliveredDeathPairs(factEntries);
		const journaledIds = collectJournaledDeliveryIds(factEntries);

		result.scanned = scan.registerEntries.length;
		const prefiltered = prefilterManagedCandidates(scan, unregisterReasons);

		for (const candidate of prefiltered) {
			result.candidates += 1;
			reconcileOneManagedCandidate(deps, candidate, deliveredIds, deathPairs, journaledIds, result);
		}
	} catch (err) {
		logger.warn("managed notify reconcile failed; candidates retried at next reconcile edge", {
			detail: { reason: deps.reason, err: err instanceof Error ? err.message : String(err) },
		});
	}
	return result;
}
