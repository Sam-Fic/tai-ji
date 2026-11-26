// src/__tests__/record-mode/template-resume.test.ts
//
// 场景 A2/A4（scriptPath 锚定恢复。机制自包含：run-created 帧携带 scriptPath 才能
// 锚定重建，缺席/空串 fail-fast——被验行为见下文与断言本体；原引用的设计档案
// workflow-resume-scriptpath-recovery.md §4 验收表随 .tmp 产物清理已不存在，git 可追溯）：
// 内置模板脚本（fan-out 真文件）的 resume 真链路。
//
// 回归测试 = a1a4 真机终判 BLOCKED 的缺陷①：修复前 resume 重建 spec.scriptPath 恒空串，
// worker 加载 fan-out 即因 scriptPath 锚定检查 fail-fast（cwd 相对解析的依赖加载收紧后
// 无回退）；修复后 run-created 帧携带 scriptPath → 锚定恢复 → 续跑成功（A2）。A4 = 旧
// 格式帧（无 scriptPath 载荷）回落现状失败形态——收紧后带恢复指引的 fail-fast。
//
// 夹具协议与 scenario-kit 同源：真 resumeRun + 真 WorkerHostImpl（node:worker_threads
// 真线程跑 fan-out.js，scriptPath 锚定检查消费包内真实路径），唯一替身 =
// faux runner（LLM 层替身）。fan-out 派发序 = tasks 成员对象数组序（map 同步构造 +
// parallel 按序发 agent-call），taskIndex 与 seed 对齐。
import fs from "node:fs";
import path from "node:path";

import { WorkflowScriptRegistryImpl } from "@zhushanwen/subagent-core";
import type { AgentRunner } from "@zhushanwen/subagent-core/orchestration/models/ports.ts";
import type { AgentResult } from "@zhushanwen/subagent-core/orchestration/models/types.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  resumeScenarioRun,
  seedCrashedRun,
  waitForScenarioSettled,
  type ScenarioEnv,
} from "./scenario-kit.ts";

/**
 * 包内 fan-out 模板真文件（worker require _shared 的锚定目标）。定位用向上查找
 *（locateTsx 同款形态）——vitest 的 vite resolver 不解析跨包包根（createRequire
 * resolve 受 package exports 限制）。
 */
function locateFanOut(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (;;) {
    const candidate = path.join(dir, "packages", "subagent-core", "workflows", "fan-out.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("fan-out.js not found in any ancestor of " + dir);
    dir = parent;
  }
}

const FAN_OUT_ABS = locateFanOut();

/** fan-out 可执行源（registry 解析链——与生产 buildRunSpecFromScript 的 toExecutable 同源）。 */
async function fanOutExecutableSource(): Promise<string> {
  const script = await new WorkflowScriptRegistryImpl().getPath(FAN_OUT_ABS);
  expect(script, `registry should resolve ${FAN_OUT_ABS}`).toBeDefined();
  return script!.toExecutable();
}

/** 成员对象形态（对象-only 契约——旧字符串数组写法已被 @pi-meta schema 拒绝）。 */
const FAN_OUT_ARGS = { tasks: [{ task: "alpha job" }, { task: "beta job" }] };

/** 包内 batch 模板真文件（subagent_batch 工具执行体；worker require _shared 的锚定目标）。 */
function locateBatch(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (;;) {
    const candidate = path.join(dir, "packages", "subagent-core", "workflows", "batch.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("batch.js not found in any ancestor of " + dir);
    dir = parent;
  }
}

const BATCH_ABS = locateBatch();

/** batch 可执行源（registry 解析链——与生产 buildRunSpecFromScript 的 toExecutable 同源）。 */
async function batchExecutableSource(): Promise<string> {
  const script = await new WorkflowScriptRegistryImpl().getPath(BATCH_ABS);
  expect(script, `registry should resolve ${BATCH_ABS}`).toBeDefined();
  return script!.toExecutable();
}

/** batch 模板成员对象形态（与 fan-out 同族；batch 无 aggregate 参数）。 */
const BATCH_ARGS = { tasks: [{ task: "alpha job" }, { task: "beta job" }] };

/**
 * A5 专用 faux runner：schema 调用回 `parsedOutput`（结构化产出）。
 *
 * 为什么不用 kit 的 makeFauxRunner：它只回 `content`，而 batch 模板的成员调用恒带
 * schema——worker 侧 schema 结果出口要求对象形态（ADR-0092：无文本回落），纯 content
 * 会被归一成 failed 成员（A2 的 fan-out 场景因此只断言生命周期）。本场景要断言纯收集
 * outcome 的逐字段形态，故自带回 parsedOutput 的替身（dispatch 捕获面与 kit 同形）。
 */
function makeSchemaFauxRunner(): {
  runner: AgentRunner;
  steps: never[];
  dispatches: Array<{ seq: number; opts: Record<string, unknown> }>;
  release: (seq: number, content: string) => void;
} {
  const dispatches: Array<{ seq: number; opts: Record<string, unknown> }> = [];
  const runner: AgentRunner = {
    async run(opts: Record<string, unknown>): Promise<AgentResult> {
      const seq = dispatches.length + 1;
      dispatches.push({ seq, opts });
      return opts.schema !== undefined
        ? {
            content: "",
            parsedOutput: { summary: "faux-summary-" + seq, fullReportPath: "/tmp/faux-" + seq + ".md" },
            durationMs: 1,
          }
        : { content: "faux-result-" + seq, durationMs: 1 };
    },
  };
  return { runner, steps: [], dispatches, release: () => {} };
}

describe("场景 A2/A4：内置模板 resume（scriptPath 锚定恢复）", () => {
  let env: ScenarioEnv;
  /** fan-out 可执行源缓存（registry 解析只跑一次，两用例共用——toExecutable 是
   * 纯文本变换（strip export const meta），本链路不含 lint）。 */
  let fanOutSource: string;
  beforeAll(async () => {
    env = mkScenarioEnv("template-resume");
    fanOutSource = await fanOutExecutableSource();
  });
  afterAll(() => env.cleanup());

  it("A2 fan-out 中断续跑：锚定恢复 → worker 真跑 fan-out.js（scriptPath 锚定通过）→ 回放零重派 + 在途重派 + 终态 done", async () => {
    const RUN = "wf-tpl-a2";
    await seedCrashedRun(env, RUN, {
      scriptSource: fanOutSource,
      workflowName: "fan-out",
      scriptPath: FAN_OUT_ABS,
      args: FAN_OUT_ARGS,
      settled: [{ agent: "fan-out-0" }], // taskIndex 0 已完成（resume 回放面）
      inflight: [{ agent: "fan-out-1" }], // taskIndex 1 在途（重派面）
    });

    const sd = makeScenarioDeps(env, makeFauxRunner());
    const resumed = await resumeScenarioRun(env, sd, RUN);

    expect(resumed).toBe(RUN);
    // 锚定从 run-created 帧逐字恢复（修复核心断言——修复前恒 ""）
    expect(sd.runs.get(RUN)!.spec.scriptPath).toBe(FAN_OUT_ABS);
    const outcome = await waitForScenarioSettled(sd.runs, RUN);
    // 修复前此处 failed（scriptPath 恒空串触发锚定 fail-fast）
    expect(outcome.status).toBe("done");
    // 零重派断言：taskIndex 0 缓存回话（不进 dispatches），仅 taskIndex 1 真实派发
    expect(sd.faux.dispatches).toHaveLength(1);
  });

  it("A4 旧格式帧（无 scriptPath 载荷）：fan-out resume 失败 = 收紧后 core_module_load_failed + 恢复指引，未到派发", async () => {
    const RUN = "wf-tpl-a4";
    await seedCrashedRun(env, RUN, {
      scriptSource: fanOutSource,
      workflowName: "fan-out",
      // scriptPath 缺省 = 旧格式帧（scriptPath 载荷落地前的形态）
      args: FAN_OUT_ARGS,
      settled: [{ agent: "fan-out-0" }],
      inflight: [{ agent: "fan-out-1" }],
    });

    const sd = makeScenarioDeps(env, makeFauxRunner());
    await resumeScenarioRun(env, sd, RUN);

    const outcome = await waitForScenarioSettled(sd.runs, RUN);
    // runSummary 派生视图：status = lifecycle 终局（done），reason = 结果（failed）
    expect(outcome.status).toBe("done");
    expect(outcome.reason).toBe("failed");
    // 收紧后的失败形态：带 core_module_load_failed 前缀（修复前为无前缀的
    // Node 原生 Cannot find module）+ 空串形态专属恢复指引（含 resume 字样）
    expect(outcome.error).toContain("core_module_load_failed");
    expect(outcome.error).toContain("resume");
    // 加载即失败（require _shared 前），未到任何成员派发
    expect(sd.faux.dispatches).toHaveLength(0);
  });
});

// ── 场景 A5：batch 模板（subagent_batch 工具执行体）真 worker 跑通 ──
// 与 A2 同夹具协议（真 resumeRun + 真 WorkerHostImpl + faux runner），被验对象换成
// `batch` 模板——它是 subagent_batch 工具的固定执行体，也是唯一「经 scriptPath 锚定
// require _shared 收集内核」的新模板。A2 证 fan-out 的内核加载链，本场景证 batch 自身：
// 真 worker eval 模式下绝对路径 require 命中 `_shared/batch-collect.cjs`、成员身份键
// = `batch-<i>`、终态 = 纯收集 outcome（无 aggregate 字段/无第二个 agent 派发）。
describe("场景 A5：batch 模板（subagent_batch 工具执行体）真 worker 跑通", () => {
  let env: ScenarioEnv;
  let batchSource: string;
  beforeAll(async () => {
    env = mkScenarioEnv("template-batch");
    batchSource = await batchExecutableSource();
  });
  afterAll(() => env.cleanup());

  it("A5 batch 中断续跑：真 worker 加载 batch.js + _shared 内核 → 回放零重派 + 在途重派 + 终态 completed + 纯收集 outcome", async () => {
    const RUN = "wf-tpl-a5";
    await seedCrashedRun(env, RUN, {
      scriptSource: batchSource,
      workflowName: "batch",
      scriptPath: BATCH_ABS,
      args: BATCH_ARGS,
      settled: [{
        agent: "batch-0",
        // taskIndex 0 已完成（resume 回放面）——带 parsedOutput 使回放结果过 schema 归一化
        result: { content: "", parsedOutput: { summary: "settled-summary-0", fullReportPath: "/tmp/settled-0.md" }, durationMs: 100 },
      }],
      inflight: [{ agent: "batch-1" }], // taskIndex 1 在途（重派面）
    });

    const faux = makeSchemaFauxRunner();
    const sd = makeScenarioDeps(env, faux);
    const resumed = await resumeScenarioRun(env, sd, RUN);

    expect(resumed).toBe(RUN);
    // 锚定从 run-created 帧逐字恢复（batch 模板的 _shared 加载前提）
    expect(sd.runs.get(RUN)!.spec.scriptPath).toBe(BATCH_ABS);
    const outcome = await waitForScenarioSettled(sd.runs, RUN);
    expect(outcome.status).toBe("done");
    expect(outcome.reason).toBe("completed");
    // 零重派断言：taskIndex 0 缓存回话，仅 taskIndex 1 真实派发（成员身份键 = batch-<i>）
    expect(faux.dispatches).toHaveLength(1);
    expect(faux.dispatches[0].opts.description).toBe("batch-1");
    // 纯收集终态：results 全量带回、无 aggregate 字段（归约节点不存在）、message 带模板名前缀
    const scriptResult = sd.runs.get(RUN)!.state.scriptResult as {
      status?: string;
      results?: Array<{ taskIndex?: number; status?: string; summary?: string }>;
      aggregate?: unknown;
      message?: string;
    };
    expect(scriptResult).toBeDefined();
    expect(scriptResult.status).toBe("ok");
    expect(scriptResult.aggregate).toBeUndefined();
    expect(scriptResult.results).toHaveLength(BATCH_ARGS.tasks.length);
    expect(scriptResult.results?.[0]).toMatchObject({ taskIndex: 0, status: "ok", summary: "settled-summary-0" });
    expect(scriptResult.results?.[1]).toMatchObject({ taskIndex: 1, status: "ok", summary: "faux-summary-1" });
    expect(scriptResult.message).toContain("batch 完成");
  });
});
