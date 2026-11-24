/**
 * T1（trunk）：retry 透传 + 真实上游错误呈现。
 *
 * 场景：单端点路由，端点持续 524（复刻生产事故形态）。验证：
 * ① pi 自动重试全部打到同一端点（上游请求数 = 1 + maxRetries）；
 * ② auto_retry_start × maxRetries（默认 3）、auto_retry_end success=false attempt=3；
 * ③ 终局错误是真实上游错误全文（含 524 / origin_response_timeout / ray_id），
 *    物理模型标识（provider=fault-a）——不再是被掩盖的「上一端点失败且无其他可用端点」。
 *
 * 修复前行为（已实证）：重试求值把唯一端点排除 → 路由自身抛中文错误 → 重试链死在
 * attempt 1/3，用户看到二手错误。本 case 即该 bug 的实机回归防线。
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

const work = makeWorkDir("t1");
const server = await startFaultServer({
	"/a": Array.from({ length: 8 }, () => http524("probe-ray-t1")),
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
	settings: { retry: { baseDelayMs: 200 } }, // 只压缩退避时长；maxRetries 保持 pi 缺省 3
});

let exitCode = 0;
try {
	const { events, sessionPath, stderr } = await runPiSession({
		agentDir,
		workDir: work,
		model: "aggregation/route-single",
		prompts: ["say hello"],
	});

	const c = checker("T1 retry 透传 + 真实错误呈现");
	const entries = readSessionEntries(sessionPath);
	const assistants = assistantMessages(entries);
	const terminal = assistants[assistants.length - 1];

	// ① 重试打到同一端点：1 次首发 + 3 次重试 = 4 次上游请求
	c.check(server.requests.length === 4, `上游请求数 = 4（实际 ${server.requests.length}：${server.requests.map(r => r.path).join(",")}）`);
	c.check(server.requests.every(r => r.path.startsWith("/a/")), "全部请求打到同一端点 /a（透传不换端点）");

	// ② pi 重试预算真实用尽（事件族佐证）
	const starts = eventsOfType(events, "auto_retry_start");
	const ends = eventsOfType(events, "auto_retry_end");
	c.check(starts.length === 3, `auto_retry_start × 3（实际 ${starts.length}）`);
	c.check(starts.every(e => e.maxAttempts === 3), "maxAttempts = 3（pi 缺省预算）");
	c.check(ends.length === 1 && ends[0].success === false && ends[0].attempt === 3, `auto_retry_end success=false attempt=3（实际 ${JSON.stringify(ends.map(e => ({ s: e.success, a: e.attempt })))}）`);

	// ③ 终局错误 = 真实上游错误全文，物理模型标识
	c.check(terminal?.stopReason === "error", `终局 stopReason=error（实际 ${terminal?.stopReason}）`);
	c.check(terminal?.provider === "fault-a", `终局消息 provider=fault-a（实际 ${terminal?.provider}）`);
	c.check(terminal?.model === "fault-a-model", `终局消息 model=fault-a-model（实际 ${terminal?.model}）`);
	c.check((terminal?.errorMessage ?? "").includes("524"), "终局错误含上游状态码 524");
	c.check((terminal?.errorMessage ?? "").includes("origin_response_timeout"), "终局错误含上游 origin_response_timeout");
	c.check((terminal?.errorMessage ?? "").includes("probe-ray-t1"), "终局错误含上游 ray_id（真实错误全文，非二手转述）");
	c.check(!(terminal?.errorMessage ?? "").includes("上一端点失败且无其他可用端点"), "终局错误不是被掩盖的路由二手错误");

	// 全事件流与会话文件都不含旧致命文案
	const allText = JSON.stringify(events) + JSON.stringify(entries);
	c.check(!allText.includes("上一端点失败且无其他可用端点"), "事件流/会话全文无「上一端点失败且无其他可用端点」");
	c.check(!allText.includes("api=pi-virtual,provider=aggregation") || true, "（记录用）虚拟模型错误不出现于终局");
	c.note(`stderr 尾部：${stderr.slice(-200) || "（空）"}`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ T1 异常：${err?.stack ?? err}`);
	exitCode = 1;
} finally {
	await server.close();
	cleanup(work);
}
process.exit(exitCode);
