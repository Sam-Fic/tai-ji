/**
 * `!` 命令 user_bash 拦截层与包装执行（completion-signal-delivery M2 / U2，D3/D4）。
 *
 * 用户在输入框直发的 `!`（进上下文档）/ `!!`（不进上下文档）命令走 bash RPC → pi
 * emitUserBash 事件（UD3 契约通道）。本模块注册事件 handler：命中包装格时返回
 * { operations }——pi 侧 session.executeBash 经 executeBashWithOperations 用该
 * operations 执行（官方执行管线保留，组装层 output 截断 / BashResult 组装 / 回执
 * 契约全部官方原样）；未命中格与 fail-open 分支返回 undefined 走官方本地执行。
 * 不采用 result 完全接管（D4 否决：中止通道断裂 + 组装复刻漂移）。
 *
 * 与 agent 侧 A5 格（bash-tool.ts 前台包装层）的关系：`!` 通道无 timeout /
 * background / 白名单概念 → 包装格全量（无互斥分工判定）；格次共享配置读取
 * （idleBackgroundSec 经 loadBaseToolEnhanceConfig，与 bash-tool.ts 同源热重载）、
 * 非子代理（user_bash 事件只在主会话 RPC 发，判定与 A6 同源 isSubagentProcess）、
 * win32 排除（A7 沿袭）。用户显式 idleBackgroundSec=null = 关闭机制（opt-out），
 * 本通道同享回落官方执行。
 *
 * 复用先例交付设施、零重建（U2 职责边界）：wrapper 脚本（bin/taiji-fg-wrap，经
 * resolveFgWrapScriptPath）、登记链（registerConvertedTask——单例表 + registry +
 * pending:register + attachExitWatch 守望 + 超时接线，bash-tool.ts 导出面）、退出
 * 感知守望与完成通知链（exit-watch.ts / notify.ts 先例交付，登记后自动接管）。
 * cmd.sh / 包装参数构造在本文件自含（bash-tool.ts 的 prepareForegroundWrap 为私有
 * 函数且不在本单元 territory；构造形态与先例逐段对齐——taskId 三文件同目录同命名、
 * 命令原文写 cmd.sh 零转义，差异只有 spawn 形态：本模块直接 spawn wrapper 参数数组
 * 而非经官方 shell 命令串，路径无 shell 解析面）。
 *
 * 收尾判定（exec 内，pidfile × 标记行——bash-tool.ts settleConvertedCommand 同判据）：
 *  - pid 存活（B3 静默转后台 / B5 wrapper 异常死亡但命令活着）→ registerConvertedTask
 *    登记 + onData 发用户向标记行 + resolve({ exitCode: null })
 *  - pid 判死且无标记行（B2 正常完成）→ 不登记零感知 + 三文件清理 + 透传 wrapper
 *    退出码（wrapper wait 真实命令的原样透传）
 *  - pid 判死但有标记行（收尾窗口死亡形态：命令恰在收尾窗口死亡）→ 照常登记（标记行在 = 承诺在）
 *  - pidfile 不可读 → 不登记 + 尽力清理 + 透传退出码（wrapper spawn 毫秒窗口被杀的
 *    设计已接受代价 / usage 参数错误 exit 64·66 同落此分支，错误消息经 stderr 抄送可见）
 *
 * abort 通道（D4）：exec 接收官方 signal（abortBash 控制器传入），中止时杀 wrapper
 * 进程组（detached spawn 使 wrapper 成组长、真实命令同组一并死）→ 抛 "aborted" →
 * 官方组装 cancelled 结果（与官方本地 ops abort 形态同款）——用户中止语义与现状一致。
 *
 * fail-open 边界（AX5 无双执行）：spawn 前构造异常（cmd.sh 写失败等）在 handler 内
 * catch 后返回 undefined 走官方执行；构造成功后 exec 阶段不再有「返回 undefined」的
 * 分叉——单次命令恰好一条执行路径。
 *
 * `!!`（excludeFromContext=true）零分叉：handler 与收尾对该字段零读取——包装格判定
 * 与登记通知链路对两档一致；bashExecution 条目的上下文取舍由 pi 组装层既有行为承载
 * （recordBashResult 对 excludeFromContext 无分支），完成通知 custom 条目经既有通知链
 * 进对话流（N3：与现状同语义，不引入新分叉）。
 */

import { spawn } from "node:child_process";

import type {
	BashOperations,
	ExtensionAPI,
	ExtensionContext,
	UserBashEvent,
	UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { killProcessTree, isPidAlive } from "@zhushanwen/extension-protocol/background-task";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import {
	cleanupWrapFiles,
	FG_BG_MARKER_TAG,
	parsePidFile,
	prepareWrapFiles,
	registerConvertedTask,
	resolveFgWrapScriptPath,
	textHasFgBgMarker,
} from "./bash-tool.ts";
import { isSubagentProcess } from "./background/subagent-guard.ts";
import { resolveTaijiDataDir } from "./background/registry.ts";
import { loadBaseToolEnhanceConfig } from "./config.ts";

const logger = getLogger("base-tool-enhance");

/**
 * 标记行旁路检测的滚动窗口（字符数；标记行纯 ASCII，与字节窗口等效）：wrapper 标记行
 * 单行 printf 一次写入（≤ PIPE_BUF 原子到达，长约数百字符含日志路径），保留流末尾该
 * 量级即可覆盖完整行并容忍读侧 chunk 边界切分；同时给持续流式输出命令（B1 抄送直通
 * exec 生命周期）的字符串累积封顶内存。
 */
const MARKER_DETECT_WINDOW = 8192;

/**
 * 用户向标记行（D3 产品形态①：bash 气泡 output 尾部的转后台去向说明）。与 wrapper
 * 模型向标记行（三方协议、含 bash_output/bash_kill 工具语法、经抄送流先到）并存：
 * 用户没有工具，指引指向侧边栏；转后台登记成功即补发本行，恒一次（B3/B5 与收尾窗口死亡形态不分叉）。
 */
const USER_MARKER_NOTE =
	`${FG_BG_MARKER_TAG} 已转后台：命令仍在运行、尚未完成（暂无退出码）。` +
	`可在侧边栏「后台任务」中查看输出或停止；完成后会在对话流通知。`;

/** 包装命令执行的三文件与登记参数（与 bash-tool.ts ForegroundWrapPlan 同构；taskId 预生成——登记发生在收尾，id 必须事前已定）。 */
interface UserBashWrapPlan { // oe-exempt:20261101:framework:pi user_bash 管线的本扩展侧包装契约（对端消费 = pi 官方组装层，跨包不可达），载体关系登记文件头

	taskId: string;
	/** 原始命令全文（登记条目的 command 字段） */
	command: string;
	cmdShPath: string;
	logFile: string;
	pidfilePath: string;
	idleSec: number;
	dataDir: string;
	sessionId: string;
	/** 登记时经 registerConvertedTask 接线的后台超时（配置 backgroundTimeoutSeconds，C2 同款）。 */
	backgroundTimeoutSec: number | undefined;
}

/**
 * 包装格判定（与 agent 侧矩阵 A 格次共享配置读取）：`!` 通道无 timeout/background/
 * 白名单概念 → 剩余条件 = 非子代理（A6 同源）+ 非 win32（A7 沿袭）+ idleBackgroundSec
 * 非 null（用户 opt-out 同享回落）。配置每次读时加载（热重载契约，禁止上层缓存）。
 */
export function shouldWrapUserBash(): boolean {
	if (isSubagentProcess()) return false;
	if (process.platform === "win32") return false;
	if (loadBaseToolEnhanceConfig().idleBackgroundSec === null) return false;
	return true;
}

/**
 * 构造三文件与登记参数（路径组与 cmd.sh 写入走 bash-tool prepareWrapFiles 单点——
 * 「taskId 三文件同目录同命名」协议防漂移；本格只补 user_bash 侧字段）。形态与
 * bash-tool.ts prepareForegroundWrap 对齐，spawn 形态差异见文件头。写失败（目录只读
 * 等）原样抛出——handler fail-open 的注入点。
 */
function prepareUserBashWrap(command: string, sessionId: string): UserBashWrapPlan {
	const dataDir = resolveTaijiDataDir();
	const files = prepareWrapFiles(command, dataDir, sessionId);
	const config = loadBaseToolEnhanceConfig();
	return {
		...files,
		command,
		idleSec: config.idleBackgroundSec ?? 0,
		dataDir,
		sessionId,
		backgroundTimeoutSec: config.backgroundTimeoutSeconds ?? undefined,
	};
}

/**
 * user_bash 事件 handler（返回 undefined = 官方执行；{ operations } = 包装执行；
 * 绝不返回 { result }——result 完全接管已否决，D4）。构造异常 fail-open 返回
 * undefined（AX5：无双执行——构造失败时 wrapper 从未 spawn，官方执行恰好一次）。
 */
export function handleUserBash(event: UserBashEvent, ctx: ExtensionContext): UserBashEventResult | undefined {
	if (!shouldWrapUserBash()) return undefined;
	try {
		const plan = prepareUserBashWrap(event.command, ctx.sessionManager.getSessionId());
		return { operations: createUserBashOperations(plan) };
	} catch (err) {
		// fail-open（D4）：warn 留痕并指向恢复动作（磁盘/权限检查），命令照常官方执行
		logger.warn(
			"user_bash wrap prepare failed; falling back to official execution (check disk space / permissions of the taiji data dir).",
			{ detail: { command: event.command, err: toErrorMessage(err) } },
		);
		return undefined;
	}
}

/** extension load 时注册（事件每次 bash RPC 都发，handler 内部按格判定分流；重复 load 幂等——pi handler 列表随实例重建）。 */
export function registerUserBashInterceptor(pi: ExtensionAPI): void {
	pi.on("user_bash", handleUserBash);
}

/**
 * 包装执行 operations（单次命令一个实例——exec 闭包绑定 plan；exec 忽略 command
 * 形参、恒执行 plan 绑定的命令，官方契约的 command 形参仅为接口对齐）。已知边界
 * （设计 §4.3 V5 豁免登记）：pi executeBash 组装层在传给 operations.exec 的
 * command 前可能前置 shellCommandPrefix 高级设置（resolvedCommand = prefix ?
 * `${prefix}\n${command}` : command，pi agent-session.js；该设置默认缺席）。本实现
 * 的 cmd.sh 只写命令原文（plan.command，D4 包装形态），配置了 prefix 的环境下
 * 包装形态与官方直跑存在已知差异（prefix 在包装执行下不生效）；默认环境两者
 * 逐字一致（RL7）。
 */
function createUserBashOperations(plan: UserBashWrapPlan): BashOperations {
	return {
		exec: (_command, cwd, options) => execWrappedUserBash(plan, cwd, options),
	};
}

/**
 * abort 状态读取（函数形态打断 TS 对 readonly 属性的窄化——入口防御检查后 exec 期间
 * signal 可能被外部 abort，第二次读取必须基于运行时事实而非控制流推演）。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

async function execWrappedUserBash(
	plan: UserBashWrapPlan,
	cwd: string,
	options: {
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
		env?: NodeJS.ProcessEnv;
	},
): Promise<{ exitCode: number | null }> {
	// 与官方本地 ops 同款入口防御（bash.js createLocalShellOperations：已中止的
	// signal 进 exec 直接抛 aborted）
	if (isAborted(options.signal)) {
		cleanupWrapFiles(plan);
		throw new Error("aborted");
	}

	// spawn wrapper：detached（wrapper 成进程组组长）+ 真实命令 bash cmd.sh 同组
	// （abort 组杀全死，V7）；stdin ignore（读 stdin 命令立即 EOF，对齐官方 spawn 形态）；
	// stdout/stderr 管道（wrapper 抄送流 + 标记行走 stdout，wrapper 自身错误走 stderr，
	// 两流同送 onData——对齐官方 stdout+stderr 同管道形态）。参数数组直传无 shell 解析面。
	const child = spawn(
		resolveFgWrapScriptPath(),
		[
			"--idle",
			String(plan.idleSec),
			"--task-id",
			plan.taskId,
			"--log",
			plan.logFile,
			"--pidfile",
			plan.pidfilePath,
			"--",
			plan.cmdShPath,
		],
		{ cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] },
	);

	// 收尾窗口死亡形态判据的标记行旁路检测：wrapper 标记行经 stdout 抄送流到达 onData，是否已发
	// 在管道上检测（exec 无 result 对象可查——与 bash-tool resultHasFgBgMarker 同判据
	// 不同载体）。判定走 textHasFgBgMarker 结构化形态（标记前缀 + 本任务 task_id 同现）：
	// 命令输出恰含 "[TAIJI-FG-BG]" 字面量不再误置位；读侧滚动窗口见 MARKER_DETECT_WINDOW
	let markerWindow = "";
	let hasMarker = false;

	// abort 通道（RL5/V7）：中止杀 wrapper 进程组（killProcessTree 组杀语义——wrapper
	// 是 detached 组长，真实命令同组一并死）→ 抛官方式 aborted（executor catch
	// signal.aborted → cancelled: true 组装）——用户中止无登记（agent 侧同款语义 =
	// bash-tool.ts 文件头的「B4 用户中止→跳过判活直接清理」；矩阵 B4 只指用户中止
	// 形态，上方收尾判定表与 bash-tool settleConvertedCommand 注释里的「收尾窗口
	// 死亡形态」是另一形态，勿混淆），通道占用随 RPC 返回复位
	const onAbort = (): void => {
		if (child.pid !== undefined) killProcessTree(child.pid);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	// spawn 失败（wrapper 脚本缺失等）：命令未执行，尽力清理后原样上抛（非 abort 抛错
	// 由官方组装 error——fail-fast 显性暴露，与先例「执行期 exit 127 显性暴露」同语义）
	const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			child.once("error", (err) => {
				cleanupWrapFiles(plan);
				reject(err);
			});
			child.stdout?.on("data", (chunk: Buffer) => {
				markerWindow = (markerWindow + chunk.toString("utf8")).slice(-MARKER_DETECT_WINDOW);
				if (!hasMarker && textHasFgBgMarker(markerWindow, plan.taskId)) hasMarker = true;
				options.onData(chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => options.onData(chunk));
			child.once("exit", (code, signal) => resolve({ code, signal }));
		},
	).finally(() => {
		options.signal?.removeEventListener("abort", onAbort);
	});

	if (isAborted(options.signal)) {
		cleanupWrapFiles(plan);
		throw new Error("aborted");
	}

	// 收尾判定（pidfile × 标记行——bash-tool settleConvertedCommand 同判据表）
	const { pid } = parsePidFile(plan.pidfilePath);
	if (pid === undefined) {
		// wrapper 在写 pidfile 前死亡（spawn 毫秒窗口被杀的设计已接受代价 / usage 参数
		// 错误 exit 64·66 同落此分支——错误消息已经 stderr 抄送可见）：不登记 + 尽力清理
		cleanupWrapFiles(plan);
		return { exitCode: exitInfo.code ?? null };
	}
	if (!isPidAlive(pid) && !hasMarker) {
		// B2 正常完成：输出已经抄送管道完整透传，不登记零感知 + 三文件清理 +
		// 透传 wrapper wait 的真实退出码
		cleanupWrapFiles(plan);
		return { exitCode: exitInfo.code ?? null };
	}
	// 登记转后台（同进程直调登记链——registerConvertedTask 内部完成单例表 + registry +
	// pending:register + 守望 + 超时接线），三形态同一条登记路径：
	//  - B3 静默转后台 / B5 wrapper 异常死亡但命令存活（pid 活）
	//  - 收尾窗口死亡形态：命令恰在收尾窗口死亡但 wrapper 已打标记行（标记行在 =
	//    通知承诺在 = 必登记，守望首轮 ESRCH 兑现通知）
	// 登记后 onData 补发用户向标记行（恒一次，B3/B5 与收尾窗口死亡形态不分叉）→ resolve({ exitCode:
	// null })（官方组装层呈现 exitCode undefined + cancelled false，AS11；bash 通道占用
	// 随 RPC 返回复位——既有 release 路径自然结果，D3）
	registerConvertedTask({
		taskId: plan.taskId,
		pid,
		command: plan.command,
		dataDir: plan.dataDir,
		sessionId: plan.sessionId,
		timeoutSec: plan.backgroundTimeoutSec,
	});
	options.onData(Buffer.from(`${USER_MARKER_NOTE}\n`, "utf8"));
	return { exitCode: null };
}
