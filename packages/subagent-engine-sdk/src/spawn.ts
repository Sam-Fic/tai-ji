// src/spawn.ts
//
// 引擎子进程 spawn 原语 + 引擎侧自灭（W12，impl-plan §2.12 / §2.2 R9-4② / §7.2 R9-2）。
//
// spawnEngineChild 是全部引擎 CLI 任务子进程的唯一 spawn 入口（W10 静态断言目标符号）：
// - 硬编码 POSIX/Windows detached:false（+ windowsHide:true），不暴露 detached 选项
//   ——引擎一代子进程不脱离进程组，宿主杀组即连带收割；
// - 不把引擎自身的 stdin fd 传给后代：子进程 stdin 恒为自有 pipe（'pipe'），
//   禁止 'inherit'/fd 形态——否则宿主死后代仍持写端、EOF 永不到达，自灭主判据失效
//   （R9-4②）。
//
// armEngineSelfDestruct 是引擎 CLI 的宿主死亡自灭检查：唯一判据 stdio EOF
//（进程事实信号——宿主死后无人再写协议帧；原「in-flight 反向请求计时超时」辅助
// 判据已随时间机制删除）。

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { getLogger } from "./logger.ts";
import { killChain, safeKill } from "./kill-chain.ts";
import type { buildEngineChildEnv } from "./env.ts";

const logger = getLogger("engine-sdk/spawn");

/** spawnEngineChild 的 env 必须来自 buildEngineChildEnv（三层契约终态）。 */
export type EngineChildEnv = ReturnType<typeof buildEngineChildEnv>;

/** 引擎子进程 spawn 选项（刻意不暴露 detached / stdio / stdin——形态硬编码，见文件头）。 */
export interface SpawnEngineChildOptions {
  command: string;
  args: readonly string[];
  /** 须由 buildEngineChildEnv 构建（类型即契约：三层 env 终态） */
  env: EngineChildEnv;
  cwd?: string;
  /** 子进程 stdout/stderr 形态；缺省 'pipe'（协议帧走 stdout，stderr 走日志/轮转） */
  stdout?: "pipe" | "ignore" | "inherit";
  stderr?: "pipe" | "ignore" | "inherit";
  /**
   * AbortSignal 触发即杀子（缺省无）。杀链 = SIGCONT 前置 + SIGTERM+SIGKILL
   * 背靠背（killChain 单源，无等待升级窗——原 30s grace 已随时间机制删除）。
   */
  signal?: AbortSignal;
}

/** 这些键出现即拒绝：spawn 形态是本原语的契约范围，不允许调用方绕过硬编码值。 */
const FORBIDDEN_OPTION_KEYS = ["detached", "stdio", "stdin", "windowsHide"] as const;

/**
 * 引擎任务子进程唯一 spawn 入口。
 *
 * 形态硬编码：detached:false、windowsHide:true、子进程 stdin 恒 'pipe'（自有 pipe，
 * 绝不继承引擎自身 stdin fd）。传入被禁止的形态键（detached/stdio/stdin/windowsHide）
 * 直接抛错——契约破坏应在配置期出声，不静默降级。
 */
export function spawnEngineChild(opts: SpawnEngineChildOptions): ChildProcess {
  for (const key of FORBIDDEN_OPTION_KEYS) {
    if (key in opts) {
      throw new Error(
        `spawnEngineChild: option "${key}" is hardcoded by the engine spawn contract `
          + `(detached:false / windowsHide:true / child stdin is always its own pipe); `
          + `remove it from the call site`,
      );
    }
  }

  const child = spawn(opts.command, [...opts.args], {
    cwd: opts.cwd,
    env: opts.env,
    detached: false,
    windowsHide: true,
    stdio: ["pipe", opts.stdout ?? "pipe", opts.stderr ?? "pipe"],
  });

  if (opts.signal !== undefined) {
    opts.signal.addEventListener(
      "abort",
      () => {
        // [SIGCONT 前置] 唤醒潜在 SIGSTOP 冻结形态——冻结进程对信号只排队不处理，
        // 不先 SIGCONT 则 SIGTERM 永远无法送达处理；对未冻结进程是 no-op，
        // 对已退进程由 safeKill 幂等吞掉。
        safeKill(child, "SIGCONT");
        killChain(child, {
          escalationNote: `engine child (pid ${child.pid ?? "unknown"}) abort`,
        });
      },
      { once: true },
    );
  }
  return child;
}

// ─────────────────────────────────────────────────────────────────────────────
// 引擎侧自灭（宿主死亡检测）
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineSelfDestructOptions {
  /** 唯一判据数据源：宿主→引擎的协议 stdin（EOF = 宿主死亡 → 立即自灭）。 */
  stdin: NodeJS.ReadableStream;
  /** 自灭执行器（缺省 = 杀自己进程组再杀自己；测试注入用）。 */
  killSelf?: () => void;
}

/** taskkill 子进程的最小面（self-destruct 是 fire-and-forget：只挂 error + unref）。 */
export type KillOwnProcessGroupSpawnResult = {
  on(event: "error", listener: (err: Error) => void): unknown;
  unref?: () => void;
};

/** 自灭杀链依赖（缺省 = 真实 platform / spawn / process.kill；测试注入分支用）。 */
export type KillOwnProcessGroupDeps = {
  readonly platform?: NodeJS.Platform;
  readonly spawnFn?: (
    command: string,
    args: readonly string[],
    options: { readonly stdio: "ignore"; readonly windowsHide: boolean },
  ) => KillOwnProcessGroupSpawnResult;
  readonly killFn?: (pid: number, signal: NodeJS.Signals) => unknown;
};

/**
 * 缺省自灭：先杀自己进程组（收割引擎 spawn 的任务子进程），失败回落杀自己。
 *
 * 平台矩阵（设计 D7）：POSIX = 负 pid 组杀；Windows 无进程组信号语义，用
 * `taskkill /PID <self> /T /F` 树杀（stdio ignore + fire-and-forget，不阻塞自灭链）。
 * Windows 分支在 taskkill 根本起不来（spawn 同步抛错，或 child 'error'：PATH 缺
 * System32 / EMFILE 等）时回落 `SIGKILL` 杀自己（R2A-N4）：只杀自己是「可接受
 * 降级」（后代 pi 交给 runtime sweep / 组登记），但引擎自身必须停住——否则引擎事件
 * 循环仍有活句柄时宿主死后引擎与 pi 都不死，比原行为更差。两条失败路径都 warn 留痕。
 * 依赖可注入 = 平台分支单测 seam（不实跑 Windows）。
 */
export function killOwnProcessGroup(deps: KillOwnProcessGroupDeps = {}): void {
  const pid = process.pid;
  const kill = deps.killFn ?? ((targetPid: number, signal: NodeJS.Signals) => process.kill(targetPid, signal));
  if ((deps.platform ?? process.platform) === "win32") {
    // [R2A-N4] taskkill 不可用时的自灭兜底（至少停引擎）：后代由 runtime sweep 收尾。
    const fallbackSelfKill = (reason: string): void => {
      logger.warn(`taskkill self-tree failed (${reason}); falling back to self SIGKILL`);
      try {
        kill(pid, "SIGKILL");
      } catch (err) {
        logger.warn(
          `self SIGKILL fallback failed (${String(err)}); descendant pi may linger until runtime sweep`,
        );
      }
    };
    const spawnFn = deps.spawnFn
      ?? ((command, args, options) => spawn(command, [...args], options));
    try {
      const child = spawnFn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", (err) => {
        fallbackSelfKill(String(err));
      });
      child.unref?.();
    } catch (err) {
      fallbackSelfKill(`spawn threw: ${String(err)}`);
    }
    return;
  }
  try {
    kill(-pid, "SIGKILL");
  } catch (err) {
    // 按进程组终止失败（非组长 / Windows 形态差异）——回落单进程杀，任务子进程由
    // 各自的 stdio EOF / 宿主回收层兜底。
    logger.warn(`process-group kill failed (${String(err)}), falling back to self kill`);
    kill(pid, "SIGKILL");
  }
}

/**
 * 武装引擎侧自灭检查。判据 = stdio EOF（唯一，进程事实信号）：stdin 'end'（数据
 * 范围读尽）或 'close'（fd 关闭）→ 立即自灭（宿主死后无人再写协议帧，引擎继续跑
 * 只烧 token）。原「in-flight 反向请求计时超时」辅助判据已随时间机制删除（它曾把
 * 长 pi 任务误判宿主死亡——漏排除已 ack 长请求即「>30s pi 任务被自灭」事故）。
 *
 * 自灭执行 = 引擎自杀并杀自己进程组（spawnEngineChild 硬编码 detached:false，
 * 任务子进程同组连带收割）。
 */
export function armEngineSelfDestruct(opts: EngineSelfDestructOptions): void {
  const killSelf = opts.killSelf ?? killOwnProcessGroup;
  let destroyed = false;

  const destroy = (reason: string): void => {
    if (destroyed) return;
    destroyed = true;
    opts.stdin.removeAllListeners?.("end");
    opts.stdin.removeAllListeners?.("close");
    logger.warn(`engine self-destruct: ${reason}`);
    killSelf();
  };

  // stdio EOF（'end' 与 'close' 双挂——pipe 半关闭与 fd 销毁都算宿主死亡）
  opts.stdin.once("end", () => destroy("host stdin EOF (end)"));
  opts.stdin.once("close", () => destroy("host stdin closed"));
}

// ─────────────────────────────────────────────────────────────────────────────
// NDJSON 行泵（子进程 stdout 拆行）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 流式 NDJSON 行泵：utf8 解码 + 缓冲累积 + "\n" 拆行循环（S4 簇 5b 收编：pi
 * spawn-run-pump 与 zcode connection 的逐字同构段单源化，实现以 pi 版为基线）。
 * 末行无换行符时滞留缓冲（NDJSON 语义：行以 \n 定界）；不监听 end/close/error——
 * 生命周期接线（close 收尾/error 兜底）由调用方自行挂接。stream 为 null/undefined
 * （无 stdio）时无操作，与原调用点 `child.stdout?.` 可选链语义等价。
 */
export function pumpNdjsonLines(
  stream: NodeJS.ReadableStream | null | undefined,
  onLine: (line: string) => void,
): void {
  if (stream === null || stream === undefined) return;
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      onLine(line);
      nl = buffer.indexOf("\n");
    }
  });
}
