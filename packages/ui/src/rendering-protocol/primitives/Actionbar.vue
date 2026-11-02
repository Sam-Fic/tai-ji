<script lang="ts">
/**
 * pin 门控注入键（tray-panel-interact §3.3 D6）——托盘 widget 面板的「交互态」注入契约：
 * 外壳（TrayPanelSurface → TrayWidgetPanel）provide 当前面板的 pinned 位，交互原语
 * （Actionbar 与 ListTree）读它决定交互项是否降级纯展示（hover 防误触，GL4）。
 *
 * 值语义（缺省方向由 RL4 单测锁定，禁反向——它是既有 scheduler-manager 行为零变化的保证）：
 * - undefined（未注入）= 非托盘挂载位（浮层 ViewHost 的 scheduler-manager 面板等）=
 *   门控不生效，按钮照常渲染可点；
 * - false = 面板 hover 未固定 = 交互项降级纯展示；
 * - true = 已 pin = 正常交互。
 *
 * 响应式契约：pinned 是外壳交互态（点图标即变），宿主必须 provide 响应式源
 * （computed(() => props.pinned) 或 toRef(props, 'pinned')）——provide 只在 setup 执行一次，
 * 静态布尔无法随 pin 翻转更新；inject 不做 ref 自动解包，故原语侧 unref 归一（静态布尔亦兼容）。
 * 键定义在本组件（首个消费方）并经 barrel 导出给壳层 provide——symbol 必须跨包同一实例；
 * ListTree import 同键（同 territory 闭环，不另立 key 文件）。
 */
import type { InjectionKey, Ref } from 'vue'

export const TRAY_PIN_STATE_KEY: InjectionKey<boolean | Ref<boolean> | undefined> = Symbol('tray-pin-state')
</script>

<script setup lang="ts">
/**
 * 操作按钮栏（AP-3）——GuiComponent 协议首个交互原语。
 *
 * 交互契约（设计 §3.3 D2 + 容器扩展点统一 §6.4）：点击走两条宿主执行路径——
 * commandId 经 ACTION_EXECUTOR_KEY 注入的命令执行器走既有命令链（commandRegistry.execute →
 * WS plugin.executeCommand）；hostAction 经 CONTAINER_NAVIGATION_KEY 注入的容器导航执行器
 * 请求宿主打开容器（校验与状态写入在 core 执行器，两 key 均由壳层 provide 真实实现）。
 * 两者并存时 commandId 优先（分派单点 = dispatchTreeInteraction，与 ListTree 同源）。
 *
 * item 三态：
 * - 按钮（有 commandId 或 hostAction）：复用 @taiji/ui Button（ghost 档；kind:'danger' 走 danger
 *   档——确认闸是插件侧产品判断、宿主按 confirm 声明渲染两段式，不擅自加闸）。disabled=true
 *   或所需执行器缺位 → Button 禁用（视觉禁用 + 组件内 guard 双重拦截，不依赖宿主对
 *   disabled button 吞事件的浏览器行为）。
 * - 纯展示（两字段缺省）：span 弱化文本，非按钮语义、不可点。
 *
 * pin 门控（tray-panel-interact §3.3 D6）：面板未 pin（注入值 false）时交互项整体降级为上述
 * 纯展示 span——hover 浏览零误触（GL4）；已 pin（true）或注入缺省（undefined，非托盘挂载位）
 * 时照常渲染可点按钮。注入键 TRAY_PIN_STATE_KEY 在本文件定义并经 barrel 导出（壳层
 * TrayWidgetPanel provide；ListTree import 同键，同 territory 闭环）。
 *
 * confirm 两段式（tray-panel-interact §3.3 D5）——插件在 item.confirm 声明确认文案，宿主
 * 按声明渲染状态机（pin 门控生效时交互项已无可点形态，两段式不进入——门控是形态降级的上游）：
 * - idle：照常渲染，点击即执行（未声明 confirm 的 item 恒停留在此态 = 旧行为）。
 * - confirming（首击后）：按钮翻 danger 档 + 显示 confirm 文案（替代原 label）。
 * - in-flight（再击后）：按钮禁用 + 转圈指示，防重复 RPC；直至回执到达或记录重推
 *   重建按钮实例（推送新 items 时确认态自然复位）。
 * 复位：超时（CONFIRM_TIMEOUT_MS）或指针离开按钮区域即回 idle——确认是面板本地瞬态，
 * 不跨推送保持（重推重建实例即终止在途态，无需跨树保持）。
 *
 * 执行器缺位（standalone 挂载 / 壳层未 provide）：所需执行器缺位的交互项禁用 + warn 一次
 * （对齐 TabBar 降级出声范式——降级 ≠ 吞错）；纯展示项（含 pin 门控中降级的项——已无可点
 * 形态，本就不需要执行器）不出声。
 *
 * 降级契约（D8）：未含本 type 的旧宿主由 core resolveComponent 降级 ansi-text
 * （label 经 JSON 序列化保留可读，P5 断言），本组件不参与降级决策。**旧宿主忽略 confirm
 * 字段 = 按钮照常渲染、点击即执行**（新增可选字段不 bump PROTOCOL_VERSION，与 action-bar
 * type 本身的降级先例同款；协议侧降级矩阵由 extension-protocol navigation-types.test.ts 锁定）。
 */
import { computed, inject, onBeforeUnmount, ref, unref, watch } from 'vue'
import { Loader2 } from '@lucide/vue'
import type { GuiComponentProps } from '@zhushanwen/extension-protocol'
import Button from '../../primitives/button/Button.vue'
import { ACTION_EXECUTOR_KEY } from '../action-executor-key'
import {
  CONTAINER_NAVIGATION_KEY,
  VIEW_SCOPE_SESSION_KEY,
  dispatchTreeInteraction,
} from '../container-navigation-key'

type ActionBarItem = GuiComponentProps['action-bar']['items'][number]

/** 单 item 的 confirm 本地状态机：idle → confirming → in-flight（终态由重推/超时复位）。 */
type ConfirmPhase = 'idle' | 'confirming' | 'in-flight'

/** 确认态超时：超时后自动复位 idle（防确认态长期滞留造成误触第二击）。 */
const CONFIRM_TIMEOUT_MS = 5000

const props = defineProps<{
  items: GuiComponentProps['action-bar']['items']
}>()

/** 宿主执行器（壳层 provide）；显式 undefined 默认值 = 抑制「injection not found」
 *  dev 警告（纯展示场景零噪音），缺位退化由下方 warn 承担（TabBar 同款范式）。 */
const commandExecutor = inject(ACTION_EXECUTOR_KEY, undefined)
const navigationExecutor = inject(CONTAINER_NAVIGATION_KEY, undefined)
/** 组件树所属视图的会话（ViewHost provide；无宿主 = undefined → 执行器回退焦点会话）。 */
const viewSessionId = inject(VIEW_SCOPE_SESSION_KEY, undefined)
/** pin 门控状态（托盘面板外壳 provide；缺省 undefined = 非托盘挂载位 = 门控不生效，RL4）。 */
const trayPinState = inject(TRAY_PIN_STATE_KEY, undefined)
/** 门控生效 = 注入值显式为 false（未 pin）；undefined（缺省）/ true 均不门控。 */
const pinGated = computed(() => unref(trayPinState) === false)

const hasCommand = (item: ActionBarItem): boolean =>
  typeof item.commandId === 'string' && item.commandId !== ''
const hasHostAction = (item: ActionBarItem): boolean => item.hostAction !== undefined
const isExecutable = (item: ActionBarItem): boolean => hasCommand(item) || hasHostAction(item)
/** confirm 声明且非空串才进两段式（空串 = 未声明，维持点击即执行）。 */
const hasConfirm = (item: ActionBarItem): boolean =>
  typeof item.confirm === 'string' && item.confirm !== ''

/** 所需执行器是否齐备：commandId 项要命令执行器；仅 hostAction 项要导航执行器
 *  （并存时按 commandId 优先分派，hostAction 为冗余声明，只要求命令执行器）。 */
const executorReady = (item: ActionBarItem): boolean => {
  if (hasCommand(item)) return commandExecutor !== undefined
  return navigationExecutor !== undefined
}

// ── confirm 两段式状态机（D5）──
/** 每 item 的本地相位（key = item.id）；只对 hasConfirm 的项有意义。 */
const phases = ref<Record<string, ConfirmPhase>>({})
/** 每 item 的超时 timer 句柄（复位确认态用；离开/再击/重推时清）。 */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

const phaseOf = (item: ActionBarItem): ConfirmPhase => phases.value[item.id] ?? 'idle'

const clearTimer = (id: string): void => {
  const t = timers.get(id)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(id)
  }
}

/** 进确认态 + 起超时（超时回 idle）。timeout 句柄随组件卸载/重推清理。 */
const enterConfirming = (id: string): void => {
  clearTimer(id)
  phases.value = { ...phases.value, [id]: 'confirming' }
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      if (phases.value[id] === 'confirming') {
        phases.value = { ...phases.value, [id]: 'idle' }
      }
    }, CONFIRM_TIMEOUT_MS),
  )
}

/** 指针离开按钮区域 = 用户放弃本次确认 → 复位 idle（防悬停误触后第二击）。 */
const resetConfirm = (item: ActionBarItem): void => {
  if (!hasConfirm(item)) return
  clearTimer(item.id)
  if (phases.value[item.id] === 'confirming') {
    phases.value = { ...phases.value, [item.id]: 'idle' }
  }
}

/** 点击：组件内 guard 是唯一权威防线（不依赖宿主对 disabled button 吞事件的浏览器行为），
 *  与 :disabled 属性双重一致。args 原样透传（协议层只许标量，校验在协议入口）。
 *  confirm 项两段式：首击翻确认态（不执行），再击进在途态并执行；在途态重复点击被
 *  guard 直接拦下（与 disabled 属性双重一致，防重复 RPC）。 */
const activate = (item: ActionBarItem): void => {
  if (item.disabled === true || !isExecutable(item) || !executorReady(item)) return
  if (hasConfirm(item)) {
    const phase = phaseOf(item)
    if (phase === 'idle') {
      enterConfirming(item.id)
      return
    }
    // 在途态（执行中）重复点击：组件内 guard 拦截，不等浏览器吞事件
    if (phase === 'in-flight') return
    // confirming = 再击确认执行：清超时（执行后不再自动复位），进在途态禁用防重复 RPC
    clearTimer(item.id)
    phases.value = { ...phases.value, [item.id]: 'in-flight' }
  }
  dispatchTreeInteraction({
    commandId: item.commandId,
    args: item.args,
    hostAction: item.hostAction,
    commandExecutor,
    navigationExecutor,
    viewSessionId,
  })
}

/** 按钮是否禁用：协议 disabled / 执行器缺位 / confirm 在途态（三源合一）。 */
const isDisabled = (item: ActionBarItem): boolean =>
  item.disabled === true || !executorReady(item) || phaseOf(item) === 'in-flight'

/** 视觉档位：协议 danger 或 confirm 确认态 → danger 档（危险操作的视觉确认信号）。 */
const variantOf = (item: ActionBarItem): 'danger' | 'ghost' =>
  item.kind === 'danger' || phaseOf(item) === 'confirming' ? 'danger' : 'ghost'

/** 按钮文本：确认态显 confirm 文案（替代原 label），其余态显 label。 */
const labelOf = (item: ActionBarItem): string =>
  hasConfirm(item) && phaseOf(item) === 'confirming' ? (item.confirm as string) : item.label

/** 在途态转圈指示（用户可见的执行中反馈；disabled + pointer-events-none 防重复点击）。 */
const isInFlight = (item: ActionBarItem): boolean => phaseOf(item) === 'in-flight'

/** 降级出声：存在所需执行器缺位的交互项 → warn 一次（防每次推送刷屏）。
 *  pin 门控中的项已降级纯展示（无可点形态、不需要执行器），不参与出声。 */
const hasBlockedExecutableItem = computed(() =>
  props.items.some((i) => isExecutable(i) && !pinGated.value && !executorReady(i)),
)
let warnedNoExecutor = false
watch(hasBlockedExecutableItem, (has) => {
  if (!has) {
    warnedNoExecutor = false
    return
  }
  if (warnedNoExecutor) return
  warnedNoExecutor = true
  console.warn(
    '[gui-action-bar] items 含 commandId/hostAction 但所需执行器未注入（命令链 ACTION_EXECUTOR_KEY / 容器导航 CONTAINER_NAVIGATION_KEY），交互项已禁用。修复：宿主壳层 provide 对应 key（@taiji/ui/rendering-protocol）',
  )
}, { immediate: true })

// 推送重建（新 items 数组 = 记录重推）：确认态与超时随旧实例一起失效——清句柄防泄漏。
// 新树里同 id 项回到 idle（在途态自然终止，无需跨树保持）。
watch(
  () => props.items,
  () => {
    for (const id of [...timers.keys()]) clearTimer(id)
    phases.value = {}
  },
)

onBeforeUnmount(() => {
  for (const id of [...timers.keys()]) clearTimer(id)
})
</script>

<template>
  <div class="action-bar flex flex-wrap items-center gap-2" data-testid="gui-action-bar">
    <template v-for="item in items" :key="item.id">
      <!-- 按钮（有 commandId 或 hostAction 且未被 pin 门控）：danger 档走 Button 危险样式；所需执行器缺位/在途态禁用 -->
      <Button
        v-if="isExecutable(item) && !pinGated"
        size="dense"
        :variant="variantOf(item)"
        :disabled="isDisabled(item)"
        :data-testid="`gui-action-bar-item-${item.id}`"
        :data-confirm-phase="phaseOf(item)"
        @click="activate(item)"
        @mouseleave="resetConfirm(item)"
      >
        <Loader2 v-if="isInFlight(item)" class="size-3.5 animate-spin" data-testid="gui-action-bar-item-spinner" />
        {{ labelOf(item) }}
      </Button>
      <!-- 纯展示（两字段缺省，或 pin 门控中的交互项）：span 弱化文本，非按钮语义、天然不可点 -->
      <span
        v-else
        class="text-sm text-neutral-dim"
        :data-testid="`gui-action-bar-item-${item.id}`"
      >
        {{ item.label }}
      </span>
    </template>
  </div>
</template>
