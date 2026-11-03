// src/__tests__/maintenance-once.test.ts —— 收殓下沉后的 session_start 维护链
// 语义（实施单元 u-bte-remove：extension 删 session_start reaper，批 2 后
// reap 类操作不再执行）：
//  - reconcilePendingEntries 是 session 级豁免类，每 session_start 派发都执行
//    （startup/resume/new 多派发 ×N——含 factory 二调 handler 累积的真实形态）
//  - 触发点消失：reaper.ts 模块文件已删除（文件级断言，见首条用例）+ 维护链不再触发
//    全局文件锁（原 reapOrphanedTasks 的 reaper.lock 路径随模块删除一并消失）
//  - 入口无条件 debug 日志按派发次数出现，detail 仅含 reason（reapSkipped 字段
//    随 reap 调用移除，S6 观测通道语义更新）
// 断言方式：reconcile / logger 间谍注入观察调用次数与参数；file-lock 为 mock
// 缺键检查 + withFileLockSync throw 哨兵（不计数）。
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { reconcileMock, loggerMock, officialBashFactoryMock, dataDirRef } =
	vi.hoisted(() => ({
		reconcileMock: vi.fn(),
		loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		officialBashFactoryMock: vi.fn(),
		dataDirRef: { dir: "/tmp/bte-fake-agent-dir" },
	}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: officialBashFactoryMock,
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
}));
// 检查形态 = mock 工厂缺键：包入口已删除的 async 锁导出不在工厂注册——维护链若
// 误回流，对已删导出的任何访问（调用与 typeof 均计）即抛错（vitest mock 缺键语义；
// 模块导入本身不抛）。withFileLockSync 哨兵保留：registry 写路径误入维护链即抛
vi.mock("@zhushanwen/pi-file-lock", () => ({
	withFileLockSync: vi.fn(() => {
		throw new Error("unexpected registry write in maintenance chain");
	}),
}));
vi.mock("../background/pending-reconcile.ts", () => ({
	reconcilePendingEntries: reconcileMock,
}));

import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";

// 顶层静态导入（index.test.ts / delivery-port-assembly.test.ts 同款）：extension 模块图
// 的一次性加载在文件作用域完成，不被记入首个用例的 junit 用例耗时（check-slow-tests
// 门禁按用例级耗时判定；vi.mock 工厂经 hoist 对静态导入同样生效，模块仍只初始化一次）
import baseToolEnhanceExtension from "../index.ts";

function createMockPi() {
	return {
		registerTool: vi.fn(),
		// __taiji_bg_reconcile__ 第二触发点（runtime 切回补投）注册桩——本文件只验证
		// session_start 入口，命令注册点断言在 index.test.ts
		registerCommand: vi.fn(),
		// pi 1.0.0 契约：on 返回退订函数（delivery-port 装配在 session_start 重绑时
		// dispose 旧实例兑现退订，mock 需符合真契约）
		on: vi.fn(() => () => {}),
		appendEntry: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn() },
		sendMessage: vi.fn(),
	};
}

function getSessionStartHandler(pi: ReturnType<typeof createMockPi>) {
	const handler = pi.on.mock.calls.find((call) => call[0] === "session_start")?.[1];
	expect(handler).toBeTypeOf("function");
	// handler 返回 promise（pi runner emit await handler 消费，维护链 async 形态——unified-delivery 波 3 口径，现行登记处 = ADR-0074 与 docs/CONTEXT.md『统一投递』段）
	return handler as (event: SessionStartEvent, ctx: unknown) => Promise<void>;
}

function makeEvent(reason: SessionStartEvent["reason"]): SessionStartEvent {
	return { type: "session_start", reason };
}

function makeCtx() {
	// getSessionFile = undefined（mock 的 no-persist 形态）：A1 修复后维护链新读
	// sessionManager.getSessionFile() 传对账第 6 参——undefined 时补投判据退化内存
	// entries（装配语义，见 pending-reconcile.ts）；本文件断言差集编排面，不触磁盘事实
	return {
		sessionManager: { getSessionId: () => "sid-once", getEntries: () => [], getSessionFile: () => undefined },
	};
}

beforeEach(() => {
	reconcileMock.mockReset();
	// 维护链 dataDir 来源 = resolveTaijiDataDir()（env，session-store-layout-inversion 域 5）：
	// getAgentDir mock 已随换根退役，改 stub env（dataDirRef.dir 仍是断言与 stub 的同一值源）
	vi.stubEnv("TAIJI_AGENT_DATA_DIR", dataDirRef.dir);
	// 官方 bash 工厂返回最小工具定义（override 定义 spread initial.name）
	officialBashFactoryMock.mockReset();
	officialBashFactoryMock.mockReturnValue({
		name: "bash",
		label: "bash",
		description: "official",
		parameters: {},
		execute: vi.fn(),
	});
	loggerMock.debug.mockClear();
	loggerMock.warn.mockClear();
	loggerMock.error.mockClear();
});

afterEach(() => {
	// env stub 逐用例还原（防同 worker 跨文件残留）
	vi.unstubAllEnvs();
});

describe("session_start maintenance chain after reap sink (u-bte-remove)", () => {
	it("no longer ships a reaper: the module is gone from the extension (trigger surface removed)", () => {
		// 等价改写（fallow unresolved-import）：原断言动态 import 已删除模块期待
		// rejects——静态分析无法理解故意性。模块文件不存在 ⟹ import 必 rejects，
		// 蕴含成立，断言价值不变（触发点消失），文件级判定更直接。路径用 join 逐段
		// 拼装：fallow 会把 ../reaper.ts 形态的相对路径字符串按 import specifier 扫描
		const reaperModulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "reaper.ts");
		expect(existsSync(reaperModulePath)).toBe(false);
	});

	it("runs reconcilePendingEntries on EVERY session_start dispatch (session-scoped exempt, D3)", async () => {
		const pi = createMockPi();
		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);
		const handler = getSessionStartHandler(pi);
		const ctx = makeCtx();

		// 多派发覆盖真实形态：startup + resume 双发（桌面端每次激活）+ new；
		// factory 二调 handler 累积时同一事件被多组 handler 各跑一次，同理多次执行
		await handler(makeEvent("startup"), ctx);
		await handler(makeEvent("resume"), ctx);
		await handler(makeEvent("new"), ctx);

		expect(reconcileMock).toHaveBeenCalledTimes(3);
		// 6 参全形（A1 修复后签名）：deliver/sessionFile 尾参 = 缺省 undefined 形态锁定
		expect(reconcileMock).toHaveBeenNthCalledWith(1, expect.anything(), dataDirRef.dir, "sid-once", [], undefined, undefined);
		expect(reconcileMock).toHaveBeenLastCalledWith(expect.anything(), dataDirRef.dir, "sid-once", [], undefined, undefined);
		// 无全局扫描回流：误触发已删锁导出的任何访问会被 mock 缺键直接抛错（检查见工厂注释），无告警
		expect(loggerMock.warn).not.toHaveBeenCalled();
	});

	it("emits the unconditional entry debug log per dispatch with reason only (S6 observation channel)", async () => {
		const pi = createMockPi();
		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);
		const handler = getSessionStartHandler(pi);
		const ctx = makeCtx();

		await handler(makeEvent("startup"), ctx);
		await handler(makeEvent("resume"), ctx);

		// 每次派发恰好一条入口日志（无条件 = 不以任何条件短路），reason 取自事件；
		// reapSkipped 字段已随 reap 下沉移除（u-bte-remove 变更登记，S6「批 2 后
		// reap 类操作不再执行」）
		expect(loggerMock.debug).toHaveBeenCalledTimes(2);
		expect(loggerMock.debug).toHaveBeenNthCalledWith(1, "reconcile maintenance dispatch", {
			detail: { reason: "startup" },
		});
		expect(loggerMock.debug).toHaveBeenNthCalledWith(2, "reconcile maintenance dispatch", {
			detail: { reason: "resume" },
		});
	});

	it("keeps reconcile failures non-fatal: handler promise resolves, warn logged", async () => {
		// async 化后的非致命语义（unified-delivery 防假绿改写，现行登记处 = ADR-0074 与 docs/CONTEXT.md『统一投递』段）：维护链已
		// async——同步 not.toThrow() 断言恒真，改为显式断言「handler 的 promise resolve
		//（错误在链内被 async 捕获，不向上传播成 unhandled rejection）+ warn 日志确实
		// 记录」。两个断言缺一即红：吞掉后不打日志 = 观测丢失；打日志但 reject = fire
		// 调用点 unhandled rejection。
		reconcileMock.mockImplementation(() => Promise.reject(new Error("reconcile boom")));
		const pi = createMockPi();
		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);
		const handler = getSessionStartHandler(pi);

		// 对账 reject 被维护链 async 捕获记 warn（僵尸停留差集，下一 session_start 幂等重查）
		await expect(handler(makeEvent("resume"), makeCtx())).resolves.toBeUndefined();
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"session_start pending reconcile failed; zombies retried next session start",
			expect.objectContaining({ detail: expect.objectContaining({ err: "reconcile boom" }) }),
		);
	});

	it("async chain surfaces synchronous setup errors through the same warn path", async () => {
		// 同步 throw（非 promise reject）走同一 catch：覆盖 getSessionId 抛错等装配期异常，
		// 锁定「try 块包住整个 await 链」不因 async 化出现裸同步段
		reconcileMock.mockImplementation(() => {
			throw new Error("sync boom");
		});
		const pi = createMockPi();
		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);
		const handler = getSessionStartHandler(pi);

		await expect(handler(makeEvent("resume"), makeCtx())).resolves.toBeUndefined();
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"session_start pending reconcile failed; zombies retried next session start",
			expect.objectContaining({ detail: expect.objectContaining({ err: "sync boom" }) }),
		);
	});
});

// ── agent_settled 回合收尾边沿（completion-signal-delivery D2/D7②：对账第三入口）──
// RL13：订阅在装配期（extension load 顶层）注册、每 pi 实例恰一次；同进程 session
// 替换重新 load 时旧实例连同订阅一并消亡（eventBus 重建），新实例重新注册——无死
// handler 累积。RL12：三入口（session_start / __taiji_bg_reconcile__ / agent_settled）
// 编排互调同一对账函数，对同一事实状态产出同一判定（此处锁编排面——参数一致；
// 判据真值面在 pending-reconcile.test.ts）。
describe("agent_settled edge: third reconcile entry (completion-signal-delivery D2/D7)", () => {
	function getAgentSettledHandler(pi: ReturnType<typeof createMockPi>) {
		const handler = pi.on.mock.calls.find((call) => call[0] === "agent_settled")?.[1];
		expect(handler).toBeTypeOf("function");
		return handler as (event: { type: "agent_settled" }, ctx: unknown) => Promise<void>;
	}

	it("registers exactly one agent_settled subscription at load time (RL13: per-instance single subscription)", async () => {
		const pi = createMockPi();
		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		const registrations = pi.on.mock.calls.filter((call) => call[0] === "agent_settled");
		expect(registrations).toHaveLength(1);
		// 重绑形态 = session 替换重新 load：新实例（新 mock pi）再 load 恰一次注册，
		// 旧实例订阅随旧实例消亡——「新实例恰一订阅」即本断言 + 上行单次注册
		const piSecond = createMockPi();
		baseToolEnhanceExtension(piSecond as unknown as ExtensionAPI);
		expect(piSecond.on.mock.calls.filter((call) => call[0] === "agent_settled")).toHaveLength(1);
		expect(pi.on.mock.calls.filter((call) => call[0] === "agent_settled")).toHaveLength(1);
	});

	it("routes every settle edge through the SAME maintenance chain as session_start (RL12 orchestration face)", async () => {
		const pi = createMockPi();
		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);
		const settleHandler = getAgentSettledHandler(pi);
		const sessionStartHandler = getSessionStartHandler(pi);
		const [, reconcileCommand] = pi.registerCommand.mock.calls[0] as [
			string,
			{ handler: (args: string, ctx: unknown) => Promise<void> },
		];
		const ctx = makeCtx();

		await settleHandler({ type: "agent_settled" }, ctx);
		expect(reconcileMock).toHaveBeenCalledTimes(1);
		expect(reconcileMock).toHaveBeenNthCalledWith(1, expect.anything(), dataDirRef.dir, "sid-once", [], undefined, undefined);

		// 三入口对同一 ctx 状态各派发一次对账、参数形态完全一致（判据单一）
		await sessionStartHandler(makeEvent("resume"), ctx);
		await reconcileCommand.handler("", ctx);
		expect(reconcileMock).toHaveBeenCalledTimes(3);
		for (const call of reconcileMock.mock.calls) {
			expect(call[1]).toBe(dataDirRef.dir);
			expect(call[2]).toBe("sid-once");
			expect(call[3]).toEqual([]);
		}
		// 高频边沿入口 debug 日志带边沿标识（S6 观测通道三入口可辨）
		expect(loggerMock.debug).toHaveBeenCalledWith("reconcile maintenance dispatch", {
			detail: { reason: "agent_settled" },
		});
		expect(loggerMock.debug).toHaveBeenCalledWith("reconcile maintenance dispatch", {
			detail: { reason: "resume" },
		});
	});
});
