/**
 * tree-plant 实机验收探针共享基座（provider-aggregation 重试/failover 修订）。
 *
 * 驱动真实宿主 = 本机 pi 二进制（PATH 解析，版本 1.0.0）以 --mode rpc 加载真实扩展源码
 * （extensions/universal/provider-aggregation/src/index.ts，经 jiti 转译），端点 = 本机
 * HTTP 故障注入服务器（openai-completions 协议）。探针不 mock 扩展、不 mock pi——
 * pi 进程、扩展闭包、provider HTTP 栈全真；故障服务器只是可编排的上游端点（与生产
 * Cloudflare 524 同形态：非 2xx + JSON error body）。
 *
 * 关键环境事实（fact-check.md 接口核实表对应行）：
 * - PI_CODING_AGENT_DIR 指定 agent dir：models.json / auth.json / config/providers.json
 *   （扩展 routes 配置 = getProviderExtrasPath = <agentDir>/config/providers.json）。
 * - --mode rpc 的 stdout = 全部 AgentSessionEvent JSONL（含 auto_retry_start/end），
 *   探针据此点数 pi 的真实重试次数。
 * - 一次 prompt 的终局信号 = agent_settled 事件（_runAgentPrompt finally 发射）。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** 仓库根（probes/lib → 上四级）。 */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** 受测扩展入口（真实源码，pi 经 jiti 加载）。 */
export const EXTENSION_PATH = join(REPO_ROOT, "extensions/universal/provider-aggregation/src/index.ts");

/** 故障注入上游：openai-completions 形态的 SSE 流式完成响应（pi 恒发 stream:true）。 */
export function completionJson(text) {
	const id = `probe-${Math.random().toString(36).slice(2, 10)}`;
	const chunk = (delta, finishReason) => JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "probe-model",
		choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
	});
	return [
		chunk({ role: "assistant", content: "" }),
		chunk({ content: text }),
		chunk({}, "stop"),
		"[DONE]",
	].map(line => `data: ${line}\n\n`).join("");
}

/**
 * 启动故障注入服务器。
 *
 * @param plan { [pathPrefix: string]: Array<{ status: number, body: string }> }
 *   每个路径前缀按序消费响应规格（第 N 个请求取第 N 项；用尽后重复最后一项）——
 *   显式剧本比回调更可审计：请求序列即预期序列。
 * @returns { port, requests: Array<{ path, at }>, close() }
 */
export function startFaultServer(plan) {
	const requests = [];
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const path = req.url ?? "/";
			requests.push({ path, at: Date.now() });
			const prefix = Object.keys(plan).find(p => path.startsWith(p));
			const script = plan[prefix];
			if (script === undefined) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `probe: no plan for ${path}` } }));
				return;
			}
			const seen = requests.filter(r => (r.path ?? "").startsWith(prefix)).length;
			const step = script[Math.min(seen, script.length) - 1] ?? script[script.length - 1];
			res.writeHead(step.status, { "content-type": step.contentType ?? "application/json" });
			res.end(step.body);
		});
	});
	return new Promise((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			resolvePromise({
				port,
				baseUrl: `http://127.0.0.1:${port}`,
				requests,
				close: () => new Promise(done => server.close(() => done())),
			});
		});
	});
}

/** 成功响应规格（SSE 流式，pi openai-completions 协议）。 */
export function httpOk(text) {
	return { status: 200, contentType: "text/event-stream", body: completionJson(text) };
}

/** 524 形态错误响应（复刻生产事故：Cloudflare origin_response_timeout + ray_id）。 */
export function http524(rayId) {
	return {
		status: 524,
		body: JSON.stringify({
			error: {
				code: 524,
				message: "origin_response_timeout",
				ray_id: rayId ?? `probe-ray-${Math.random().toString(36).slice(2, 12)}`,
			},
		}),
	};
}

/** 账户类 fail-fast 错误响应（命中 pi 原生 NON_RETRYABLE 词表的 insufficient_quota）。 */
export function httpInsufficientQuota() {
	return {
		status: 429,
		body: JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }),
	};
}

/** 单个 provider 的 models.json 条目（openai-completions，指向故障服务器路径）。 */
function modelEntry(providerId, modelId, baseUrl) {
	return {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

/**
 * 写 agent dir（pi 的配置面：models.json / auth.json / config/providers.json）。
 *
 * @param routes providers.json routes 域数组（AggregationRoute 形态，schema 键全既有）。
 * @param providerPaths { [providerId]: urlPrefix } 端点 provider → 服务器路径前缀。
 * @param settings settings.json 内容（缺省 = pi 默认：retry enabled、maxRetries 3）。
 */
export function writeAgentDir(baseDir, { routes, providerPaths, settings }) {
	const agentDir = join(baseDir, "agent");
	mkdirSync(join(agentDir, "config"), { recursive: true });
	const models = { providers: {} };
	for (const [providerId, urlPrefix] of Object.entries(providerPaths)) {
		models.providers[providerId] = { models: [modelEntry(providerId, `${providerId}-model`, urlPrefix)] };
	}
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(models, null, 2));
	const auth = {};
	for (const providerId of Object.keys(providerPaths)) {
		auth[providerId] = { type: "api_key", key: "probe-dummy-key" };
	}
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth, null, 2));
	writeFileSync(join(agentDir, "config", "providers.json"), JSON.stringify({ routes: { version: 1, routes } }, null, 2));
	if (settings !== undefined) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
	}
	return agentDir;
}

/**
 * 跑一轮真实 pi 会话：顺序发送 prompts，每条等 agent_settled 后返回。
 *
 * @param onSettled 每条 prompt settle 后的钩子（可 async——探针在此改配置复现链中配置变更）。
 * @returns { events, sessionPath, stderr }  events = 全部 AgentSessionEvent（rpc JSONL）。
 */
export function runPiSession({ agentDir, workDir, model, prompts, extensionPath = EXTENSION_PATH, timeoutMs = 180_000, onSettled }) {
	const sessionDir = join(workDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const child = spawn("pi", [
		"-ne", // 禁用 settings 清单扩展发现（防 npm 版双载，AGENTS.md [HISTORICAL] 事故纪律）
		"--mode", "rpc",
		"--session-dir", sessionDir,
		"--model", model,
		"--approve",
		"--offline",
		"--no-context-files",
		"--extension", extensionPath,
	], {
		cwd: workDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir },
		stdio: ["pipe", "pipe", "pipe"],
	});

	const events = [];
	let stderr = "";
	let buffer = "";
	let waiters = [];
	const settleCount = () => events.filter(e => e.type === "agent_settled").length;

	child.stdout.on("data", chunk => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const nl = buffer.indexOf("\n");
			if (nl < 0) break;
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith("{")) continue;
			try {
				const event = JSON.parse(line);
				events.push(event);
				if (event.type === "agent_settled") {
					const pending = waiters;
					waiters = [];
					for (const w of pending) w();
				}
			} catch { /* 非 JSON 行（启动横幅）忽略 */ }
		}
	});
	child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });

	const send = (message) => new Promise((resolveSend, rejectSend) => {
		const target = settleCount() + 1;
		const timer = setTimeout(() => rejectSend(new Error(`probe timeout ${timeoutMs}ms waiting for prompt ${target} to settle (events so far: ${events.map(e => e.type).join(",")})`)), timeoutMs);
		waiters.push(() => { clearTimeout(timer); resolveSend(); });
		child.stdin.write(`${JSON.stringify({ type: "prompt", id: `p${target}`, message })}\n`);
	});

	const done = (async () => {
		for (const prompt of prompts) {
			await send(prompt);
			await onSettled?.(settleCount());
		}
		child.stdin.end();
		await new Promise(resolveExit => {
			if (child.exitCode !== null) resolveExit();
			else child.once("exit", resolveExit);
		});
		const sessionPath = findNewestSession(sessionDir);
		return { events, sessionPath, stderr };
	})();

	done.catch(async () => { child.kill("SIGKILL"); });
	return done.then(
		result => result,
		async err => {
			try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
			throw err;
		},
	);
}

/**
 * 带 set_model 交替的会话驱动（模型切换场景：steps = { prompt } 与 { setModel:[provider,id] }
 * 交替序列，每条 prompt 等 agent_settled 后调 onSettled）。
 *
 * 用途 = 实机锁定「切换模型 away-and-back」类场景（路由闭包不参与切走轮次，但闭包状态留存——
 * T9 链内计数退役判据依赖此驱动）。
 */
export function spawnPiWithSteps({ agentDir, workDir, model, steps, extensionPath = EXTENSION_PATH, timeoutMs = 180_000 }) {
	const sessionDir = join(workDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const child = spawn("pi", [
		"-ne",
		"--mode", "rpc",
		"--session-dir", sessionDir,
		"--model", model,
		"--approve",
		"--offline",
		"--no-context-files",
		"--extension", extensionPath,
	], {
		cwd: workDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir },
		stdio: ["pipe", "pipe", "pipe"],
	});

	const events = [];
	let buffer = "";
	let waiters = [];
	child.stdout.on("data", chunk => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const nl = buffer.indexOf("\n");
			if (nl < 0) break;
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith("{")) continue;
			try {
				const event = JSON.parse(line);
				events.push(event);
				if (event.type === "agent_settled") {
					const pending = waiters;
					waiters = [];
					for (const w of pending) w();
				}
			} catch { /* 非 JSON 行（启动横幅）忽略 */ }
		}
	});
	let stderr = "";
	child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });

	const done = (async () => {
		let n = 0;
		for (const step of steps) {
			n += 1;
			if (step.setModel !== undefined) {
				child.stdin.write(`${JSON.stringify({ type: "set_model", id: `s${n}`, provider: step.setModel[0], modelId: step.setModel[1] })}\n`);
				await new Promise(r => setTimeout(r, 300)); // 等 set_model 响应落地
				continue;
			}
			await new Promise((resolveSend, rejectSend) => {
				const timer = setTimeout(() => rejectSend(new Error(`probe timeout ${timeoutMs}ms waiting for step ${n} to settle (events: ${events.map(e => e.type).join(",")})`)), timeoutMs);
				waiters.push(() => { clearTimeout(timer); resolveSend(); });
				child.stdin.write(`${JSON.stringify({ type: "prompt", id: `p${n}`, message: step.prompt })}\n`);
			});
			await step.onSettled?.(n);
		}
		child.stdin.end();
		await new Promise(resolveExit => {
			if (child.exitCode !== null) resolveExit();
			else child.once("exit", resolveExit);
		});
		return { events, sessionPath: findNewestSession(sessionDir), stderr };
	})();

	return done.then(
		result => result,
		async err => {
			try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
			throw err;
		},
	);
}

/** session-dir 里最新的 jsonl 会话文件（pi 首次 flush 前可能不存在——调用方判空）。 */
export function findNewestSession(sessionDir) {
	let entries;
	try { entries = readdirSync(sessionDir); } catch { return undefined; }
	const jsonls = entries.filter(f => f.endsWith(".jsonl"));
	if (jsonls.length === 0) return undefined;
	const withTime = jsonls.map(f => ({ f, t: statSafe(join(sessionDir, f)) }));
	withTime.sort((a, b) => b.t - a.t);
	return join(sessionDir, withTime[0].f);
}

function statSafe(p) {
	try { return readFileSync(p, "utf8").length; } catch { return 0; }
}

/** 读会话文件全部条目（每行一个 JSON entry）。 */
export function readSessionEntries(sessionPath) {
	if (sessionPath === undefined) return [];
	return readFileSync(sessionPath, "utf8")
		.split(/\r?\n/)
		.filter(l => l.trim().startsWith("{"))
		.map(l => { try { return JSON.parse(l); } catch { return undefined; } })
		.filter(Boolean);
}

/** 探针工件根目录（每次调用一个 mkdtemp，调用方负责 rmSync 清理）。 */
export function makeWorkDir(label) {
	const dir = join(mkdtempSync(join(tmpdir(), "tp-probe-")), label);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** 断言工具：收集失败项，退出码非 0 即探针红。 */
export function checker(name) {
	const failures = [];
	const notes = [];
	const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
	const note = message => notes.push(message);
	const done = () => {
		for (const n of notes) console.log(`  · ${n}`);
		if (failures.length > 0) {
			for (const f of failures) console.error(`  ✗ ${f}`);
			console.error(`✗ ${name} 未通过（${failures.length} 项）`);
			process.exitCode = 1;
			return false;
		}
		console.log(`✓ ${name} 通过`);
		return true;
	};
	return { check, note, done };
}

/** 清理工件目录。 */
export function cleanup(dir) {
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
}

/** 事件流里某类型的全部事件。 */
export function eventsOfType(events, type) {
	return events.filter(e => e.type === type);
}

/** 会话条目里全部 assistant 消息（message 条目：{type:"message", message:{...}}）。 */
export function assistantMessages(entries) {
	const out = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		out.push(entry.message);
	}
	return out;
}

/** 会话条目里全部 pi.virtual-model-state 自定义条目（{type:"custom", customType, data}）。 */
export function virtualModelStateEntries(entries) {
	return entries.filter(e => e.customType === "pi.virtual-model-state");
}
