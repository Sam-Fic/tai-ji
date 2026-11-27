/**
 * T3（枝 fail-fast）：账户类错误不触发 failover。
 *
 * 场景：双端点路由 [fault-a, fault-b]，fault-a 返回 429 insufficient_quota
 * （命中 pi 原生 NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN——pi 压根不重试）。
 * ① 第一轮：零 auto_retry 事件，终局错误即账户错误原文；
 * ② 第二轮：终局观察看到 error 但链内计数 0 < maxRetries 3（fail-fast：没烧预算）
 *    → 不 burnt → 主端点 fault-a 继续被选（账户错误持续可见，不向候选静默漂移）；
 * ③ fault-b 全程零请求。
 */

import {
	assistantMessages,
	checker,
	cleanup,
	eventsOfType,
	httpInsufficientQuota,
	httpOk,
	makeWorkDir,
	readSessionEntries,
	runPiSession,
	startFaultServer,
	virtualModelStateEntries,
	writeAgentDir,
} from "./lib/harness.mjs";

const work = makeWorkDir("t3");
const server = await startFaultServer({
	"/a": Array.from({ length: 8 }, () => httpInsufficientQuota()),
	"/b": [httpOk("SHOULD-NOT-HAPPEN")],
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

	const c = checker("T3 fail-fast 不换端点");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);

	// ① pi 没有重试（账户类错误不可重试）
	c.check(eventsOfType(events, "auto_retry_start").length === 0, "零 auto_retry_start（fail-fast：pi 不重试账户类错误）");
	const first = assistants.find(m => m.stopReason === "error");
	c.check((first?.errorMessage ?? "").includes("insufficient_quota"), "终局错误是账户错误原文（持续可见）");

	// ② 第二轮仍选 fault-a（未 burnt：链内计数 0 < 预算 3）
	const requestsA = server.requests.filter(r => r.path.startsWith("/a/")).length;
	const requestsB = server.requests.filter(r => r.path.startsWith("/b/")).length;
	c.check(requestsA === 2, `fault-a 两轮各一次 = 2（实际 ${requestsA}）`);
	c.check(requestsB === 0, `fault-b 零请求（未漂移；实际 ${requestsB}）`);

	// ③ 无 burnt 落盘（或落了空集）
	const stateEntries = virtualModelStateEntries(entries);
	const burnt = stateEntries.length > 0 ? (stateEntries[stateEntries.length - 1]?.data?.state?.burnt ?? []) : [];
	c.check(burnt.length === 0, `无 burnt 端点（实际 ${JSON.stringify(burnt)}）`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T3 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
