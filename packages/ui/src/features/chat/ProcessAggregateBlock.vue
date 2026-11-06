<!--
  展示组件 · 过程聚合块（ProcessAggregateBlock，chat-flow-process-aggregate U2）：
  两条正文块之间的过程段收进一个自维护三态的容器（设计终态①②③）——
  ① 进行中：开放容器（无外框无标题行），内部双固定高度窗口（最新思考窗 + 内部聚合窗），
    可见性由段内已开始步骤类型纯派生（D7），占位与段内步骤数解耦（AX2/GL1）；
  ② 已完成：一行摘要（分类计数 + 思考数 + 总耗时 + 失败标记），点击整行展开/收起；
  ③ 展开：units 按真实顺序平铺（思考行与工具组交替），无二次折叠（GL3）。
  三态判定：进行中 ⇔ turnWorking ∧ !followedByText（core 段契约「调用方合成」条款）；
  展开/收起是组件本地 ref（D6：不落 store、不持久化）。
  数据契约：本组件只消费 core ProcessSegment（切段/分组/计数在 core 单点算好，渲染层
  零解析，AX7）。fixture 驱动开发（不接线 Turn——编排切换在 U3/u-wiring）。
  单步详情通道：悬停浮层在本组件族内；点击 emit open-detail，右侧抽屉由 U4 接线；
  Turn 编排接线在 u-wiring 单元。
-->
<template>
  <div :class="['agg-block', entranceClass]" data-testid="process-aggregate">
    <!-- ① 进行中：双窗（无外框无标题行） -->
    <AggregateLiveWindows v-if="isLive" :segment="segment" />
    <!-- ②③ 完成态：摘要行 +（展开时）平铺区 -->
    <template v-else>
      <AggregateSummaryRow :segment="segment" :expanded="expanded" @toggle="toggleExpanded" />
      <AggregateExpandedBody
        v-if="expanded"
        :segment="segment"
        :session-id="sessionId"
        @open-detail="(tool) => emit('open-detail', tool)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ProcessSegment } from '@taiji/core/domain/chat'
import type { ToolCall } from '@taiji/shared'
import AggregateLiveWindows from './process-aggregate/AggregateLiveWindows.vue'
import AggregateSummaryRow from './process-aggregate/AggregateSummaryRow.vue'
import AggregateExpandedBody from './process-aggregate/AggregateExpandedBody.vue'
import { useProcessAggregateState } from './composables/useProcessAggregate'

const props = defineProps<{
  /** 段数据（core 切段纯函数输出；fixture 驱动期由测试/调用方构造） */
  segment: ProcessSegment
  /** 回合工作态（Turn isWorkingTurn 同源；与 followedByText 合成三态判定） */
  turnWorking: boolean
  /** 所属 session（透传思考行 MarkdownRenderer） */
  sessionId?: string | null
}>()

const emit = defineEmits<{
  /** 单步行点击 → 抽屉触发（抽屉壳接线在 U4；Turn 层转发在 u-wiring） */
  (e: 'open-detail', tool: ToolCall): void
}>()

const { isLive, expanded, toggleExpanded, entranceClass } = useProcessAggregateState({
  segment: computed(() => props.segment),
  turnWorking: computed(() => props.turnWorking),
})
</script>

<style scoped>
/* 聚合块入场（340ms 上移 9px 淡入，D10）：类由挂载时求值的一次性判据挂载
   （composable entranceClass——virtua 卸载重挂载 / 键抖动全量重挂载均无该类），
   keyframes from 帧 ≠ 元素常态，单次播放后停在常态，类恒挂不构成重放 */
.agg-enter {
  animation: agg-enter 340ms var(--ease-out-soft, ease-out);
}

@keyframes agg-enter {
  from {
    opacity: 0;
    transform: translateY(9px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agg-enter {
    animation: none;
  }
}
</style>
