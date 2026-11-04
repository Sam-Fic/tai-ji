// lifecycle-predicates 单测（v4 B-1；W6 随拆依赖改写：读点改 core 侧状态镜像）。
// 验证 isResumable/hasLiveProcessHandle 在两态收敛后的判定逻辑。
// 依赖 core 侧 spawnedChildren 镜像（engine/host/spawned-children.ts），
// beforeEach 重置隔离。
//（原 hasArmedIdleTimer 用例组随 idle timer 机制删除消亡。）

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  coreSpawnedChildrenMirror,
  _resetCoreSpawnedChildrenMirrorForTest,
} from "../engine/host/spawned-children.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";

import { hasLiveProcessHandle, isResumable } from "../lifecycle/lifecycle-predicates.ts";

/** 构造最小 ExecutionRecord（status 默认 running）。 */
function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "sa-test",
    agent: "general-purpose",
    model: "test/model",
    thinkingLevel: undefined,
    mode: "background",
    task: "test",
    startedAt: Date.now(),
    rootSessionId: "root",
    parentRecordId: undefined,
    depth: 0,
    status: "running",
    turns: [],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    round: 0,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    controller: undefined,
    ...overrides,
  } as ExecutionRecord;
}

describe("lifecycle-predicates (v4 B-1)", () => {
  beforeEach(() => {
    _resetCoreSpawnedChildrenMirrorForTest();
  });

  afterEach(() => {
    // 用例注册的镜像条目只靠下一用例 beforeEach 清——文件收尾后残留
    // 会泄漏进 shared 池同 worker 的后续文件（isolate:false，globalThis 跨文件复用）。
    _resetCoreSpawnedChildrenMirrorForTest();
  });

  describe("hasLiveProcessHandle（W6 改读镜像）", () => {
    it("no mirror entry → false", () => {
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });

    it("mirror entry running (not killed) → true", () => {
      coreSpawnedChildrenMirror().register("sa-test", { pid: 1, killed: false });
      expect(hasLiveProcessHandle("sa-test")).toBe(true);
    });

    it("mirror entry killed → false", () => {
      coreSpawnedChildrenMirror().register("sa-test", { pid: 1, killed: true });
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });

    it("mirror markKilled 置死后 → false", () => {
      coreSpawnedChildrenMirror().register("sa-test", { pid: 1, killed: false });
      coreSpawnedChildrenMirror().markKilled("sa-test");
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });

  });

  // [two-state-convergence U5/D4] isResumable 判据改 idle 派生（idle 即 resumable）——
  // 旧「running && 无活进程」判据依赖的轮终桥接形态已随 U4 翻边消亡。
  describe("isResumable (= status === 'idle'，[U5/D4] idle 派生)", () => {
    it("idle → true (轮终收尾即可续聊——含 one-shot 完成 / chat 等续聊 / 中断族)", () => {
      expect(isResumable(makeRecord({ status: "idle" }))).toBe(true);
    });

    it("running（无论有无活进程镜像）→ false (在途轮不可冷路径 resume)", () => {
      expect(isResumable(makeRecord({ status: "running" }))).toBe(false);
      const rec = makeRecord({ status: "running" });
      coreSpawnedChildrenMirror().register(rec.id, { pid: 1, killed: false });
      expect(isResumable(rec)).toBe(false);
    });
  });
});
