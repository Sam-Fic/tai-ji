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
 * 时照常渲染可点按钮。注入键 TRAY_PIN_STATE_KEY 与四项接线在 interaction-executors 单点
 * （ListTree 同构共用），键经 barrel 导出给壳层（TrayWidgetPanel）provide。
 *
 * confirm 两段式（tray-panel-interact §3.3 D5）——插件在 item.confirm 声明确认文案，宿主
 * 按声明渲染状态机（pin 门控生效时交互项已无可点形态，两段式不进入——门控是形态降级的上游）：
 * - idle：照常渲染，点击即执行（未声明 confirm 的 item 恒停留在此态 = 旧行为）。
 * - confirming（首击后）：按钮翻 danger 档 + 显示 confirm 文案（替代原 label）。
 * - in-flight（再击后）：按钮禁用 + 转圈指示，防重复 RPC；直至回执到达或记录重推
 *   重建按钮实例（推送新 items 时确认态自然复位）。
 * 复位：超时（CONFIRM_TIMEOUT_MS）或指针离开按钮区域即回 idle——确认是面板本地瞬态，
 * 不跨推送保持（重推重建实例即终止在途态，无需跨树保持）。
 * 回执 settle（D5）：在途态的分派回执可能是 Promise（壳层 execute 透传 RPC Promise）——
 * reject（RPC 失败，WS 断连即触发）或 resolve false（命令缺失）时相位复位 idle 并走
 * 命令缺失置灰通道（RL2）给可见反馈；resolve（命令已执行）留在在途态直至重推。只吞
 * 回执不消费时（旧形态 void 丢弃 Promise），失败后无重推即永久滞留转圈+禁用。
 *
 * 执行器缺位（standalone 挂载 / 壳层未 provide）：所需执行器缺位的交互项禁用 + warn 一次
 * （对齐 TabBar 降级出声范式——降级 ≠ 吞错）；纯展示项（含 pin 门控中降级的项——已无可点
 * 形态，本就不需要执行器）不出声。
 *
 * 命令缺失置灰（tray-panel-interact §4.2 RL2）：点击后命令执行器回报 false（壳层命令表
 * 查无此 commandId，HeaderActionsHost E3 同款先例）→ 该项本地置灰 + guard 拦再击——
 * 误指/未注册 commandId 不静默失效（ERR6 已在执行链内出声，置灰是用户可见的后续反馈）；
 * 同步 false 与异步回执 resolve false / reject（RPC 失败）同走此通道。随推送重建复位
 * （命令重注册 / 连接恢复重推后恢复可点）。
 *
 * 降级契约（权威描述见 docs/architecture/extension-gui-protocol.md「降级行为」节）：
 * 未含本 type 的旧宿主由 core resolveComponent 降级 ansi-text（label 经 JSON 序列化
 * 保留可读），本组件不参与降级决策。**旧宿主忽略 confirm
 * 字段 = 按钮照常渲染、点击即执行**（新增可选字段不 bump PROTOCOL_VERSION，与 action-bar
 * type 本身的降级先例同款；协议侧降级矩阵由 extension-protocol navigation-types.test.ts 锁定）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Loader2 } from '@lucide/vue'
import type { GuiComponentProps } from '@zhushanwen/extension-protocol'
import Button from '../../primitives/button/Button.vue'
import { dispatchTreeInteraction } from '../container-navigation-key'
import { useInteractionExecutors } from '../interaction-executors'

type ActionBarItem = GuiComponentProps['action-bar']['items'][number]

/** 单 item 的 confirm 本地状态机：idle → confirming → in-flight（终态由回执 settle / 重推 / 超时复位）。 */
type ConfirmPhase = 'idle' | 'confirming' | 'in-flight'

/** 确认态超时：超时后自动复位 idle（防确认态长期滞留造成误触第二击）。 */
const CONFIRM_TIMEOUT_MS = 5000

const props = defineProps<{
  items: GuiComponentProps['action-bar']['items']
}>()

/** 四项注入 + pin 门控派生（与 ListTree 同构段单点 = interaction-executors）。 */
const { commandExecutor, navigationExecutor, viewSessionId, pinGated } = useInteractionExecutors()

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

// ── 命令缺失本地置灰（tray-panel-interact §4.2 RL2）──
/** 点击后命令执行器回报 false（壳层命令表查无此 commandId，HeaderActionsHost E3 同款）→
 *  记入本地置灰集合：按钮渲染禁用 + guard 拦再击。ERR6 已在执行链内出声（不静默），
 *  置灰是用户可见的后续反馈。同步 false 与异步回执（resolve false / RPC reject）同走此
 *  通道（markCommandMissing，后者同时把在途态复位 idle）。随推送重建复位（命令重注册 /
 *  连接恢复重推后恢复可点，同 HeaderActionsHost E3 让位规则的简化形态）。 */
const commandMissing = ref(new Set<string>())

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
 *  guard 直接拦下（与 disabled 属性双重一致，防重复 RPC）。
 *  命令缺失置灰项同样被 guard 拦下（已出声过 ERR6，重复点击不再分派）。
 *  回执 settle（tray-panel-interact §3.3 D5）：dispatch 可能回 Promise（壳层执行器透传
 *  RPC Promise）——落地后 reject 或 resolve false 时把在途态复位 idle 并走置灰通道
 *  （markCommandMissing），防 RPC 失败（WS 断连）后无重推、按钮永久滞留转圈+禁用；
 *  resolve（命令已执行）留在在途态直至记录重推重建（防重复 RPC 的设计语义不变）。 */
const activate = (item: ActionBarItem): void => {
  if (item.disabled === true || !isExecutable(item) || !executorReady(item)) return
  if (commandMissing.value.has(item.id)) return
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
  const dispatched = dispatchTreeInteraction({
    commandId: item.commandId,
    args: item.args,
    hostAction: item.hostAction,
    commandExecutor,
    navigationExecutor,
    viewSessionId,
  })
  // 执行器同步回报命令缺失（false）→ 本地置灰（RL2 渲染禁用）
  if (dispatched === false) {
    markCommandMissing(item)
    return
  }
  // 异步回执（壳层 execute 透传的 RPC Promise）：settle 后按结果处理（见函数头注释）。
  // 同步 void（执行器不回报，如 settings 插件 fork 直发执行器）不进本路径，行为不变。
  if (dispatched instanceof Promise) {
    void dispatched.then(
      (ok) => {
        if (ok === false) markCommandMissing(item)
      },
      () => markCommandMissing(item),
    )
  }
}

/** 命令缺失/执行失败的本地置灰（RL2）：记入置灰集合（渲染禁用 + guard 拦再击），并把
 *  在途态相位复位 idle——失败后按钮脱离「永久转圈 + 禁用」，随推送重建恢复可点
 *  （命令重注册 / 连接恢复重推后自然复位，同 HeaderActionsHost E3 让位规则）。 */
const markCommandMissing = (item: ActionBarItem): void => {
  commandMissing.value.add(item.id)
  if (phases.value[item.id] === 'in-flight') {
    phases.value = { ...phases.value, [item.id]: 'idle' }
  }
}

/** 按钮是否禁用：协议 disabled / 执行器缺位 / confirm 在途态 / 命令缺失置灰（四源合一）。 */
const isDisabled = (item: ActionBarItem): boolean =>
  item.disabled === true ||
  !executorReady(item) ||
  phaseOf(item) === 'in-flight' ||
  commandMissing.value.has(item.id)

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
// 新树里同 id 项回到 idle（在途态自然终止，无需跨树保持）；命令缺失置灰同步复位
// （命令重注册后随下帧恢复可点，同 HeaderActionsHost E3 让位规则的简化形态）。
watch(
  () => props.items,
  () => {
    for (const id of [...timers.keys()]) clearTimer(id)
    phases.value = {}
    commandMissing.value = new Set()
  },
)

onBeforeUnmount(() => {
  for (const id of [...timers.keys()]) clearTimer(id)
})
</script>

<template>
  <div class="action-bar flex flex-wrap items-center gap-2" data-testid="gui-action-bar">
    <template v-for="item in items" :key="item.id">
      <!-- 按钮（有 commandId 或 hostAction 且未被 pin 门控）：danger 档走 Button 危险样式；执行器缺位/在途态/命令缺失置灰禁用 -->
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
