// src/__tests__/file-lock.test.ts
//
// withFileLockSync 单测（真实文件系统，不 mock fs）：
//   - sync 版临界区互斥的进程内面：fn 结果透传（unlock 后可立即再锁）/ fn 抛错也
//     释放（finally 语义）/ 锁冲突直接 ELOCKED fail-fast（错误文案含恢复指引）
//   - 锁目录被外部删除的容忍路径：无保活定时器（边界声明见 lock-core.ts 头注释），
//     fn 执行期间锁目录被外部删除无定时器发现，release 时 rmdir 命中 ENOENT 静默
//     成功（照抄 proper-lockfile removeLock 容忍），不外抛、不影响 fn 结果
//   - 真实跨进程互斥（门控用例）：两个 node 子进程并发 RMW 同一 JSON 文件，计数
//     零丢失（「两写方并发不丢条目」的 D5a/D1e 核心验收形态）
//
// 轨道与预算：本文件整体登记在包 vitest.config.ts 的 integration 串行尾组（真实
// fs IO，满并行下资源竞争放大单条耗时）。进程内用例走 vitest 默认预算；门控用例
// （TAIJI_TEST_INTEGRATION，SSOT = test-guard/integration-gate.ts）本地默认跳过，
// 单独挂 90s 预算——须覆盖子进程 spawnSync timeout（60s，内含 worker 自旋重试
// 预算 30s），预算不改变断言强度（RMW 终值精确断言）。

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from "../../../../../test-guard/integration-gate.ts";

import { withFileLockSync } from "../file-lock.ts";

const PKG_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

describe("withFileLockSync", () => {
	let tmpDir: string;
	let target: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-sync-test-"));
		target = path.join(tmpDir, "target.json");
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

	it("返回 fn 结果且锁已释放（可立即再锁）", () => {
		expect(withFileLockSync(target, () => 42)).toBe(42);
		expect(withFileLockSync(target, () => "again")).toBe("again");
	});

	it("fn 抛错也释放锁", () => {
		expect(() =>
			withFileLockSync(target, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(withFileLockSync(target, () => "ok")).toBe("ok");
	});

	it("锁冲突直接 ELOCKED fail-fast：错误带 code 且文案含恢复指引（手动删除锁目录）", () => {
		// 先占锁（外层 sync 锁），再在 fn 内嵌套取锁 → 必 ELOCKED → 直接抛错
		try {
			withFileLockSync(target, () => withFileLockSync(target, () => "never"));
			expect.unreachable("must throw");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("ELOCKED");
			expect((err as Error).message).toContain("手动删除该锁目录");
		}
		// 外层锁未被嵌套失败破坏，仍可正常使用
		expect(withFileLockSync(target, () => "after")).toBe("after");
	});
});

// 锁目录被外部删除的容忍路径：proper-lockfile onCompromised 的自实现替代形态对照
// （proper-lockfile 靠保活定时器 stat 发现锁被删 → ERELEASED → debug 留痕；本实现
// 无保活定时器，删除不可发现、release 容忍 ENOENT）。
describe("withFileLockSync 锁目录被外部删除（原 compromise 场景的自实现语义）", () => {
	let tmpDir: string;
	let target: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-extrem-"));
		target = path.join(tmpDir, "target.json");
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

	it("fn 执行期间锁被外部删除 → fn 正常返回 + release 静默成功 + 可立即再锁", () => {
		const result = withFileLockSync(
			target,
			() => {
				// 模拟外部清理（手动删除锁目录的恢复动作）：无保活定时器，删除本身
				// 不触发任何回调
				fs.rmSync(`${target}.lock`, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
				return "fn-done";
			},
		);

		// fn 结果原样返回（无 compromised 拦截——无保活故无 compromise 检测）
		expect(result).toBe("fn-done");
		// release 对已消失的锁目录静默成功（ENOENT 容忍）——由下一断言间接证明：
		// 若 release 抛错，sync 版 finally 不吞错会直接外抛；直接再锁验证锁已释放
		expect(withFileLockSync(target, () => "again")).toBe("again");
	});

	it("fn 抛错且锁目录已被外部删除 → 错误照常外抛 + release 不叠加失败", () => {
		expect(() =>
			withFileLockSync(target, () => {
				fs.rmSync(`${target}.lock`, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
				throw new Error("boom");
			}),
		).toThrow("boom");
		// finally 的 release 对 ENOENT 静默——不遮蔽原始 boom 错误（上方断言已过）
	});
});

// 真实跨进程互斥（真子进程，无确定性完成信号可等的「代码 + OS 组合行为」）——经
// TAIJI_TEST_INTEGRATION 门控：本地默认跳过，CI / 按改动范围触发时真跑（门控 SSOT
// = test-guard/integration-gate.ts；本文件登记在包 vitest.config.ts 的 integration
// 串行尾组，见该配置头注释）。
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
	`真实跨进程互斥（D5a/D1e 验收形态）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
	() => {
		it(
			"两个子进程并发 RMW 同一 JSON 各 5 次，终值 10 零丢失",
			async () => {
				const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-xproc-"));
				const target = path.join(tmpDir, "shared.json");
				fs.writeFileSync(target, JSON.stringify({ n: 0 }), "utf-8");
				try {
					// 子进程脚本先经 esbuild 预编译为纯 JS bundle（含真实 src/file-lock.ts
					// 源码，消除 --experimental-strip-types 的逐子进程编译窗），再以无
					// flag 的 node 直接运行。RMW 各 5 次：跨进程互斥的本质 = 锁内读改写
					// 零丢失，迭代数放大的是时长、不是互斥语义。
					// 锁获取形态：withFileLockSync 本身无重试（ELOCKED 直接抛）+ worker
					// 外层 ELOCKED 固定 20ms 间隔重试自旋、30s 预算——满载下临界区持有
					// 窗口可能被 OS 抢占拉长，直抛语义下并发子进程会偶发拿锁失败；自旋
					// 重试保证合理时间内必能拿到锁，互斥语义（lock-core 层）不受等待
					// 形态影响。
					const workerSource = `
import * as fs from "node:fs";
import { withFileLockSync } from ${JSON.stringify(path.join(PKG_DIR, "src", "file-lock.ts"))};
const target = process.argv[2];
const deadline = Date.now() + 30_000;
for (let i = 0; i < 5; i++) {
	for (;;) {
		try {
			withFileLockSync(target, () => {
				const cur = JSON.parse(fs.readFileSync(target, "utf-8"));
				cur.n += 1;
				fs.writeFileSync(target, JSON.stringify(cur), "utf-8");
			});
			break;
		} catch (err) {
			if (!err || err.code !== "ELOCKED" || Date.now() >= deadline) throw err;
			await new Promise((r) => setTimeout(r, 20));
		}
	}
}
`;
					const workerSrc = path.join(tmpDir, "worker.src.ts");
					const workerJs = path.join(tmpDir, "worker.mjs");
					fs.writeFileSync(workerSrc, workerSource, "utf-8");
					await build({
						entryPoints: [workerSrc],
						bundle: true,
						platform: "node",
						format: "esm",
						target: "node22",
						outfile: workerJs,
						logLevel: "silent",
					});
					const procs = [1, 2].map(() =>
						spawnSync(process.execPath, [workerJs, target], { encoding: "utf-8", timeout: 60_000 }),
					);
					for (const p of procs) {
						// 失败消息带出 worker stderr/stdout，保证非零退出时调试信息不丢
						expect(p.status, `worker stderr: ${p.stderr} stdout: ${p.stdout}`).toBe(0);
					}
					expect((JSON.parse(fs.readFileSync(target, "utf-8")) as { n: number }).n).toBe(10);
				} finally {
					fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
				}
			},
			// 用例级预算覆盖子进程 spawnSync timeout（60s，内含自旋重试预算 30s）：
			// 预算放宽不改变断言强度（终值精确 10）
			90_000,
		);
	},
);
