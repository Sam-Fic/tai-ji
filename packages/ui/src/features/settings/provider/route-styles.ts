/**
 * 模型路由页共享样式映射（provider-aggregation U5b）：端点色板与异常 chip 配色，
 * RouteCard / RouteEndpointRow / RouteInlineTimeGrid 三组件消费同一份（一致性 > 各自拼类）。
 *
 * 色板 = CSS 语义变量对应的静态 Tailwind 字面类（JIT 扫描可达，禁硬编码色值）；
 * 行内网格覆盖格底色在 RouteInlineTimeGrid 内以 success 变量直填（Tailwind v3 对 var() 色不支持 /opacity 修饰符）（Tailwind v3
 * 对 var() 色不支持 /opacity 修饰符）。
 */
import type { EndpointIssueKind } from './route-preview'

/** 端点色板（按端点序循环取色）。 */
export const DOT_COLOR_CLASSES = ['bg-accent', 'bg-info', 'bg-warn', 'bg-danger', 'bg-success', 'bg-neutral-fg'] as const

/** 端点序 → 色板类（取模循环）。 */
export function dotColorClass(index: number): string {
  return DOT_COLOR_CLASSES[index % DOT_COLOR_CLASSES.length]!
}

/** 异常 chip 配色：danger 族（删除/移除/缺密钥）红、禁用族黄（warn，仍参与求值）。 */
export function issueChipClass(kind: EndpointIssueKind): string {
  return kind === 'provider-disabled' ? 'bg-warn-soft text-warn' : 'bg-danger-soft text-danger'
}
