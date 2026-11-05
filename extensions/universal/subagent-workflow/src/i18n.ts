// src/i18n.ts
//
// subagent-workflow 扩展的 L2 呈现层词典（tray-panel-interact 设计 §3.3 D9：面板文案
// 随 UI 语言——标题 / 分段标签 / 行内操作按钮与确认文案）。
//
// 语言归属原则（与 scheduler / plan 同源）：跨边界只走数据——renderer 是语言权威，进程只读
// 派生态。locale 读取（readUiLocale）与词典模板渲染机制（t / dictionaryKeys，回落链
// 当前 locale → en-US → 键名）下沉在 `@zhushanwen/pi-llm-shared` 单一实现（ui-locale /
// ui-dictionary），本模块只持有词典数据并经 createUiDictionary 消费机制。
// locale 读取时机 = 每次渲染时读（t 内部 readUiLocale 后回落），与 scheduler widget 臂
// 同款——界面语言切换后下一次推送即生效。
//
// 为什么 widget 构造函数收显式 locale 实参而非内部读：widget 树构造是纯函数（入参出参），
// locale 作为显示决定因素显式入形参，单测可按 locale 精确断言、不依赖进程环境。

import { DEFAULT_UI_LOCALE, readUiLocale } from '@zhushanwen/pi-llm-shared/ui-locale'
import { createUiDictionary } from '@zhushanwen/pi-llm-shared/ui-dictionary'
import type { UiLocale } from '@zhushanwen/pi-llm-shared/ui-locale'

export type { UiLocale }
export { DEFAULT_UI_LOCALE, readUiLocale }

// ── 词典（zh-CN / en-US）──

type Dictionary = Record<string, string>

const ZH_CN: Dictionary = {
  // 托盘面板标题（meta.title，宿主 widget 区 head 渲染）
  'tray.subagent.title': '子代理',
  'tray.workflow.title': '工作流',
  // tab-bar 分段标签（{n} = 该段条数）
  'tray.segment.running': '进行中 {n}',
  'tray.segment.ended': '已结束 {n}',
  // 行内操作按钮（M3 生命周期操作，宿主薄命令）
  'tray.action.cancel': '取消',
  'tray.action.cancelConfirm': '确认取消？',
  'tray.action.retry': '重试',
  'tray.action.abort': '中止',
  'tray.action.abortConfirm': '确认中止？',
  'tray.action.resume': '续跑',
  // interrupted 行状态覆盖字（composer-tray-protocol D3/D8：三值枚举装不下的特殊语义
  // 经 TreeItem.statusLabel 表达——渲染序 = statusLabel ?? 宿主按 status 枚举映射）
  'tray.workflow.interruptedLabel': '已中断（可续跑）',
}

const EN_US: Dictionary = {
  // Tray panel titles (meta.title, rendered by the host widget-zone head)
  'tray.subagent.title': 'Subagents',
  'tray.workflow.title': 'Workflows',
  // tab-bar segment labels ({n} = entry count in that segment)
  'tray.segment.running': 'In progress {n}',
  'tray.segment.ended': 'Ended {n}',
  // Row actions (M3 lifecycle operations, host thin commands)
  'tray.action.cancel': 'Cancel',
  'tray.action.cancelConfirm': 'Confirm cancel?',
  'tray.action.retry': 'Retry',
  'tray.action.abort': 'Abort',
  'tray.action.abortConfirm': 'Confirm abort?',
  'tray.action.resume': 'Resume',
  // Interrupted row status override (composer-tray-protocol D3/D8: semantics beyond the
  // closed three-value enum go through TreeItem.statusLabel — render order =
  // statusLabel ?? host enum mapping)
  'tray.workflow.interruptedLabel': 'Interrupted (resumable)',
}

const { t, dictionaryKeys } = createUiDictionary({ 'zh-CN': ZH_CN, 'en-US': EN_US })

export { t, dictionaryKeys }
