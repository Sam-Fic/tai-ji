<script setup lang="ts">
/**
 * 列表树组件（v6）——替代 TUI 的 ⎿ ├─ └─ 缩进。
 * 递归渲染 TreeItem：每项含可选行号 + icon + label + 可选 status 圆点 + 可选 children。
 *
 * v6 改造（§3.4）：
 * - 缩进 depth × 16px padding-left（从 20px 收，留白档优于 border-l 引导线）。
 * - icon size-3(12px) 对齐 trace 档，去 statusClass 着色改中性（继承 label neutral-mid），
 *   状态信息全部由圆点承担（单一信息源，避免 icon 与 status 双重表达）。
 * - status 从文字标签改为 7px 圆点（done→bg-success / running→bg-accent / failed→bg-danger），
 *   margin-left:auto 右对齐（对齐 §3.3 状态指示范式）。
 * - done 项 label 降为 neutral-dim（终态弱化，与 ProgressBar「done 中性化」同哲学：
 *   圆点承载状态色，亮度承载强调层级——非第二状态指示）。
 * - numbered（v1.1）：行首弱化 mono 序号（1/2/3…，编辑器行号范式）。扁平有序清单用；
 *   icon 与序号互斥（序号占据 icon 槽位，避免行首双元素）。
 * - 递归 depth 逻辑不变。
 * - label 截断（2026-10-19 优化）：min-w-0 + flex-1 + truncate 单行截断——todo 文本 /
 *   goal success criteria / scheduler 任务行都经本原语渲染，长行此前会撑破托盘浮层；
 *   截断后全文仍由消费方（浮层行 title / aria）承载，本原语只负责视觉不溢出。
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
import { computed, inject, unref } from 'vue'
import { ACTION_EXECUTOR_KEY } from '../action-executor-key'
import { TRAY_PIN_STATE_KEY } from './Actionbar.vue'
import {
  CONTAINER_NAVIGATION_KEY,
  VIEW_SCOPE_SESSION_KEY,
  dispatchTreeInteraction,
} from '../container-navigation-key'

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

/** 命令执行器与容器导航执行器（壳层 provide，ViewHost 递归子实例沿父链取同一实例）；
 *  显式 undefined 默认值 = 抑制「injection not found」dev 警告（纯展示树零噪音）。 */
const commandExecutor = inject(ACTION_EXECUTOR_KEY, undefined)
const navigationExecutor = inject(CONTAINER_NAVIGATION_KEY, undefined)
const viewSessionId = inject(VIEW_SCOPE_SESSION_KEY, undefined)
/** pin 门控状态（托盘面板外壳 provide；缺省 undefined = 非托盘挂载位 = 门控不生效，RL4）。 */
const trayPinState = inject(TRAY_PIN_STATE_KEY, undefined)
/** 门控生效 = 注入值显式为 false（未 pin）；undefined（缺省）/ true 均不门控。 */
const pinGated = computed(() => unref(trayPinState) === false)

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

/** v6：status → 圆点 bg 色（done=success / running=accent / failed=danger）。 */
const statusDotClass = (status?: TreeItem['status']) => {
  if (!status) return ''
  const map = { running: 'bg-accent', done: 'bg-success', failed: 'bg-danger' } as const
  return map[status]
}

/** v6：done 项 label 终态弱化（同光标行高亮哲学——完成的项让位给进行中的项）。 */
const labelClass = (status?: TreeItem['status']) =>
  status === 'done' ? 'text-neutral-dim' : 'text-neutral-mid'

const INDENT_PX = 16
const currentDepth = () => props.depth ?? 0
const depthPadding = () => ({ paddingLeft: `${currentDepth() * INDENT_PX}px` })
</script>

<template>
  <div class="list-tree font-mono text-[length:var(--text-sm)] leading-relaxed" data-testid="gui-list-tree">
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
        <!-- numbered：行首弱化序号（编辑器行号范式，占据 icon 槽位） -->
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
        <span :class="['min-w-0 flex-1 truncate', labelClass(item.status)]">{{ item.label }}</span>
        <span
          v-if="item.status"
          data-testid="list-tree-status"
          class="list-tree__status ml-auto size-[7px] shrink-0 rounded-full"
          :class="statusDotClass(item.status)"
        />
      </component>
      <!-- 递归渲染 children：depth + 1 自动缩进（children 层不开序号） -->
      <template v-if="item.children && item.children.length > 0">
        <ListTree :items="item.children" :depth="currentDepth() + 1" />
      </template>
    </template>
  </div>
</template>
