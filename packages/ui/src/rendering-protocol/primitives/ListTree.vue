<script setup lang="ts">
/**
 * 列表树组件（v7 富行）——递归渲染 TreeItem：每项含可选行号 + icon + label + 可选
 * 副文本 / 状态标签 / 行内操作槽 + 可选 children。
 *
 * v7 富行渲染（composer-tray-protocol §3.4 M2b，D2/D3/D4/D5）——原语级升级，托盘面板 /
 * 浮层 / 抽屉标签页 / chat 工具回执直挂位等全部挂载位统一，不带托盘专属变体参数：
 * - 行四段结构（形态规格 = 设计 AS7 证据 demo v3 行规格文字化）：主名（neutral-fg、
 *   截断）/ 副文本 subLabel（neutral-dim 小字、截断、flex-1）/ 状态胶囊（10px 字、
 *   px-1.5 py-px、rounded-xs 胶囊）/ 行内操作槽（行尾内联）。数值 = demo 独立 HTML
 *   基准换算本仓 tokens 档（--text-3xs/2xs/xs 字号、--radius-xs 胶囊半径、--*-soft
 *   半透明底透明度档），零硬编码颜色/魔数间距。
 * - 状态标签（D3）：文字 = statusLabel（推送方覆盖，如「已中断（可续跑）」）?? 宿主
 *   i18n 按 status 封闭枚举映射（panel.tray.statusLabel.* 词条在 renderer tray 词典族）；
 *   status 与 statusLabel 双无的行不渲染标签（纯文本行现状不变；空串 statusLabel =
 *   未声明，Actionbar confirm 同款口径）。颜色与文字同源取自同一行状态语义：覆盖行仍取
 *   该行 status 枚举色（running accent / done success / failed danger 的 text-* 配
 *   bg-*-soft 半透明底），无 status 行取中性（neutral-dim 文字 + bg-input 弱底，demo
 *   .cstate.idle 同形态）——不引入第二判据。
 * - 行内操作槽（D4）：TreeItem.actions 条目（与 action-bar items 同构，类型引用构造性
 *   保证）行尾内联渲染既有 Actionbar 组件——两段式确认状态机（首击翻确认态 / 再击执行 /
 *   在途禁用）、命令缺失置灰、pin 门控（TRAY_PIN_STATE_KEY 与既有命令行共享同一 provide，
 *   未 pin 时 Actionbar 内部降级纯展示）全部由 Actionbar 内部承载，零重实现。行容器上
 *   @click.stop 阻断冒泡（行 action 与行内按钮互不串扰）；行 button 内嵌 Actionbar 按钮
 *   在 DOM API 渲染路径下合法（本仓 Electron renderer 客户端渲染，无 HTML parser 拆散
 *   窗口）。
 * - 排版升级（D5）：根类去 font-mono 改无衬线（等宽是 v1 TUI 演化遗留，demo v3 定稿即
 *   无衬线）；numbered 序号保留 mono（编辑器行号范式）；v6 的 done 项 label 弱化与
 *   status 圆点退役——状态强调已由胶囊文字承担，主名恒 neutral-fg（demo .cname 规格）。
 * - 缩进 depth × 16px padding-left、递归 children 自动 depth+1、label 单行截断语义不变。
 * - 行点击动作（容器扩展点统一 §6.4）：action 含 commandId/hostAction 的行渲染为原生
 *   button（键盘可达：Tab 聚焦 + Enter/Space 触发，PB-4 探针的构造性承载），点击经
 *   dispatchTreeInteraction 分派（commandId 优先走命令链，hostAction 走容器导航执行器，
 *   与 Actionbar 同源单点）；两执行器均由壳层 provide，缺位时点击静默 no-op（导航目标
 *   的存在性/可打开性校验归 core 执行器，本组件不重复校验）。无 action 的行维持 div
 *   纯展示（旧行为零变化）。
 * - pin 门控（tray-panel-interact §3.3 D6）：读 TRAY_PIN_STATE_KEY 注入（键定义与导出在
 *   Actionbar.vue，本组件 import 同键）。commandId 命令行门控——面板未 pin 时降级为 div
 *   纯展示行（不可点，与 Actionbar 按钮同形态）；hostAction 导航行**不门控**（导航是安全
 *   操作）。注入缺省（undefined，非托盘挂载位）= 门控不生效，行照常可点（RL4 锁定方向）。
 */
import type { TreeItem, TreeItemIcon } from '@zhushanwen/extension-protocol'
import {
  ChevronRight, Check, X, Circle, Dot, Pause, GitBranch,
} from '@lucide/vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import Actionbar from './Actionbar.vue'
import { dispatchTreeInteraction } from '../container-navigation-key'
import { useInteractionExecutors } from '../interaction-executors'

const props = defineProps<{
  items: TreeItem[]
  /** 行首显示弱化序号（index+1）。扁平有序清单（todo）用；自带编号文本勿开（双重编号） */
  numbered?: boolean
  /** 当前层深度（根层=0，递归 children 时 +1）。外部不需传，内部递归自动管理。 */
  depth?: number
}>()

const ICON_MAP: Record<TreeItemIcon, Component> = {
  arrow: ChevronRight,
  check: Check,
  cross: X,
  circle: Circle,
  dot: Dot,
  pause: Pause,
  branch: GitBranch,
}

const { t } = useI18n()

/** 四项注入 + pin 门控派生（与 Actionbar 同构段单点 = interaction-executors）；
 *  显式 undefined 默认值 = 抑制「injection not found」dev 警告（纯展示树零噪音）。 */
const { commandExecutor, navigationExecutor, viewSessionId, pinGated } = useInteractionExecutors()

/** 行是否可点：action 下 commandId / hostAction 至少一个在场（缺省 = 纯展示行，旧行为）。 */
const hasAction = (item: TreeItem): boolean =>
  item.action !== undefined &&
  ((typeof item.action.commandId === 'string' && item.action.commandId !== '') ||
    item.action.hostAction !== undefined)

/** 命令行（commandId 在场即走命令链——与 hostAction 并存时 commandId 优先，分派优先级同源）。 */
const isCommandRow = (item: TreeItem): boolean =>
  typeof item.action?.commandId === 'string' && item.action.commandId !== ''

/** 行是否可点（渲染为原生 button）：有 action，且非「pin 门控中的命令行」。
 *  导航行（仅 hostAction）不门控——导航是安全操作（§3.3 D6）；命令行未 pin 时降级纯展示行。 */
const isClickable = (item: TreeItem): boolean =>
  hasAction(item) && (!isCommandRow(item) || !pinGated.value)

/** 可点行的点击分派（单点 = dispatchTreeInteraction，与 Actionbar 同源；执行器缺位 no-op）。
 *  门控中的命令行已降级为 div 纯展示行（div 上的 click 监听仍会触发），guard 一并拦下。 */
const activate = (item: TreeItem): void => {
  if (!isClickable(item)) return
  dispatchTreeInteraction({
    commandId: item.action?.commandId,
    hostAction: item.action?.hostAction,
    commandExecutor,
    navigationExecutor,
    viewSessionId,
  })
}

type TreeItemStatus = NonNullable<TreeItem['status']>

/** D3 第二档：宿主按 status 封闭枚举的 i18n 映射（词条在 renderer tray 词典族
 *  panel.tray.statusLabel.*；推送方 statusLabel 为第一档覆盖）。 */
const STATUS_ENUM_KEYS: Record<TreeItemStatus, string> = {
  running: 'panel.tray.statusLabel.running',
  done: 'panel.tray.statusLabel.done',
  failed: 'panel.tray.statusLabel.failed',
}

/** D3 状态胶囊文字（渲染序单一：覆盖 ?? 映射）；双无返回 null = 不渲染标签。
 *  空串 statusLabel = 未声明（confirm 同款口径），不触发覆盖档。 */
const statusTextOf = (item: TreeItem): string | null => {
  if (typeof item.statusLabel === 'string' && item.statusLabel !== '') return item.statusLabel
  if (item.status === undefined) return null
  return t(STATUS_ENUM_KEYS[item.status])
}

/** D3 胶囊色与文字同源：有 status 取枚举色（text-* 配 bg-*-soft 半透明底——既有
 *  --*-soft 透明度档 = color-mix 10-12%，对齐 demo rgba 12% 底形态）；无 status 的
 *  覆盖行取中性（neutral-dim 文字 + bg-input 弱底，demo .cstate.idle 同形态）。 */
const STATUS_PILL_CLASS: Record<TreeItemStatus, string> = {
  running: 'bg-accent-soft text-accent',
  done: 'bg-success-soft text-success',
  failed: 'bg-danger-soft text-danger',
}

const statusPillClass = (item: TreeItem): string =>
  item.status ? STATUS_PILL_CLASS[item.status] : 'bg-bg-input text-neutral-dim'

const INDENT_PX = 16
const currentDepth = () => props.depth ?? 0
const depthPadding = () => ({ paddingLeft: `${currentDepth() * INDENT_PX}px` })
</script>

<template>
  <div class="list-tree text-[length:var(--text-xs)] leading-relaxed" data-testid="gui-list-tree">
    <template v-for="(item, i) in items" :key="i">
      <!-- 可点行 = 原生 button（键盘可达 + 语义正确）；纯展示行 = div（旧行为）；
           pin 门控中的命令行降级 div（与 Actionbar 按钮同形态） -->
      <component
        :is="isClickable(item) ? 'button' : 'div'"
        class="list-tree__item flex items-center gap-1.5"
        :class="isClickable(item) ? 'w-full cursor-pointer text-left hover:bg-surface-hover' : ''"
        :type="isClickable(item) ? 'button' : undefined"
        :style="depthPadding()"
        :data-testid="isClickable(item) ? `gui-list-tree-action-${i}` : undefined"
        @click="activate(item)"
      >
        <!-- numbered：行首弱化序号（编辑器行号范式，占据 icon 槽位；D5 下保留 mono） -->
        <span v-if="numbered" class="w-4 shrink-0 text-right font-mono text-[length:var(--text-3xs)] tabular-nums text-neutral-dim">
          {{ i + 1 }}
        </span>
        <span v-else class="list-tree__icon flex w-3.5 shrink-0 justify-center">
          <component
            v-if="item.icon"
            :is="ICON_MAP[item.icon]"
            class="size-3"
          />
        </span>
        <!-- 主名（AS7 .cname：fg 色、截断；done 弱化已由胶囊承担，恒 neutral-fg） -->
        <span class="min-w-0 truncate text-neutral-fg">{{ item.label }}</span>
        <!-- 副文本（AS7 .csub：dim 小字、截断、flex:1；空串 = 无副文本） -->
        <span
          v-if="item.subLabel"
          data-testid="list-tree-sub-label"
          class="min-w-0 flex-1 truncate text-[length:var(--text-2xs)] text-neutral-dim"
        >{{ item.subLabel }}</span>
        <!-- 状态胶囊（D3：statusLabel ?? i18n 枚举；双无不渲染，纯文本行现状） -->
        <span
          v-if="statusTextOf(item) !== null"
          data-testid="list-tree-status"
          class="list-tree__status shrink-0 rounded-xs px-1.5 py-px text-[length:var(--text-3xs)]"
          :class="statusPillClass(item)"
        >{{ statusTextOf(item) }}</span>
        <!-- 行内操作槽（D4：复用 Actionbar 两段式确认与 pin 门控；stop 防行点击串扰） -->
        <span
          v-if="item.actions && item.actions.length > 0"
          class="ml-auto flex shrink-0 items-center"
          @click.stop
        >
          <Actionbar :items="item.actions" />
        </span>
      </component>
      <!-- 递归渲染 children：depth + 1 自动缩进（children 层不开序号） -->
      <template v-if="item.children && item.children.length > 0">
        <ListTree :items="item.children" :depth="currentDepth() + 1" />
      </template>
    </template>
  </div>
</template>
