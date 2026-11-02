// src/__tests__/index.test.ts —— 入口集成：工具注册（bash / bash_output / bash_kill）+
// 审计 hook 挂载 + M3 接线（D17 引用刷新 / exit 边沿通知 / session_start 对账链）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createBashToolDefinitionMock, dataDirRef, subagentServiceRef, dispatchResumeReconcileMock } = vi.hoisted(() => ({
	createBashToolDefinitionMock: vi.fn(),
	dataDirRef: { dir: "/tmp/bte-fake-agent-dir" },
	// [A5 缺陷修复回归] 切回入口 subagent 域对账转发的单例桩——mock 包级单例访问器
	//（真单例由 subagent-workflow 装配链 session_start 时创建，本测试面只锁转发行为）。
	subagentServiceRef: { current: null as unknown },
	// [U2 修复回归] 两域（session-manager / subagent-workflow）切回对账转发 = 经
	// delivery-port 进程级注册槽派发。mock 槽派发函数锁「handler 转发面」；两域
	// 订阅行为在各自扩展包的装配测试锁（真实槽行为在 delivery-port 包锁）。
	dispatchResumeReconcileMock: vi.fn((): Array<{ domain: string; error: unknown }> => []),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: createBashToolDefinitionMock,
}));
vi.mock("@zhushanwen/subagent-core", () => ({
	getSubagentService: () => subagentServiceRef.current,
}));
vi.mock("@zhushanwen/pi-delivery-port", async (importOriginal) => {
	// 部分替身：bindDeliveryPort / createPiDeliveryPortHost 等保真（session_start
	// 装配链依赖），只替 dispatchResumeReconcile（本测试面的观察点）。
	const actual = await importOriginal<typeof import("@zhushanwen/pi-delivery-port")>();
	return { ...actual, dispatchResumeReconcile: dispatchResumeReconcileMock };
});

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getRegistryPath, writeRegistryEntry } from "../background/registry.ts";
import { resetNotifyForTest } from "../background/notify.ts";
import baseToolEnhanceExtension from "../index.ts";

function createMockPi() {
	return {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		// pi 1.0.0 契约：on 返回退订函数（delivery-port 装配在 session_start 重绑时
		// dispose 旧实例兑现退订——mock 需符合真契约，否则重绑 dispose 对 undefined
		// 退订函数调用即 TypeError；maintenance-once.test.ts 同款形态）
		on: vi.fn(() => () => {}),
		appendEntry: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn() },
		sendMessage: vi.fn(),
	};
}

function setupOfficialFactory() {
	createBashToolDefinitionMock.mockReset();
	createBashToolDefinitionMock.mockReturnValue({
		name: "bash",
		label: "bash",
		description: "official",
		parameters: {},
		execute: vi.fn(),
	});
}

describe("baseToolEnhanceExtension entry", () => {
	it("registers bash (override), bash_output and bash_kill tools by name", () => {
		setupOfficialFactory();
		const pi = createMockPi();

		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		expect(pi.registerTool).toHaveBeenCalledTimes(3);
		const names = pi.registerTool.mock.calls.map((call) => (call[0] as { name: string }).name);
		expect(names).toEqual(["bash", "bash_output", "bash_kill"]);
	});

	it("mounts the tool error audit hook", () => {
		setupOfficialFactory();
		const pi = createMockPi();

		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		expect(pi.on).toHaveBeenCalledWith("tool_execution_end", expect.any(Function));
	});

	it("registers a session_start handler (reconcile chain, M3)", () => {
		setupOfficialFactory();
		const pi = createMockPi();

		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
	});

	it("registers the __taiji_bg_reconcile__ internal command with a non-empty description", () => {
		setupOfficialFactory();
		const pi = createMockPi();

		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		expect(pi.registerCommand).toHaveBeenCalledTimes(1);
		const [name, def] = pi.registerCommand.mock.calls[0] as [
			string,
			{ description: string; handler: (args: string, ctx: unknown) => Promise<void> },
		];
		expect(name).toBe("__taiji_bg_reconcile__");
		expect(typeof def.description).toBe("string");
		expect(def.description.length).toBeGreaterThan(0);
		expect(typeof def.handler).toBe("function");
	});
});

describe("__taiji_bg_reconcile__ command: runtime-resume trigger face", () => {
	it("handler runs the same maintenance chain as session_start (zombie settle via appendEntry on the SAME pi reference)", async () => {
		setupOfficialFactory();
		// 独立临时 dataDir（同 session_start 用例：维护链只读不扫），registry 预置终态僵尸条目。
		// 维护链 dataDir 来源 = resolveTaijiDataDir()（env，session-store-layout-inversion 域 5）
		const dataDir = mkdtempSync(join(tmpdir(), "bte-bgcmd-"));
		dataDirRef.dir = dataDir;
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", dataDir);
		try {
			const sessionId = "sess-bgcmd";
			writeRegistryEntry(getRegistryPath(dataDir, sessionId), {
				taskId: "bt-1700000000-bgc001",
				pid: 12345,
				command: "sleep 3600",
				outputFile: "/tmp/bgc.log",
				startedAt: 1_700_000_000_000,
				state: "orphaned",
				ownerPiPid: 1,
				sessionId,
			});
			const pi = createMockPi();
			baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

			const [, def] = pi.registerCommand.mock.calls[0] as [
				string,
				{ description: string; handler: (args: string, ctx: unknown) => Promise<void> },
			];
			// handler 返回维护链 promise（runtime 侧 fire-and-forget 消费；本测试 await 落定）
			await def.handler("", {
				sessionManager: {
					getSessionId: () => sessionId,
					// getSessionFile = undefined（no-persist mock 形态）：A1 修复后维护链
					// 新读该成员传对账第 6 参（补投判据磁盘事实源；undefined 退化内存账）
					getSessionFile: () => undefined,
					getEntries: () => [
						{
							customType: "pending:register",
							data: { id: "bt-1700000000-bgc001", type: "bash", name: "sleep 3600" },
						},
					],
				},
			});

			expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
				id: "bt-1700000000-bgc001",
				reason: "cancelled",
				status: "cancelled",
			});
			expect(pi.events.emit).not.toHaveBeenCalled();
		} finally {
			rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
			dataDirRef.dir = "/tmp/bte-fake-agent-dir";
			vi.unstubAllEnvs();
			resetNotifyForTest();
		}
	});
});

// [A5 product-bug 修复回归] 切回入口 subagent 域对账转发（completion-signal-delivery
// V4b 入口③）：漏挂本转发 = 组 a 切回零补投的缺陷形态（RL14 三入口的扩展侧落位）。
// 转发通道 = 进程单例 SubagentService.runNotifyReconcileMaintenance（事实源与补投出口
// 在服务内装配，扩展侧无法直构 deps）；只挂本入口，session_start / agent_settled 两
// 边沿服务内已自挂（revive / agent_settled 订阅），重复转发 = 同边沿双派发。
describe("__taiji_bg_reconcile__ command: subagent-domain reconcile forward (V4b entry ③)", () => {
	it("handler forwards the subagent reconcile via the service singleton exactly once with reason=resume", async () => {
		setupOfficialFactory();
		const service = { runNotifyReconcileMaintenance: vi.fn() };
		subagentServiceRef.current = service;
		try {
			const pi = createMockPi();
			baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

			const [, def] = pi.registerCommand.mock.calls[0] as [
				string,
				{ description: string; handler: (args: string, ctx: unknown) => Promise<void> },
			];
			await def.handler("", {
				sessionManager: {
					getSessionId: () => "sid-subagent-fwd",
					getSessionFile: () => undefined,
					getEntries: () => [],
				},
			});

			expect(service.runNotifyReconcileMaintenance).toHaveBeenCalledTimes(1);
			expect(service.runNotifyReconcileMaintenance).toHaveBeenCalledWith("resume");
		} finally {
			subagentServiceRef.current = null;
		}
	});

	it("session_start / agent_settled edges do NOT forward (self-wired inside the service)", async () => {
		setupOfficialFactory();
		const service = { runNotifyReconcileMaintenance: vi.fn() };
		subagentServiceRef.current = service;
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", dataDirRef.dir);
		try {
			const pi = createMockPi();
			baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

			const sessionStart = pi.on.mock.calls.find((call) => call[0] === "session_start")?.[1] as (
				event: unknown,
				ctx: unknown,
			) => Promise<void>;
			const agentSettled = pi.on.mock.calls.find((call) => call[0] === "agent_settled")?.[1] as (
				event: unknown,
				ctx: unknown,
			) => Promise<void>;
			expect(sessionStart).toBeTypeOf("function");
			expect(agentSettled).toBeTypeOf("function");
			const ctx = {
				sessionManager: {
					getSessionId: () => "sid-no-fwd",
					getSessionFile: () => undefined,
					getEntries: () => [],
				},
			};
			await sessionStart({ type: "session_start", reason: "resume" }, ctx);
			await agentSettled({}, ctx);

			expect(service.runNotifyReconcileMaintenance).not.toHaveBeenCalled();
		} finally {
			subagentServiceRef.current = null;
			vi.unstubAllEnvs();
		}
	});

	it("absent service singleton (pre-initSession window) is tolerated — handler still resolves", async () => {
		setupOfficialFactory();
		subagentServiceRef.current = null;
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", dataDirRef.dir);
		try {
			const pi = createMockPi();
			baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

			const [, def] = pi.registerCommand.mock.calls[0] as [
				string,
				{ description: string; handler: (args: string, ctx: unknown) => Promise<void> },
			];
			// 单例缺席（session_start 前进程形态 / 无 subagent 域宿主）= 对账不挂（缺席
			// 语义非错误）：可选链早退，handler 不抛、bash 域维护链照常落定。
			await expect(
				def.handler("", {
					sessionManager: {
						getSessionId: () => "sid-absent",
						getSessionFile: () => undefined,
						getEntries: () => [],
					},
				}),
			).resolves.toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

// [U2 修复回归] 切回入口两域（session-manager / subagent-workflow）对账转发
// （completion-signal-delivery D8② 三入口同构的切回边沿）：漏挂本转发 = 两域
// 「切走再切回同进程」场景补投不触发（延迟至下一 agent_settled 或重启
// session_start）的缺陷形态。转发通道 = pi-delivery-port 进程级注册槽
// dispatchResumeReconcile（两域 extension load 时订阅；两域与 base-tool-enhance
// 无依赖边，槽是三方共同依赖包内的转发通道）。
describe("__taiji_bg_reconcile__ command: two-domain reconcile dispatch via delivery-port slot (D8② entry ③)", () => {
	// 共享模块 mock：调用历史每用例清零（前面用例的 handler 派发不串入计数断言）
	beforeEach(() => {
		dispatchResumeReconcileMock.mockClear();
	});

	it("handler dispatches the slot exactly once, forwarding the command ctx as-is", async () => {
		setupOfficialFactory();
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", dataDirRef.dir);
		try {
			const pi = createMockPi();
			baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

			const [, def] = pi.registerCommand.mock.calls[0] as [
				string,
				{ description: string; handler: (args: string, ctx: unknown) => Promise<void> },
			];
			const ctx = {
				sessionManager: {
					getSessionId: () => "sid-two-domain-fwd",
					getSessionFile: () => undefined,
					getEntries: () => [],
				},
			};
			await def.handler("", ctx);

			expect(dispatchResumeReconcileMock).toHaveBeenCalledTimes(1);
			expect(dispatchResumeReconcileMock).toHaveBeenCalledWith(ctx);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("slot listener failures do not block the handler (per-domain fence; bash-domain maintenance chain still settles)", async () => {
		setupOfficialFactory();
		dispatchResumeReconcileMock.mockReturnValueOnce([
			{ domain: "session-manager", error: new Error("fence leak") },
		]);
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", dataDirRef.dir);
		try {
			const pi = createMockPi();
			baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

			const [, def] = pi.registerCommand.mock.calls[0] as [
				string,
				{ description: string; handler: (args: string, ctx: unknown) => Promise<void> },
			];
			// 单域失败（域侧围栏漏网的防御位）不阻断其余域与 bash 域维护链：handler
			// 正常落定（失败清单由 handler 逐条 warn 留痕，不向 runtime 上抛）。
			await expect(
				def.handler("", {
					sessionManager: {
						getSessionId: () => "sid-slot-failure",
						getSessionFile: () => undefined,
						getEntries: () => [],
					},
				}),
			).resolves.toBeUndefined();
			expect(dispatchResumeReconcileMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("session_start / agent_settled edges do NOT dispatch the slot (two domains self-wire those edges)", async () => {
		setupOfficialFactory();
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", dataDirRef.dir);
		try {
			const pi = createMockPi();
			baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

			const sessionStart = pi.on.mock.calls.find((call) => call[0] === "session_start")?.[1] as (
				event: unknown,
				ctx: unknown,
			) => Promise<void>;
			const agentSettled = pi.on.mock.calls.find((call) => call[0] === "agent_settled")?.[1] as (
				event: unknown,
				ctx: unknown,
			) => Promise<void>;
			expect(sessionStart).toBeTypeOf("function");
			expect(agentSettled).toBeTypeOf("function");
			const ctx = {
				sessionManager: {
					getSessionId: () => "sid-no-slot-dispatch",
					getSessionFile: () => undefined,
					getEntries: () => [],
				},
			};
			await sessionStart({ type: "session_start", reason: "resume" }, ctx);
			await agentSettled({}, ctx);

			expect(dispatchResumeReconcileMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("session_start chain: reconcile (M3, reap sunk into runtime by u-bte-remove)", () => {
	it("settles a zombie register via appendEntry on the SAME pi reference", async () => {
		setupOfficialFactory();
		// 独立临时 dataDir（维护链只读不扫：收殓已下沉 runtime），registry 预置终态僵尸条目。
		// 维护链 dataDir 来源 = resolveTaijiDataDir()（env，session-store-layout-inversion 域 5）
		const dataDir = mkdtempSync(join(tmpdir(), "bte-index-"));
		dataDirRef.dir = dataDir;
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", dataDir);
		try {
			const sessionId = "sess-index";
			writeRegistryEntry(getRegistryPath(dataDir, sessionId), {
				taskId: "bt-1700000000-idx001",
				pid: 12345,
				command: "sleep 3600",
				outputFile: "/tmp/idx.log",
				startedAt: 1_700_000_000_000,
				state: "orphaned",
				ownerPiPid: 1,
				sessionId,
			});
			const pi = createMockPi();
			baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

			const handler = pi.on.mock.calls.find((call) => call[0] === "session_start")?.[1] as (
				event: unknown,
				ctx: { sessionManager: { getSessionId: () => string; getEntries: () => unknown[]; getSessionFile: () => string | undefined } },
			) => void;
			expect(handler).toBeDefined();
			// pi runner emit session_start 必带事件（SessionStartEvent.reason 必填，
			// pi 0.84.4 实装核实）——维护链入口日志消费 reason
			handler({ type: "session_start", reason: "resume" }, {
				sessionManager: {
					getSessionId: () => sessionId,
					// getSessionFile = undefined（no-persist mock 形态，同 __taiji_bg_reconcile__ 用例注）
					getSessionFile: () => undefined,
					getEntries: () => [
						{
							customType: "pending:register",
							data: { id: "bt-1700000000-idx001", type: "bash", name: "sleep 3600" },
						},
					],
				},
			});

			// handler 同步直跑对账（u-bte-remove 后无 reap await）——等待落定
			await vi.waitFor(() =>
				expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
					id: "bt-1700000000-idx001",
					reason: "cancelled",
					status: "cancelled",
				}),
			);
			// 尽力补 emit 已随 ext-simplify-13 删除（恒 no-op 死路径）——对账后不得有任何
			// bus emit，appendEntry 即唯一权威路径
			expect(pi.events.emit).not.toHaveBeenCalled();
		} finally {
			rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
			dataDirRef.dir = "/tmp/bte-fake-agent-dir";
			vi.unstubAllEnvs();
			resetNotifyForTest();
		}
	});
});
