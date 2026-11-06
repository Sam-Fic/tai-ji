<!--
  聚合块 · 进行中双窗（chat-flow-process-aggregate U2，D7）：思考窗 92px（窄屏 78px）+
  聚合窗 116px（窄屏 96px），间距 10px。无外框无标题行（进行中态容器形态，任务书硬约束）。
  窗口可见性纯派生（v-if 由段内已开始步骤类型决定，composable 派生）：
  - 思考窗：段内已有思考步骤才出现；显示「最新思考」实时文本、自动跟底，思考结束停住
    （内容不再变化），下一段思考开始切换内容（computed 内容源切换）；
  - 聚合窗：段内首个工具步骤开始才挂载——立即挂载（v-if 即时）+ 300ms 上浮淡入（CSS
    动画，边沿触发见 composable），不预留高度、无「等待工具调用」空态占位；
  - 纯思考段聚合窗全程不出现。
  思考窗渐变底 + 上下 16px 渐隐遮罩：BlockScrollBox 既有双向渐隐同族形态（pointer-events
  -none 绝对定位渐变条 + 按滚动方向 opacity 显形），渐隐宽度 h-4 = 16px 落规格 13-18px 区间。
  聚合条：条目 = units 过滤思考成员（组行与独立行按真实顺序交替），运行中条目高亮 +
  1.9s 流光，失败即时「含 N 次失败」（D3 直播口径）；窗口自动滚到最新（用户上滚停吸）。
-->
<template>
  <div class="flex flex-col gap-[10px]" data-testid="agg-live-windows">
    <!-- 思考窗 -->
    <div
      v-if="hasThinking"
      class="agg-think-window relative overflow-hidden rounded-[var(--radius-sm)]"
      :style="{ height: thinkHeight }"
      data-testid="agg-think-window"
    >
      <div
        ref="thinkViewport"
        class="h-full overflow-y-auto overscroll-contain px-3 py-2 whitespace-pre-wrap text-[length:var(--text-sm)] leading-[1.6] text-neutral-mid"
        :class="thinkingStreaming ? 'text-sweep [--sweep-base:var(--neutral-mid)]' : ''"
        data-testid="agg-think-viewport"
        @scroll.passive="onThinkScroll"
      >{{ thinkingContent }}</div>
      <!-- 双向渐隐遮罩（BlockScrollBox 同族：仅该方向可滚时显形；不拦截指针） -->
      <div
        class="pointer-events-none absolute inset-x-0 top-0 h-4 opacity-0 transition-opacity duration-[var(--duration-fast)] bg-[image:linear-gradient(to_bottom,var(--accent-soft),transparent)]"
        :class="thinkCanScrollUp ? 'opacity-100' : 'opacity-0'"
        aria-hidden="true"
      />
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 h-4 opacity-0 transition-opacity duration-[var(--duration-fast)] bg-[image:linear-gradient(to_top,var(--bg),transparent)]"
        :class="thinkAtBottom ? 'opacity-0' : 'opacity-100'"
        aria-hidden="true"
      />
    </div>
    <!-- 聚合窗：聚合条条目序与展开区同源（units 投影），零二次拼接 -->
    <div
      v-if="hasToolCall"
      class="relative overflow-hidden rounded-[var(--radius-sm)]"
      :class="aggregateWindowEntered ? 'agg-window-in' : ''"
      :style="{ height: aggregateHeight }"
      data-testid="agg-window"
    >
      <div
        ref="aggregateViewport"
        class="flex h-full flex-col gap-1 overflow-y-auto overscroll-contain px-3 py-2"
        data-testid="agg-strip-viewport"
        @scroll.passive="onAggregateScroll"
      >
        <template v-for="unit in stripUnits" :key="stripKey(unit)">
          <!-- 组条目：组名 + 运行态/步数统计 + 失败计数（运行中高亮 + 流光见 scoped） -->
          <div
            v-if="unit.kind === 'group'"
            class="flex shrink-0 items-baseline gap-2 rounded-[var(--radius-xs)] px-1 py-0.5 text-[length:var(--text-sm)]"
            :class="unit.group.hasRunning ? 'agg-strip--running text-neutral-mid' : 'text-neutral-dim'"
            :data-testid="unit.group.hasRunning ? 'agg-strip-current' : 'agg-strip-group'"
          >
            <span class="shrink-0 [font-weight:var(--fw-mid)]">{{ t(RUN_GROUP_LABEL_KEY[unit.group.base]) }}</span>
            <span v-if="unit.group.hasRunning" class="shrink-0">{{ t('panel.message.aggGroupRunning') }}</span>
            <span class="min-w-0 truncate font-mono text-[length:var(--text-2xs)]">{{ groupStatText(unit.group) }}</span>
            <span
              v-if="unit.group.failedCount > 0"
              class="shrink-0 rounded-[var(--radius-xs)] bg-danger-soft px-1.5 py-px text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] text-danger"
            >{{ t('panel.message.traceFailed', { count: unit.group.failedCount }) }}</span>
          </div>
          <!-- 独立行条目（类型表外工具 / agentgraph）：工具名 + 运行态/统计 -->
          <div
            v-else-if="isProcessToolBlock(unit.block.block)"
            class="flex shrink-0 items-baseline gap-2 rounded-[var(--radius-xs)] px-1 py-0.5 text-[length:var(--text-sm)]"
            :class="toolStatusOf(unit.block.block) === 'running' ? 'agg-strip--running text-neutral-mid' : 'text-neutral-dim'"
            :data-testid="toolStatusOf(unit.block.block) === 'running' ? 'agg-strip-current' : 'agg-strip-row'"
          >
            <span class="shrink-0 [font-weight:var(--fw-mid)]">{{ toolRef(unit.block.block).toolName }}</span>
            <span v-if="toolStatusOf(unit.block.block) === 'running'" class="shrink-0">{{ t('panel.message.aggGroupRunning') }}</span>
            <span
              v-if="toolRef(unit.block.block).status === 'error'"
              class="shrink-0 rounded-[var(--radius-xs)] bg-danger-soft px-1.5 py-px text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] text-danger"
            >{{ t('panel.message.traceFailed', { count: 1 }) }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RunGroupBase, ProcessToolGroup, ProcessSegment, ProcessSegmentUnit } from '@taiji/core/domain/chat'
import type { ToolCall } from '@taiji/shared'
import { useChatDensity } from '../chat-view-deps'
import {
  THINKING_WINDOW_HEIGHT_PX,
  AGGREGATE_WINDOW_HEIGHT_PX,
  useAggregateWindows,
} from '../composables/useProcessAggregate'
import { formatDuration } from '../format-utils'

const props = defineProps<{
  /** 段数据（core 切段输出；双窗可见性与条目序纯派生） */
  segment: ProcessSegment
}>()

const { t } = useI18n()
const density = useChatDensity()

const {
  hasThinking,
  hasToolCall,
  thinkingContent,
  thinkingStreaming,
  aggregateWindowEntered,
  thinkViewport,
  thinkAtBottom,
  thinkCanScrollUp,
  onThinkScroll,
  aggregateViewport,
  onAggregateScroll,
  stripUnits,
} = useAggregateWindows(computed(() => props.segment))

/** 双窗高度：desktop / mobile（≤420px 窄屏同档）两档固定值，内联 style 承载（可测） */
const thinkHeight = computed(() => `${THINKING_WINDOW_HEIGHT_PX[density]}px`)
const aggregateHeight = computed(() => `${AGGREGATE_WINDOW_HEIGHT_PX[density]}px`)

/** 组类型 → 组名 i18n 键（SegmentToolGroup 同键同值；条目行不落图标，名 + 统计即可） */
const RUN_GROUP_LABEL_KEY: Record<RunGroupBase, string> = {
  explore: 'panel.message.runGroupExplore',
  edit: 'panel.message.runGroupEdit',
  exec: 'panel.message.runGroupExec',
}

function groupStatText(group: ProcessToolGroup): string {
  const steps = t('panel.message.runGroupSteps', { count: group.members.length })
  const duration = group.durationMs > 0 ? formatDuration(group.durationMs) : ''
  return duration ? `${steps} · ${duration}` : steps
}

/* ── 独立行条目的工具形态收窄：agentgraph 与类型表外工具块 ref 均为 ToolCall ── */
function isProcessToolBlock(block: { kind: string; ref: unknown }): boolean {
  return block.kind === 'tool' || block.kind === 'agentgraph'
}
function toolRef(block: { kind: string; ref: unknown }): ToolCall {
  return block.ref as ToolCall
}
function toolStatusOf(block: { kind: string; ref: unknown }): ToolCall['status'] {
  return toolRef(block).status
}

function stripKey(unit: ProcessSegmentUnit): string {
  return unit.kind === 'group' ? `g${unit.group.members[0]?.flatIndex ?? 0}` : `m${unit.block.flatIndex}`
}
</script>

<style scoped>
/* 思考窗渐变底：低饱和强调色纵向渐变（--accent-soft 10% accent，spec 渐变节「低饱和
   强调色纵向渐变底」），向下约七成衰减到透明 */
.agg-think-window {
  background-image: linear-gradient(to bottom, var(--accent-soft), transparent 70%);
}

/* 聚合窗挂载浮现（300ms 上移 4px 淡入，D10）：类由增量边沿挂载（composable
   aggregateWindowEntered），单次播放后停在元素常态（keyframes from 帧 ≠ 元素常态），
   恒挂不构成重放 */
.agg-window-in {
  animation: agg-window-in 300ms var(--ease-out-soft, ease-out);
}

@keyframes agg-window-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}

/* 运行中聚合条流光（1.9s 循环，D10）：横向强调色渐变扫过条底（text-sweep 同机制作用于
   背景层）；非运行条目中性底无动画 */
.agg-strip--running {
  background-image: linear-gradient(100deg, transparent 42%, var(--accent-soft) 50%, transparent 58%);
  background-size: 250% 100%;
  background-repeat: no-repeat;
  animation: agg-strip-sweep 1.9s cubic-bezier(0.45, 0, 0.25, 1) infinite;
}

@keyframes agg-strip-sweep {
  from {
    background-position: 120% 0;
  }
  to {
    background-position: -120% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .agg-window-in,
  .agg-strip--running {
    animation: none;
  }
}
</style>
