// src/__tests__/exit-watch.test.ts —— 转后台任务退出感知守望（foreground-idle-to-background
// §5 部件 5）谓词三分支真值表逐分支断言 + 间隔驱动接线 + finalize 链落点。
//
// 三分支真值表（断言 #5）：
//  1. ESRCH（isPidAlive false，内核判定无此 pid）→ finalize 链（exitCode 恒 null +
//     registry 终态写 + handleTaskExit 恰 1 次）
//  2. 进程存活 + start time 匹配 → 在跑，继续守望（不收尾）
//  3. 进程存活 + start time 漂移（pid 复用）→ 按退出收尾且**不杀**（无关进程不受影响）
//  4. ps 失败注入（getProcessStartTimeSec 返回 undefined）→ **绝不触发 finalize**
//     （保守跳过本轮，真死由 ESRCH 兜住）
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTEGRATION_TESTS_ENABLED } from "../../../../../test-guard/integration-gate.ts";

const { pstMock, handleTaskExitSpy, origRefs } = vi.hoisted(() => ({
	pstMock: vi.fn(),
	handleTaskExitSpy: vi.fn(),
	origRefs: {} as { getProcessStartTimeSec?: (pid: number) => number | undefined },
}));

// ps 原语可控（默认委托真实实现）；handleTaskExit spy（finalize 链落点断言）
vi.mock("@zhushanwen/extension-protocol/background-task", async (importOriginal) => {
	const orig = await importOriginal<
		typeof import("@zhushanwen/extension-protocol/background-task")
	>();
	origRefs.getProcessStartTimeSec = orig.getProcessStartTimeSec;
	pstMock.mockImplementation((pid: number) => origRefs.getProcessStartTimeSec!(pid));
	return { ...orig, getProcessStartTimeSec: pstMock };
});
vi.mock("../background/notify.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../background/notify.ts")>();
	return { ...orig, handleTaskExit: handleTaskExitSpy };
});

import { getProcessStartTimeSec as realGetProcessStartTimeSec } from "@zhushanwen/extension-protocol/background-task";

import {
	attachExitWatch,
	clearExitWatchesForTest,
	EXIT_WATCH_INTERVAL_MS,
	pollConvertedTaskOnce,
} from "../background/exit-watch.ts";
import { resetNotifyForTest } from "../background/notify.ts";
import { getRegistryPath, readRegistry, taskToRegistryEntry, writeRegistryEntry } from "../background/registry.ts";
import { clearTaskStoreForTest, getTask, markKillingIntent, registerSpawnedTask } from "../background/task-store.ts";
import type { BackgroundTask } from "../background/types.ts";

const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-exitwatch-"));
const SESSION_ID = "sess-exitwatch";
const REGISTRY_PATH = getRegistryPath(DATA_DIR, SESSION_ID);

let taskSeq = 0;

/** 活进程（detached 自成进程组，组杀清理）；进程表真读 start time。 */
function spawnAlive(command: string, args: string[]): { pid: number; pidStartTime: number; kill: () => void } {
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.unref();
	const pid = child.pid!;
	const pidStartTime = realGetProcessStartTimeSec(pid)!;
	return { pid, pidStartTime, kill: () => killTree(pid) };
}

/** 确定已死的 pid：spawn 真进程并等 exit 边沿（死亡确认后 pid 复用需系统分配，测试窗口内概率可忽略）。 */
async function spawnDeadPid(): Promise<number> {
	const child = spawn("true", [], { stdio: "ignore" });
	await once(child, "exit");
	return child.pid!;
}

function killTree(pid: number): void {
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

/** 手动组装转后台条目（无 child 句柄——与 registerConvertedTask 产物同构）并进表。 */
function makeConvertedTask(pid: number, pidStartTime?: number): BackgroundTask {
	taskSeq += 1;
	const task: BackgroundTask = {
		taskId: `bt-1700000000-ew${String(taskSeq).padStart(3, "0")}`,
		pid,
		command: "sleep 30",
		outputFile: join(DATA_DIR, `${taskSeq}.log`),
		registryPath: REGISTRY_PATH,
		startedAt: Date.now(),
		state: "running",
		ownerPiPid: process.pid,
		sessionId: SESSION_ID,
		...(pidStartTime !== undefined ? { pidStartTime } : {}),
	};
	registerSpawnedTask(task);
	// 登记双写（表 + registry running 条目）对齐 registerConvertedTask 真实形态
	writeRegistryEntry(REGISTRY_PATH, taskToRegistryEntry(task));
	return task;
}

beforeEach(() => {
	handleTaskExitSpy.mockReset();
	pstMock.mockImplementation((pid: number) => origRefs.getProcessStartTimeSec!(pid));
});

afterEach(() => {
	clearExitWatchesForTest();
	clearTaskStoreForTest();
	resetNotifyForTest();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

afterAll(() => {
	rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe.skipIf(!INTEGRATION_TESTS_ENABLED)("exit watch predicate truth table (断言 #5)", () => {
	it("ESRCH → finalize chain: exitCode null, registry terminal write, handleTaskExit exactly once", async () => {
		const deadPid = await spawnDeadPid();
		const task = makeConvertedTask(deadPid);

		pollConvertedTaskOnce(task);

		const finalized = getTask(task.taskId);
		expect(finalized?.state).toBe("exited");
		expect(finalized?.exitCode).toBeNull(); // 转后台无父权，退出码结构性不可得
		expect(finalized?.reason).toBe("natural");
		// registry 终态落定（矩阵 C1：与 exit 边沿同一条收尾路径的持久化侧）
		const entry = readRegistry(REGISTRY_PATH).get(task.taskId);
		expect(entry?.state).toBe("exited");
		expect(entry?.exitCode).toBeNull();
		// 收尾链恰走一次；重复 poll 对终态条目是 no-op
		expect(handleTaskExitSpy).toHaveBeenCalledTimes(1);
		expect(handleTaskExitSpy).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.taskId }));
		pollConvertedTaskOnce(task);
		expect(handleTaskExitSpy).toHaveBeenCalledTimes(1);
	});

	it("alive + start time matches → keep watching (no finalize)", () => {
		const alive = spawnAlive("sleep", ["30"]);
		try {
			const task = makeConvertedTask(alive.pid, alive.pidStartTime);

			pollConvertedTaskOnce(task);

			expect(getTask(task.taskId)?.state).toBe("running");
			expect(handleTaskExitSpy).not.toHaveBeenCalled();
			expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("running");
		} finally {
			alive.kill();
		}
	});

	it("alive + start time drift (pid reuse) → finalize WITHOUT killing the unrelated process", () => {
		const alive = spawnAlive("sleep", ["30"]);
		try {
			const task = makeConvertedTask(alive.pid, alive.pidStartTime);
			// 身份漂移注入：读到的 start time 与登记值不匹配（复用嫌疑）
			pstMock.mockReturnValueOnce(alive.pidStartTime + 1);

			pollConvertedTaskOnce(task);

			const finalized = getTask(task.taskId);
			expect(finalized?.state).toBe("exited");
			expect(finalized?.exitCode).toBeNull();
			expect(handleTaskExitSpy).toHaveBeenCalledTimes(1);
			// 不杀——那是别人的进程（进程仍活，测试自行收尾）
			expect(realGetProcessStartTimeSec(alive.pid)).toBeDefined();
		} finally {
			alive.kill();
		}
	});

	it("ps failure injection (getProcessStartTimeSec → undefined) NEVER finalizes (conservative skip)", () => {
		const alive = spawnAlive("sleep", ["30"]);
		try {
			const task = makeConvertedTask(alive.pid, alive.pidStartTime);
			pstMock.mockReturnValueOnce(undefined);

			pollConvertedTaskOnce(task);

			// 保守跳过本轮：不判死不收尾，进程真死最终由 ESRCH 兜住
			expect(getTask(task.taskId)?.state).toBe("running");
			expect(handleTaskExitSpy).not.toHaveBeenCalled();
			expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("running");
		} finally {
			alive.kill();
		}
	});

	it("killed intent is consumed on ESRCH: reason=killed (notify killed-silent rule resolves at handleTaskExit)", async () => {
		const deadPid = await spawnDeadPid();
		const task = makeConvertedTask(deadPid);
		markKillingIntent(task.taskId, "killed");

		pollConvertedTaskOnce(task);

		const finalized = getTask(task.taskId);
		expect(finalized?.state).toBe("exited");
		expect(finalized?.reason).toBe("killed");
		expect(handleTaskExitSpy).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: task.taskId, reason: "killed" }),
		);
	});
});

describe.skipIf(!INTEGRATION_TESTS_ENABLED)("interval-driven attach (module-level singleton)", () => {
	it("attachExitWatch polls on the 2s interval and finalizes an ESRCH task", async () => {
		vi.useFakeTimers();
		const deadPid = await spawnDeadPid();
		const task = makeConvertedTask(deadPid);

		attachExitWatch(task);
		vi.advanceTimersByTime(EXIT_WATCH_INTERVAL_MS);

		expect(getTask(task.taskId)?.state).toBe("exited");
		expect(handleTaskExitSpy).toHaveBeenCalledTimes(1);

		// 终态后守望已摘除：再走间隔不重复收尾
		vi.advanceTimersByTime(EXIT_WATCH_INTERVAL_MS * 3);
		expect(handleTaskExitSpy).toHaveBeenCalledTimes(1);
	});

	it("attachExitWatch is idempotent for the same taskId", async () => {
		vi.useFakeTimers();
		const deadPid = await spawnDeadPid();
		const task = makeConvertedTask(deadPid);

		attachExitWatch(task);
		attachExitWatch(task); // 重复挂接被忽略
		vi.advanceTimersByTime(EXIT_WATCH_INTERVAL_MS);

		expect(handleTaskExitSpy).toHaveBeenCalledTimes(1);
	});
});
