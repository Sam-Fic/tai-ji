// src/reconcile-judgement.ts
//
// 对账补投判据的共享纯函数层（completion-signal-delivery D2 三重事实判据骨架 +
// 投递日志幂等键提取）——无 I/O、无 pi 依赖。原角色载体 = base-tool-enhance
// background/notify-reconcile-judgement.ts（u1 抽出的「跨域共享语义落点」）；
// 判据链曾以「域侧同构落位 + 真值表测试逐行对拍」形态在 bash / session-manager /
// subagent-workflow 三域各持物理副本（subagent-core 受 core ← extensions 依赖
// 方向红线不能反向共享，第四域仍为同构落位——见 execution/notify/notify-reconcile.ts
// 文件头），本文件是四域判据链收编进三方共同依赖包后的单源：骨架真值组合与幂等键
// 提取各只此一份，域侧只留「域事实 → 布尔」映射，真值表测试随迁本包单点锁定
// （reconcile-judgement.test.ts），域侧逐行对拍的人工同步义务退役。
//
// 域侧消费形态（调用方判定好的事实布尔进骨架；骨架零 I/O）：bash 域 =
// pending-reconcile.ts registryFacts（registry 条目）；session-manager 域 =
// notify-reconcile.ts 预检 + reconcileOneManagedCandidate；workflow 域 =
// workflow-notify-reconcile.ts reconcileOneCandidate；subagent-core 域 = 世代
// 匹配变体（本包不可达，同构锚定）。排除位语义随域参数化（「主路径不发者排除」
// 原理，D5 裁决同源），判据演化不产生第二套真值组合。

import {
	ACK_CUSTOM_TYPE,
	OUTBOX_CUSTOM_TYPE,
	V1_ACK_CUSTOM_TYPE,
	V1_OUTBOX_CUSTOM_TYPE,
	mapV1OutboxData,
	readAckId,
	readOutboxDataV2,
} from "./journal.ts";

/** 三重事实判据的输入（调用方在域内完成事实源映射后传入；骨架零 I/O）。 */
export interface ReconcileNotifyFacts { // oe-exempt:20261102:framework:port 契约层判据输入形状，域侧以对象字面量消费、无 implements 变体（四域判据链已收编本包单源）
	/** 事实一：任务/记录已终态（域事实源判定——bash 域 = registry 终态枚举成员）。 */
	isTerminal: boolean;
	/**
	 * 排除位（「主路径不发者排除」原理，D5 裁决同源）：主路径对该终态成因不发的
	 * 通知，补投无从恢复也不该发。bash 域 = killed；u3 subagent 域 = cancelled 族
	 * + workflow origin 整体排除；session-manager/workflow 域 = 静默注销类 /
	 * 恒 false（主路径全终态发通知）。真 = 非候选。
	 */
	excludedByOrigin: boolean;
	/** 事实二：送达痕迹命中（该键的完成通知消息已在会话 entries）。 */
	delivered: boolean;
	/**
	 * 事实三：投递日志已含该幂等键条目（受理已发生）。有条目未送达 = 差集重放
	 * （port.recover）的职责；已终局 = ack/凭据判据的职责——均非补投对象（D2
	 * 采用段：补投只认「从未受理成功」形态，与重放职责不重叠）。
	 */
	journaled: boolean;
}

/**
 * 三重事实判据骨架（D2）：终态 ∧ 未排除 ∧ 无送达痕迹 ∧ 投递日志无条目。
 *
 * 单源位（原 judgement.ts RL12 行为锁收编）：bash 域对账（isReapNotifyCandidate）
 * 与三边沿入口（session_start / 切回 / agent_settled）经同一函数消费；session-
 * manager / workflow 域终判循环复用同一真值组合——判据演化不产生第二套真值逻辑。
 */
export function isReconcileNotifyCandidate(facts: ReconcileNotifyFacts): boolean {
	return facts.isTerminal && !facts.excludedByOrigin && !facts.delivered && !facts.journaled;
}

/**
 * 从会话 entries 提取投递日志已登记的幂等键与承载键集（事实三的事实源）。outbox
 * （受理落盘）与 ack/discard（终局列）v2/v1 四类 entry 兼容读。
 *
 * collectKey 键集展开（单源统一裁决——原 bash 域副本只收条目 id、session-manager/
 * workflow 域副本带展开的分叉收敛）：主路径受理条目可按 collectKey 申报承载键
 * （条目 id ≠ 业务幂等键的承载形态——workflow 域裸 runId、session-manager 域合批
 * 成员键），只收 id 会漏「主路径成功受理」形态（误补投由 port 幂等预检吞并，多余
 * 但无害；判据侧直接补齐）。展开是 id 收集的无损超集：多命中方向 = 漏补投（保守，
 * 与「漏补投优于重复投」取向一致）；各域键词表不相交（bt- / run / managed notify
 * 键形态互斥），跨域展开无误命中面。
 *
 * 解析复用本包 journal 单点（readOutboxDataV2 / mapV1OutboxData / readAckId），
 * 宽容口径与 port scanJournal 一致：data 畸形按无条目——误判「无条目」的残余
 * 风险由 port 幂等预检承接（重投被 swallowed 吞并，无实害）。
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
