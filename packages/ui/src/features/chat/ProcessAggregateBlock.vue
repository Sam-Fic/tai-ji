<!--
  展示组件 · 过程聚合块（ProcessAggregateBlock，chat-flow-process-aggregate U2）：
  两条正文块之间的过程段收进一个自维护三态的容器（设计终态①②③）——
  ① 进行中：开放容器，摘要行 live 变体（呼吸弧行首 + 实时计数）+ 双固定高度窗口
    （最新思考窗 + 内部聚合窗），窗口可见性由段内已开始步骤类型纯派生（D7），
    占位与段内步骤数解耦（AX2/GL1）；[2026-11-09 用户裁决] 进行中与完成态同构提供
    点击展开（推翻原「进行中无标题行不可展开」约束 AX3 的不可展开半边）——收起 =
    双窗，展开 = units 平铺（running 步骤实时跟随状态翻转）；
  ② 已完成：一行摘要（分类计数 + 思考数 + 总耗时 + 失败标记），点击整行展开/收起；
  ③ 展开：units 按真实顺序平铺（思考行与工具组交替），无二次折叠（GL3）。
  三态判定：进行中 ⇔ turnWorking ∧ !followedByText（core 段契约「调用方合成」条款）；
  展开/收起是组件本地 ref（D6：不落 store、不持久化），两态共用同一 ref——进行中
  展开着落成时无缝切换为「摘要行 + 平铺区」完成形态，不跳变。
  数据契约：本组件只消费 core ProcessSegment（切段/分组/计数在 core 单点算好，渲染层
  零解析，AX7）。Turn 编排已接线（Turn.vue trace 区单元挂载，传 turn-streaming）。
  单步详情通道：悬停浮层在本组件族内；单步行点击的 open-detail 事件在 AggregateExpandedBody
  本地终结消费（U4 接线：本地 ref 开合态挂抽屉），本组件与 Turn 层均无接线点。
-->
<template>
  <div :class="['agg-block', entranceClass]" data-testid="process-aggregate">
    <!-- 摘要行恒渲染（展开交互的可见入口，两态共用；live 变体见 AggregateSummaryRow）；
         单步详情抽屉在展开区本地接线（AggregateExpandedBody 自持开合态），事件链
         终结于此不向容器冒泡——本组件无 open-detail 转发/声明 -->
    <AggregateSummaryRow :segment="segment" :expanded="expanded" :live="isLive" @toggle="toggleExpanded" />
    <!-- ① 进行中收起：双窗（无外框）；展开 = 平铺区（与完成态同一 v-if 位） -->
    <AggregateLiveWindows v-if="isLive && !expanded" :segment="segment" />
    <!-- ③ 平铺区（两态共用）：units 按真实顺序，running 成员实时态 -->
    <AggregateExpandedBody v-if="expanded" :segment="segment" :session-id="sessionId" :live="isLive" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ProcessSegment } from '@taiji/core/domain/chat'
import AggregateLiveWindows from './process-aggregate/AggregateLiveWindows.vue'
import AggregateSummaryRow from './process-aggregate/AggregateSummaryRow.vue'
import AggregateExpandedBody from './process-aggregate/AggregateExpandedBody.vue'
import { useProcessAggregateState } from './composables/useProcessAggregate'

const props = defineProps<{
  /** 段数据（core 切段纯函数输出；fixture 驱动期由测试/调用方构造） */
  segment: ProcessSegment
  /** 回合工作态（Turn isWorkingTurn 同源；与 followedByText 合成三态判定） */
  turnWorking: boolean
  /** 回合级流式（Turn isStreaming 同源；入场一次性判据的「真实到达」信号——缺省 = 非流式
   *  即不出入场动画，宁缺勿重放。仅挂载期消费，不入 v-memo deps。判定依据见
   *  useProcessAggregateState.entranceClass 注释） */
  turnStreaming?: boolean
  /** 所属 session（透传思考行 MarkdownRenderer） */
  sessionId?: string | null
}>()

const { isLive, expanded, toggleExpanded, entranceClass } = useProcessAggregateState({
  segment: computed(() => props.segment),
  turnWorking: computed(() => props.turnWorking),
  turnStreaming: computed(() => props.turnStreaming === true),
})
</script>

<style scoped>
/* 聚合块入场（340ms 上移 9px 淡入，D10）：类由挂载时求值的一次性判据挂载
   （composable entranceClass——判据含 turnStreaming 真实到达信号，virtua 卸载重挂载
   （含等待态工作回合）与键抖动全量重挂载均无该类，判定依据见 useProcessAggregateState
   注释），keyframes from 帧 ≠ 元素常态，单次播放后停在常态，类恒挂不构成重放 */
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
