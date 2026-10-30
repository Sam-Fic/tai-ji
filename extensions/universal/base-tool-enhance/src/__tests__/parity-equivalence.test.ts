// src/__tests__/parity-equivalence.test.ts —— 透传等价测试族（M2 波次，设计 §6.3 断言 #3）
//
// 守护对象 = A5 公理（foreground-idle-to-background）：包装层对正常完成的命令透传全部
// 输出与真实退出码，结果与官方直跑逐字一致。测试对象是 u-wrapper（bin/taiji-fg-wrap）
// 与 u-injector（bash-tool.ts 改写层）的真实集成形态，不是 mock——包装跑经真实改写层
// 构造包装命令串、真 taiji-fg-wrap 执行、真实 pidfile 收尾（B2 不登记 + 三文件清理）；
// 官方直跑 = pi 真工厂 createBashToolDefinition 直接 execute（对照形态，与
// idleBackgroundSec=null 的官方原生回落路径同为官方本体，且不经 override 层任何逻辑）。
// 两形态同进程、同 ctx（cwd / sessionId / env 同源——官方 getShellEnv() 直接继承本测试
// 进程 env，包装脚本不改 env，命令侧 env 对齐）。
//
// 六族用例（§6.3 断言 #3）：stdout 多行 / 退出码（exit 0 与非零）/ 截断脚注 /
// "(no output)" 占位 / 非零退出状态行 / stdin 立即 EOF。
// stdin 族前提 = 默认 commandTransport 非 stdin（官方 spawn stdio ["ignore",...]，
// pi bash.js:67；macOS getShellConfig 固定 /bin/bash，非 legacy WSL stdin 路径）——
// 包装 spawn stdio 误配为 pipe 时 head -n 1 挂住，由用例显式超时上界变红。
//
// 逐字比对口径：content text 与 structuredContent.output（截断形态把官方每次随机的
// Full output 临时文件路径归一化后比对，脚注形态本身逐字）+ 退出码 / 错误态 / 截断元
// 数据一致。截断双口径均覆盖：details.truncation 是 display 截断（2000 行 / 50KB，
// OutputAccumulator snapshot）；structuredContent.truncated 是 output 字段的 1MB 上限
// 口径（readFullOutput 返回，与 display 截断独立）。官方
// structuredContent.wall_time_seconds 每次运行必变，结构性不在等价口径内。
//
// 本文件是真子进程集成（每用例 spawn 官方 bash 工具链），但全部命令立即完成、无真实
// 时钟等待窗口（挂住形态 = 失败场景，靠显式上界变红），单用例实测 <2s——不挂
// TAIJI_TEST_INTEGRATION 门控，默认组真跑（skip 形态会让六族守护静默失效）。
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConfigCache } from "@zhushanwen/pi-llm-shared";

import { createBashOverrideToolDefinition } from "../bash-tool.ts";
import { getRegistryPath } from "../background/registry.ts";
import { clearTaskStoreForTest, getAllTasks } from "../background/task-store.ts";

const SESSION_ID = "sess-parity";
/** 真进程用例显式上界（正常形态实测远低于此；vitest 默认 5s 略紧，真进程链给余量）。 */
const PROCESS_CASE_TIMEOUT = 10_000;
/** stdin 族上界：包装 stdio 误配 pipe 时 head -n 1 挂住至超时 → 由本上界变红（守护语义本体）。 */
const STDIN_TRAP_TIMEOUT = 15_000;
/** 「立即 EOF」耗时判据：官方探针 0.08s 量级，两形态合计仍远小于显式上界。 */
const INSTANT_EOF_BUDGET_MS = 3_000;
/** 截断族触发行数（> DEFAULT_MAX_LINES=2000、总字节 < 50KB → truncatedBy "lines"）。 */
const TRUNCATION_LINES = 3000;

// 空 agentDir → base-tool-enhance 配置文件不存在 → 全默认（idleBackgroundSec=600，短命令
// 不触发空闲阈值；用户机器真实 ~/.pi 配置不得影响本测试的分流判定）
const AGENT_DIR = mkdtempSync(join(tmpdir(), "bte-parity-agent-"));
// 改写层三文件（cmd.sh/pidfile/日志）落点隔离
const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-parity-data-"));
// 官方 ops.exec 的 cwd（fsAccess 前置校验，必须存在）
const CWD = mkdtempSync(join(tmpdir(), "bte-parity-cwd-"));
const TASKS_DIR = dirname(getRegistryPath(DATA_DIR, SESSION_ID));

type OfficialCtx = {
	cwd: string;
	sessionManager: {
		getSessionId: () => string;
		getSessionFile: () => undefined;
	};
}

/**
 * 两形态共用的 execute ctx。getSessionFile 是官方 resolveSpawnContext 的调用点
 * （pi bash.js resolveSpawnContext：sessionFile falsy → PI_SESSION_FILE 不注入），
 * 两形态传同形 ctx → PI_SESSION_ID 注入值一致（env 对齐）。
 */
function createCtx(): OfficialCtx {
	return {
		cwd: CWD,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionFile: () => undefined,
		},
	};
}

/** 官方直跑形态：pi 真工厂直接 execute（timeout 缺省 = 官方无超时语义，与包装跑同参形态）。 */
async function runOfficial(command: string): Promise<unknown> {
	const official = createBashToolDefinition(CWD);
	return official.execute("parity-official", { command, timeout: undefined }, undefined, undefined, createCtx() as never);
}

/**
 * 包装跑形态：经真实改写层（A5 格）→ 真 taiji-fg-wrap → 真实 pidfile 收尾。
 * 附带零感知断言（V3 同族语义）：正常完成路径 B2 不登记、background-tasks/ 无本次残留。
 */
async function runWrapped(command: string): Promise<unknown> {
	const override = createBashOverrideToolDefinition();
	const result = await override.execute("parity-wrapped", { command }, undefined, undefined, createCtx() as never);
	expect(getAllTasks(), `包装跑正常完成不应登记后台任务（command: ${command}）`).toHaveLength(0);
	const residue = existsSync(TASKS_DIR) ? readdirSync(TASKS_DIR) : [];
	expect(residue, `包装跑正常完成后 background-tasks/ 应零残留（B2 三文件清理；command: ${command}）`).toEqual([]);
	return result;
}

/** 官方截断临时文件路径每次运行随机（tmpdir/pi-bash-*），逐字比对前归一化为占位。 */
function normalizeFullOutputPath(text: string): string {
	return text.replace(/Full output: [^\]\n]+/g, "Full output: <FULL_OUTPUT_PATH>");
}

/** 两形态等价口径的归一化结果形态。 */
type ParityResult = {
	text: string;
	output: string | undefined;
	exitCode: number | undefined;
	isError: boolean | undefined;
	/** structuredContent.truncated（output 字段 1MB 上限口径，独立于 display 截断） */
	structuredTruncated: boolean | undefined;
	/** details.truncation（display 截断元数据，fullOutputPath 归一化剔除后逐字段比对） */
	truncation: Record<string, unknown> | undefined;
	hasDisplayFullOutput: boolean;
}

function extract(result: unknown): ParityResult {
	const r = result as {
		content?: Array<{ type: string; text?: string }>;
		details?: { truncation?: Record<string, unknown>; fullOutputPath?: string } | undefined;
		structuredContent?: {
			output?: string;
			truncated?: boolean;
			full_output_path?: string;
			exit_code?: number;
		};
		isError?: boolean;
	};
	const textBlock = r.content?.find((block) => block.type === "text");
	const truncationRaw = r.details?.truncation;
	let truncation: Record<string, unknown> | undefined;
	if (truncationRaw !== undefined) {
		truncation = { ...truncationRaw };
		delete truncation.fullOutputPath;
	}
	return {
		text: normalizeFullOutputPath(textBlock?.text ?? ""),
		output:
			r.structuredContent?.output === undefined
				? undefined
				: normalizeFullOutputPath(r.structuredContent.output),
		exitCode: r.structuredContent?.exit_code,
		isError: r.isError,
		structuredTruncated: r.structuredContent?.truncated,
		truncation,
		hasDisplayFullOutput: r.details?.fullOutputPath !== undefined,
	};
}

/** 逐字比对（验收条款：不一致时断言消息含差异上下文——首个差异点邻域 + 双方全文，JSON.stringify 让不可见字符显形）。 */
function assertVerbatim(label: string, field: "text" | "output", official: ParityResult, wrapped: ParityResult): void {
	const a = official[field] ?? "";
	const b = wrapped[field] ?? "";
	if (a === b) return;
	let firstDiff = 0;
	const min = Math.min(a.length, b.length);
	while (firstDiff < min && a[firstDiff] === b[firstDiff]) firstDiff++;
	const ctxFrom = Math.max(0, firstDiff - 60);
	const ctx = (s: string) => JSON.stringify(s.slice(ctxFrom, firstDiff + 120));
	throw new Error(
		`${label}: ${field} 官方直跑与包装跑逐字不一致（首个差异索引 ${firstDiff}；` +
			`官方长度 ${a.length} / 包装长度 ${b.length}）\n` +
			`官方直跑差异上下文: ${ctx(a)}\n包装跑差异上下文:   ${ctx(b)}\n` +
			`官方直跑全文: ${JSON.stringify(a)}\n包装跑全文:   ${JSON.stringify(b)}`,
	);
}

/** 全量等价断言：text + structuredContent.output 逐字 + 退出码/错误态/截断元数据一致。 */
function assertParity(label: string, command: string, official: ParityResult, wrapped: ParityResult): void {
	assertVerbatim(label, "text", official, wrapped);
	if (official.output !== undefined || wrapped.output !== undefined) {
		assertVerbatim(label, "output", official, wrapped);
	}
	expect(wrapped.exitCode, `${label} exit_code 两形态等价（command: ${JSON.stringify(command)}）`).toBe(
		official.exitCode,
	);
	expect(wrapped.isError, `${label} isError 两形态等价（command: ${JSON.stringify(command)}）`).toBe(
		official.isError,
	);
	expect(wrapped.structuredTruncated, `${label} structuredContent.truncated 两形态等价（command: ${JSON.stringify(command)}）`).toBe(
		official.structuredTruncated,
	);
	expect(wrapped.truncation, `${label} 截断元数据等价（fullOutputPath 剔除后；command: ${JSON.stringify(command)}）`).toEqual(
		official.truncation,
	);
	expect(wrapped.hasDisplayFullOutput, `${label} display 截断的 Full output 存在性两形态一致（command: ${JSON.stringify(command)}）`).toBe(
		official.hasDisplayFullOutput,
	);
}

async function runBoth(command: string): Promise<[ParityResult, ParityResult]> {
	const official = extract(await runOfficial(command));
	const wrapped = extract(await runWrapped(command));
	return [official, wrapped];
}

beforeEach(() => {
	vi.stubEnv("PI_CODING_AGENT_DIR", AGENT_DIR);
	vi.stubEnv("TAIJI_AGENT_DATA_DIR", DATA_DIR);
	clearConfigCache();
});

afterEach(() => {
	vi.unstubAllEnvs();
	clearTaskStoreForTest();
});

afterAll(() => {
	for (const dir of [AGENT_DIR, DATA_DIR, CWD]) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
});

describe("透传等价：官方直跑 vs 包装跑逐字一致（§6.3 断言 #3 / A5 公理）", () => {
	it(
		"族1 stdout 多行输出逐字一致",
		{ timeout: PROCESS_CASE_TIMEOUT },
		async () => {
			const [official, wrapped] = await runBoth("printf 'parity-line-1\\nparity-line-2\\nparity-line-3\\n'");

			assertParity("族1", "printf 三行", official, wrapped);
			expect(official.text).toContain("parity-line-1");
			expect(official.text).toContain("parity-line-2");
			expect(official.text).toContain("parity-line-3");
		},
	);

	it(
		"族2a 退出码透传：exit 0",
		{ timeout: PROCESS_CASE_TIMEOUT },
		async () => {
			const [official, wrapped] = await runBoth("echo parity-ok");

			assertParity("族2a", "echo parity-ok", official, wrapped);
			expect(official.exitCode).toBe(0);
			expect(official.isError).toBeFalsy();
		},
	);

	it(
		"族2b 退出码透传：非零 exit 7",
		{ timeout: PROCESS_CASE_TIMEOUT },
		async () => {
			const [official, wrapped] = await runBoth("exit 7");

			assertParity("族2b", "exit 7", official, wrapped);
			expect(official.exitCode).toBe(7);
			expect(official.isError).toBe(true);
		},
	);

	it(
		"族3 截断脚注形态（3000 行触发官方 lines 截断，脚注经路径归一化后逐字一致）",
		{ timeout: PROCESS_CASE_TIMEOUT },
		async () => {
			const [official, wrapped] = await runBoth(`seq 1 ${TRUNCATION_LINES}`);

			// display 截断路径真实触发（details.truncation 口径；输出经官方同一
			// OutputAccumulator 管道，包装抄送流一并参与计数——3000 行 > 2000 行上限）
			expect(official.truncation?.truncated).toBe(true);
			expect(official.truncation?.totalLines).toBe(TRUNCATION_LINES);
			expect(official.truncation?.truncatedBy).toBe("lines");
			assertParity(`族3`, `seq 1 ${TRUNCATION_LINES}`, official, wrapped);
			// 脚注形态本身：尾部 2000 行 + Full output 归一化占位（官方每次随机临时路径，结构性不同一）
			expect(official.text).toMatch(
				new RegExp(
					`\\[Showing lines \\d+-${TRUNCATION_LINES} of ${TRUNCATION_LINES}\\. Full output: <FULL_OUTPUT_PATH>\\]$`,
				),
			);
		},
	);

	it(
		"族4 零输出命令的 \"(no output)\" 占位逐字一致",
		{ timeout: PROCESS_CASE_TIMEOUT },
		async () => {
			const [official, wrapped] = await runBoth("true");

			assertParity("族4", "true", official, wrapped);
			expect(official.text).toBe("(no output)");
		},
	);

	it(
		"族5 非零退出状态行形态逐字一致（前置输出 + Command exited with code N）",
		{ timeout: PROCESS_CASE_TIMEOUT },
		async () => {
			const [official, wrapped] = await runBoth("echo before-fail; exit 3");

			assertParity("族5", "echo before-fail; exit 3", official, wrapped);
			expect(official.exitCode).toBe(3);
			expect(official.text).toContain("before-fail");
			expect(official.text).toContain("Command exited with code 3");
		},
	);

	it(
		"族6 stdin 立即 EOF：head -n 1 两形态立即返回且结果逐字一致（stdio 误配 pipe 时挂住，由显式上界变红）",
		{ timeout: STDIN_TRAP_TIMEOUT },
		async () => {
			const startedAt = Date.now();
			const [official, wrapped] = await runBoth("head -n 1");
			const elapsedMs = Date.now() - startedAt;

			assertParity("族6", "head -n 1", official, wrapped);
			expect(official.exitCode).toBe(0);
			// 「立即」耗时判据：官方 stdin=ignore 探针 0.08s 量级；包装 stdio 误配 pipe 时
			// head -n 1 挂住 → 本用例先撞 STDIN_TRAP_TIMEOUT 变红，耗时断言作为快路径复核
			expect(
				elapsedMs,
				`stdin 族应立即 EOF 返回（两形态合计 ${elapsedMs}ms ≥ ${INSTANT_EOF_BUDGET_MS}ms 即非立即——检查包装 spawn 是否把 stdio 误配为 pipe）`,
			).toBeLessThan(INSTANT_EOF_BUDGET_MS);
		},
	);
});
