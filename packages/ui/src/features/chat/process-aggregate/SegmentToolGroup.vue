<!--
  聚合块 · 段内工具组（chat-flow-process-aggregate U2）：组头纯标题（不可点击——D1 裁决：
  demo 同构，原型组头为 div 而非 button；段展开即全部成员逐行可见，组级再收一层等于把
  PR2 的二次折叠请回来）+ 成员 SegmentToolRow 全铺开（无「更早 N 步」折叠，GL3）。
  组头计数（成员数/耗时/失败）与 hasRunning 由 core ProcessToolGroup 一次算好，本组件零解析。
-->
<template>
  <div class="agg-group flex min-w-0 flex-col" data-testid="agg-tool-group">
    <!-- 组头：纯标题 div（无 role/click/tabindex——组级无折叠入口）；负 8px 边距 + 8px 内边距
         对齐规格（行悬停底色外扩由成员行自担，组头无悬停交互） -->
    <div
      class="flex min-w-0 items-baseline gap-[8px] px-2 py-0.5 -mx-2 [font-weight:var(--fw-mid)] text-neutral-mid"
      data-testid="agg-group-head"
    >
      <RunningBlockIcon v-if="group.hasRunning" :kind="RUN_GROUP_RUNNING_ICON[group.base]" />
      <component
        :is="BLOCK_ICON_LUCIDE[RUN_GROUP_ICON[group.base]]"
        v-else
        :class="[BLOCK_ICON_CLASS, 'self-center']"
      />
      <span class="shrink-0 whitespace-nowrap">{{ t(RUN_GROUP_LABEL_KEY[group.base]) }}</span>
      <span
        v-if="group.hasRunning"
        class="shrink-0 text-neutral-dim"
        data-testid="agg-group-running"
      >{{ t('panel.message.aggGroupRunning') }}</span>
      <span
        class="min-w-0 truncate font-mono text-neutral-dim"
        data-testid="agg-group-stat"
      >{{ statText }}</span>
      <!-- 失败段 chip（软危险底圆角小标签；计数与段级摘要行同口径——core 单源） -->
      <span
        v-if="group.failedCount > 0"
        class="shrink-0 rounded-[var(--radius-xs)] bg-danger-soft px-1.5 py-px text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] text-danger"
        data-testid="agg-group-failed"
      >{{ t('panel.message.traceFailed', { count: group.failedCount }) }}</span>
    </div>
    <!-- 成员全铺开：key = 成员 flatIndex——段尾延长 members 追加成员时既有成员 key 不变，
         不 remount 既有成员行 -->
    <SegmentToolRow
      v-for="m in group.members"
      :key="m.flatIndex"
      :tool="m.block.ref as ToolCall"
      class="pl-6"
      @open-detail="(tool) => emit('open-detail', tool)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RunGroupBase, ProcessToolGroup } from '@taiji/core/domain/chat'
import type { ToolCall } from '@taiji/shared'
import RunningBlockIcon from '../RunningBlockIcon.vue'
import SegmentToolRow from './SegmentToolRow.vue'
import { BLOCK_ICON_CLASS, BLOCK_ICON_LUCIDE, type BlockIconKind, type RunningIconKind } from '../block-icon'
import { formatDuration } from '../format-utils'

const props = defineProps<{
  /** 段内工具组（core ProcessToolGroup：计数与运行信号已算好） */
  group: ProcessToolGroup
}>()

const emit = defineEmits<{
  (e: 'open-detail', tool: ToolCall): void
}>()

const { t } = useI18n()

/** 组类型 → 块图标（组件本地映射：三档复用既有 BlockIconKind，不新开图标；
 *  排掉 'running'——运行态走 loader 分支）。保持本地常量不上收共享：跨组件
 *  共享映射的收敛归 block-icon SSOT 后续批次。 */
const RUN_GROUP_ICON: Record<RunGroupBase, Exclude<BlockIconKind, 'running'>> = {
  explore: 'tool-read',
  edit: 'tool-edit',
  exec: 'tool-bash',
}

/** 组类型 → 组头名 i18n 键（探索 / 改动 / 执行命令；复用既有 locale 键 runGroup* 族） */
const RUN_GROUP_LABEL_KEY: Record<RunGroupBase, string> = {
  explore: 'panel.message.runGroupExplore',
  edit: 'panel.message.runGroupEdit',
  exec: 'panel.message.runGroupExec',
}

/** 组类型 → 运行中动效 kind（探索扫描 / 改动描线 / 命令光标闪烁，经 RunningBlockIcon 渲染） */
const RUN_GROUP_RUNNING_ICON: Record<RunGroupBase, RunningIconKind> = {
  explore: 'tool-read',
  edit: 'tool-edit',
  exec: 'tool-bash',
}

/** 统计段：「N 步 · 耗时」（已完成成员合计，endTime 缺失按 0——core durationMs 口径直读） */
const statText = computed(() => {
  const steps = t('panel.message.runGroupSteps', { count: props.group.members.length })
  const duration = props.group.durationMs > 0 ? formatDuration(props.group.durationMs) : ''
  return duration ? `${steps} · ${duration}` : steps
})
</script>
