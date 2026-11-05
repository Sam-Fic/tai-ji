// tray-widget-test-fixtures.ts —— 托盘件三测试文件（tray-widget-buttons / workflow-tray-widget /
// interface/gui/tray-widget）共用的 fixture 单点：record fixture（真 SubagentRecord 形状）、
// tab-bar 树解包辅助、段纯 list-tree 结构断言、推送点 mock 注册。
//
// 本模块**不得值导入 @zhushanwen/subagent-core**：interface/gui/tray-widget.test 整体 mock
// 该包（只留 getSubagentService 可控点），值导入会被 mock 击穿（WorkflowRun 等 real 绑定
// 变 undefined）。需要真聚合根的 workflow run fixture 在 workflow-run-fixture.ts（仅被
// subagent-core 走真实现的两个测试文件消费）。
//
// mock 注册在本模块顶层（vitest transform 把 vi.mock 提升到本模块顶部，test 文件把本模块
// 放在首个 import 即保证先于 SUT 装载注册）：logger 防文件落盘；ext-guards 真实错误文案
// 映射；protocol 只 mock setWidgetDual 推送点，guiComponent/guiResult 走真实现——树形状
// 断言消费真实产物。
import { expect, vi } from "vitest";
import type { Mock } from "vitest";
import type { GuiComponent, GuiComponentProps, HostContainerAction, TreeItem } from "@zhushanwen/extension-protocol";
import type { SubagentRecord } from "@zhushanwen/subagent-core";
import type { UiLocale } from "../i18n.ts";

/** 托盘件测试共享 mock 面（vi.hoisted 聚合对象——vitest 禁止直接 export hoisted 变量，
 *  经下方非提升导出 trayWidgetMocks 包装发布）。 */
export interface TrayWidgetTestMocks { // oe-exempt:20261105:test:hoisted mock 聚合形状（三测试文件共享发布面，非可实现接口）
  /** logger mock 单例（断言 warn 留痕用：instance.warn） */
  instance: { debug: Mock; warn: Mock; error: Mock };
  getLogger: Mock;
  /** protocol setWidgetDual 推送点 mock（beforeEach mockReset；推送帧断言用 mock.calls） */
  setWidgetDual: Mock;
}

const mocks = vi.hoisted((): TrayWidgetTestMocks => {
  // 稳定单例（模块内 getLogger(...) 的每次调用返回同一 mock 实例——断言才能取到写入）
  const instance = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { instance, getLogger: vi.fn(() => instance), setWidgetDual: vi.fn() };
});

vi.mock("@zhushanwen/pi-extension-logger", () => ({ getLogger: mocks.getLogger }));
vi.mock("@zhushanwen/pi-ext-guards", () => ({
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock("@zhushanwen/extension-protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhushanwen/extension-protocol")>();
  return { ...actual, setWidgetDual: mocks.setWidgetDual };
});

/** 共享 mock 发布面（非提升导出——模块体求值时 hoisted 值已就绪）。 */
export const trayWidgetMocks: TrayWidgetTestMocks = mocks;

/** action-bar item 声明形状（协议 action-bar items 元素；协议包不导出该别名，消费方本地定义——Actionbar.vue 同款）。 */
export type ActionBarItem = GuiComponentProps["action-bar"]["items"][number];

/**
 * 面板文案 locale（D9：标题 / 分段标签 / 按钮与确认文案随 UI 语言）。构造函数是纯函数、
 * 显式收 locale 实参（scheduler widget 臂同款）；三个测试文件断言中文文案，故固定传
 * zh-CN——不依赖进程环境（readUiLocale 的 env 与 ui-preferences.json 读取）。
 */
export const TRAY_TEST_LOCALE: UiLocale = "zh-CN";

/** record fixture（字段见 core assembly/types.ts SubagentRecord；三测试文件单点）。 */
export function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
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
export function makeFailedRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
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

/** tab-bar 树的段组件清单（sections[i]——段 = 子树数组）。 */
export function segmentComponents(component: GuiComponent, index: number): GuiComponent[] {
  expect(component.type).toBe("tab-bar");
  const sections = (component.props as { sections?: GuiComponent[][] }).sections ?? [];
  return sections[index] ?? [];
}

/** 段内行集（D8 富行形态：段 = 每行一棵单行 list-tree，展平段内全部 list-tree 的 items）。 */
export function segmentItems(component: GuiComponent, index: number): TreeItem[] {
  return segmentComponents(component, index)
    .filter((c) => c.type === "list-tree")
    .flatMap((c) => (c.props as { items: TreeItem[] }).items);
}

/** 行内操作槽 items 展平（D8：按钮挂行 TreeItem.actions——段内全部行的 actions 集合；
 *  段内零按钮 = 空数组，无独立 action-bar 兄弟块）。 */
export function segmentActionItems(component: GuiComponent, index: number): ActionBarItem[] {
  return segmentItems(component, index).flatMap((item) => item.actions ?? []);
}

/** 行 action 的 hostAction 提取（「查看」入口——导航声明不随按钮增删而变化）。 */
export function rowHostAction(item: TreeItem): HostContainerAction | undefined {
  return item.action?.hostAction;
}

/** 观察者断言：两段均为纯 list-tree 序列（AX3：行内操作由协议字段承载，禁止独立
 *  兄弟 action-bar 块模拟——subagent / workflow 两件的段结构共用同一判据）。 */
export function expectSegmentsAllListTree(component: GuiComponent): void {
  for (const index of [0, 1]) {
    const components = segmentComponents(component, index);
    expect(components.map((c) => c.type)).toEqual(Array(components.length).fill("list-tree"));
  }
}
