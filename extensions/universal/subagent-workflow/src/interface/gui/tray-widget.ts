// src/interface/gui/tray-widget.ts
//
// subagent 托盘件的 widget 树产出 + 推送器（容器扩展点统一 §6.6 层 1：托盘 subagent
// 件改插件推 widget 树，宿主自建分桶/计数/专属面板退役——「树由谁构造」从宿主换到
// 插件进程，判据 = 事件源头在插件进程内）。
//
// 数据源 = subagent-core RecordStore 查询面（getSubagentService().queries）：
// collectRecords 四源合并（内存 running ∪ 磁盘重建 ∪ 主 session entry ∪ manifest），
// rootSession 过滤在查询面内收敛（与宿主侧 recordsOf(sessionId) 同分区语义）；磁盘
// 重建天然覆盖宿主重启后的冷读收敛（S6 重启观察点——startup-sweep / ADR-0161 补写
// 的事件经折叠进同一重建规则，不丢形态）。变更驱动 = queries.onChange（core 状态迁移
// 点同步出口），queueMicrotask 合并同 tick 多次触发后重推（微任务清空是构造性保证，
// 不设 timer——ADR-0122 事件顺序承载，无时间窗）。
//
// 推送通道 = protocol setWidgetDual（模式分派单点：RPC 经 marker 到宿主 ViewHostStore
// per-session 分区 → composer 托盘 widget 区；TUI 走原生文本行）。渲染终点与 todo/goal
// 同一 widget 区机制（宿主 ComposerTray widgetItems → TrayWidgetButton/TrayWidgetPanel）。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  failedRoundOf,
  failureCauseLabel,
  guiComponent,
  isRunningProjection,
  setWidgetDual,
  type DualWidgetContent,
  type GuiComponent,
  type GuiComponentProps,
  type GuiContext,
  type HostContainerAction,
} from "@zhushanwen/extension-protocol";
import { getSubagentService, type SubagentRecord } from "@zhushanwen/subagent-core";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { t, readUiLocale, type UiLocale } from "../../i18n.ts";
import { buildDualSegmentTrayWidget } from "./tray-widget-dual-segment.ts";

/** 托盘 widget 的 viewId（宿主 widget 区分区键；todo/goal 同形短名）。 */
export const SUBAGENT_TRAY_VIEW_ID = "subagent";

/**
 * 行点击导航目标（M2 入口复活，tray-panel-interact 设计 §3.3 D1/D3 消费侧 + AX2）：
 * 右抽屉 subagent tab 的全局 id（§6.12 内置保留命名空间 'ui' + 内容名）。宿主 sink 侧
 * 经 core stripBuiltinNamespace 剥前缀还原选中态 key（剥前缀规则单源在 core，插件声明
 * 侧只给完整全局 id——协议契约要求「目标标签页 id 须带命名空间前缀」）。
 */
const SUBAGENT_DRAWER_TAB_ID = "ui.subagent";

/**
 * 宿主薄命令 id（M3 生命周期操作，设计 §3.3 D4）：action-bar commandId 命中后经宿主
 * commandExecutor 分叉直转 session.subagentAction RPC（不经 plugin.executeCommand——pi
 * 扩展命令不在 provider 型插件命令表，设计 AS4 分叉）。命令表与执行体在宿主侧
 * （renderer host-thin-commands.ts），插件侧只声明 id 与 args，不感知执行形态。
 */
const SUBAGENT_CANCEL_COMMAND_ID = "taiji.subagentCancel";
const SUBAGENT_RETRY_COMMAND_ID = "taiji.subagentRetry";

/** action-bar item 声明形状（协议 action-bar items 元素；字段契约见协议 types.ts）。 */
type ActionBarItem = GuiComponentProps["action-bar"]["items"][number];

/** 单次推送的记录上限（托盘是概览面不是全量列表；行数超限按查询面排序截断）。 */
const TRAY_RECORD_LIMIT = 50;

// ── 判据（单点 = extension-protocol subagent-projection：isRunningProjection /
//    failedRoundOf / failureCauseLabel 本模块 import 消费，与宿主 renderer 侧
//    lib/subagent-bucket 同源——判据本体与语义注释见协议包 predicates.ts，
//    扩值评估两侧同批）──────────────────────────────────────────────

// ── widget 树构造（纯函数，单测锚点）─────────────────────────────────────────

/** 行状态映射：running 在途 → running；失败轮 → failed（红点）；其余收尾 → done。 */
function rowStatusOf(record: SubagentRecord): "running" | "done" | "failed" | undefined {
  if (isRunningProjection(record)) return "running";
  if (failedRoundOf(record) !== undefined) return "failed";
  return "done";
}

/** 行主名（composer-tray-protocol D8 富行迁移，demo v3 .cname 规格）：label 只放
 *  agent 名——slug 与失败分类迁 subLabel 副文本位，不再「 · 」拼接单行文本。 */
function rowLabelOf(record: SubagentRecord): string {
  return record.agent;
}

/** 行副文本（demo v3 .csub 规格）：slug · 失败分类。user.cancelled 是用户主动中止
 *  非失败（failedRoundOf 判据同源排除）：不拼失败词也不落 failed 点——拼上会与真
 *  失败同视觉，违反行的中性/危险二分（中止事实仍以「已结束」段行可见，非丢弃）。
 *  返回空串 = 无副文本（推送侧转字段缺省，ListTree 空串同「未声明」口径）。 */
function rowSubLabelOf(record: SubagentRecord): string {
  const parts: string[] = [];
  if (record.slug) parts.push(record.slug);
  const failure = failedRoundOf(record)?.failure;
  if (failure !== undefined) parts.push(failureCauseLabel(failure));
  return parts.join(" · ");
}

/**
 * 行内操作按钮声明（M3 生命周期操作，设计 §3.3 D4/D5 消费侧 + AX4）：running 行取消
 * （danger 档 + confirm 两段式——取消可恢复（重新派发即恢复）仍按 D5 判定表给危险操作
 * 统一防误触形态，M4 pin 门控到位前 confirm 是唯一防误触闸）；failed 行重试（同任务
 * 重派发新记录，天然可恢复故无 confirm）。
 *
 * 重试渲染条件：仅当 record 同时含可重派发任务原文（task）与短标签（slug）时渲染
 * （判据见下方行内注释）；缺任一字段的失败行只保留 hostAction「查看」入口（行点击
 * 导航不受影响）。
 *
 * 按钮文案经 i18n 词典（D9：随 UI 语言）——locale 由构造调用方显式传入（纯函数），
 * 文案主权在推送方（扩展），宿主持 title 模板不持按钮文案（D9 已否决宿主翻译插件文案）。
 */
function rowActionsOf(record: SubagentRecord, locale: UiLocale): ActionBarItem[] {
  if (isRunningProjection(record)) {
    return [
      {
        id: `cancel-${record.id}`,
        label: t("tray.action.cancel", undefined, locale),
        kind: "danger",
        commandId: SUBAGENT_CANCEL_COMMAND_ID,
        args: { recordId: record.id },
        confirm: t("tray.action.cancelConfirm", undefined, locale),
      },
    ];
  }
  // task 是 SubagentRecord 必需字段（string，磁盘/内存源均有）；slug 磁盘重建源旧文件
  // 可能缺失、契约明示兜底空串（core assembly/types.ts「磁盘重建源旧文件可能缺失→兜底
  // 空串」）。任一为空串 = 无原文可派（存量或异常构造路径）→ 按设计降级不渲染，防渲染出
  // 点击必错的按钮：retry args 原样携带 slug，宿主 hostStringArg 对空串 throw（数据缺失
  // 被误报成「按钮未提供 {param} 参数（扩展声明缺失）」——行级降级而非误导性报错）。
  if (failedRoundOf(record) !== undefined && record.task && record.slug) {
    return [
      {
        id: `retry-${record.id}`,
        label: t("tray.action.retry", undefined, locale),
        commandId: SUBAGENT_RETRY_COMMAND_ID,
        args: { slug: record.slug, task: record.task },
      },
    ];
  }
  // 其余收尾行（user.cancelled 主动中止 / 正常完成）：无行内操作——行仍可点查看。
  return [];
}

/**
 * 单段清单（sections 的段 = 子树数组）：富行形态（composer-tray-protocol D8）——
 * 每行一棵单行 list-tree，行信息按协议字段承载（label 主名 / subLabel 副文本 /
 * actions 行内操作槽），行内取消/重试不再推兄弟 action-bar 块（AX3：视觉层级由
 * 协议字段显式承载，禁止独立兄弟组件模拟）。
 *
 * 行 action（M2 入口复活）：声明 hostAction 后行渲染为可点原生 button，点击经宿主容器
 * 导航执行器打开右抽屉 subagent tab 并用 params.recordId 定位该子代理（drawer.tab 族
 * 登记键；core openDrawerTab 命中 subagent 时经 openSubagent 编排写选中态，与 doc tab
 * 的 commandName/filePath 定位参数同构）。导航是安全操作，不随 pin 态门控（D6 只门控
 * 行内操作按钮）——两段（进行中/已结束）行同权可点，终态行同样可查看对话流。
 */
function traySegment(records: readonly SubagentRecord[], locale: UiLocale): GuiComponent[] {
  const children: GuiComponent[] = [];
  for (const record of records) {
    const subLabel = rowSubLabelOf(record);
    const actions = rowActionsOf(record, locale);
    children.push(
      guiComponent("list-tree", {
        items: [
          {
            label: rowLabelOf(record),
            status: rowStatusOf(record),
            depth: 0,
            // 空串 = 无副文本/无行内操作 → 字段缺省（与 confirm「空串 = 未声明」同口径，
            // 不给宿主渲染层留空值分支）
            ...(subLabel !== "" ? { subLabel } : {}),
            ...(actions.length > 0 ? { actions } : {}),
            // satisfies 而非 as const：保字面量窄化（kind 须落在 'overlay'|'drawer' 联合）同时
            // 受 HostContainerAction 契约校验——裸对象字面量在宽泛上下文里会被拓宽成 string。
            action: {
              hostAction: {
                kind: "drawer",
                tabId: SUBAGENT_DRAWER_TAB_ID,
                params: { recordId: record.id },
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
 *  组装完整拼接文本 `agent · slug · 失败分类`——slug/失败分类不随 GUI 字段拆分静默
 *  丢弃，TUI 与 GUI 信息量等价（独立 pi CLI 用户经 setWidgetDual 的 text 分支呈现）。 */
function rowTextOf(record: SubagentRecord): string {
  const parts = [record.agent];
  const sub = rowSubLabelOf(record);
  if (sub !== "") parts.push(sub);
  return parts.join(" · ");
}

/** TUI 文本臂（pi 原生 widget 行——非 rpc/TUI 模式经 setWidgetDual 的 text 分支呈现）。 */
function trayTextLines(records: readonly SubagentRecord[]): string[] {
  return records.map((record) => {
    const state = isRunningProjection(record) ? "running" : failedRoundOf(record) ? "failed" : "done";
    return `[${state}] ${rowTextOf(record)}`;
  });
}

/**
 * 托盘 widget 双模内容（meta head + tab-bar 双段，形态对齐 todo 的双段架构与原宿主
 * 托盘两桶语义「进行中 / 已结束」）：骨架组装（状态派生 / 角标规则 / 双段 / meta head）
 * 见 tray-widget-dual-segment（workflow 件同构共用）；本件只落数据源域差异——运行中段
 * = 占用谓词命中行，已结束段 = 其余（含失败轮——失败分类在行 subLabel 副文本承载，
 * 状态点 failed 红，不静默丢弃）；空记录 → undefined（调用方按清屏语义推
 * setWidgetDual(…, undefined)——与 todo 空列表清屏同款，宿主 widget 区「有 entry 即
 * 渲染、清屏即消失」）。
 *
 * locale 形参（D9）：head 标题与 tab-bar 分段标签随 UI 语言；由推送方在每次推送时读
 * （readUiLocale）后显式传入——本函数保持纯函数（入参出参），显示决定因素不含隐藏的
 * 进程态读取。界面语言切换后下一次推送即生效（无指纹跳推，见本文件推送器）。
 */
export function buildSubagentTrayWidget(
  records: readonly SubagentRecord[],
  locale: UiLocale,
): DualWidgetContent | undefined {
  if (records.length === 0) return undefined;
  const running = records.filter((r) => isRunningProjection(r));
  const ended = records.filter((r) => !isRunningProjection(r));
  const hasFailure = ended.some((r) => failedRoundOf(r) !== undefined);
  // 骨架（head 状态派生 / 角标规则 / tab-bar 双段 / meta head）在 tray-widget-dual-segment
  // 单点（workflow 件同构共用）；本件只注入数据源域差异（行构造 / text 臂 / title / icon）。
  return buildDualSegmentTrayWidget(
    {
      records,
      running,
      ended,
      hasFailure,
      titleKey: "tray.subagent.title",
      icon: "bot",
      segment: traySegment,
      textLines: trayTextLines,
    },
    locale,
  );
}

// ── 推送器（session_start/shutdown 驱动的 per-factory 实例）──────────────────

/**
 * subagent 托盘 widget 推送器。attach = 订阅 record 变更 + 初始推送（collectRecords
 * 磁盘重建覆盖冷读）；detach = 取消订阅。推送失败首败 warn 留痕（不重试——下一次
 * onChange 事件驱动重推，绝对投影语义下任何一帧成功即整镜恢复，inflight reporter
 * 的 dirty 重推同款方向）。
 *
 * ctx 为 null 期间（attach 前 / detach 后）push 为 no-op；getSubagentService() 为
 * null（session_start 装配链之前）不订阅——attach 调用点在 setupSessionLifecycle
 * 之后（service 必在），防御分支仅覆盖异常时序。
 */
export interface SubagentTrayWidgetPusher { // oe-exempt:20261025:framework:托盘推树 port 契约（工厂单装配，非抽象接口单实现）
  attach(ctx: ExtensionContext): void;
  detach(): void;
}

export function createSubagentTrayWidgetPusher(): SubagentTrayWidgetPusher {
  const logger = getLogger("subagents");
  let ctx: ExtensionContext | null = null;
  let unsubscribe: (() => void) | null = null;
  /** 同 tick 多次 onChange 合并为一次推送（微任务边界 = 合并点，无 timer）。 */
  let flushScheduled = false;
  let firstFailureLogged = false;

  function push(): void {
    if (ctx === null) return;
    const service = getSubagentService();
    const records =
      service?.queries.collectRecords(TRAY_RECORD_LIMIT, "all", false) ?? [];
    // locale 每次推送时读（D9，scheduler widget 臂同款）：界面语言切换后下一次推送即生效。
    const locale = readUiLocale();
    try {
      // todo makeRefreshDisplay 同款断言（协议侧既有先例）：pi 的 ExtensionContext.ui.custom
      // 泛型签名与 GuiContext 静态不兼容，setWidgetDual 只读 mode/hasUI/ui.setWidget。
      setWidgetDual(ctx as GuiContext, SUBAGENT_TRAY_VIEW_ID, buildSubagentTrayWidget(records, locale));
      firstFailureLogged = false;
    } catch (err) {
      // 推送失败不反噬 onChange 调用方（core 写链不得被渲染侧故障打断）；
      // 显式留痕防静默丢（绝对投影语义，下一事件自然补推）。
      if (!firstFailureLogged) {
        firstFailureLogged = true;
        logger.warn(`[subagent-tray] widget push failed; will retry on next record change: ${toErrorMessage(err)}`);
      }
    }
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      push();
    });
  }

  return {
    attach(target: ExtensionContext): void {
      ctx = target;
      const service = getSubagentService();
      // onChange 订阅幂等：reload 场景 attach 前先 detach（组合根时序保证），防御
      // 重复订阅在此收敛（先解后订，监听集不累积）。
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
      if (service !== null) {
        unsubscribe = service.queries.onChange(scheduleFlush);
      }
      scheduleFlush();
    },

    detach(): void {
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
      ctx = null;
    },
  };
}
