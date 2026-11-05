/**
 * defer 通知去重 — 纯函数（chat-domain-v1x W5 拆解后的存活部分）
 *
 * 零 Pi 依赖（engine 层契约）。所有判定输入由调用方（agent-end）采集传入。
 */

// ── defer 通知去重 ───────────────────────────────────

/**
 * 活跃 pending 集合是否发生变化（顺序无关）。
 *
 * defer 分支的用户通知只在「集合变化或首次进入 defer」时发——事故中每轮 agent_end
 * 都 notify「Goal waiting for N task(s)」，pending 集合不变时是纯噪音。
 */
export function pendingSetChanged(current: readonly string[], last: readonly string[]): boolean {
	if (current.length !== last.length) return true;
	const lastSet = new Set(last);
	return current.some((id) => !lastSet.has(id));
}
