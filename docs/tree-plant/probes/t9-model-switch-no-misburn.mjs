/**
 * T9（枝 failover-edges）：模型切换 away-and-back 不误烧（链内计数退役）。
 *
 * 场景（修剪发现 P1 的实机锁定）：双端点路由 [fault-a, fault-b]。
 * ① 第一轮：fault-a 链内 3 次透传重试后第 4 次 attempt 恢复成功（计数=3，链以成功收尾）；
 * ② 用户切换到物理模型 fault-d 发一轮（route 闭包不参与）；
 * ③ 切回路由：第三轮选 fault-a → insufficient_quota 账户类 fail-fast（pi 不重试）；
 * ④ 第四轮：终局观察看到 error 但链内计数已在②③间退役（切走轮次的成功结局终断了链）→
 *    判 fail-fast → 不 burnt、不切换，主端点错误持续可见；全程零 state 条目。
 *
 * 修复前（修剪实证）：切回后最近物理结局 = fault-d 的消息（非本路由成员）→ 观察跳过 →
 * fault-a 的旧计数 3 被孤立 → 第四轮误判「预算用尽」→  burnt + 漂移 fault-b，账户错误被掩盖。
 */

import {
	assistantMessages,
	checker,
	cleanup,
	http524,
	httpInsufficientQuota,
	httpOk,
	makeWorkDir,
	readSessionEntries,
	spawnPiWithSteps,
	startFaultServer,
	virtualModelStateEntries,
	writeAgentDir,
} from "./lib/harness.mjs";

const work = makeWorkDir("t9");
const server = await startFaultServer({
	"/a": [http524("ray-t9-1"), http524("ray-t9-2"), http524("ray-t9-3"), httpOk("A-RECOVERED"), httpInsufficientQuota(), httpInsufficientQuota()],
	"/b": [httpOk("B-OK-1"), httpOk("B-OK-2")],
	"/d": [httpOk("D-OK")],
});
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
	providerPaths: {
		"fault-a": `${server.baseUrl}/a`,
		"fault-b": `${server.baseUrl}/b`,
		"fault-d": `${server.baseUrl}/d`,
	},
	settings: { retry: { baseDelayMs: 200 } },
});

const snap = () => ({
	a: server.requests.filter(r => r.path.startsWith("/a/")).length,
	b: server.requests.filter(r => r.path.startsWith("/b/")).length,
	d: server.requests.filter(r => r.path.startsWith("/d/")).length,
});

let exitCode = 0;
try {
	const turns = [];
	const { sessionPath } = await spawnPiWithSteps({
		agentDir,
		workDir: work,
		model: "aggregation/route-a",
		steps: [
			{ prompt: "p1", onSettled: () => { turns[1] = snap(); } },
			{ setModel: ["fault-d", "fault-d-model"] },
			{ prompt: "p2-on-fault-d", onSettled: () => { turns[2] = snap(); } },
			{ setModel: ["aggregation", "route-a"] },
			{ prompt: "p3", onSettled: () => { turns[3] = snap(); } },
			{ prompt: "p4", onSettled: () => { turns[4] = snap(); } },
		],
	});

	const c = checker("T9 模型切换 away-and-back 不误烧");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);

	c.check(turns[1].a === 4, `第一轮 fault-a 四请求后恢复成功（实际 a=${turns[1].a}）`);
	c.check(turns[2].d === 1, `第二轮打 fault-d（实际 d=${turns[2].d}）`);
	c.check(turns[3].a === 5 && turns[3].b === 0, `第三轮切回后选 fault-a 单次 fail-fast（实际 a=${turns[3].a} b=${turns[3].b}）`);
	const turn3 = [...assistants].reverse().find(m => m.provider === "fault-a" && m.stopReason === "error");
	c.check((turn3?.errorMessage ?? "").includes("insufficient_quota"), "第三轮终局 = insufficient_quota 账户错误");

	// fail-fast 分界：第四轮仍选 fault-a，不 burnt 不切换，零 state 条目
	c.check(turns[4].b === turns[3].b, `第四轮不应 failover 到 fault-b（实际 b: ${turns[3].b}→${turns[4].b}）`);
	c.check(turns[4].a === 6, `第四轮仍选 fault-a（实际 a=${turns[4].a}）`);
	const stateEntries = virtualModelStateEntries(entries);
	c.check(stateEntries.length === 0, `全程零 burn 事件 → 零 state 条目（实际 ${stateEntries.length}：${JSON.stringify(stateEntries.map(e => e.data?.state))}）`);

	c.note(`每轮上游请求快照：${JSON.stringify(turns)}`);
	c.note(`终局消息：${assistants.map(m => `${m.provider}:${m.stopReason}`).join(" | ")}`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T9 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
