/**
 * T7（trunk）：retry 透传不复查路由条件。
 *
 * 场景：单端点路由带额度条件（阈值 50%），quota-cache.json 初始「剩余 100%」→ 条件满足，
 * 端点被选中后持续 524。第一次上游请求落地后，探针把额度缓存改写为「剩余 0%」——
 * 若重试求值复查条件（旧实现的 evaluateRoute 路径），候选集已空 → 路由自身失败；
 * 透传则不复查 → 继续打同一端点。
 * ① 4 次上游请求全部打到 /a（旧行为在此形态下第 2 次求值即抛中文错误，止于 1 次）；
 * ② 终局错误是真实 524，无路由二手错误；
 * ③ auto_retry 链完整走满预算（3 次）。
 *
 * 锁 D6 修订总则：「重试归属在途请求的延续，不复查条件（直连模型同型）」。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	assistantMessages,
	checker,
	cleanup,
	http524,
	makeWorkDir,
	readSessionEntries,
	runPiSession,
	startFaultServer,
	writeAgentDir,
} from "./lib/harness.mjs";

const work = makeWorkDir("t7");
const server = await startFaultServer({
	"/a": Array.from({ length: 8 }, () => http524("probe-ray-t7")),
});
const agentDir = writeAgentDir(work, {
	routes: [{
		id: "route-quota",
		name: "额度条件端点",
		modelId: "route-quota",
		enabled: true,
		mode: "advanced",
		members: [{
			id: "m1",
			providerId: "fault-a",
			modelId: "fault-a-model",
			type: "quota",
			quota: { thresholdPercent: 50 },
		}],
		specials: [],
	}],
	providerPaths: { "fault-a": `${server.baseUrl}/a` },
	settings: { retry: { baseDelayMs: 400 } },
});

const quotaCachePath = join(agentDir, "..", "quota-cache.json");
const writeQuota = pct => {
	writeFileSync(quotaCachePath, JSON.stringify({
		"fault-a": {
			lastFetchAt: Date.now(),
			data: { wins: [{ pct, resetSec: 18000 }] },
		},
	}, null, 2));
};

// 初始：剩余 100%（pct=0）→ 阈值 50 满足
writeQuota(0);

let exitCode = 0;
try {
	// 第一次上游请求落地即把额度翻到耗尽（pct=100 → 剩余 0 < 50）：
	// 此后任何「复查条件」的求值都会失去候选，只有透传能继续打端点。
	const flip = (async () => {
		while (server.requests.length < 1) await new Promise(r => setTimeout(r, 20));
		await new Promise(r => setTimeout(r, 50));
		writeQuota(100);
	})();

	const { sessionPath } = await runPiSession({
		agentDir,
		workDir: work,
		model: "aggregation/route-quota",
		prompts: ["say hello"],
	});
	await flip;

	const c = checker("T7 透传不复查条件");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);
	const terminal = assistants[assistants.length - 1];

	// ① 4 次请求全打到 /a（旧行为：重试求值复查条件 → no-candidate → 中文错误止于 1 次）
	c.check(server.requests.length === 4, `上游请求 = 4（透传不复查；实际 ${server.requests.length}）`);
	c.check(server.requests.every(r => r.path.startsWith("/a/")), "全部请求打到同一端点");

	// ② 终局错误是真实 524（不是「条件不满足」类路由错误）
	c.check(terminal?.provider === "fault-a", `终局 provider=fault-a（实际 ${terminal?.provider}）`);
	c.check((terminal?.errorMessage ?? "").includes("524"), "终局错误含上游 524");
	const allText = JSON.stringify(entries);
	c.check(!allText.includes("上一端点失败且无其他可用端点"), "无旧致命文案");
	c.check(!allText.includes("额度低于阈值"), "终局不是额度条件路由错误（证明未复查条件）");

	// ③ 重试链完整
	c.note(`auto_retry_start 事件由 T1 锁定，本case聚焦条件正交`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T7 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
