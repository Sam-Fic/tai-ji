/**
 * T11（枝 failover-edges）：链中端点被改指向——重试落正常选择的那次也计数（预算不漏记）。
 *
 * 场景（修剪发现 P2 的实机锁定）：路由 [m1→fault-a, m2→fault-b]。
 * ① 第一轮：m1 首发 fault-a 失败；第一次上游请求落地后链中把 m1 改指向 fault-c；
 * ② 三次重试经正常选择打 fault-c（首次 divert 不返还传但计数记在 fault-c 头上）→ 预算用尽，
 *    终局错误 = fault-c；
 * ③ 第二轮：终局观察见 fault-c 终局 error + 计数 3 ≥ maxRetries 3 → burnt → failover 到
 *    fault-b 成功；第三轮维持 fault-b（ burnt 持久）。
 *
 * 修复前（修剪实证）：divert 的首次重试不走透传、不 bump → 计数只攒到 2 → 误判 fail-fast →
 * 故障端点 fault-c 被重选再烧一整轮（c=7），failover 晚一轮。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

const work = makeWorkDir("t11");
const server = await startFaultServer({
	"/a": Array.from({ length: 8 }, () => http524("ray-t11-a")),
	"/c": Array.from({ length: 8 }, () => http524("ray-t11-c")),
	"/b": [httpOk("B-OK-1"), httpOk("B-OK-2")],
});

const routeOriginal = {
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
};
// 链中改配置：m1 被改指向 fault-c（原 failed 端点 fault-a 不在新配置 → 重试落正常选择）
const routeRepointed = {
	...routeOriginal,
	members: [
		{ id: "m1", providerId: "fault-c", modelId: "fault-c-model", type: "none" },
		{ id: "m2", providerId: "fault-b", modelId: "fault-b-model", type: "none" },
	],
};

const agentDir = writeAgentDir(work, {
	routes: [routeOriginal],
	providerPaths: {
		"fault-a": `${server.baseUrl}/a`,
		"fault-c": `${server.baseUrl}/c`,
		"fault-b": `${server.baseUrl}/b`,
	},
	settings: { retry: { baseDelayMs: 200 } },
});

/** 链中改配置（mtime 变化 → 下一求值前重读）。 */
function rewriteRoutes(routes) {
	writeFileSync(join(agentDir, "config", "providers.json"), JSON.stringify({ routes: { version: 1, routes } }, null, 2));
}

let exitCode = 0;
try {
	// 第一次上游请求落地即把 m1 改指向 fault-c（此后 failed=fault-a 不在配置 → 重试落正常选择）
	const flip = (async () => {
		while (server.requests.length < 1) await new Promise(r => setTimeout(r, 20));
		await new Promise(r => setTimeout(r, 50));
		rewriteRoutes([routeRepointed]);
	})();

	const perTurn = [];
	const { events, sessionPath } = await runPiSession({
		agentDir,
		workDir: work,
		model: "aggregation/route-a",
		prompts: ["p1", "p2", "p3"],
		onSettled: async n => {
			perTurn[n] = {
				a: server.requests.filter(r => r.path.startsWith("/a/")).length,
				c: server.requests.filter(r => r.path.startsWith("/c/")).length,
				b: server.requests.filter(r => r.path.startsWith("/b/")).length,
			};
		},
	});
	await flip;

	const c = checker("T11 链中改指向——divert 重试计数不漏记");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);

	// ① 第一轮：fault-a 只吃首发；三次重试经正常选择打 fault-c
	c.check(perTurn[1].a === 1, `第一轮 fault-a 请求 = 1（仅首发；实际 ${perTurn[1].a}）`);
	c.check(perTurn[1].c === 3, `第一轮 fault-c 请求 = 3（三次重试经正常选择路径；实际 ${perTurn[1].c}）`);
	const turn1Terminal = [...assistants].reverse().find(m => m.stopReason === "error");
	c.check(turn1Terminal?.provider === "fault-c", `第一轮终局 = fault-c 错误（实际 ${turn1Terminal?.provider}）`);
	c.check(eventsOfType(events, "auto_retry_start").length >= 3, "第一轮重试链完整（预算用尽）");

	// ② 第二轮即 burnt failover（预算记账正确：fault-c 吃满 3 次重试）
	c.check(perTurn[2].c === 3, `第二轮不再打 fault-c（预算已尽应 burnt；实际 c=${perTurn[2].c}）`);
	c.check(perTurn[2].b === 1, `第二轮 failover 到 fault-b（实际 b=${perTurn[2].b}）`);

	// ③ 第三轮维持 fault-b（burnt 持久）
	c.check(perTurn[3].b === 2, `第三轮维持 fault-b（实际 b=${perTurn[3].b}）`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T11 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
