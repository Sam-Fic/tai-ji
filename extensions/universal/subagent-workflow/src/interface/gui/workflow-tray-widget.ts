// src/interface/gui/workflow-tray-widget.ts
//
// workflow 托盘件的 widget 树产出 + 推送器（容器扩展点统一 §6.6 层 1，U10：托盘
// workflow 件改插件推 widget 树，宿主自建 workflow 分桶/首拉/专属面板退役——「树由谁
// 构造」从宿主换到插件进程，判据 = 事件源头在插件进程内；与 subagent 件 tray-widget.ts
// 同族同形态，差异只在数据源与变更出口）。
//
// 数据源 = workflow 域 per-session 的 runs Map（WorkflowRun 聚合根，LauncherDeps.runs
// 同源——经注入的 readRuns 现读，组合根 workflow-events 在 session_start 装配链后注入
// 当前 session 条目；聚合根内存投影即绝对状态）+ 磁盘折叠冷读源（reloadFromDisk，组合根
// 注入 store.loadAll 的 upsert 包装）：内存投影空时触发一次折叠补装再重读——restore/
// 重启形态下内存投影面（per-session Map + lsRef 单值键位）任一环未就绪即投影空，且
// interrupted 是静态暂停态、后续无 journal 事件驱动重推，空投影无自愈；磁盘折叠源让
// attach 投影不依赖装配链恢复段的成果（subagent 件 collectRecords 四源合并中「磁盘重建」
// 的同款语义——与 subagent 件同款重启恢复收敛）。
// 行级信息 = core runSummary 派生视图（三态 done>interrupted>running + DoneReason 终局
// 因）+ state.calls 成员计数（N/M 进度的原语承载位——list-tree 无进度条原语，随 slug
// 落行 subLabel 副文本位，信息不静默丢弃）。
//
// 变更驱动 = run 域 journal 落盘出口（core notifyJournalAppended 的壳层组合分发——
// run 生命周期每条转移帧都落 run 域 journal，出口回调即权威变更信号；进程级单监听
// 由组合根分发给 journal reporter 与本推送器两个消费者）。queueMicrotask 合并同 tick
// 多次触发后重推（微任务清空是构造性保证，不设 timer——ADR-0122 事件顺序承载）。
//
// 推送通道 = protocol setWidgetDual（与 subagent/todo/goal 同一 widget 区机制：RPC 经
// marker 到宿主 ViewHostStore per-session 分区 → composer 托盘 widget 区；TUI 走原生
// 文本行）。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  guiComponent,
  setWidgetDual,
  type DualWidgetContent,
  type GuiComponent,
  type GuiComponentProps,
  type GuiContext,
  type HostContainerAction,
} from "@zhushanwen/extension-protocol";
import { runSummary } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { t, readUiLocale, type UiLocale } from "../../i18n.ts";
import { buildDualSegmentTrayWidget } from "./tray-widget-dual-segment.ts";

/** 托盘 widget 的 viewId（宿主 widget 区分区键；todo/goal/subagent 同形短名）。 */
export const WORKFLOW_TRAY_VIEW_ID = "workflow";

/**
 * 行点击导航目标（M2 入口复活，tray-panel-interact 设计 §3.3 D1/D2 消费侧 + AX2）：
 * workflow 可视化浮层内容的全局 id（§6.12 内置保留命名空间 'ui' + 内容名）。浮层内置
 * 内容不经容器位声明通道（§6.8），宿主 lookup 侧按 OVERLAY_REGISTRY 投影补全局 id 空间
 * 解析（id = 'ui.<kind>'）——插件声明侧只给完整全局 id，不感知宿主内部特判。
 */
const WORKFLOW_OVERLAY_CONTENT_ID = "ui.workflow";

/**
 * 宿主薄命令 id（M3 生命周期操作，设计 §3.3 D4）：action-bar commandId 命中后经宿主
 * commandExecutor 分叉直转 session.workflowAction RPC（不经 plugin.executeCommand——pi
 * 扩展命令不在 provider 型插件命令表，设计 AS4 分叉）。命令表与执行体在宿主侧
 * （renderer host-thin-commands.ts），插件侧只声明 id 与 args，不感知执行形态。
 */
const WORKFLOW_ABORT_COMMAND_ID = "taiji.workflowAbort";
const WORKFLOW_RESUME_COMMAND_ID = "taiji.workflowResume";

/** action-bar item 声明形状（协议 action-bar items 元素；字段契约见协议 types.ts）。 */
type ActionBarItem = GuiComponentProps["action-bar"]["items"][number];

/** 单次推送的 run 行上限（托盘是概览面不是全量列表；序 = runs Map 插入序截断）。 */
const TRAY_RUN_LIMIT = 50;

// ── 行级判据（宿主侧 tray-tone workflow 档的插件侧承载；run 级判据，消费
//    core runSummary/DoneReason 词表——与 subagent 件的 record 级投影判据不同组：
//    那组判据已下沉 extension-protocol 单点（subagent-projection/predicates.ts），
//    本组以 runSummary 为输入、仅本文件承载，词表扩值时与 core runSummary 同批评估。──

/**
 * 单个 run 的成员进度计数（N/M）：N = 已落定 call 数（result 已设置——markDone
 * 前置保证落定即有 result，error 有无区分成败）；M = 总 call 数。行 subLabel 的承载位
 * （原宿主托盘 workflow 行的进度条 + N/M 文本迁 widget 后先由 label 承载、D8 富行
 * 迁移后随 slug 一起落 subLabel 副文本位，不静默丢弃）。
 */
function memberProgressOf(run: WorkflowRun): { settled: number; total: number } {
  let settled = 0;
  for (const call of run.state.calls.values()) {
    if (call.result !== undefined) settled += 1;
  }
  return { settled, total: run.state.calls.size };
}

/** 行状态映射（与对话流 buildWorkflowGui 的 runTreePresentation 同口径）：running
 * 在途 → running；interrupted（暂停态无活体）→ 无圆点 pause；终局按终止性因分档
 * （failed 族红 / completed 与 aborted 绿——aborted 是用户主动取消非失败）。 */
function rowPresentation(
  summary: ReturnType<typeof runSummary>,
): { status?: "running" | "done" | "failed"; icon: "circle" | "pause" | "cross" | "check" } {
  if (summary.status === "running") return { status: "running", icon: "circle" };
  if (summary.status === "interrupted") return { icon: "pause" };
  switch (summary.reason) {
    case "failed":
    case "budget_limited":
    case "time_limited":
    case "partially_succeeded":
      return { status: "failed", icon: "cross" };
    case "completed":
    case "aborted":
      return { status: "done", icon: "check" };
    // done + 终局因缺省（注册表 miss 窗口）——数据缺口不作成败断言，中性 pause。
    case undefined:
      return { icon: "pause" };
  }
}

/** 行主名（composer-tray-protocol D8 富行迁移，demo v3 .cname 规格）：label 只放
 *  run 名——slug 与成员进度迁 subLabel 副文本位，不再「 · 」拼接单行文本。 */
function rowLabelOf(run: WorkflowRun): string {
  return runSummary(run).name;
}

/**
 * 行副文本（demo v3 .csub 规格）：`slug · N/M`（成员进度 N/M = 已落定 call 数/总 call
 * 数——list-tree 无进度条原语，subLabel 是该信息的原语承载位，不静默丢弃；slug 缺省
 * 跳段——filter(Boolean) 防双空格）。返回空串 = 无副文本（推送侧转字段缺省）。
 */
function rowSubLabelOf(run: WorkflowRun): string {
  const summary = runSummary(run);
  const progress = memberProgressOf(run);
  return [summary.slug, `${progress.settled}/${progress.total}`]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 行内操作按钮声明（M3 生命周期操作，设计 §3.3 D4/D5 消费侧 + AX4/AX5）：running 行
 * 中止（danger 档 + confirm 两段式——abort 落 terminal 终局态不可恢复，D5 判定表定
 * 其必须带 confirm，恢复手段 = 从头重跑新 run）；interrupted 行续跑（断点恢复操作
 * 本体，无破坏面故无 confirm）。终局行（done/failed）无行内操作——workflow 运行中
 * 形态为一次性（abort-only，无 pause/resume；重派发是 subagent start 语义，workflow
 * 无同构通道，AX5）。
 *
 * 按钮文案经 i18n 词典（D9：随 UI 语言）——locale 由构造调用方显式传入（纯函数），
 * 文案主权在推送方（扩展），宿主持 title 模板不持按钮文案（D9 已否决宿主翻译插件文案）。
 */
function rowActionsOf(run: WorkflowRun, locale: UiLocale): ActionBarItem[] {
  const summary = runSummary(run);
  if (summary.status === "running") {
    return [
      {
        id: `abort-${run.runId}`,
        label: t("tray.action.abort", undefined, locale),
        kind: "danger",
        commandId: WORKFLOW_ABORT_COMMAND_ID,
        args: { runId: run.runId },
        confirm: t("tray.action.abortConfirm", undefined, locale),
      },
    ];
  }
  if (summary.status === "interrupted") {
    return [
      {
        id: `resume-${run.runId}`,
        label: t("tray.action.resume", undefined, locale),
        commandId: WORKFLOW_RESUME_COMMAND_ID,
        args: { runId: run.runId },
      },
    ];
  }
  return [];
}

/**
 * 段清单（tab-bar sections 的段 = 子树数组）：富行形态（composer-tray-protocol D8）——
 * 每行一棵单行 list-tree，行信息按协议字段承载（label 主名 / subLabel 副文本 /
 * statusLabel 状态覆盖 / actions 行内操作槽），行内中止/续跑不再推兄弟 action-bar 块
 * （AX3：视觉层级由协议字段显式承载，禁止独立兄弟组件模拟）。
 *
 * interrupted（三值枚举装不下的特殊语义，D3/D8）经 statusLabel 覆盖字表达
 * （「已中断（可续跑）」，文案在扩展 i18n 词典——渲染序 = statusLabel ?? 宿主枚举映射）。
 *
 * 行 action（M2 入口复活）：声明 hostAction 后行渲染为可点原生 button，点击经宿主容器
 * 导航执行器打开全屏浮层并用 params.runId 定位该 run（overlay.content 族登记键；core
 * openOverlayContent 命中 workflow 且带 runId 时走参数化通道，经 drawer 域 openWorkflow
 * → bindWorkflowOverlayOpener 注入桥调 openWorkflowVizOverlay 同款编排）。这是 workflow
 * 可视化的第一用户入口（G3：整套可视化此前零入口）。导航是安全操作，不随 pin 态门控
 * （D6 只门控行内操作按钮）——两段（进行中/已结束）行同权可点。
 */
function traySegment(runs: readonly WorkflowRun[], locale: UiLocale): GuiComponent[] {
  const children: GuiComponent[] = [];
  for (const run of runs) {
    const summary = runSummary(run);
    const presentation = rowPresentation(summary);
    const subLabel = rowSubLabelOf(run);
    const actions = rowActionsOf(run, locale);
    children.push(
      guiComponent("list-tree", {
        items: [
          {
            label: rowLabelOf(run),
            status: presentation.status,
            icon: presentation.icon,
            depth: 0,
            // interrupted 无活体暂停态（不作成败断言——status 缺省）：覆盖字是唯一
            // 状态语义承载，空串 = 未声明口径同 confirm（本词条词典恒非空串）
            ...(summary.status === "interrupted"
              ? { statusLabel: t("tray.workflow.interruptedLabel", undefined, locale) }
              : {}),
            // 空串 = 无副文本/无行内操作 → 字段缺省（与 confirm「空串 = 未声明」同口径，
            // 不给宿主渲染层留空值分支）
            ...(subLabel !== "" ? { subLabel } : {}),
            ...(actions.length > 0 ? { actions } : {}),
            action: {
              hostAction: {
                kind: "overlay",
                tabId: WORKFLOW_OVERLAY_CONTENT_ID,
                params: { runId: run.runId },
              } satisfies HostContainerAction,
            },
          },
        ],
      }),
    );
  }
  return children;
}

/** TUI text 臂行组装（D8 TUI 文本臂语义，R1 修复轮）：GUI 行拆字段后 text 臂自行
 *  组装完整拼接文本 `name · slug · N/M`——slug 与成员进度不随 GUI 字段拆分静默丢弃，
 *  TUI 与 GUI 信息量等价（独立 pi CLI 用户经 setWidgetDual 的 text 分支呈现）。 */
function rowTextOf(run: WorkflowRun): string {
  const summary = runSummary(run);
  const progress = memberProgressOf(run);
  return [summary.name, summary.slug, `${progress.settled}/${progress.total}`]
    .filter(Boolean)
    .join(" · ");
}

/** TUI 文本臂（pi 原生 widget 行——非 rpc/TUI 模式经 setWidgetDual 的 text 分支呈现）。 */
function trayTextLines(runs: readonly WorkflowRun[]): string[] {
  return runs.map((run) => {
    const summary = runSummary(run);
    const state = summary.status;
    return `[${state}] ${rowTextOf(run)}`;
  });
}

/**
 * workflow 托盘 widget 双模内容（meta head + tab-bar 双段，形态对齐 subagent 件的
 * 「进行中 / 已结束」两桶语义——原宿主分桶面板的两视图裁决同构）：骨架组装（状态派生 /
 * 角标规则 / 双段 / meta head）见 tray-widget-dual-segment（subagent 件同构共用）；本件
 * 只落数据源域差异——进行中段 = status==="running" 行，已结束段 = 其余（done /
 * interrupted——interrupted 计已结束与原宿主 [D2] 显式裁决同口径：interrupted 是无活体
 * 暂停态不算进行中）；空 runs → undefined（调用方按清屏语义推 setWidgetDual(…,
 * undefined)——与 todo / subagent 空列表清屏同款，宿主 widget 区「有 entry 即渲染、
 * 清屏即消失」）。
 *
 * locale 形参（D9）：head 标题与 tab-bar 分段标签随 UI 语言；由推送方在每次推送时读
 * （readUiLocale）后显式传入——本函数保持纯函数（入参出参），显示决定因素不含隐藏的
 * 进程态读取。界面语言切换后下一次推送即生效（无指纹跳推，见推送器）。
 */
export function buildWorkflowTrayWidget(
  runs: readonly WorkflowRun[],
  locale: UiLocale,
): DualWidgetContent | undefined {
  if (runs.length === 0) return undefined;
  const running = runs.filter((r) => runSummary(r).status === "running");
  const ended = runs.filter((r) => runSummary(r).status !== "running");
  const hasFailure = ended.some((r) => {
    const p = rowPresentation(runSummary(r));
    return p.status === "failed";
  });
  // 骨架（head 状态派生 / 角标规则 / tab-bar 双段 / meta head）在 tray-widget-dual-segment
  // 单点（subagent 件同构共用）；本件只注入数据源域差异（行构造 / text 臂 / title / icon）。
  return buildDualSegmentTrayWidget(
    {
      records: runs,
      running,
      ended,
      hasFailure,
      titleKey: "tray.workflow.title",
      icon: "workflow",
      segment: traySegment,
      textLines: trayTextLines,
    },
    locale,
  );
}

// ── 推送器（组合根注入 readRuns 的 per-factory 实例）────────────────────────

/** workflow 域 run 集的现读口（组合根装配：当前 session 的 runs Map 值集，截断在推送器）。 */
export type WorkflowRunsReader = () => readonly WorkflowRun[];

/**
 * 磁盘折叠冷读源（restore/重启收敛）：内存投影为空时由推送器触发（每 attach 生命周期
 * 一次）。实现方（组合根）读当前 session 的 store.loadAll 幂等重建并 upsert 进内存
 * 投影面（runs Map 补缺，不覆盖活体态），返回是否补到产物——true 时推送器重读 readRuns。
 * 故障由推送器围栏（warn 留痕后按空投影继续），不反噬推送链。
 */
export type WorkflowRunsDiskReloader = () => Promise<boolean>;

/** 推送器工厂可选项（缺省 = 无磁盘折叠源，纯内存投影——既有行为）。 */
export interface WorkflowTrayWidgetPusherOptions {
  reloadFromDisk?: WorkflowRunsDiskReloader;
}

/**
 * workflow 托盘 widget 推送器。attach = 初始推送（绝对投影——聚合根内存态即当前真值；
 * 投影空且有磁盘折叠源时先折叠补装再投影，见 push 内注释）；notifyRunsChanged = run 域
 * journal 出口的变更信号（组合根分发，同 tick 多次合并为一次重推）；detach = 摘 ctx 停推。
 * 推送失败首败 warn 留痕（不重试——下一次 journal 事件驱动重推，绝对投影语义下任何一帧
 * 成功即整镜恢复，subagent 件同款方向）。
 *
 * ctx 为 null 期间（attach 前 / detach 后）push 为 no-op；readRuns 抛错（session 装配
 * 链未完成的时序窗）按无数据清屏投影——不反噬 journal 出口调用方（core 写链不得被
 * 渲染侧故障打断）。
 */
export interface WorkflowTrayWidgetPusher { // oe-exempt:20261025:framework:托盘推树 port 契约（工厂单装配，非抽象接口单实现）
  attach(ctx: ExtensionContext): void;
  detach(): void;
  /** run 域变更信号（journal 出口组合分发调用；同 tick 多次合并微任务边界一次推送）。 */
  notifyRunsChanged(): void;
}

export function createWorkflowTrayWidgetPusher(
  readRuns: WorkflowRunsReader,
  options: WorkflowTrayWidgetPusherOptions = {},
): WorkflowTrayWidgetPusher {
  const logger = getLogger("subagents");
  const reloadFromDisk = options.reloadFromDisk;
  let ctx: ExtensionContext | null = null;
  /** 同 tick 多次变更信号合并为一次推送（微任务边界 = 合并点，无 timer）。 */
  let flushScheduled = false;
  let firstFailureLogged = false;
  /**
   * 磁盘折叠预算（每 attach 生命周期一次）：restore 收敛只需一问，常态空投影（真无 run
   * 的 session）不重复付 loadAll 的全量 session 读成本；attach 复位（切回该 session 重算）。
   */
  let diskReloadUsed = false;
  /** 折叠单飞：await 间隙重入的 push 不重复发起折叠（第一次完成后由重推链收敛）。 */
  let diskReloadInFlight = false;

  /** readRuns 围栏：读侧故障按空集 + 留痕（不静默），下一事件自然重推。 */
  function readRunsSafe(): readonly WorkflowRun[] {
    try {
      return readRuns();
    } catch (err) {
      logger.warn(`[workflow-tray] runs read failed; projecting empty: ${toErrorMessage(err)}`);
      return [];
    }
  }

  async function push(): Promise<void> {
    if (ctx === null) return;
    // 折叠单飞期间到达的并发 push：此刻读到的仍是折叠前的空内存投影（补装未达投影面），
    // 且 diskReloadUsed 已被发起方置位使其跳过折叠 → 只会推出无信息量的瞬态清屏帧
    // （托盘条目毫秒级闪烁后又被数据帧覆盖）。折叠发起方 await 返回后按最新投影重推，
    // 中间帧直接丢弃，不参与推送。
    if (diskReloadInFlight) return;
    let runs = readRunsSafe();
    if (runs.length === 0 && reloadFromDisk && !diskReloadUsed && !diskReloadInFlight) {
      // restore/重启冷读收敛：内存投影空 ≠ 无 run（装配链恢复段产物可能未达投影面，
      // 且 interrupted 静态态无后续事件重推）——磁盘折叠补装一次后重读。补装只补缺
      // （组合根 upsert 语义），不覆盖内存活体态；无 reloadFromDisk（测试/纯内存形态）
      // 或预算已用尽时直接按空投影清屏。
      diskReloadUsed = true;
      diskReloadInFlight = true;
      try {
        const added = await reloadFromDisk();
        if (added) runs = readRunsSafe();
      } catch (err) {
        logger.warn(`[workflow-tray] disk reload failed; projecting empty: ${toErrorMessage(err)}`);
      } finally {
        diskReloadInFlight = false;
      }
    }
    // 折叠 await 间隙可能 detach（session 切换/终结）——醒来后核对再推，防 stale ctx 推帧。
    if (ctx === null) return;
    // locale 每次推送时读（D9，subagent 件同款）：界面语言切换后下一次推送即生效。
    const locale = readUiLocale();
    try {
      setWidgetDual(
        ctx as GuiContext,
        WORKFLOW_TRAY_VIEW_ID,
        buildWorkflowTrayWidget(runs.slice(0, TRAY_RUN_LIMIT), locale),
      );
      firstFailureLogged = false;
    } catch (err) {
      // 推送失败不反噬 journal 出口调用方；显式留痕防静默丢（绝对投影语义）。
      if (!firstFailureLogged) {
        firstFailureLogged = true;
        logger.warn(`[workflow-tray] widget push failed; will retry on next run journal event: ${toErrorMessage(err)}`);
      }
    }
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      void push();
    });
  }

  return {
    attach(target: ExtensionContext): void {
      ctx = target;
      // 切回该 session（attach 重算）恢复磁盘折叠预算：上一 attach 的「已问过磁盘」
      // 不跨 session 生命周期记忆。
      diskReloadUsed = false;
      scheduleFlush();
    },

    detach(): void {
      ctx = null;
    },

    notifyRunsChanged(): void {
      scheduleFlush();
    },
  };
}
