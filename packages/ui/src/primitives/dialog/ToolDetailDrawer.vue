<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from '@lucide/vue'
import { DialogClose } from 'reka-ui'
// Dialog 系列直接文件导入（不经本目录 barrel）：本组件经 dialog/index.ts 再导出，
// 目录 barrel 自引用会封住循环依赖环（R2 S-1，ConfirmDialog 同款修法）
import Dialog from './Dialog.vue'
import DialogContent from './DialogContent.vue'
import DialogTitle from './DialogTitle.vue'

/**
 * 工具详情抽屉壳 —— 对话流单步详情的模态抽屉通道（chat-flow-process-aggregate D4）。
 *
 * 基座 = 本目录 Dialog/DialogContent 模态原语族（v-model:open 受控开关 + reka 焦点陷阱/
 * Esc 关闭）；420px 右贴边形态经 DialogContent variant='right-drawer' 在壳层定型，
 * 消费点（聚合块成员行）直接使用。
 *
 * 开合态为消费方自有本地状态：不接入右抽屉 DrawerPanel tab 注册制、不触 core
 * drawer/bottom-drawer 与 overlay 单例——与既有抽屉/浮层通道无共享开合态（D4 选型裁决，
 * 邻居不变量验收 V5）。
 *
 * 内容插槽承接命令/参数/输出/耗时/状态（修改类增删着色由内容装配方传 Markup）——
 * 「阶段」无独立结构源（ToolCall 无 phase 字段），执行阶段由状态词承担，插槽无阶段装配点；
 * 壳只管布局与交互。
 */
interface Props {
  /** 受控开关（配合 v-model:open） */
  open: boolean
  /** 抽屉标题（DialogTitle，屏读必需；未传回落抽屉标题键 aggDetailTitle，消费方按工具名拼前缀） */
  title?: string
  /**
   * 焦点归还降级目标（对话流容器）：触发行在抽屉开启期间被虚拟滚动卸载时，
   * 关闭焦点归还到这里；触发行仍在场则归还触发行。由调用方传入。
   */
  fallbackFocusTarget?: HTMLElement | null
}

const props = withDefaults(defineProps<Props>(), {
  fallbackFocusTarget: null,
})

const { t } = useI18n()

/**
 * 标题解析：调用方未传时回落抽屉标题键（DialogTitle 屏读必需，不空手而归）。
 * 不用 withDefaults 缺省值承载回落——默认值表达式被提升到 setup 外，引用 setup
 * 局部绑定（t）是 SFC 编译期硬错误（checkInvalidScopeReference），computed 消费
 * props 是同语义的合法形态。
 */
const resolvedTitle = computed(() => props.title ?? t('panel.message.aggDetailTitle'))

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

/** 触发行（open 时刻的焦点元素）；关闭时优先归还，已卸载则降级 fallbackFocusTarget */
const triggerElement = ref<HTMLElement | null>(null)

// immediate：支持「以 open=true 初次挂载」形态——触发元素同样取挂载时刻的焦点元素。
// 触发行是 focusable 元素（聚合块成员行 SegmentToolRow：role=button + tabindex=0），
// 点击/键盘激活后持有焦点，此处读 activeElement 即触发行；无焦点（activeElement=body）
// 时记 null，归还全走降级。
watch(
  () => props.open,
  (open) => {
    if (!open) return
    const active = document.activeElement
    triggerElement.value = active instanceof HTMLElement && active !== document.body ? active : null
  },
  { immediate: true },
)

/**
 * 关闭焦点归还（closeAutoFocus = reka FocusScope 卸载时刻，设计契约「焦点归还触发行」）。
 * preventDefault 压掉 reka 内部两路自动归还（Dialog 模态壳对触发元素的 watch focus、
 * FocusScope 卸载 setTimeout 归还）——触发行被虚拟滚动卸载后那些路径是对断连元素调
 * focus（浏览器 no-op，降级无人做），由这里统一裁决：触发行在场归还触发行，卸载归还
 * 调用方传入的对话流容器。
 */
function onCloseAutoFocus(event: Event): void {
  event.preventDefault()
  const trigger = triggerElement.value
  if (trigger && trigger.isConnected) {
    trigger.focus()
    return
  }
  if (props.fallbackFocusTarget?.isConnected) props.fallbackFocusTarget.focus()
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <!-- aria-modal 补 reka 未默认设置的模态语义（设计可访问性契约：role=dialog 由 reka
         DismissableLayer 承担，焦点陷阱/Esc 关闭由 reka FocusScope/DismissableLayer 承担）；
         data-testid 经 DialogContent 的 attrs 合并通道落到面板元素 -->
    <DialogContent
      variant="right-drawer"
      hide-close
      aria-modal="true"
      data-testid="tool-detail-drawer"
      @close-auto-focus="onCloseAutoFocus"
    >
      <header class="flex items-center justify-between gap-2 border-b border-hairline px-5 py-4">
        <DialogTitle class="min-w-0 truncate text-[length:var(--text-base)] font-semibold leading-none">
          {{ resolvedTitle }}
        </DialogTitle>
        <!-- 关闭钮形态对齐 DialogContent 默认 absolute 关闭钮（24px 热区 + dim 色 + hover 提亮），
             抽屉形态按钮收进 header 行内排布，不用 absolute 避免与标题行叠放 -->
        <DialogClose
          class="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius)] text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--focus-ring)] focus-visible:-outline-offset-1"
        >
          <X class="size-[15px]" />
          <span class="sr-only">Close</span>
        </DialogClose>
      </header>
      <!-- 内容插槽承接命令/参数/输出/耗时/状态（u-detail-drawer 装配，无阶段装配点——
           ToolCall 无 phase 结构源，执行阶段由状态词承担）；壳只管布局 -->
      <div class="min-h-0 flex-1 select-text overflow-y-auto px-5 py-4">
        <slot />
      </div>
    </DialogContent>
  </Dialog>
</template>
