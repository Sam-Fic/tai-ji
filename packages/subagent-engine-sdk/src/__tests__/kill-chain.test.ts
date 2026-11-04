// src/__tests__/kill-chain.test.ts
//
// killChain（SIGTERM+SIGKILL 背靠背）与 abortWithFallback（abort 编排：原生中断 →
// 杀链兜底）的行为范围。child 用结构 fake——KillableChild 接口注释明示「测试可注入
// fake（ChildProcess 全字段构造过重）」，退出态经 emitExit 手工推进，不 spawn 真实
// 进程、不碰引擎进程。日志经 LoggerSink 注入捕获（同时避免缺省 console 出口刷屏）。
//（原 grace/nativeGrace/SIGKILL 收尸等待窗用例已随杀链等待升级窗删除消亡。）

import { describe, expect, it, vi } from "vitest";

import {
  abortWithFallback,
  killChain,
  killPidChain,
  probePidAlive,
  type KillableChild,
} from "../kill-chain.ts";
import { configureLoggerSink, resetLoggerSinkForTests, type LoggerSink } from "../logger.ts";

interface FakeChild extends KillableChild {
  /** 已收到的信号序列（断言杀链信号序列）。 */
  readonly signals: readonly NodeJS.Signals[];
  /** 手工推进退出态并触发 exit listeners（fake 进程的收尸入口，幂等）。 */
  emitExit(code: number | null, signal: NodeJS.Signals | null): void;
}

function fakeChild(
  opts: {
    exitCode?: number;
    signalCode?: string;
  } = {},
): FakeChild {
  let exitCode: number | null = opts.exitCode ?? null;
  let signalCode: string | null = opts.signalCode ?? null;
  const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const signals: NodeJS.Signals[] = [];
  const child: FakeChild = {
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    get signals() {
      return signals;
    },
    kill(signal?: NodeJS.Signals | number): boolean {
      signals.push(signal as NodeJS.Signals);
      return true;
    },
    once(_event, listener) {
      listeners.push(listener);
      return listener;
    },
    emitExit(code, signal) {
      if (exitCode !== null || signalCode !== null) return;
      exitCode = code;
      signalCode = signal;
      for (const l of [...listeners]) l(code, signal);
    },
  };
  return child;
}

/** 注入日志捕获 sink（替代缺省 console 出口），返回留痕列表。 */
function captureSink(): Array<{ level: string; msg: string }> {
  const logs: Array<{ level: string; msg: string }> = [];
  const sink: LoggerSink = {
    log(level, _component, message) {
      logs.push({ level, msg: message });
    },
  };
  configureLoggerSink(sink);
  return logs;
}

describe("killChain（SIGTERM+SIGKILL 背靠背杀链）", () => {
  it("活进程：SIGTERM 与 SIGKILL 背靠背发出（无等待窗），返回 'killed'", () => {
    const child = fakeChild();
    const result = killChain(child);
    expect(result).toBe("killed");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("已退出进程：无信号发出，返回 'terminated'（幂等 no-op）", () => {
    const child = fakeChild({ exitCode: 0 });
    const result = killChain(child);
    expect(result).toBe("terminated");
    expect(child.signals).toEqual([]);
  });

  it("escalationNote 在场时 warn 留痕（含 note 原文）", () => {
    const logs = captureSink();
    const child = fakeChild();
    killChain(child, { escalationNote: "child sa-1 (source: test)" });
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("child sa-1 (source: test)"))).toBe(true);
    resetLoggerSinkForTests();
  });
});

describe("abortWithFallback（abort 编排：原生中断 → 杀链兜底）", () => {
  it("无原生中断（CLI-only）：signal abort → 直接落杀链（SIGTERM+SIGKILL）", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const p = abortWithFallback(child, controller.signal);
    controller.abort();
    expect(await p).toBe("killed");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("原生中断成功：中断发出后不等其生效，仍落杀链兜底（信号序列完整）", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const nativeInterrupt = vi.fn(async () => {});
    const p = abortWithFallback(child, controller.signal, nativeInterrupt);
    controller.abort();
    expect(await p).toBe("killed");
    expect(nativeInterrupt).toHaveBeenCalledTimes(1);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("原生中断抛错：不阻断兜底（debug 留痕后照常杀链）", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const nativeInterrupt = vi.fn(async () => {
      throw new Error("pipe broken");
    });
    const p = abortWithFallback(child, controller.signal, nativeInterrupt);
    controller.abort();
    expect(await p).toBe("killed");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("进程自然退出先于 abort：'terminated' settle，signal listener 已移除", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const p = abortWithFallback(child, controller.signal);
    child.emitExit(0, null);
    expect(await p).toBe("terminated");
    expect(child.signals).toEqual([]);
    // abort 在 settle 后不触发杀链（listener 已摘）
    controller.abort();
    expect(child.signals).toEqual([]);
  });

  it("abort 前 child 已退出：立即 'terminated'（挂 exit 前的已死检查）", async () => {
    const child = fakeChild({ exitCode: 1 });
    const controller = new AbortController();
    expect(await abortWithFallback(child, controller.signal)).toBe("terminated");
  });
});

describe("killPidChain（run 级单 pid 杀链——SIGTERM+SIGKILL 背靠背，绝不按进程组终止）", () => {
  it("活 pid：SIGTERM 与 SIGKILL 先后发出", () => {
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid > 0 && (signal === "SIGTERM" || signal === "SIGKILL")) {
        kills.push({ pid, signal: signal as NodeJS.Signals });
      }
      return true;
    }) as typeof process.kill);
    try {
      killPidChain(4242, { note: "run wf-1 topology kill" });
    } finally {
      vi.mocked(process.kill).mockRestore();
    }
    expect(kills).toEqual([
      { pid: 4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
  });

  it("note 在场且 pid 存活时 warn 留痕", () => {
    const logs = captureSink();
    vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      killPidChain(4243, { note: "run wf-2" });
      expect(logs.some((l) => l.level === "warn" && l.msg.includes("run wf-2"))).toBe(true);
    } finally {
      vi.mocked(process.kill).mockRestore();
      resetLoggerSinkForTests();
    }
  });
});

describe("probePidAlive（三态存活探针）", () => {
  it("自进程 → true（kill(pid,0) 成功）", () => {
    expect(probePidAlive(process.pid)).toBe(true);
  });

  it("探针异常 → undefined（保守按存活）", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    try {
      expect(probePidAlive(999_999)).toBeUndefined();
    } finally {
      vi.mocked(process.kill).mockRestore();
    }
  });
});
