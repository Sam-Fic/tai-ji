<!--
  聚合块 · 段内思考行（chat-flow-process-aggregate U2）：薄包装——把段成员 FlatBlock 的
  ThinkingBlock 字段适配给既有 ThinkingRow（复用其行内展开机制：点击展开完整文本，
  240px 限高 BlockScrollBox，2026-11-06 用户裁决对齐 spec §3.2）。组件本体不改（设计
  「不改」清单：ThinkingRow 组件本体被聚合块内思考行复用），本组件只做字段适配。
  working 恒 false：展开态只存在于完成段（进行中段无展开入口，AX3），段内思考行不再
  有流式三态（流式中的思考在思考窗呈现）。
-->
<template>
  <ThinkingRow
    :content="thinking.content"
    :thinking-id="thinking.id"
    :thinking-start="thinking.startTime"
    :thinking-end="thinking.endTime"
    :working="false"
    :session-id="sessionId ?? undefined"
  />
</template>

<script setup lang="ts">
import type { ThinkingBlock } from '@taiji/shared'
import ThinkingRow from '../ThinkingRow.vue'

defineProps<{
  /** 段成员的 ThinkingBlock（FlatBlock.block.ref 的 thinking 形态） */
  thinking: ThinkingBlock
  /** 所属 session（透传 MarkdownRenderer 供文件路径打开 DetailPane 用） */
  sessionId?: string | null
}>()
</script>
