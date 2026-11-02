// src/session-journal-read.ts
//
// session JSONL 落盘条目的磁盘读侧（对账补投判据事实源的共享读原语）——原角色
// 载体 = 三域各自持有的同构副本（bash pending-reconcile.ts / session-manager
// notify-reconcile.ts / subagent-workflow workflow-notify-reconcile.ts 的
// readSessionFileEntries，近逐字同构、容错口径一致），随判据链收编进本包单源。
// 机制动机（pi SessionManager._appendEntry 幽灵内存 entry 形态——persist 失败无
// 回滚，内存账不可作判据事实源）的 pi 侧实锚登记 = docs/pi-semantics.json PS-97。
// 域侧退化语义（no-persist 形态退化内存账 + warn）经 resolveReconcileFactEntries
// 收编本文件单源（session-manager / workflow 两域消费；bash 域文案词序与其余两域
// 不同，保持域内原样，登记在该域）。
//
// logger 归因：本包共享原语的 warn 走本包通道（getLogger("pi-delivery-port")），
// 不按消费域归因（三域调用点零参数差异；读失败本身是共享原语事件，域归因由调用
// 栈排障定位）。容错口径与 packages/subagent-core 的同构读原语
// readSessionEntriesFromFile 互指登记见该函数头注（core 受 core ← extensions
// 依赖方向红线不进本包；读错误 warn + [] 口径两侧一致，warn 文本同串——
// ENOENT 静默空、脏行跳过亦同；差异仅 logger 通道归因）。

import { readFileSync } from "node:fs";

import { getLogger } from "@zhushanwen/pi-extension-logger";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

const logger = getLogger("pi-delivery-port");

/** 脏行 warn 留痕的截断长度（taste/no-magic-numbers 抽常量）。 */
const DIRTY_LINE_SNIPPET_LEN = 120;

/**
 * 读 session JSONL 文件的落盘条目（判据事实源的磁盘读侧）。pi _persist 落盘形态
 * = 每条 entry 一行 JSON.stringify，逐行 parse 产出与 getEntries() 同构的条目数组。
 *
 * 容错口径（与 collectJournaledDeliveryIds「data 畸形按无条目」宽容口径同源）：
 *  - ENOENT → []：session 首条对话消息前文件不存在（pi _persist 首次 flush 前置
 *    条件，PS-97 :797-799 未 flush 无对话早退），常态非异常；
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
			logger.warn("session JSONL 脏行跳过（对账事实按其余行继续）", {
				detail: { line: line.slice(0, DIRTY_LINE_SNIPPET_LEN), error: toErrorMessage(e) },
			});
		}
	}
	return entries;
}

/**
 * 对账事实源解析（session-manager / workflow 两域对账编排共用的 no-persist 退化
 * 形态单源）：sessionFile 在场 = 读磁盘落盘条目（readSessionFileEntries）；缺席
 * （no-persist 形态，磁盘事实结构性不存在）退化内存 entries + warn——该形态
 * _persist no-op 恒成功、无幽灵态，内存账即完整事实。warn 文案 domain 段参数化
 * （域标签进文案首位，子串 "fell back to in-memory entries" 为两域测试的共享断言锚）。
 */
export function resolveReconcileFactEntries(opts: {
	/** 域标签（warn 文案归因段：如 "managed notify reconcile" / "workflow notify reconcile"）。 */
	domain: string;
	/** 入口来源（warn detail 透传——入口来源日志可辨）。 */
	reason: string;
	/** 当前 session entries（内存账——退化事实源）。 */
	entries: readonly unknown[];
	/** 当前 session JSONL 路径；undefined = no-persist 形态。 */
	sessionFile?: string;
}): readonly unknown[] {
	if (opts.sessionFile !== undefined) return readSessionFileEntries(opts.sessionFile);
	logger.warn(
		`${opts.domain} journal facts fell back to in-memory entries: session file unavailable (no-persist session?); ghost in-memory entries would misjudge delivered/journaled facts`,
		{
			detail: { reason: opts.reason },
		},
	);
	return opts.entries;
}
