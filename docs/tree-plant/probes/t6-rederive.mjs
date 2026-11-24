/**
 * T6（枝 rederive）：路由自身失败后的幂等重导（虚拟 error 跳过）。
 *
 * 场景：双端点路由 [fault-a, fault-b]，fault-a 持续 524。
 * ① 第一轮：fault-a 用尽预算，终局物理 524 错误入投影；
 * ② 链中改配置：路由全部端点时间窗外（no-candidate）→ 第二轮路由自身失败
 *    （虚拟模型错误消息入投影，provider=aggregation）；
 * ③ 恢复配置后第三轮：终局观察从尾向前跳过虚拟 error，找到更早的物理 524 结局，
 *    凭闭包链内计数（3 ≥ 3）幂等重导 burn → failover 到 fault-b 成功。
 *
 * 锁「burn 不因选择层抛错而丢、不需闭包镜像」——观察永远从会话事实重算。
 * 兼证 route 求值前 mtime 重读（链中配置变更对下一请求生效）。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	assistantMessages,
	checker,
	cleanup,
	http524,
	httpOk,
	makeWorkDir,
	readSessionEntries,
	runPiSession,
	startFaultServer,
	virtualModelStateEntries,
	writeAgentDir,
} from "./lib/harness.mjs";

const work = makeWorkDir("t6");
const server = await startFaultServer({
	"/a": Array.from({ length: 8 }, () => http524("probe-ray-t6")),
	"/b": [httpOk("REDERIVE-OK-B")],
});

/** 全false 时间窗表（7×48）——任何墙钟都判窗外。 */
function closedWindow() {
	return Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => false));
}

const dualRoute = {
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
};

const windowedRoute = {
	...dualRoute,
	members: [
		{ id: "m1", providerId: "fault-a", modelId: "fault-a-model", type: "window", window: closedWindow() },
		{ id: "m2", providerId: "fault-b", modelId: "fault-b-model", type: "window", window: closedWindow() },
	],
};

const agentDir = writeAgentDir(work, {
	routes: [dualRoute],
	providerPaths: { "fault-a": `${server.baseUrl}/a`, "fault-b": `${server.baseUrl}/b` },
	settings: { retry: { baseDelayMs: 200 } },
});

/** 链中改配置（mtime 变化 → 下一求值前重读）。 */
function rewriteRoutes(routes) {
	writeFileSync(join(agentDir, "config", "providers.json"), JSON.stringify({ routes: { version: 1, routes } }, null, 2));
}

let exitCode = 0;
try {
	const { sessionPath } = await runPiSession({
		agentDir,
		workDir: work,
		model: "aggregation/route-dual",
		prompts: ["first prompt", "second prompt", "third prompt"],
		onSettled: async settledCount => {
			if (settledCount === 1) rewriteRoutes([windowedRoute]);
			if (settledCount === 2) rewriteRoutes([dualRoute]);
		},
	});

	const c = checker("T6 路由失败后幂等重导");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);

	// ② 第二轮 = 路由自身失败（虚拟模型错误）
	const routingError = assistants.find(m => m.provider === "aggregation" && m.stopReason === "error");
	c.check(routingError !== undefined, "第二轮产出路由自身失败消息（provider=aggregation）");
	c.check((routingError?.errorMessage ?? "").includes("无可用端点") || (routingError?.errorMessage ?? "").includes("时间窗外"), `路由失败错误含条件落选明细（实际 ${(routingError?.errorMessage ?? "").slice(0, 80)}）`);

	// ③ 第三轮 = 幂等重导 burn → failover 成功
	const requestsB = server.requests.filter(r => r.path.startsWith("/b/")).length;
	c.check(requestsB === 1, `第三轮 failover 到 fault-b（实际 /b 请求 ${requestsB}）`);
	const last = assistants[assistants.length - 1];
	c.check(last?.stopReason === "stop" && last?.provider === "fault-b", `第三轮成功出站自 fault-b（实际 ${last?.provider}/${last?.stopReason}）`);

	// burnt 重导结果落盘
	const stateEntries = virtualModelStateEntries(entries);
	const lastState = stateEntries[stateEntries.length - 1];
	const burnt = lastState?.data?.state?.burnt ?? [];
	c.check(burnt.includes("fault-a/fault-a-model"), ` burnt 经重导后落盘（实际 ${JSON.stringify(burnt)}）`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T6 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
