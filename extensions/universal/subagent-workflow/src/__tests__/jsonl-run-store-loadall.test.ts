// src/__tests__/jsonl-run-store-loadall.test.ts
//
// loadAll 发现域裁决锚（v2-only）：主 session 的发现通道收敛为「v2 注册条目定界 →
// record 流权威重建」单通道。旧格式 entry（v1 全量快照 / 旧 workflow-state-link
// 指针）按不存在处理（用户 2026-10-30 裁决无 v1/link 存量数据）——在盘也不识别，
// loadAll 必须静默忽略（不抛、不重建、零 warn），未知 entry 容忍面不受影响。
// v2 重建/收编读侧的完整用例在 jsonl-run-store-session-file.test.ts（W17/W1 describe）与
// __tests__/record-mode/（[D1] record 单源语义族）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { CustomEntry } from "@earendil-works/pi-coding-agent";

import {
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_ENTRY_VERSION,
  evictDoneRunsBeyondCap,
  isRunSettled,
  runSummary,
} from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
// [D6(a) 第 1 步] 注册表清零面（setRunEventJournalDirForTest 同实现内清 liveRunStates
// 与终局记录注册表）——换源后注册表是 isRunSettled / runSummary 的唯一判源。
import { setRunEventJournalDirForTest } from "@zhushanwen/subagent-core/orchestration/terminal-actions.ts";
import { JsonlRunStore } from "../jsonl-run-store.ts";
import { mkCtx } from "@zhushanwen/subagent-core/testing/orchestration/__tests__/test-mocks.ts";

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/** 手工构造历史形态 v1 快照 entry（快照载荷直接给对象字面量——历史数据在盘形态
 *  的夹具产出，用于锚定「不再被发现」的裁决行为）。 */
function legacyV1RecordEntryRaw(runId: string, snapshot: Record<string, unknown>): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: { v: 1, snapshot, updatedAt: new Date().toISOString() },
    id: `seed-v1-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** 手工构造历史形态 workflow-state-link 指针 entry。 */
function legacyLinkEntry(runId: string, statePath: string): CustomEntry {
  return {
    type: "custom",
    customType: "workflow-state-link",
    data: { runId, path: statePath },
    id: `seed-link-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** v2 注册条目夹具（字段集 = core lifecycle 写点同构）。 */
function v2RegisteredEntry(runId: string, recordPath: string): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: WORKFLOW_RECORD_ENTRY_VERSION,
      kind: "registered",
      runId,
      workflowName: "test-script",
      scriptName: "test-script",
      slug: "test-script",
      startedAt: Date.now(),
      recordPath,
    },
    id: `seed-v2-reg-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** record 流 run-settled 终局帧（载荷完整形态——[D1] 后 settled 帧必带 result 全文）。 */
function settledLine(): string {
  return JSON.stringify({
    type: "run-settled",
    seq: 2,
    ts: Date.now(),
    outcome: "done",
    artifactsDir: "/tmp/wf",
  });
}

function recordPathOf(tmpDir: string, runId: string): string {
  return path.join(tmpDir, `${runId}.record.jsonl`);
}

// ── 用例 ─────────────────────────────────────────────────────────────────────

describe("loadAll 发现域（v2-only）：历史形态 entry 不再被发现", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-loadall-v2only-"));
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("存量旧会话（v1 快照 entry + workflow-state-link 指针在盘）→ loadAll 返回空 + 零 warn（静默忽略不抛）", async () => {
    // v1 形态快照：v 字段 + snapshot 信封 + v2 版本头（历史形态的合法内容）
    const statePath = path.join(tmpDir, "run-legacy.jsonl");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({ v: "wf-run-v2", runId: "run-legacy", state: { status: "running" }, meta: {} })}\n`,
      "utf8",
    );

    const entries: CustomEntry[] = [
      legacyV1RecordEntryRaw("run-legacy", { v: "wf-run-v2", runId: "run-legacy", state: { status: "running" }, meta: {} }),
      legacyLinkEntry("run-legacy", statePath),
    ];
    const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });

    // 历史形态不参与发现：空结果、不抛、零 warn（静默语义）
    await expect(store.loadAll()).resolves.toEqual([]);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("混合批：v2 注册条目照常 journal 重建，历史形态 entry 同批不干扰", async () => {
    // v2 实体：注册条目 + journal 终局帧 → journal 权威重建
    const recordPath = recordPathOf(tmpDir, "run-v2-current");
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, `${settledLine()}\n`, "utf8");

    // 历史形态同批在盘：v1 快照 entry + link 指针（指向 state 文件）
    const legacyStatePath = path.join(tmpDir, "run-old.jsonl");
    fs.writeFileSync(
      legacyStatePath,
      `${JSON.stringify({ v: "wf-run-v2", runId: "run-old", state: { status: "running" }, meta: {} })}\n`,
      "utf8",
    );
    const entries: CustomEntry[] = [
      v2RegisteredEntry("run-v2-current", recordPath),
      legacyV1RecordEntryRaw("run-old", { v: "wf-run-v2", runId: "run-old", state: { status: "running" }, meta: {} }),
      legacyLinkEntry("run-old", legacyStatePath),
    ];

    const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();

    // 只有 v2 实体重建（终局 ⟸ journal run-settled）；历史形态零发现
    expect(loaded.map((r) => r.runId)).toEqual(["run-v2-current"]);
    // [D6(a) 第 3 步] 终局判定源 = 终局记录注册表（聚合不持 status）
    expect(isRunSettled(loaded[0]!)).toBe(true);
    expect(loaded[0]!.state.reason).toBe("completed");
  });

  it("[U6 回归] resolveAgentOpts 失败形态的 agent-settled 帧带 result → loadAll 正常重建（不判损坏）", async () => {
    // 派发前置失败（agent 名/skill 解析失败）是设计内合法产出：run 终局 failed、
    // call 的 agent-settled 帧由 dispatchAgentSettledFailed 写入 journal 记录。写侧补齐 result
    // 后，重启 loadAll 的严格读原语（settled 帧缺 result = RecordStreamCorruptionError
    // → storeHealthy=false 停初始化）不再把该流判损坏。
    const recordPath = recordPathOf(tmpDir, "run-pre-dispatch-fail");
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(
      recordPath,
      [
        JSON.stringify({
          type: "run-created",
          seq: 1,
          ts: Date.now(),
          runId: "run-pre-dispatch-fail",
          workflowName: "test-script",
          argsSummary: "{}",
          scriptSource: "agent('nope')",
        }),
        JSON.stringify({
          type: "agent-started",
          seq: 2,
          ts: Date.now(),
          taskIndex: 0,
          agentName: "nope",
          attempt: 1,
        }),
        JSON.stringify({
          type: "agent-settled",
          seq: 3,
          ts: Date.now(),
          taskIndex: 0,
          attempt: 1,
          outcome: "failed",
          errorCode: "unknown",
          result: { content: "", error: "skill not found: nope" },
          durationMs: 0,
        }),
        JSON.stringify({
          type: "run-settled",
          seq: 4,
          ts: Date.now(),
          outcome: "failed",
          errorCode: "unknown",
          reason: "agent opts resolve failed",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const store = new JsonlRunStore({ runsDir: tmpDir, ctx: mkCtx([v2RegisteredEntry("run-pre-dispatch-fail", recordPath)]) });
    const loaded = await store.loadAll();

    expect(loaded.map((r) => r.runId)).toEqual(["run-pre-dispatch-fail"]);
    // [D6(a) 第 3 步] 终局判定源 = 终局记录注册表（聚合不持 status）
    expect(isRunSettled(loaded[0]!)).toBe(true);
    expect(loaded[0]!.state.reason).toBe("failed");
    const call = loaded[0]!.state.calls.get(0);
    expect(call?.result).toMatchObject({ content: "", error: "skill not found: nope" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [D6(a) 第 1 步] 重启后重新加载进内存的 run 的终局判定换源：判据 = 重建 fold 结果
//
// loadAll 从 record 流 fold 出「有 run-settled 帧」这一事实后，经
// noteRebuiltSettlement 注入 core 终局记录注册表——展示派生视图（runSummary）、
// isRunSettled、evictDoneRunsBeyondCap 白名单三处据此判定，不再读聚合 status
// 字段。本节 = 设计 §1.7 第 1 步判据点名的三处行为断言（重启后 done run 不回退
// running / 判终局为真 / 可被淘汰，内存有界）。
// ════════════════════════════════════════════════════════════════════════════

describe("[D6(a) 第 1 步] 重新加载进内存的 run 的终局判定源 = 重建 fold 结果", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-rehydrate-finality-"));
    // 注册表清零（换源后它是 isRunSettled / runSummary 的唯一判源）——防跨用例污染
    setRunEventJournalDirForTest(undefined);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 写 record 流 + v2 注册条目 → loadAll 重建该 run。 */
  async function rebuild(runId: string, lines: string[]): Promise<WorkflowRun> {
    const recordPath = recordPathOf(tmpDir, runId);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, `${lines.join("\n")}\n`, "utf8");
    const store = new JsonlRunStore({
      runsDir: tmpDir,
      ctx: mkCtx([v2RegisteredEntry(runId, recordPath)]),
    });
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual([runId]);
    return loaded[0]!;
  }

  it("① 重启后 done run 的 runSummary 仍派生视图 done（展示不回退 running）", async () => {
    const run = await rebuild("wf-rehydrated-done", [settledLine()]);

    const summary = runSummary(run);
    expect(summary.status).toBe("done");
    expect(summary.reason).toBe("completed");
    expect(summary.completedAt).toBeDefined();
  });

  it("② isRunSettled 对重新加载进内存的 done run 为真；无 run-settled 帧的重新加载进内存的 run 为假", async () => {
    const done = await rebuild("wf-rehydrated-settled", [settledLine()]);
    expect(isRunSettled(done)).toBe(true);

    const running = await rebuild("wf-rehydrated-running", [
      JSON.stringify({
        type: "run-created",
        seq: 1,
        ts: Date.now(),
        runId: "wf-rehydrated-running",
        workflowName: "test-script",
        argsSummary: "{}",
        scriptSource: "agent('a')",
      }),
    ]);
    expect(isRunSettled(running)).toBe(false);
    expect(runSummary(running).status).toBe("running");
  });

  it("③ 重新加载进内存的 done run 进入 evictDoneRunsBeyondCap 白名单（runs Map 内存有界性）", async () => {
    const run = await rebuild("wf-rehydrated-evict", [settledLine()]);
    const runs = new Map<string, WorkflowRun>([[run.runId, run]]);

    expect(evictDoneRunsBeyondCap(runs, 0)).toBe(1);
    expect(runs.has(run.runId)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [subagent-model-switch §6.6①/§7.4] fold 覆盖事件消费用例（P8 第五道防线）：
// record 流写入 model-override 覆盖事件行 → fold 产物（WorkflowRun）meta 含覆盖
// 状态。fold 按事件类型字面量独立分派、core 词表已扩但本 fold 未跟时新事件行被
// 静默跳过 = 覆盖状态丢行——本用例在该回归下确实变红（meta.modelOverride 缺失），
// 是「词表已扩、fold 未跟」丢行风险的唯一快速防线（设计 §3.5 P8 防线清单）。
// ════════════════════════════════════════════════════════════════════════════

describe("fold 覆盖事件消费（model-override → meta.modelOverride 派生视图）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-fold-model-override-"));
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 写 record 流 + v2 注册条目 → loadAll 重建该 run。 */
  async function rebuild(runId: string, lines: string[]): Promise<WorkflowRun> {
    const recordPath = recordPathOf(tmpDir, runId);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, `${lines.join("\n")}\n`, "utf8");
    const store = new JsonlRunStore({
      runsDir: tmpDir,
      ctx: mkCtx([v2RegisteredEntry(runId, recordPath)]),
    });
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual([runId]);
    return loaded[0]!;
  }

  it("写入覆盖事件行 → fold 产物 meta.modelOverride 含覆盖状态（fold 未跟时本用例红——P8 丢行防线）", async () => {
    const run = await rebuild("wf-fold-ovr-single", [
      JSON.stringify({
        type: "run-created",
        seq: 1,
        ts: Date.now(),
        runId: "wf-fold-ovr-single",
        workflowName: "test-script",
        argsSummary: "{}",
        scriptSource: "agent('a')",
      }),
      JSON.stringify({
        type: "model-override",
        seq: 2,
        ts: Date.now() + 1_000,
        model: { provider: "b-provider", modelId: "b1" },
        thinkingLevel: "high",
      }),
    ]);

    expect(run.meta.modelOverride).toEqual({
      model: { provider: "b-provider", modelId: "b1" },
      thinkingLevel: "high",
      ts: expect.any(Number),
    });
  });

  it("两条覆盖事件 → 生效值 = 最新一条（覆盖旧覆盖值不叠加，不变量 2）", async () => {
    const run = await rebuild("wf-fold-ovr-latest", [
      JSON.stringify({
        type: "run-created",
        seq: 1,
        ts: Date.now(),
        runId: "wf-fold-ovr-latest",
        workflowName: "test-script",
        argsSummary: "{}",
        scriptSource: "agent('a')",
      }),
      JSON.stringify({
        type: "model-override",
        seq: 2,
        ts: Date.now() + 1_000,
        model: { provider: "b-provider", modelId: "b1" },
      }),
      JSON.stringify({
        type: "model-override",
        seq: 3,
        ts: Date.now() + 2_000,
        model: { provider: "c-provider", modelId: "c1" },
      }),
      JSON.stringify({ type: "run-settled", seq: 4, ts: Date.now() + 3_000, outcome: "done", artifactsDir: "/tmp/wf" }),
    ]);

    expect(run.meta.modelOverride).toEqual({
      model: { provider: "c-provider", modelId: "c1" },
      ts: expect.any(Number),
    });
  });

  it("无覆盖事件 → meta 无 modelOverride 键（缺省不造键）；覆盖帧不干扰 calls/终局折叠", async () => {
    const run = await rebuild("wf-fold-ovr-absent", [
      JSON.stringify({
        type: "run-created",
        seq: 1,
        ts: Date.now(),
        runId: "wf-fold-ovr-absent",
        workflowName: "test-script",
        argsSummary: "{}",
        scriptSource: "agent('a')",
      }),
      JSON.stringify({ type: "run-settled", seq: 2, ts: Date.now() + 1_000, outcome: "done", artifactsDir: "/tmp/wf" }),
    ]);

    expect("modelOverride" in run.meta).toBe(false);
    expect(isRunSettled(run)).toBe(true);
  });
});

// ── 条目终局证明的 status 感知（restore 双装配窗实测回归锚）─────────────────────
//
// WorkflowRecordSettledEntryData.status 词表 = "done" | "interrupted"：收编中断条目
// 与终态条目同 kind "settled"，仅 status 可判别。重建侧以「条目在场」充当终局证明的
// 分支必须按 status 区分——把中断条目当终局证明会把可续跑 run 对全部重建路径
//（托盘冷读 / 后续重启恢复）永久隐藏（实测链：装配 1 收编写中断条目 → 装配 2
// loadAll 误判跳过 → 投影空 → 托盘恢复推送被清屏帧抹掉）。

/** v2 settled 条目夹具（status 由用例给：done = 终局 / interrupted = 暂停态）。 */
function v2SettledEntry(
  runId: string,
  status: "done" | "interrupted",
  extra: Record<string, unknown> = {},
): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: WORKFLOW_RECORD_ENTRY_VERSION,
      kind: "settled",
      runId,
      status,
      settledAt: Date.now(),
      callCount: 1,
      usedTokens: 0,
      ...(status === "interrupted" ? { errorCode: "crashed" } : { reason: "completed", outcome: "done" }),
      ...extra,
    },
    id: `seed-v2-settled-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** run-interrupted 转移帧（收编写点形态，terminal-actions dispatchRunTrigger 同构）。 */
function interruptedLine(seq: number): string {
  return JSON.stringify({
    type: "run-interrupted",
    seq,
    ts: Date.now(),
    errorCode: "crashed",
    reason: "Process killed (kill-9 or crash recovery)",
  });
}

describe("loadAll 条目终局证明 status 感知：interrupted 条目 ≠ 终局证明", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-loadall-status-"));
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    setRunEventJournalDirForTest(undefined);
  });

  it("中断条目 + 流带 run-interrupted 帧（无 run-settled 帧）→ 重建为 interrupted（不跳过，可续跑）", async () => {
    const runId = "wf-status-interrupted";
    const recordPath = recordPathOf(tmpDir, runId);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(
      recordPath,
      [
        JSON.stringify({
          type: "run-created",
          seq: 1,
          ts: Date.now(),
          runId,
          workflowName: "test-script",
          argsSummary: "{}",
          scriptSource: "agent('a')",
        }),
        interruptedLine(2),
      ].join("\n") + "\n",
      "utf8",
    );
    const store = new JsonlRunStore({
      runsDir: tmpDir,
      ctx: mkCtx([v2RegisteredEntry(runId, recordPath), v2SettledEntry(runId, "interrupted")]),
    });

    const loaded = await store.loadAll();
    // 核心回归：条目在场不再触发「条目判终局而流无终局帧」跳过——run 必须重建
    expect(loaded.map((r) => r.runId)).toEqual([runId]);
    expect(isRunSettled(loaded[0]!)).toBe(false);
    expect(runSummary(loaded[0]!).status).toBe("interrupted");
  });

  it("终局条目 + 流无 run-settled 帧（残流）→ 跳过不重建（终局证明语义保持）", async () => {
    const runId = "wf-status-terminal-residue";
    const recordPath = recordPathOf(tmpDir, runId);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(
      recordPath,
      `${JSON.stringify({
        type: "run-created",
        seq: 1,
        ts: Date.now(),
        runId,
        workflowName: "test-script",
        argsSummary: "{}",
        scriptSource: "agent('a')",
      })}\n`,
      "utf8",
    );
    const store = new JsonlRunStore({
      runsDir: tmpDir,
      ctx: mkCtx([v2RegisteredEntry(runId, recordPath), v2SettledEntry(runId, "done")]),
    });

    const loaded = await store.loadAll();
    expect(loaded).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("settled entry present but record stream has no run-settled frame"),
    );
  });

  it("流缺失 + 中断条目 → degraded 重建交恢复链（不按终局证明跳过）", async () => {
    const runId = "wf-status-stream-missing";
    const recordPath = recordPathOf(tmpDir, runId);
    const store = new JsonlRunStore({
      runsDir: tmpDir,
      ctx: mkCtx([v2RegisteredEntry(runId, recordPath), v2SettledEntry(runId, "interrupted")]),
    });

    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual([runId]);
    expect(isRunSettled(loaded[0]!)).toBe(false);
  });

  it("流缺失 + 终局条目 → 跳过（呈现范围归条目读者，语义保持）", async () => {
    const runId = "wf-status-stream-gone-terminal";
    const recordPath = recordPathOf(tmpDir, runId);
    const store = new JsonlRunStore({
      runsDir: tmpDir,
      ctx: mkCtx([v2RegisteredEntry(runId, recordPath), v2SettledEntry(runId, "done")]),
    });

    const loaded = await store.loadAll();
    expect(loaded).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("record stream missing but settled entry present"),
    );
  });

  it("仅中断条目在场不抑制终局条目补写（续跑后终局：条目半边落终局）", async () => {
    const runId = "wf-status-resumed-then-done";
    const recordPath = recordPathOf(tmpDir, runId);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, `${settledLine()}\n`, "utf8");
    const appendEntry = vi.fn();
    const store = new JsonlRunStore({
      runsDir: tmpDir,
      pi: { appendEntry } as unknown as Parameters<typeof JsonlRunStore>[0]["pi"],
      ctx: mkCtx([v2RegisteredEntry(runId, recordPath), v2SettledEntry(runId, "interrupted")]),
    });

    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual([runId]);
    expect(isRunSettled(loaded[0]!)).toBe(true);
    // 流终局帧在场而 session 只有陈旧中断条目 → 终局条目必须补写（customType 同 v2 词表）
    expect(appendEntry).toHaveBeenCalledWith(
      WORKFLOW_RECORD_CUSTOM_TYPE,
      expect.objectContaining({ kind: "settled", runId, status: "done" }),
    );
  });
});
