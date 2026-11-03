// src/__tests__/active-children.test.ts
//
// dispose 全量收割的三分类记账测试（kill-chain-architecture §3.4）：已退注销 →
// finished；SIGKILL 投递成功 → killed；杀链失败（进程仍活）→ leaked（pid/reason
// 如实上报，计数不虚高）。fake child 注入 kill 行为（KillableChild 结构子集），
// 探针路径经 vi.spyOn(process, 'kill') 桩。

import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { killAllActiveChildren, registerActiveChild } from "../active-children.ts";

function fakeChild(opts: { exited?: boolean; killImpl?: () => boolean } = {}): ChildProcess {
  const emitter = new EventEmitter();
  return {
    pid: 7777,
    exitCode: opts.exited === true ? 0 : null,
    signalCode: null,
    kill: opts.killImpl ?? (() => true),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
  } as unknown as ChildProcess;
}

function epermError(): Error {
  return Object.assign(new Error("kill EPERM"), { code: "EPERM" });
}

describe("killAllActiveChildren 三分类记账", () => {
  it("已退 → finished；SIGKILL 投递成功 → killed；EPERM → leaked（pid/reason）", async () => {
    registerActiveChild("rec-exited", fakeChild({ exited: true }));
    registerActiveChild("rec-killed", fakeChild());
    registerActiveChild(
      "rec-leaked",
      fakeChild({
        killImpl: () => {
          throw epermError();
        },
      }),
    );

    const tally = await killAllActiveChildren();

    expect(tally.killed).toEqual(["rec-killed"]);
    expect(tally.finished).toEqual(["rec-exited"]);
    expect(tally.leaked).toEqual([{ recordId: "rec-leaked", pid: 7777, reason: "permission-denied" }]);
  });

  it("kill 返回 false + 探针复核确证已死（ESRCH）→ already-dead 落 finished 分类（等价成功）", async () => {
    const probe = vi.spyOn(process, "kill").mockImplementation((() => {
      const err = new Error("probe ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }) as typeof process.kill);
    try {
      registerActiveChild("rec-dead", fakeChild({ killImpl: () => false }));
      const tally = await killAllActiveChildren();
      expect(tally.finished).toEqual(["rec-dead"]);
      expect(tally.killed).toEqual([]);
      expect(tally.leaked).toEqual([]);
    } finally {
      probe.mockRestore();
    }
  });

  it("kill 返回 false + 探针存活 → leaked（undetermined 保守按存活）", async () => {
    // 探针桩不抛 = process.kill(pid, 0) 成功 = 存活（true）
    const probe = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as unknown as typeof process.kill);
    try {
      registerActiveChild("rec-undet", fakeChild({ killImpl: () => false }));
      const tally = await killAllActiveChildren();
      expect(tally.leaked).toEqual([{ recordId: "rec-undet", pid: 7777, reason: "undetermined" }]);
    } finally {
      probe.mockRestore();
    }
  });

  it("单条泄漏不阻断：后续条目照常处理（关停路径逐条 best-effort）", async () => {
    registerActiveChild(
      "rec-leak-first",
      fakeChild({
        killImpl: () => {
          throw epermError();
        },
      }),
    );
    registerActiveChild("rec-killed-after", fakeChild());

    const tally = await killAllActiveChildren();
    expect(tally.leaked.map((l) => l.recordId)).toEqual(["rec-leak-first"]);
    expect(tally.killed).toEqual(["rec-killed-after"]);
  });
});
