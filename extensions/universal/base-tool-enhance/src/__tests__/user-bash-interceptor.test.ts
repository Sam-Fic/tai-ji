// src/__tests__/user-bash-interceptor.test.ts —— `!` 命令 user_bash 拦截层（M2/U2）
//
// 被测对象 = user-bash-interceptor.ts（handler 格判定 / fail-open / operations.exec
// 包装执行）。默认组覆盖：
//   RL6 fail-open 恰好一次执行（cmd.sh 写入失败注入 → handler undefined → 官方执行
//       恰好一条、无 wrapper、无登记）
//   RL4 回执契约 fail-open 半边（handler undefined → 官方执行正常 resolve = pi 侧
//       settled 回执的 exec 侧前提；转后台半边 = settled 已执行已收尾，见
//       background-lifecycle.test.ts 门控组）
//   RL7 透传等价测试族（先例 parity-equivalence.test.ts 同款形态移植到 user_bash
//       exec 层：包装 ops vs 官方 createLocalBashOperations 直跑，stdout/退出码/
//       截断/stdin 立即 EOF 逐字比对）
//   正常完成零登记 + `!!` 零分叉记录用例
//
// 与先例 parity 的形态差异（豁免项同步调整，结构性豁免同源）：user_bash 的官方组装
// 层是 executeBashWithOperations（pi bash-executor），不在包名导出面——两端 exec 层
// 直接比对（onData 累积字节流 + exitCode），组装层（滚动缓冲 + truncateTail）对两
// 形态是同一官方函数同一参数形态，构造性一致；截断族以包根导出的官方 truncateTail
// 对两端累积流各组装一次，断言 output/truncated 口径一致（双层截断语义：结果文本以
// 官方截断为准——wrapper 落盘全量、官方滚动缓冲 + 截断，检查点口径的等价性验证）。
// 先例四项结构性豁免中「随机临时文件路径 / 耗时字段」在 exec 层不存在（那是工具层
// OutputAccumulator / structuredContent 的产物），无需归一化；「stderr/stdout 混流
// 交错顺序」两端物理通道不同（官方双管道 vs wrapper 单日志文件顺序），比对命令全部
// 单流形态（与先例同款规避），混流顺序不在等价口径内。
//
// 真进程形态说明（同先例 parity）：每用例 spawn 官方 bash 工具链或真 taiji-fg-wrap，
// 但全部命令立即完成、无真实时钟等待窗口（挂住形态 = 失败场景，靠显式上界变红），
// 不挂 TAIJI_TEST_INTEGRATION 门控，默认组真跑（skip 会让透传守护静默失效）。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BashOperations, ExtensionContext, UserBashEvent } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, truncateTail } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConfigCache } from "@zhushanwen/pi-llm-shared";

import { getRegistryPath, readRegistry } from "../background/registry.ts";
import { resetNotifyForTest } from "../background/notify.ts";
import { clearTaskStoreForTest, getAllTasks } from "../background/task-store.ts";
import { handleUserBash } from "../user-bash-interceptor.ts";

const SESSION_ID = "sess-user-bash";
/** 真进程用例显式上界（正常形态实测远低于此；vitest 默认 5s 略紧，真进程链给余量）。 */
const PROCESS_CASE_TIMEOUT = 10_000;
/** stdin 族上界：包装 stdio 误配 pipe 时 head -n 1 挂住至超时 → 由本上界变红（守护语义本体）。 */
const STDIN_TRAP_TIMEOUT = 15_000;
/** 「立即 EOF」耗时判据（先例同款口径：官方探针 0.08s 量级，两形态合计远小于上界）。 */
const INSTANT_EOF_BUDGET_MS = 3_000;
/** 截断族触发行数（> DEFAULT_MAX_LINES=2000、总字节 < 50KB → truncatedBy "lines"）。 */
const TRUNCATION_LINES = 3000;

// 空 agentDir → base-tool-enhance 配置文件不存在 → 全默认（idleBackgroundSec=600，
// 短命令不触发空闲阈值；用户机器真实 ~/.pi 配置不得影响本测试的判定）
const AGENT_DIR = mkdtempSync(join(tmpdir(), "bte-ubash-agent-"));
const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-ubash-data-"));
// 官方 ops.exec 的 cwd（fsAccess 前置校验，必须存在）；wrapper spawn cwd 同源
const CWD = mkdtempSync(join(tmpdir(), "bte-ubash-cwd-"));
const TASKS_DIR = dirname(getRegistryPath(DATA_DIR, SESSION_ID));

function createEvent(command: string, excludeFromContext = false): UserBashEvent {
	return { type: "user_bash", command, excludeFromContext, cwd: CWD };
}

function createCtx(): ExtensionContext {
	return { sessionManager: { getSessionId: () => SESSION_ID } } as unknown as ExtensionContext;
}

/** handler 直跑（ctx 与事件 cwd 同源）。 */
function runHandler(command: string, excludeFromContext = false) {
	return handleUserBash(createEvent(command, excludeFromContext), createCtx());
}

/** exec 层两端共用的采集形态：onData 累积字节 + exec 返回值。 */
interface ExecRun { // oe-exempt:20261101:test:测试侧ExecRun 形态锚 = pi 官方 operations.exec 参数结构的测试副本（跨包不可达），供包装器行为对拍

	chunks: Buffer[];
	exitCode: number | null;
}

async function execAndCollect(exec: BashOperations["exec"], command: string): Promise<ExecRun> {
	const chunks: Buffer[] = [];
	const result = await exec(command, CWD, { onData: (chunk: Buffer) => chunks.push(chunk) });
	return { chunks, exitCode: result.exitCode };
}

/** 官方直跑形态：pi 官方本地 ops（rpc-mode 无 operations 时的官方执行本体）。 */
function runOfficial(command: string): Promise<ExecRun> {
	return execAndCollect(createLocalBashOperations().exec, command);
}

/** 包装跑形态：经真实 handler（格判定 + 构造）返回的 operations.exec。 */
async function runWrapped(command: string, excludeFromContext = false): Promise<ExecRun> {
	const handlerResult = runHandler(command, excludeFromContext);
	expect(handlerResult, "包装格判定应命中（主会话 + darwin + idle 非 null）").toMatchObject({ operations: expect.anything() });
	const operations = (handlerResult as { operations: BashOperations }).operations;
	return execAndCollect(operations.exec, command);
}

beforeEach(() => {
	delete process.env.TAIJI_AGENT_SUBAGENT;
	vi.stubEnv("PI_CODING_AGENT_DIR", AGENT_DIR);
	vi.stubEnv("TAIJI_AGENT_DATA_DIR", DATA_DIR);
	clearConfigCache();
});

afterEach(() => {
	vi.unstubAllEnvs();
	clearTaskStoreForTest();
	resetNotifyForTest();
	clearConfigCache();
	// fail-open 注入的只读态恢复（rmSync 需要写权限）
	if (existsSync(TASKS_DIR)) chmodSync(TASKS_DIR, 0o700);
});

afterAll(() => {
	for (const dir of [AGENT_DIR, DATA_DIR, CWD]) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
});

// ──────────────────────── 包装格判定（U2 检查点：与矩阵 A 格次共享配置读取）────────────────────────

describe("包装格判定（`!` 通道全量包装格 + 共享配置）", () => {
	afterEach(() => {
		// 判定用例只调 handler（构造 cmd.sh）不消费 operations——生产契约上游必然调
		// exec（rpc-mode 返回 operations 即进 executeBash），单测层不消费的构造产物
		// 在此清理，防污染零登记断言
		if (existsSync(TASKS_DIR)) rmSync(TASKS_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	it("主会话 + darwin + idle 非 null → 返回 { operations }（`!` 通道无 timeout/background/白名单概念，包装格全量）", () => {
		const result = runHandler("echo ok");
		expect(result).toMatchObject({ operations: expect.anything() });
		expect(result).not.toHaveProperty("result"); // result 完全接管已否决（D4）
	});

	it("子代理进程 → undefined 走官方执行（与 A6 同源 isSubagentProcess）", () => {
		process.env.TAIJI_AGENT_SUBAGENT = "1";
		expect(runHandler("echo ok")).toBeUndefined();
	});

	it("win32 → undefined 走官方执行（A7 沿袭）", async () => {
		const original = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			expect(runHandler("echo ok")).toBeUndefined();
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true });
		}
	});

	it("idleBackgroundSec=null（用户显式关闭）→ undefined 走官方执行（opt-out 同享回落）", () => {
		const dir = mkdtempSync(join(tmpdir(), "bte-ubash-cfg-"));
		try {
			vi.stubEnv("PI_CODING_AGENT_DIR", dir);
			const configPath = join(dir, "config", "base-tool-enhance-ext-config.json");
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, `${JSON.stringify({ idleBackgroundSec: null })}\n`, "utf8");
			clearConfigCache();
			expect(runHandler("echo ok")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
			clearConfigCache();
		}
	});

	it("`!!`（excludeFromContext=true）→ 同样返回 { operations }（两档零分叉记录用例，N3）", () => {
		expect(runHandler("!!echo secret", true)).toMatchObject({ operations: expect.anything() });
	});
});

// ──────────────────────── RL6 fail-open 恰好一次执行 ────────────────────────

describe("RL6 fail-open：构造失败 → 官方执行恰好一次（AX5 无双执行）", () => {
	it("cmd.sh 写入失败注入（tasksDir 只读）→ handler undefined + 无登记 + 官方执行成功一条", { timeout: PROCESS_CASE_TIMEOUT }, async () => {
		mkdirSync(TASKS_DIR, { recursive: true });
		chmodSync(TASKS_DIR, 0o500); // 只读：writeFileSync(cmd.sh) 抛 EACCES（V8 注入形态）

		// handler fail-open：构造异常 catch → undefined（官方执行接管）
		expect(runHandler("echo fail-open-ok")).toBeUndefined();

		// 无登记、无 wrapper 进程产物（后台任务表与 registry 均空——无双执行证据）
		expect(getAllTasks()).toHaveLength(0);
		expect(readRegistry(getRegistryPath(DATA_DIR, SESSION_ID)).size).toBe(0);

		// 官方执行端到端恰好一条：undefined → pi 走 createLocalBashOperations 本地执行
		const official = await runOfficial("echo fail-open-ok");
		expect(official.exitCode).toBe(0);
		expect(Buffer.concat(official.chunks).toString("utf8")).toContain("fail-open-ok");
	});
});

// ──────────────────────── RL4 回执契约（fail-open 半边）────────────────────────

describe("RL4 回执契约：fail-open = settled（已执行已收尾）", () => {
	it("handler undefined → 官方执行正常 resolve 不 reject（pi 侧 settled 回执的 exec 侧前提；started/rejected 判定不由本层触碰）", { timeout: PROCESS_CASE_TIMEOUT }, async () => {
		mkdirSync(TASKS_DIR, { recursive: true });
		chmodSync(TASKS_DIR, 0o500);
		expect(runHandler("echo settled-check")).toBeUndefined();
		const official = await runOfficial("echo settled-check");
		// resolve + exitCode 0 = 官方组装 BashResult 非取消形态 → rpc success → runtime settled
		expect(official.exitCode).toBe(0);
		chmodSync(TASKS_DIR, 0o700);
	});
});

// ──────────────────────── 正常完成零登记 + 三文件清理 ────────────────────────

describe("正常完成零登记（B2 零感知）", () => {
	it("短命令经包装跑正常完成 → 不登记 + background-tasks/ 零残留 + 真实退出码透传", { timeout: PROCESS_CASE_TIMEOUT }, async () => {
		const run = await runWrapped("echo user-bash-quick; exit 3");

		// 不登记（正常完成不进后台域）
		expect(getAllTasks()).toHaveLength(0);
		expect(readRegistry(getRegistryPath(DATA_DIR, SESSION_ID)).size).toBe(0);
		// 三文件清理（B2 无登记条目则文件无消费方）
		const residue = existsSync(TASKS_DIR) ? readdirSync(TASKS_DIR) : [];
		expect(residue).toEqual([]);
		// 退出码透传（wrapper wait 的真实退出码）
		expect(run.exitCode).toBe(3);
		expect(Buffer.concat(run.chunks).toString("utf8")).toContain("user-bash-quick");
	});
});

// ──────────────────────── RL7 透传等价测试族（先例形态移植，exec 层两端比对）────────────────────────

describe("RL7 透传等价：包装 ops vs 官方 ops 直跑（exec 层逐字一致）", () => {
	it(
		"族1 stdout 多行输出逐字一致",
		{ timeout: PROCESS_CASE_TIMEOUT },
		async () => {
			const command = "printf 'parity-line-1\\nparity-line-2\\nparity-line-3\\n'";
			const [official, wrapped] = await Promise.all([runOfficial(command), runWrapped(command)]);

			expect(Buffer.concat(wrapped.chunks).equals(Buffer.concat(official.chunks))).toBe(true);
			expect(wrapped.exitCode).toBe(official.exitCode);
			expect(official.exitCode).toBe(0);
		},
	);

	it(
		"族2a 退出码透传：exit 0",
		{ timeout: PROCESS_CASE_TIMEOUT },
		async () => {
			const [official, wrapped] = await Promise.all([runOfficial("echo parity-ok"), runWrapped("echo parity-ok")]);

			expect(Buffer.concat(wrapped.chunks).equals(Buffer.concat(official.chunks))).toBe(true);
			expect(wrapped.exitCode).toBe(0);
			expect(wrapped.exitCode).toBe(official.exitCode);
		},
	);

	it(
		"族2b 退出码透传：非零 exit 7",
		{ timeout: PROCESS_CASE_TIMEOUT },
		async () => {
			const [official, wrapped] = await Promise.all([runOfficial("exit 7"), runWrapped("exit 7")]);

			expect(Buffer.concat(wrapped.chunks).equals(Buffer.concat(official.chunks))).toBe(true);
			expect(wrapped.exitCode).toBe(7);
			expect(wrapped.exitCode).toBe(official.exitCode);
		},
	);

	it(
		"族3 截断族：3000 行两端抄送流逐字一致 + 官方 truncateTail 组装口径一致（双层截断语义：结果文本以官方截断为准）",
		{ timeout: PROCESS_CASE_TIMEOUT },
		async () => {
			const command = `seq 1 ${TRUNCATION_LINES}`;
			const [official, wrapped] = await Promise.all([runOfficial(command), runWrapped(command)]);

			// exec 层：wrapper 抄送流与官方管道流逐字一致（抄送不丢不重）
			const officialBytes = Buffer.concat(official.chunks);
			const wrappedBytes = Buffer.concat(wrapped.chunks);
			expect(wrappedBytes.equals(officialBytes)).toBe(true);
			expect(wrapped.exitCode).toBe(official.exitCode);

			// 组装层（官方滚动缓冲 + truncateTail 对两形态同一函数同一形态——构造性
			// 一致，本断言按检查点口径验证「结果文本以官方截断为准」的两端产出一致）：
			// 3000 行 > 2000 行上限 → 双端 truncated + 尾部 2000 行 output 相同
			const officialAssembled = truncateTail(officialBytes.toString("utf8"));
			const wrappedAssembled = truncateTail(wrappedBytes.toString("utf8"));
			expect(officialAssembled.truncated).toBe(true);
			expect(wrappedAssembled.truncated).toBe(officialAssembled.truncated);
			expect(wrappedAssembled.content).toBe(officialAssembled.content);
			expect(wrappedAssembled.totalLines).toBe(TRUNCATION_LINES);
		},
	);

	it(
		"族4 零输出命令：两端累积流均空 + 退出码一致",
		{ timeout: PROCESS_CASE_TIMEOUT },
		async () => {
			const [official, wrapped] = await Promise.all([runOfficial("true"), runWrapped("true")]);

			expect(Buffer.concat(wrapped.chunks)).toEqual(Buffer.concat(official.chunks));
			expect(Buffer.concat(official.chunks)).toHaveLength(0);
			expect(wrapped.exitCode).toBe(0);
			expect(wrapped.exitCode).toBe(official.exitCode);
		},
	);

	it(
		"族5 stdin 立即 EOF：head -n 1 两形态立即返回且流一致（stdio 误配 pipe 时挂住，由显式上界变红）",
		{ timeout: STDIN_TRAP_TIMEOUT },
		async () => {
			const startedAt = Date.now();
			const [official, wrapped] = await Promise.all([runOfficial("head -n 1"), runWrapped("head -n 1")]);
			const elapsedMs = Date.now() - startedAt;

			expect(Buffer.concat(wrapped.chunks).equals(Buffer.concat(official.chunks))).toBe(true);
			expect(wrapped.exitCode).toBe(0);
			expect(wrapped.exitCode).toBe(official.exitCode);
			expect(
				elapsedMs,
				`stdin 族应立即 EOF 返回（两形态合计 ${elapsedMs}ms ≥ ${INSTANT_EOF_BUDGET_MS}ms 即非立即——检查 wrapper spawn 是否把 stdio 误配为 pipe）`,
			).toBeLessThan(INSTANT_EOF_BUDGET_MS);
		},
	);
});
