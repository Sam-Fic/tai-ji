/**
 * T5（枝 budget-read）：重试预算从 settings 读，非硬编码。
 *
 * 场景：settings.retry.maxRetries = 1（压缩退避），双端点路由 [fault-a, fault-b]，
 * fault-a 持续 524。
 * ① 第一轮：只重试 1 次（上游 2 次请求），auto_retry_start × 1 且 maxAttempts = 1；
 * ② 第二轮：链内计数 1 ≥ maxRetries 1 → burnt → failover 到 fault-b 成功。
 *
 * 证明「预算用尽」的尺来自 pi.getSettings().retry.maxRetries 实读（改配置即改行为），
 * 不是写死 3。
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
	writeAgentDir,
} from "./lib/harness.mjs";

const work = makeWorkDir("t5");
const server = await startFaultServer({
	"/a": Array.from({ length: 8 }, () => http524("probe-ray-t5")),
	"/b": [httpOk("BUDGET-OK-B")],
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
	settings: { retry: { maxRetries: 1, baseDelayMs: 100 } },
});

let exitCode = 0;
try {
	const { events, sessionPath } = await runPiSession({
		agentDir,
		workDir: work,
		model: "aggregation/route-dual",
		prompts: ["first prompt", "second prompt"],
	});

	const c = checker("T5 预算从 settings 实读");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);

	// ① 只重试 1 次：2 次上游请求，maxAttempts = 1
	const requestsA = server.requests.filter(r => r.path.startsWith("/a/")).length;
	c.check(requestsA === 2, `第一轮 fault-a 请求 = 2（maxRetries=1；实际 ${requestsA}）`);
	const starts = eventsOfType(events, "auto_retry_start");
	c.check(starts.length === 1, `auto_retry_start × 1（实际 ${starts.length}）`);
	c.check(starts[0]?.maxAttempts === 1, `maxAttempts = 1（实际 ${starts[0]?.maxAttempts}）`);

	// ② 计数 1 ≥ 预算 1 → burnt → failover
	const requestsB = server.requests.filter(r => r.path.startsWith("/b/")).length;
	c.check(requestsB === 1, `第二轮 failover 到 fault-b（实际 /b 请求 ${requestsB}）`);
	const last = assistants[assistants.length - 1];
	c.check(last?.stopReason === "stop" && last?.provider === "fault-b", `第二轮成功出站自 fault-b（实际 ${last?.provider}/${last?.stopReason}）`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T5 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
