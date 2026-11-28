<!--
  过程卡 · 工具步行（chat-flow-v2）：一行 24px，一个工具调用一行。
  形态（原型同款）：`>` 等工具图标 + 主体 + 行尾。主体按工具类型二选一——
  命令类工具（RUN_GROUP_TOOLS.exec 类型表内，如 bash）只显示命令正文，不带工具名；
  其余工具显示工具名 + 参数摘要。行尾：diff 摘要、失败标记、耗时。
  失败行在场标红（失败是段的正式成员，不做可见性剔除）；重试标记不渲染（无结构判定源，D4）。
  执行中：命令正文提亮，行尾显示最新一行输出与光标（没有输出时只有光标）；不显示耗时。
  详情通道分工（D4）：悬停 → 浮层摘要；点击 / Enter / Space → emit open-detail
  （右侧抽屉由 AggregateExpandedBody 接线；点击同时收浮层）。行内不展开输出。
  浮层传送到页面层、固定定位：行在限高滚动的窗口里，挂在行内的浮层会被窗口裁掉。
-->
<template>
  <div
    ref="rowRef"
    class="agg-tool-row group/aggrow relative -mx-2 flex h-[length:var(--proc-tape-row-h)] min-w-0 cursor-pointer select-none items-center gap-2 rounded-[var(--radius-xs)] px-2 text-[length:var(--text-sm)] hover:bg-[color:var(--hover-tint)]"
    :class="isFailed ? 'agg-tool-row--failed' : ''"
    role="button"
    tabindex="0"
    data-testid="agg-tool-row"
    @mouseenter="showCard"
    @mouseleave="hideCard"
    @click="onRowClick"
    @keydown.enter.stop.prevent="onRowClick"
    @keydown.space.stop.prevent="onRowClick"
  >
    <!-- running 态 loader（呼吸弧 + accent），其余状态静态图标；失败行图标染 danger。
         命令类工具执行中保持静态箭头：进度信号在行尾的输出与光标 -->
    <RunningBlockIcon v-if="isRunning && !isCommandLine" kind="tool-other" />
    <component
      :is="headerIcon"
      v-else
      :class="[BLOCK_ICON_CLASS, isFailed ? 'text-danger' : '', 'shrink-0']"
    />
    <span v-if="!isCommandLine" class="shrink-0 text-neutral-mid">{{ tool.toolName }}</span>
    <!-- 主体：命令正文或参数摘要，占满剩余宽度后省略（完整内容走浮层/抽屉） -->
    <span
      v-if="paramText"
      class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-xs)]"
      :class="isRunning ? 'text-neutral-fg' : 'text-neutral-fg-2'"
      data-testid="agg-tool-param"
    >{{ paramText }}</span>
    <span v-else class="flex-1" />
    <!-- diff 摘要（edit 工具增删行数，core diffStat 口径；write/历史会话缺省不渲染） -->
    <span
      v-if="tool.diffStat"
      class="shrink-0 font-mono text-[length:var(--text-xs)] tabular-nums text-neutral-mid"
      data-testid="agg-tool-diffstat"
    >+{{ tool.diffStat.additions }} −{{ tool.diffStat.deletions }}</span>
    <!-- 失败标记（危险色文字；行左缘另有呼吸微光动画，scoped 尾部） -->
    <span
      v-if="isFailed"
      class="shrink-0 rounded-[var(--radius-xs)] bg-danger-soft px-1.5 py-px text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] text-danger"
      data-testid="agg-tool-failed"
    >{{ t('panel.message.aggRowFailed') }}</span>
    <!-- 执行中：最新一行输出（最多占行宽的 46%）与光标 -->
    <span
      v-if="isRunning && outputTail"
      class="ml-auto flex min-w-0 max-w-[46%] shrink items-center gap-1 font-mono text-[length:var(--text-xs)] text-neutral-mid"
      data-testid="agg-tool-tail"
    ><CornerDownRight class="size-3 shrink-0 text-neutral-dim" aria-hidden="true" /><span class="truncate">{{ outputTail }}</span></span>
    <span v-if="isRunning" class="agg-cursor" aria-hidden="true" />
    <!-- 耗时（行尾等宽中灰；running 无 endTime 不渲染） -->
    <span
      v-if="duration"
      class="ml-auto shrink-0 font-mono text-[length:var(--text-xs)] tabular-nums text-neutral-mid"
      data-testid="agg-tool-duration"
    >{{ duration }}</span>
    <!-- 悬停浮层：传送到页面层并按行的视口位置固定定位（v-if 挂载；显隐归本组件） -->
    <Teleport to="body">
      <AggregateHoverCard v-if="cardVisible" :tool="tool" :anchor="anchor" />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CornerDownRight } from '@lucide/vue'
import { RUN_GROUP_TOOLS } from '@taiji/core/domain/chat'
import type { ToolCall } from '@taiji/shared'
import RunningBlockIcon from '../RunningBlockIcon.vue'
import AggregateHoverCard from './AggregateHoverCard.vue'
import './aggregate-motion.css'
import { BLOCK_ICON_CLASS, BLOCK_ICON_LUCIDE, getBlockIcon } from '../block-icon'
import { formatDuration } from '../format-utils'
import { toolArgFieldText } from './tool-arg-summary'

const props = defineProps<{
  /** 工具调用（段成员 FlatBlock.block.ref 的 ToolCall 形态；agentgraph 同构） */
  tool: ToolCall
}>()

const emit = defineEmits<{
  /** 工具步行点击 → 右侧抽屉触发（抽屉壳与焦点管理在 U4 接线，本单元只发事件） */
  (e: 'open-detail', tool: ToolCall): void
}>()

const { t } = useI18n()

const isRunning = computed(() => props.tool.status === 'running')
const isFailed = computed(() => props.tool.status === 'error')

/** 命令类工具（类型表 RUN_GROUP_TOOLS.exec 内）：行内只显示命令正文，不带工具名 */
const isCommandLine = computed(() => RUN_GROUP_TOOLS.exec.includes(props.tool.toolName))

/** 静态图标（按完成态取字形；执行中的非命令类工具在模板里换成功效图标） */
const headerIcon = computed(() => {
  const kind = getBlockIcon(props.tool.toolName, 'completed', false, false)
  return kind === 'running' ? BLOCK_ICON_LUCIDE['tool-other'] : BLOCK_ICON_LUCIDE[kind]
})

/** 执行中最新一行输出：output 里最后一个非空行（output 已去 ANSI）；没有则不显示 */
const outputTail = computed(() => {
  if (!isRunning.value) return ''
  const lines = (props.tool.output ?? '').split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (line) return line
  }
  return ''
})

const duration = computed(() => {
  const { startTime, endTime } = props.tool
  if (typeof startTime !== 'number' || typeof endTime !== 'number') return ''
  return formatDuration(Math.max(0, endTime - startTime))
})

/**
 * 行内主体（命令正文 / 参数摘要；字段序单源 tool-arg-summary）。提取与样式分离：
 * 省略是模板层约束，提取只产出文本；未覆盖形态回退空串（窄行不进长 JSON）。
 */
const paramText = computed(() => toolArgFieldText(props.tool.input) ?? '')

/* ── 悬停浮层显隐：滚动 / 缩放 / Esc / 行点击时消失。监听器随浮层在场挂载、离场移除 ── */
const rowRef = ref<HTMLElement | null>(null)
const cardVisible = ref(false)
/** 行的视口矩形（浮层定位依据；显示那一刻取一次，之后行一动浮层即收起） */
const anchor = ref({ top: 0, bottom: 0, left: 0 })

function showCard(): void {
  const rect = rowRef.value?.getBoundingClientRect()
  if (!rect) return
  anchor.value = { top: rect.top, bottom: rect.bottom, left: rect.left }
  cardVisible.value = true
  window.addEventListener('scroll', hideCard, true)
  window.addEventListener('resize', hideCard)
  window.addEventListener('keydown', onKeydown)
}

function hideCard(): void {
  if (!cardVisible.value) return
  cardVisible.value = false
  window.removeEventListener('scroll', hideCard, true)
  window.removeEventListener('resize', hideCard)
  window.removeEventListener('keydown', onKeydown)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') hideCard()
}

function onRowClick(): void {
  hideCard()
  emit('open-detail', props.tool)
}

onBeforeUnmount(() => {
  window.removeEventListener('scroll', hideCard, true)
  window.removeEventListener('resize', hideCard)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
/* 失败行呼吸微光（1.6s，仅左缘红渐隐——D10 动效清单）。悬停底色走模板层 --hover-tint */
.agg-tool-row--failed {
  border-left: 2px solid var(--danger);
  animation: agg-fail-glow 1.6s ease-in-out infinite;
}

@keyframes agg-fail-glow {
  0%,
  100% {
    box-shadow: -2px 0 6px -2px color-mix(in oklch, var(--danger) 35%, transparent);
  }
  50% {
    box-shadow: -2px 0 10px -1px color-mix(in oklch, var(--danger) 60%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agg-tool-row--failed {
    animation: none;
  }
}
</style>
