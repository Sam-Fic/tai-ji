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
  guiResult,
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

/** 行 label：agent · slug · 失败分类（失败分类拼进行尾——TreeItem 无独立严重度文本
 *  字段，label 是该信息的原语承载位；迁移前宿主行的 failure chip 同为文本呈现，
 *  信息不静默丢弃，§6.6 风险②）。user.cancelled 是用户主动中止非失败（判据同源
 *  排除）：不拼失败词也不落 failed 点——拼上会与真失败同视觉，违反原宿主行的
 *  中性/危险二分（中止事实仍以「已结束」段行可见，非丢弃）。 */
function rowLabelOf(record: SubagentRecord): string {
  const parts = [record.agent];
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
 * 重试渲染条件：仅当 record 含可重派发任务原文时渲染（判据见下方行内注释）；无原文
 * 的失败行只保留 hostAction「查看」入口（行点击导航不受影响）。
 *
 * 按钮文案用字面量（i18n 接线归 u-polish-shell 的 readUiLocale 波次——与本节两个 tab
 * 标签「进行中/已结束」硬编码同形态，M4 随全文案一起随 UI 语言）。
 */
function rowActionsOf(record: SubagentRecord): ActionBarItem[] {
  if (isRunningProjection(record)) {
    return [
      {
        id: `cancel-${record.id}`,
        label: "取消",
        kind: "danger",
        commandId: SUBAGENT_CANCEL_COMMAND_ID,
        args: { recordId: record.id },
        confirm: "确认取消？",
      },
    ];
  }
  // task 是 SubagentRecord 必需字段（string，磁盘/内存源均有）；空串/缺值 = 无原文
  // 可派（存量或异常构造路径）→ 按设计降级不渲染，防渲染出点击必错的按钮。
  if (failedRoundOf(record) !== undefined && record.task) {
    return [
      {
        id: `retry-${record.id}`,
        label: "重试",
        commandId: SUBAGENT_RETRY_COMMAND_ID,
        args: { slug: record.slug, task: record.task },
      },
    ];
  }
  // 其余收尾行（user.cancelled 主动中止 / 正常完成）：无行内操作——行仍可点查看。
  return [];
}

/**
 * 单段清单（sections 的段 = 子树数组）：逐行「list-tree 行 + action-bar 操作」对
 * （scheduler-manager 浮层面板同款形态——仓内 action-bar 唯一消费先例，设计 AS3）。
 * 行集从「一段一棵 list-tree」改为逐行一棵：按钮 args 逐行承载该行 recordId，段级
 * 共享 action-bar 表达不了行级参数；无操作按钮的行只推 list-tree（段内零按钮时不
 * 出现空 action-bar）。
 *
 * 行 action（M2 入口复活）：声明 hostAction 后行渲染为可点原生 button，点击经宿主容器
 * 导航执行器打开右抽屉 subagent tab 并用 params.recordId 定位该子代理（drawer.tab 族
 * 登记键；core openDrawerTab 命中 subagent 时经 openSubagent 编排写选中态，与 doc tab
 * 的 commandName/filePath 定位参数同构）。导航是安全操作，不随 pin 态门控（D6 只门控
 * 行内操作按钮）——两段（进行中/已结束）行同权可点，终态行同样可查看对话流。
 */
function traySegment(records: readonly SubagentRecord[]): GuiComponent[] {
  const children: GuiComponent[] = [];
  for (const record of records) {
    children.push(
      guiComponent("list-tree", {
        items: [
          {
            label: rowLabelOf(record),
            status: rowStatusOf(record),
            depth: 0,
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
    const actions = rowActionsOf(record);
    if (actions.length > 0) {
      children.push(guiComponent("action-bar", { items: actions }));
    }
  }
  return children;
}

/** TUI 文本臂（pi 原生 widget 行——非 rpc/TUI 模式经 setWidgetDual 的 text 分支呈现）。 */
function trayTextLines(records: readonly SubagentRecord[]): string[] {
  return records.map((record) => {
    const state = isRunningProjection(record) ? "running" : failedRoundOf(record) ? "failed" : "done";
    return `[${state}] ${rowLabelOf(record)}`;
  });
}

/** meta 状态词表（head 状态点语义）。 */
type MetaStatus = NonNullable<import("@zhushanwen/extension-protocol").WidgetMeta["status"]>;

/**
 * 托盘 widget 双模内容（meta head + tab-bar 双段，形态对齐 todo 的双段架构与原宿主
 * 托盘两桶语义「进行中 / 已结束」）：
 * - gui 臂 meta：宿主壳层唯一渲染 head（标题/状态点/进度/icon/badge）；status = running>0
 *   亮运行态（宿主呼吸点），有失败轮落 failed，否则 done；badge/progress = 进行中条数
 *   （托盘 `[bot N]` 计数语义与原宿主按钮角标同源）；icon 点名 'bot'（宿主
 *   WIDGET_ICON_ENTRIES 在册）。
 * - gui 臂内容 = tab-bar 双段互斥覆盖全量：运行中段 = 占用谓词命中行；已结束段 = 其余
 *   （含失败轮——失败分类在行 label 承载，状态点 failed 红，不静默丢弃）。段内逐行
 *   「list-tree 行 + action-bar 操作」对：running 行带取消按钮、failed 行（任务原文
 *   在场）带重试按钮，commandId 指向宿主薄命令（M3，见 rowActionsOf）。
 * - text 臂 = TUI 原生文本行（setWidgetDual 模式分派到非 rpc 臂的呈现）。
 * - 空记录 → undefined（调用方按清屏语义推 setWidgetDual(…, undefined)——与 todo
 *   空列表清屏同款，宿主 widget 区「有 entry 即渲染、清屏即消失」）。
 */
export function buildSubagentTrayWidget(
  records: readonly SubagentRecord[],
): DualWidgetContent | undefined {
  if (records.length === 0) return undefined;
  const running = records.filter((r) => isRunningProjection(r));
  const ended = records.filter((r) => !isRunningProjection(r));
  const hasFailure = ended.some((r) => failedRoundOf(r) !== undefined);
  const status: MetaStatus =
    running.length > 0 ? "running" : hasFailure ? "failed" : "done";
  return {
    gui: guiResult(
      guiComponent("tab-bar", {
        tabs: [
          // 首段带 active：容器化宿主据此建立初始 tab（此后本地切换不被推送重置）
          { label: `进行中 ${running.length}`, active: true },
          { label: `已结束 ${ended.length}` },
        ],
        sections: [traySegment(running), traySegment(ended)],
      }),
      {
        title: "Subagents",
        status,
        progress: {
          current: running.length,
          total: records.length,
          label: String(running.length),
        },
        icon: "bot",
        badge: String(running.length),
      },
    ),
    text: trayTextLines(records),
  };
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
    try {
      // todo makeRefreshDisplay 同款断言（协议侧既有先例）：pi 的 ExtensionContext.ui.custom
      // 泛型签名与 GuiContext 静态不兼容，setWidgetDual 只读 mode/hasUI/ui.setWidget。
      setWidgetDual(ctx as GuiContext, SUBAGENT_TRAY_VIEW_ID, buildSubagentTrayWidget(records));
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
