/**
 * 转后台任务退出感知守望（foreground-idle-to-background 设计 §5 部件 5）。
 *
 * 为什么存在：包装命令转后台后，真实命令由包装脚本 spawn（同进程组），extension
 * 进程非其父、无 ChildProcess 句柄——exit-collector 的 `task.child?.on("exit")`
 * optional chaining 静默失效，完成通知与终态落定（矩阵 C1）无载体。本模块为转后台
 * 登记的任务起 pid 轮询守望（唯一可达通道：跨进程退出事件无跨平台原语——macOS
 * kqueue EVFILT_PROC 可监听任意进程、Linux 无等价；轮询先例：PingProbe 进程健康
 * 探测。退役条件 = 出现跨平台跨进程退出事件通道时改事件驱动）。退出感知延迟 2s
 * 对已转后台任务无感（模型不在等待它）。
 *
 * 持有者 = 模块级单例（非实例级）：同进程 session 替换会重新 load extension 实例、
 * 实例级状态随 dispose 消失，模块级跨替换存活（task-store.ts 文件头同范式）——
 * 守望做成实例级会在 session 替换后丢失转后台任务的退出感知。
 *
 * 谓词对齐 reaper / BackgroundTaskService 既有范式（判死与身份校验分离）：
 *  - 退出判定 = isPidAlive 的 ESRCH（内核判定无此 pid，无歧义，无需 start-time
 *    校验——reaper 同款）→ 走 finalize 链（终态落定 + 完成通知，与 exit 边沿同一条
 *    收尾路径：finalizeTask + registry 终态写 + handleTaskExit）
 *  - 身份校验仅服务判活防复用（进程存活时才做）：getProcessStartTimeSec 读得到且
 *    匹配登记值（pidStartMatchesRegistered 单点判定，startedAt 秒级降级同款）→
 *    在跑，继续守望；读得到且不匹配 → pid 复用 → 按退出收尾（不杀——那是别人的
 *    进程）
 *  - 读不到（undefined）= 无法校验 → 保守跳过本轮（三类来源：进程不存在 / ps 失败
 *    或超时 / 输出不可解析，background-task-process.ts 原语契约明文「调用方一律按
 *    无法校验 → 保守跳过」；进程真死最终由 ESRCH 兜住——下一轮重判）
 *
 * 与 exit-collector 的协作：bash_kill / armBackgroundTimeout 到点 kill 后无 exit
 * 事件边沿可用（无 child 句柄），终态由本守望的 ESRCH 轮次收尾——intent（内存）
 * 与 registry killing 预写的消费逻辑与 finalizeExitedTask 同语义。
 */

import {
	getProcessStartTimeSec,
	isPidAlive,
	pidStartMatchesRegistered,
} from "@zhushanwen/extension-protocol/background-task";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { handleTaskExit } from "./notify.ts";
import { readTailSummary } from "./output-tail.ts";
import { readRegistry, taskToRegistryEntry, writeRegistryEntry } from "./registry.ts";
import { finalizeTask, getTask } from "./task-store.ts";
import { isTerminalState, type BackgroundTask, type BackgroundTaskEndReason } from "./types.ts";

const logger = getLogger("base-tool-enhance");

/** 守望轮询间隔：2s（设计 §5 部件 5；退出感知延迟 ≤4s 含容差，矩阵 C1/V11）。 */
export const EXIT_WATCH_INTERVAL_MS = 2_000;

/** 模块级单例：taskId → interval timer（跨 session 替换存活，见文件头）。 */
const watchTimers = new Map<string, ReturnType<typeof setInterval>>();

/**
 * 为转后台登记的任务挂接 pid 守望（登记链路调用，对称于 spawnBackgroundTask 的
 * attachExitCollector）。幂等：同 taskId 重复挂接被忽略。
 */
export function attachExitWatch(task: BackgroundTask): void {
	if (watchTimers.has(task.taskId)) return;
	const timer = setInterval(() => {
		try {
			pollConvertedTaskOnce(task);
		} catch (err) {
			// 单轮判定失败（registry/日志 IO 异常等）不终止守望：下一轮重判
			logger.warn("exit watch poll failed; will retry next tick", {
				detail: { taskId: task.taskId, err: toErrorMessage(err) },
			});
		}
	}, EXIT_WATCH_INTERVAL_MS);
	timer.unref?.();
	watchTimers.set(task.taskId, timer);
}

function stopWatch(taskId: string): void {
	const timer = watchTimers.get(taskId);
	if (timer !== undefined) {
		clearInterval(timer);
		watchTimers.delete(taskId);
	}
}

/** 测试专用：清空全部守望 timer（模块级状态跨测试文件存活，必须显式复位）。 */
export function clearExitWatchesForTest(): void {
	for (const taskId of [...watchTimers.keys()]) stopWatch(taskId);
}

/**
 * 守望单轮判定（间隔回调与测试共用同一单元——三分支真值表的可测入口）：
 *  1. 条目已终态 / 已不在表（bash_kill 进程内路径、进程退出收殓等并发收尾先到）→
 *     摘除守望，不重复收尾（finalizeTask 单一终态归属的旁路防御）；
 *  2. ESRCH → 摘除守望 + 收尾；
 *  3. 身份漂移（读得到 start time 但不匹配登记值）→ 摘除守望 + 收尾（不杀）；
 *  4. 读不到 start time → 保守跳过本轮（不判死不收尾）；
 *  5. 身份匹配 → 在跑，继续守望。
 */
export function pollConvertedTaskOnce(task: BackgroundTask): void {
	const current = getTask(task.taskId);
	if (current === undefined || isTerminalState(current.state)) {
		stopWatch(task.taskId);
		return;
	}
	// 退出判定 = ESRCH（内核判定无此 pid，无歧义——无需 start-time 校验，reaper 范式）
	if (!isPidAlive(task.pid)) {
		stopWatch(task.taskId);
		finalizeConvertedExit(task);
		return;
	}
	// 身份校验（仅判活防复用）：读不到 = 无法校验 → 保守跳过本轮（绝不 finalize）
	const actualStartSec = getProcessStartTimeSec(task.pid);
	if (actualStartSec === undefined) return;
	if (!pidStartMatchesRegistered(actualStartSec, task.pidStartTime, task.startedAt)) {
		// pid 复用：登记的原进程已不在，现占该 pid 的是无关进程 → 按退出收尾，不杀
		stopWatch(task.taskId);
		finalizeConvertedExit(task);
		return;
	}
}

/**
 * 收尾（与 exit-collector 的 exit 边沿同一条 finalize 链）：exitCode 恒 null（转后台
 * 命令 reparent 到 init、extension 非其父、wait 不可用——退出码结构性不可得）→
 * reason 判定（内存 intent 优先，缺省读回 registry killing——D6-en 跨进程 UI 代杀
 * 预写，与 finalizeExitedTask 同语义）→ 单例表 + registry 两侧写终态 → handleTaskExit
 * （pending:unregister + 完成通知；killed 零投递规则由 notify 统一裁决）。
 */
function finalizeConvertedExit(task: BackgroundTask): void {
	const reason = task.intent !== undefined ? task.intent.reason : readBackReasonFromRegistry(task);
	const endedAt = Date.now();
	const tailSummary = readTailSummary(task.outputFile);
	const finalized = finalizeTask(task.taskId, { exitCode: null, reason, endedAt, tailSummary });
	if (finalized === undefined) return;
	writeRegistryEntry(finalized.registryPath, taskToRegistryEntry(finalized));
	handleTaskExit(finalized);
}

/**
 * D6-en intent 读回：内存 intent 缺省时读回本条目的 registry 条目——state==="killing"
 * ↔ reason=killed（跨进程 UI 代杀只写 registry 侧）。与 exit-collector 的
 * readBackReasonFromRegistry 同构复刻（该文件不在本单元 territory，共享单点抽取留待
 * 后续收敛登记）；读失败/条目缺失/状态非 killing → "natural" 不阻塞终态化。
 */
function readBackReasonFromRegistry(task: BackgroundTask): BackgroundTaskEndReason {
	const entry = readRegistry(task.registryPath).get(task.taskId);
	return entry?.state === "killing" ? "killed" : "natural";
}
