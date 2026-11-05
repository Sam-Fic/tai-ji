// src/__tests__/task-store.test.ts —— 单例任务表白盒：task_id 唯一性 / 状态机 / LRU
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// registerConvertedTask（bash-tool.ts 第二登记点）经顶层 import 链引用 pi 工厂——
// 轻量 mock 隔离（本文件只测登记表语义，不触官方工厂行为）
const { createBashToolDefinitionMock } = vi.hoisted(() => ({
	createBashToolDefinitionMock: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: createBashToolDefinitionMock,
}));

import { registerConvertedTask } from "../bash-tool.ts";
import { generateTaskId } from "../background/spawn-background.ts";
import {
	clearTaskStoreForTest,
	countActiveTasks,
	finalizeTask,
	MAX_TERMINAL_TASKS,
	markKillingIntent,
	registerSpawnedTask,
	getAllTasks,
	getActiveTasks,
	getTask,
} from "../background/task-store.ts";
import type { BackgroundTask } from "../background/types.ts";

const CONVERT_DATA_DIR = mkdtempSync(join(tmpdir(), "bte-taskstore-conv-"));

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		taskId: overrides.taskId ?? generateTaskId(),
		pid: overrides.pid ?? 424242,
		command: overrides.command ?? "sleep 1",
		outputFile: overrides.outputFile ?? join(mkdtempSync(join(tmpdir(), "bte-")), "out.log"),
		registryPath: overrides.registryPath ?? "/tmp/registry.json",
		startedAt: overrides.startedAt ?? Date.now(),
		state: overrides.state ?? "running",
		ownerPiPid: overrides.ownerPiPid ?? process.pid,
		sessionId: overrides.sessionId ?? "session-a",
		...overrides,
	};
}

afterEach(() => {
	clearTaskStoreForTest();
});

afterAll(() => {
	rmSync(CONVERT_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("generateTaskId", () => {
	it("uses the bt- prefix with <ts>-<rand> shape", () => {
		const id = generateTaskId(1_724_589_012_000);
		expect(id).toMatch(/^bt-1724589012000-[a-z0-9]{6}$/);
	});

	it("generates unique ids across a burst (no process-local sequence)", () => {
		const ids = new Set<string>();
		const COUNT = 1000;
		for (let i = 0; i < COUNT; i++) {
			const id = generateTaskId();
			ids.add(id);
		}
		// 连续生成无碰撞：自增序列在同 ts 也不碰撞是随机段职责（禁自增，§2.3）
		expect(ids.size).toBe(COUNT);
	});

	it("uniqueness holds even with identical timestamps (rand segment disambiguates)", () => {
		const fixedTs = 1_724_589_012_999;
		const ids = new Set<string>();
		const COUNT = 500;
		for (let i = 0; i < COUNT; i++) {
			ids.add(generateTaskId(fixedTs));
		}
		expect(ids.size).toBe(COUNT);
	});
});

describe("task store state machine", () => {
	it("register → get → active listing", () => {
		const task = makeTask();
		registerSpawnedTask(task);
		expect(getTask(task.taskId)?.pid).toBe(task.pid);
		expect(getActiveTasks().map((t) => t.taskId)).toEqual([task.taskId]);
	});

	it("markKillingIntent transitions running → killing and records intent", () => {
		const task = makeTask();
		registerSpawnedTask(task);
		const marked = markKillingIntent(task.taskId, "killed");
		expect(marked?.state).toBe("killing");
		expect(marked?.intent).toEqual({ reason: "killed", at: expect.any(Number) });
		// killing 仍属活跃态（exit 边沿监护对象）
		expect(getActiveTasks().map((t) => t.taskId)).toEqual([task.taskId]);
	});

	it("markKillingIntent on terminal task is a no-op (undefined)", () => {
		const task = makeTask();
		registerSpawnedTask(task);
		finalizeTask(task.taskId, { exitCode: 0, reason: "natural", endedAt: Date.now() });
		expect(markKillingIntent(task.taskId, "killed")).toBeUndefined();
	});

	it("finalizeTask writes terminal fields, consumes intent, computes duration", () => {
		const task = makeTask({ startedAt: Date.now() - 1500 });
		registerSpawnedTask(task);
		markKillingIntent(task.taskId, "timeout");
		const finalized = finalizeTask(task.taskId, {
			exitCode: null,
			reason: "timeout",
			endedAt: Date.now(),
		});
		expect(finalized?.state).toBe("exited");
		expect(finalized?.reason).toBe("timeout");
		expect(finalized?.exitCode).toBeNull();
		expect(finalized?.intent).toBeUndefined();
		expect(finalized?.durationMs).toBeGreaterThanOrEqual(1500);
		expect(getActiveTasks()).toHaveLength(0);
	});

	it("finalizeTask is idempotent for terminal tasks (single ownership of terminal state)", () => {
		const task = makeTask();
		registerSpawnedTask(task);
		const first = finalizeTask(task.taskId, { exitCode: 0, reason: "natural", endedAt: Date.now() });
		const second = finalizeTask(task.taskId, { exitCode: 1, reason: "killed", endedAt: Date.now() });
		// 第二次终态化不覆盖已定终态
		expect(first?.reason).toBe("natural");
		expect(second?.reason).toBe("natural");
		expect(second?.exitCode).toBe(0);
	});
});

describe("terminal LRU eviction (cap 50)", () => {
	it("evicts oldest terminal entries beyond cap, keeps recent ones", () => {
		const OVERFLOW = 5;
		const total = MAX_TERMINAL_TASKS + OVERFLOW;
		const created: BackgroundTask[] = [];
		for (let i = 0; i < total; i++) {
			const task = makeTask({ startedAt: 1000 + i });
			created.push(task);
			registerSpawnedTask(task);
			finalizeTask(task.taskId, { exitCode: 0, reason: "natural", endedAt: 2000 + i });
		}
		const remaining = getAllTasks();
		expect(remaining).toHaveLength(MAX_TERMINAL_TASKS);
		// 最老的 OVERFLOW 条被淘汰
		for (let i = 0; i < OVERFLOW; i++) {
			expect(getTask(created[i].taskId)).toBeUndefined();
		}
		// 最新的 50 条保留
		for (let i = OVERFLOW; i < total; i++) {
			expect(getTask(created[i].taskId)).toBeDefined();
		}
	});

	it("active tasks are never evicted by LRU", () => {
		const active = makeTask({ startedAt: 1 });
		registerSpawnedTask(active);
		for (let i = 0; i < MAX_TERMINAL_TASKS + 10; i++) {
			const task = makeTask({ startedAt: 1000 + i });
			registerSpawnedTask(task);
			finalizeTask(task.taskId, { exitCode: 0, reason: "natural", endedAt: 2000 + i });
		}
		expect(getTask(active.taskId)).toBeDefined();
		expect(getTask(active.taskId)?.state).toBe("running");
	});
});

// ── 转后台登记（registerConvertedTask，foreground-idle-to-background §4.3）：第二
//    登记调用点与 spawn 登记共存于同一模块级单例表——头部不变量注释同步的行为面 ──

describe("converted registration co-resides with spawn registration", () => {
	it("registerConvertedTask lands in the same singleton table and counts toward active tasks", () => {
		const spawned = makeTask();
		registerSpawnedTask(spawned);

		const converted = registerConvertedTask({
			taskId: "bt-1700000000-conv01",
			pid: 4242424,
			command: "echo converted",
			dataDir: CONVERT_DATA_DIR,
			sessionId: "session-conv",
		});

		// 两类条目同表共存（registerSpawnedTask 调用点 = spawnBackgroundTask + registerConvertedTask）
		expect(getTask(converted.taskId)?.state).toBe("running");
		expect(getActiveTasks().map((t) => t.taskId).sort()).toEqual([converted.taskId, spawned.taskId].sort());
		expect(countActiveTasks()).toBe(2);
		// 转后台条目无 child 句柄（不挂 exit-collector——转后台命令非本进程 child）
		expect(getTask(converted.taskId)?.child).toBeUndefined();
	});

	it("converted entry flows through the same state machine (killing intent → finalize)", () => {
		const converted = registerConvertedTask({
			taskId: "bt-1700000000-conv02",
			pid: 4242425,
			command: "echo conv",
			dataDir: CONVERT_DATA_DIR,
			sessionId: "session-conv",
		});

		markKillingIntent(converted.taskId, "killed");
		expect(getTask(converted.taskId)?.state).toBe("killing");
		expect(countActiveTasks()).toBe(1); // killing 仍属活跃（守望/收殓监护对象）

		const finalized = finalizeTask(converted.taskId, { exitCode: null, reason: "killed", endedAt: Date.now() });
		expect(finalized?.state).toBe("exited");
		expect(finalized?.exitCode).toBeNull(); // 转后台退出码结构性不可得
		expect(countActiveTasks()).toBe(0);
	});
});
