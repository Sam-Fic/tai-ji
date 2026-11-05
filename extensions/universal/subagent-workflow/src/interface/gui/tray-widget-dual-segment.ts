// src/interface/gui/tray-widget-dual-segment.ts
//
// 双段托盘 widget 的同构骨架单点（composer-tray-protocol D8，subagent / workflow 两件
// 共用）：head 状态派生 + demo v3 角标规则 + tab-bar 双段互斥覆盖全量 + meta head 组装。
// 两件的真差异只在数据源域——行级判据（segment 构造）、text 臂行组装、面板标题词典键、
// icon 点名——经入参注入，骨架本体不重复第二份。

import {
  guiComponent,
  guiResult,
  type DualWidgetContent,
  type GuiComponent,
  type WidgetMeta,
} from "@zhushanwen/extension-protocol";
import { t, type UiLocale } from "../../i18n.ts";

/** meta 状态词表（head 状态点语义）。 */
type MetaStatus = NonNullable<WidgetMeta["status"]>;

/** 双段托盘 widget 组装入参（行类型 T 由各件的数据源域决定）。 */
export interface DualSegmentTrayInput<T> { // oe-exempt:20261105:framework:骨架组装入参契约（泛型参数对象，无可实现主体——调用方字面量构造）
	/** 全量行（progress.total 与 text 臂的数据源）。 */
	records: readonly T[];
  /** 进行中段（status 派生 + progress.current 的数据源）。 */
  running: readonly T[];
  /** 已结束段（收尾/中断行）。 */
  ended: readonly T[];
  /** 是否存在失败行（状态派生次序：running>0 亮运行态 → 失败红点 → done）。 */
  hasFailure: boolean;
  /** 面板标题词典键（tray.subagent.title / tray.workflow.title）。 */
  titleKey: string;
  /** head icon 点名（宿主 widget icon registry 在册值）。 */
  icon: NonNullable<WidgetMeta["icon"]>;
  /** 段构造（行富行形态——行级判据是数据源域真差异，两件各自实现）。 */
  segment: (rows: readonly T[], locale: UiLocale) => GuiComponent[];
  /** TUI text 臂行组装（信息量与 GUI 等价，两件各自实现）。 */
  textLines: (rows: readonly T[]) => string[];
}

/**
 * 双段托盘 widget 骨架组装（gui 臂 meta + tab-bar 双段 / text 臂 TUI 文本行）：
 * - meta：status = running>0 亮运行态（宿主呼吸点），有失败行落 failed，否则 done；
 *   badge/progress.label = 进行中条数且 running>0 才推（demo v3 角标规则，PR5 红色 0
 *   根因 = 推送侧 0 照推 + 宿主无过滤——判定信号在语义所有方）。0 时面板 head 计数回落
 *   current/total 拼接（「0/2」）、迷你进度条 0% 照常（progress.current/total 恒保留）。
 * - gui 臂内容 = tab-bar 双段互斥覆盖全量（进行中段 / 已结束段），首段带 active。
 * - text 臂 = TUI 原生文本行（setWidgetDual 模式分派到非 rpc 臂的呈现）。
 */
export function buildDualSegmentTrayWidget<T>(
  input: DualSegmentTrayInput<T>,
  locale: UiLocale,
): DualWidgetContent {
  const { records, running, ended, hasFailure, titleKey, icon, segment, textLines } = input;
  const status: MetaStatus =
    running.length > 0 ? "running" : hasFailure ? "failed" : "done";
  const runningCountText = running.length > 0 ? String(running.length) : undefined;
  return {
    gui: guiResult(
      guiComponent("tab-bar", {
        tabs: [
          // 首段带 active：容器化宿主据此建立初始 tab（此后本地切换不被推送重置）
          { label: t("tray.segment.running", { n: running.length }, locale), active: true },
          { label: t("tray.segment.ended", { n: ended.length }, locale) },
        ],
        sections: [segment(running, locale), segment(ended, locale)],
      }),
      {
        title: t(titleKey, undefined, locale),
        status,
        progress: {
          current: running.length,
          total: records.length,
          ...(runningCountText !== undefined ? { label: runningCountText } : {}),
        },
        icon,
        ...(runningCountText !== undefined ? { badge: runningCountText } : {}),
      },
    ),
    text: textLines(records),
  };
}
