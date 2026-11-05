/**
 * 交互原语共享接线 —— action-bar（Actionbar.vue）与 list-tree（ListTree.vue）两原语
 * 同构注入段的单点（容器扩展点统一 §6.4 + tray-panel-interact §3.3 D6）。
 *
 * 四项注入（命令执行器 / 容器导航执行器 / 视图会话 / pin 门控）+ 门控派生在两原语中
 * 形状完全同构，收敛在本 composable 单点；分派调用（dispatchTreeInteraction）留在各
 * 组件——两原语的分派输入形状不同（action-bar 带 args 与 confirm 相位机，list-tree 从
 * item.action 取字段），只有接线是共享面。
 *
 * TRAY_PIN_STATE_KEY（pin 门控注入键）随接线一并持于此文件：原定义在 Actionbar.vue
 * （首个消费方），接线下沉后若键留原处，本文件 import Actionbar.vue 会形成
 * Actionbar ⇄ 本文件的模块环（fall-out：circular-dependencies 门禁 FAIL）——键与它的
 * 唯一消费接线同居一处，经 barrel 导出给壳层 provide（symbol 必须跨包同一实例）。
 *
 * pin 门控值语义（缺省方向由 RL4 单测锁定，禁反向——它是既有 scheduler-manager 行为零
 * 变化的保证）：
 * - undefined（未注入）= 非托盘挂载位（浮层 ViewHost 的 scheduler-manager 面板等）=
 *   门控不生效，按钮照常渲染可点；
 * - false = 面板 hover 未固定 = 交互项降级纯展示；
 * - true = 已 pin = 正常交互。
 *
 * 响应式契约：pinned 是外壳交互态（点图标即变），宿主必须 provide 响应式源
 * （computed(() => props.pinned) 或 toRef(props, 'pinned')）——provide 只在 setup 执行一次，
 * 静态布尔无法随 pin 翻转更新；inject 不做 ref 自动解包，故本侧 unref 归一（静态布尔亦兼容）。
 */
import { computed, inject, unref } from 'vue'
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import { ACTION_EXECUTOR_KEY, type ActionExecutor } from './action-executor-key'
import {
  CONTAINER_NAVIGATION_KEY,
  VIEW_SCOPE_SESSION_KEY,
  type ContainerNavigationExecutor,
} from './container-navigation-key'

/**
 * pin 门控注入键——托盘 widget 面板的「交互态」注入契约：外壳（TrayPanelSurface →
 * TrayWidgetPanel）provide 当前面板的 pinned 位，交互原语（Actionbar 与 ListTree）读它
 * 决定交互项是否降级纯展示（hover 防误触，GL4）。键 symbol 必须跨包同一实例，故经
 * barrel 导出给壳层 provide。
 */
export const TRAY_PIN_STATE_KEY: InjectionKey<boolean | Ref<boolean> | undefined> = Symbol('tray-pin-state')

/** 交互原语共享接线产物（注入值 + 门控派生；分派调用在各组件）。 */
export interface InteractionExecutors { // oe-exempt:20261105:framework:composable 返回形状契约（两原语共享接线单点 useInteractionExecutors）
  /** 宿主命令执行器（壳层 provide；缺位 = 命令链不可用，组件侧按需降级出声）。 */
  commandExecutor: ActionExecutor | undefined
  /** 容器导航执行器（壳层 provide；缺位 = 导航 no-op，存在性校验归 core 执行器）。 */
  navigationExecutor: ContainerNavigationExecutor | undefined
  /** 组件树所属视图的会话（ViewHost provide；无宿主 = undefined → 执行器回退焦点会话）。 */
  viewSessionId: string | undefined
  /** 门控生效 = 注入值显式为 false（未 pin）；undefined（缺省）/ true 均不门控。 */
  pinGated: ComputedRef<boolean>
}

/**
 * 交互原语共享接线（setup 内调用）：四个 inject 显式 undefined 默认值 = 抑制
 * 「injection not found」dev 警告（纯展示场景零噪音）；命令执行器缺位的降级出声、
 * 导航缺位的静默 no-op 等组件侧行为由各原语自行承担（接线只取值）。
 */
export function useInteractionExecutors(): InteractionExecutors {
  const commandExecutor = inject(ACTION_EXECUTOR_KEY, undefined)
  const navigationExecutor = inject(CONTAINER_NAVIGATION_KEY, undefined)
  const viewSessionId = inject(VIEW_SCOPE_SESSION_KEY, undefined)
  const trayPinState = inject(TRAY_PIN_STATE_KEY, undefined)
  const pinGated = computed(() => unref(trayPinState) === false)
  return { commandExecutor, navigationExecutor, viewSessionId, pinGated }
}
