<!--
  TrayPanelSurface —— 托盘条目浮层的统一外壳（ComposerTray 的 built-in 分支与 widget 分支共用）。

  浮层形态契约（设计 §3.3 D8 + 固定高裁决 2026-09-16 + U3 热区修复 + M4b demo 对齐）：
  - 锚定 icon 上方（side="top"）、宽 400px 由外壳给、锚距 10px（demo .composer .popover
    bottom: calc(100% + 10px)，workbench.css 权威）；
  - [窄视口钳制] 追加 `max-w-[calc(100vw-16px)]`（仓内 CommandPopover / AmbiguousFilePopover
    同款）：固定宽 400px 在视口 < ~416px 时右侧被裁（reka 碰撞位移也救不回一个比视口还宽的面板），
    上限收到视口 −16px 后面板自身收窄即可完整落在视口内；`min-w-0` 解掉包装层 `min-w-[240px]`
    在极窄视口下反过来压过 max-width 的优先级问题（min-width 在 CSS 里胜出）。
  - 浮层容器形态（2026-10-13 用户裁决 demo 方案 A 全族迁移后）：底/边随 PopoverContent
    基类 = bg-bg + border（composer 同源档，旧 bg-elevated 浮层档 + border-strong 边退役——
    elevated 容器比行 hover 的 surface-hover 亮，hover 行反而变更暗）+ 圆角 rounded-lg
    （12px，demo --r-lg）+ shadow-2（原语基类已带）+ 内边距 p-1（4px）；
  - 内容区固定高 h-[340px]（小屏 max-h 60vh 兜底）：切内部 tab 容器不塌缩，hover 态指针不
    落空（面板收起的根因消除）；宽高不随 demo 收窄（固定 400×340 是本仓 hover 稳定性的
    既有裁决，demo 无固定宽高对应物）；
  - 热区：内边距 p-1 放在**内容 div 自身**（不是浮层根）——内容 div 因此覆盖浮层全幅，
    指针落在 padding 带上同样触发 pointerenter 取消收起计时（U3：挂在浮层根做不到——本仓
    PopoverContent 包装组件的根是 PopoverPortal/Teleport，未声明为 props/emits 的原生监听在
    Teleport 根被 Vue 丢弃；reka PopoverContent 自身会经 PopperContent 的 `$attrs` 透传到浮层根）。
  - `data-testid="tray-panel"` 与 `data-panel-key` / `data-pinned` 是外壳状态机与 e2e 的接口，
    字符串形态不得改（e2e 依赖 `[data-testid="tray-panel"][data-panel-key=…]`）。
  - 开合动效（demo E5：进 ease-out / 出 ease-in，位移 3px + 透明度，120ms）：走 PopoverContent
    基类 reka-popover-transition（style.css 浮层进出场过渡段，同参实现）——reka 浮层经 Teleport
    渲染，scoped 选择器不命中浮层元素，且 @starting-style 无法用 Tailwind 表达，两者由该全局段
    统一承载（机制先例 = CollapsibleContent.vue 的 reka data-state 过渡 escape hatch）。
  - pin 态注入（tray-panel-interact §3.3 D6）：本组件把外壳持有的 pinned 位经 provide 下传给
    面板内容（slot 内的 TrayWidgetPanel 及其协议原语子树）。交互原语（Actionbar / list-tree
    可点命令行）读该注入决定交互项是否降级纯展示——hover 浏览零误触。注入缺失（非托盘挂载位，
    如浮层 ViewHost 的 scheduler-manager 面板）= 门控不生效、按钮照常可点（RL4 方向）。

  交互（pointer 热区 / 层外拦截 / 打开不抢焦点）经 emit 上抛给 ComposerTray 状态机消费。
-->
<template>
  <PopoverContent
    side="top"
    align="start"
    :side-offset="10"
    class="w-[400px] min-w-0 max-w-[calc(100vw-16px)] rounded-lg"
    @interact-outside="emit('interactOutside', $event)"
    @open-auto-focus="emit('openAutoFocus', $event)"
  >
    <div
      data-testid="tray-panel"
      :data-panel-key="panelKey"
      :data-pinned="pinned ? 'true' : 'false'"
      class="flex h-[340px] max-h-[60vh] flex-col p-1"
      @pointerenter="emit('panelEnter')"
      @pointerleave="emit('panelLeave')"
    >
      <slot />
    </div>
  </PopoverContent>
</template>

<script setup lang="ts">
import { computed, provide } from 'vue'
import { PopoverContent } from '@/components/ui/popover'
import { TRAY_PIN_STATE_KEY } from '@taiji/ui/rendering-protocol'

const props = defineProps<{
  /** 面板键（外壳 single activeKey 的键空间，原样写入 data-panel-key） */
  panelKey: string
  /** pin 态（外壳持有，原样写入 data-pinned） */
  pinned: boolean
}>()

/**
 * pin 态注入（tray-panel-interact §3.3 D6）：pinned 经 provide 下传给面板内容——
 * slot 内的 TrayWidgetPanel 及其协议原语（Actionbar / list-tree 可点命令行） inject
 * 同键，未 pin 时交互项降级纯展示（导航行不门控：导航是安全操作）。
 *
 * 必须 provide **响应式源**（computed）：pinned 是外壳交互态（点图标即变），而 provide
 * 只在 setup 执行一次——静态布尔无法随 pin 翻转更新，hover 点 pin 后按钮不出现
 * （契约与键定义见 packages/ui 的 Actionbar.vue 头注，本组件经 barrel 消费同一 symbol
 * 实例）。缺省方向由消费侧原语定死：注入缺失（非托盘挂载位，如浮层 ViewHost 的
 * scheduler-manager 面板）= 门控不生效、按钮照常可点（RL4，既有独立挂载位零变化）。
 */
provide(TRAY_PIN_STATE_KEY, computed(() => props.pinned))

const emit = defineEmits<{
  /** 指针进入内容区（外壳取消待收起计时） */
  panelEnter: []
  /** 指针离开内容区（外壳按 hover 语义收起，除非 pin） */
  panelLeave: []
  /** reka 层外交互（外壳对托盘按钮行内目标 preventDefault） */
  interactOutside: [event: Event]
  /** reka 打开自动聚焦（外壳 preventDefault：hover 预览不抢 composer 焦点） */
  openAutoFocus: [event: Event]
}>()
</script>
