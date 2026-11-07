<!--
  聚合块 · 展开平铺区（chat-flow-process-aggregate U2，终态③）：units 按真实发生顺序
  一维平铺——思考行（SegmentThinkingRow，复用 ThinkingRow 行内展开 240px）与工具组
  （SegmentToolGroup，组头纯标题 + 成员全铺开）/ 独立工具行（SegmentToolRow）交替，
  无二次折叠（GL3）。渲染归属以 core units 投影为准，本组件零拼接。
  单步详情抽屉接线（U4）：成员行 open-detail 事件在本组件本地消费（detailTool + detailOpen
  本地 ref，D6 同款瞬态不落 store），挂载 AggregateToolDetailDrawer（壳 = primitives/dialog
  ToolDetailDrawer，自有开合态）——事件链终结于此，不向容器冒泡。
  动效（D10）：展开区行错峰浮现（300ms + 逐行 30-160ms 阶梯延迟，demo 实装值形态）——
  用户显式动作的反馈，每次展开播放（v-if 重新挂载即重播，语义正确）；展开内容浮现 500ms。
  行 wrapper 承担错峰动画类与延迟，子组件保持纯内容（动画 keyframes 与消费同组件 scoped
  自洽，RunningBlockIcon 先例）。
-->
<template>
  <div
    class="agg-expanded mt-1 flex flex-col gap-0.5"
    :class="bodyIn ? 'agg-body-in' : ''"
    data-testid="agg-expanded"
  >
    <div
      v-for="(unit, i) in segment.units"
      :key="unitKey(unit)"
      class="agg-row-in"
      :style="{ animationDelay: `${rowDelayMs(i)}ms` }"
      :data-testid="`agg-row-${i}`"
    >
      <SegmentThinkingRow
        v-if="unit.kind === 'member' && unit.block.block.kind === 'thinking'"
        :thinking="unit.block.block.ref as ThinkingBlock"
        :session-id="sessionId"
      />
      <SegmentToolRow
        v-else-if="unit.kind === 'member'"
        :tool="unit.block.block.ref as ToolCall"
        @open-detail="openDetail"
      />
      <SegmentToolGroup
        v-else
        :group="unit.group"
        @open-detail="openDetail"
      />
    </div>
    <!-- 单步详情抽屉（U4 接线）：点击成员行打开；Esc/关闭钮经壳 update:open 归位 -->
    <AggregateToolDetailDrawer
      :tool="detailTool"
      :open="detailOpen"
      :session-id="sessionId"
      @update:open="setDetailOpen"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ProcessSegment, ProcessSegmentUnit } from '@taiji/core/domain/chat'
import type { ThinkingBlock, ToolCall } from '@taiji/shared'
import SegmentThinkingRow from './SegmentThinkingRow.vue'
import SegmentToolRow from './SegmentToolRow.vue'
import SegmentToolGroup from './SegmentToolGroup.vue'
import AggregateToolDetailDrawer from './AggregateToolDetailDrawer.vue'

const props = defineProps<{
  /** 段数据（units 是展开平铺序唯一投影） */
  segment: ProcessSegment
  /** 所属 session（透传思考行 MarkdownRenderer 与抽屉富渲染） */
  sessionId?: string | null
}>()

/** 行错峰延迟常量（demo 实装值形态）：首行 30ms 起、逐行 +10ms、封顶 160ms */
const ROW_DELAY_BASE_MS = 30
const ROW_DELAY_STEP_MS = 10
const ROW_DELAY_MAX_MS = 160

/**
 * 行错峰延迟（30-160ms 阶梯）。成员极多的段阶梯封顶后其余行同 160ms 延迟
 * （不随行数线性增长到不可接受）。
 */
function rowDelayMs(index: number): number {
  return Math.min(ROW_DELAY_BASE_MS + index * ROW_DELAY_STEP_MS, ROW_DELAY_MAX_MS)
}

function unitKey(unit: ProcessSegmentUnit): string {
  return unit.kind === 'group' ? `g${unit.group.members[0]?.flatIndex ?? 0}` : `m${unit.block.flatIndex}`
}

/* ── 单步详情抽屉接线（U4）：开合态与锚定工具 id 都是本组件本地 ref（D6 同款瞬态，
      不落 store、不持久化）；抽屉壳自带 Esc/关闭钮/焦点归还。锚定 id 而非对象引用：
      core applyEntry 是「新数组 + 新对象」的不可变替换形态——工具完成时块对象整体替换、
      旧引用不更新，锚引用会让「仍在执行」注记在终态翻转后挂着不消失；按 id 从段 units
      现查（id 是 pi 工具调用 id，跨对象替换稳定，AX1「以结构定位」同款思想），运行中
      步骤的状态翻转在抽屉内容里实时跟随。 ── */
const detailToolId = ref<string | null>(null)
const detailOpen = ref(false)

function openDetail(tool: ToolCall): void {
  detailToolId.value = tool.id
  detailOpen.value = true
}

function setDetailOpen(value: boolean): void {
  detailOpen.value = value
  if (!value) detailToolId.value = null
}

/** 抽屉锚定的当前工具调用：按 id 从段 units 现查（段 units 是全量成员投影，成员
    不会中途丢失；找不到 = 锚定成员已不在段内，抽屉内容位随之清空） */
const detailTool = computed<ToolCall | null>(() => {
  const id = detailToolId.value
  if (!id) return null
  for (const unit of props.segment.units) {
    if (unit.kind === 'group') {
      const hit = unit.group.members.find((m) => (m.block.ref as ToolCall).id === id)
      if (hit) return hit.block.ref as ToolCall
    } else if (unit.block.block.kind === 'tool' && (unit.block.block.ref as ToolCall).id === id) {
      return unit.block.block.ref as ToolCall
    }
  }
  return null
})

/* 展开内容浮现 500ms：挂载即播（onMounted 后挂类，避免首帧抢在插入前播）；
   收起再展开重新挂载重新播放（用户显式动作反馈，D10 语义） */
const bodyIn = ref(false)
onMounted(() => {
  bodyIn.value = true
})
</script>

<style scoped>
/* 展开内容浮现（500ms，D10）：类挂载触发单次播放 */
.agg-body-in {
  animation: agg-body-in 500ms var(--ease-out-soft, ease-out);
}

@keyframes agg-body-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}

/* 展开区行错峰浮现（300ms + 逐行 30-160ms 阶梯延迟，D10）：延迟经行内 style 注入 */
.agg-row-in {
  animation: agg-row-in 300ms var(--ease-out-soft, ease-out) backwards;
}

@keyframes agg-row-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agg-body-in,
  .agg-row-in {
    animation: none;
    animation-delay: 0ms;
  }
}
</style>
