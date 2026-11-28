<!--
  过程卡 · 悬停浮层（D4 摘要通道）：工具步行悬停显示工具名 / 状态 / 耗时 / 完整参数 / 最多 8 行输出。
  定位：传送到页面层、按触发行的视口矩形固定定位（行在限高滚动的窗口里，挂在行内的浮层会被
  窗口裁掉）；缺省弹在行上方，上方放不下（会顶出视口）时翻到行下方；左右不出视口。
  硬约束（可访问性规格）：不拦截鼠标（pointer-events-none——浮层区域内可正常滚动对话流）；
  role=tooltip；同等信息可经点击通道（抽屉）获取，不依赖悬停。
  显隐控制归触发行（SegmentToolRow），本组件纯展示。
-->
<template>
  <div
    ref="rootRef"
    role="tooltip"
    class="agg-hover-card pointer-events-none fixed z-[var(--z-hovercard)] w-max max-w-[420px] rounded-[var(--radius-sm)] border border-hairline bg-bg-elevated px-3 py-2 text-left shadow-lg"
    :style="positionStyle"
    data-testid="agg-hover-card"
  >
    <!-- 头行：工具名 + 状态 + 耗时（mono 小字档，元信息 10-11.5px 规格） -->
    <div class="flex items-baseline gap-2 font-mono text-[length:var(--text-2xs)] text-neutral-dim" data-testid="agg-hover-head">
      <span class="text-neutral-mid">{{ tool.toolName }}</span>
      <span :class="isFailed ? 'text-danger' : ''">{{ statusLabel }}</span>
      <span v-if="duration">{{ duration }}</span>
    </div>
    <!-- 完整参数（pre-wrap 原样，与单步行省略相对的「看全」通道） -->
    <pre v-if="paramText" class="agg-hover-param mt-1 max-h-[160px] overflow-y-auto whitespace-pre-wrap break-all font-mono text-[length:var(--text-2xs)] leading-[1.5] text-neutral-mid" data-testid="agg-hover-param">{{ paramText }}</pre>
    <!-- 输出前 8 行（含失败 error 文本兜底，ToolRow displayContent 同口径） -->
    <pre v-if="outputPreview" class="agg-hover-output mt-1 whitespace-pre-wrap break-all font-mono text-[length:var(--text-2xs)] leading-[1.5] text-neutral-dim" data-testid="agg-hover-output">{{ outputPreview }}</pre>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ToolCall } from '@taiji/shared'
import { formatDuration } from '../format-utils'
import { toolArgSummaryText } from './tool-arg-summary'

const props = defineProps<{
  /** 悬停锚定的工具调用（完整参数与输出数据源） */
  tool: ToolCall
  /** 触发行的视口矩形（显示那一刻由触发行取一次；之后行一动浮层即收起） */
  anchor: { top: number; bottom: number; left: number }
}>()

const { t } = useI18n()

/** 浮层输出行数上限（最多 8 行） */
const HOVER_OUTPUT_MAX_LINES = 8
/** 浮层与触发行的间距、距视口边缘的最小留白 */
const GAP_PX = 4
const VIEWPORT_MARGIN_PX = 8

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

/** 输出前 8 行（「最多 8 行输出」）；output 空时失败 error 文本兜底 */
const outputPreview = computed(() => {
  const raw = props.tool.output || (isFailed.value ? (props.tool.error ?? '') : '')
  if (!raw) return ''
  return raw.split('\n').slice(0, HOVER_OUTPUT_MAX_LINES).join('\n')
})

/* ── 定位：挂载后按实际尺寸定左右与上下方向 ── */
const rootRef = ref<HTMLElement | null>(null)
/** 行上方放不下（会顶出视口）时翻到行下方 */
const flipDown = ref(false)
const left = ref(props.anchor.left)

onMounted(() => {
  const el = rootRef.value
  if (!el) return
  const maxLeft = window.innerWidth - el.offsetWidth - VIEWPORT_MARGIN_PX
  left.value = Math.max(VIEWPORT_MARGIN_PX, Math.min(props.anchor.left, maxLeft))
  flipDown.value = props.anchor.top - el.offsetHeight - GAP_PX < VIEWPORT_MARGIN_PX
})

const positionStyle = computed(() =>
  flipDown.value
    ? { top: `${props.anchor.bottom + GAP_PX}px`, left: `${left.value}px` }
    : { bottom: `${window.innerHeight - props.anchor.top + GAP_PX}px`, left: `${left.value}px` },
)
</script>
