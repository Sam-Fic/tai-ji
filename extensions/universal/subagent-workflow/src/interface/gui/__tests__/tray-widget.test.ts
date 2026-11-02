// tray-widget.test.ts —— subagent 托盘件 widget 树构造 + 推送器（容器扩展点统一 §6.6 U9 层 1）。
//
// 三视角：
//   ①使用者（宿主 widget 区视角）——树形状：meta head（title/status/progress/icon/badge）
//     + tab-bar 双段（进行中/已结束）行集（M3 起段内逐行「list-tree + action-bar」对）；
//     失败轮行 label 承载 class.kind 失败分类且
//     status=failed（§6.6 风险②「lastRound.failure 不得静默丢弃」的单测承载——原宿主
//     托盘行的失败分类 chip 随件迁移，信息原语承载位 = TreeItem label + status 圆点）；
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks（依赖收窄：logger 防文件落盘；protocol 只 mock setWidgetDual 推送点，
//    guiComponent/guiResult 走真实现——树形状断言消费真实产物；core barrel 只留 service 可控点）──

const extensionLoggerMock = vi.hoisted(() => {
  // 稳定单例（模块内 getLogger(...) 的每次调用返回同一 mock 实例——断言才能取到写入）
  const instance = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: vi.fn(() => instance), instance };
});

const setWidgetDualMock = vi.hoisted(() => vi.fn());

const mockService = vi.hoisted(() => ({
  current: null as null | {
    queries: {
      collectRecords: ReturnType<typeof vi.fn>;
      onChange: ReturnType<typeof vi.fn>;
    };
  },
}));

vi.mock("@zhushanwen/pi-extension-logger", () => extensionLoggerMock);
vi.mock("@zhushanwen/pi-ext-guards", () => ({
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock("@zhushanwen/extension-protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhushanwen/extension-protocol")>();
  return { ...actual, setWidgetDual: setWidgetDualMock };
});
vi.mock("@zhushanwen/subagent-core", () => ({
  getSubagentService: () => mockService.current,
}));

import type { SubagentRecord } from "@zhushanwen/subagent-core";
import type { UiLocale } from "../../../i18n.ts";
import {
  SUBAGENT_TRAY_VIEW_ID,
  buildSubagentTrayWidget,
  createSubagentTrayWidgetPusher,
} from "../tray-widget.ts";

/**
 * 面板文案 locale（D9：标题 / 分段标签随 UI 语言）。构造函数是纯函数、显式收 locale
 * 实参（scheduler widget 臂同款）；本文件断言中文文案，故固定传 zh-CN——不依赖进程环境
 * （readUiLocale 的 env 与 ui-preferences.json 读取）。推送器路径的 locale 由推送时读取
 * 决定（en-US 缺省），其标题断言按该口径单独断言。
 */
const LOCALE: UiLocale = "zh-CN";

/** subagent 托盘 widget 构造（中文文案 locale 固定）。 */
function buildWidget(records: readonly SubagentRecord[]): ReturnType<typeof buildSubagentTrayWidget> {
  return buildSubagentTrayWidget(records, LOCALE);
}
import type { GuiComponent, HostContainerAction, TreeItem } from "@zhushanwen/extension-protocol";

/** record fixture（字段见 core assembly/types.ts SubagentRecord）。 */
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

/** tab-bar 树的段组件清单（sections[i]——段 = 子树数组）。 */
function segmentComponents(component: GuiComponent, index: number): GuiComponent[] {
  expect(component.type).toBe("tab-bar");
  const sections = (component.props as { sections?: GuiComponent[][] }).sections ?? [];
  return sections[index] ?? [];
}

/** 段内行集（M3 起段 = 逐行「list-tree 行 + action-bar 操作」对——展平段内全部
 *  list-tree 的 items，与 workflow-tray-widget.test / tray-widget-buttons.test 同口径）。 */
function segmentItems(component: GuiComponent, index: number): TreeItem[] {
  return segmentComponents(component, index)
    .filter((c) => c.type === "list-tree")
    .flatMap((c) => (c.props as { items: TreeItem[] }).items);
}

/** 行 action 的 hostAction 提取（行不可点 = action 缺省，断言处显式判 undefined）。 */
function rowHostAction(item: TreeItem): HostContainerAction | undefined {
  return item.action?.hostAction;
}

beforeEach(() => {
  setWidgetDualMock.mockReset();
  mockService.current = null;
});

describe("buildSubagentTrayWidget 树构造（纯函数）", () => {
  it("空记录 → undefined（宿主清屏语义——widget 区「清屏即消失」）", () => {
    expect(buildWidget([])).toBeUndefined();
  });

  it("meta head：title/icon/badge/progress（badge = 进行中数，icon 点名 bot）与状态点（running>0 → running）", () => {
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

  it("分桶：占用谓词命中行落进行中段，其余落已结束段；行 label = agent · slug", () => {
    const result = buildWidget([
      makeRecord({ id: "r-run", agent: "reviewer", slug: "rev", status: "running", stopReason: undefined }),
      makeRecord({ id: "r-end", agent: "worker", slug: "wrk", status: "idle" }),
    ]);
    expect(result?.gui.meta?.status).toBe("running");
    const runningItems = segmentItems(result!.gui.component, 0);
    const endedItems = segmentItems(result!.gui.component, 1);
    expect(runningItems).toEqual([
      {
        label: "reviewer · rev",
        status: "running",
        depth: 0,
        action: { hostAction: { kind: "drawer", tabId: "ui.subagent", params: { recordId: "r-run" } } },
      },
    ]);
    expect(endedItems).toEqual([
      {
        label: "worker · wrk",
        status: "done",
        depth: 0,
        action: { hostAction: { kind: "drawer", tabId: "ui.subagent", params: { recordId: "r-end" } } },
      },
    ]);
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

  it("失败分类承载（§6.6 风险②不静默丢弃）：失败轮行 label 含 class.kind 且 status=failed", () => {
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
    expect(endedItems[0].label).toContain("harness.turn_budget_exhausted");
    expect(endedItems[0].status).toBe("failed");
  });

  it("user.cancelled 是用户主动中止非失败：行不标 failed、label 不拼失败词、head 不落 failed", () => {
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
    expect(endedItems[0].label).toBe("worker · wrk");
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

  it("多行段逐行成对（M3 段结构）：首行无按钮 + 次行有按钮 → 段内 list-tree/action-bar 按行交替", () => {
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
    // 组件序列 = 逐行「list-tree 行 + action-bar（该行有按钮时）」对：首行收尾无按钮
    // 只推 list-tree，次行失败行带重试按钮——按钮挂次行之后（args 逐行承载，不串台）。
    expect(segmentComponents(component, 1).map((c) => c.type)).toEqual([
      "list-tree",
      "list-tree",
      "action-bar",
    ]);
    // 行集展平覆盖两行——旧「段取首项」断言只能看到首行，次行的段结构回归被掩盖。
    expect(segmentItems(component, 1)).toHaveLength(2);
    const actionItems = (
      segmentComponents(component, 1)[2].props as {
        items: Array<{ id: string; label: string; commandId: string; args: Record<string, unknown> }>;
      }
    ).items;
    expect(actionItems).toEqual([
      {
        id: "retry-r-fail",
        label: "重试",
        commandId: "taiji.subagentRetry",
        args: { slug: "rev", task: "do the thing" },
      },
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

  afterEach(() => {
    // 微任务排空：scheduleFlush 的 queueMicrotask 不跨用例泄漏
  });

  it("attach → 初始推送（collectRecords 磁盘重建覆盖冷读）+ onChange 订阅；有记录推树、空记录推清屏", async () => {
    const { collect, onChange } = wireService([makeRecord({ id: "r1", status: "running", stopReason: undefined })]);
    const pusher = createSubagentTrayWidgetPusher();
    pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0]);
    await vi.waitFor(() => expect(setWidgetDualMock).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalled();
    // 推送键 = SUBAGENT_TRAY_VIEW_ID；内容 = 树（meta 在场）
    expect(setWidgetDualMock.mock.calls[0][1]).toBe(SUBAGENT_TRAY_VIEW_ID);
    expect(setWidgetDualMock.mock.calls[0][2]?.gui.meta?.title).toBe("Subagents");

    // 记录清空后的重推 = 清屏（第二参数 undefined）
    collect.mockReturnValue([]);
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    await vi.waitFor(() => expect(setWidgetDualMock).toHaveBeenCalledTimes(2));
    expect(setWidgetDualMock.mock.calls[1][2]).toBeUndefined();
  });

  it("同 tick 多次 onChange 合并为一次推送（微任务边界合并，无 timer）", async () => {
    const { listeners, onChange } = wireService([makeRecord()]);
    const pusher = createSubagentTrayWidgetPusher();
    pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0]);
    await vi.waitFor(() => expect(setWidgetDualMock).toHaveBeenCalledTimes(1));

    // 连续触发三次（core 写链单 tick 多迁移的形态）：合并为一次重推
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    for (const listener of Array.from(onChange.mock.calls, (call) => call[0])) listener();
    await Promise.resolve();
    await Promise.resolve();
    expect(setWidgetDualMock).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
  });

  it("detach → 退订 + 通道静默（session 终结后不推帧）", async () => {
    const { listeners } = wireService([makeRecord()]);
    const pusher = createSubagentTrayWidgetPusher();
    pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0]);
    await vi.waitFor(() => expect(setWidgetDualMock).toHaveBeenCalledTimes(1));

    pusher.detach();
    expect(listeners.size).toBe(0);
    setWidgetDualMock.mockClear();
    // 退订后无事件路径可达推送；本用例断言 detach 后通道静默（重新 attach 才恢复）
    expect(setWidgetDualMock).not.toHaveBeenCalled();
  });

  it("service 缺席（session 装配链前的异常时序）→ no-op 不抛错", async () => {
    mockService.current = null;
    const pusher = createSubagentTrayWidgetPusher();
    expect(() => pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0])).not.toThrow();
    await Promise.resolve();
    // collectRecords 不可达 → 投影按空记录处理 → 推清屏（不虚亮）
    await vi.waitFor(() => expect(setWidgetDualMock).toHaveBeenCalledTimes(1));
    expect(setWidgetDualMock.mock.calls[0][2]).toBeUndefined();
  });

  it("推送异常不反噬（warn 首败留痕后继续，下一事件重推）", async () => {
    wireService([makeRecord()]);
    setWidgetDualMock.mockImplementationOnce(() => {
      throw new Error("ctx dead");
    });
    const pusher = createSubagentTrayWidgetPusher();
    expect(() => pusher.attach(makeCtx() as Parameters<typeof pusher.attach>[0])).not.toThrow();
    await vi.waitFor(() => {
      expect(extensionLoggerMock.instance.warn).toHaveBeenCalled();
    });
  });
});
