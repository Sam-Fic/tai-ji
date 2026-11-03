// src/i18n.ts
//
// subagent-workflow 扩展的 L2 呈现层词典 + locale 读取接线（tray-panel-interact 设计
// §3.3 D9：面板文案随 UI 语言——标题 / 分段标签 / 行内操作按钮与确认文案）。
//
// 语言归属原则（与 scheduler / plan 同源）：跨边界只走数据——renderer 是语言权威，进程只读
// 派生态。读取器（readUiLocale + mtime+size 双键读缓存 + 降级）下沉在
// `@zhushanwen/pi-llm-shared` 单一实现，本模块经 import 消费，不各自就地实现。
// locale 读取时机 = 每次推送时读（推送器 push 内调 readUiLocale 后作实参传给纯构造函数），
// 与 scheduler widget 臂同款——不带缓存失效问题，界面语言切换后下一次推送即生效。
//
// 为什么构造函数收显式 locale 实参而非内部读：widget 树构造是纯函数（入参出参），locale
// 作为显示决定因素显式入形参，单测可按 locale 精确断言、不依赖进程环境（scheduler 的
// buildSchedulerWidgetGui(tasks, locale) 同款）。

import { DEFAULT_UI_LOCALE, readUiLocale } from '@zhushanwen/pi-llm-shared/ui-locale'
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
}

const DICTIONARIES: Record<UiLocale, Dictionary> = {
  'zh-CN': ZH_CN,
  'en-US': EN_US,
}

/** 指定语言的词典 key 集合（测试用于 zh/en 双侧对齐 + 超集断言）。 */
export function dictionaryKeys(locale: UiLocale): string[] {
  return Object.keys(DICTIONARIES[locale])
}

// ── 模板渲染 ──

/**
 * 渲染词典模板。键缺失 → 回落 en 值 → 再回落键名本身（**禁返回空串**）：所有经 `t()`
 * 赋值的字段因此天然非空（`meta.title` 依赖本保证）。占位符缺参时保留 `{name}` 原样（非空）。
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
  locale?: UiLocale,
): string {
  const resolved = locale ?? readUiLocale()
  const template = DICTIONARIES[resolved][key] ?? DICTIONARIES[DEFAULT_UI_LOCALE][key] ?? key
  return interpolate(template, params)
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}
