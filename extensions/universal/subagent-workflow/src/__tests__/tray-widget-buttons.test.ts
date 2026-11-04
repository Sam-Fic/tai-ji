// tray-widget-buttons.test.ts —— M3 行内操作按钮声明（tray-panel-interact 设计 §3.3 D4/D5
// + composer-tray-protocol D8 行内槽迁移）。
//
// 三视角：
//   ①使用者（宿主 widget 区视角）——按钮声明形状：行内操作槽 TreeItem.actions 条目的
//     commandId（宿主薄命令，宿主侧 commandExecutor 分叉转 session 域 RPC）/ args（recordId、
//     slug+task、runId——只含标量，协议 AP-3 校验口径）/ danger 档 / confirm 两段式
//     文案；渲染条件（retry 仅 failed 行且任务原文在场、abort 仅 running、resume 仅
//     interrupted）；无按钮的行无 actions 字段（「查看」入口 = 行 hostAction 不受影响）；
//   ②构建者——纯函数入参出参（新写测试判据档①：同步逻辑，无进程/IO/时钟/挂载）；
//   ③观察者——段形态：D8 富行——每行一棵单行 list-tree，按钮挂行 actions 槽（AX3：
//     行内操作由协议字段承载，禁止独立兄弟 action-bar 块模拟），按钮 id 逐行唯一（同段
//     多行不串台）。
//
// 判据单点：running/失败判据 = @zhushanwen/extension-protocol subagent-projection
// （isRunningProjection / failedRoundOf，本测试经构造 fixture 消费真实产物）；workflow
// 三态 = core runSummary 派生视图（真聚合根 fixture）。

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks（依赖收窄：logger 防文件落盘；protocol 只 mock setWidgetDual 推送点，
//    guiComponent/guiResult 走真实现——树形状断言消费真实产物；subagent-core 走真实现
//    （WorkflowRun.reconstruct 真聚合根 + runSummary 真派生视图），与 workflow-tray-widget.test
//    同口径——本文件只测 build* 纯函数，不装推送器，无需可控 service）──

const extensionLoggerMock = vi.hoisted(() => {
  const instance = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: vi.fn(() => instance), instance };
});

const setWidgetDualMock = vi.hoisted(() => vi.fn());

vi.mock("@zhushanwen/pi-extension-logger", () => extensionLoggerMock);
vi.mock("@zhushanwen/pi-ext-guards", () => ({
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock("@zhushanwen/extension-protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhushanwen/extension-protocol")>();
  return { ...actual, setWidgetDual: setWidgetDualMock };
});

import {
  AgentCall,
  Budget,
  Trace,
  WorkflowRun,
  noteRebuiltSettlement,
} from "@zhushanwen/subagent-core";
import type { DoneReason, SubagentRecord } from "@zhushanwen/subagent-core";
import type {
  GuiComponent,
  GuiComponentProps,
  HostContainerAction,
  TreeItem,
} from "@zhushanwen/extension-protocol";
import { buildSubagentTrayWidget } from "../interface/gui/tray-widget.ts";
import type { UiLocale } from "../i18n.ts";
import { buildWorkflowTrayWidget } from "../interface/gui/workflow-tray-widget.ts";

/**
 * 面板文案 locale（D9：标题 / 分段标签 / 按钮与确认文案随 UI 语言）。构造函数是纯函数、
 * 显式收 locale 实参（scheduler widget 臂同款）；本文件断言中文文案，故固定传 zh-CN——
 * 不依赖进程环境（readUiLocale 的 env 与 ui-preferences.json 读取）。
 */
const LOCALE: UiLocale = "zh-CN";

/** subagent 托盘 widget 构造（中文文案 locale 固定）。 */
function subagentWidget(records: readonly SubagentRecord[]): ReturnType<typeof buildSubagentTrayWidget> {
  return buildSubagentTrayWidget(records, LOCALE);
}

/** workflow 托盘 widget 构造（中文文案 locale 固定）。 */
function workflowWidget(runs: readonly WorkflowRun[]): ReturnType<typeof buildWorkflowTrayWidget> {
  return buildWorkflowTrayWidget(runs, LOCALE);
}

/** action-bar item 声明形状（协议 action-bar items 元素；协议包不导出该别名，消费方本地定义——Actionbar.vue 同款）。 */
type ActionBarItem = GuiComponentProps["action-bar"]["items"][number];

/** record fixture（字段见 core assembly/types.ts SubagentRecord；与 gui/__tests__/tray-widget.test 同源）。 */
function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "rec-1",
    agent: "worker",
    task: "do the thing",
    slug: "thing",
    status: "idle",
    mode: "sync",
    startedAt: 1000,
    endedAt: 2000,
    rootSessionId: undefined,
    parentRecordId: undefined,
    depth: 0,
    turns: 1,
    totalTokens: 10,
    model: "test/model",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: "ok",
    error: undefined,
    sessionFile: undefined,
    ...over,
  } as SubagentRecord;
}

/** failed record fixture：失败轮（failedRoundOf 命中——failure 存在且非 user.cancelled）。 */
function makeFailedRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return makeRecord({
    id: "rec-fail",
    agent: "reviewer",
    slug: "rev",
    task: "审一遍 PR #123",
    status: "idle",
    stopReason: "error",
    lastRound: {
      engineStopReason: "error",
      failure: { class: "provider", kind: "rate_limited", retryable: "conditional", raw: "rpm 101/100" },
    },
    ...over,
  });
}

/** run fixture（真聚合根 WorkflowRun.reconstruct——与 workflow-tray-widget.test 同源）。 */
function makeRun(opts: {
  runId: string;
  scriptName: string;
  status: "running" | "done";
  reason?: DoneReason;
  slug?: string;
  interrupted?: boolean;
  calls?: Array<{ settled: boolean; failed?: boolean }>;
}): WorkflowRun {
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

/** tab-bar 树的段组件清单（sections[i]——段 = 子树数组）。 */
function segmentComponents(component: GuiComponent, index: number): GuiComponent[] {
  expect(component.type).toBe("tab-bar");
  const sections = (component.props as { sections?: GuiComponent[][] }).sections ?? [];
  return sections[index] ?? [];
}

/** 段内行集（D8 富行形态：段 = 每行一棵单行 list-tree）。 */
function segmentItems(component: GuiComponent, index: number): TreeItem[] {
  return segmentComponents(component, index)
    .filter((c) => c.type === "list-tree")
    .flatMap((c) => (c.props as { items: TreeItem[] }).items);
}

/** 行内操作槽 items 展平（D8：按钮挂行 TreeItem.actions——段内全部行的 actions 集合；
 *  段内零按钮 = 空数组，无独立 action-bar 兄弟块）。 */
function segmentActionItems(component: GuiComponent, index: number): ActionBarItem[] {
  return segmentItems(component, index).flatMap((item) => item.actions ?? []);
}

/** 行 action 的 hostAction 提取（「查看」入口——导航声明不随按钮增删而变化）。 */
function rowHostAction(item: TreeItem): HostContainerAction | undefined {
  return item.action?.hostAction;
}

beforeEach(() => {
  setWidgetDualMock.mockReset();
});

describe("buildSubagentTrayWidget 行内操作按钮（M3，使用者视角）", () => {
  it("running 行取消按钮：commandId=taiji.subagentCancel + args.recordId + danger 档 + confirm「确认取消？」", () => {
    const widget = subagentWidget([
      makeRecord({ id: "rec-run", agent: "reviewer", slug: "rev", status: "running", stopReason: undefined }),
    ]);
    const runningItems = segmentItems(widget!.gui.component, 0);
    expect(runningItems).toHaveLength(1);
    expect(segmentActionItems(widget!.gui.component, 0)).toEqual([
      {
        id: "cancel-rec-run",
        label: "取消",
        kind: "danger",
        commandId: "taiji.subagentCancel",
        args: { recordId: "rec-run" },
        confirm: "确认取消？",
      },
    ]);
    // 行本身仍是「查看」入口（导航声明与按钮并存，两条执行路径互斥）
    expect(rowHostAction(runningItems[0])).toEqual({
      kind: "drawer",
      tabId: "ui.subagent",
      params: { recordId: "rec-run" },
    });
  });

  it("failed 行重试按钮：commandId=taiji.subagentRetry + args={slug, task}（任务原文在场）；无 danger/confirm", () => {
    const widget = subagentWidget([makeFailedRecord()]);
    const endedItems = segmentItems(widget!.gui.component, 1);
    expect(endedItems).toHaveLength(1);
    const items = segmentActionItems(widget!.gui.component, 1);
    expect(items).toEqual([
      {
        id: "retry-rec-fail",
        label: "重试",
        commandId: "taiji.subagentRetry",
        args: { slug: "rev", task: "审一遍 PR #123" },
      },
    ]);
    // 重试是重派发（天然可恢复，D5 判定表）——不声明危险档与确认闸
    expect(items[0].kind).toBeUndefined();
    expect(items[0].confirm).toBeUndefined();
  });

  it("failed 行无任务原文（task 空串）→ 不渲染重试按钮，行无 actions 字段（「查看」入口在场）", () => {
    const widget = subagentWidget([makeFailedRecord({ id: "rec-fail-notask", task: "" })]);
    const endedItems = segmentItems(widget!.gui.component, 1);
    expect(endedItems).toHaveLength(1);
    expect(segmentActionItems(widget!.gui.component, 1)).toEqual([]);
    // 降级不行内操作 = 查看入口仍在（行可点开对话流，不是不可达行）
    expect(rowHostAction(endedItems[0])).toEqual({
      kind: "drawer",
      tabId: "ui.subagent",
      params: { recordId: "rec-fail-notask" },
    });
  });

  it("failed 行 slug 兜底空串（磁盘重建源旧文件缺失，类型契约明示的合法形态）→ 不渲染重试按钮，行无 actions 字段", () => {
    // slug 空串是契约明示合法形态（core assembly/types.ts「磁盘重建源旧文件可能缺失→
    // 兜底空串」）：retry args 原样携带 slug，宿主 hostStringArg 对空串 throw（点击必失败，
    // 且 toast 把数据缺失误报成扩展声明缺失）→ 行级降级不渲染，与 task 空串同款。
    const widget = subagentWidget([makeFailedRecord({ id: "rec-fail-noslug", slug: "" })]);
    const endedItems = segmentItems(widget!.gui.component, 1);
    expect(endedItems).toHaveLength(1);
    expect(segmentActionItems(widget!.gui.component, 1)).toEqual([]);
    expect(rowHostAction(endedItems[0])).toEqual({
      kind: "drawer",
      tabId: "ui.subagent",
      params: { recordId: "rec-fail-noslug" },
    });
  });

  it("failed 行 task 与 slug 均在场 → 渲染重试按钮（判据收紧不误伤正常行）", () => {
    const widget = subagentWidget([makeFailedRecord({ id: "rec-fail-both", slug: "rev-both", task: "两份都在场" })]);
    expect(segmentActionItems(widget!.gui.component, 1)).toEqual([
      {
        id: "retry-rec-fail-both",
        label: "重试",
        commandId: "taiji.subagentRetry",
        args: { slug: "rev-both", task: "两份都在场" },
      },
    ]);
  });

  it("user.cancelled 行（主动中止非失败，failedRoundOf 排除）→ 无行内操作按钮", () => {
    const widget = subagentWidget([
      makeRecord({
        id: "rec-cancel",
        status: "idle",
        stopReason: "aborted",
        lastRound: {
          engineStopReason: "aborted",
          failure: { class: "user", kind: "cancelled", retryable: false, raw: "user aborted" },
        },
      }),
    ]);
    expect(segmentItems(widget!.gui.component, 1)).toHaveLength(1);
    expect(segmentActionItems(widget!.gui.component, 1)).toEqual([]);
  });

  it("正常收尾行 → 无行内操作按钮", () => {
    const widget = subagentWidget([makeRecord({ id: "rec-done", status: "idle" })]);
    expect(segmentItems(widget!.gui.component, 1)).toHaveLength(1);
    expect(segmentActionItems(widget!.gui.component, 1)).toEqual([]);
  });

  it("段结构（观察者）：D8 富行——段为纯 list-tree 序列；按钮挂行 actions（有按钮行 actions 在场、无按钮行无该字段）", () => {
    const widget = subagentWidget([
      makeRecord({ id: "rec-run", agent: "reviewer", slug: "rev", status: "running", stopReason: undefined }),
      makeFailedRecord({ id: "rec-fail" }),
      makeRecord({ id: "rec-done", agent: "worker", slug: "wrk", status: "idle" }),
    ]);
    // 两段都无独立 action-bar 兄弟块（AX3：行内操作由协议字段承载，禁止兄弟组件模拟）
    for (const index of [0, 1]) {
      expect(segmentComponents(widget!.gui.component, index).map((c) => c.type)).toEqual(
        Array(segmentComponents(widget!.gui.component, index).length).fill("list-tree"),
      );
    }
    const runningRow = segmentItems(widget!.gui.component, 0)[0];
    const failedRow = segmentItems(widget!.gui.component, 1)[0];
    const doneRow = segmentItems(widget!.gui.component, 1)[1];
    expect(runningRow.actions?.map((i) => i.id)).toEqual(["cancel-rec-run"]);
    expect(failedRow.actions?.map((i) => i.id)).toEqual(["retry-rec-fail"]);
    expect(doneRow).not.toHaveProperty("actions");
  });

  it("同段多 failed 行：按钮 id 逐行唯一（cancel-/retry-<recordId>，同段多行不串台）", () => {
    const widget = subagentWidget([
      makeFailedRecord({ id: "rec-fail-a", slug: "rev-a" }),
      makeFailedRecord({ id: "rec-fail-b", slug: "rev-b", task: "第二个任务" }),
    ]);
    expect(segmentActionItems(widget!.gui.component, 1).map((i) => i.id)).toEqual([
      "retry-rec-fail-a",
      "retry-rec-fail-b",
    ]);
    expect(segmentActionItems(widget!.gui.component, 1).map((i) => i.args)).toEqual([
      { slug: "rev-a", task: "审一遍 PR #123" },
      { slug: "rev-b", task: "第二个任务" },
    ]);
  });

  it("按钮声明只走 commandId 路径（不声明 hostAction——行内操作不经容器导航，与行 action 两条路径互斥）", () => {
    const widget = subagentWidget([
      makeRecord({ id: "rec-run", status: "running", stopReason: undefined }),
      makeFailedRecord({ id: "rec-fail" }),
    ]);
    for (const segment of [0, 1]) {
      for (const item of segmentActionItems(widget!.gui.component, segment)) {
        expect(item.hostAction).toBeUndefined();
        expect(typeof item.commandId).toBe("string");
      }
    }
  });
});

describe("buildWorkflowTrayWidget 行内操作按钮（M3，使用者视角）", () => {
  it("running 行中止按钮：commandId=taiji.workflowAbort + args.runId + danger 档 + confirm「确认中止？」（abort 不可恢复必须带确认）", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-live", scriptName: "build", slug: "ci", status: "running", calls: [{ settled: false }] }),
    ]);
    expect(segmentItems(widget!.gui.component, 0)).toHaveLength(1);
    expect(segmentActionItems(widget!.gui.component, 0)).toEqual([
      {
        id: "abort-wf-run-live",
        label: "中止",
        kind: "danger",
        commandId: "taiji.workflowAbort",
        args: { runId: "wf-run-live" },
        confirm: "确认中止？",
      },
    ]);
  });

  it("interrupted 行续跑按钮：commandId=taiji.workflowResume + args.runId（恢复操作本体，无 danger/confirm）", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-halt", scriptName: "halt", status: "running", interrupted: true }),
    ]);
    const endedItems = segmentItems(widget!.gui.component, 1);
    expect(endedItems).toHaveLength(1);
    const items = segmentActionItems(widget!.gui.component, 1);
    expect(items).toEqual([
      {
        id: "resume-wf-run-halt",
        label: "续跑",
        commandId: "taiji.workflowResume",
        args: { runId: "wf-run-halt" },
      },
    ]);
    expect(items[0].kind).toBeUndefined();
    expect(items[0].confirm).toBeUndefined();
  });

  it("终局行（done/failed）→ 无行内操作按钮（abort-only 无 pause/resume；workflow 无重派发通道，AX5）", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-ok", scriptName: "ok", status: "done", reason: "completed" }),
      makeRun({ runId: "wf-run-boom", scriptName: "boom", status: "done", reason: "failed" }),
    ]);
    expect(segmentItems(widget!.gui.component, 1)).toHaveLength(2);
    expect(segmentActionItems(widget!.gui.component, 1)).toEqual([]);
    for (const item of segmentItems(widget!.gui.component, 1)) {
      expect(item).not.toHaveProperty("actions");
    }
  });

  it("段结构（观察者）：D8 富行——段为纯 list-tree 序列；abort/resume 挂行 actions（无独立 action-bar 兄弟块）", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-live", scriptName: "build", status: "running", calls: [{ settled: false }] }),
      makeRun({ runId: "wf-run-halt", scriptName: "halt", status: "running", interrupted: true }),
    ]);
    for (const index of [0, 1]) {
      expect(segmentComponents(widget!.gui.component, index).map((c) => c.type)).toEqual(["list-tree"]);
    }
    expect(segmentItems(widget!.gui.component, 0)[0].actions?.map((i) => i.id)).toEqual(["abort-wf-run-live"]);
    expect(segmentItems(widget!.gui.component, 1)[0].actions?.map((i) => i.id)).toEqual(["resume-wf-run-halt"]);
  });

  it("行 hostAction（查看入口）与行内按钮并存：导航声明不受按钮增删影响", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-live", scriptName: "build", status: "running", calls: [{ settled: false }] }),
    ]);
    expect(rowHostAction(segmentItems(widget!.gui.component, 0)[0])).toEqual({
      kind: "overlay",
      tabId: "ui.workflow",
      params: { runId: "wf-run-live" },
    });
  });
});
