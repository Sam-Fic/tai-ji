<!--
  聚合块 · 段内思考行（chat-flow-process-aggregate U2）：薄包装——把段成员 FlatBlock 的
  ThinkingBlock 字段适配给既有 ThinkingRow（复用其行内展开机制：点击展开完整文本，
  240px 限高 BlockScrollBox，2026-11-06 用户裁决对齐 spec §3.2）。组件本体不改（设计
  「不改」清单：ThinkingRow 组件本体被聚合块内思考行复用），本组件只做字段适配与
  行级对齐。
  working 判定（2026-11-09 用户裁决：进行中同构可展开）：进行中段展开时流式中的思考
  （有 start 无 end，useProcessAggregate.thinkingStreaming 同判据）传 working=true
  ——复用 ThinkingRow 流式形态（尾部行视口 + 双轴尾部追踪）；完成段与已完成思考块恒
  false（历史块双时间戳缺失也天然 false）。收起态流式思考仍在思考窗呈现，不受影响。
  对齐规格（spec §7.3 / V2 通过标准）：负 8px 外边距 + 8px 内边距与本组其余行
  （AggregateSummaryRow / SegmentToolGroup 组头 / SegmentToolRow）统一——挂在
  ThinkingRow 根类（单根组件 attrs 透传，不加 DOM 层，同 SegmentToolGroup→
  SegmentToolRow pl-6 先例），思考行图标与正文左缘对齐。
-->
<template>
  <ThinkingRow
    class="-mx-2 px-2"
    :content="thinking.content"
    :thinking-id="thinking.id"
    :thinking-start="thinking.startTime"
    :thinking-end="thinking.endTime"
    :working="working"
    :session-id="sessionId ?? undefined"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ThinkingBlock } from '@taiji/shared'
import ThinkingRow from '../ThinkingRow.vue'

const props = defineProps<{
  /** 段成员的 ThinkingBlock（FlatBlock.block.ref 的 thinking 形态） */
  thinking: ThinkingBlock
  /** 所属 session（透传 MarkdownRenderer 供文件路径打开 DetailPane 用） */
  sessionId?: string | null
  /** 段进行中（isLive 透传）：仅作流式判定开关——流式态最终由本块自身时间戳派生
   *  （完成段即使误传 live，历史块双时间戳缺失也恒 false） */
  live?: boolean
}>()

/** 本块流式中（有 start 无 end；与 useProcessAggregate.thinkingStreaming 同判据）。
 *  live=false（完成段）短路 false——判据只作流式形态开关，不独立于段状态。 */
const working = computed(() => props.live === true
  && typeof props.thinking.startTime === 'number'
  && typeof props.thinking.endTime !== 'number')
</script>
