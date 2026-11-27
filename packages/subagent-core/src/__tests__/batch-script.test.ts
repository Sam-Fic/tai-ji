// batch-script.test.ts — batch.js workflow 脚本行为契约直测（subagent_batch 工具的专用执行体）
//
// 覆盖范围（与 fan-out-script.test.ts 的分工：收集内核的行为契约在 fan-out 侧直测——
// 两模板共用 _shared/batch-collect.cjs；本文件只测 batch 模板**自身**的契约）：
//   - 无归约节点：aggregate 参数/阶段/agent 派发三处皆不存在（传了也被 inert 忽略）
//   - 纯收集终态：results 全量带回 + partial/truncated/partialMembers 形态不变
//   - scriptPath 锚定 fail-fast（模板自带的 _shared 加载守卫，先于 require）
//   - 收集内核单实现的结构锚（模板经 scriptPath 锚定加载内核，不复制收集逻辑）
//   - @pi-meta 形态（name/phases/parameters 对象-only + thinkingLevel enum 对拍）
//
// 测试方法（同 fan-out-script.test.ts 先例）：batch.js 是 pi worker 模板脚本——顶层
// 执行 + 顶层 return，不可作为 ES module import。用 AsyncFunction 在本进程内复刻
// worker 模板宿主形态（注入 fake agent / parallel / phase / log 与 require；
// workerData.scriptPath 锚定契约，注入真实路径）。派发/断言语义不变、零 spawn。
// 探针无文件系统副作用（batch 不落盘；deliverables 的 file 谓词走真实 fs.stat 时用
// mkdtemp 自建临时产物）。
//
// fake parallel 复刻 worker-script-builder.ts parallel() 的结果归一化语义
//（fulfilled 对象透传 / fulfilled 非对象→failed / rejected→failed），使「成员死亡走
// allSettled failed 分支」断言对齐真实 worker 行为，而非测试自造契约。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { THINKING_ORDER } from "../shared/model-ref.ts";

const WORKFLOWS_DIR = join(__dirname, "..", "..", "workflows");
const BATCH_PATH = join(WORKFLOWS_DIR, "batch.js");
const BATCH_SOURCE = readFileSync(BATCH_PATH, "utf8");
const BATCH_CORE_SOURCE = readFileSync(join(WORKFLOWS_DIR, "_shared", "batch-collect.cjs"), "utf8");

/** fake agent 行为表。 */
interface AgentBehavior { // oe-exempt:20261124:test:fake agent 行为表夹具类型（仅本测试文件内消费，无第二实现）
  /** 每个成功成员的 summary 字符串（默认短摘要） */
  summaryOf?: string;
  /** 这些派发序下标的成员失败 */
  failIndexes?: number[];
  /** 失败形态：reject（成员死亡/崩溃）或 resolve-string（非对象结果→failed） */
  failMode?: "reject" | "resolve-string";
  /** 按派发序下标覆盖成功成员的返回对象（structured_output 谓词缺失形态等）。 */
  resultOverrides?: Record<number, Record<string, unknown>>;
}

interface AgentCallRecord { // oe-exempt:20261124:test:agent() 派发记录夹具类型（仅本测试文件内消费，无第二实现）
  description?: string;
  prompt?: string;
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  schema?: { required?: string[]; properties?: Record<string, unknown> };
}

interface ProbeResult { // oe-exempt:20261124:test:探针返回值夹具类型（仅本测试文件内消费，无第二实现）
  outcome: {
    status: string;
    results: Array<{
      task?: string;
      taskIndex: number;
      status: string;
      summary?: string;
      fullReportPath?: string;
      error?: string;
      observations?: string[];
    }>;
    aggregate?: unknown;
    truncated?: boolean;
    message?: string;
    partialMembers?: Array<{ taskIndex: number; missing: string[] }>;
  };
  agentCalls: AgentCallRecord[];
  logs: string[];
}

/** worker 模板宿主形态：AsyncFunction 以注入参数为自由变量执行整脚本源码（顶层 return 即 runner 应答值）。 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...params: string[]
) => (this: unknown, ...args: unknown[]) => Promise<unknown>;

const makeRunner = () =>
  new AsyncFunction("workerData", "$ARGS", "agent", "parallel", "phase", "log", "require", BATCH_SOURCE + "\n");

const WORKER_DATA = { scriptPath: BATCH_PATH };
const requireFromTest = createRequire(import.meta.url);
/** 内核模块本体（预算常量不导出——常量值由本测试直接 require 断言，见下）。 */
const batchCore = requireFromTest(join(WORKFLOWS_DIR, "_shared", "batch-collect.cjs")) as {
  parseTasks: unknown;
  collectMembers: unknown;
  buildOutcome: unknown;
  RESULTS_BUDGET_CHARS: number;
};
const noopPhase = (): void => {};

/** fake agent：行为表驱动（与 fan-out-script.test.ts 同款，成员 description 前缀 = batch-）。 */
function makeFakeAgent(behavior: AgentBehavior, agentCalls: AgentCallRecord[]) {
  return (opts: AgentCallRecord): Promise<unknown> => {
    agentCalls.push(opts);
    const m = /^batch-(\d+)$/.exec(opts.description ?? "");
    const idx = m ? Number(m[1]) : -1;
    if (idx >= 0) {
      if ((behavior.failIndexes ?? []).includes(idx)) {
        if (behavior.failMode === "resolve-string") {
          // resolve-string = 引擎失败回退形态（非对象结果 → parallel 归一化判 failed）
          return Promise.resolve("plain error text " + idx);
        }
        return Promise.reject(new Error("boom-" + idx));
      }
      if (behavior.resultOverrides?.[idx] !== undefined) {
        return Promise.resolve(behavior.resultOverrides[idx]);
      }
      return Promise.resolve({
        summary: behavior.summaryOf ?? "summary-" + idx,
        fullReportPath: "/tmp/batch-report-" + idx + ".md",
      });
    }
    // 模板不应派发成员之外的 agent（无 aggregate 节点）——走到这里即违约
    return Promise.resolve({ summary: "unexpected-extra-agent:" + String(opts.description) });
  };
}

/** parallel 归一化语义复刻（worker-script-builder.ts parallel() 的三分支）。 */
async function fakeParallel(
  calls: Array<Promise<unknown> | AgentCallRecord>,
  fakeAgent: (opts: AgentCallRecord) => Promise<unknown>,
): Promise<Array<Record<string, unknown>>> {
  const settled = await Promise.allSettled(
    calls.map((c) => (c instanceof Promise ? c : fakeAgent(c as AgentCallRecord))),
  );
  return settled.map((r) => {
    if (r.status === "fulfilled") {
      const v = r.value;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const rec = v as Record<string, unknown>;
        if (typeof rec.error === "string" && rec.error.length > 0) {
          return { status: "failed", error: rec.error };
        }
        return rec;
      }
      return { status: "failed", error: "agent returned non-object result (type=" + typeof v + ")" };
    }
    const reason = r.reason;
    return { status: "failed", error: reason instanceof Error ? reason.message : String(reason) };
  });
}

async function runScript(args: unknown, behavior: AgentBehavior, workerData: unknown = WORKER_DATA): Promise<ProbeResult> {
  const agentCalls: AgentCallRecord[] = [];
  const logs: string[] = [];
  const fakeAgent = makeFakeAgent(behavior, agentCalls);
  const outcome = (await makeRunner()(
    workerData,
    args,
    fakeAgent,
    (calls: Array<Promise<unknown> | AgentCallRecord>) => fakeParallel(calls, fakeAgent),
    noopPhase,
    (msg: unknown) => {
      logs.push(String(msg));
    },
    requireFromTest,
  )) as ProbeResult["outcome"];
  return { outcome, agentCalls, logs };
}

async function runScriptExpectThrow(args: unknown, behavior: AgentBehavior, workerData: unknown = WORKER_DATA): Promise<string> {
  try {
    await runScript(args, behavior, workerData);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected script to throw, but it resolved with args: " + JSON.stringify(args));
}

const THREE_TASKS = [{ task: "count ts files" }, { task: "count md files" }, { task: "list exports" }];

describe("batch.js 无归约节点（批量执行体的核心契约：结果原样全量带回）", () => {
  it("传 aggregate=true 也被 inert 忽略：成员数 = agent 调用数，outcome 无 aggregate 字段", async () => {
    // 参数侧 additionalProperties:false 会在 ajv 层先拒（工具/run 入口），此处验证
    // 脚本自身也不读该参数——绕过 ajv 的直参宿主形态下同样无归约节点。
    const r = await runScript({ tasks: THREE_TASKS, aggregate: true }, {});
    expect(r.outcome.status).toBe("ok");
    expect(r.agentCalls).toHaveLength(THREE_TASKS.length);
    expect(r.outcome.aggregate).toBeUndefined();
    expect(r.agentCalls.map((c) => c.description)).not.toContain("batch-aggregate");
    expect(r.agentCalls.map((c) => c.description)).not.toContain("fan-out-aggregate");
  });

  it("静态锚：无 aggregate 阶段/参数/读取（三处皆不存在才是真无节点）", () => {
    expect(BATCH_SOURCE).not.toContain('phase("aggregate")');
    expect(BATCH_SOURCE).not.toContain("$ARGS.aggregate");
    // @pi-meta parameters 不含 aggregate 键（通用模板 fan-out 才保留）
    const metaStart = BATCH_SOURCE.indexOf("/* @pi-meta");
    const metaBlock = BATCH_SOURCE.slice(metaStart, BATCH_SOURCE.indexOf("*/", metaStart));
    expect(metaBlock).not.toContain("aggregate:");
  });

  it("meta.phases 恰为 [\"batch\"]（单段：派发即收集，无第二段）", () => {
    const metaStart = BATCH_SOURCE.indexOf("/* @pi-meta");
    const metaBlock = BATCH_SOURCE.slice(metaStart, BATCH_SOURCE.indexOf("*/", metaStart));
    expect(metaBlock).toContain('phases: ["batch"]');
    expect(BATCH_SOURCE.match(/\bphase\s*\(/g) ?? []).toHaveLength(1);
  });

  it("纯收集终态：status=ok 时 results 全量带回（每条 task/taskIndex/status/summary/fullReportPath）", async () => {
    const r = await runScript({ tasks: THREE_TASKS }, {});
    expect(r.outcome.status).toBe("ok");
    expect(r.outcome.results).toHaveLength(3);
    expect(r.outcome.truncated).toBeUndefined();
    expect(r.outcome.partialMembers).toBeUndefined();
    r.outcome.results.forEach((entry, i) => {
      expect(entry.taskIndex).toBe(i);
      expect(entry.status).toBe("ok");
      expect(entry.summary).toBe("summary-" + i);
      expect(entry.fullReportPath).toBe("/tmp/batch-report-" + i + ".md");
    });
  });

  it("收集内核单实现：模板经 scriptPath 锚定加载 _shared/batch-collect.cjs（不在模板内复制收集逻辑）", () => {
    expect(BATCH_SOURCE).toContain("_shared/batch-collect.cjs");
    expect(BATCH_SOURCE).not.toContain('r.status === "failed"');
    expect(BATCH_SOURCE).not.toContain("fitResultsInBudget");
    expect(BATCH_CORE_SOURCE).toContain("module.exports");
  });
});

describe("batch.js scriptPath 锚定 fail-fast（_shared 内核的加载守卫，先于 require）", () => {
  // workerData 以 runner 首参直传（不经 runScript 的缺省装配）——缺席/空串两种旧格式
  // 形态都要在加载 _shared 内核之前被自己的守卫拦住。
  const agentCalls: AgentCallRecord[] = [];
  const fakeAgent = makeFakeAgent({}, agentCalls);

  it("workerData.scriptPath 缺席 → core_module_load_failed + 恢复动作，零 agent 调用", async () => {
    const err = (await makeRunner()(
      undefined,
      { tasks: [{ task: "t0" }] },
      fakeAgent,
      (calls: Array<Promise<unknown> | AgentCallRecord>) => fakeParallel(calls, fakeAgent),
      noopPhase,
      () => {},
      requireFromTest,
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("core_module_load_failed");
    expect(err.message).toContain("scriptPath is missing");
    expect(err.message).toContain("Recovery:");
    expect(agentCalls).toHaveLength(0);
  });

  it("workerData.scriptPath 为空串（旧格式 record 流）→ 同族 fail-fast + resume 指引，零 agent 调用", async () => {
    const message = await runScriptExpectThrow({ tasks: [{ task: "t0" }] }, {}, { scriptPath: "" });
    expect(message).toContain("core_module_load_failed");
    expect(message).toContain("resume");
    expect(message).toContain("Recovery:");
    expect(agentCalls).toHaveLength(0);
  });
});

describe("batch.js 入口 fail-fast（tasks 对象-only 契约）", () => {
  it("tasks 元素为旧字符串形态 → 专属迁移文案（旧形状早于成员对象格式）", async () => {
    const message = await runScriptExpectThrow({ tasks: ["t0", "t1"] }, {});
    expect(message).toContain("legacy args shape detected");
    expect(message).toContain("predates the member-object parameter format");
    expect(message).toContain("Recovery: re-dispatch a NEW run with member-object tasks");
    expect(message).toContain("Correct:");
  });

  it("顶层 agents 残留键（成员对象 tasks + agents）→ 专属迁移文案", async () => {
    const message = await runScriptExpectThrow(
      { tasks: [{ task: "t0" }], agents: "/a/one.md,/b/two.md" },
      {},
    );
    expect(message).toContain('top-level "agents" key present');
    expect(message).toContain("predates the member-object parameter format");
  });

  it("tasks 缺失 → throw 带 Correct 示例", async () => {
    const message = await runScriptExpectThrow({}, {});
    expect(message).toContain("tasks is required");
    expect(message).toContain('Correct: {"tasks"');
  });

  it("tasks 空数组 → throw（minItems:1 的脚本入口纵深）", async () => {
    const message = await runScriptExpectThrow({ tasks: [] }, {});
    expect(message).toContain("tasks is required");
  });

  it("成员缺 task 字段 / member.task 空白 → throw（task 必填且非空白）", async () => {
    const missing = await runScriptExpectThrow({ tasks: [{ task: "ok" }, { agent: "/a/one.md" }] }, {});
    expect(missing).toContain('must be objects with a non-blank "task" string');
    const blank = await runScriptExpectThrow({ tasks: [{ task: "ok" }, { task: "   " }] }, {});
    expect(blank).toContain('must be objects with a non-blank "task" string');
  });

  it("deliverables 纵深校验：空数组 / kind=file 缺 path / structured_output 带 path / 词表外 kind → 入口 throw 带修正形态", async () => {
    await expect(runScriptExpectThrow({ tasks: [{ task: "t0", deliverables: [] }] }, {})).resolves.toContain(
      "must be a non-empty array",
    );
    await expect(runScriptExpectThrow({ tasks: [{ task: "t0", deliverables: [{ kind: "file" }] }] }, {})).resolves.toContain(
      'kind="file" requires a non-empty "path"',
    );
    await expect(
      runScriptExpectThrow({ tasks: [{ task: "t0", deliverables: [{ kind: "structured_output", path: "/x" }] }] }, {}),
    ).resolves.toContain('kind="structured_output" takes no path/minBytes');
    await expect(runScriptExpectThrow({ tasks: [{ task: "t0", deliverables: [{ kind: "none" }] }] }, {})).resolves.toContain(
      'kind must be "file" or "structured_output"',
    );
  });
});

describe("batch.js 成员级配置派发（成员对象 agent/model/thinkingLevel）", () => {
  it("成员级 agent 逐成员生效（各成员可不同执行者）", async () => {
    const r = await runScript(
      { tasks: [{ task: "t0", agent: "/a/one.md" }, { task: "t1", agent: "/b/two.md" }, { task: "t2", agent: "/a/one.md" }] },
      {},
    );
    expect(r.outcome.status).toBe("ok");
    expect(r.agentCalls.map((c) => c.agent)).toEqual(["/a/one.md", "/b/two.md", "/a/one.md"]);
  });

  it("成员未指定 agent → 不带 agent 字段（默认执行者；未指定字段不进 agent() 调用）", async () => {
    const r = await runScript({ tasks: [{ task: "t0" }, { task: "t1" }] }, {});
    expect(r.outcome.status).toBe("ok");
    for (const call of r.agentCalls) {
      expect(call.agent).toBeUndefined();
    }
  });

  it("成员级 model/thinkingLevel 进 agent() 调用；未指定不带字段（留给 $MODEL/$THINKING_LEVEL 继承）", async () => {
    const r = await runScript(
      {
        tasks: [
          { task: "t0", model: "prov/model-one", thinkingLevel: "high" },
          { task: "t1" },
        ],
      },
      {},
    );
    expect(r.agentCalls[0].model).toBe("prov/model-one");
    expect(r.agentCalls[0].thinkingLevel).toBe("high");
    expect(r.agentCalls[1].model).toBeUndefined();
    expect(r.agentCalls[1].thinkingLevel).toBeUndefined();
  });

  it("description 恒为 batch-<i>（成员复用身份键，派发序对齐）", async () => {
    const r = await runScript({ tasks: THREE_TASKS }, {});
    expect(r.agentCalls.map((c) => c.description)).toEqual(["batch-0", "batch-1", "batch-2"]);
  });

  it("prompt = member.task 原文（无转译包装）", async () => {
    const r = await runScript({ tasks: THREE_TASKS }, {});
    expect(r.agentCalls.map((c) => c.prompt)).toEqual(THREE_TASKS.map((m) => m.task));
  });
});

describe("batch.js taskIndex 派发序赋值（权威源契约）", () => {
  it("results[].taskIndex 严格等于 $ARGS.tasks 下标，task 文本以 member.task 为权威源", async () => {
    const r = await runScript({ tasks: THREE_TASKS.map((m) => ({ ...m, agent: "/x/one.md" })) }, {});
    expect(r.outcome.status).toBe("ok");
    r.outcome.results.forEach((entry, i) => {
      expect(entry.taskIndex).toBe(i);
      expect(entry.task).toBe(THREE_TASKS[i].task);
      expect(entry.status).toBe("ok");
    });
  });

  it("成员输出 schema 不含 taskIndex（成员无从错报）——schema 只有 summary/fullReportPath", async () => {
    const r = await runScript({ tasks: [{ task: "t0" }, { task: "t1" }] }, {});
    for (const call of r.agentCalls) {
      expect(call.schema?.required).toEqual(["summary"]);
      expect(Object.keys(call.schema?.properties ?? {}).sort()).toEqual(["fullReportPath", "summary"]);
    }
  });
});

describe("batch.js 失败语义（allSettled partial 收尾）", () => {
  it("部分成员失败 → status=partial，失败条目带 error，其余成员 ok 不被阻断；收尾提示只重派失败 taskIndex", async () => {
    const r = await runScript({ tasks: THREE_TASKS.map((m) => ({ ...m, agent: "/x/one.md" })) }, { failIndexes: [1] });
    expect(r.outcome.status).toBe("partial");
    expect(r.outcome.results[0].status).toBe("ok");
    expect(r.outcome.results[1].status).toBe("failed");
    expect(r.outcome.results[1].error).toContain("boom-1");
    expect(r.outcome.results[2].status).toBe("ok");
    expect(r.outcome.results[1].taskIndex).toBe(1);
    expect(r.outcome.results[1].task).toBe(THREE_TASKS[1].task);
    // 三个成员都被派发（失败不阻断派发集合）
    expect(r.agentCalls).toHaveLength(3);
    expect(r.outcome.message).toContain("taskIndex");
    expect(r.outcome.message).toContain("失败 1");
  });

  it("成员 resolve 非对象结果（引擎失败回退形态）→ failed 条目，不炸 run", async () => {
    const r = await runScript({ tasks: [{ task: "t0" }, { task: "t1" }] }, { failIndexes: [0], failMode: "resolve-string" });
    expect(r.outcome.status).toBe("partial");
    expect(r.outcome.results[0].status).toBe("failed");
    expect(r.outcome.results[0].error).toContain("non-object result");
    expect(r.outcome.results[1].status).toBe("ok");
  });

  it("全员失败 → throw（run failed，非 error outcome 收尾）", async () => {
    const message = await runScriptExpectThrow({ tasks: [{ task: "t0" }, { task: "t1" }] }, { failIndexes: [0, 1] });
    expect(message).toContain("all tasks failed");
    expect(message).toContain("2/2");
  });
});

describe("batch.js 通知体积保序截断（truncated 标记）", () => {
  it("results 超预算 → truncated:true，按序截断（靠前完整、靠后让出 summary），taskIndex/status/路径恒完整", async () => {
    const r = await runScript(
      { tasks: [{ task: "t0" }, { task: "t1" }, { task: "t2" }, { task: "t3" }, { task: "t4" }] },
      { summaryOf: "x".repeat(3000) },
    );
    expect(r.outcome.status).toBe("ok");
    expect(r.outcome.truncated).toBe(true);
    expect(r.outcome.results).toHaveLength(5);
    expect(r.outcome.results[0].summary).toBe("x".repeat(3000));
    expect(r.outcome.results[2].summary).toBeUndefined();
    r.outcome.results.forEach((entry, i) => {
      expect(entry.taskIndex).toBe(i);
      expect(entry.status).toBe("ok");
      expect(entry.fullReportPath).toBe("/tmp/batch-report-" + i + ".md");
    });
  });

  it("总量在预算内 → 无 truncated 标记（缺省即 false 语义）", async () => {
    const r = await runScript({ tasks: [{ task: "t0" }, { task: "t1" }] }, {});
    expect(r.outcome.truncated).toBeUndefined();
    expect(r.outcome.results[0].summary).toBe("summary-0");
  });
});

describe("batch.js 产物契约（deliverables 谓词，§3.3.10）", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "batch-deliverables-"));
  });
  afterAll(() => {
    // teardown 递归删除补 maxRetries：与在途异步写竞争时 ENOTEMPTY 满载 flake
    //（check_test_flake_hygiene F3——默认 maxRetries=0，一次瞬态失败即抛）
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("缺省不传 deliverables = 不做交付校验：outcome 无 partialMembers、条目无 observations", async () => {
    const r = await runScript({ tasks: [{ task: "t0" }] }, {});
    expect(r.outcome.partialMembers).toBeUndefined();
    expect(r.outcome.results[0].observations).toBeUndefined();
  });

  it("UC-11 部分交付：2 项 deliverables 仅 file 落盘 → status ok（不进失败）+ partialMembers + observations", async () => {
    const good = join(dir, "report.md");
    writeFileSync(good, "x".repeat(64), "utf8");
    const r = await runScript(
      {
        tasks: [
          {
            task: "t0",
            deliverables: [
              { kind: "file", path: good, minBytes: 10 },
              { kind: "file", path: "/nonexistent/batch-missing.md", minBytes: 10 },
            ],
          },
        ],
      },
      {},
    );
    expect(r.outcome.status).toBe("ok");
    expect(r.outcome.partialMembers).toEqual([
      { taskIndex: 0, missing: ["file:/nonexistent/batch-missing.md (not readable (ENOENT))"] },
    ]);
    expect(r.outcome.results[0].observations).toEqual([
      "deliverable missing: file:/nonexistent/batch-missing.md (not readable (ENOENT))",
    ]);
  });

  it("UC-11 全不满足 → 成员 failed（agent.no_deliverable）+ failedCount 计入 partial 收尾", async () => {
    const r = await runScript(
      {
        tasks: [
          { task: "t0", deliverables: [{ kind: "file", path: "/nonexistent/batch-a.md" }, { kind: "structured_output" }] },
          { task: "t1" },
        ],
      },
      { resultOverrides: { 0: { summary: "" } } }, // summary 空 = structured_output 亦未满足
    );
    expect(r.outcome.results[0].status).toBe("failed");
    expect(r.outcome.results[0].error).toContain("agent.no_deliverable");
    expect(r.outcome.results[0].error).toContain("2 deliverable(s) missing");
    expect(r.outcome.results[0].observations?.[0]).toContain("deliverable missing:");
    expect(r.outcome.status).toBe("partial"); // 另一成员正常 → partial 收尾
    expect(r.outcome.partialMembers).toBeUndefined(); // 全缺走失败集合，不进 partialMembers
  });

  it("UC-12 cause 优先级：成员死于上游失败 + deliverables 全缺 → 保持原失败事实，不冒充 agent.no_deliverable", async () => {
    const r = await runScript(
      {
        tasks: [
          { task: "t0", deliverables: [{ kind: "file", path: "/nonexistent/batch-x.md" }] },
          { task: "t1" },
        ],
      },
      { failIndexes: [0] },
    );
    expect(r.outcome.results[0].status).toBe("failed");
    expect(r.outcome.results[0].error).toContain("boom-0"); // 上游事实原样保留
    expect(r.outcome.results[0].error).not.toContain("agent.no_deliverable");
    expect(r.outcome.results[0].observations?.[0]).toContain("member failed upstream");
    expect(r.outcome.results[0].observations?.[0]).toContain("agent.no_deliverable not assigned");
  });
});

describe("batch.js 模块形态与参数侧契约", () => {
  it("顶层 return 使其不可作为 ES module import（pi worker 脚本，非可导入模块）", async () => {
    await expect(import("../../workflows/batch.js" as string)).rejects.toThrow();
  });

  it("通知体积预算常量 8000 + 导出面恰为三个编排入口（常量不导出——锁值走源码，锁面走模块键）", () => {
    // 常量值是内核内部事实：走源码字面量断言（改了会红），不为此多一个导出面
    expect(BATCH_CORE_SOURCE).toContain("RESULTS_BUDGET_CHARS = 8000");
    // 导出面 = 模板真正消费的三个编排入口（parseTasks/collectMembers/buildOutcome）
    expect(Object.keys(batchCore).sort()).toEqual(["buildOutcome", "collectMembers", "parseTasks"]);
  });

  it("参数范围无 tasksJson（tasks 直接数组是唯一任务集入口）", () => {
    expect(BATCH_SOURCE).not.toContain("tasksJson");
    expect(BATCH_SOURCE).not.toContain("itemsJson");
  });

  it("@pi-meta tasks schema 对象-only：顶层与 items 均 additionalProperties:false + task minLength + agent pattern ^/ + maxItems", () => {
    const metaStart = BATCH_SOURCE.indexOf("/* @pi-meta");
    const metaBlock = BATCH_SOURCE.slice(metaStart, BATCH_SOURCE.indexOf("*/", metaStart));
    expect(metaBlock).toContain("additionalProperties: false");
    expect(metaBlock).toContain("minLength: 1");
    expect(metaBlock).toContain('pattern: "^/"');
    expect(metaBlock).toContain("minItems: 1");
    expect(metaBlock).toContain("maxItems: 20");
  });

  it("@pi-meta 无 agents 参数（随成员对象化退役）；无 aggregate 参数（批量无归约）", () => {
    const metaStart = BATCH_SOURCE.indexOf("/* @pi-meta");
    const metaBlock = BATCH_SOURCE.slice(metaStart, BATCH_SOURCE.indexOf("*/", metaStart));
    expect(metaBlock).not.toContain("agents:");
    expect(metaBlock).not.toContain("aggregate:");
  });

  it("两形态谓词封闭枚举：@pi-meta kind enum 恰为 file/structured_output（无 none）+ items additionalProperties:false", () => {
    const metaStart = BATCH_SOURCE.indexOf("/* @pi-meta");
    const metaBlock = BATCH_SOURCE.slice(metaStart, BATCH_SOURCE.indexOf("*/", metaStart));
    expect(metaBlock).toContain('enum: ["file", "structured_output"]');
  });

  it("thinkingLevel enum 与运行级 THINKING_ORDER 动态对拍（worker eval 环境无 TS import，字面量须手动同步）", () => {
    const metaStart = BATCH_SOURCE.indexOf("/* @pi-meta");
    const metaBlock = BATCH_SOURCE.slice(metaStart, BATCH_SOURCE.indexOf("*/", metaStart));
    const m = /enum: \[([^\]]*)\]/.exec(metaBlock);
    expect(m, "batch.js @pi-meta 应声明 thinkingLevel enum").not.toBeNull();
    const declared = (m?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    expect([...declared].sort()).toEqual([...THINKING_ORDER].sort());
  });
});
