// workflow-run-fixture.ts —— WorkflowRun 真聚合根 fixture（reconstruct + AgentCall.markDone
// 注入成员进度事实 + noteRebuiltSettlement 注入终局事实，与 tool-workflow.test 的 makeRun
// 同源口径）。仅被 subagent-core 走真实现的测试文件消费（tray-widget-buttons / 
// workflow-tray-widget）；interface/gui/tray-widget.test 整体 mock subagent-core，不得
// import 本模块（见 tray-widget-test-fixtures.ts 头注释的分工说明）。
import {
  AgentCall,
  Budget,
  Trace,
  WorkflowRun,
  noteRebuiltSettlement,
} from "@zhushanwen/subagent-core";
import type { DoneReason, WorkflowRun as WorkflowRunType } from "@zhushanwen/subagent-core";

/** run fixture（真聚合根）：calls 经 AgentCall.markDone 注入成员进度事实（result 有无 =
 *  落定判据；error 有无 = 失败判据）；终局事实经 noteRebuiltSettlement 注入注册表。 */
export function makeRun(opts: {
  runId: string;
  scriptName: string;
  status: "running" | "done";
  reason?: DoneReason;
  slug?: string;
  interrupted?: boolean;
  calls?: Array<{ settled: boolean; failed?: boolean }>;
}): WorkflowRunType {
  const run = WorkflowRun.reconstruct(
    opts.runId,
    {
      scriptSource: "// stub source",
      args: {},
      scriptName: opts.scriptName,
      scriptPath: `/abs/${opts.scriptName}.js`,
      ...(opts.slug !== undefined ? { slug: opts.slug } : {}),
    },
    {
      status: opts.status,
      reason: opts.reason,
      budget: new Budget(),
      calls: new Map(
        (opts.calls ?? []).map((c, i) => {
          const call = new AgentCall(i, { prompt: `task ${i}` } as never, new Trace());
          // markRunning 前置（pending 不能直接 markDone——AgentCall 状态机约束）
          call.markRunning();
          if (c.settled) {
            call.markDone({ ...(c.failed ? { error: "boom" } : {}) } as never);
          }
          return [i, call];
        }),
      ),
      trace: new Trace(),
      errorLogs: [],
      error: undefined,
    },
    {
      startedAt: "2026-10-25T00:00:00Z",
      ...(opts.status === "done" ? { completedAt: "2026-10-25T00:01:00Z" } : {}),
      ...(opts.interrupted ? { interruptedAt: "2026-10-25T00:00:30Z" } : {}),
    },
  );
  if (opts.status === "done") {
    noteRebuiltSettlement(opts.runId, {
      outcome: opts.reason === "failed" ? "failed" : "done",
      settledAt: Date.parse("2026-10-25T00:01:00Z"),
    });
  }
  return run;
}
