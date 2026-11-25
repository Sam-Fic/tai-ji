/**
 * T12（枝 failover-edges）：链中压缩不抹在途链的预算记账（修剪复审 F1 的实机锁定）。
 *
 * 场景：双端点路由 [fault-a, fault-b]，小 contextWindow + keepRecentTokens=0 → pi 在
 * 重试链在途触发自动压缩（prepareRequest 路由求值后 _exceedsCompactionThreshold →
 * _runAutoCompaction → 摘要请求再进 route 回调，reason=direct）。摘要请求成功、真实
 * 请求持续 524。
 * ① 第一轮（warmup）：fault-a 首次请求成功（攒历史 + 让上下文过压缩阈）；
 * ② 第二轮：fault-a 打满预算（4 次真实请求 + 链中多次压缩摘要），终局 524；
 * ③ 第三轮：终局观察在链边界读到终局 error + 计数 3 ≥ maxRetries 3 → burnt →
 *    failover 到 fault-b 成功，burnt 落 state。
 *
 * 修复前（修剪复审实证）：链在途的 direct 求值（messages 已被 _omitRecoveryAttempt
 * 剔除失败 attempt）命中计数退役路径 → 在途计数被抹 → 终局 error 判 fail-fast →
 * 永不 burnt、永不 failover，用户每轮重打故障端点。
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

/** pi 压缩摘要请求的标识（摘要系统提示含该串）。 */
const SUMMARY_MARKER = "context summarization assistant";

const work = makeWorkDir("t12");
const server = await startFaultServer(
	{
		"/a": [httpOk("first-turn-ok"), http524("ray-t12-1"), http524("ray-t12-2"), http524("ray-t12-3"), http524("ray-t12-4")],
		"/b": [httpOk("B-OK")],
	},
	{
		summary: {
			marker: SUMMARY_MARKER,
			step: httpOk("## Goal\nprobe summary\n\n## Next Steps\n1. none"),
		},
	},
);
const agentDir = writeAgentDir(work, {
	routes: [{
		id: "route-a",
		name: "双端点",
		modelId: "route-a",
		enabled: true,
		mode: "advanced",
		members: [
			{ id: "m1", providerId: "fault-a", modelId: "fault-a-model", type: "none" },
			{ id: "m2", providerId: "fault-b", modelId: "fault-b-model", type: "none" },
		],
		specials: [],
	}],
	providerPaths: { "fault-a": `${server.baseUrl}/a`, "fault-b": `${server.baseUrl}/b` },
	// 小窗 + 不保留近期 token → 重试链在途必然触发自动压缩（direct 求值夹在链中）
	contextWindow: 1000,
	settings: { retry: { baseDelayMs: 100 }, compaction: { keepRecentTokens: 0 } },
});

let exitCode = 0;
try {
	const { events, sessionPath } = await runPiSession({
		agentDir,
		workDir: work,
		model: "aggregation/route-a",
		prompts: ["p1", "p2", "p3"],
	});

	const c = checker("T12 链中压缩不抹在途计数");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);

	// 前置：压缩确实在链中发生（否则本 case 空转）
	const compactions = eventsOfType(events, "compaction_start").length;
	c.check(compactions > 0, `链中压缩确实发生（compaction_start=${compactions}）`);
	const summaries = server.requests.filter(r => r.isSummary).length;
	c.check(summaries > 0, `摘要请求经路由回调发出（${summaries} 次）`);

	// ② 第二轮预算完整用尽（真实请求 4 次：首发 + 3 重试）
	const requestsA = server.requests.filter(r => !r.isSummary && r.path.startsWith("/a/")).length;
	c.check(requestsA === 5, `fault-a 真实请求 = 5（warmup 1 + 链 4；实际 ${requestsA}）`);
	c.check(eventsOfType(events, "auto_retry_start").length === 3, "第二轮重试链完整（3 次）");

	// ③ 第三轮 burnt failover
	const requestsB = server.requests.filter(r => r.path.startsWith("/b/")).length;
	c.check(requestsB === 1, `第三轮 failover 到 fault-b（实际 /b 请求 ${requestsB}）`);
	const last = assistants[assistants.length - 1];
	c.check(last?.stopReason === "stop" && last?.provider === "fault-b", `第三轮成功出站自 fault-b（实际 ${last?.provider}/${last?.stopReason}）`);
	const stateEntries = virtualModelStateEntries(entries);
	const burnt = stateEntries.length > 0 ? (stateEntries[stateEntries.length - 1]?.data?.state?.burnt ?? []) : [];
	c.check(burnt.includes("fault-a/fault-a-model"), ` burnt 落盘（实际 ${JSON.stringify(burnt)}）`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T12 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
