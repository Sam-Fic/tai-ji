<!--
  聚合块 · 摘要行（chat-flow-process-aggregate U2，终态② + live 变体）：过程图标 + 「过程」 +
  分类计数（探索 N · 修改 N · 执行命令 N，0 的类型省略）+ 思考 N + 总耗时 + 失败标记
  （含 M 次失败，danger chip）。计数唯一数据源 = core ProcessSegmentCounts（段级口径，
  与组头/聚合条三处同口径——D3/RL4）。真实 button + aria-expanded 同步（可访问性规格）；
  点击整行展开/收起，展开态由容器（D6 组件本地 ref）持有，本组件纯受控。
  总耗时格式复用 formatDurationHms（mono 计时口径 SSOT：45s / 2m00s / 1h02m03s）。
  [live 变体（2026-11-09 用户裁决：进行中同构可展开）] 段进行中（isLive）时本行即进行中
  形态的展开入口：行首 Layers 换呼吸弧 loader（复用 block-icon.ts RUNNING_LOADER_SVG
  SSOT + animate-loader-spin，ActivityStrip 活动行同款「进行中」信号）；总耗时隐藏
  （live 期 totalDurationMs 只累计已完成步骤，不构成段耗时语义）；分类/思考/失败计数
  保持实时（core counts 响应式重建）。落成瞬间图标交叉切回 Layers、耗时行出现——
  与块级三态切换同帧。
-->
<template>
  <Button
    variant="ghost"
    class="agg-summary -mx-2 h-auto w-full justify-start gap-2 rounded-[var(--radius-xs)] px-2 py-1 [font-weight:var(--fw-mid)] text-neutral-mid focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-[color:var(--focus-ring)] hover:text-neutral-mid"
    :aria-expanded="expanded"
    data-testid="agg-summary-row"
    @click="emit('toggle')"
  >
    <!-- live 行首呼吸弧：复用 block-icon.ts 的 RUNNING_LOADER_SVG（呼吸弧 SSOT，禁止
         手抄同构副本；.ld-track/.ld-arc 动画类由 style.css 全局层持有）。testid 挂
         v-html 包装层，与 TurnRail / BashOutputBlock / MarkdownRenderer / TurnMeta
         四处既有消费同形态 -->
    <!-- eslint-disable-next-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
    <span v-if="live" class="inline-flex size-[15px] shrink-0 self-center items-center justify-center text-accent animate-loader-spin" data-testid="agg-summary-live-loader" v-html="RUNNING_LOADER_SVG" />
    <Layers v-else class="size-[15px] shrink-0 self-center text-neutral-ico [stroke-width:1.6]" aria-hidden="true" />
    <span class="shrink-0">{{ t('panel.message.aggProcessLabel') }}</span>
    <!-- 分类计数：categoryCounts 三类按序（explore/edit/exec），0 省略——v-if 省略（DOM
         不渲染）：fx spec「摘要行只列存在的类型」，v-show 留隐藏节点会被辅助技术读出且
         testid 查询仍命中（真机剧本 agg-tf-1 实证），纯思考段三类全零时摘要只列思考计数 -->
    <template v-for="(count, base) in segment.counts.categoryCounts" :key="base">
      <span
        v-if="count > 0"
        class="shrink-0 text-neutral-dim"
        :data-testid="`agg-summary-cat-${base}`"
      >· {{ t(RUN_GROUP_LABEL_KEY[base]) }} {{ count }}</span>
    </template>
    <span v-if="segment.counts.thinkingCount > 0" class="shrink-0 text-neutral-dim" data-testid="agg-summary-thinking">· {{ t('panel.message.thinkingBlock') }} {{ segment.counts.thinkingCount }}</span>
    <span v-if="durationText && !live" class="shrink-0 font-mono text-[length:var(--text-2xs)] tabular-nums text-neutral-dim" data-testid="agg-summary-duration">· {{ durationText }}</span>
    <!-- 失败标记（含 M 次失败）：AX6 响亮契约——计数即存在信号，无失败不渲染 -->
    <span
      v-if="segment.counts.failedCount > 0"
      class="shrink-0 rounded-[var(--radius-xs)] bg-danger-soft px-1.5 py-px text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] text-danger"
      data-testid="agg-summary-failed"
    >{{ t('panel.message.traceFailed', { count: segment.counts.failedCount }) }}</span>
  </Button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Layers } from '@lucide/vue'
import type { RunGroupBase, ProcessSegment } from '@taiji/core/domain/chat'
import { Button } from '../../../primitives/button'
import { RUNNING_LOADER_SVG } from '../block-icon'
import { formatDurationHms } from '../format-utils'

const props = defineProps<{
  /** 段数据（counts 是摘要行唯一数据源，core 单源口径） */
  segment: ProcessSegment
  /** 展开/收起态（容器本地 ref 透传，aria-expanded 同步） */
  expanded: boolean
  /** 段进行中（isLive 透传）：live 变体（呼吸弧行首 + 隐藏总耗时），缺省完成态形态 */
  live?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
}>()

const { t } = useI18n()

/** 分类名 i18n 键（SegmentToolGroup 同键同值——摘要行与组头共用 runGroup* 词表） */
const RUN_GROUP_LABEL_KEY: Record<RunGroupBase, string> = {
  explore: 'panel.message.runGroupExplore',
  edit: 'panel.message.runGroupEdit',
  exec: 'panel.message.runGroupExec',
}

const durationText = computed(() => {
  const ms = props.segment.counts.totalDurationMs
  return ms > 0 ? formatDurationHms(ms) : ''
})
</script>
