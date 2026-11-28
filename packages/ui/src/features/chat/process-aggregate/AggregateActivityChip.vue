<!--
  过程卡 · 活动 chip（chat-flow-v2）：进行中常驻卡头右侧——「此刻在做什么 + 已持续多久」。
  数据来自 useTapeActivity；本组件纯展示。当前活动是流式中的思考时它是开关：点一下点开该段思考
  （展开状态在卡上，与思考行共用）；其它活动只是展示。
  它是卡内唯一的实时计时（行内只有已结束步骤的历史耗时）。
-->
<template>
  <component
    :is="activity.thinkingId ? Button : 'span'"
    v-bind="activity.thinkingId ? { variant: 'ghost', title: t('panel.message.expandReasoning') } : {}"
    class="agg-chip h-full gap-1.5 rounded-[var(--radius-xs)] px-1.5 py-0 text-[length:var(--text-sm)] text-neutral-mid [font-weight:var(--fw-mid)]"
    :class="activity.thinkingId ? 'pointer-events-auto hover:bg-[color:var(--hover-tint)] hover:text-neutral-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-[color:var(--focus-ring)]' : 'inline-flex items-center'"
    data-testid="agg-activity-chip"
    @click="activity.thinkingId ? emit('activate') : undefined"
  >
    <RunningBlockIcon :kind="activity.icon" />
    <span data-testid="agg-activity-label">{{ activity.label }}</span>
    <b
      v-if="elapsed"
      class="agg-chip-dur"
      data-testid="agg-activity-duration"
    >{{ elapsed }}</b>
  </component>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import RunningBlockIcon from '../RunningBlockIcon.vue'
import type { useTapeActivity } from '../composables/useProcessAggregate'
import { Button } from '../../../primitives/button'

defineProps<{
  /** 此刻在做什么（useTapeActivity.activity） */
  activity: NonNullable<ReturnType<typeof useTapeActivity>['activity']['value']>
  /** 已持续时长的文本（useTapeActivity.elapsedText；空串 = 不显示） */
  elapsed: string
}>()

const emit = defineEmits<{
  /** 点了可点开的 chip（当前活动是流式中的思考） */
  (e: 'activate'): void
}>()

const { t } = useI18n()
</script>

<style scoped>
/* 计时：等宽、次级正文色、等宽数字（每秒变化不抖动） */
.agg-chip-dur {
  color: var(--neutral-fg-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  font-weight: var(--fw-mid);
}
</style>
