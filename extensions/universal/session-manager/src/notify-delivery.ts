// src/notify-delivery.ts — managed session 死亡通知的投递接入（unified-delivery 波 2：
// 投递路径切 pi 半区投递端口，getDeliveryPort 进程级槽消费，C-ext-06）。
//
// 投递形态（老能力映射 #6）：watch 上游不变，recordManagedNotify 投递路径切
// port.deliver（managed-session-notify 外部通道逐条不合批——port 批组隔离原生
// 承载，合批已在 watch-coordinator 微窗内重建批身份，D3 裁决4）。port 恒装配于
// base-tool-enhance session_start（P6 infrastructure 档必载），本域零装配义务
//（通知账本装配随波 2 账本退役删除——两套装配并存违背装配单一归属，§3.7）。
//
// 槽空降级（port 缺席：base-tool-enhance session_start 未跑 / bind 失败——装配异常
// 窗口，生产不可达常态）：warn 留痕 + false（STANDARDS §11.1 通知类接入点降级，
// 非静默吞）。缺席回退不建第二投递路径（unified-delivery §3.7：两套装配并存违背
// 装配单一归属——notifier 直发兜底属 notifier 自身形态，本域降级 = 放弃该条 +
// warn 修复信号）。
//
// rejected 处置阶梯（completion-signal-delivery D1/D8①，ADR-0122⑧ 边界精确化）：
// rejected（幂等键未登记、投递日志未落，重放结构性无从覆盖）不再等于丢失——
// 瞬态成因（disposed / persist 瞬断）当场 getDeliveryPort() 重取当前实例单次重提
// 原 envelope（一次投递尝试的同步收尾动作，非重试循环非定时器——ADR-0122 红线
// 不越界，RL10 同锁：重提 rejected 或重取缺席即停，无第三次投递、无定时器句柄）；
// 重提仍失败恢复责任移交对账边沿的事实判据兜底（notify-reconcile 三入口编排，
// warn 文案带 recovered 指引——RL9/RL11 同族）。

import { getDeliveryPort } from "@zhushanwen/pi-delivery-port";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

import {
	MANAGED_SESSION_NOTIFY_CUSTOM_TYPE,
	type ManagedNotifyDetails,
} from "./notify-content.ts";

const logger = getLogger("session-manager");

/** port.deliver 单次调用的受理裁决（主投与单次重提共用同一收尾语义）。 */
type DeliverOutcome =
	| { kind: "accepted" }
	| { kind: "swallowed" }
	| { kind: "failed"; reason: string }
	| { kind: "port-absent" };

/**
 * 单次投递（主投与重提共用的投递管道）：deliver rejected / 写入异常 / port 缺席
 * 三类失败收敛为 failed（reason 透传）——重提链据此裁决停止位。
 */
function deliverOnce(
	notifyId: string,
	content: string,
	details: ManagedNotifyDetails,
	collectKeys: string[],
): DeliverOutcome {
	const port = getDeliveryPort();
	if (!port) {
		return { kind: "port-absent" };
	}
	try {
		const result = port.deliver(
			{
				payload: {
					kind: "custom",
					customType: MANAGED_SESSION_NOTIFY_CUSTOM_TYPE,
					content,
					display: true,
					details,
				},
				id: notifyId,
			},
			{ collectKey: collectKeys },
		);
		if (result.kind === "rejected") {
			return { kind: "failed", reason: result.reason };
		}
		return { kind: result.kind };
	} catch (err) {
		// 写入异常（stale ctx / appendEntry 失败）按接入点降级：不拖垮 watch 应答编排
		//（unregister 照常），warn 留痕可归因
		logger.warn("[session-manager] notify delivery failed", {
			notifyId,
			error: toErrorMessage(err),
		});
		return { kind: "failed", reason: toErrorMessage(err) };
	}
}

/**
 * 投递一条死亡通知（unified-delivery 波 2：port.deliver 主投——managed-session-notify
 * 外部通道逐条不合批）。
 *
 * collectKeys（result-collect 设计 §3.4 managed 行）：批内全部债权键集申报——合批
 * 条目载荷幂等键 = 批首债权键，其余成员仅注销 pending 无独立日志条目，单值申报下
 * collect 无法按非首键定位载荷；键集申报经端口逐键展开（命中 = 等待集 ∩ 条目键集
 * ≠ ∅）。必传：批恒至少一条应答，无键集的 deliver 在本域 = collect 永远等不到，
 * 属调用方缺陷，构造性防漏（编译期拦截）。
 *
 * port 缺席 → warn + false（降级登记，见文件头）。deliver swallowed = 幂等命中
 * （同 notifyId 已受理或已终局——重放/重复应答的重复提交），按已投递返回 true；
 * deliver rejected（disposed / persist-failed 等）→ 处置阶梯①接线（D8①）：立即
 * getDeliveryPort() 重取单次重提原 envelope（同幂等键——rejected 条目幂等键未
 * 登记，重提合法），重提 accepted/swallowed 按已投递返回 true，重提仍 rejected
 * 或重取缺席即停 + warn 恢复指引（恢复通道 = 对账边沿事实判据，notify-reconcile）。
 */
export function recordManagedNotify(
	notifyId: string,
	content: string,
	details: ManagedNotifyDetails,
	collectKeys: string[],
): boolean {
	const outcome = deliverOnce(notifyId, content, details, collectKeys);
	if (outcome.kind === "accepted" || outcome.kind === "swallowed") {
		return true;
	}
	if (outcome.kind === "port-absent") {
		logger.warn(
			"[session-manager] delivery port not bound — notification dropped (base-tool-enhance session_start 装配缺失；下次 session_start 重试装配)",
			{ notifyId },
		);
		return false;
	}
	// rejected（幂等键未登记）：首败留痕（修复信号）+ 处置阶梯①接线。
	logger.warn(
		"[session-manager] delivery port rejected notification; retrying once via re-acquired port, recovered by reconcile fallback if the retry fails too (idempotency key not registered)",
		{ notifyId, reason: outcome.reason },
	);
	return retryManagedNotifyOnce(notifyId, content, details, collectKeys);
}

/**
 * 立即单次重提（D8①，与 bash 域 retryDeliverOnce 同款单次形态——RL10 同锁）：
 * getDeliveryPort() 重取当前实例（session_start 重绑后即新实例）、重提原 envelope
 * （同幂等键同 collectKey 申报）。单次不循环：重提 rejected 或重取 undefined 均
 * 直接停止（RL10 的两处停止位），无定时器、无重试队列、无第三次投递；重取缺席
 * 不扩直发降级（缺席直发只属主路径缺席形态），恢复通道 = 对账边沿事实判据。
 */
function retryManagedNotifyOnce(
	notifyId: string,
	content: string,
	details: ManagedNotifyDetails,
	collectKeys: string[],
): boolean {
	const retryOutcome = deliverOnce(notifyId, content, details, collectKeys);
	if (retryOutcome.kind === "accepted" || retryOutcome.kind === "swallowed") {
		logger.debug("[session-manager] notify retry accepted via re-acquired port", { notifyId });
		return true;
	}
	if (retryOutcome.kind === "port-absent") {
		logger.warn(
			"[session-manager] notify retry skipped: delivery port absent on re-acquire; recovered by reconcile fallback",
			{ notifyId },
		);
		return false;
	}
	// 单次重提仍 rejected（转换窗旧实例在位 / 持久写失败）：即停报警（RL11——
	// 持久成因不静默重试，warn 留痕交环境修复；环境修复后的送达由对账边沿的
	// 事实判据自动承接，判据不区分成因）。
	logger.warn(
		"[session-manager] notify retry rejected after the single re-acquire attempt; single retry spent, recovered by reconcile fallback (session_start / agent_settled edge)",
		{ notifyId, reason: retryOutcome.reason },
	);
	return false;
}
