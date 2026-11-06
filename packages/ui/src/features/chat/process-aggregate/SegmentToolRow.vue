<!--
  聚合块 · 段内单步行（chat-flow-process-aggregate U2）：展开平铺与聚合条共用的工具行。
  形态（任务书硬约束）：工具名 + 参数（超宽 min(420px,52%) 省略；窄屏 11px）+ diff 摘要 + 耗时 +
  失败标记；失败行在场标红（AX6：失败是段的正式成员，不做可见性剔除）；重试标记不渲染
  （无结构判定源，D4 裁决——demo 数据里的重试标记不进生产口径）。
  详情通道分工（D4）：悬停 → 浮层摘要（本组件内显隐）；点击 / Enter / Space → emit
  open-detail（右侧抽屉由 U4 接线；点击同时收浮层 = 「开抽屉时消失」路径之一）。
  行可聚焦（role=button + tabindex=0）：键盘可达 + 鼠标点击持焦点——抽屉壳在 open 时刻
  读 activeElement 当触发行、关闭归还到它（GL6「焦点归还触发行」前提，ToolRow 文件 chip
  同款可聚焦行形态）。
  行内不展开输出（行内展开已随 D4 退役——输出不再挤占对话流）。
-->
<template>
  <div
    class="agg-tool-row group/aggrow relative -mx-2 flex min-w-0 cursor-pointer select-none items-baseline gap-[8px] rounded-[var(--radius-xs)] px-2 py-0.5 hover:bg-[color:var(--hover-tint)]"
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
    <!-- running 态 loader（呼吸弧 + accent），其余状态静态图标二选一切换；
         失败行图标染 danger（状态色只落图标，行文字恒行层级——demo .tool .t-name 同规） -->
    <RunningBlockIcon v-if="isRunning" kind="tool-other" />
    <component :is="headerIcon" v-else :class="[BLOCK_ICON_CLASS, isFailed ? 'text-danger' : '', 'self-center']" />
    <span class="shrink-0 text-neutral-mid">{{ tool.toolName }}</span>
    <!-- 参数摘要：超宽 min(420px,52%) 省略（任务书硬约束；完整参数走浮层/抽屉）；
         窄屏（density mobile 档 = ≤420px 窄屏同档，D7 双窗降档同判定源）11px = --text-2xs
         令牌（chat 语境 11px 基准，D4 采用栏 demo 规格） -->
    <span
      v-if="paramText"
      class="min-w-0 max-w-[min(420px,52%)] truncate font-mono text-neutral-dim"
      :class="density === 'mobile' ? 'text-[length:var(--text-2xs)]' : ''"
      data-testid="agg-tool-param"
    >{{ paramText }}</span>
    <!-- diff 摘要（edit 工具增删行数，core diffStat 口径；write/历史会话缺省不渲染） -->
    <span
      v-if="tool.diffStat"
      class="shrink-0 font-mono text-[length:var(--text-2xs)] tabular-nums text-neutral-dim"
      data-testid="agg-tool-diffstat"
    >+{{ tool.diffStat.additions }} −{{ tool.diffStat.deletions }}</span>
    <!-- 失败标记（危险色文字；行左缘另有呼吸微光动画，scoped 尾部） -->
    <span
      v-if="isFailed"
      class="shrink-0 rounded-[var(--radius-xs)] bg-danger-soft px-1.5 py-px text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] text-danger"
      data-testid="agg-tool-failed"
    >{{ t('panel.message.aggRowFailed') }}</span>
    <!-- 耗时（行尾 mono dim；running 无 endTime 不渲染） -->
    <span
      v-if="duration"
      class="ml-auto shrink-0 font-mono text-[length:var(--text-2xs)] tabular-nums text-neutral-dim"
      data-testid="agg-tool-duration"
    >{{ duration }}</span>
    <!-- 悬停浮层：v-if 挂载（happy-dom 可断言存在性）；显隐归本组件（滚动/缩放/Esc 全局监听） -->
    <AggregateHoverCard v-if="cardVisible" :tool="tool" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ToolCall } from '@taiji/shared'
import RunningBlockIcon from '../RunningBlockIcon.vue'
import AggregateHoverCard from './AggregateHoverCard.vue'
import { BLOCK_ICON_CLASS, BLOCK_ICON_LUCIDE, getBlockIcon } from '../block-icon'
import { formatDuration } from '../format-utils'
import { useChatDensity } from '../chat-view-deps'

const props = defineProps<{
  /** 工具调用（段成员 FlatBlock.block.ref 的 ToolCall 形态；agentgraph 同构） */
  tool: ToolCall
}>()

const emit = defineEmits<{
  /** 单步行点击 → 右侧抽屉触发（抽屉壳与焦点管理在 U4 接线，本单元只发事件） */
  (e: 'open-detail', tool: ToolCall): void
}>()

const { t } = useI18n()

/** 密度档（D4 窄屏 11px 参数字号判定源，与 D7 双窗降档同档：mobile = ≤420px 窄屏同档） */
const density = useChatDensity()

const isRunning = computed(() => props.tool.status === 'running')
const isFailed = computed(() => props.tool.status === 'error')

/** 静态图标（running 收窄回退 tool-other 字形——实际渲染走模板 RunningBlockIcon 分支，
 *  ToolRow headerBlockIcon 同款收窄形态） */
const headerIcon = computed(() => {
  const kind = getBlockIcon(props.tool.toolName, props.tool.status, false, false)
  return kind === 'running' ? BLOCK_ICON_LUCIDE['tool-other'] : BLOCK_ICON_LUCIDE[kind]
})

const duration = computed(() => {
  const { startTime, endTime } = props.tool
  if (typeof startTime !== 'number' || typeof endTime !== 'number') return ''
  return formatDuration(Math.max(0, endTime - startTime))
})

/**
 * 参数摘要字段序（AggregateHoverCard 同款同序——两处提取消费同一字段清单；展示级提取，
 * 非成员资格判定）。样式与提取分离：超宽省略宽度是模板层约束（min(420px,52%)），提取
 * 只产出文本。
 */
const paramText = computed(() => {
  const input = props.tool.input
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    for (const key of ['command', 'path', 'pattern', 'query', 'code'] as const) {
      const v = obj[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
    return ''
  }
  return ''
})

/* ── 悬停浮层显隐：滚动 / 缩放 / Esc / 行点击时消失（任务书硬约束）。
      监听器随浮层在场挂载、离场移除（常驻空监听 = 无谓的全局开销）；
      scroll 用 capture 捕获对话流内部容器的滚动（window 级 scroll 事件不冒泡）。 ── */
const cardVisible = ref(false)

function showCard(): void {
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
/* 失败行呼吸微光（1.6s，仅左缘红渐隐——D10 动效清单；成功重试调用不染红：
   判定源 = status==='error' 事实，无重试推断）。悬停底色走模板层 --hover-tint
   任意值类，无 scoped 规则体。 */
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
