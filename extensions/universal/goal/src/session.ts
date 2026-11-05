/**
 * Session 层 — 运行时句柄 + 状态重建（entry 不做 GC，只读最新一条）
 *
 * GoalSession 是进程内瞬态句柄（不持久化）。
 * reconstructGoalState 从 entry 恢复状态（session_start / session_tree 时调，
 * U6c：重建输入接活跃路径裁剪——被撤子树的 goal-state 不进重建态）。
 *
 * FR-6.4: 删除 hasPendingInjection（僵尸字段）
 * FR-6.7: 删除 pendingPause（ESC 改用 aborted 检查）
 * FR-8.1 G-006: session append-only——entry GC 不生效（生产），history 显示侧截断
 * FR-3: 崩溃后保持原状态（active 重启计时；paused/blocked 保持；终态保持）
 */

import { filterActivePath } from "@zhushanwen/pi-session-path";

import type { GoalRuntimeState } from "./engine/types";
import { deserializeState, ENTRY_TYPE } from "./persistence";
import type { SessionEntryLike, UiPort } from "./ports";

// ── 运行时句柄 ────────────────────────────────────────

export interface GoalSession {
	state: GoalRuntimeState | null;
	/** 防重入标志：agent_end / before_agent_start 等事件处理器入口检查 */
	isProcessing: boolean;
}

export function createGoalSession(): GoalSession {
	return {
		state: null,
		isProcessing: false,
	};
}

// ── Stale Context 检测（FR-8.2 G-010）─────────────────
// [REMOVED W4] 原实现导出 STALE_CONTEXT_PATTERNS + isStaleContextError，双重废：
// ① 无生产调用方（仅测试引用）——goal 的 appendEntry/sendMessage 调用点均在 pi
//   event handler 内，pi runner 对 handler 错误有隔离，无「捕获后分诊 stale」的场景；
// ② patterns 与 pi 0.84.1 真实 stale 文案零匹配（"This extension ctx is stale
//   after session replacement..."，runner.js:352——"stale context" ≠ "ctx is stale"）。
// 复用价值场景请参照 scheduler 的已验证方案：runtime.ts STALE_CTX_MARKER
// 'stale after session replacement'（子串匹配真实文案）+ 代际计数治本（G1）。

// ── 活跃路径裁剪（U6c）────────────────────────────────

/**
 * 活跃路径回溯所需的最小 session 视图（U6c）。getLeafId 可选：SessionPort
 * （buildPorts 产物）不携带时按文件尾回退——session_start 时点 pi 树重放规则
 * （叶子 = 文件最后一条 entry）使两锚等价；session_tree handler 传
 * ctx.sessionManager（含 getLeafId），覆盖运行中树回退后 leaf ≠ 文件尾的形态。
 */
export interface ActivePathSessionView {
	getEntries(): SessionEntryLike[];
	getLeafId?(): string | null;
}

// 活跃路径裁剪（leafId 沿 parentId 回溯，撤回后被撤子树的 goal-state entry 不进
// 重建输入）收敛于 @zhushanwen/pi-session-path 单一实现（四包同构副本收编，防御
// 语义与回退口径见该包 filterActivePath 注释；runtime 侧 entry-tree-builder 保持
// 独立——extension 不能 import runtime 包）。

// ── reconstructGoalState（session_start / session_tree 时调）──────────

/**
 * 从 session entries 恢复 goal state（U6c：重建输入 = 活跃路径派生视图，非全文件）。
 *
 * Pi SDK 的 session 是 append-only，getEntries() 返回 filter-copy——splice
 * 无法修改真实 entries。Entry GC（goal-state 留 1、goal-history 留 20）在生产
 * 不生效：本函数只读最新一条 goal-state，不删旧 entry；history 显示侧用
 * .slice(-MAX_HISTORY_ENTRIES) 截断（handleHistory）。长期需 compaction API。
 * FR-3: 崩溃后状态保持原状——active 重启计时（timeStartedAt = now），
 *   paused/blocked 保持（用户/agent 主动叫停不被抹除），终态保持。
 * FR-8.1 G-024: deserialize throw → state=null（部分损坏全丢）
 */
export function reconstructGoalState(session: GoalSession, sessionPort: ActivePathSessionView): void {
	session.state = null;
	const entries = filterActivePath(sessionPort);

	// 找到最新的 goal-state entry（活跃路径内从后往前）
	let latestStateIdx = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (isGoalStateEntry(entries[i]!)) {
			latestStateIdx = i;
			break;
		}
	}

	if (latestStateIdx >= 0) {
		const data = entries[latestStateIdx]!.data as Record<string, unknown> | undefined;
		if (data) {
			try {
				session.state = deserializeState(data);
			} catch {
				// FR-8.1 G-024: 部分损坏全丢
				session.state = null;
			}
		}
	}

	// FR-8.1 G-006: session append-only，splice GC 在生产不生效（见上方函数注释）。
	// 不在此处删旧 entry；history 显示侧截断。

	if (!session.state) return;

	// FR-3: 崩溃后状态保持。
	// - active：重启计时（timeStartedAt = now，开启新运行段）
	// - paused/blocked：保持原状（对称设计——用户/agent 主动叫停的状态不被崩溃抹除）
	// - 终态：保持终态（不会被强制激活）
	if (session.state.status === "active") {
		session.state.timeStartedAt = Date.now();
	}
}

function isGoalStateEntry(entry: SessionEntryLike): boolean {
	return entry.type === "custom" && entry.customType === ENTRY_TYPE;
}

// ── clearGoalSession ──────────────────────────────────

export function clearGoalSession(session: GoalSession, uiPort: UiPort): void {
	session.state = null;
	session.isProcessing = false;
	// FR-6.6: hasUI 检查
	if (uiPort.hasUI) {
		uiPort.setWidget("goal", undefined);
		uiPort.setStatus("goal", undefined);
	}
}
