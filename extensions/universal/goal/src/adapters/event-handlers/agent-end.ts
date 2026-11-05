/**
 * 事件 6: agent_end（FR-8.7 + ESC 检查 + 并发保护）。
 *
 * 关键约定：
 * - FR-8.2 G-021 防重入：session.isProcessing 入口加锁，finally 释放
 * - FR-8.2 G-020 stale 快照：入口 makeStaleChecker snapshot goalId，每个副作用前 checkStale
 * - FR-6.7 ESC 检查（最关键）：ctx.signal?.aborted → 不发 continuation、不做 budget 检查、
 *   不做任何状态变更，goal 保持 active，等用户下次输入恢复
 *
 * #8 后流程：budget 预警/steering → continuation（空 turn 去抖 + pending defer +
 * defer 通知去重）。agent_end 只做提醒（warning + steering），不做终态转换。
 * 终态转换不在 agent_end——由 persistAndUpdate 兜底（#5 范围，单一检查点）。
 *
 * continuation 发送形态（有意决策）：仅在 agent_end 时刻立即发送——无退避定时器、
 * 无连发封顶（时间/计数判死机制已删）。空 turn（tokenDelta≤0）与 pending defer
 * 轮不发，循环由此自然停止。
 *
 * 全解耦：不再做 allTasksDone followUp（原依赖 pi.__todoGetList，跨 ext 失效）。
 * todo 是否全完成由 AI 自行判断（prompt 软建议）。
 *
 * ESC 路径：aborted 时直接 return（goal 保持 active）。注意 ESC 检查在终态/非 active
 * 检查之后——终态 goal 仍走终态 notify（不被 ESC 影响），非 active 状态直接返回。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { countActiveFromEntries } from "@zhushanwen/pi-pending-notifications";

import { checkBudgetOnTurnEnd } from "../../engine/budget";
import { isActiveStatus, isTerminalStatus } from "../../engine/goal";
import { pendingSetChanged } from "../../engine/liveness";
import {
	budgetLimitPrompt,
	continuationPrompt,
} from "../../projection/prompts";
import { persistAndUpdate, tickState } from "../../service";
import type { ServicePorts } from "../../service";
import { buildPorts } from "../ports";
import type { GoalSession } from "../../session";

export async function handleAgentEnd(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	if (!session.state || session.isProcessing) return;
	session.isProcessing = true;
	try {
		const checkStale = makeStaleChecker(session);
		if (checkStale()) return;
		const ports = buildPorts(pi, ctx);

		// 终态处理（complete / blocked）
		if (session.state.status === "complete" || session.state.status === "blocked") {
			await handleTerminalStateAgentEnd(session, ports, ctx, checkStale);
			return;
		}
		if (!isActiveStatus(session.state.status)) return;

		// FR-6.7 ESC 检查（最关键）：aborted 时 goal 保持 active，不做任何副作用
		if (ctx.signal?.aborted) {
			return;
		}

		// 预算检查（仅 token 维度）——先 tick 把当前运行段计入 timeUsedSeconds，
		// 否则累计耗时（timeUsedSeconds）记账会比实际晚一轮（回归修复）
		tickState(session.state);
		const budgetResult = checkBudgetOnTurnEnd(session.state);
		const budgetAction = await handleBudgetChecks(ports, session, ctx, budgetResult, checkStale);
		if (budgetAction !== "continue") return;

		// continuation（budget 预警未拦截时）
		await handleContinuation(pi, ports, session, ctx, checkStale);
	} finally {
		session.isProcessing = false;
	}
}

/** 终态 agent_end：persist + notify（complete/blocked 各一条消息）。 */
async function handleTerminalStateAgentEnd(
	session: GoalSession,
	ports: ServicePorts,
	ctx: ExtensionContext,
	checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (persistAndUpdate(session, ports, checkStale)) return;
	if (state.status === "complete") {
		ctx.ui.notify(`Objective completed ✓ (${state.currentTurnIndex} turns)`, "info");
	} else {
		ctx.ui.notify(
			"Goal blocked. Use /goal resume to continue or /goal clear to reset.",
			"warning",
		);
	}
}

type BudgetAction = "continue" | "stop";

/**
 * 仅 token 维度预算检查（#8 后只做提醒，不做终态）：
 * - 预警（warning70/warning90）：set flag + notify（不阻塞 continuation）
 * - 90% steering（shouldSendSteering）：set flag + 发 budgetLimitPrompt（收尾），返回 "stop" 中断 continuation
 *
 * 终态转换（budget 耗尽）不在 agent_end，由 persistAndUpdate 兜底（#5 范围，单一检查点）。
 */
async function handleBudgetChecks(
	ports: ServicePorts,
	session: GoalSession,
	ctx: ExtensionContext,
	budgetResult: ReturnType<typeof checkBudgetOnTurnEnd>,
	checkStale: () => boolean,
): Promise<BudgetAction> {
	const state = session.state!;

	// 发送预警（仅 token 维度）
	for (const w of budgetResult.warnings) {
		if (w.type === "warning90") {
			state.tokenWarning90Sent = true;
			ctx.ui.notify("Token budget 90% used — start wrapping up.", "warning");
		} else if (w.type === "warning70") {
			state.tokenWarning70Sent = true;
			ctx.ui.notify("Token budget 70% used — keep scope in check.", "info");
		}
	}

	// 90% steering → 收尾
	if (budgetResult.shouldSendSteering) {
		state.budgetLimitSteeringSent = true;
		if (persistAndUpdate(session, ports, checkStale)) return "stop";
		ports.messaging.sendContextMessage(
			budgetLimitPrompt(state),
			"steer",
		);
		return "stop";
	}

	if (checkStale()) return "stop";
	return "continue";
}

/**
 * continuation 尾部逻辑（budget 预警未拦截时）。
 *
 * - 空 turn 去抖：tokenDelta≤0（空 turn）不发，只 persist
 * - pending 检查：有活跃 background subagent/workflow 时不发 continuation。
 *   靠 subagent/workflow 完成时 sendMessage({triggerTurn:true}，缺省 deliverAs 即 steer) 自然唤醒主 agent；
 *   goal 抢先催会与异步任务完成通知叠加，形成“停不下来”的死循环——continuation 排入
 *   _followUpMessages 队列 → _handlePostAgentRun 的 hasQueuedMessages() 返回 true → agent.continue()
 *   新 turn → 又 agent_end → 又 continuation。
 *   刻意不校验 expiresAt：长任务 subagent（>1h TTL）完成时仍 triggerTurn 唤醒主 agent，
 *   按 TTL 判非活跃会让死循环在长任务场景复现。
 * - defer 通知去重：pending 集合不变的连续 defer 轮不重复 notify。
 *
 * 注：终态转换由 persistAndUpdate 兜底（#5 范围，单一检查点）。
 */
async function handleContinuation(
	pi: ExtensionAPI,
	ports: ServicePorts,
	session: GoalSession,
	ctx: ExtensionContext,
	checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (checkStale()) return;

	const entries = ctx.sessionManager.getEntries();

	// FR-8.6: 空 turn 去抖（tokenDelta≤0 不发）
	const tokenDelta = state.tokensUsed - state.lastTurnTokensUsed;
	state.lastTurnTokensUsed = state.tokensUsed;

	// pending 检查：有活跃 background subagent/workflow 时不发 continuation。
	// [W4 读侧过滤①消费口] 传当前 session 基准：fork 继承的父级注册残留不进差集
	// （检查不幻 defer）；设计 D4「读侧过滤一刀」在本消费口的落地（W6 探针实测
	// registry-fork-filter.test.ts 证不传则虚增，A9② 验收标准）。
	const pendingOps = countActiveFromEntries(entries, {
		currentSessionId: ctx.sessionManager.getSessionId(),
	});
	let deferred = false;
	if (pendingOps.count > 0) {
		deferred = true;
		pi.appendEntry("goal:log", {
			timestamp: Date.now(),
			level: "debug",
			component: "goal:agent-end",
			message: `continuation deferred: ${pendingOps.count} active pending operation(s)`,
			data: { activePending: pendingOps.count, ids: pendingOps.ids },
		});
		// defer 通知去重：状态变化（pending 集合变化或首次进入 defer）才 notify——
		// 事故中每轮 agent_end 都发「Goal waiting for N…」，集合不变时是纯噪音。
		// 用户可见反馈保留：deferred 无反馈时用户只看到 goal active 但无产出，
		// 无法区分等待 vs 死循环。
		if (pendingSetChanged(pendingOps.ids, state.lastDeferredPendingIds)) {
			ctx.ui.notify(
				`Goal waiting for ${pendingOps.count} background task(s) to complete.`,
				"info",
			);
			state.lastDeferredPendingIds = [...pendingOps.ids].sort();
		}
	} else {
		// 非 defer 轮清空去重锚：每个等待 episode 的首次 defer 都会通知一次
		state.lastDeferredPendingIds = [];
	}

	// 单次 persist（H2 合并）：defer 去重锚（lastDeferredPendingIds）随同一快照落盘。
	// budget 终态检查点在 persistAndUpdate 内部（#5 单一检查点），与调用位置无关。
	persistAndUpdate(session, ports);
	if (deferred) {
		// defer 轮：已 persist + 已去重通知，不发 continuation
		return;
	}
	if (tokenDelta <= 0) {
		// 空 turn：已 persist，不发 continuation
		return;
	}
	// 终态检查：persistAndUpdate 可能把 goal 转为 budget_limited 终态。
	// 此时不应发 continuation（deliverAs:"followUp" 会触发新 turn，让已耗尽预算的 agent 再跑一轮）。
	if (isTerminalStatus(state.status)) return;

	// 立即发出 continuation（无退避、无封顶——发送决策只看本轮事实：
	// 非 defer、非空 turn、非终态）
	ports.messaging.sendContextMessage(continuationPrompt(state), "followUp");
}

/**
 * 构造 stale-check 闭包（FR-8.2 G-020）：入口快照 goalId，后续判断是否被新 goal 覆盖。
 *
 * 用法（agent_end）：
 * ```ts
 * const checkStale = makeStaleChecker(session);
 * // ... 长流程 ...
 * if (checkStale()) return; // goal 被覆盖，本次 agent_end 作废
 * ```
 *
 * 语义：snapshot 时 session.state 可能为 null（首次启动），此时 snapshotGoalId
 * 为 undefined；后续若有新 goal（goalId !== undefined）即视为 stale。
 */
export function makeStaleChecker(session: GoalSession): () => boolean {
	const snapshotGoalId = session.state?.goalId;
	return () => !session.state || session.state.goalId !== snapshotGoalId;
}
