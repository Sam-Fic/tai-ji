<!--
  过程卡 · 卡头（chat-flow-v2）：一行 24px。左侧开关 = 层叠图标 +「过程」+ 计数 + 失败标记
  + 展开箭头；右侧插槽（由 AggregateTape 提供）放进行中的活动 chip 与滚动提示。
  行首图标恒为层叠字形：进行中的动态信号在右侧活动 chip，不在行首（原型同款）。
  计数口径：步数按段内工具类成员累计（思考不计步），思考数取 core counts.thinkingCount；
  失败计数取 core counts.failedCount（与失败行同一口径）。
  卡头不显示段总耗时——卡内唯一的实时计时在活动 chip。
  展开/收起态由容器持有（D6 组件本地 ref），本组件纯受控：真实 button + aria-expanded 同步。
-->
<template>
  <div class="relative h-[length:var(--proc-tape-row-h)]">
    <Button
      variant="ghost"
      class="-mx-2 h-[length:var(--proc-tape-row-h)] w-full justify-start gap-2 rounded-[var(--radius-xs)] px-2 text-[length:var(--text-sm)] text-neutral-fg-2 [font-weight:var(--fw-mid)] hover:bg-transparent hover:text-neutral-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-[color:var(--focus-ring)]"
      :aria-expanded="expanded"
      data-testid="agg-summary-row"
      @click="emit('toggle')"
    >
      <Layers class="size-[15px] shrink-0 text-neutral-ico [stroke-width:1.6]" aria-hidden="true" />
      <span class="shrink-0">{{ t('panel.message.aggProcessLabel') }}</span>
      <span
        v-if="countText"
        class="min-w-0 shrink truncate text-neutral-mid [font-weight:var(--fw-text)]"
        data-testid="agg-summary-count"
      >{{ countText }}</span>
      <!-- 失败标记（含 M 次失败）：计数即存在信号，无失败不渲染 -->
      <span
        v-if="segment.counts.failedCount > 0"
        class="shrink-0 rounded-[var(--radius-xs)] bg-danger-soft px-1.5 py-px text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] text-danger"
        data-testid="agg-summary-failed"
      >{{ t('panel.message.traceFailed', { count: segment.counts.failedCount }) }}</span>
      <ChevronRight
        class="ml-auto size-[15px] shrink-0 text-neutral-dim transition-[color,transform] duration-[var(--duration-fast)] ease-[var(--ease)]"
        :class="expanded ? 'rotate-90 text-accent' : ''"
        aria-hidden="true"
      />
    </Button>
    <!-- 右侧一组（活动 chip / 滚动提示）：叠在开关之上、停在箭头左侧；容器不拦指针，子元素自行接收 -->
    <div v-if="$slots.right" class="pointer-events-none absolute inset-y-0 right-8 flex items-center gap-0.5">
      <slot name="right" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Layers } from '@lucide/vue'
import type { ProcessSegment } from '@taiji/core/domain/chat'
import { Button } from '../../../primitives/button'

const props = defineProps<{
  /** 段数据（counts 与 members 是计数唯一数据源，core 单源口径） */
  segment: ProcessSegment
  /** 展开/收起态（容器本地 ref 透传，aria-expanded 同步） */
  expanded: boolean
  /** 段进行中（isLive 透传）：卡头形态不随它变化，保留给需要区分的调用方 */
  live?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
}>()

const { t } = useI18n()

/** 卡头计数：「N 步 · 思考 M」。步数按段内工具类成员累计（思考不计步），思考数取 core 计数 */
const countText = computed(() => {
  const steps = props.segment.members.filter((m) => m.block.kind !== 'thinking').length
  const thinking = props.segment.counts.thinkingCount
  const parts: string[] = []
  if (steps > 0) parts.push(t('panel.message.runGroupSteps', { count: steps }))
  if (thinking > 0) parts.push(t('panel.message.procThinkCount', { count: thinking }))
  return parts.join(' · ')
})
</script>
