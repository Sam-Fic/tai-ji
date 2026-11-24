/**
 * T2（trunk）：failover 端到端 + router state 持久化。
 *
 * 场景：双端点路由 [fault-a, fault-b]，fault-a 持续 524，fault-b 正常。
 * ① 第一轮：fault-a 上用尽 pi 重试预算（4 次上游请求），终局真实 524 错误；
 * ② 第二轮（新 user 请求）：终局观察发现「物理结局 error + 链内失败计数 3 ≥ maxRetries 3」
 *    → burnt fault-a → failover 到 fault-b，正常出站；
 * ③ 会话落 pi.virtual-model-state 条目，burnt 含 fault-a/fault-a-model（跨轮次持久化）。
 */

import {
	assistantMessages,
	checker,
	cleanup,
	eventsOfType,
	http524,
	httpOk,
	makeWorkDir,
	readSessionEntries,
	runPiSession,
	startFaultServer,
	virtualModelStateEntries,
	writeAgentDir,
} from "./lib/harness.mjs";

const work = makeWorkDir("t2");
const server = await startFaultServer({
	"/a": Array.from({ length: 8 }, () => http524("probe-ray-t2")),
	"/b": [httpOk("FAILOVER-OK-B")],
});
const agentDir = writeAgentDir(work, {
	routes: [{
		id: "route-dual",
		name: "双端点",
		modelId: "route-dual",
		enabled: true,
		mode: "advanced",
		members: [
			{ id: "m1", providerId: "fault-a", modelId: "fault-a-model", type: "none" },
			{ id: "m2", providerId: "fault-b", modelId: "fault-b-model", type: "none" },
		],
		specials: [],
	}],
	providerPaths: { "fault-a": `${server.baseUrl}/a`, "fault-b": `${server.baseUrl}/b` },
	settings: { retry: { baseDelayMs: 200 } },
});

let exitCode = 0;
try {
	const { events, sessionPath } = await runPiSession({
		agentDir,
		workDir: work,
		model: "aggregation/route-dual",
		prompts: ["first prompt", "second prompt"],
	});

	const c = checker("T2 failover 端到端 + state 持久化");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);

	// ① 第一轮：fault-a 用尽预算（4 次请求），fault-b 未被触碰
	const requestsA = server.requests.filter(r => r.path.startsWith("/a/")).length;
	const requestsB = server.requests.filter(r => r.path.startsWith("/b/")).length;
	c.check(requestsA === 4, `第一轮 fault-a 上游请求 = 4（预算用尽；实际 ${requestsA}）`);

	// ② 第二轮：failover 到 fault-b 且成功出站
	c.check(requestsB === 1, `第二轮 fault-b 上游请求 = 1（failover 生效；实际 ${requestsB}）`);
	const last = assistants[assistants.length - 1];
	c.check(last?.stopReason === "stop", `第二轮终局 stopReason=stop（实际 ${last?.stopReason}）`);
	c.check(last?.provider === "fault-b", `第二轮出站 provider=fault-b（实际 ${last?.provider}）`);
	c.check(JSON.stringify(last?.content ?? "").includes("FAILOVER-OK-B"), "第二轮出站内容来自 fault-b");
	c.check(eventsOfType(events, "agent_settled").length === 2, "两轮各自 settle");

	// ③ burnt 持久化：会话落 virtual-model-state 条目
	const stateEntries = virtualModelStateEntries(entries);
	c.check(stateEntries.length >= 1, `会话含 pi.virtual-model-state 条目（实际 ${stateEntries.length}）`);
	// 引用相等纪律（pi 落盘条件 route.state !== state）：burnt 无变化的求值不得重复落条目——
	// 本剧本只有一次 burn 事件，条目数上界 1（重复 append = 引用纪律回归）
	c.check(stateEntries.length <= 1, `state 条目不重复（实际 ${stateEntries.length}）`);
	const lastState = stateEntries[stateEntries.length - 1];
	const burnt = lastState?.data?.state?.burnt ?? [];
	c.check(Array.isArray(burnt) && burnt.includes("fault-a/fault-a-model"), `burnt 含 fault-a/fault-a-model（实际 ${JSON.stringify(burnt)}）`);
	c.note(`state 条目：${JSON.stringify(stateEntries.map(e => e.data?.state))}`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T2 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
