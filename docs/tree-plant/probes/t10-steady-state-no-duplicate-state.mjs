/**
 * T10（枝 failover-edges）：单端点 burnt 稳态不重复落 state（轮换引用纪律）。
 *
 * 场景（修剪发现 P3 的实机锁定）：单端点路由持续 524。第一轮烧出 burn；第 2-4 轮 burnt
 * 无变化（单候选轮换重探 = 原样重试）。判据：burn 事件只发生一次 → pi.virtual-model-state
 * 条目只有 1 条，不随请求数线性增长。
 *
 * 修复前（修剪实证）：rotateOldestBurnt 对单元素 delete+add 产出同内容新引用 → 闭包写门禁
 * （引用比较）恒真 → 每请求 append 一条恒等条目（4 轮 3 条），会话文件随请求线性增长
 * （生产事故画像 = 路由持续失败 25h）。
 */

import {
	assistantMessages,
	checker,
	cleanup,
	http524,
	makeWorkDir,
	readSessionEntries,
	runPiSession,
	startFaultServer,
	virtualModelStateEntries,
	writeAgentDir,
} from "./lib/harness.mjs";

const work = makeWorkDir("t10");
const server = await startFaultServer({
	"/a": Array.from({ length: 24 }, () => http524("ray-t10")),
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
	const { sessionPath } = await runPiSession({
		agentDir,
		workDir: work,
		model: "aggregation/route-single",
		prompts: ["p1", "p2", "p3", "p4"],
	});

	const c = checker("T10 单端点 burnt 稳态不重复落 state");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);

	// 每轮 4 请求（单端点 ≡ 直连：每轮真试满预算）
	c.check(server.requests.length === 16, `四轮各 4 请求（实际 ${server.requests.length}）`);
	c.note(`assistant 消息数（含中间 attempt）：${assistants.length}`);

	// 判据：burn 事件只应发生一次（第二轮）；其余求值 burnt 无变化 → 不落条目
	const stateEntries = virtualModelStateEntries(entries);
	const states = stateEntries.map(e => JSON.stringify(e?.data?.state));
	c.check(stateEntries.length === 1, `state 条目应只有 1 条（单次 burn 事件；实际 ${stateEntries.length} 条：${states.join(" ; ")}）`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T10 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
