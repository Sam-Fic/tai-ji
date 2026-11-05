// src/lock-core.ts
//
// 零依赖跨进程 mkdir 锁原语（D1-A 自实现，docs/architecture/file-lock-unification-and-reaper-sink.md §3.2）。
//
// 为什么自实现：包名入口原先包 proper-lockfile，但 runtime 经 tsup bundle 复用它时，
// 第三方对模块对象的内部操作（probe 精度缓存的 fs symbol）在 jiti 类加载器下失效——
// 本次事故根因。本文件只用 node:fs / node:path 内置调用实现同一磁盘协议，天然免疫
// 模块系统包装；runtime 经 `@zhushanwen/pi-file-lock/core` 子入口复用同一实现。
//
// 磁盘协议（与 proper-lockfile@4.1.2 的互斥面兼容——pi 内嵌版互斥同一把锁）：
//   - 锁文件 = path.resolve(目标) + '.lock' 目录（mkdir 原子上锁）。realpath:false 分支：
//     仅字符串绝对化（path.resolve），不解析 symlink
//   - mkdir EEXIST → 抛 ELOCKED。不做时间阈值判死夺取（显式设计决策）：锁被持锁方
//     占用（含崩溃残留）时获取直接失败，恢复 = 手动删除锁目录后重试
//   - 释放 = rmdir，容忍 ENOENT（照抄 removeLock）
//   - graceful exit 兜底：process.on('exit') 配对 rmdirSync，避免优雅退出后锁残留。
//     覆盖范围边界：'exit' 只覆盖正常退出与 process.exit；信号默认终止（SIGINT/SIGTERM
//     无 handler）与 SIGKILL 崩溃场景 'exit' 不触发，锁残留需手动删除锁目录恢复
//
// 与 proper-lockfile 的行为边界（设计显式决策，非遗漏）：
//   - 不做周期 utimes 保活（proper-lockfile 的 updateLock 定时器）：无 stale 判死，
//     保活无消费方
//   - 无 compromise 检测；release 对锁目录已被外部删除的场景静默成功（ENOENT 容忍）
//   - 长期持锁不会被自动打断——跨进程契约 = 临界区毫秒级完成 + 正常退出配对释放
//
// 零依赖约束（D1-A）：本文件不得 import 任何项目内包或第三方包——extension-logger
// 携带 pi SDK peerDep 链，经 runtime re-export 会穿越 pi 边界。

import { mkdirSync, rmdirSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** async release 函数：释放锁目录（幂等；锁目录已消失时静默成功）。 */
export type LockRelease = () => Promise<void>;

// ──────────────────────── 协议原语（照抄 lockfile.js 对应函数） ────────────────────────

/** realpath:false 分支：仅字符串绝对化，不解析 symlink（照抄 resolveCanonicalPath）。 */
function resolveTarget(filePath: string): string {
	return resolve(filePath);
}

/** 照抄 getLockFile：`options.lockfilePath || \`${file}.lock\``（不自定义 lockfilePath）。 */
function lockPathOf(target: string): string {
	return `${target}.lock`;
}

/** ELOCKED 错误（message/fields 照抄 proper-lockfile）。 */
function elocked(target: string): Error {
	return Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file: target });
}

/** Node fs 错误 code 收窄（in 收窄，禁 as 断言——taste/no-unsafe-cast）。 */
function errCode(err: unknown): string | undefined {
	return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** 锁前确保父目录存在（mkdir lockfile 需要；recursive 对已存在目录静默成功）。 */
async function ensureParentDir(target: string): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
}

// ──────────────────────── graceful exit 兜底（照抄 signal-exit 清理语义） ────────────────────────

/** 当前进程持有的活跃锁（lockfilePath 集合）。release 时同步出表。 */
const activeLocks = new Set<string>();

let exitHookInstalled = false;

/**
 * 进程退出点配对清理（模块级注册一次）：exit handler 内只能同步操作，用 rmdirSync。
 * 单把锁清理失败不阻断其余锁清理——进程已终止，无恢复动作；零依赖约束下无日志
 * 通道，失败静默（锁残留由人工删除恢复，见头注释覆盖范围边界）。
 */
function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const lockfilePath of activeLocks) {
			try {
				rmdirSync(lockfilePath);
			} catch {
				// 进程已终止，无恢复动作；吞错保证其余锁清理不被阻断
			}
		}
		activeLocks.clear();
	});
}

/** 单次释放（rmdir，容忍 ENOENT——照抄 removeLock）。 */
async function removeLockAsync(lockfilePath: string): Promise<void> {
	try {
		await rmdir(lockfilePath);
	} catch (err) {
		if (errCode(err) !== "ENOENT") throw err;
	}
}

/** removeLockAsync 的同步版。 */
function removeLockSync(lockfilePath: string): void {
	try {
		rmdirSync(lockfilePath);
	} catch (err) {
		if (errCode(err) !== "ENOENT") throw err;
	}
}

/** release 闭包：幂等（二调 no-op）；释放即出活跃锁表。 */
function makeRelease(lockfilePath: string): LockRelease {
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		activeLocks.delete(lockfilePath);
		await removeLockAsync(lockfilePath);
	};
}

// ──────────────────────── 对外 API ────────────────────────

/**
 * 单次获取跨进程锁：成功返回 release（幂等）；锁已被持有（含崩溃残留）时抛
 * code:"ELOCKED" 错误——无重试、无时间阈值判死夺取，恢复 = 手动删除锁目录后重试
 * （重试编排属消费方：extension 侧 src/file-lock.ts / runtime 侧
 * packages/runtime/src/utils/file-lock.ts）。
 */
export async function acquireLock(filePath: string): Promise<LockRelease> {
	const target = resolveTarget(filePath);
	const lockfilePath = lockPathOf(target);
	await ensureParentDir(target);
	installExitHook();
	let acquired = false;
	try {
		await mkdir(lockfilePath);
		acquired = true;
	} catch (err) {
		if (errCode(err) !== "EEXIST") throw err;
	}
	if (!acquired) throw elocked(target);
	activeLocks.add(lockfilePath);
	return makeRelease(lockfilePath);
}

/**
 * acquireLock 的同步版（sync 调用链专用；语义同 async 版，无事件循环依赖）。
 */
export function acquireLockSync(filePath: string): () => void {
	const target = resolveTarget(filePath);
	const lockfilePath = lockPathOf(target);
	mkdirSync(dirname(target), { recursive: true });
	installExitHook();
	let acquired = false;
	try {
		mkdirSync(lockfilePath);
		acquired = true;
	} catch (err) {
		if (errCode(err) !== "EEXIST") throw err;
	}
	if (!acquired) throw elocked(target);
	activeLocks.add(lockfilePath);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeLocks.delete(lockfilePath);
		removeLockSync(lockfilePath);
	};
}
