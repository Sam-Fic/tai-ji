/**
 * T8（枝 failover-edges）：重试停用（retry.enabled=false）→ 终局 error 即 burnt，
 * failover 即时生效（设计文档 §3.6 行为后果的实机锁定）。
 *
 * 场景：settings.retry.enabled=false，双端点路由 [fault-a, fault-b]，fault-a 持续 524。
 * ① 第一轮：pi 不重试（零 auto_retry 事件），1 次上游请求后终局真实 524；
 * ② 第二轮：预算读为 0（停用 = 零次重试）→ 终局 error + 计数 0 ≥ 0 → burnt →
 *    failover 到 fault-b 成功出站。
 *
 * 锁「pi 的重试预算」对「停用」形态的口径：enabled=false 时预算 = 0，而非无限期不 failover。
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

const work = makeWorkDir("t8");
const server = await startFaultServer({
	"/a": Array.from({ length: 8 }, () => http524("probe-ray-t8")),
	"/b": [httpOk("DISABLED-RETRY-OK-B")],
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
	settings: { retry: { enabled: false } },
});

let exitCode = 0;
try {
	const { events, sessionPath } = await runPiSession({
		agentDir,
		workDir: work,
		model: "aggregation/route-dual",
		prompts: ["first prompt", "second prompt"],
	});

	const c = checker("T8 重试停用 → 即时 failover");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);

	// ① pi 零重试
	c.check(eventsOfType(events, "auto_retry_start").length === 0, "零 auto_retry_start（retry 停用）");
	const requestsA = server.requests.filter(r => r.path.startsWith("/a/")).length;
	c.check(requestsA === 1, `fault-a 仅 1 次请求（未重试；实际 ${requestsA}）`);
	const first = assistants.find(m => m.stopReason === "error");
	c.check((first?.errorMessage ?? "").includes("524"), "终局错误是真实 524");

	// ② 预算 0 → 即时 burnt → failover
	const requestsB = server.requests.filter(r => r.path.startsWith("/b/")).length;
	c.check(requestsB === 1, `第二轮 failover 到 fault-b（实际 /b 请求 ${requestsB}）`);
	const last = assistants[assistants.length - 1];
	c.check(last?.stopReason === "stop" && last?.provider === "fault-b", `第二轮成功出站自 fault-b（实际 ${last?.provider}/${last?.stopReason}）`);
	const stateEntries = virtualModelStateEntries(entries);
	const burnt = stateEntries.length > 0 ? (stateEntries[stateEntries.length - 1]?.data?.state?.burnt ?? []) : [];
	c.check(burnt.includes("fault-a/fault-a-model"), ` burnt 即时落盘（实际 ${JSON.stringify(burnt)}）`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T8 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
