/**
 * 事件 4: session_start（状态重建）。
 *
 * 调 reconstructGoalState 重建持久化状态 + updateWidget。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { updateWidget } from "../../projection/widget";
import type { GoalSession } from "../../session";
import { reconstructGoalState } from "../../session";
import { buildPorts } from "../ports";

export async function handleSessionStart(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	const ports = buildPorts(pi, ctx);
	reconstructGoalState(session, ports.session);
	if (session.state) {
		updateWidget(session, ports.ui);
	}
}
