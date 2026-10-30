// src/__tests__/wrapper-foreground-idle.test.ts —— taiji-fg-wrap 包装脚本集成测试
//
// 被测对象 = bin/taiji-fg-wrap（bash 包装脚本本体，设计 foreground-idle-to-background
// §5 部件 1）。自包含真进程集成：真 spawn 包装脚本 + 真实时钟空闲触发，不依赖扩展运行时。
//
// 门控形态（对齐 background-lifecycle.test.ts 集成组先例）：真子进程 + 真实时钟满载下
// 延迟不可预估，无确定性完成信号——属「代码 + OS 组合行为」，移出默认单测层：
// 本地默认跳过，CI / 按改动范围触发时设 TAIJI_TEST_INTEGRATION=1 真跑
// （门控 SSOT = test-guard/integration-gate.ts）。
//
// 空闲阈值秒级实测（脚本参数化，任务书批准形态）：--idle 2 秒级真实等待，禁真实长等待；
// fake timers 控制不了子进程的时钟，本文件全部用短 idle 实测。等待写法：
// 等 wrapper 退出 = await exit 事件（确定性信号）；等日志增长 = vi.waitFor 条件轮询。
//
// 验收条款映射（任务书 / 设计 §6.3）：
//   断言 #1  idle 触发后命令进程存活 + 日志持续增长   → 「idle 触发转后台…」用例
//   断言 #2  空闲阈值触发时序（30s±5s 按阈值等比）    → 「触发时序…」用例（idle 2s 窗 2s±0.5s）
//   断言 #6  包装脚本退出后命令进程存活（SIGPIPE 规避）→ 「idle 触发转后台…」用例
//   断言 #8  正常完成抄送不丢字节（逐字比对）          → 「长输出多批次抄送…」用例
//   §9 检查点 UTF-8 多字节跨抄送批次切半不丢不重      → 「UTF-8 多字节跨抄送批次…」用例
//   N1（§6.2 / 验收 A13）持续输出刷新空闲计时不转后台  → 「N1 持续输出…」用例（idle 2 + 每秒 echo × 4s）
//   退出码透传 / stdin 立即 EOF / V3 命令集            → 各自独立用例
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from "../../../../../test-guard/integration-gate.ts";

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "taiji-fg-wrap");
const USEC_TIMEOUT = 20_000; // 集成组用例预算（先例同款；门控文件受 sanction，不进默认组慢用例门禁）
const BG_MARKER = "[TAIJI-FG-BG] Command moved to background after";

type WrapperRun = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	stdoutBuf: Buffer[];
}

type PidfileEntry = {
	pid: number;
	pidStartTimeSec: number;
}

/** 各用例当前在跑的包装脚本 pid（detached spawn → 包装脚本为其进程组组长），afterEach 整组清理 */
let liveWrapperPids: number[] = [];
let workDir = "";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeCmd(name: string, body: string): string {
	const path = join(workDir, name);
	writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o644 });
	return path;
}

function writeCmdWithIdle(name: string, body: string, idleSec: number, taskId: string): string[] {
	return [
		"--idle",
		String(idleSec),
		"--task-id",
		taskId,
		"--log",
		join(workDir, `${taskId}.log`),
		"--pidfile",
		join(workDir, `${taskId}.pid`),
		"--",
		writeCmd(name, body),
	];
}

/** spawn 包装脚本（detached 复刻官方 spawn 的进程组结构：wrapper 为组长，真实命令同组） */
function runWrapper(args: string[]): Promise<WrapperRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(WRAPPER, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		if (child.pid === undefined) {
			reject(new Error("wrapper spawn failed: no pid"));
			return;
		}
		liveWrapperPids.push(child.pid);
		const run: WrapperRun = { code: null, signal: null, stdout: "", stderr: "", stdoutBuf: [] };
		child.stdout?.on("data", (chunk: Buffer) => {
			run.stdoutBuf.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			run.stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			run.code = code;
			run.signal = signal;
			run.stdout = Buffer.concat(run.stdoutBuf).toString("utf8");
			resolve(run);
		});
	});
}

/** 杀包装脚本所在进程组（含已转后台的真实命令），ESRCH 容忍 */
function killWrapperGroup(pid: number): void {
	for (const target of [-pid, pid]) {
		try {
			process.kill(target, "SIGKILL");
		} catch {
			// 进程/进程组已不存在
		}
	}
}

function readPidfile(taskId: string): PidfileEntry {
	const raw = JSON.parse(readFileSync(join(workDir, `${taskId}.pid`), "utf8")) as PidfileEntry;
	return raw;
}

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
	`taiji-fg-wrap 空闲转后台集成（真进程）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
	() => {
		beforeEach(() => {
			workDir = mkdtempSync(join(tmpdir(), "taiji-fg-wrap-"));
			liveWrapperPids = [];
		});

		afterEach(() => {
			for (const pid of liveWrapperPids) {
				killWrapperGroup(pid);
			}
			liveWrapperPids = [];
			rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		});

		afterAll(() => {
			// 兜底：任何用例异常路径遗留的包装/命令进程整组收掉，不留孤儿
			for (const pid of liveWrapperPids) {
				killWrapperGroup(pid);
			}
		});

		it(
			"长输出多批次抄送逐字完整 + 退出码透传（断言 #8：exit 7 原样透传，stderr 经合并流不丢行）",
			{ timeout: USEC_TIMEOUT },
			async () => {
				const batches = 3;
				const expected: string[] = [];
				for (let i = 1; i <= batches; i++) {
					expected.push(`batch-${i}-line1`, `batch-${i}-line2`);
				}
				expected.push("err-stream");
				const run = await runWrapper(
					writeCmdWithIdle(
						"cmd.sh",
						[
							"for i in 1 2 3; do",
							'  echo "batch-$i-line1"',
							'  echo "batch-$i-line2"',
							"  sleep 0.3",
							"done",
							'echo "err-stream" >&2',
							"exit 7",
						].join("\n"),
						10,
						"parity-exit7",
					),
				);

				// 命令输出分 3 批、批间隔 0.3s 跨多个轮询周期（200ms），抄送流拼接逐字完整
				expect(run.stdout.split("\n")).toEqual(expect.arrayContaining(expected));
				expect(run.stdout.split("\n").filter((line) => line.startsWith("batch-"))).toHaveLength(batches * 2);
				expect(run.stdout).toContain("err-stream");
				expect(run.code).toBe(7); // 退出码透传：命令 exit 7 → 包装脚本 exit 7
				expect(run.stderr).toBe(""); // 命令 stderr 只落日志/抄送流，不经包装脚本自身 stderr
			},
		);

		it(
			"UTF-8 多字节跨抄送批次字节完整（设计 §9 检查点：切半不丢不重，抄送流与日志逐字节一致）",
			{ timeout: USEC_TIMEOUT },
			async () => {
				// 构造跨批次切半：批间隔 sleep 0.3 > 轮询间隔（设计 ≤200ms 口径），保证抄送
				// offset 必然停在多字节序列内部——「中」(E4 B8 AD) 拆两批、「😀」(F0 9F 98 80)
				// 拆两批。flush_log 按字节 offset 接续，跨批次字节流无损拼接、不丢不重。
				const fullLine = (i: number) => `第${i}行：中文字符串😀与内容`;
				const run = await runWrapper(
					writeCmdWithIdle(
						"cmd.sh",
						[
							"for i in 1 2 3; do",
							'  printf \'第%d行：中文字符串😀与内容\\n\' "$i"',
							"  sleep 0.3",
							"done",
							"printf '\\xe4\\xb8'", // 「中」前 2 字节：批边界停在其内部
							"sleep 0.3",
							"printf '\\xad'", // 补全「中」
							"sleep 0.3",
							"printf '\\xf0\\x9f'", // 「😀」前 2 字节
							"sleep 0.3",
							"printf '\\x98\\x80\\n'", // 补全「😀」
						].join("\n"),
						10,
						"mb-utf8",
					),
				);

				// 抄送流与日志文件逐字节一致（跨切半边界不丢不重；无标记行、无自产输出）
				const relayBytes = Buffer.concat(run.stdoutBuf);
				expect(relayBytes.equals(readFileSync(join(workDir, "mb-utf8.log")))).toBe(true);
				// 解码侧完整：三行全文 + 切半重组后的「中」「😀」原样可解（丢字节会解出替换符）
				expect(relayBytes.toString("utf8").split("\n")).toEqual(
					expect.arrayContaining([fullLine(1), fullLine(2), fullLine(3), "中😀"]),
				);
				expect(run.code).toBe(0);
				expect(run.stderr).toBe("");
			},
		);

		it(
			"触发时序与转后台形态（断言 #2：idle 2s 触发窗 2s±0.5s；exit 0 + 标记行逐字协议）",
			{ timeout: USEC_TIMEOUT },
			async () => {
				const startedAt = Date.now();
				const run = await runWrapper(writeCmdWithIdle("cmd.sh", "echo start\nsleep 30", 2, "timing"));

				const elapsedMs = Date.now() - startedAt;
				expect(elapsedMs).toBeGreaterThanOrEqual(1500); // 2s - 0.5s
				expect(elapsedMs).toBeLessThanOrEqual(2500); // 2s + 0.5s
				expect(run.code).toBe(0); // 转后台形态 exit 0
				expect(run.stdout).toContain("start");
				expect(run.stderr).toBe("");
				// 标记行逐字协议（§5 部件 3；Ns 段为实际静默秒数的十进制整数）
				const markerLine = run.stdout
					.split("\n")
					.find((line) => line.startsWith(BG_MARKER));
				expect(markerLine).toBeDefined();
				const logPath = join(workDir, "timing.log");
				const taskId = "timing";
				expect(markerLine).toMatch(
					new RegExp(
						`^\\[TAIJI-FG-BG\\] Command moved to background after \\d+s without output — still running, NOT finished \\(no exit code yet\\)\\. Full log: ${escapeRegExp(logPath)} Check: bash_output \\{task_id:"${taskId}"\\}; terminate: bash_kill \\{task_id:"${taskId}"\\}\\. It will notify on completion — DO NOT bash sleep while waiting\\.$`,
					),
				);
			},
		);

		it(
			"idle 触发转后台后命令存活且日志持续增长（断言 #1 + #6：SIGPIPE 规避回归防护 + pidfile 内容）",
			{ timeout: USEC_TIMEOUT },
			async () => {
				const run = await runWrapper(
					writeCmdWithIdle("cmd.sh", "echo start\nsleep 3\necho after-bg\nsleep 30", 2, "alive"),
				);

				// 包装脚本已退出（转后台形态），真实命令不动
				expect(run.code).toBe(0);
				expect(run.stdout).toContain("start");

				// pidfile：真实命令 pid + 启动时间（spawn 后写）
				const entry = readPidfile("alive");
				expect(Number.isInteger(entry.pid)).toBe(true);
				expect(Number.isInteger(entry.pidStartTimeSec)).toBe(true);

				// 断言 #6 / #1 前半：包装脚本退出后命令进程仍存活（结构性 SIGPIPE 规避）
				expect(() => process.kill(entry.pid, 0)).not.toThrow();

				// 断言 #1 后半：转后台后命令继续产生输出，日志文件持续增长
				const sizeAtBackground = statSync(join(workDir, "alive.log")).size;
				await vi.waitFor(
					() => {
						expect(statSync(join(workDir, "alive.log")).size).toBeGreaterThan(sizeAtBackground);
					},
					{ timeout: 5000 },
				);
				expect(readFileSync(join(workDir, "alive.log"), "utf8")).toContain("after-bg");
			},
		);

		it(
			"stdin 立即 EOF（stdio 对齐官方 ignore：读 stdin 命令秒退不挂住，误配 pipe 时本用例超时红）",
			{ timeout: USEC_TIMEOUT },
			async () => {
				const startedAt = Date.now();
				const run = await runWrapper(writeCmdWithIdle("cmd.sh", "head -n 1", 2, "stdin-eof"));

				const elapsedMs = Date.now() - startedAt;
				expect(run.code).toBe(0);
				expect(run.stdout).toBe("");
				// 读 stdin 立即 EOF 自然退出，远早于 idle 2s 空闲触发
				expect(elapsedMs).toBeLessThan(2000);
			},
		);

		it(
			"V3 命令集本地直跑：ls / pnpm -v / 每秒 echo 持续输出，经包装跑输出与退出码正常",
			{ timeout: USEC_TIMEOUT },
			async () => {
				// ls：测试自建目录内文件可见（cmd.sh 以参数路径列出，不依赖包装进程 cwd）
				writeFileSync(join(workDir, "a.txt"), "a");
				writeFileSync(join(workDir, "b.txt"), "b");
				const lsRun = await runWrapper(writeCmdWithIdle("cmd.sh", `ls "${workDir}"`, 10, "v3-ls"));
				expect(lsRun.code).toBe(0);
				expect(lsRun.stdout).toContain("a.txt");
				expect(lsRun.stdout).toContain("b.txt");

				// pnpm -v：输出版本号形态
				const pnpmRun = await runWrapper(writeCmdWithIdle("cmd.sh", "pnpm -v", 10, "v3-pnpm"));
				expect(pnpmRun.code).toBe(0);
				expect(pnpmRun.stdout).toMatch(/\d+\.\d+\.\d+/);

				// 每秒 echo 持续输出（V3 命令集直跑项：idle 10 > 总时长 ~3s，本子用例不承载
				// 空闲刷新判别——N1 判别形态见「N1 持续输出刷新空闲计时…」专项用例）
				const echoRun = await runWrapper(
					writeCmdWithIdle(
						"cmd.sh",
						"for i in 1 2 3; do\n  echo \"tick-$i\"\n  sleep 1\ndone",
						10,
						"v3-echo",
					),
				);
				expect(echoRun.code).toBe(0);
				expect(echoRun.stdout.split("\n")).toEqual(expect.arrayContaining(["tick-1", "tick-2", "tick-3"]));
			},
		);

		it(
			"N1 持续输出刷新空闲计时：idle 2 + 每秒 echo × 4s 全程前台至自然退出（绝不转后台 + 退出码透传）",
			{ timeout: USEC_TIMEOUT },
			async () => {
				// 判别形态（设计 §6.2 N1 / 验收 A13 的阈值等比缩小：60s/30s → 4s/2s）：
				// 总时长 4s > idle 2s 且批间隔 1s < idle 2s——空闲重置（新字节刷新
				// last_byte_ms）正确时全程不触发 B3；重置被破坏（计时冻结在 spawn 时刻）时
				// wrapper 会在 ~2.2s 打标记行 exit 0，时长 / 标记行 / 退出码三口径任一变红。
				const startedAt = Date.now();
				const run = await runWrapper(
					writeCmdWithIdle(
						"cmd.sh",
						["for i in 1 2 3 4; do", '  echo "tick-$i"', "  sleep 1", "done", "exit 5"].join("\n"),
						2,
						"n1-echo",
					),
				);

				const elapsedMs = Date.now() - startedAt;
				// 全程前台至自然退出：4×sleep 1 下界保证 wrapper 退出不早于命令总时长 4s
				expect(elapsedMs).toBeGreaterThanOrEqual(4000);
				// 绝不转后台：无标记行（B3 形态会打标记）；退出码 = 命令自身 exit 5（B3 形态为 exit 0）
				expect(run.stdout).not.toContain(BG_MARKER);
				expect(run.code).toBe(5);
				// 持续输出全部透传
				expect(run.stdout.split("\n")).toEqual(
					expect.arrayContaining(["tick-1", "tick-2", "tick-3", "tick-4"]),
				);
			},
		);

		it("pidfile 与抄送基线在命令正常完成路径仍写有内容（B2 形态：透传后 pidfile 残留由改写层收尾删除）", { timeout: USEC_TIMEOUT }, async () => {
			// B2 正常完成形态：包装脚本透传退出码退出；pidfile/cmd.sh/日志三文件的删除归
			// execute 改写层收尾（u-injector 域），本脚本只保证自己写有 pidfile 可供其判定
			const run = await runWrapper(writeCmdWithIdle("cmd.sh", "echo done-quick", 2, "quick"));
			expect(run.code).toBe(0);
			expect(run.stdout).toContain("done-quick");
			expect(existsSync(join(workDir, "quick.pid"))).toBe(true);
			const entry = readPidfile("quick");
			expect(Number.isInteger(entry.pid)).toBe(true);
		});

		it("多字节 UTF-8 输出跨抄送批次逐字完整（设计 §9 字节完整性边界）", { timeout: USEC_TIMEOUT }, async () => {
			// 中文 + emoji + 变音符号混合流，每行单独一拍（sleep 0.3 > 抄送循环 0.15s 间隔）
			// → 5 行分 5 个抄送批次到达；多字节字符若在批次边界被切/丢，逐字比对即变红
			const lines = ["中文行-one-🚀", "中文行-two-émoji", "中文行-three-汉字", "中文行-four-🚄", "中文行-five-✓"];
			const script = lines.map((l) => `echo "${l}"; sleep 0.3`).join("\n");
			const run = await runWrapper(writeCmdWithIdle("cmd.sh", script, 3, "utf8"));
			expect(run.code).toBe(0);
			expect(run.stdout.split("\n").filter((l) => l.startsWith("中文行-"))).toEqual(lines);
		});
	},
);
