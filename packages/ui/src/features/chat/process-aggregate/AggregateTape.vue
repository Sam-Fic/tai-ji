<!--
  过程卡（chat-flow-v2）：一张卡 = 卡片 + 卡头 + 12 行窗口。
  卡片：比页面底色亮一档的底色、圆角、左右 12px 内边距（原型同款）。
  卡头（AggregateSummaryRow）承载开关与计数；右侧插槽放进行中的活动 chip
  （AggregateActivityChip：此刻在做什么 + 已持续多久）与滚动提示
  （更早 N 条 / 回到最新 / 下面还有 N 条 / 回到开头——useTapeScroll 按窗口几何派生）。
  窗口（agg-tape-scroll）高度上限 = 12 行 × 24px，内容在其中滚动；滚动条隐藏；
  内容滚出窗口的一侧 16px 渐隐。思考块的展开集合由本组件持有（思考行与卡头的活动 chip 共用）。
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
        <AggregateActivityChip
          v-if="activity"
          :activity="activity"
          :elapsed="activityElapsed"
          @activate="toggleThinkingById(activity.thinkingId)"
        />
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
      :class="{ 'is-over-top': overTop, 'is-over-bottom': overBottom }"
      data-testid="agg-tape-scroll"
      @scroll="onScroll"
      @scrollend="onScrollEnd"
      @wheel="onWheel"
    >
      <AggregateExpandedBody
        :segment="segment"
        :session-id="sessionId"
        :live="live"
        :expanded-thinking="openThinking"
        @toggle-thinking="toggleThinking"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ProcessSegment } from '@taiji/core/domain/chat'
import { Button } from '../../../primitives/button'
import AggregateSummaryRow from './AggregateSummaryRow.vue'
import AggregateExpandedBody from './AggregateExpandedBody.vue'
import { useTapeActivity, useTapeScroll } from '../composables/useProcessAggregate'
import AggregateActivityChip from './AggregateActivityChip.vue'

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

const { hint, overTop, overBottom, onScroll, onScrollEnd, onWheel, onHint, attach } = useTapeScroll({
  window: windowRef,
  segment,
  live,
})

/* 卡头活动 chip：进行中「此刻在做什么 + 已持续多久」（卡内唯一的实时计时） */
const { activity, elapsedText: activityElapsed } = useTapeActivity({ segment, live })

/* 已点开的思考块：窗口收起再打开、段继续增长都保留；卡卸载即清空（瞬态，不落 store）。
   翻转时替换成新集合——读它的模板与 computed 才会更新 */
const openThinking = ref<ReadonlySet<string>>(new Set())
function toggleThinking(id: string): void {
  const next = new Set(openThinking.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openThinking.value = next
}
/** 活动 chip 的点开请求：只对带目标 id 的 chip 生效（当前活动是流式中的思考） */
function toggleThinkingById(id: string | undefined): void {
  if (id !== undefined) toggleThinking(id)
}

/* 窗口挂载 / 卸载即接入滚动运行时：挂载后进行中且跟随时贴底，落成后打开从第一条读起；
   两种情况都立即量一次（内容未长满时也要给出正确的提示） */
watch(windowRef, attach, { immediate: true })
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
/* 两侧渐隐：内容滚出窗口的一侧 16px 由透明到不透明，提示那一侧还有内容 */
.agg-tape-win.is-over-top {
  mask-image: linear-gradient(to bottom, transparent, #000 16px);
}
.agg-tape-win.is-over-bottom {
  mask-image: linear-gradient(to top, transparent, #000 16px);
}
.agg-tape-win.is-over-top.is-over-bottom {
  mask-image: linear-gradient(to bottom, transparent, #000 16px, #000 calc(100% - 16px), transparent);
}
</style>
