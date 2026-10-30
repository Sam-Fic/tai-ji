// src/active-children.ts
//
// 当前活跃子进程记账（自 spawn-runner.ts 提取）：镜像上报 / dispose 收割
// 消费；引擎进程内权威。spawn-runner.ts re-export 全部导出保持既有导入范围
// （index.ts / pi-engine.ts / __tests__ 均从 spawn-runner 导入）。
//
// [U1 归并 + kill-chain-architecture §3.4] dispose 收割走 pi-rpc killPiProcess
// （SIGKILL 直杀 + 三值判别）：结果如实三分类记账（killed / finished / leaked），
// 杀链失败（进程仍活）不折叠成收割成功——计数不再虚高，第一现场日志不再失真。

import type { ChildProcess } from "node:child_process";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";
import { killPiProcess, KillSignalError } from "@zhushanwen/pi-rpc";

const logger = getLogger("session-runner");

/** 活跃子进程表（recordId → child）。 */
const activeChildren = new Map<string, ChildProcess>();

/** 注册活跃子进程（interact 热路径投递路径）。 */
export function registerActiveChild(recordId: string, child: ChildProcess): void {
  activeChildren.set(recordId, child);
}

/** 注销（close 后调用）。 */
export function unregisterActiveChild(recordId: string, child: ChildProcess): void {
  if (activeChildren.get(recordId) === child) activeChildren.delete(recordId);
}

/** 按 record 取活跃子进程（undefined = 无句柄，对齐 getChildByRecord 语义）。 */
export function getActiveChild(recordId: string): ChildProcess | undefined {
  return activeChildren.get(recordId);
}

/** dispose 收割三分类结果（按杀链结果如实记账）。 */
export interface DisposeReapTally {
  /** SIGKILL 已成功投递的收割清单（recordId）——进程必死，收尾等 close。 */
  killed: string[];
  /** 无信号发出的注销清单（recordId）：收割时已退出，或杀链复核确证已死（already-dead）。 */
  finished: string[];
  /** 杀链失败清单（进程仍活）：登记已注销但进程泄漏，无进一步处置（宿主/用户层面处理）。 */
  leaked: Array<{ recordId: string; pid: number | undefined; reason: string }>;
}

/**
 * 全量收割（dispose）：SIGKILL 直杀（pi-rpc killPiProcess 单源）+ 结果三分类记账。
 *
 * 杀决策落盘（2026-09-24 事故取证补口）：dispose 全量收割会连坐杀掉**正在运行**的
 * record 子进程（pi 子进程直杀）——该决策必留 warn 第一现场，且计数按真实结果报
 * （killing X, finished Y, leaked Z——leaked 带 pid/reason）：「杀了 N 个」在杀链
 * 失败时是假事实，泄漏形态必须如实上报。杀链 promise 同步 settle（deliverSignal
 * 不等收尸），await 仅微任务级——dispose 收割语义上「即时」返回终值。
 *
 * 失败不阻断：单条泄漏只记分类（dispose 是关停路径，继续逐条处理）。
 */
export async function killAllActiveChildren(): Promise<DisposeReapTally> {
  const tally: DisposeReapTally = { killed: [], finished: [], leaked: [] };
  for (const [recordId, child] of activeChildren) {
    if (child.exitCode !== null || child.signalCode !== null) {
      tally.finished.push(recordId);
      activeChildren.delete(recordId);
      continue;
    }
    try {
      const outcome = await killPiProcess(child);
      if (outcome.status === "signal-delivered") tally.killed.push(recordId);
      else tally.finished.push(recordId); // already-dead：探针时点差异，本来就死了
    } catch (err) {
      tally.leaked.push({
        recordId,
        pid: child.pid,
        reason: err instanceof KillSignalError ? err.reason : "unexpected-error",
      });
    }
    activeChildren.delete(recordId);
  }
  if (tally.killed.length > 0 || tally.leaked.length > 0) {
    // 运行中 record 被 dispose 连坐杀 / 杀失败泄漏：上游断连形态的触发指纹，
    // warn 级必达（TAIJI_AGENT_EXT_LOG=1 即落盘，无需 DEBUG 档）
    const leakedDetail = tally.leaked
      .map((l) => `${l.recordId}(pid=${String(l.pid)}, reason=${l.reason})`)
      .join(", ");
    logger.warn(
      `[session-runner] dispose killAll: killing ${tally.killed.length} [${tally.killed.join(", ")}], ` +
        `finished ${tally.finished.length}, leaked ${tally.leaked.length}` +
        (leakedDetail !== "" ? ` [${leakedDetail}]` : "") +
        (tally.finished.length > 0 ? `; ${tally.finished.length} already-exited record(s) unregistered only [${tally.finished.join(", ")}]` : ""),
    );
  }
  return tally;
}
