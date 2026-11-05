// workflow-tray-widget.test.ts —— workflow 托盘件 widget 树构造 + 推送器（容器扩展点
// 统一 §6.6 U10 层 1）。
//
// 三视角（与 subagent 件 tray-widget.test 同族）：
//   ①使用者（宿主 widget 区视角）——树形状：meta head（title/status/progress/icon/badge）
//     + tab-bar 双段（进行中/已结束）行集（composer-tray-protocol D8 富行形态：行信息按
//     协议字段承载——run 名→label / slug→subLabel / 成员进度 N/M→subLabel，中止/续跑挂
//     行内 actions 槽，不再推兄弟 action-bar 块；interrupted 经 statusLabel 覆盖字表达
//     「已中断（可续跑）」——三值枚举装不下的语义，D3/D8）；树形对账用例锁定旧 label
//     拼接信息逐项映射到新字段不丢（RL5）；interrupted 落已结束段（无活体暂停态不算
//     进行中，原宿主 [D2] 裁决同口径）且行无圆点 pause 图标；badge/progress.label =
//     running>0 才推（demo v3 角标规则），progress.current/total 恒保留；
//     行 action.hostAction 声明（M2 入口复活：overlay → ui.workflow + params.runId，逐行取
//     该行 run.runId——workflow 可视化的第一用户入口，G3 零入口问题的单测承载）；
//     text 臂（TUI）自行组装完整拼接文本 `[state] name · slug · N/M`——GUI 拆字段后
//     TUI 与 GUI 信息量等价（D8 TUI 文本臂语义）；
//   ②构建者——空 runs 清屏（undefined）/ 推送器 attach 初始推送 + notifyRunsChanged
//     变更驱动重推（微任务合并）+ detach 停推；readRuns 抛错按清屏投影不反噬调用方。
//   ②b restore 冷读收敛（[fix-tray-restore]）——内存投影空时磁盘折叠补装（每 attach
//     一次预算）后重读投影：重建产物含 interrupted 行（已结束段 + 行内续跑 actions +
//     statusLabel 覆盖字）；折叠无新增/抛错按清屏继续；内存非空不触发折叠（正常路径
//     零磁盘 IO）；attach 复位预算。
//   ③观察者——纯函数入参出参；推送失败 warn 留痕后继续（绝对投影，下一事件自愈）。
//
// WorkflowRun fixture 用真聚合根（WorkflowRun.reconstruct——runSummary/calls 派生消费
// 真字段；终局事实经 noteRebuiltSettlement 注入注册表，与 tool-workflow.test 同款夹具）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── 共用 fixture 单点（tray-widget-test-fixtures：mock 注册 / 树解包辅助；
//    workflow-run-fixture：WorkflowRun 真聚合根 fixture）——mock 收窄：logger 防文件落盘；
//    protocol 只 mock setWidgetDual 推送点，guiComponent/guiResult/runSummary 走真实现——
//    树形状断言消费真实产物 ──

import {
  TRAY_TEST_LOCALE,
  rowHostAction,
  segmentItems,
  trayWidgetMocks,
} from "./tray-widget-test-fixtures.ts";
import { makeRun } from "./workflow-run-fixture.ts";

import { WorkflowRun } from "@zhushanwen/subagent-core";
import { runSummary } from "@zhushanwen/subagent-core";
import {
  WORKFLOW_TRAY_VIEW_ID,
  buildWorkflowTrayWidget,
  createWorkflowTrayWidgetPusher,
} from "../interface/gui/workflow-tray-widget.ts";

/** workflow 托盘 widget 构造（中文文案 locale 固定）。 */
function workflowWidget(runs: readonly WorkflowRun[]): ReturnType<typeof buildWorkflowTrayWidget> {
  return buildWorkflowTrayWidget(runs, TRAY_TEST_LOCALE);
}

/** 微任务清空（push 异步化的折叠 await 链：微任务边界数轮冲刷后断言）。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

beforeEach(() => {
  trayWidgetMocks.setWidgetDual.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildWorkflowTrayWidget —— 树构造（使用者视角）", () => {
  it("running run → 进行中段 1 行（status=running），meta status=running + badge 计数", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-1", scriptName: "build", slug: "ci", status: "running", calls: [{ settled: false }] }),
    ]);
    expect(widget).toBeDefined();
    const comp = widget!.gui.component;
    expect(comp.type).toBe("tab-bar");
    const tabs = (comp.props as { tabs: Array<{ label: string }> }).tabs;
    expect(tabs[0].label).toBe("进行中 1");
    expect(tabs[1].label).toBe("已结束 0");
    const running = segmentItems(comp, 0);
    expect(running).toHaveLength(1);
    expect(running[0].status).toBe("running");
    expect(running[0].icon).toBe("circle");
    // meta head：标题/状态点/进度/icon/badge（宿主壳层唯一渲染 head）；标题随 locale（D9）
    const meta = widget!.gui.meta;
    expect(meta.title).toBe("工作流");
    expect(meta.status).toBe("running");
    expect(meta.badge).toBe("1");
    expect(meta.icon).toBe("workflow");
    expect(meta.progress).toEqual({ current: 1, total: 1, label: "1" });
  });

  it("树形对账（RL5）：旧 label 拼接信息逐项映射到新字段——run 名→label / slug→subLabel / 成员进度→subLabel，逐项不丢", () => {
    const widget = workflowWidget([
      makeRun({
        runId: "wf-run-2",
        scriptName: "ship",
        slug: "v2",
        status: "running",
        calls: [{ settled: true }, { settled: true }, { settled: false }],
      }),
    ]);
    const running = segmentItems(widget!.gui.component, 0);
    // 逐项对账（旧单行拼接 `ship · v2 · 2/3` 的信息全集）
    expect(running[0].label).toBe("ship");
    expect(running[0].subLabel).toBe("v2 · 2/3");
  });

  it("done(completed) run → 已结束段（status=done）；interrupted run 落已结束段、pause 图标 + statusLabel 覆盖字（D3/D8，RL5）", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-3", scriptName: "ok", status: "done", reason: "completed" }),
      makeRun({ runId: "wf-run-4", scriptName: "halt", status: "running", interrupted: true }),
    ]);
    const ended = segmentItems(widget!.gui.component, 1);
    expect(ended).toHaveLength(2);
    expect(ended[0].status).toBe("done");
    expect(ended[0].statusLabel).toBeUndefined();
    // interrupted：无圆点（不作成败断言）+ pause 图标 + statusLabel 覆盖字（三值枚举
    // 装不下的特殊语义——渲染序 = statusLabel ?? 宿主枚举映射，宿主侧无枚举可映射）
    expect(ended[1].status).toBeUndefined();
    expect(ended[1].icon).toBe("pause");
    expect(ended[1].statusLabel).toBe("已中断（可续跑）");
  });

  it("running/done 行不推 statusLabel（覆盖字只承载枚举外语义——三值枚举行走宿主 i18n 映射档）", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-live", scriptName: "build", status: "running", calls: [{ settled: false }] }),
      makeRun({ runId: "wf-run-ok", scriptName: "ok", status: "done", reason: "completed" }),
    ]);
    expect(segmentItems(widget!.gui.component, 0)[0].statusLabel).toBeUndefined();
    expect(segmentItems(widget!.gui.component, 1)[0].statusLabel).toBeUndefined();
  });

  it("failed 终局 → 行 status=failed + meta status=failed（失败可见不吞）", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-5", scriptName: "boom", status: "done", reason: "failed" }),
    ]);
    const ended = segmentItems(widget!.gui.component, 1);
    expect(ended[0].status).toBe("failed");
    expect(widget!.gui.meta.status).toBe("failed");
  });

  it("badge 条件（demo v3 角标规则，RL5）：running=0 → badge 与 progress.label 双缺省、progress.current/total 恒保留", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-ok", scriptName: "ok", status: "done", reason: "completed" }),
      makeRun({ runId: "wf-run-halt", scriptName: "halt", status: "running", interrupted: true }),
    ]);
    const meta = widget!.gui.meta;
    expect(meta.status).toBe("done");
    expect(meta).not.toHaveProperty("badge");
    expect(meta.progress).toEqual({ current: 0, total: 2 });
  });

  it("空 runs → undefined（清屏语义；调用方推 setWidgetDual(…, undefined)）", () => {
    expect(workflowWidget([])).toBeUndefined();
  });

  it("行 action.hostAction：overlay → ui.workflow + params.runId = 该行 run.runId（M2 入口复活）", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-live", scriptName: "build", slug: "ci", status: "running", calls: [{ settled: false }] }),
      makeRun({ runId: "wf-run-done", scriptName: "ship", slug: "v2", status: "done", reason: "completed" }),
    ]);
    // 两段行同权可点（进行中与已结束都能打开该 run 的可视化浮层）；runId 逐行取该行 run.runId
    expect(rowHostAction(segmentItems(widget!.gui.component, 0)[0])).toEqual({
      kind: "overlay",
      tabId: "ui.workflow",
      params: { runId: "wf-run-live" },
    });
    expect(rowHostAction(segmentItems(widget!.gui.component, 1)[0])).toEqual({
      kind: "overlay",
      tabId: "ui.workflow",
      params: { runId: "wf-run-done" },
    });
    // 行 action 只声明导航、不声明 commandId（导航不经命令链，与 action-bar item 的两条路径互斥）
    for (const segment of [0, 1]) {
      for (const item of segmentItems(widget!.gui.component, segment)) {
        expect(item.action?.commandId).toBeUndefined();
      }
    }
  });

  it("text 臂（TUI 文本臂语义，RL5）：自行组装完整拼接文本 `[status] name · slug · N/M`——不随 GUI 字段拆分丢弃（含 slug 段）", () => {
    const widget = workflowWidget([
      makeRun({ runId: "wf-run-6", scriptName: "build", status: "running", slug: "ci" }),
    ]);
    expect(widget!.text).toEqual(["[running] build · ci · 0/0"]);
  });

  it("runSummary 派生视图单源（行状态 = core 三态投影，不经本地第二套判定）", () => {
    const run = makeRun({ runId: "wf-run-7", scriptName: "x", status: "running" });
    expect(runSummary(run).status).toBe("running");
    const widget = workflowWidget([run]);
    expect(segmentItems(widget!.gui.component, 0)[0].status).toBe("running");
  });
});

describe("createWorkflowTrayWidgetPusher —— 推送器（构建者视角）", () => {
  function makeCtx(): unknown {
    return { mode: "rpc", hasUI: true };
  }

  it("attach 初始推送（绝对投影）+ notifyRunsChanged 变更驱动重推（微任务合并）", async () => {
    let runs: WorkflowRun[] = [];
    const pusher = createWorkflowTrayWidgetPusher(() => runs);
    const ctx = makeCtx();

    pusher.attach(ctx as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(1);
    expect(trayWidgetMocks.setWidgetDual.mock.calls[0][1]).toBe(WORKFLOW_TRAY_VIEW_ID);
    expect(trayWidgetMocks.setWidgetDual.mock.calls[0][2]).toBeUndefined(); // 空集清屏

    // 变更信号：同一 tick 两次 notify 合并为一次推送（微任务边界）
    runs = [makeRun({ runId: "wf-run-8", scriptName: "build", status: "running" })];
    pusher.notifyRunsChanged();
    pusher.notifyRunsChanged();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(2);
    const pushed = trayWidgetMocks.setWidgetDual.mock.calls[1][2];
    expect(pushed).toBeDefined();
    expect(pushed.gui.component.type).toBe("tab-bar");

    // detach 后停推
    pusher.detach();
    pusher.notifyRunsChanged();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(2);
  });

  it("readRuns 抛错 → 按清屏投影 + warn 留痕，不反噬调用方", async () => {
    const pusher = createWorkflowTrayWidgetPusher(() => {
      throw new Error("session not assembled");
    });
    pusher.attach(makeCtx() as never);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledWith(
      expect.anything(),
      WORKFLOW_TRAY_VIEW_ID,
      undefined,
    );
    expect(trayWidgetMocks.instance.warn).toHaveBeenCalledWith(
      expect.stringContaining("runs read failed"),
    );
  });

  it("推送失败（setWidgetDual throw）→ warn 留痕不反噬 notifyRunsChanged 调用方", async () => {
    trayWidgetMocks.setWidgetDual.mockImplementation(() => {
      throw new Error("channel down");
    });
    const pusher = createWorkflowTrayWidgetPusher(() => [
      makeRun({ runId: "wf-run-9", scriptName: "build", status: "running" }),
    ]);
    pusher.attach(makeCtx() as never);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(trayWidgetMocks.instance.warn).toHaveBeenCalledWith(
      expect.stringContaining("widget push failed"),
    );
    // 第二次变更信号继续尝试（首败 warn 只记一次，重推不中断）
    trayWidgetMocks.setWidgetDual.mockImplementation(() => {});
    pusher.notifyRunsChanged();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(2);
  });
});

describe("createWorkflowTrayWidgetPusher —— 磁盘折叠冷读收敛（[fix-tray-restore] restore 场景锁定）", () => {
  function makeCtx(): unknown {
    return { mode: "rpc", hasUI: true };
  }

  it("restore 冷读收敛：内存投影空 → 磁盘折叠补装 → 初始推送即含重建产物（interrupted 行带续跑按钮）", async () => {
    // restore 形态：attach 时投影面尚未含恢复产物（readRuns 空），磁盘折叠源补装后重读。
    const runs: WorkflowRun[] = [];
    const rebuilt = [
      makeRun({ runId: "wf-restore-int", scriptName: "fanout-canary", slug: "canary", status: "running", interrupted: true }),
      makeRun({ runId: "wf-restore-done", scriptName: "older", status: "done", reason: "completed" }),
    ];
    const reloadFromDisk = vi.fn(async () => {
      runs.push(...rebuilt);
      return true;
    });
    const pusher = createWorkflowTrayWidgetPusher(() => runs, { reloadFromDisk });

    pusher.attach(makeCtx() as never);
    await flushMicrotasks();

    expect(reloadFromDisk).toHaveBeenCalledTimes(1);
    expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(1);
    const pushed = trayWidgetMocks.setWidgetDual.mock.calls[0]![2];
    expect(pushed).toBeDefined();
    // interrupted 重建行落已结束段：富行字段（label 主名 / subLabel 副文本）+ statusLabel
    // 覆盖字 + 行内续跑 actions（任务书目标 1 的投影形态；推送器路径 locale = readUiLocale
    // 回落 en-US——与 subagent 件推送器路径断言同口径）
    const ended = segmentItems(pushed.gui.component, 1);
    const interruptedRow = ended.find((item) => item.label === "fanout-canary");
    expect(interruptedRow).toBeDefined();
    expect(interruptedRow!.subLabel).toBe("canary · 0/0");
    expect(interruptedRow!.statusLabel).toBe("Interrupted (resumable)");
    const resume = interruptedRow!.actions?.find((item) => item.id === "resume-wf-restore-int");
    expect(resume).toBeDefined();
    expect(resume!.label).toBe("Resume");
    expect(resume!.commandId).toBe("taiji.workflowResume");
  });

  it("磁盘折叠无新增（返回 false）→ 按空投影清屏；预算一次性（后续空投影不再触发 reload）", async () => {
    const reloadFromDisk = vi.fn(async () => false);
    const pusher = createWorkflowTrayWidgetPusher(() => [], { reloadFromDisk });

    pusher.attach(makeCtx() as never);
    await flushMicrotasks();
    expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledWith(expect.anything(), WORKFLOW_TRAY_VIEW_ID, undefined);

    // 变更信号驱动的空投影重推不再触发第二次折叠（真无 run 的 session 不重复付磁盘读成本）
    pusher.notifyRunsChanged();
    await flushMicrotasks();
    expect(reloadFromDisk).toHaveBeenCalledTimes(1);
    expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(2);
  });

  it("内存投影非空 → 不触发磁盘折叠（正常路径零磁盘 IO）", async () => {
    const reloadFromDisk = vi.fn(async () => false);
    const pusher = createWorkflowTrayWidgetPusher(
      () => [makeRun({ runId: "wf-live", scriptName: "build", status: "running" })],
      { reloadFromDisk },
    );

    pusher.attach(makeCtx() as never);
    await flushMicrotasks();

    expect(reloadFromDisk).not.toHaveBeenCalled();
    expect(trayWidgetMocks.setWidgetDual.mock.calls[0]![2]).toBeDefined();
  });

  it("detach 后重新 attach（切回 session）→ 折叠预算复位，重新触发一次 reload（RE3 切回即现）", async () => {
    const reloadFromDisk = vi.fn(async () => false);
    const pusher = createWorkflowTrayWidgetPusher(() => [], { reloadFromDisk });
    const ctx = makeCtx();

    pusher.attach(ctx as never);
    await flushMicrotasks();
    expect(reloadFromDisk).toHaveBeenCalledTimes(1);

    pusher.detach();
    pusher.attach(ctx as never);
    await flushMicrotasks();
    expect(reloadFromDisk).toHaveBeenCalledTimes(2);
  });

  it("磁盘折叠抛错 → warn 留痕后按空投影清屏，不反噬推送链", async () => {
    const reloadFromDisk = vi.fn(async () => {
      throw new Error("record stream corrupted");
    });
    const pusher = createWorkflowTrayWidgetPusher(() => [], { reloadFromDisk });

    pusher.attach(makeCtx() as never);
    await flushMicrotasks();

    expect(trayWidgetMocks.instance.warn).toHaveBeenCalledWith(
      expect.stringContaining("disk reload failed"),
    );
    expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledWith(expect.anything(), WORKFLOW_TRAY_VIEW_ID, undefined);
  });

  it("折叠 await 间隙的并发 push 不推瞬态清屏帧（托盘条目不闪）", async () => {
    // 竞态锁定：attach 触发折叠后，await 间隙到达的并发 push 读到的仍是折叠前的空内存
    // 投影，且 diskReloadUsed 已置位使其跳过折叠 → 旧行为推 setWidgetDual(…, undefined)
    // 清屏帧，折叠发起方醒来后才被数据帧覆盖（托盘条目毫秒级闪失）。修复后中间帧直接
    // 丢弃：全程只推一帧，且是折叠完成后的最新投影。
    let releaseFold: () => void = () => {};
    const foldGate = new Promise<void>((resolve) => {
      releaseFold = resolve;
    });
    const runs: WorkflowRun[] = [];
    const reloadFromDisk = vi.fn(async () => {
      await foldGate;
      runs.push(makeRun({ runId: "wf-fold-race", scriptName: "build", status: "running" }));
      return true;
    });
    const pusher = createWorkflowTrayWidgetPusher(() => runs, { reloadFromDisk });

    pusher.attach(makeCtx() as never);
    // 让 push 走到 await reloadFromDisk()（折叠单飞已置位，磁盘折叠尚未返回）
    await Promise.resolve();

    // 折叠进行中的并发变更信号：不产生任何推送帧
    pusher.notifyRunsChanged();
    await flushMicrotasks();
    expect(trayWidgetMocks.setWidgetDual).not.toHaveBeenCalled();

    // 折叠完成后：恰好一帧，且带最新投影（非清屏帧）
    releaseFold();
    await flushMicrotasks();
    expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(1);
    expect(trayWidgetMocks.setWidgetDual.mock.calls[0]![2]).toBeDefined();
  });
});
