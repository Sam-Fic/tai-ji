<!--
  过程卡 · 窗口内容（chat-flow-v2）：思考块与工具步按发生顺序逐行平铺，一个 block 一行。
  行序列 = segment.units 的逐行投影：member 单元原样成行，group 单元按成员顺序展开成行
  （窗口内不设分组标题行）；不重新归组、不改顺序。
  行高 24px、行间无间隙（12 行窗口 = 288px 整）。
  行入场动效只用透明度、不用位移：位移会临时增大窗口的内容高度，把贴底的窗口判成未贴底
  （机制探针 scripts/acceptance/motion-overflow.mjs）。
  单步详情抽屉接线（U4）：成员行 open-detail 事件在本组件本地消费，挂 AggregateToolDetailDrawer。
-->
<template>
  <div
    class="agg-expanded flex flex-col"
    :class="bodyIn ? 'agg-body-in' : ''"
    data-testid="agg-expanded"
  >
    <div
      v-for="(row, i) in rows"
      :key="row.key"
      class="agg-row-in"
      :style="{ animationDelay: `${rowDelayMs(i)}ms` }"
      :data-testid="`agg-row-${i}`"
    >
      <SegmentThinkingRow
        v-if="row.kind === 'thinking'"
        :thinking="row.block.block.ref as ThinkingBlock"
        :session-id="sessionId"
        :live="live"
      />
      <SegmentToolRow
        v-else
        :tool="row.block.block.ref as ToolCall"
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
import type { FlatBlock, ProcessSegment } from '@taiji/core/domain/chat'
import type { ThinkingBlock, ToolCall } from '@taiji/shared'
import SegmentThinkingRow from './SegmentThinkingRow.vue'
import SegmentToolRow from './SegmentToolRow.vue'
import AggregateToolDetailDrawer from './AggregateToolDetailDrawer.vue'

const props = defineProps<{
  /** 段数据（units 是窗口行序唯一投影） */
  segment: ProcessSegment
  /** 所属 session（透传思考行与抽屉富渲染） */
  sessionId?: string | null
  /** 段进行中（isLive 透传）：思考行按自身时间戳启用流式形态，缺省完成态形态 */
  live?: boolean
}>()

type TapeRow =
  | { key: string; kind: 'thinking'; block: FlatBlock }
  | { key: string; kind: 'tool'; block: FlatBlock }

/** 窗口行序列：units 逐行投影（group 单元按成员顺序展开，不另设标题行） */
const rows = computed<TapeRow[]>(() => {
  const out: TapeRow[] = []
  for (const unit of props.segment.units) {
    if (unit.kind === 'group') {
      for (const m of unit.group.members) out.push({ key: `m${m.flatIndex}`, kind: 'tool', block: m })
    } else {
      out.push({
        key: `m${unit.block.flatIndex}`,
        kind: unit.block.block.kind === 'thinking' ? 'thinking' : 'tool',
        block: unit.block,
      })
    }
  }
  return out
})

/** 行错峰延迟常量：打开窗口时首行 30ms 起、逐行 +10ms、封顶 160ms */
const ROW_DELAY_BASE_MS = 30
const ROW_DELAY_STEP_MS = 10
const ROW_DELAY_MAX_MS = 160

/**
 * 行错峰延迟只给「打开窗口时已在场」的行（用户显式动作的反馈）；之后追加的行零延迟出现——
 * 进行中的最新一行晚一步才浮现，会显得迟滞。
 */
const openingRowCount = ref(Number.MAX_SAFE_INTEGER)
/* 展开内容浮现 500ms：挂载即播（onMounted 后挂类，避免首帧抢在插入前播）；
   收起再展开重新挂载重新播放（用户显式动作反馈，D10 语义） */
const bodyIn = ref(false)
onMounted(() => {
  bodyIn.value = true
  openingRowCount.value = rows.value.length
})
function rowDelayMs(index: number): number {
  if (index >= openingRowCount.value) return 0
  return Math.min(ROW_DELAY_BASE_MS + index * ROW_DELAY_STEP_MS, ROW_DELAY_MAX_MS)
}

/* ── 单步详情抽屉接线（U4）：开合态与锚定工具 id 都是本组件本地 ref（D6 同款瞬态，
      不落 store、不持久化）。锚定 id 而非对象引用：core applyEntry 是「新数组 + 新对象」的
      不可变替换形态——工具完成时块对象整体替换、旧引用不更新；按 id 从段 units 现查
      （id 是 pi 工具调用 id，跨对象替换稳定），运行中步骤的状态翻转在抽屉内容里实时跟随。 ── */
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

/** 抽屉锚定的当前工具调用：按 id 从窗口行序列现查（找不到 = 锚定成员已不在段内，抽屉内容位随之清空） */
const detailTool = computed<ToolCall | null>(() => {
  const id = detailToolId.value
  if (!id) return null
  for (const row of rows.value) {
    if (row.kind === 'tool' && (row.block.block.ref as ToolCall).id === id) return row.block.block.ref as ToolCall
  }
  return null
})
</script>

<style scoped>
/* 展开内容浮现（500ms，D10）：只用透明度（位移会临时改变窗口的内容高度） */
.agg-body-in {
  animation: agg-body-in 500ms var(--ease-out-soft, ease-out);
}

@keyframes agg-body-in {
  from {
    opacity: 0;
  }
}

/* 行浮现（220ms + 打开时的错峰延迟）：只用透明度 */
.agg-row-in {
  animation: agg-row-in 220ms var(--ease-out-soft, ease-out) backwards;
}

@keyframes agg-row-in {
  from {
    opacity: 0;
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
