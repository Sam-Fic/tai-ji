/**
 * 对账补投判据的送达痕迹提取（bash 域专属层）——无 I/O、无 pi 依赖。
 *
 * 本文件原是三重事实判据骨架的「跨域共享语义落点」（u1 抽出：骨架
 * isReconcileNotifyCandidate / ReconcileNotifyFacts / 投递日志幂等键提取
 * collectJournaledDeliveryIds 曾在此单源登记，session-manager / subagent-workflow
 * 两域按同构落位持物理副本、真值表测试逐行对拍锁定）。判据链已收编
 * @zhushanwen/pi-delivery-port（reconcile-judgement.ts / session-journal-read.ts
 * 单源，真值表测试随迁该包、域侧对拍的人工同步义务退役），骨架三件随迁，本文件
 * 只留 bash 域专属的送达痕迹提取——补投候选 = 任务已终态 ∧ 送达痕迹未命中 ∧
 * 投递日志无该幂等键条目，其中后两事实的事实源函数（痕迹提取在此、日志键提取在
 * port 包）与骨架真值组合（port 包 reconcile-judgement）按域侧调用组合。
 *
 * 职责：collectDeliveredTaskIds 从会话 entries 提取送达痕迹集合（D3 裁决 1 /
 * 波 3 载体形态；completion-signal-delivery D2/D7 的送达痕迹判据事实源）。
 *
 * 投递统一化设计的现行登记处 = ADR-0074 与 docs/CONTEXT.md「统一投递」段。
 *
 * collectDeliveredTaskIds：从会话 entries 提取「已送达完成通知的 taskId 集合」。
 * 送达痕迹 = 会话文件里的完成通知消息本身（custom_message，customType =
 * background-bash）——主路径经 port.deliver 注入落盘的形态（波 3 前直发/补投的历史
 * 消息同形态，判据通吃）；fork 副本随 session 文件复制同形态带走，天然命中。
 * 判定通道两条，任一命中即算：details.taskId（结构化字段）/ content 文本含
 * bt- 形态 token（缺 details 的旧消息——details 载荷是后加的，历史消息只有 content）。
 *
 * 非目标（防回潮）：补投幂等不在此处承载——防双投由 port 幂等体系接管（deliver
 * 幂等预检 + 内核三级判重 + outbox/ack 终态列，见 pending-reconcile.ts 文件头）；
 * 本函数只回答「这个任务的通知是否已经出现在会话里」。
 */

import { BACKGROUND_BASH_CUSTOM_TYPE } from "./notify.ts";

/**
 * content 中 bt- 形态 taskId 的提取模式（spawn-background generateTaskId 生成规则：
 * bt-<epoch ms>-<base36 固定长随机段>）。按生成形态锚定而非任意 bt- 前缀串，避免把
 * 普通英文词（如 "btw-"）误判为任务 id。设计原文「content 含 taskId」的宽松语义：
 * 尾部输出摘要里如出现其他任务 id 也会算送达痕迹——方向保守（漏补投优于重复投）。
 */
const CONTENT_TASK_ID_PATTERN = /\bbt-\d+-[0-9a-z]+\b/g;

/**
 * 从会话 entries 提取已送达完成通知的 taskId 集合。
 *
 * 五形态语义：正常消息（details + content 双通道命中）、fork 副本（同形态命中）、
 * 缺 details 旧消息（仅 content 命中）、非 bash 通知（customType 不同，不命中）、
 * killed 无痕迹任务（无消息 entry，天然不在集合）。
 *
 * 容错对齐 protocol pending-entries 扫描同款纪律：null/非对象元素跳过；content 兼容
 * string 与 TextContent[] 两种落盘形态（pi appendCustomMessageEntry 接受两者）。
 */
export function collectDeliveredTaskIds(entries: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry.customType !== BACKGROUND_BASH_CUSTOM_TYPE) continue;
		const taskId = stringField(entry.details, "taskId");
		if (taskId !== undefined) ids.add(taskId);
		const content = entry.content;
		if (typeof content === "string") {
			collectTaskIdsFromText(content, ids);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				const text = stringField(block, "text");
				if (text !== undefined) collectTaskIdsFromText(text, ids);
			}
		}
	}
	return ids;
}

/** unknown 值上指定键的 string 字段（非对象/缺键/非字符串一律 undefined）。 */
function stringField(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

function collectTaskIdsFromText(text: string, ids: Set<string>): void {
	for (const match of text.matchAll(CONTENT_TASK_ID_PATTERN)) {
		ids.add(match[0]);
	}
}
