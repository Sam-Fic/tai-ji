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

import { beforeEach, describe, expect, it } from "vitest";

// ── 共用 fixture 单点（tray-widget-test-fixtures：mock 注册 / record fixture / 树解包辅助；
//    workflow-run-fixture：WorkflowRun 真聚合根 fixture）──
// subagent-core 走真实现（runSummary 真派生视图），与 workflow-tray-widget.test 同口径——
// 本文件只测 build* 纯函数，不装推送器，无需可控 service（分工见 fixtures 头注释）。

import {
  TRAY_TEST_LOCALE,
  expectSegmentsAllListTree,
  makeFailedRecord,
  makeRecord,
  rowHostAction,
  segmentActionItems,
  segmentItems,
  trayWidgetMocks,
} from "./tray-widget-test-fixtures.ts";
import { makeRun } from "./workflow-run-fixture.ts";

import type { SubagentRecord, WorkflowRun } from "@zhushanwen/subagent-core";
import { buildSubagentTrayWidget } from "../interface/gui/tray-widget.ts";
import { buildWorkflowTrayWidget } from "../interface/gui/workflow-tray-widget.ts";

/** subagent 托盘 widget 构造（中文文案 locale 固定）。 */
function subagentWidget(records: readonly SubagentRecord[]): ReturnType<typeof buildSubagentTrayWidget> {
  return buildSubagentTrayWidget(records, TRAY_TEST_LOCALE);
}

/** workflow 托盘 widget 构造（中文文案 locale 固定）。 */
function workflowWidget(runs: readonly WorkflowRun[]): ReturnType<typeof buildWorkflowTrayWidget> {
  return buildWorkflowTrayWidget(runs, TRAY_TEST_LOCALE);
}

beforeEach(() => {
  trayWidgetMocks.setWidgetDual.mockReset();
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
    expectSegmentsAllListTree(widget!.gui.component);
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
    // 段结构（观察者）：D8 富行——段为纯 list-tree 序列；abort/resume 挂行 actions（无独立 action-bar 兄弟块）
    expectSegmentsAllListTree(widget!.gui.component);
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
