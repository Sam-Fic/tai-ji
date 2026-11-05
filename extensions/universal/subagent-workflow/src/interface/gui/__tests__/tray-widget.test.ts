// tray-widget.test.ts —— subagent 托盘件 widget 树构造 + 推送器（容器扩展点统一 §6.6 U9 层 1）。
//
// 三视角：
//   ①使用者（宿主 widget 区视角）——树形状：meta head（title/status/progress/icon/badge）
//     + tab-bar 双段（进行中/已结束）行集（composer-tray-protocol D8 富行形态：行信息按
//     协议字段承载——agent 名→label / slug→subLabel / 失败分类→subLabel，取消/重试挂行内
//     actions 槽，不再推兄弟 action-bar 块）；
//     树形对账用例锁定旧 label 拼接信息逐项映射到新字段不丢（RL5：§6.6 风险②
//     「lastRound.failure 不得静默丢弃」——失败分类的原语承载位 = subLabel + status 圆点）；
//     text 臂（TUI）自行组装完整拼接文本 `[state] agent · slug · 失败分类`——GUI 拆字段
//     后 TUI 与 GUI 信息量等价（D8 TUI 文本臂语义）；
//     badge/progress.label 条件 = running>0 才推（demo v3 角标规则——红色 0 根因即推送侧
//     0 照推），progress.current/total 恒保留（面板 head 计数回落「0/2」）；
//     行 action.hostAction 声明（M2 入口复活：drawer → ui.subagent + params.recordId，
//     逐行取该行 record.id——AX2「面板交互能力与目标容器等价」的入口半边）；
//   ②构建者——分桶判据（占用谓词镜像）/ 空记录清屏 / 推送器 attach 初始推送 +
//     onChange 事件驱动重推（微任务合并）+ detach 退订；
//   ③观察者——纯函数入参出参；推送失败不反噬调用方（warn 留痕后继续）。
//
// 判据单点：本文件的占用/失败判据与 renderer lib/subagent-bucket 同源——判据本体
// 在 @zhushanwen/extension-protocol（extensions/subagent-projection/predicates.ts），
// 两侧 import 同一实现（[dmg-r1-4] 下沉，镜像手抄退役），词表扩值评估两侧同批
// （shared/core record 词表纪律不变）。

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks（依赖收窄：core barrel 只留 service 可控点——本文件私有面，不共用）；
//    logger / ext-guards / protocol 推送点的 mock 注册在共用 fixture 模块
//    tray-widget-test-fixtures（test 文件经 import 语义先于 SUT 装载注册）──

const mockService = vi.hoisted(() => ({
  current: null as null | {
    queries: {
      collectRecords: ReturnType<typeof vi.fn>;
      onChange: ReturnType<typeof vi.fn>;
    };
  },
}));

vi.mock("@zhushanwen/subagent-core", () => ({
  getSubagentService: () => mockService.current,
}));

import {
  TRAY_TEST_LOCALE,
  makeRecord,
  rowHostAction,
  segmentComponents,
  segmentItems,
  trayWidgetMocks,
} from "../../../__tests__/tray-widget-test-fixtures.ts";
import type { SubagentRecord } from "@zhushanwen/subagent-core";
import {
  SUBAGENT_TRAY_VIEW_ID,
  buildSubagentTrayWidget,
  createSubagentTrayWidgetPusher,
} from "../tray-widget.ts";

/** subagent 托盘 widget 构造（中文文案 locale 固定）。推送器路径的 locale 由推送时读取
 *  决定（en-US 缺省），其标题断言按该口径单独断言。 */
function buildWidget(records: readonly SubagentRecord[]): ReturnType<typeof buildSubagentTrayWidget> {
  return buildSubagentTrayWidget(records, TRAY_TEST_LOCALE);
}

beforeEach(() => {
  trayWidgetMocks.setWidgetDual.mockReset();
  mockService.current = null;
});

describe("buildSubagentTrayWidget 树构造（纯函数）", () => {
  it("空记录 → undefined（宿主清屏语义——widget 区「清屏即消失」）", () => {
    expect(buildWidget([])).toBeUndefined();
  });

  it("meta head（running>0 档）：badge/progress.label = 进行中数、progress.current/total 恒在场（icon 点名 bot）", () => {
    const result = buildWidget([
      makeRecord({ id: "r-run", status: "running", stopReason: undefined }),
      makeRecord({ id: "r-idle", status: "idle" }),
    ]);
    expect(result).toBeDefined();
    expect(result?.gui.meta).toMatchObject({
      title: "子代理",
      status: "running",
      icon: "bot",
      badge: "1",
      progress: { current: 1, total: 2, label: "1" },
    });
  });

  it("badge 条件（demo v3 角标规则，RL5）：running=0 → badge 与 progress.label 双缺省、progress.current/total 恒保留", () => {
    // 红色 0 根因 = 推送侧 0 照推 + 宿主无过滤；修复在推送侧（判定信号在语义所有方）——
    // 推送载荷里就不出现 badge/label 字段，非靠宿主渲染层过滤。
    const result = buildWidget([
      makeRecord({ id: "r-done-1", status: "idle" }),
      makeRecord({
        id: "r-fail",
        status: "idle",
        stopReason: "error",
        lastRound: {
          engineStopReason: "error",
          failure: { class: "provider", kind: "rate_limited", retryable: "conditional", raw: "rpm 101/100" },
        },
      }),
    ]);
    const meta = result?.gui.meta;
    expect(meta?.status).toBe("failed");
    expect(meta).not.toHaveProperty("badge");
    expect(meta?.progress).toEqual({ current: 0, total: 2 });
  });

  it("分桶：占用谓词命中行落进行中段，其余落已结束段；行信息按字段承载（agent→label / slug→subLabel）", () => {
    const result = buildWidget([
      makeRecord({ id: "r-run", agent: "reviewer", slug: "rev", status: "running", stopReason: undefined }),
      makeRecord({ id: "r-end", agent: "worker", slug: "wrk", status: "idle" }),
    ]);
    expect(result?.gui.meta?.status).toBe("running");
    const runningItems = segmentItems(result!.gui.component, 0);
    const endedItems = segmentItems(result!.gui.component, 1);
    expect(runningItems).toEqual([
      {
        label: "reviewer",
        status: "running",
        depth: 0,
        subLabel: "rev",
        actions: [
          {
            id: "cancel-r-run",
            label: "取消",
            kind: "danger",
            commandId: "taiji.subagentCancel",
            args: { recordId: "r-run" },
            confirm: "确认取消？",
          },
        ],
        action: { hostAction: { kind: "drawer", tabId: "ui.subagent", params: { recordId: "r-run" } } },
      },
    ]);
    expect(endedItems).toEqual([
      {
        label: "worker",
        status: "done",
        depth: 0,
        subLabel: "wrk",
        action: { hostAction: { kind: "drawer", tabId: "ui.subagent", params: { recordId: "r-end" } } },
      },
    ]);
  });

  it("slug 缺省（磁盘重建源旧文件兜底空串）→ 行无 subLabel 字段（不留空值分支）", () => {
    const result = buildWidget([makeRecord({ id: "r-noslug", slug: "", status: "idle" })]);
    const endedItems = segmentItems(result!.gui.component, 1);
    expect(endedItems[0].label).toBe("worker");
    expect(endedItems[0]).not.toHaveProperty("subLabel");
  });

  it("行 action.hostAction：drawer → ui.subagent + params.recordId = 该行 record.id（M2 入口复活）", () => {
    const result = buildWidget([
      makeRecord({ id: "rec-alpha", agent: "reviewer", slug: "rev", status: "running", stopReason: undefined }),
      makeRecord({ id: "rec-beta", agent: "worker", slug: "wrk", status: "idle" }),
    ]);
    // 两段行同权可点（进行中与已结束都能查看对话流）；recordId 逐行取该行 record.id
    expect(rowHostAction(segmentItems(result!.gui.component, 0)[0])).toEqual({
      kind: "drawer",
      tabId: "ui.subagent",
      params: { recordId: "rec-alpha" },
    });
    expect(rowHostAction(segmentItems(result!.gui.component, 1)[0])).toEqual({
      kind: "drawer",
      tabId: "ui.subagent",
      params: { recordId: "rec-beta" },
    });
    // 行 action 只声明导航、不声明 commandId（导航不经命令链，与 action-bar item 的两条路径互斥）
    for (const segment of [0, 1]) {
      for (const item of segmentItems(result!.gui.component, segment)) {
        expect(item.action?.commandId).toBeUndefined();
      }
    }
  });

  it("全部收尾 → status=done；失败轮在场 → status=failed（head 状态点反映最重事实）", () => {
    const clean = buildWidget([makeRecord({ id: "r1", status: "idle" })]);
    expect(clean?.gui.meta?.status).toBe("done");

    const failed = buildWidget([
      makeRecord({
        id: "r2",
        status: "idle",
        stopReason: "error",
        lastRound: {
          engineStopReason: "error",
          failure: { class: "provider", kind: "rate_limited", retryable: "conditional", raw: "rpm 101/100" },
        },
      }),
    ]);
    expect(failed?.gui.meta?.status).toBe("failed");
  });

  it("树形对账（RL5）：旧 label 拼接信息逐项映射到新字段——agent→label / slug→subLabel / 失败分类→subLabel，逐项不丢", () => {
    const result = buildWidget([
      makeRecord({
        id: "r-fail",
        agent: "reviewer",
        slug: "rev",
        status: "idle",
        stopReason: "aborted",
        lastRound: {
          engineStopReason: "aborted",
          failure: { class: "harness", kind: "turn_budget_exhausted", retryable: false, raw: "budget" },
        },
      }),
    ]);
    const endedItems = segmentItems(result!.gui.component, 1);
    expect(endedItems).toHaveLength(1);
    // 逐项对账（旧单行拼接 `reviewer · rev · harness.turn_budget_exhausted` 的信息全集）：
    expect(endedItems[0].label).toBe("reviewer");
    expect(endedItems[0].subLabel).toBe("rev · harness.turn_budget_exhausted");
    expect(endedItems[0].status).toBe("failed");
  });

  it("user.cancelled 是用户主动中止非失败：行不标 failed、subLabel 不拼失败词、head 不落 failed", () => {
    const result = buildWidget([
      makeRecord({
        id: "r-cancel",
        agent: "worker",
        slug: "wrk",
        status: "idle",
        stopReason: "aborted",
        lastRound: {
          engineStopReason: "aborted",
          failure: { class: "user", kind: "cancelled", retryable: false, raw: "user aborted" },
        },
      }),
    ]);
    const endedItems = segmentItems(result!.gui.component, 1);
    expect(endedItems[0].label).toBe("worker");
    expect(endedItems[0].subLabel).toBe("wrk");
    expect(endedItems[0].status).toBe("done");
    expect(result?.gui.meta?.status).toBe("done");
  });

  it("占用判据（protocol 单点）：running + 轮收条停因（stopReason 已写）落已结束段（「轮收条已写 = 本轮不在途」）", () => {
    const result = buildWidget([
      makeRecord({ id: "r-dead", status: "running", stopReason: "failed" }),
      makeRecord({ id: "r-live", status: "running", stopReason: undefined }),
    ]);
    expect(segmentItems(result!.gui.component, 0)).toHaveLength(1);
    expect(segmentItems(result!.gui.component, 1)).toHaveLength(1);
  });

  it("多行段富行形态（D8）：行内操作挂行 actions 槽——段为纯 list-tree 序列、无兄弟 action-bar 块", () => {
    const result = buildWidget([
      makeRecord({ id: "r-done", agent: "worker", slug: "done", status: "idle" }),
      makeRecord({
        id: "r-fail",
        agent: "reviewer",
        slug: "rev",
        status: "idle",
        stopReason: "error",
        lastRound: {
          engineStopReason: "error",
          failure: { class: "provider", kind: "rate_limited", retryable: "conditional", raw: "rpm 101/100" },
        },
      }),
    ]);
    const component = result!.gui.component;
    // 段结构 = 每行一棵 list-tree（富行），无独立 action-bar 兄弟块（AX3：行内操作槽
    // 由协议字段承载，禁止独立兄弟组件模拟）。
    expect(segmentComponents(component, 1).map((c) => c.type)).toEqual(["list-tree", "list-tree"]);
    expect(segmentItems(component, 1)).toHaveLength(2);
    // 重试按钮挂失败行的行内 actions（args 逐行承载，不串台）；收尾行无 actions 字段
    const failRow = segmentItems(component, 1)[1];
    expect(failRow.actions).toEqual([
      {
        id: "retry-r-fail",
        label: "重试",
        commandId: "taiji.subagentRetry",
        args: { slug: "rev", task: "do the thing" },
      },
    ]);
    expect(segmentItems(component, 1)[0]).not.toHaveProperty("actions");
  });

  it("text 臂（TUI 文本臂语义，RL5）：自行组装完整拼接文本——slug 与失败分类不随 GUI 字段拆分丢弃", () => {
    const result = buildWidget([
      makeRecord({ id: "r-run", agent: "reviewer", slug: "rev", status: "running", stopReason: undefined }),
      makeRecord({
        id: "r-fail",
        agent: "worker",
        slug: "wrk",
        status: "idle",
        stopReason: "error",
        lastRound: {
          engineStopReason: "error",
          failure: { class: "provider", kind: "rate_limited", retryable: "conditional", raw: "rpm 101/100" },
        },
      }),
      makeRecord({ id: "r-noslug", agent: "lone", slug: "", status: "idle" }),
    ]);
    // 每行 = `[state] agent · slug · 失败分类`（slug 缺省跳段）——TUI 与 GUI 信息量等价
    expect(result?.text).toEqual([
      "[running] reviewer · rev",
      "[failed] worker · wrk · provider.rate_limited",
      "[done] lone",
    ]);
  });
});

describe("createSubagentTrayWidgetPusher 推送器", () => {
  function makeCtx() {
    return { mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "s-1" } };
  }

  function wireService(records: SubagentRecord[]) {
    const listeners = new Set<() => void>();
    const collect = vi.fn(() => records);
    const onChange = vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    mockService.current = { queries: { collectRecords: collect, onChange } };
    return { listeners, collect, onChange };
  }

  it("attach → 初始推送（collectRecords 磁盘重建覆盖冷读）+ onChange 订阅；有记录推树、空记录推清屏", async () => {
    const { collect, onChange } = wireService([makeRecord({ id: "r1", status: "running", stopReason: undefined })]);
    const pusher = createSubagentTrayWidgetPusher();
    pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0]);
    await vi.waitFor(() => expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalled();
    // 推送键 = SUBAGENT_TRAY_VIEW_ID；内容 = 树（meta 在场）
    expect(trayWidgetMocks.setWidgetDual.mock.calls[0][1]).toBe(SUBAGENT_TRAY_VIEW_ID);
    expect(trayWidgetMocks.setWidgetDual.mock.calls[0][2]?.gui.meta?.title).toBe("Subagents");

    // 记录清空后的重推 = 清屏（第二参数 undefined）
    collect.mockReturnValue([]);
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    await vi.waitFor(() => expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(2));
    expect(trayWidgetMocks.setWidgetDual.mock.calls[1][2]).toBeUndefined();
  });

  it("同 tick 多次 onChange 合并为一次推送（微任务边界合并，无 timer）", async () => {
    const { listeners, onChange } = wireService([makeRecord()]);
    const pusher = createSubagentTrayWidgetPusher();
    pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0]);
    await vi.waitFor(() => expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(1));

    // 连续触发三次（core 写链单 tick 多迁移的形态）：合并为一次重推
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    await Promise.resolve();
    await Promise.resolve();
    expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
  });

  it("detach → 退订 + 通道静默（session 终结后不推帧）", async () => {
    const { listeners } = wireService([makeRecord()]);
    const pusher = createSubagentTrayWidgetPusher();
    pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0]);
    await vi.waitFor(() => expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(1));

    pusher.detach();
    expect(listeners.size).toBe(0);
    trayWidgetMocks.setWidgetDual.mockClear();
    // 退订后无事件路径可达推送；本用例断言 detach 后通道静默（重新 attach 才恢复）
    expect(trayWidgetMocks.setWidgetDual).not.toHaveBeenCalled();
  });

  it("service 缺席（session 装配链前的异常时序）→ no-op 不抛错", async () => {
    mockService.current = null;
    const pusher = createSubagentTrayWidgetPusher();
    expect(() => pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0])).not.toThrow();
    await Promise.resolve();
    // collectRecords 不可达 → 投影按空记录处理 → 推清屏（不虚亮）
    await vi.waitFor(() => expect(trayWidgetMocks.setWidgetDual).toHaveBeenCalledTimes(1));
    expect(trayWidgetMocks.setWidgetDual.mock.calls[0][2]).toBeUndefined();
  });

  it("推送异常不反噬（warn 首败留痕后继续，下一事件重推）", async () => {
    wireService([makeRecord()]);
    trayWidgetMocks.setWidgetDual.mockImplementationOnce(() => {
      throw new Error("ctx dead");
    });
    const pusher = createSubagentTrayWidgetPusher();
    expect(() => pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0])).not.toThrow();
    await vi.waitFor(() => {
      expect(trayWidgetMocks.instance.warn).toHaveBeenCalled();
    });
  });
});
