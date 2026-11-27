import type { Component } from 'vue'
import {
  Lightbulb,
  BookOpen,
  ChevronRight,
  SquareTerminal,
  Pencil,
  SquareFunction,
  Search,
  Users,
  Workflow,
  ArrowRight,
} from '@lucide/vue'
import type { ToolCallStatus } from '@taiji/shared'

/**
 * block-icon.ts —— trace 块图标映射（Demo H 最终视觉 SSOT）。
 *
 * 9 类 BlockIconKind 对应 trace 流里所有块的图标语义。getBlockIcon 按「状态 > 类型」的
 * 固定优先级决策（running 覆盖一切 → subagent → workflow → toolName 映射）。
 *
 * failed 不换形（demo TurnList.vue:86-89 权威：图标名不随失败态变，仅由消费方
 * headerIconClass 把原工具图标染 danger——原 'failed'→AlertTriangle 换形枚举已删）。
 *
 * BLOCK_ICON_LUCIDE 是 H 最终图标（lightbulb/book-open/square-terminal/pencil/search/users/
 * workflow/arrow-right），统一规格 14×14 / stroke-width 1.7 / currentColor。
 * running 态不走该映射，消费方改用 RunningBlockIcon 动效组件（每类活动专属动效，
 * 字形保留 + accent 动效元素——双环/呼吸弧全类型共用 loader 退役，见 RunningBlockIcon.vue）。
 *
 * 归属：本文件是图标决策的 SSOT（IF1/IF2 契约）。消费方拿 BlockIconKind 后，running 用
 * toolName → 动效 kind 映射（ToolRow.vue TOOL_RUNNING_KIND——Block 壳退役后的现行位置），
 * 其余用 BLOCK_ICON_LUCIDE[kind]。
 */
export type BlockIconKind =
  | 'thinking' | 'tool-read' | 'tool-bash' | 'tool-cmd' | 'tool-edit' | 'tool-grep' | 'tool-other'
  | 'subagent' | 'workflow' | 'running' | 'text'

/**
 * 运行中动效 kind（RunningBlockIcon 消费；与静态档一一对应 + thinking 轨道点）。
 * 独立类型 = 消费方映射表（ToolRow.vue TOOL_RUNNING_KIND / SegmentToolGroup.vue
 * RUN_GROUP_RUNNING_ICON——Block 壳退役后的现行位置）的键域约束。
 */
export type RunningIconKind =
  | 'thinking' | 'tool-read' | 'tool-bash' | 'tool-edit' | 'tool-grep'
  | 'subagent' | 'workflow' | 'tool-other'

/** toolName → tool 细分类映射（未命中的 toolName 走 'tool-other'）。grep/find 探索类
 *  单列 tool-grep（Search 字形 + 透镜扫掠动效），不再落 SquareFunction 兜底。
 *  bash 静态字形 = tool-cmd（裸 › 提示符，2026-10-15 裁决 ③B：成员/单行 bash 抽象化，
 *  波及组内外所有 bash 行——本映射是全局 SSOT）；bash running 态不再走动效图标
 *  （2026-10-17 方案 A 裁决：与完成态同款 tool-cmd 静态箭头，TOOL_RUNNING_KIND 已无
 *  bash 条目）；exec 组头静态仍 tool-bash（RUN_GROUP_ICON 独立映射，SegmentToolGroup.vue
 *  组件本地，不动）。 */
const TOOL_ICON_MAP: Record<string, BlockIconKind> = {
  read: 'tool-read',
  bash: 'tool-cmd',
  edit: 'tool-edit',
  write: 'tool-edit',
  grep: 'tool-grep',
  find: 'tool-grep',
}

/**
 * 决策块图标种类。优先级（覆盖关系）：
 *   status==='running' → running（运行中态覆盖一切，用 loader 动画）
 *   isSubagent         → subagent
 *   isWorkflow         → workflow
 *   否则               → TOOL_ICON_MAP[toolName] ?? 'tool-other'
 * status==='error' 不入决策（MF-1-29 demo 权威：failed 行保持原工具图标，失败信号由
 * 消费方 headerIconClass 染 danger 承担，图标名不变——见 BLOCK_ICON_LUCIDE 上方说明）。
 */
export function getBlockIcon(
  toolName: string,
  status: ToolCallStatus,
  isSubagent: boolean,
  isWorkflow: boolean,
): BlockIconKind {
  if (status === 'running') return 'running'
  if (isSubagent) return 'subagent'
  if (isWorkflow) return 'workflow'
  return TOOL_ICON_MAP[toolName] ?? 'tool-other'
}

/**
 * BlockIconKind → lucide 组件映射（不含 running——running 用 RunningBlockIcon 动效组件）。
 * tool-read=book-open / tool-cmd=chevron-right（bash 静态字形，2026-10-15 裁决 ③B）/
 * tool-bash=square-terminal（exec 组头保留方框终端）/ tool-edit=pencil / tool-grep=search /
 * tool-other=square-function / subagent=users / text=arrow-right。
 * workflow=workflow（lucide Workflow 双节点连线，与 composer slash 菜单 slash-icons.ts 同款——
 * 原独立档 list-checks 与菜单图标不一致，统一到同源字形）。
 * run 组块（run 类型分组）不占独立档：组头图标 = 组类型的语义图标（探索→tool-read /
 * 改动→tool-edit / 执行命令→tool-bash，映射在 SegmentToolGroup.vue 的 RUN_GROUP_ICON——
 * Block 壳退役后的现行权威位置），组身份由
 * 「类型名 + N 步」文案承载，行内有 running 成员时图标位让给 RunningBlockIcon 动效款
 * （组头动效 = 组类别同款，见 RunningBlockIcon）。
 */
export const BLOCK_ICON_LUCIDE: Record<Exclude<BlockIconKind, 'running'>, Component> = {
  thinking: Lightbulb,
  'tool-read': BookOpen,
  'tool-bash': SquareTerminal,
  'tool-cmd': ChevronRight,
  'tool-edit': Pencil,
  'tool-grep': Search,
  'tool-other': SquareFunction,
  subagent: Users,
  workflow: Workflow,
  text: ArrowRight,
}

/**
 * running 态呼吸弧 loader SVG（ui-optimize-unified 决策 11 / N14）。
 * [2026-10 trace 块动效退役] trace 块行头的 running 态已改用 RunningBlockIcon 动效组件
 * （每类活动专属动效，字形保留 + accent 动效元素），块头位置不消费本常量。
 * 本常量是呼吸弧 loader 的唯一副本（SSOT），消费点一律 v-html 引用本常量、禁止手抄
 * 同构 SVG 副本；现行非块头消费点 = TurnRail / BashOutputBlock / MarkdownRenderer /
 * TurnMeta / process-aggregate/AggregateSummaryRow 五处（rail 位置/通知位/摘要行行首
 * 不与块动效同屏争抢）。
 * 浅色轨道整圈 circle r=10 opacity 0.16 + accent 弧段 circle r=10 pathLength=100，
 * viewBox 0 0 24 24，stroke currentColor stroke-width 1.7 / linecap round / linejoin round。
 * 颜色唯一 accent（消费方 text-accent 继承 currentColor），不加发光与缩放脉冲。
 *
 * 两层动画的驱动位置（[perf:animation] 2026-11 由三层降为两层，并再收尾为「仅外层一层」）：
 * - 整体旋转 = 消费方容器 class animate-loader-spin（1.15s/圈 cubic-bezier(.6,.1,.35,.9)，
 *   简写注册在 renderer tailwind.config.ts animation 段）。消费方一律两层 HTML span：
 *   外层 [transform:translateZ(0)] 提层，内层 animate-loader-spin 旋转——[不可合到同一元素]：
 *   keyframes 只写 to，隐式 from = 当前 transform（translateZ(0)），两端同为单位矩阵 → 不转
 *   （2026-11 分支审查探针实测；机器守卫 = check-animation-source-guards.mjs「translateZ(0)
 *   与 animate-* 不同元素」）。will-change 实测无改善。
 * - 弧段：**现为纯静态形态**（无动画）。两条原动画依次退役：① ld-arc-dash
 *   （`stroke-dasharray` 16%↔54% 呼吸）—— stroke 几何属性逐帧重绘矢量、不可合成，且本
 *   常量有 6 个挂点各一份；② ld-arc-swing（150° 摆动）—— 同在 SVG 元素上，同样不可合成
 *   （实测流式场景只停 .ld-arc 一条，GPU helper 37.9%→24.7%），且外层 animate-loader-spin
 *   已提供「在跑」视觉，去之无损语义。dasharray / rotate 现均为固定基态（16 100 / -75°）。
 *   v-html 注入的 SVG 内部元素不带 scoped data-v 属性，Tailwind 类也无法静态命中，
 *   只能全局类声明。
 *
 * prefers-reduced-motion 由 style.css 全局 @media reduce 兜底（animation-duration 0.01ms
 * + iteration 1）：外层旋转瞬切终态——静态呈现「浅色轨道整圈 + 固定相位弧段」，保留形态识别。
 *
 * 浅色轨道 .ld-track / 弧段 .ld-arc class 仅作形态标记，样式一律由 CSS 侧持有，
 * inline 只保留静态属性（opacity/pathLength），保证 v-html 可用。
 */
export const RUNNING_LOADER_SVG: string =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle class="ld-track" cx="12" cy="12" r="10" opacity="0.16"/>' +
  '<circle class="ld-arc" cx="12" cy="12" r="10" pathLength="100"/>' +
  '</svg>'

/**
 * trace 块 header 的 ICON + 前缀文案统一规格（thinking / tool / subagent / workflow 四块共用）。
 *
 * 图标静态档 = --neutral-dim（demo `.tool .sicon { color: var(--dim) }`，workbench.css:378，
 * --dim 即「工具行/元信息」档）；demo 图标无 hover 变色，故不带 hover 类——failed/thinking/
 * running 三状态分支的显式换色不受影响（消费方 headerIconClass / 行内显式类各自覆盖）。
 *
 * 前缀单语言化后必须非 mono、非 uppercase、非 letter-spacing：中文 label 走 mono 会掉回 CJK
 * 字体（英文 mono 的等宽观感消失），tracking 撑开汉字间距正是 DESIGN.md:124/:862 禁的
 * 「uppercase + tracking-wider 装饰文字」。层级由色彩承担而非缩到小字。
 */
export const BLOCK_ICON_CLASS =
  'size-[15px] shrink-0 text-neutral-dim [stroke-width:1.6]'
/** 动作词 label（思考 / 执行工具 / WORKFLOW. / SUBAGENT. 前缀）：字重走 --fw-mid；
 *  颜色落行层级灰 --neutral-mid。字号不在此定档——label 是行主体文字，随 trace 容器
 *  （Turn.vue .trace 的 text-md = 15px）继承，与所在行头其余文字同档。 */
export const BLOCK_LABEL_CLASS =
  'mr-0.5 inline-block shrink-0 whitespace-nowrap [font-weight:var(--fw-mid)] text-neutral-mid'
