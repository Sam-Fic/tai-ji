// src/kill-chain.ts
//
// 杀链与 abort 兜底（引擎侧原语，自 core execution/engine/common/kill-chain.ts
// 迁入 @zhushanwen/subagent-engine-sdk，实现体逐字等价）。迁移处置（impl-plan §2.1
// kill-chain 行，逐项落地）：
//   - 契约类型随 SDK 下沉：AgentCallOpts（引擎侧子集）/ AgentOutcome 改自
//     src/protocol/contract-types.ts（结构等价，零 core import）；
//   - logger 走 SDK facade（src/logger.ts）；
//   - STDOUT_TAIL_ECHO_CHARS 自持（src/protocol/error-codes.ts）；toErrorMessage
//     改用 SDK 单源 src/error-message.ts（round1-reuse R11 收编原内联副本）。
//
// [时间机制删除] 原「SIGTERM → grace 窗 → SIGKILL 升级」的两级等待链收敛为
// SIGTERM+SIGKILL 背靠背（无等待窗）；原宿主超时合成面（HOST_TIMEOUT_ABORT_REASON /
// synthesizeTimeoutOutcome）已随宿主 timeoutMs 墙钟机制删除。

import { getLogger } from "./logger.ts";
import { toErrorMessage } from "./error-message.ts";

const logger = getLogger("subagents");

// ============================================================
// 杀链（SIGTERM + SIGKILL 背靠背）
// ============================================================

/**
 * 可杀子进程的结构形状（Node ChildProcess 的结构子集）。
 * 用结构接口而非 ChildProcess 类型：测试可注入 fake（ChildProcess 全字段构造过重），
 * 且未来 driver host 的常驻进程句柄只要满足此形状即可复用杀链。
 */
export interface KillableChild {
  /** 非 null = 进程已退出（自然退出码）。 */
  readonly exitCode: number | null;
  /** 非 null = 进程被信号杀死。exitCode/signalCode 任一非 null 即已退出。 */
  readonly signalCode: string | null;
  /** 发信号。返回 false = 进程已不存在（kill no-op）。 */
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/**
 * 杀链：SIGTERM + SIGKILL 背靠背发出（无等待升级窗——原 grace 窗已随时间机制删除，
 * 优雅退出窗不存在）。进程已退出时 no-op。
 *
 * @returns 'terminated' = 进程已退出（无需发信号）；'killed' = 信号已发出。
 */
export function killChain(
  child: KillableChild,
  opts?: { escalationNote?: string },
): "terminated" | "killed" {
  // 已退出（自然/已被杀）→ 无需发信号，按优雅终止口径返回
  if (child.exitCode !== null || child.signalCode !== null) return "terminated";

  if (opts?.escalationNote !== undefined) {
    logger.warn(
      `[kill-chain] ${opts.escalationNote}: SIGTERM+SIGKILL issued (no grace window)`,
    );
  }
  safeKill(child, "SIGTERM");
  safeKill(child, "SIGKILL");
  return "killed";
}

/**
 * 发信号兜底包裹：进程恰在退出态检查与 kill 之间自退时，ChildProcess.kill 可能抛
 *（zsub 实测经验）——幂等吞掉并 debug 留痕，不阻断杀链语义（对已退进程信号本就是
 * no-op）。收敛自 zcode launcher 的内联实现（对齐点②：单一权威）。
 */
export function safeKill(child: KillableChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (err) {
    logger.debug(
      `[kill-chain] ${signal} on exited process: ${toErrorMessage(err)}`,
    );
  }
}

// ============================================================
// [D9-2 杀伤半径收窄] run 级 pid 杀链（宿主侧，单 pid 非按进程组终止）
// ============================================================

/**
 * 单 pid 存活探针（`process.kill(pid, 0)`）。
 *
 * 返回三态：true = 存活；false = 已死（ESRCH）；undefined = 不可判定（EPERM =
 * 进程存在但属他人 / 探针异常）——undefined 按存活保守处理（杀链对已死进程发信号
 * 本就是 no-op，误判存活只多一次空信号，误判死亡会漏杀）。
 */
export function probePidAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    return undefined;
  }
}

/**
 * [D9-2 半径收窄原语] run 级 pid 杀链：SIGTERM + SIGKILL 背靠背（无升级等待窗），
 * **只打单 pid，绝不按进程组终止**（宿主对引擎孙进程只持镜像 pid、不持 ChildProcess——
 * 引擎以 detached:true 自成进程组，孙进程在其组内而非自任组长，负 pid 按进程组终止不可达；
 * 本原语逐 pid 退化单杀，语义 = 「该 run 的进程拓扑」而非引擎组）。
 *
 * fire-and-forget：宿主非进程持有方，无 exit 事件可等；收尸由 OS 完成。
 * 对已死 pid 全程 no-op（信号幂等吞掉）。
 */
export function killPidChain(pid: number, opts: { note?: string } = {}): void {
  if (opts.note !== undefined && probePidAlive(pid) !== false) {
    logger.warn(`[kill-chain] ${opts.note}: pid ${pid} SIGTERM+SIGKILL issued (no grace window)`);
  }
  signalPid(pid, "SIGTERM");
  signalPid(pid, "SIGKILL");
}

/** 单 pid 发信号兜底包裹（safeKill 的 bare-pid 变体：目标恰在检查与 kill 间自退时 kill 抛 ESRCH——幂等吞掉）。 */
function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    logger.debug(
      `[kill-chain] ${signal} to pid ${pid} failed (already dead = expected): ${toErrorMessage(err)}`,
    );
  }
}

// ============================================================
// abort 编排（原生中断 → 杀链兜底）
// ============================================================

/**
 * abort 编排 helper（D1 abort 分级的公共实现）：
 * signal abort 时 ①先调引擎原生中断（tryNativeInterrupt，若有——原 3s 原生中断
 * 宽限窗已随时间机制删除，中断发出后不等其生效）；②随即走杀链兜底（SIGTERM+
 * SIGKILL 背靠背；无原生中断——CLI-only 引擎——直接杀链）。
 *
 * 进程自然退出时以 'terminated' settle（挂在 exit 事件上，杀链对已退进程是 no-op），
 * 调用方可安全 await；signal 永不 abort 且进程已退时也会 settle，不悬挂。
 */
export function abortWithFallback(
  child: KillableChild,
  signal: AbortSignal,
  tryNativeInterrupt?: () => Promise<void>,
): Promise<"terminated" | "killed"> {
  return new Promise<"terminated" | "killed">((resolve) => {
    let settled = false;
    function finish(result: "terminated" | "killed"): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    }

    function onExit(): void {
      finish("terminated");
    }

    function runChain(): void {
      void (async () => {
        if (tryNativeInterrupt) {
          try {
            await tryNativeInterrupt();
          } catch (err) {
            // 原生中断失败（协议错/管道断）→ 直接落杀链，中断失败不阻断兜底。
            // debug 级留诊断线索：这不是错误终态，只是该引擎优雅中断不可用
            logger.debug(
              `[kill-chain] native interrupt failed, falling back to kill chain: ${
                toErrorMessage(err)
              }`,
            );
          }
        }
        finish(killChain(child));
      })();
    }

    function onAbort(): void {
      runChain();
    }

    // 进程自然退出（含原生中断生效）→ 优雅终止口径。
    // once listener 不显式移除：触发时 finish 已幂等，单 child 单 listener 无堆积。
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish("terminated");
      return;
    }

    if (signal.aborted) runChain();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
