<!--
  聚合块 · 悬停浮层（chat-flow-process-aggregate U2，D4 摘要通道）：单步行悬停显示
  工具名 / 状态 / 耗时 / 完整参数 / 最多 8 行输出。
  硬约束（任务书 / 设计可访问性节）：不拦截鼠标（pointer-events:none——浮层区域内可正常
  滚动对话流）；role=tooltip；同等信息可经点击通道（抽屉，U4 接线）获取，不依赖悬停。
  显隐控制归触发行（SegmentToolRow），本组件纯展示。
-->
<template>
  <div
    role="tooltip"
    class="agg-hover-card pointer-events-none absolute bottom-full left-0 z-50 mb-1 w-max max-w-[420px] rounded-[var(--radius-sm)] border border-hairline bg-bg-elevated px-3 py-2 text-left shadow-lg"
    data-testid="agg-hover-card"
  >
    <!-- 头行：工具名 + 状态 + 耗时（mono 小字档，元信息 10-11.5px 规格） -->
    <div class="flex items-baseline gap-2 font-mono text-[length:var(--text-2xs)] text-neutral-dim" data-testid="agg-hover-head">
      <span class="text-neutral-mid">{{ tool.toolName }}</span>
      <span :class="isFailed ? 'text-danger' : ''">{{ statusLabel }}</span>
      <span v-if="duration">{{ duration }}</span>
    </div>
    <!-- 完整参数（pre-wrap 原样，与单步行超宽省略相对的「看全」通道） -->
    <pre v-if="paramText" class="agg-hover-param mt-1 max-h-[160px] overflow-y-auto whitespace-pre-wrap break-all font-mono text-[length:var(--text-2xs)] leading-[1.5] text-neutral-mid" data-testid="agg-hover-param">{{ paramText }}</pre>
    <!-- 输出前 8 行（含失败 error 文本兜底，ToolRow displayContent 同口径） -->
    <pre v-if="outputPreview" class="agg-hover-output mt-1 whitespace-pre-wrap break-all font-mono text-[length:var(--text-2xs)] leading-[1.5] text-neutral-dim" data-testid="agg-hover-output">{{ outputPreview }}</pre>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ToolCall } from '@taiji/shared'
import { formatDuration } from '../format-utils'
import { toolArgSummaryText } from './tool-arg-summary'

const props = defineProps<{
  /** 悬停锚定的工具调用（完整参数与输出数据源） */
  tool: ToolCall
}>()

const { t } = useI18n()

/** 浮层输出行数上限（任务书硬约束：最多 8 行） */
const HOVER_OUTPUT_MAX_LINES = 8

const isFailed = computed(() => props.tool.status === 'error')

/** 状态词：running/completed/error 有既有行态词，end_not_received 显示耗时口径「—」 */
const statusLabel = computed(() => {
  if (props.tool.status === 'error') return t('panel.message.aggRowFailed')
  if (props.tool.status === 'running') return t('panel.message.aggGroupRunning')
  if (props.tool.status === 'completed') return t('panel.message.aggStatusDone')
  return '—'
})

const duration = computed(() => {
  const { startTime, endTime } = props.tool
  if (typeof startTime !== 'number' || typeof endTime !== 'number') return ''
  return formatDuration(Math.max(0, endTime - startTime))
})

/**
 * 参数摘要（字段序单源 tool-arg-summary：command/path/pattern/query/code——展示级提取，
 * 非成员资格判定）；未覆盖形态回退单行 JSON，与「完整参数」的浮层义务一致。
 */
const paramText = computed(() => toolArgSummaryText(props.tool.input))

/** 输出前 8 行（「最多 8 行输出」硬约束）；output 空时失败 error 文本兜底 */
const outputPreview = computed(() => {
  const raw = props.tool.output || (isFailed.value ? (props.tool.error ?? '') : '')
  if (!raw) return ''
  return raw.split('\n').slice(0, HOVER_OUTPUT_MAX_LINES).join('\n')
})
</script>
