// src/__tests__/subagent-guard.test.ts
//
// subagent-guard 判据钉值（ext-simplify-17 D4 重锚定后）：
//   - TAIJI_AGENT_SUBAGENT === "1" 命中（引擎 spawn 链恒注入的现行标记）
//   - 其他值 / 缺失不命中（顶层会话不误降级，background 正常后台化）
//
// [HISTORICAL] 对照（D4 重锚前的旧行为）：旧判据查 PI_SUBAGENT_* 身份键族两枚、
// 任一存在即命中——该键族已无写入方，旧判据实际恒 false（降级从未生效）。旧键
// 不命中的钉值在 ext-guards predicates 测试（谓词实现方领地），此处只钉 bte
// 消费方的现行语义。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 断言 #7（A6 判定）需要经 bash override 的 execute 走真实判定链——pi 工厂 mock 隔离
const { createBashToolDefinitionMock, officialExecuteMock, agentDirRef } = vi.hoisted(() => ({
	createBashToolDefinitionMock: vi.fn(),
	officialExecuteMock: vi.fn(),
	agentDirRef: { dir: "/tmp/bte-fake-agent-dir" },
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: createBashToolDefinitionMock,
	getAgentDir: () => agentDirRef.dir,
}));

import { clearConfigCache } from "@zhushanwen/pi-llm-shared";

import { createBashOverrideToolDefinition } from "../bash-tool.ts";
import { clearExitWatchesForTest } from "../background/exit-watch.ts";
import { resetNotifyForTest } from "../background/notify.ts";
import { clearTaskStoreForTest, getAllTasks } from "../background/task-store.ts";
import { isSubagentProcess } from "../background/subagent-guard.ts";

describe("isSubagentProcess（subagent-guard，D4 重锚后）", () => {
	it("TAIJI_AGENT_SUBAGENT=1 命中（引擎链 subagent → D14 background 降级前提恢复）", () => {
		expect(isSubagentProcess({ TAIJI_AGENT_SUBAGENT: "1" })).toBe(true);
	});

	it("值非 \"1\" 不命中", () => {
		expect(isSubagentProcess({ TAIJI_AGENT_SUBAGENT: "0" })).toBe(false);
		expect(isSubagentProcess({ TAIJI_AGENT_SUBAGENT: "" })).toBe(false);
	});

	it("缺失不命中（顶层会话 → background 正常后台化，guard 不误命中）", () => {
		expect(isSubagentProcess({})).toBe(false);
	});
});

// ── 断言 #7（foreground-idle-to-background）：子代理内机制全灭——矩阵 A6 判定：
//    subagent 进程内无超时前台命令不包装（A5 前置例外）、不登记、白名单/background
//    双失效（D14 全量降级语义零变化）──

describe("A6: subagent in-process mechanisms all off (断言 #7)", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "bte-subguard-"));
	const configTempDirs: string[] = [];

	function useConfig(config: Record<string, unknown>): void {
		const dir = mkdtempSync(join(tmpdir(), "bte-subguard-cfg-"));
		configTempDirs.push(dir);
		agentDirRef.dir = dir;
		const configPath = join(dir, "config", "base-tool-enhance-ext-config.json");
		mkdirSync(join(configPath, ".."), { recursive: true });
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		clearConfigCache();
	}

	function setupFactory() {
		createBashToolDefinitionMock.mockReset();
		officialExecuteMock.mockReset();
		createBashToolDefinitionMock.mockImplementation((_cwd: string) => ({
			name: "bash",
			label: "bash",
			description: `official for ${_cwd}`,
			promptSnippet: "snippet",
			promptGuidelines: [],
			parameters: { type: "object", properties: {} },
			execute: officialExecuteMock,
		}));
		officialExecuteMock.mockImplementation(async (_id: string, args: { command: string }) => ({
			content: [{ type: "text" as const, text: `ran: ${args.command}` }],
			details: undefined,
		}));
	}

	beforeEach(() => {
		setupFactory();
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", dataDir);
	});

	afterEach(() => {
		clearExitWatchesForTest();
		clearTaskStoreForTest();
		resetNotifyForTest();
		agentDirRef.dir = "/tmp/bte-fake-agent-dir";
		for (const dir of configTempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
		delete process.env.TAIJI_AGENT_SUBAGENT;
		clearConfigCache();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	async function execute(command: string, extra: Record<string, unknown> = {}) {
		const tool = createBashOverrideToolDefinition();
		return tool.execute(
			"call-sub",
			{ command, ...extra },
			undefined,
			undefined,
			{ cwd: "/tmp/bte-subguard-workdir", sessionManager: { getSessionId: () => "sess-sub" } } as never,
		);
	}

	it("subagent + no timeout → native execution with ORIGINAL command (no wrapper, no registration)", async () => {
		process.env.TAIJI_AGENT_SUBAGENT = "1";

		await execute("sleep 30");

		// 官方委托收到命令原文（非包装命令串）——A6 不包装
		expect(officialExecuteMock).toHaveBeenCalledWith(
			"call-sub",
			{ command: "sleep 30", timeout: undefined },
			undefined,
			undefined,
			expect.anything(),
		);
		expect(officialExecuteMock.mock.calls[0]![1] as { command: string }).toMatchObject({ command: "sleep 30" });
		// 不登记（A6 不包装不登记）
		expect(getAllTasks()).toHaveLength(0);
	});

	it("subagent + background:true + whitelist hit → both degraded (D14), native foreground", async () => {
		process.env.TAIJI_AGENT_SUBAGENT = "1";

		const result = await execute("npm test", { background: true });

		const text = (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "";
		// 白名单不生效（无 Forced to background 注记）、background 忽略 → 前台同步语义
		expect(text).toContain("ran: npm test");
		expect(text).not.toContain("Forced to background");
		expect(officialExecuteMock).toHaveBeenCalledTimes(1);
		expect(getAllTasks()).toHaveLength(0);
	});

	it("对照（非 subagent）: 同命令无超时 → A5 包装（判定差异即 subagent 降级的边界）", async () => {
		await execute("sleep 30");

		const forwarded = officialExecuteMock.mock.calls[0]![1] as { command: string };
		// A5 包装形态（含 wrapper 路径与 --task-id）——与 subagent 用例的原文透传形成对照
		expect(forwarded.command).toContain("--task-id bt-");
		expect(forwarded.command).toContain("--idle");
	});
});

