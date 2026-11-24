/**
 * T4（枝 rotation）：全 burnt 轮换重探 + 成功康复清 burn。
 *
 * 场景：单端点路由，fault-a 前 4 次请求 524（首发 + 3 重试 = 预算用尽 → burnt），
 * 第 5 次起恢复。
 * ① 第二轮：唯一候选已 burnt → 轮换重探（单端点退化为原样重探）→ 上游第 5 次请求成功；
 * ② 成功出站 → 终局观察清 burnt（端点康复，重新成为首选）；
 * ③ 第三轮：burnt 已清 → 正常按配置序选择 → 上游第 6 次请求成功。
 *
 * 锁「 burnt 只重排不删候选」与「单端点 ≡ 直连模型：每轮真试、错误真实呈现」两条语义。
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

const work = makeWorkDir("t4");
const server = await startFaultServer({
	"/a": [
		http524("probe-ray-t4-1"),
		http524("probe-ray-t4-2"),
		http524("probe-ray-t4-3"),
		http524("probe-ray-t4-4"),
		httpOk("RECOVERED-OK"),
		httpOk("RECOVERED-OK-2"),
	],
});
const agentDir = writeAgentDir(work, {
	routes: [{
		id: "route-single",
		name: "单端点",
		modelId: "route-single",
		enabled: true,
		mode: "advanced",
		members: [{ id: "m1", providerId: "fault-a", modelId: "fault-a-model", type: "none" }],
		specials: [],
	}],
	providerPaths: { "fault-a": `${server.baseUrl}/a` },
	settings: { retry: { baseDelayMs: 200 } },
});

let exitCode = 0;
try {
	const { events, sessionPath } = await runPiSession({
		agentDir,
		workDir: work,
		model: "aggregation/route-single",
		prompts: ["first prompt", "second prompt", "third prompt"],
	});

	const c = checker("T4 全 burnt 轮换重探 + 康复清 burn");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);

	// ① 第一轮 4 次（预算用尽）+ 第二轮重探成功（第 5 次）
	c.check(server.requests.length >= 5, `上游请求 ≥ 5（实际 ${server.requests.length}）`);
	const turn2 = assistants.filter(m => m.stopReason === "stop");
	c.check(turn2.length >= 2, `第 2/3 轮成功出站（实际成功消息 ${turn2.length} 条）`);
	c.check(JSON.stringify(turn2[turn2.length - 1]?.content ?? "").includes("RECOVERED-OK-2"), "第三轮出站内容来自恢复后的端点");

	// ②③ burnt 被成功观察清掉（最终 state 的 burnt 为空）
	const stateEntries = virtualModelStateEntries(entries);
	const lastBurnt = stateEntries.length > 0 ? (stateEntries[stateEntries.length - 1]?.data?.state?.burnt ?? null) : null;
	c.check(lastBurnt !== null && lastBurnt.length === 0, `最终 burnt 已清空（实际 ${JSON.stringify(lastBurnt)}）`);
	c.check(eventsOfType(events, "agent_settled").length === 3, "三轮各自 settle");
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T4 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
