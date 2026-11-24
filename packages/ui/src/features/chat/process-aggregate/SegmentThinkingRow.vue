<!--
  过程卡 · 思考行（chat-flow-v2）：一个思考块一行，三种形态。
    已结束、未点开：一行标签 = 灯泡 +「思考」+ 该次时长 + 行尾箭头，不带正文。
    进行中、未点开：只露最新一行文字（行尾光标），不显示标签——标签与计时在卡头的活动 chip。
    点开：标签行 + 全文（最高 240px，内滚动）；进行中全文跟着最新一行走。
  展开态由卡持有（AggregateTape 的展开集合，经 AggregateExpandedBody 透传）：卡头的活动 chip
  也能点开同一段思考，状态只能有一个来源。
  流式判定沿用 isThinkingStreaming（有 start 无 end）；落成后的段即使某块缺 endTime 也按已结束显示。
  行高固定取 --proc-tape-row-h，未点开时恒为一行。
-->
<template>
  <div
    class="agg-think"
    :class="{ 'is-open': expanded }"
    data-testid="agg-thinking-row"
  >
    <Button
      v-if="!tailOnly"
      variant="ghost"
      class="-mx-2 w-[calc(100%+16px)] justify-start gap-2 rounded-[var(--radius-xs)] px-2 py-0 text-[length:var(--text-sm)] text-neutral-mid [font-weight:var(--fw-mid)] hover:bg-[color:var(--hover-tint)] hover:text-neutral-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-[color:var(--focus-ring)] agg-think-btn"
      :aria-expanded="expanded"
      data-testid="agg-thinking-toggle"
      @click="emit('toggle')"
    >
      <Lightbulb class="size-[15px] shrink-0 text-neutral-ico [stroke-width:1.6]" aria-hidden="true" />
      <span class="shrink-0">{{ t('panel.message.thinkingBlock') }}</span>
      <span
        v-if="streaming"
        class="shrink-0 font-mono text-[length:var(--text-xs)] [font-weight:var(--fw-text)]"
        data-testid="agg-thinking-running"
      >{{ t('panel.message.aggGroupRunning') }}</span>
      <span
        v-else-if="duration"
        class="shrink-0 font-mono text-[length:var(--text-xs)] tabular-nums [font-weight:var(--fw-text)]"
        data-testid="agg-thinking-duration"
      >{{ duration }}</span>
      <ChevronRight
        class="ml-auto size-[15px] shrink-0 text-neutral-dim transition-[color,transform] duration-[var(--duration-fast)] ease-[var(--ease)]"
        :class="expanded ? 'rotate-90 text-accent' : ''"
        aria-hidden="true"
      />
    </Button>
    <!-- 正文：未点开时不渲染（进行中除外——进行中只露最新一行）；进行中的全文跟着最新一行走 -->
    <div
      v-if="tailOnly || expanded"
      ref="textRef"
      class="agg-think-tx"
      :class="{ 'is-tail': tailOnly }"
      data-testid="agg-thinking-text"
      @click="onTextClick"
    >
      <MarkdownRenderer
        v-if="!streaming"
        :content="thinking.content"
        :session-id="sessionId ?? undefined"
        variant="thinking"
      />
      <!-- 光标放在文字末尾、同一行内：作为容器的并列子元素它会被块化成单独一行，
           把最新一行文字挤出可视范围 -->
      <span v-else class="agg-think-in">{{ shownText }}<span v-if="tailOnly" class="agg-cursor" aria-hidden="true" /></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Lightbulb } from '@lucide/vue'
import type { ThinkingBlock } from '@taiji/shared'
import MarkdownRenderer from '../MarkdownRenderer.vue'
import './aggregate-motion.css'
import { isThinkingStreaming } from '../composables/useProcessAggregate'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../../primitives/button'
import { formatDuration } from '../format-utils'

const props = defineProps<{
  /** 段成员的 ThinkingBlock（FlatBlock.block.ref 的 thinking 形态） */
  thinking: ThinkingBlock
  /** 是否点开（卡的展开集合透传） */
  expanded: boolean
  /** 所属 session（透传 MarkdownRenderer 供文件路径打开 DetailPane 用） */
  sessionId?: string | null
  /** 段进行中（isLive 透传）：仅作流式判定开关——完成段即使误传 live，历史块也恒非流式 */
  live?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
}>()

const { t } = useI18n()

/** 本块流式中（有 start 无 end；完成段恒 false） */
const streaming = computed(() => props.live === true && isThinkingStreaming(props.thinking))

/** 只露最新一行：进行中且未点开 */
const tailOnly = computed(() => streaming.value && !props.expanded)

/**
 * 只露最新一行时只渲染末尾一段文字：容器贴底对齐、裁成一行高，末尾一行自然露出。
 * 截掉前面的部分让流式期间每次重排的文本量恒定（长思考不至于每个增量重排全文）。
 */
const TAIL_CHARS = 240
const shownText = computed(() => (tailOnly.value ? (props.thinking.content ?? '').slice(-TAIL_CHARS) : (props.thinking.content ?? '')))

const duration = computed(() => {
  const start = props.thinking.startTime
  const end = props.thinking.endTime
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return ''
  return formatDuration(end - start)
})

const textRef = ref<HTMLElement | null>(null)

/** 进行中的全文区跟着最新一行走 */
watch(
  () => [props.thinking.content, tailOnly.value] as const,
  () => {
    if (!streaming.value || tailOnly.value) return
    void nextTick(() => {
      const el = textRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
)

function onTextClick(): void {
  if (tailOnly.value) emit('toggle')
}
</script>

<style scoped>
/* 未点开时恒为一行高；点开放开上限 */
.agg-think {
  max-height: var(--proc-tape-row-h);
  overflow: hidden;
}
.agg-think.is-open {
  max-height: none;
}
.agg-think-btn {
  height: var(--proc-tape-row-h);
}
/* 正文：左缘与标签文字对齐 */
.agg-think-tx {
  margin: 2px 0 2px 31px;
  max-height: 240px;
  overflow: auto;
  color: var(--neutral-mid);
  font-size: var(--text-base);
  line-height: 1.7;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
/* 只露最新一行：贴底对齐、裁成一行高、可点开 */
.agg-think-tx.is-tail {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  height: var(--proc-tape-row-h);
  margin: 0 0 0 31px;
  overflow: hidden;
  cursor: pointer;
}
/* 文字块不参与弹性收缩：保持内容高度，容器贴底对齐并裁成一行，露出的就是最新一行
   （默认的收缩会把它压成一行高，多出的内容直接消失） */
.agg-think-in {
  flex: none;
}</style>
