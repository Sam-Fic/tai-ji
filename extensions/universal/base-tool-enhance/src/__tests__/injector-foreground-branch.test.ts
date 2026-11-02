// src/__tests__/injector-foreground-branch.test.ts —— execute 改写层（foreground-idle-to-background
// M1，矩阵 A 判定 / 包装命令构造 / 收尾 pid 判定 / registerConvertedTask 三步登记）。
//
// 包装脚本集成 mock：真 wrapper（bin/taiji-fg-wrap）由 u-wrapper 并行交付，本文件用本地
// fixture bash 脚本模拟其 pidfile 契约（officialExecute mock 真跑 fixture——包装命令串
// 经真实 shell 解析，引号/空格路径一并覆盖），D3 真机验收做真集成。
//
// 断言覆盖：矩阵 A 七格分流（A5 构造包装命令串含全部参数 / A3/A4 不包装 / A7 win32
// 回落 / A6 子代理 / N3 关闭）；收尾 pid 判定两分支（#4：pid 活=登记 / pid 死=不登记且
// 三文件删除）；B5 补标记 + B3 已打印不重复补；registerConvertedTask 三步落点 + 池满
// 登记不拒 + countActiveTasks 计入（#11）+ 超时启用接线（armBackgroundTimeout）。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTEGRATION_TESTS_ENABLED } from "../../../../../test-guard/integration-gate.ts";

// mock pi 官方工厂：execute 行为两种模式（passthrough 回显 / 真跑 fixture 模拟 wrapper）
const { createBashToolDefinitionMock, officialExecuteMock, agentDirRef } = vi.hoisted(() => ({
	createBashToolDefinitionMock: vi.fn(),
	officialExecuteMock: vi.fn(),
	agentDirRef: { dir: "/tmp/bte-fake-agent-dir" },
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: createBashToolDefinitionMock,
	getAgentDir: () => agentDirRef.dir,
}));

import { getProcessStartTimeSec, pidStartMatchesRegistered } from "@zhushanwen/extension-protocol/background-task";
import { clearConfigCache } from "@zhushanwen/pi-llm-shared";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	createBashOverrideToolDefinition,
	parsePidFile,
	registerConvertedTask,
	resolveFgWrapScriptPath,
} from "../bash-tool.ts";
import { clearExitWatchesForTest } from "../background/exit-watch.ts";
import { refreshPiReference, resetNotifyForTest } from "../background/notify.ts";
import { getRegistryPath, readRegistry } from "../background/registry.ts";
import { clearTaskStoreForTest, countActiveTasks, getTask, getAllTasks, registerSpawnedTask } from "../background/task-store.ts";
import type { BackgroundTask } from "../background/types.ts";

const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-injector-"));
const SESSION_ID = "sess-injector";
const TASKS_DIR = dirname(getRegistryPath(DATA_DIR, SESSION_ID));
const FIXTURE_PATH = join(DATA_DIR, "fixture-fg-wrap.sh");

// fixture：模拟 taiji-fg-wrap 的 pidfile 契约（§5 部件 1 子集——写 pidfile / 日志、按
// FIXTURE_MODE 决定命令进程死活；alive 模式 sleep reparent 存活 = B5 兜底形态）
writeFileSync(
	FIXTURE_PATH,
	[
		"#!/bin/bash",
		"# fixture wrapper: simulates taiji-fg-wrap pidfile contract (u-wrapper delivered in parallel)",
		'TASK_ID=""; LOG=""; PIDFILE=""; CMD_SH=""',
		'while [ $# -gt 0 ]; do',
		'  case "$1" in',
		'    --task-id) TASK_ID="$2"; shift 2;;',
		'    --log) LOG="$2"; shift 2;;',
		'    --pidfile) PIDFILE="$2"; shift 2;;',
		'    --idle) shift 2;;',
		'    --) shift; break;;',
		'    *) shift;;',
		'  esac',
		'done',
		'CMD_SH="$1"',
		'echo "fixture wrapper: $CMD_SH" > "$LOG"',
		'if [ "$FIXTURE_MODE" = "alive" ]; then',
		'  sleep 30 & printf \'{"pid":%d,"pidStartTimeSec":%d}\\n\' "$!" "$(date +%s)" > "$PIDFILE"',
		'else',
		'  true & DP=$!; wait $DP 2>/dev/null',
		'  printf \'{"pid":%d,"pidStartTimeSec":%d}\\n\' "$DP" "$(date +%s)" > "$PIDFILE"',
		'fi',
	].join("\n"),
	{ mode: 0o755 },
);

const CWD = "/tmp/bte-injector-workdir";

function createMockPi() {
	return {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn(),
		appendEntry: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn() },
		sendMessage: vi.fn(),
	};
}

function setupFactory() {
	createBashToolDefinitionMock.mockReset();
	officialExecuteMock.mockReset();
	isSubagentEnv(false);
	createBashToolDefinitionMock.mockImplementation((_cwd: string) => ({
		name: "bash",
		label: "bash",
		description: `official for ${_cwd}`,
		promptSnippet: "snippet",
		promptGuidelines: [],
		parameters: { type: "object", properties: {} },
		execute: officialExecuteMock,
	}));
}

/** isSubagentProcess 真实读 env（TAIJI_AGENT_SUBAGENT），用 stub 切换。 */
function isSubagentEnv(on: boolean): void {
	if (on) {
		process.env.TAIJI_AGENT_SUBAGENT = "1";
	} else {
		delete process.env.TAIJI_AGENT_SUBAGENT;
	}
}

/** 官方 execute passthrough：回显收到的 command（分流断言用，不真跑）。 */
function officialPassthrough(): void {
	officialExecuteMock.mockImplementation(async (_id: string, args: { command: string }) => ({
		content: [{ type: "text" as const, text: `ran: ${args.command}` }],
		details: undefined,
	}));
}

/**
 * 官方 execute passthrough + 改写前现场捕获：包装形态断言（cmd.sh 内容 = 命令原文）
 * 在 mock 内读取——execute 返回后收尾判定（B2）已删三文件，落盘态只存在于官方执行期间。
 */
function officialPassthroughWithCapture(): { captured: () => { wrapped: string; cmdShContent: string | null } | undefined } {
	let captured: { wrapped: string; cmdShContent: string | null } | undefined;
	officialExecuteMock.mockImplementation(async (_id: string, args: { command: string }) => {
		const m = args.command.match(/^'([^']+)' --idle \d+ --task-id bt-\d+-[a-z0-9]{6} --log '[^']+' --pidfile '[^']+' -- '([^']+)'$/);
		let cmdShContent: string | null = null;
		if (m) {
			try {
				cmdShContent = readFileSync(m[2]!, "utf8");
			} catch {
				// 非 A5 形态
			}
		}
		captured = { wrapped: args.command, cmdShContent };
		return { content: [{ type: "text" as const, text: `ran: ${args.command}` }], details: undefined };
	});
	return { captured: () => captured };
}

/** 官方 execute 真跑 fixture 模拟 wrapper（收尾判定用，pidfile 契约端到端）。 */
function officialRunsFixture(mode: "alive" | "dead", resultTextOverride?: string): void {
	officialExecuteMock.mockImplementation(async (_id: string, args: { command: string }) => {
		expect(args.command).toContain(resolveFgWrapScriptPath());
		const fixtureCommand = args.command.replace(
			`'${resolveFgWrapScriptPath()}'`,
			`'${FIXTURE_PATH}'`,
		);
		await new Promise<void>((resolve, reject) => {
			const child = spawn("bash", ["-c", fixtureCommand], {
				env: { ...process.env, FIXTURE_MODE: mode },
				stdio: "ignore",
			});
			child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`))));
			child.on("error", reject);
		});
		return {
			content: [{ type: "text" as const, text: resultTextOverride ?? `ran: ${args.command}` }],
			details: undefined,
		};
	});
}

function createCtx() {
	return { cwd: CWD, sessionManager: { getSessionId: () => SESSION_ID } };
}

/** 切到全新临时 agentDir 并写入配置文件（loadBaseToolEnhanceConfig 读时刷新即生效；bash-tool.test.ts useConfig 同款）。 */
const configTempDirs: string[] = [];
function useConfig(config: Record<string, unknown>): void {
	const dir = mkdtempSync(join(tmpdir(), "bte-injector-cfg-"));
	configTempDirs.push(dir);
	agentDirRef.dir = dir;
	const configPath = join(dir, "config", "base-tool-enhance-ext-config.json");
	mkdirSync(join(configPath, ".."), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	clearConfigCache();
}

async function executeBash(command: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) {
	const tool = createBashOverrideToolDefinition();
	return tool.execute("call-x", { command, ...extra }, signal, undefined, createCtx() as never);
}

/** 包装命令串解析（shQuote 单引号形态，正则安全——tmp 路径无单引号）。 */
function parseWrapped(wrapped: string) {
	const m = wrapped.match(
		/^'([^']+)' --idle (\d+) --task-id (bt-\d+-[a-z0-9]{6}) --log '([^']+)' --pidfile '([^']+)' -- '([^']+)'$/,
	);
	expect(m, `wrapped command shape: ${wrapped}`).toBeTruthy();
	return {
		wrapperPath: m![1],
		idle: m![2],
		taskId: m![3],
		log: m![4],
		pidfile: m![5],
		cmdSh: m![6],
	};
}

function resultText(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
	return content[0]?.type === "text" ? (content[0].text ?? "") : "";
}

function killLeftoverTasks(): void {
	for (const task of getAllTasks()) {
		try {
			process.kill(-task.pid, "SIGKILL");
		} catch {
			try {
				process.kill(task.pid, "SIGKILL");
			} catch {
				// already dead
			}
		}
	}
}

function withPlatform(platform: string, fn: () => Promise<void>): Promise<void> {
	const original = process.platform;
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	return fn().finally(() => Object.defineProperty(process, "platform", { value: original, configurable: true }));
}

beforeEach(() => {
	setupFactory();
	officialPassthrough();
	vi.stubEnv("TAIJI_AGENT_DATA_DIR", DATA_DIR);
});

afterEach(() => {
	clearExitWatchesForTest();
	killLeftoverTasks();
	clearTaskStoreForTest();
	resetNotifyForTest();
	vi.unstubAllEnvs();
	isSubagentEnv(false);
	agentDirRef.dir = "/tmp/bte-fake-agent-dir";
	for (const dir of configTempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
	clearConfigCache();
	vi.restoreAllMocks();
});

afterAll(() => {
	rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// ──────────────────────── 矩阵 A 分流（七格）────────────────────────

describe.skipIf(!INTEGRATION_TESTS_ENABLED)("matrix A routing (§3.2)", () => {
	it("A5: no timeout + not whitelisted + main session + darwin → wrapped command with all params", async () => {
		const pi = createMockPi();
		refreshPiReference(pi as unknown as ExtensionAPI);
		const { captured } = officialPassthroughWithCapture();
		const result = await executeBash("echo hi && grep -r foo .");

		expect(officialExecuteMock).toHaveBeenCalledTimes(1);
		const wrapped = officialExecuteMock.mock.calls[0]![1] as { command: string; timeout: undefined };
		const p = parseWrapped(wrapped.command);
		expect(p.wrapperPath).toBe(resolveFgWrapScriptPath());
		expect(p.idle).toBe("600"); // idleBackgroundSec 默认（u-config-doc 交付）
		expect(p.taskId).toMatch(/^bt-\d+-[a-z0-9]{6}$/); // generateTaskId 同款形态
		expect(p.log).toBe(join(TASKS_DIR, `${p.taskId}.log`));
		expect(p.pidfile).toBe(join(TASKS_DIR, `${p.taskId}.pid`));
		expect(p.cmdSh).toBe(join(TASKS_DIR, `${p.taskId}.sh`));
		// cmd.sh = 命令原文零转义（官方执行期间落盘态，mock 内捕获）
		expect(captured()?.wrapped).toBe(wrapped.command);
		expect(captured()?.cmdShContent).toBe("echo hi && grep -r foo .\n");
		// 包装执行 timeout 缺省（官方无超时语义；转后台后超时归 armBackgroundTimeout）
		expect(wrapped.timeout).toBeUndefined();
		// passthrough 不写 pidfile → 收尾走 B2 清理（无残留）
		expect(existsSync(p.cmdSh)).toBe(false);
		expect(existsSync(p.pidfile)).toBe(false);
		expect(existsSync(p.log)).toBe(false);
		expect(getAllTasks()).toHaveLength(0);
		expect(resultText(result)).toContain("ran:"); // 结果透传
	});

	it("A3: explicit timeout → native execution with original command (no wrap)", async () => {
		await executeBash("sleep 120", { timeout: 5 });

		expect(officialExecuteMock).toHaveBeenCalledWith(
			"call-x",
			{ command: "sleep 120", timeout: 5 },
			undefined,
			undefined,
			expect.anything(),
		);
		expect(getAllTasks()).toHaveLength(0);
	});

	it("A4: configured foregroundTimeoutSeconds → native execution with injected timeout (no wrap)", async () => {
		useConfig({ foregroundTimeoutSeconds: 10 });

		await executeBash("sleep 60");

		expect(officialExecuteMock).toHaveBeenCalledWith(
			"call-x",
			{ command: "sleep 60", timeout: 10 },
			undefined,
			undefined,
			expect.anything(),
		);
		expect(getAllTasks()).toHaveLength(0);
	});

	it("A7: win32 → native execution fallback (no wrap even without timeout)", async () => {
		await withPlatform("win32", async () => {
			await executeBash("dir");
		});

		expect(officialExecuteMock).toHaveBeenCalledWith(
			"call-x",
			{ command: "dir", timeout: undefined },
			undefined,
			undefined,
			expect.anything(),
		);
		expect(officialExecuteMock.mock.calls[0]![1] as { command: string }).toMatchObject({ command: "dir" });
		expect(getAllTasks()).toHaveLength(0);
	});

	it("A6: subagent process → native execution (no wrap, no registration)", async () => {
		isSubagentEnv(true);

		await executeBash("sleep 30");

		expect(officialExecuteMock).toHaveBeenCalledWith(
			"call-x",
			{ command: "sleep 30", timeout: undefined },
			undefined,
			undefined,
			expect.anything(),
		);
		expect(getAllTasks()).toHaveLength(0);
	});

	it("N3: idleBackgroundSec=null (user opt-out) → native execution, zero files, zero registration", async () => {
		useConfig({ idleBackgroundSec: null });

		await executeBash("sleep 30");

		expect(officialExecuteMock).toHaveBeenCalledWith(
			"call-x",
			{ command: "sleep 30", timeout: undefined },
			undefined,
			undefined,
			expect.anything(),
		);
		expect((officialExecuteMock.mock.calls[0]![1] as { command: string }).command).toBe("sleep 30");
		expect(getAllTasks()).toHaveLength(0);
	});

	it("A5 idle value follows config: idleBackgroundSec=42 → --idle 42", async () => {
		useConfig({ idleBackgroundSec: 42 });

		await executeBash("echo x");

		const wrapped = officialExecuteMock.mock.calls[0]![1] as { command: string };
		const p = parseWrapped(wrapped.command);
		expect(p.idle).toBe("42");
	});
});

// ──────────────────── 收尾 pid 判定两分支（断言 #4）────────────────────

describe.skipIf(!INTEGRATION_TESTS_ENABLED)("parsePidFile (wrapper pidfile protocol read side)", () => {
	it("parses the taiji-fg-wrap JSON contract; consumes pid only (pidStartTimeSec is a wall-clock approximation, never registered)", () => {
		const f = join(DATA_DIR, "probe-json.pid");
		writeFileSync(f, '{"pid":12345,"pidStartTimeSec":1700000000}\n', "utf8");
		expect(parsePidFile(f)).toEqual({ pid: 12345 });
	});

	it("tolerates missing pidStartTimeSec and rejects invalid fields", () => {
		const f2 = join(DATA_DIR, "probe-pid-nostart.json");
		writeFileSync(f2, '{"pid":42}\n', "utf8");
		expect(parsePidFile(f2)).toEqual({ pid: 42 });
		const f3 = join(DATA_DIR, "probe-pid-bad.json");
		writeFileSync(f3, '{"pid":0,"pidStartTimeSec":1}\n', "utf8");
		expect(parsePidFile(f3)).toEqual({});
	});

	it("non-JSON / corrupt / missing content all fall back to empty (JSON 单一契约)", () => {
		const f4 = join(DATA_DIR, "probe-pid-nonjson.pid");
		writeFileSync(f4, "99 1700000000\n", "utf8");
		expect(parsePidFile(f4)).toEqual({});
		const f5 = join(DATA_DIR, "probe-pid-garbage.pid");
		writeFileSync(f5, "{corrupt json", "utf8");
		expect(parsePidFile(f5)).toEqual({});
		const f6 = join(DATA_DIR, "probe-pid-missing.pid");
		expect(parsePidFile(f6)).toEqual({});
	});
});

describe.skipIf(!INTEGRATION_TESTS_ENABLED)("settle by pidfile (断言 #4)", () => {
	it("B3/B5: command process still alive → registered as background task (files kept, marker appended)", async () => {
		const pi = createMockPi();
		refreshPiReference(pi as unknown as ExtensionAPI);
		officialRunsFixture("alive");

		const result = await executeBash("sleep 30 && echo done");

		const task = getAllTasks()[0];
		expect(task).toBeDefined();
		expect(task?.state).toBe("running");
		expect(task?.command).toBe("sleep 30 && echo done");
		expect(countActiveTasks()).toBe(1);
		// 三文件保留（转后台任务日志是 bash_output 数据源，随会话目录清理）
		expect(existsSync(task!.outputFile)).toBe(true);
		expect(existsSync(join(TASKS_DIR, `${task!.taskId}.sh`))).toBe(true);
		expect(existsSync(join(TASKS_DIR, `${task!.taskId}.pid`))).toBe(true);
		// registry running 条目含 pidStartTime（登记时同源直读 ps——与守望/超时身份校验
		// 同一经 getProcessStartTimeSec，严格相等比对成立；fixture 的 sleep 30 真活进程）
		const entry = readRegistry(getRegistryPath(DATA_DIR, SESSION_ID)).get(task!.taskId);
		expect(entry?.state).toBe("running");
		expect(typeof entry?.pidStartTime).toBe("number");
		// 三步登记之 pending:register emit
		expect(pi.events.emit).toHaveBeenCalledWith(
			"pending:register",
			{ id: task!.taskId, type: "bash", name: "sleep 30 && echo done" },
		);
		// B5 补标记：fixture 正常退出但未打印标记行 → 改写层补齐（命令仍在跑/日志/查询/终止）
		const text = resultText(result);
		expect(text).toContain("[TAIJI-FG-BG]");
		expect(text).toContain(`bash_output {task_id:"${task!.taskId}"}`);
		expect(text).toContain(`bash_kill {task_id:"${task!.taskId}"}`);
		expect(text).toContain("DO NOT bash sleep");
	});

	it("B3 already-marked result is passed through untouched (no duplicate marker)", async () => {
		const pi = createMockPi();
		refreshPiReference(pi as unknown as ExtensionAPI);
		officialRunsFixture("alive", "ran: ...\n[TAIJI-FG-BG] Command moved to background after 600s without output — still running (wrapper marker).");

		const result = await executeBash("sleep 30");

		expect(getAllTasks()).toHaveLength(1);
		const text = resultText(result);
		expect(text.match(/\[TAIJI-FG-BG\]/g)).toHaveLength(1); // wrapper 已打印 → 不重复补
		expect(text).not.toContain("(the wrapper exited without printing its marker)");
		void pi;
	});

	it("B2: command process already dead → NOT registered + three files deleted (zero residue)", async () => {
		const pi = createMockPi();
		refreshPiReference(pi as unknown as ExtensionAPI);
		officialRunsFixture("dead");

		const result = await executeBash("echo fast");

		const wrapped = officialExecuteMock.mock.calls[0]![1] as { command: string };
		const p = parseWrapped(wrapped.command);
		// 不登记、零感知
		expect(getAllTasks()).toHaveLength(0);
		expect(readRegistry(getRegistryPath(DATA_DIR, SESSION_ID)).get(p.taskId)).toBeUndefined();
		// 三文件删除（B2 无登记条目则文件无消费方，输出已官方管道完整透传）
		expect(existsSync(p.cmdSh)).toBe(false);
		expect(existsSync(p.pidfile)).toBe(false);
		expect(existsSync(p.log)).toBe(false);
		// 结果透传，无补标记
		expect(resultText(result)).not.toContain("[TAIJI-FG-BG]");
		expect(pi.events.emit).not.toHaveBeenCalled();
	});

	it("pidfile missing (wrapper killed in spawn window) → no registration, best-effort cleanup, no crash", async () => {
		officialExecuteMock.mockImplementation(async () => ({
			content: [{ type: "text" as const, text: "wrapper died early" }],
			details: undefined,
		}));

		const result = await executeBash("echo x");

		expect(resultText(result)).toBe("wrapper died early");
		expect(getAllTasks()).toHaveLength(0);
		// cmd.sh 尽力清理；目录内无本次调用残留（pidfile/log 本就不存在）
		expect(existsSync(join(TASKS_DIR))).toBe(true);
	});

	it("收尾窗口死亡形态: 标记行存在 + pid 已死 → 照常登记 + 日志保留 + 守望通知兑现（exit code unknown），结果不重复补标记", { timeout: 20_000 }, async () => {
		const pi = createMockPi();
		refreshPiReference(pi as unknown as ExtensionAPI);
		// wrapper 已打印标记行（结果含 [TAIJI-FG-BG]）+ 命令恰在收尾窗口死亡
		// （fixture dead：pidfile 指向已收殓的 pid）——修复前判死即清理三文件：
		// 标记行的 "It will notify on completion" 承诺落空（无登记无守望无通知）、
		// 标记行引用的日志路径也被删
		officialRunsFixture(
			"dead",
			'ran: ...\n[TAIJI-FG-BG] Command moved to background after 600s without output — still running (wrapper printed marker).',
		);

		const result = await executeBash("echo done");

		// 标记行在 = 承诺在 = 必登记（判死也不清理）
		const task = getAllTasks()[0];
		expect(task).toBeDefined();
		expect(task?.state).toBe("running");
		expect(task?.command).toBe("echo done");
		// 三文件保留：日志是标记行引用路径 + bash_output 数据源 + 通知 tail 数据源
		expect(existsSync(task!.outputFile)).toBe(true);
		expect(existsSync(join(TASKS_DIR, `${task!.taskId}.sh`))).toBe(true);
		expect(existsSync(join(TASKS_DIR, `${task!.taskId}.pid`))).toBe(true);
		// 结果透传不重复补标记（wrapper 已打印 → 恰 1 处，与 B5 补标记逻辑双向闭合）
		expect(resultText(result).match(/\[TAIJI-FG-BG\]/g)).toHaveLength(1);

		// 守望首轮（2s 轮询）ESRCH 收尾 → 完成通知到达，退出码如实报 unknown
		// （转后台任务退出码结构性不可得，notify.ts 已登记形态）
		await vi.waitFor(
			() => {
				expect(pi.sendMessage).toHaveBeenCalled();
			},
			{ timeout: 8_000 },
		);
		const notified = pi.sendMessage.mock.calls[0]![0] as { customType: string; content: string };
		expect(notified.customType).toBe("background-bash");
		expect(notified.content).toContain(`[background-bash] ${task!.taskId} finished (exit code unknown`);
		expect(notified.content).toContain("echo done");
		// 收尾链同轮完成：pending:unregister emit + 终态落定（exited）
		expect(pi.events.emit).toHaveBeenCalledWith(
			"pending:unregister",
			expect.objectContaining({ id: task!.taskId, reason: "unknown" }),
		);
		expect(getTask(task!.taskId)?.state).toBe("exited");
		// 日志在通知后仍保留（bash_output 可查，不随收尾删除）
		expect(existsSync(task!.outputFile)).toBe(true);
	});
});

// ──────────── execute 抛错路径的收尾（B2 abort 前置判定）────────────

describe.skipIf(!INTEGRATION_TESTS_ENABLED)("execute error path catch settle (abort × 非 abort)", () => {
	/**
	 * mock：真跑 fixture（alive——写活 pidfile：sleep 30 存活进程）后抛错。复刻 pi
	 * abort 组杀后的僵尸窗口：命令进程被杀但未被系统收尸，isPidAlive 仍返回 true——
	 * 若收尾错误地走判活路径会读到活 pid 误登记（B2 缺陷形态）。onPidfile 回调捕获
	 * fixture pid 供测试收尾清理（三文件删除后 pidfile 不再可读）。
	 */
	function officialRunsFixtureThenThrow(onPidfile: (pid: number) => void): void {
		officialExecuteMock.mockImplementation(async (_id: string, args: { command: string }) => {
			expect(args.command).toContain(resolveFgWrapScriptPath());
			const fixtureCommand = args.command.replace(
				`'${resolveFgWrapScriptPath()}'`,
				`'${FIXTURE_PATH}'`,
			);
			await new Promise<void>((resolve, reject) => {
				const child = spawn("bash", ["-c", fixtureCommand], {
					env: { ...process.env, FIXTURE_MODE: "alive" },
					stdio: "ignore",
				});
				child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`))));
				child.on("error", reject);
			});
			const p = parseWrapped(args.command);
			const pid = parsePidFile(p.pidfile).pid;
			if (pid !== undefined) onPidfile(pid);
			throw new Error("Bash command aborted");
		});
	}

	it("B4 用户中止形态: abort 抛错（signal.aborted=true）→ 跳过判活收尾，不登记 + 三文件删除 + 无通知（设计矩阵 B4「用户中止无登记」）", async () => {
		const pi = createMockPi();
		refreshPiReference(pi as unknown as ExtensionAPI);
		let fixturePid: number | undefined;
		officialRunsFixtureThenThrow((pid) => {
			fixturePid = pid;
		});

		// 官方式错误原样上抛（不吞不改写）
		await expect(executeBash("sleep 30", {}, AbortSignal.abort())).rejects.toThrow("Bash command aborted");

		const wrapped = officialExecuteMock.mock.calls[0]![1] as { command: string };
		const p = parseWrapped(wrapped.command);
		// 不登记（僵尸窗口内 pid 判活为 true，判活收尾会误登记——abort 前置判定跳过）
		expect(getAllTasks()).toHaveLength(0);
		expect(readRegistry(getRegistryPath(DATA_DIR, SESSION_ID)).get(p.taskId)).toBeUndefined();
		// 三文件删除（直接清理，复用 settle 判死分支逻辑）
		expect(existsSync(p.cmdSh)).toBe(false);
		expect(existsSync(p.pidfile)).toBe(false);
		expect(existsSync(p.log)).toBe(false);
		// 无通知链路任何一环（无登记 → 无 pending:register / 无守望 → 无 unregister / sendMessage）
		expect(pi.events.emit).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		// fixture 残留清理（sleep 30 未被收尾路径处理）
		if (fixturePid !== undefined) {
			try {
				process.kill(-fixturePid, "SIGKILL");
			} catch {
				try {
					process.kill(fixturePid, "SIGKILL");
				} catch {
					// already dead
				}
			}
		}
	});

	it("B2 对照: 非 abort 抛错（无 signal）→ settle 照走判活收尾，活 pid 仍登记（spawn 失败等形态现行语义不变）", async () => {
		const pi = createMockPi();
		refreshPiReference(pi as unknown as ExtensionAPI);
		officialRunsFixtureThenThrow(() => {});

		await expect(executeBash("sleep 30")).rejects.toThrow("Bash command aborted");

		// fixture alive：pid 判活为 true → 照常登记（错误上抛但任务接管，B5 兜底语义）
		expect(getAllTasks()).toHaveLength(1);
		expect(getAllTasks()[0]?.state).toBe("running");
		expect(pi.events.emit).toHaveBeenCalledWith(
			"pending:register",
			expect.objectContaining({ id: getAllTasks()[0]!.taskId }),
		);
	});
});

// ──────────────── registerConvertedTask 集成（断言 #11 + 超时接线）────────────────

describe.skipIf(!INTEGRATION_TESTS_ENABLED)("registerConvertedTask (断言 #11)", () => {
	it("three-step registration lands: in-memory table + registry entry + pending:register emit", () => {
		const pi = createMockPi();
		refreshPiReference(pi as unknown as ExtensionAPI);

		const task = registerConvertedTask({
			taskId: "bt-1700000000-rct001",
			pid: 4242424, // 不可达 pid（登记不判活——判活在改写层收尾已完成）
			command: "sleep 30 && echo done",
			dataDir: DATA_DIR,
			sessionId: SESSION_ID,
		});

		// ① 单例表（运行时权威）：running 条目计入 countActiveTasks
		expect(getTask(task.taskId)?.state).toBe("running");
		expect(countActiveTasks()).toBe(1);
		expect(task.child).toBeUndefined(); // 无 child 句柄（exit 感知归守望）
		// pidStartTime 同源直读 ps：不可达 pid 读不到 → 条目省略该字段（消费方降级
		// startedAt 秒级校验兜底，不报错不阻断）
		expect(task.pidStartTime).toBeUndefined();
		// ② registry 落盘 running 条目
		const entry = readRegistry(getRegistryPath(DATA_DIR, SESSION_ID)).get(task.taskId);
		expect(entry).toMatchObject({
			taskId: task.taskId,
			pid: 4242424,
			state: "running",
			ownerPiPid: process.pid,
		});
		expect(entry).not.toHaveProperty("pidStartTime");
		// ③ pending:register emit（session_start 差集对账前提）
		expect(pi.events.emit).toHaveBeenCalledWith("pending:register", {
			id: task.taskId,
			type: "bash",
			name: "sleep 30 && echo done",
		});
	});

	it("pool full: converted registration is NOT rejected and occupies the pool (countActiveTasks)", () => {
		// 塞满默认池（maxConcurrentBackground 默认 8）——转后台登记不过并发门：
		// 拒绝登记 = 标记行已打印而任务不存在 + 孤儿进程（设计 §5 部件 2 并发池关系）
		const poolFillers: BackgroundTask[] = [];
		for (let i = 0; i < 8; i++) {
			const filler: BackgroundTask = {
				taskId: `bt-1700000000-pool${String(i).padStart(2, "0")}`,
				pid: 4000000 + i,
				command: `sleep ${i}`,
				outputFile: join(TASKS_DIR, `pool-${i}.log`),
				registryPath: getRegistryPath(DATA_DIR, SESSION_ID),
				startedAt: 1000 + i,
				state: "running",
				ownerPiPid: process.pid,
				sessionId: SESSION_ID,
			};
			registerSpawnedTask(filler);
			poolFillers.push(filler);
		}
		expect(countActiveTasks()).toBe(8);

		const task = registerConvertedTask({
			taskId: "bt-1700000000-poolov",
			pid: 4242424,
			command: "echo overflow",
			dataDir: DATA_DIR,
			sessionId: SESSION_ID,
		});

		expect(getTask(task.taskId)?.state).toBe("running");
		expect(countActiveTasks()).toBe(9); // 登记进表即为 running、占用池
	});

	it("backgroundTimeoutSeconds wiring: armBackgroundTimeout timer armed on the converted task", () => {
		vi.useFakeTimers();
		const task = registerConvertedTask({
			taskId: "bt-1700000000-rctto1",
			pid: 4242424,
			command: "echo to",
			dataDir: DATA_DIR,
			sessionId: SESSION_ID,
			timeoutSec: 60,
		});

		// 矩阵 C2 接线：漏接则转后台任务不受后台超时约束
		expect(task.timeoutTimer).toBeDefined();
	});

	it("pidStartTime source: read from the live process via getProcessStartTimeSec — identity check passes (same clock source)", () => {
		// 回归防护（U1 同源修复）：登记值必须与守望/bash_kill/超时身份校验同一时钟源
		// （ps lstart）。曾采信 pidfile 的 wrapper 墙钟近似值（跨秒边界比真实值大 1），
		// pidStartMatchesRegistered 严格相等无容差 → 守望首轮误判 pid 复用，对在跑
		// 任务假终态 + 假完成通知（exit code unknown）+ 任务脱离可杀可查
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		child.unref();
		const pid = child.pid!;
		try {
			const task = registerConvertedTask({
				taskId: "bt-1700000000-rctps1",
				pid,
				command: "echo ps",
				dataDir: DATA_DIR,
				sessionId: SESSION_ID,
			});
			expect(typeof task.pidStartTime).toBe("number");
			expect(task.pidStartTime).toBeGreaterThan(0);
			// 与消费方同源同值：pidStartMatchesRegistered（守望/超时身份校验同一谓词）判 true
			const actualStartSec = getProcessStartTimeSec(pid);
			expect(actualStartSec).toBeDefined();
			expect(pidStartMatchesRegistered(actualStartSec!, task.pidStartTime, task.startedAt)).toBe(true);
		} finally {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already dead
				}
			}
		}
	});
});
