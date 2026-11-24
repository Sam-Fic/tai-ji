<!--
  过程卡（chat-flow-v2）：一张卡 = 卡片 + 卡头 + 12 行窗口。
  卡片：比页面底色亮一档的底色、圆角、左右 12px 内边距（原型同款）。
  卡头（AggregateSummaryRow）承载开关与计数；右侧插槽放滚动提示
  （更早 N 条 / 回到最新 / 下面还有 N 条 / 回到开头——useTapeScroll 按窗口几何派生）。
  窗口（agg-tape-scroll）高度上限 = 12 行 × 24px，内容在其中滚动；滚动条隐藏。
  窗口左右各外扩一段（卡片内边距 + 行悬停底色的外扩量），行悬停底色因此完整可见，
  又不会被窗口的滚动裁切。
-->
<template>
  <div class="agg-tape flex min-w-0 flex-col rounded-[var(--radius)] bg-[color:var(--bg-input)]" data-testid="agg-tape">
    <AggregateSummaryRow
      :segment="segment"
      :expanded="open"
      :live="live"
      @toggle="emit('toggle')"
    >
      <template #right>
        <Button
          v-if="hint"
          variant="ghost"
          class="pointer-events-auto h-full rounded-[var(--radius-xs)] px-1.5 py-0 font-mono text-[length:var(--text-xs)] font-normal tabular-nums text-neutral-mid hover:bg-[color:var(--hover-tint)] hover:text-neutral-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-[color:var(--focus-ring)]"
          data-testid="agg-tape-hint"
          @click="onHint"
        >{{ hint }}</Button>
      </template>
    </AggregateSummaryRow>
    <div
      v-if="open"
      ref="windowRef"
      class="agg-tape-win max-h-[calc(var(--proc-tape-rows)*var(--proc-tape-row-h))] overflow-y-auto"
      data-testid="agg-tape-scroll"
      @scroll="onScroll"
      @wheel="onWheel"
    >
      <AggregateExpandedBody :segment="segment" :session-id="sessionId" :live="live" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ProcessSegment } from '@taiji/core/domain/chat'
import { Button } from '../../../primitives/button'
import AggregateSummaryRow from './AggregateSummaryRow.vue'
import AggregateExpandedBody from './AggregateExpandedBody.vue'
import { useTapeScroll } from '../composables/useProcessAggregate'

const props = defineProps<{
  /** 段数据（core 切段纯函数输出；窗口行内容 = segment.units 逐行投影） */
  segment: ProcessSegment
  /** 段进行中（容器 isLive 透传）：进行中贴底跟随，落成后从第一条读起 */
  live: boolean
  /** 窗口展开/收起态（容器本地 ref 透传；收起 = 只留卡头一行） */
  open: boolean
  /** 所属 session（透传思考行与详情抽屉） */
  sessionId?: string | null
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
}>()

const windowRef = ref<HTMLElement | null>(null)
const live = computed(() => props.live)
const segment = computed(() => props.segment)

const { hint, onScroll, onWheel, onHint, stickToBottom } = useTapeScroll({ window: windowRef, segment, live })

/* 展开态切换：落成后打开从第一条读起（不贴底）；进行中打开/内容变化即贴底 */
watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (live.value) void nextTick(stickToBottom)
    else void nextTick(() => onScroll())
  },
)
/* 挂载即量一次（真机首屏窗口已在位、内容未长满时也要给出正确提示） */
watch(windowRef, () => void nextTick(() => onScroll()), { immediate: true })
</script>

<style scoped>
/* 卡片内边距：上下 2px、左右 12px（落成收起时 = 卡头 24px + 上下 4px = 28px 一行） */
.agg-tape {
  --agg-card-px: 12px;
  /* 行悬停底色向左右外扩的量（行的负外边距） */
  --agg-row-out: 8px;
  padding: 2px var(--agg-card-px);
}
/* 窗口：左右外扩到卡片内边距之外，行悬停底色落在窗口内边距里不被裁切；滚动条隐藏 */
.agg-tape-win {
  margin: 0 calc(-1 * (var(--agg-card-px) + var(--agg-row-out)));
  padding: 0 calc(var(--agg-card-px) + var(--agg-row-out));
  scrollbar-width: none;
}
.agg-tape-win::-webkit-scrollbar {
  display: none;
}
</style>
