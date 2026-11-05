// src/file-lock.ts
//
// 跨进程同步文件锁（extension 侧共享 util，D5a/D1e，integrity-hardening.md §3.5）。
//
// 为什么存在：worktrees.json（多 pi 进程各一份扩展实例写）与 ext-config 家族
// （runtime + 扩展双写）都是跨进程 RMW——Node 单线程只能保证进程内不交错，
// 挡不住跨进程「后写者基于旧快照覆盖先写者」。
//
// 锁原语：自实现 mkdir-lock（src/lock-core.ts，D1-A，零第三方依赖）。磁盘协议与
// pi 内嵌 proper-lockfile@4.1.2 的互斥面兼容（协议细节见 lock-core.ts 头注释）。
// 本文件职责：对外 API + ELOCKED 错误包装（恢复指引），logger 由包入口 index.ts
// 装配的机制已随判死诊断面移除。
//
// 锁协议（与 runtime 侧 packages/runtime/src/utils/file-lock.ts 对齐，登记表
// docs/architecture/data-source-registry.md §6）：
//   - lockfile 路径 = <目标文件>.lock（双方路径一致才互斥）
//   - realpath:false —— 目标文件不存在也可锁；不解析 symlink
//   - 无重试：锁冲突（ELOCKED）直接抛错，恢复 = 手动删除锁目录
//   - release 对锁目录已被外部删除的场景静默成功（ENOENT 容忍）
//
// 契约：fn 内仅做既定读改写（读目标文件 + 纯内存变更 + 原子写），禁其他 I/O /
// 再次对本文件加锁（嵌套取锁 ELOCKED 直接抛错），毫秒级完成。

import { resolve } from "node:path";

import { acquireLockSync } from "./lock-core";

/**
 * 同步跨进程文件锁内执行 fn：锁冲突（ELOCKED）直接抛带 ELOCKED code 的错误
 * （文案含恢复指引：手动删除锁目录）；unlock 放 finally（fn 抛错也释放）。
 *
 * 与 runtime 侧 sync 实现（packages/runtime/src/utils/file-lock.ts 的
 * withFileLockSync）同协议——同一把 lockfile（<目标文件>.lock），互斥不依赖
 * 实现归属。适用场景：调用链必须保持 sync 签名（如 llm-shared saveConfig，
 * permission/rename-session 的命令回调零波及）。
 */
export function withFileLockSync<T>(
	filePath: string,
	fn: () => T,
): T {
	let release: (() => void) | undefined;
	try {
		release = acquireLockSync(filePath);
	} catch (err) {
		if (!isElocked(err)) throw err;
		throw Object.assign(
			new Error(
				`[file-lock] ${resolve(filePath)}.lock 写锁获取失败：锁已被其他进程持有（持锁方可能已崩溃残留）。` +
				`恢复指引：确认无进程正在写入后，手动删除该锁目录，再重试本次写入。`,
				// cause 挂原始 ELOCKED 错误，保留锁原语诊断信息
				{ cause: err },
			),
			{ code: "ELOCKED" },
		);
	}
	try {
		return fn();
	} finally {
		release();
	}
}

function isElocked(err: unknown): boolean {
	// in 收窄而非 as 断言（extensions taste/no-unsafe-catch：全可选属性断言 = 无校验）
	return err instanceof Error && "code" in err && err.code === "ELOCKED";
}
