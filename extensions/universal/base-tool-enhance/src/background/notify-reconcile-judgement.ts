/**
 * 对账补投判据的纯函数层（completion-signal-delivery 设计的共享语义落点）——
 * 无 I/O、无 pi 依赖。
 *
 * 职责一（既有）：collectDeliveredTaskIds 从会话 entries 提取送达痕迹集合（D3
 * 裁决 1 / 波 3 载体形态）。
 *
 * 职责二（本设计新增，D2/D7）：三重事实判据骨架 isReconcileNotifyCandidate 与
 * 投递日志幂等键提取 collectJournaledDeliveryIds——补投候选 = 任务/记录已终态 ∧
 * 送达痕迹未命中 ∧ 投递日志无该幂等键条目。骨架只消费调用方判定好的事实布尔
 * （终态与成因排除各域事实源不同：bash 域 = registry 条目；u3/u5 域 = record /
 * pending 表 / run journal——域内映射各自实现，骨架本体跨域单一），这是「判据
 * 语义单源」的载体形态：域侧新增候选时把事实映射进骨架，排除位语义随域参数化
 * （「主路径不发者排除」原理，D5 裁决同源），判据演化不产生第二套真值组合。
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

import {
	ACK_CUSTOM_TYPE,
	OUTBOX_CUSTOM_TYPE,
	V1_ACK_CUSTOM_TYPE,
	V1_OUTBOX_CUSTOM_TYPE,
	mapV1OutboxData,
	readAckId,
	readOutboxDataV2,
} from "@zhushanwen/pi-delivery-port";

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

// ─── 三重事实判据骨架（completion-signal-delivery D2；跨域共享语义，消费形态见文件头）───

/** 三重事实判据的输入（调用方在域内完成事实源映射后传入；骨架零 I/O）。 */
export interface ReconcileNotifyFacts {
	/** 事实一：任务/记录已终态（域事实源判定——bash 域 = registry 终态枚举成员）。 */
	isTerminal: boolean;
	/**
	 * 排除位（「主路径不发者排除」原理，D5 裁决同源）：主路径对该终态成因不发的
	 * 通知，补投无从恢复也不该发。bash 域 = killed（kill 发令方当次交互已同步
	 * 获知，notify.ts 单点归属规则）；u3 subagent 域 = cancelled 族 + workflow
	 * origin 整体排除两落位。真 = 非候选。
	 */
	excludedByOrigin: boolean;
	/** 事实二：送达痕迹命中（该键的完成通知消息已在会话 entries——collectDeliveredTaskIds 同源）。 */
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
 * 判据单一导出的骨架位（RL12 行为锁）：bash 域对账（pending-reconcile
 * isReapNotifyCandidate）与三边沿入口（session_start / 切回 / agent_settled）
 * 经同一函数消费；u3/u5 域侧映射各自事实源进 ReconcileNotifyFacts 复用同一
 * 真值组合——判据演化不产生第二套真值逻辑。
 */
export function isReconcileNotifyCandidate(facts: ReconcileNotifyFacts): boolean {
	return facts.isTerminal && !facts.excludedByOrigin && !facts.delivered && !facts.journaled;
}

/**
 * 从会话 entries 提取投递日志已登记的幂等键集合（事实三的事实源）。outbox
 * （受理落盘）与 ack/discard（终局列）v2/v1 四类 entry 兼容读——受理成功必有
 * outbox 条目（受理前落盘，append-only 契约），ack 无 outbox 结构性不可能；ack
 * 并入集合是同一次遍历内的防御性冗余分支。
 *
 * 解析复用 port 包单点（readOutboxDataV2 / mapV1OutboxData / readAckId），宽容
 * 口径与 port scanJournal 一致：data 畸形按无条目——误判「无条目」的残余风险由
 * port 幂等预检承接（重投被 swallowed 吞并，无实害；方向对齐送达痕迹判据的
 * 「漏补投优于重复投」保守取向）。
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
				if (record !== undefined) ids.add(record.id);
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
