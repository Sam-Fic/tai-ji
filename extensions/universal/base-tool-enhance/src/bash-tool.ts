/**
 * bash 工具同名 override 定义。
 *
 * 前台行为 100% 委托 pi 官方工厂 createBashToolDefinition——override 后工具的全部
 * 行为归本包负责，前台语义必须跟随 pi 版本升级而不是自研复刻（自研 spawn 会与
 * pi 升级双向漂移，截断规则 / shellPath / PI_* env / stdin transport 细节遗漏即回归）。
 * 本模块真正的增量：
 *  1. input schema 新增 background?: boolean（D2：工具名保持 bash，只扩 schema）
 *  2. description 重写——官方文案不含 background 用法，不重写则模型永远发现不了
 *     新参数，「模型主动要求后台」的路径不可达
 *  3. background:true 分支（M2）：spawn 后台任务立即返回 task_id（D14：subagent
 *     进程内降级忽略 background，走前台同步语义）
 *  4. 白名单强制后台（M4，D3/D13）：命令命中 force-test/force-longrun/用户正则 →
 *     无视 background 参数强制后台，忽略 LLM 显式 timeout；双模式 timeout 配置注入
 *     （前台未填 → foregroundTimeoutSeconds，后台未填 → backgroundTimeoutSeconds）
 *  5. 空闲转后台包装层（foreground-idle-to-background M1，矩阵 A5）：无超时（显式与
 *     配置注入均无）且未命中白名单、非子代理、非 win32、idleBackgroundSec 非 null 的
 *     前台命令，命令原文写入 cmd.sh 后经包装脚本 taiji-fg-wrap 执行（空闲监控 + 转后
 *     台标记 + 输出落日志抄送，u-wrapper 交付物）；execute 收尾按 pidfile × 标记行
 *     判定——还活着（B3 静默转后台 / B5 包装异常）→ registerConvertedTask 登记 + 守
 *     望收尾；已死且无标记行（B2 正常完成）→ 不登记零感知 + 三文件清理；已死但有
 *     标记行 → 照常登记（标记行在 = 通知承诺在 = 必登记，守望首轮 ESRCH 收尾兑现通
 *     知）；官方 execute 抛错且 abort 已置（B4 用户中止）→ 跳过判活直接清理三文件
 *     （组杀后僵尸窗口内 isPidAlive 对将死进程返回 true，判活登记 = 幽灵通知）。
 *     执行本体仍是官方 delegate.execute（包装命令串交官方原样跑），透传等价契约不变
 *     （A5 公理）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	BashToolDetails,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { getProcessStartTimeSec, isPidAlive } from "@zhushanwen/extension-protocol/background-task";
import { Type } from "typebox";
import { isRecord, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { truncateCommand } from "./background/command-display.ts";
import { attachExitWatch } from "./background/exit-watch.ts";
import { emitPendingRegister } from "./background/notify.ts";
import {
	getRegistryPath,
	resolveTaijiDataDir,
	taskToRegistryEntry,
	writeRegistryEntry,
} from "./background/registry.ts";
import {
	armBackgroundTimeout,
	generateTaskId,
	resolveBackgroundTimeoutSec,
	spawnBackgroundTask,
} from "./background/spawn-background.ts";
import { isSubagentProcess } from "./background/subagent-guard.ts";
import { registerSpawnedTask } from "./background/task-store.ts";
import type { BackgroundTask } from "./background/types.ts";
import { loadBaseToolEnhanceConfig, type BaseToolEnhanceConfig } from "./config.ts";
import { compileForcePatterns, describeForceMatch, matchForceBackground } from "./force-patterns.ts";

const logger = getLogger("base-tool-enhance");

/**
 * override 后的 bash input schema。
 *
 * 在官方 schema（bash.js bashSchema：command + timeout?）基础上只追加 background。
 * timeout 单位与官方一致 = 秒；background 缺省 false（不传 = 前台，等价官方行为）。
 */
const enhancedBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional; if omitted, the configured default timeout applies when set)" }),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run in background: returns a task_id immediately instead of waiting for the command to finish. Default false.",
		}),
	),
});

/**
 * 重写的 bash description（给 LLM 的，英文，风格对齐官方文案 bash.js:233）。
 *
 * description 文案必须覆盖的要点（覆盖要求由本注释直接承载）：
 *  1. background:true 语义（立即返回 task_id，bash_output 查询 / bash_kill 终止）
 *  2. 白名单命中命令自动转后台（即使未要求 background）
 *  3. timeout 单位秒、显式填写会被尊重（唯一例外：白名单强转后台时忽略，D13）
 *  4. 自动通知契约（统一话术 "DO NOT bash sleep"）：任务完成 steer 自动唤醒新
 *     turn（notify.ts），LLM 文案必须传达「不要 sleep 空等」——实测大量 agent
 *     启动后台任务后跑 bash sleep 轮询空等，机制在而契约不在所致
 *
 * bash_output / bash_kill 工具由 M2 单元注册，description 先行提及（D2 要求）。
 */
const ENHANCED_BASH_DESCRIPTION = [
	"Execute a bash command in the current working directory. Returns stdout and stderr.",
	"Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file.",
	"Optionally provide a timeout in seconds; an explicit timeout is respected, except when a whitelisted long-running command is force-routed to background. If no timeout is given, a configured default timeout applies when set.",
	"",
	"Background mode: set background: true to start the command without waiting for it. The tool returns immediately with a task_id, the pid, and an output file path.",
	"Completion is auto-notified: when the task finishes, a steer message with its output tail wakes your next turn — DO NOT bash sleep (e.g. run `sleep 30` in another bash call) or busy-wait while it runs. Do useful non-overlapping work, otherwise just stop and let the notification arrive.",
	"bash_output {task_id} is for on-demand progress checks only (omit task_id to list known background tasks); never use it as a wait loop. Terminate a task with bash_kill {task_id}.",
	"",
	"Commands matching the force-background whitelist (test suites, dev servers, watch jobs and similar long-running commands) are automatically routed to background even when background was not requested; the result carries a task_id and completion auto-notifies — the same DO NOT bash sleep rule applies.",
	"",
	"Idle-to-background: when you give NO timeout (explicit or configured default) and the command is not whitelisted, the command runs under an idle monitor — if it produces no output for 600s (configurable), the tool call returns early with a [TAIJI-FG-BG] marker while the command keeps running (its output keeps going to a log file). That marker is NOT completion: there is no exit code yet. Read the captured output in the marker result first, then decide: keep waiting (the completion notification will arrive automatically — DO NOT bash sleep or busy-wait), check progress with bash_output, or terminate with bash_kill. A command that streams output continuously (monitors, tail -f style logs, while loops) never trips the idle threshold — pass an explicit timeout (it then runs natively and is killed at the deadline) or set background: true for such commands.",
].join("\n");

/**
 * spawn 后台任务并拼装立即返回的 tool result（白名单强转与显式 background:true
 * 两分支共用——spawn 入参、失败抛错、返回文案只有这一份，改文案不再有漏改分叉）。
 * extraNotes：分支差异文案（如 force 命中说明），插在 Output file 行与 Poll 指引之间。
 */
function startBackgroundAndReply(
	command: string,
	ctx: ExtensionToolContext,
	config: BaseToolEnhanceConfig,
	timeoutSec: number | undefined,
	extraNotes: string[] = [],
) {
	const spawned = spawnBackgroundTask({
		command,
		cwd: ctx.cwd,
		dataDir: resolveTaijiDataDir(),
		sessionId: ctx.sessionManager.getSessionId(),
		timeoutSec,
		maxConcurrent: config.maxConcurrentBackground,
	});
	if (!spawned.ok) {
		throw new Error(spawned.error);
	}
	const { task } = spawned;
	return {
		content: [
			{
				type: "text" as const,
				text: [
					`Background task started: ${truncateCommand(task.command)}`,
					`task_id: ${task.taskId}  pid: ${task.pid}`,
					`Output file: ${task.outputFile}`,
					...extraNotes,
					`Completion is auto-notified — DO NOT bash sleep while waiting. On-demand check: bash_output {task_id:"${task.taskId}"} (or omit task_id to list all tasks); terminate with bash_kill {task_id:"${task.taskId}"}.`,
				].join("\n"),
			},
		],
		details: undefined as undefined,
	};
}

/**
 * 白名单强制后台分支（D3/M4，execute 复杂度拆出）：判定在 execute 内部、不改写
 * input——permission 审批的永远是原始 command/background/timeout（P1 探针结论的
 * 前提）。命中 → 强制走 background，无视 background:false/缺省；D13：忽略 LLM 显式
 * timeout（unified-hooks 时代「跑测试带 timeout」习惯会精确复刻 §2.2 要解决的失败
 * 模式），按「配置默认 → 不限」取值。未命中返回 undefined（execute 继续后续分支）。
 */
function forcedBackgroundReply(
	args: { command: string; timeout?: number },
	ctx: ExtensionToolContext,
	config: BaseToolEnhanceConfig,
): ReturnType<typeof startBackgroundAndReply> | undefined {
	const forceMatch = matchForceBackground(
		args.command,
		compileForcePatterns(config.forceBackgroundPatterns, config.disableBuiltinForcePatterns),
	);
	if (forceMatch === undefined) return undefined;
	const timeoutSec = resolveBackgroundTimeoutSec(
		undefined,
		config.backgroundTimeoutSeconds ?? undefined,
	);
	const notes = [
		`Forced to background: command matched force-background whitelist ${describeForceMatch(forceMatch)}.`,
		...(args.timeout !== undefined
			? [
					`Ignored explicit timeout ${args.timeout}s for whitelisted command ` +
						`(background timeout: ${timeoutSec !== undefined ? `${timeoutSec}s (config default)` : "unlimited"}).`,
				]
			: []),
	];
	return startBackgroundAndReply(args.command, ctx, config, timeoutSec, notes);
}

/**
 * 矩阵 A5 包装执行（execute 复杂度拆出）：包装执行 + 空闲转后台。执行本体仍是官方
 * delegate（包装命令串交官方原样跑，timeout 缺省 = 官方无超时语义；转后台后的超时 =
 * backgroundTimeoutSeconds，由 registerConvertedTask 的 armBackgroundTimeout 接线
 * 承担）。收尾统一读 pidfile 判定命令进程存活性：还活着（B3 静默转后台 / B5 包装
 * 异常）→ 登记；已死（B2 正常完成）→ 不登记零感知 + 三文件清理。
 *
 * B4 用户中止（abort 按进程组整组杀）前置跳过判活收尾：pi 组杀后抛错不等真实命令
 * 被系统收尸，收尾判活 isPidAlive（kill -0 只查 pid 存在性）对僵尸进程返回 true →
 * 误登记转后台任务 → 守望 2s 后 ESRCH 收尾发幽灵「finished」通知唤醒新回合。abort
 * 信号已置即属用户中止形态：直接清理三文件后原样上抛（无登记 = 无守望 = 无通知）。
 */
async function runWrappedForegroundExecute(
	toolCallId: string,
	args: { command: string },
	idleSec: number,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
	ctx: ExtensionToolContext,
	config: BaseToolEnhanceConfig,
	delegate: ReturnType<typeof createBashToolDefinition>,
) {
	const dataDir = resolveTaijiDataDir();
	const sessionId = ctx.sessionManager.getSessionId();
	const plan = prepareForegroundWrap(args.command, dataDir, sessionId, idleSec);
	try {
		const result = await delegate.execute(
			toolCallId,
			{ command: plan.wrappedCommand, timeout: undefined },
			signal,
			onUpdate,
			ctx,
		);
		// 收尾判据（settleConvertedCommand 注释）：标记行在 = 承诺在 = 必登记——
		// pid 判死也不清理（收尾窗口死亡形态：命令恰在收尾窗口死亡时通知承诺
		// 不落空；矩阵 B4「用户中止」是另一形态，见下方 catch 分支）
		const converted = settleConvertedCommand(
			plan,
			dataDir,
			sessionId,
			config.backgroundTimeoutSeconds ?? undefined,
			resultHasFgBgMarker(result),
		);
		// B5 补标记：wrapper 未及打印标记行（异常死亡）时由本层补齐；B3 已打印
		// → 透传不动（登记后结果文本透传原则：标记行已在输出内，模型直接可读）。
		// 与 settle 的 hasMarker 判据双向闭合：标记行在 = 必登记；登记且无标记 = 必补
		if (converted !== undefined && !resultHasFgBgMarker(result)) {
			return appendTextToResult(result, buildConvertedMarkerNote(converted));
		}
		return result;
	} catch (err) {
		if (signal?.aborted === true) {
			cleanupWrapFiles(plan);
			throw err;
		}
		// 非 abort 的官方 execute 抛错（spawn 失败等形态——命令进程死活未定，
		// 判活收尾仍需执行）→ 收尾判定照走（抛错路径无 result 可判标记，恒
		// hasMarker=false 走 pid 判定），官方式错误原样上抛（不吞不改写）
		settleConvertedCommand(
			plan,
			dataDir,
			sessionId,
			config.backgroundTimeoutSeconds ?? undefined,
			false,
		);
		throw err;
	}
}

// ───────────── 空闲转后台包装层（foreground-idle-to-background，矩阵 A5）─────────────

/**
 * 包装脚本双形态探测（逐字对齐 plan/templates.ts getBuiltinTemplateDir 先例）：
 *  - 源码形态（npm 安装 / dev jiti 直接加载 src/bash-tool.ts）：__dirname = <pkg>/src，
 *    脚本在 `../bin/taiji-fg-wrap`（包根 bin/，随 files 白名单发布）。
 *  - bundle 形态（staged 打包内置，esbuild 把本文件 inline 进包根 index.js）：
 *    __dirname = …/extensions/@zhushanwen/pi-base-tool-enhance，脚本由
 *    bundle-extensions.mjs 专项拷贝到同级 `bin/`。若仍按 `../bin` 推导会错位一级
 *    解析到 …/@zhushanwen/bin/taiji-fg-wrap（不存在）→ 打包版每条包装命令串指向
 *    不存在的脚本，全部常规前台命令 exit 127。
 * 探测先 bundle 形态后源码形态：两形态目录互斥（staged 无 src/；源码布局 src/ 下
 * 无 bin/），existsSync 判别即可定位；均缺失时回退源码形态路径（改写层只构造命令串
 * 不依赖脚本已存在——真 wrapper 缺失在执行期 exit 127 显性暴露，fail-fast 可见）。
 */
export function resolveFgWrapScriptPath(): string {
	const bundleForm = fileURLToPath(new URL("./bin/taiji-fg-wrap", import.meta.url));
	if (existsSync(bundleForm)) return bundleForm;
	return fileURLToPath(new URL("../bin/taiji-fg-wrap", import.meta.url));
}

/** 包装脚本转后台标记行前缀（设计 §5 部件 3 三方契约；B5 补标记判据 = wrapper 已打印则不重复补）。 */
const FG_BG_MARKER_TAG = "[TAIJI-FG-BG]";

/** POSIX shell 单引号引用（包装命令串中路径段防空格/特殊字符；win32 不走本层——矩阵 A7）。 */
function shQuote(pathSegment: string): string {
	return `'${pathSegment.replace(/'/g, `'\\''`)}'`;
}

/** 包装命令执行的三文件（与任务日志同目录 = registry.json 同目录）。 */
interface ForegroundWrapPlan {
	taskId: string;
	/** 原始命令全文（登记条目的 command 字段） */
	command: string;
	cmdShPath: string;
	logFile: string;
	pidfilePath: string;
	wrappedCommand: string;
	idleSec: number;
}

/**
 * A5 改写：命令原文写 cmd.sh（零转义、零长度限制——bash 直接解释文件，无注入面）
 * 并构造包装命令串交官方 execute。taskId 预生成（generateTaskId 同款形态）：--task-id
 * 传包装脚本，--log/--pidfile 路径与（可能的）登记条目共用同一 id——登记发生在收尾，
 * 包装脚本的标记行在退出时打印，id 必须事前已定（B2 正常完成时 id 弃用，无冲突）。
 */
function prepareForegroundWrap(
	command: string,
	dataDir: string,
	sessionId: string,
	idleSec: number,
): ForegroundWrapPlan {
	const taskId = generateTaskId();
	const tasksDir = dirname(getRegistryPath(dataDir, sessionId));
	const cmdShPath = join(tasksDir, `${taskId}.sh`);
	const logFile = join(tasksDir, `${taskId}.log`);
	const pidfilePath = join(tasksDir, `${taskId}.pid`);
	mkdirSync(tasksDir, { recursive: true });
	writeFileSync(cmdShPath, command.endsWith("\n") ? command : `${command}\n`, "utf8");
	const wrappedCommand = [
		shQuote(resolveFgWrapScriptPath()),
		"--idle",
		String(idleSec),
		"--task-id",
		taskId,
		"--log",
		shQuote(logFile),
		"--pidfile",
		shQuote(pidfilePath),
		"--",
		shQuote(cmdShPath),
	].join(" ");
	return { taskId, command, cmdShPath, logFile, pidfilePath, wrappedCommand, idleSec };
}

/**
 * pidfile 读取（wrapper 写、改写层读的协议载体，bin/taiji-fg-wrap 实装对齐）：单行 JSON
 * `{"pid":<n>,"pidStartTimeSec":<epoch秒>}`，读侧只消费 pid。pidStartTimeSec 不作为
 * 登记值（它是 wrapper spawn 后的墙钟近似，跨秒边界可比真实启动秒大 1；身份校验消费方
 * 与 getProcessStartTimeSec 严格相等比对无容差，采信近似值会恒失配 → 守望首轮误判
 * pid 复用、假终态+假完成通知——见 registerConvertedTask 同源直读）。解析防御：文件
 * 缺失 / JSON 损坏 / 字段非法 → pid undefined；空格分隔 `<pid> <pidStartTime>` 旧文本
 * 形态保留回退（协议漂移防御，同样只取首字段 pid）。
 * pidfile 缺失 = wrapper 在 spawn 与写 pidfile 的毫秒窗口内被杀（设计 §5 部件 1 已接受
 * 形态：B5 兜底对该次失效，命令进程可能残留，与 pi 原生执行中宿主崩溃的残留同级）→
 * 不登记（无 pid 可管），cmd.sh 尽力清理。
 */
export function parsePidFile(pidfilePath: string): { pid?: number } {
	let raw: string;
	try {
		raw = readFileSync(pidfilePath, "utf8").trim();
	} catch {
		return {};
	}
	const toPid = (value: unknown): number | undefined => {
		const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
		return Number.isInteger(n) && n > 0 ? n : undefined;
	};
	// JSON 单一契约（wrapper 写侧自首个交付起只写 {"pid",...} 形态，无旧文本格式）；
	// 缺失 / 损坏 / 字段非法 → {}（不崩溃、不误判活）
	if (!raw.startsWith("{")) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isRecord(parsed)) {
			const pid = toPid(parsed.pid);
			if (pid !== undefined) return { pid };
		}
	} catch (err) {
		// JSON 损坏 → {}（协议防御路径）；warn 留痕（taste/no-silent-catch）
		logger.warn(`[bash-tool] fg-wrap marker 解析失败，按缺失处理: ${String(err)}`)
	}
	return {};
}

/**
 * 转后台登记（只登记不 spawn）：包装命令 execute 返回、收尾判定命令进程还活着
 * （B3 静默转后台 / B5 包装异常兜底）时的登记入口。三步对齐 spawnBackgroundTask 登记
 * 链路（spawn-background.ts 范式）：
 *   ① registerSpawnedTask（内存单例表，运行时权威）
 *   ② writeRegistryEntry（registry 落盘 running 条目）
 *   ③ emitPendingRegister（pending:register emit——session_start 差集对账前提）
 * 不挂 attachExitCollector（转后台命令非本进程 child，无 exit 事件边沿）——退出感知
 * 由 exit-watch.ts 的 pid 守望承载（attachExitWatch，部件 5）。
 * 超时启用接线（矩阵 C2）：backgroundTimeoutSeconds 经 armBackgroundTimeout（自
 * spawn-background.ts 导出）挂 task.timeoutTimer——漏接则转后台任务不受后台超时约束。
 * 并发池关系（设计 §5 部件 2）：**不过并发门**（池满不拒——命令已存活，拒绝登记 =
 * 标记行已打印而任务不存在 + 孤儿进程；spawn 侧 maxConcurrentBackground 上限语义 =
 * spawn 准入控制，非表容量硬限）。登记进表即为 running 条目、计入 countActiveTasks、
 * 占用池（挤占形态 = 池满时显式后台 spawn 被拒，错误文案含 bash_kill 指引可处置）。
 */
export function registerConvertedTask(opts: {
	taskId: string;
	pid: number;
	command: string;
	dataDir: string;
	sessionId: string;
	timeoutSec?: number;
}): BackgroundTask {
	const registryPath = getRegistryPath(opts.dataDir, opts.sessionId);
	const outputFile = join(dirname(registryPath), `${opts.taskId}.log`);
	// pidStartTime（pid 复用防御，spawn-background M3 补写同款）：登记时同源直读
	// getProcessStartTimeSec——与全部身份校验消费方（守望 / bash_kill / 后台超时 /
	// reaper）同经 ps lstart，严格相等比对（pidStartMatchesRegistered 无容差）才能
	// 成立。pidfile 的 pidStartTimeSec 是 wrapper 墙钟近似（跨秒边界可比真实值大
	// 1），采信它会让守望首轮误判 pid 复用 → 对在跑任务假终态+假完成通知。登记时
	// 进程刚经 isPidAlive 验活（改写层收尾判定），直读几乎必成；读不到省略（消费方
	// 降级 startedAt 秒级校验兜底——floor 单调性零误跳，优于回退墙钟近似值）
	const pidStartTime = getProcessStartTimeSec(opts.pid);
	const task: BackgroundTask = {
		taskId: opts.taskId,
		pid: opts.pid,
		command: opts.command,
		outputFile,
		registryPath,
		startedAt: Date.now(),
		state: "running",
		ownerPiPid: process.pid,
		sessionId: opts.sessionId,
		...(pidStartTime !== undefined ? { pidStartTime } : {}),
		// child 缺省：转后台命令非本进程 spawn，无 ChildProcess 句柄（exit 感知归守望）
	};
	if (opts.timeoutSec !== undefined) {
		armBackgroundTimeout(task, opts.timeoutSec);
	}
	registerSpawnedTask(task);
	writeRegistryEntry(registryPath, taskToRegistryEntry(task));
	emitPendingRegister(task);
	// 退出感知守望（部件 5）：2s 轮询 pid，ESRCH / pid 复用 → finalize 链收尾
	attachExitWatch(task);
	return task;
}

/** 三文件清理（cmd.sh/pidfile/日志，B2 无登记条目则文件无消费方，输出已经官方管道完整透传；防「调用频次 × 会话寿命」的单调累积）。对中途异常尽力而为（rmSync force，缺哪个删哪个）。 */
function cleanupWrapFiles(plan: ForegroundWrapPlan): void {
	for (const path of [plan.cmdShPath, plan.pidfilePath, plan.logFile]) {
		try {
			rmSync(path, { force: true });
		} catch (err) {
			logger.debug("foreground-wrap cleanup failed (best-effort)", {
				detail: { path, err: toErrorMessage(err) },
			});
		}
	}
}

/**
 * execute 收尾统一判定（§4.3 登记判据 = pid 存活性 × 标记行，B2/B3/B5 与收尾窗口
 * 死亡形态收口；矩阵 B4「用户中止」不经此——调用方 catch 分支 abort 前置跳过判活）：
 *  - pidfile 可读且 pid 活 → 登记为后台任务（返回条目，调用方按需补标记行）
 *  - 判死且无标记行 → 不登记零感知 + 删除本次三文件（B2 正常完成：输出已经官方
 *    管道完整透传，无登记条目则文件无消费方）
 *  - 判死但有标记行（收尾窗口死亡形态）→ 照常登记：标记行在 = 承诺在（"It will notify on
 *    completion"）= 必登记——无登记无守望则通知永不到来，且三文件清理会让标记行引用
 *    的日志路径落空。登记后 attachExitWatch 首轮（≤2s）ESRCH 收尾、通知兑现，退出码
 *    如实报 unknown（转后台任务退出码结构性不可得，notify.ts 已登记形态）。
 *  - pidfile 不可读（pid undefined）→ 不登记 + 尽力清理（spawn 毫秒窗口被杀的设计已
 *    接受代价；「标记行在 + pidfile 缺失」真实序列不可达——标记打印在监控循环内，
 *    前提是 pidfile 早已写毕，防御侧仍走清理：无 pid 可管，登记无载体）。
 * hasMarker 与调用方「登记后不重复补标记」逻辑形成同一判据双向闭合：标记行在 = 承诺在
 * = 必登记；登记成功且无标记行 = 必补标记（B5）。
 */
function settleConvertedCommand(
	plan: ForegroundWrapPlan,
	dataDir: string,
	sessionId: string,
	backgroundTimeoutSec: number | undefined,
	hasMarker: boolean,
): BackgroundTask | undefined {
	const { pid } = parsePidFile(plan.pidfilePath);
	if (pid === undefined || (!isPidAlive(pid) && !hasMarker)) {
		cleanupWrapFiles(plan);
		return undefined;
	}
	return registerConvertedTask({
		taskId: plan.taskId,
		pid,
		command: plan.command,
		dataDir,
		sessionId,
		timeoutSec: backgroundTimeoutSec,
	});
}

/** B5 补标记（设计 §3.2 失败路径）：wrapper 异常死亡未及打印标记行时，由改写层在结果尾部补齐（命令仍在跑、日志路径、查询/终止用法）。 */
function buildConvertedMarkerNote(task: BackgroundTask): string {
	return [
		`${FG_BG_MARKER_TAG} Command moved to background (the wrapper exited without printing its marker) — still running, NOT finished (no exit code yet).`,
		`Full log: ${task.outputFile}`,
		`Check: bash_output {task_id:"${task.taskId}"}; terminate: bash_kill {task_id:"${task.taskId}"}.`,
		"It will notify on completion — DO NOT bash sleep while waiting.",
	].join("\n");
}

/** 首个 text 块尾部追加（无 text 块则追加一块；content 类型面 = pi AgentToolResult 判别联合，窄化零断言）。 */
function appendTextToResult<T extends AgentToolResult<unknown>>(result: T, note: string): T {
	for (const block of result.content) {
		if (block.type === "text") {
			block.text = `${block.text}\n${note}`;
			return result;
		}
	}
	result.content.push({ type: "text", text: note });
	return result;
}

/** 结果文本是否已含 wrapper 标记（收尾判定本身走 pidfile，此处仅判 B5 补标记的必要性——B3 已打印则透传不动，不解析标记内容）。 */
function resultHasFgBgMarker(result: AgentToolResult<unknown>): boolean {
	return result.content.some((block) => block.type === "text" && block.text.includes(FG_BG_MARKER_TAG));
}

/**
 * 构建 bash override 的 ToolDefinition。
 *
 * cwd 处理：官方工厂在调用时固化 cwd（execute 闭包捕获），而 extension load 时机
 * 早于会话 cwd 确定。因此以 execute 时 ctx.cwd 为权威：cwd 变化（cd / session 切换）
 * 就地重建 delegate；同 cwd 复用（工厂是纯函数，重建仅多创建 ops 闭包，单槽缓存
 * 防止每次工具调用重复构建）。promptSnippet / promptGuidelines / renderCall /
 * renderResult 等未覆盖字段从官方 delegate 展开透传——override 掉整个 definition
 * 后不透传会丢掉系统提示里的工具片段（types.d.ts ToolDefinition：无 promptSnippet
 * 的 custom tool 会被 Available tools 段省略）与 TUI 渲染（pi 0.84.1 bash 实装的
 * renderCall 命令格式化 / renderResult elapsed 计时与富结果组件）。
 */
export function createBashOverrideToolDefinition() {
	let cachedCwd: string | undefined;
	// 官方工厂返回值的形状 = ToolDefinition（bash.js createBashToolDefinition），
	// 类型交由 pi 公开导出推断，不在本地重复声明（防与 pi 升级漂移）。
	type OfficialBashTool = ReturnType<typeof createBashToolDefinition>;
	let cachedDelegate: OfficialBashTool | undefined;

	const getDelegate = (cwd: string): OfficialBashTool => {
		if (cachedDelegate === undefined || cachedCwd !== cwd) {
			cachedDelegate = createBashToolDefinition(cwd);
			cachedCwd = cwd;
		}
		return cachedDelegate;
	};

	// registerTool 发生在 extension load 时（无 execute ctx），初始 delegate 用
	// 进程 cwd 建立——name/label/promptSnippet/renderCall/renderResult 等静态字段与
	// cwd 无关，execute 路径会被 getDelegate(ctx.cwd) 纠正。
	const initial = getDelegate(process.cwd());

	return {
		// 官方 delegate 展开透传（render 面委托）：pi 0.84.1 bash definition 实装带
		// renderCall（命令格式化）/ renderResult（elapsed 计时、富结果组件），独立
		// pi TUI 用户安装本包后渲染不降级为通用组件——凡未在下方显式覆盖的字段
		// （label/promptSnippet/promptGuidelines/renderCall/renderResult 等）全部随
		// delegate 透传，cwd 重建 delegate 时静态闭包引用不变（render 闭包与 cwd 无关）
		...initial,
		// D2（禁止改名）：桌面侧六处按工具 key 'bash' 硬编码（truncate-tool-output、
		// useToolMeta、block-icon、pi-preset BUILTIN_TOOLS 与 deniedTools、permission
		// extractCommand）——改名后这些消费方全部失配，审批退化为逐次弹窗、渲染错位
		name: initial.name, // "bash"：同名覆盖内置工具（agent-session _refreshToolRegistry 后注册者胜）
		description: ENHANCED_BASH_DESCRIPTION,
		parameters: enhancedBashSchema,
		async execute(
			toolCallId: string,
			args: { command: string; timeout?: number; background?: boolean },
			signal: AbortSignal | undefined,
			// 与官方 delegate 同型（展开透传后泛型 TDetails=BashToolDetails|undefined
			// 随 render 面传入，execute 签名必须对齐，否则 registerTool 赋值检查不过）
			onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
			// pi 1.0.0：ToolDefinition.execute 第 5 参 ctx 收窄为 ExtensionToolContext
			// （ExtensionContext + tools/executeTool，嵌套工具调用点）
			ctx: ExtensionToolContext,
		) {
			// 配置每次 execute 读时加载（热重载契约：禁止上层缓存，同进程改配置文件
			// 不重启即生效）。D14：subagent 降级是全量的——白名单与 background 参数
			// 同时失效（判定一次，两个分支共用）
			const config = loadBaseToolEnhanceConfig();
			const subagent = isSubagentProcess();

			// 白名单强制后台（D3/M4）：判定在 execute 内部、不改写 input——permission
			// 审批的永远是原始 command/background/timeout（P1 探针结论的前提）。命中 →
			// 强制走 background，无视 background:false/缺省（分支本体见 forcedBackgroundReply）
			if (!subagent) {
				const forced = forcedBackgroundReply(args, ctx, config);
				if (forced !== undefined) return forced;
			}

			// background 分支（M2）：显式 background:true 且非 subagent 降级（D14——
			// subagent 进程内忽略 background 走前台，保持内置同步语义）。abort/interrupt
			// 不传播到后台任务（D15）：本分支不接触 signal，立即返回
			if (args.background === true && !subagent) {
				// timeout 优先级：LLM 显式值 > 配置默认 > 不限；无效显式值沿用
				// pi 内置文案抛错（注入只发生在「LLM 未填 && 配置了默认」，D4）
				const timeoutSec = resolveBackgroundTimeoutSec(args.timeout, config.backgroundTimeoutSeconds ?? undefined);
				return startBackgroundAndReply(args.command, ctx, config, timeoutSec);
			}
			const delegate = getDelegate(ctx.cwd);
			// 前台路径：只转发官方 schema 已识别的字段（command/timeout），background
			// 是本包增量，官方 execute 不认识（其解构也只取这两个键，显式构造让
			// 「本层转发侧」在代码上自解释）。subagent 降级（D14）与 background 缺省
			// 都落到这条路径。
			//
			// 前台 timeout 注入（M4/G3）：LLM 未填 && foregroundTimeoutSeconds 配置了
			// 默认 → 注入；默认 null 不注入。注入与 subagent 降级正交——D14 只废
			// background/白名单语义，前台默认超时是全局挂死保护
			const foregroundTimeout =
				args.timeout !== undefined ? args.timeout : (config.foregroundTimeoutSeconds ?? undefined);

			// 矩阵 A3/A4（§4.4 timeout 与转后台互斥分工，A 级）：超时存在（显式或配置
			// 注入）= 模型/用户已选定「到点杀」处置策略，命令原样交官方——不包装、无
			// 转后台。两机制互斥，无并存武装。
			if (foregroundTimeout !== undefined) {
				return delegate.execute(
					toolCallId,
					{ command: args.command, timeout: foregroundTimeout },
					signal,
					onUpdate,
					ctx,
				);
			}

			// 矩阵 A5 前置例外（全部回落官方原生，与现状逐字一致）：
			//  - A6：子代理进程内一律官方原生执行（§4.5——不包装不登记，subagent-guard
			//    文件头两条降级理由：结构化输出契约 + 孤儿无人收殓）
			//  - A7：win32 回落（包装脚本暂不支持 Windows，差距 G7，M3 波次消除）
			//  - N3：idleBackgroundSec=null（用户显式关闭机制，opt-out 语义）
			const idleSec = config.idleBackgroundSec;
			if (
				subagent ||
				process.platform === "win32" ||
				idleSec === null
			) {
				return delegate.execute(
					toolCallId,
					{ command: args.command, timeout: undefined },
					signal,
					onUpdate,
					ctx,
				);
			}

			// 矩阵 A5：包装执行 + 空闲转后台（执行本体见 runWrappedForegroundExecute）。
			return runWrappedForegroundExecute(
				toolCallId,
				args,
				idleSec,
				signal,
				onUpdate,
				ctx,
				config,
				delegate,
			);
		},
	};
}
