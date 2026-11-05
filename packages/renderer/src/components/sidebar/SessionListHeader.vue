<template>
  <!--
    区头（demo .sess-head：gap 6px / padding 8px 10px 5px；lbl 12px mid、count mono 11px fg-2、
    右侧模式开关 = .mode-seg 凹陷槽）。从 SessionList 抽出（区头工具组 = 标题计数 + 新建项目 +
    归档入口 + A/C 模式开关的自包含呈现单元）；固定于 ScrollArea 外（不随列表滚动），
    新建项目草稿行 / 归档确认态等编排状态由父级 SessionList 持有，本组件纯展示。
  -->
  <div class="flex shrink-0 items-center gap-[6px] px-[10px] pt-[8px] pb-[5px]" data-testid="session-list-header">
    <span class="truncate text-[length:var(--text-xs)] text-neutral-mid">
      {{ t('sidebar.sessionList.header') }}
    </span>
    <span class="font-mono text-[length:var(--text-2xs)] text-neutral-fg-2">{{ totalCount }}</span>
    <!-- 右侧工具组（用户裁决 2026-10-11）：新建项目「+」紧贴模式开关（组内 gap 2px，
         组整体 ml-auto 承接右贴）。新建项目入口 = 区头「+」→ 列表顶部草稿行（父级渲染），
         不再使用区头内联输入。
         [session-archive D10] 归档入口插在「+」与模式开关之间：Archive 图标（归档域
         统一用 Archive 归档箱——入口 / 悬停归档钮 / 两处空态同族；「标记完成」用对勾系
         CircleCheck 区分「做完了 vs 收起来」）+ archiveCount 角标（count 0 隐藏，按钮仍可点
         ——空归档列表有引导空态）。 -->
    <div class="ml-auto flex items-center gap-[2px]">
      <Button
        variant="ghost"
        size="icon"
        data-testid="project-add-btn"
        class="grid size-[24px] place-items-center rounded-[var(--radius-xs)] p-0 text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-neutral-dim [&_svg]:size-[13px]"
        :title="editingEnabled ? t('sidebar.projectGroup.newProject') : t('sidebar.sessionList.projectEditDisabledHint')"
        :aria-label="t('sidebar.projectGroup.newProject')" :disabled="!editingEnabled"
        @click="emit('startCreate')"
      >
        <Plus :stroke-width="1.8" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        data-testid="sidebar-archive-entry-btn"
        class="relative grid size-[24px] place-items-center rounded-[var(--radius-xs)] p-0 text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[13px]"
        :title="t('sidebar.archiveEntry.title', { count: archiveCount })"
        :aria-label="t('sidebar.archiveEntry.title', { count: archiveCount })"
        @click="emit('openArchives')"
      >
        <Archive :stroke-width="1.8" />
        <!-- 计数角标（D10：count 0 隐藏；>0 右上角 accent 圆形 mono 小字，99 封顶） -->
        <span
          v-if="archiveCount > 0"
          data-testid="sidebar-archive-count-badge"
          class="absolute -right-[3px] -top-[3px] grid min-w-[14px] place-items-center rounded-full bg-accent px-[3px] font-mono text-[9px] leading-[14px] text-accent-fg"
        >{{ archiveCount > 99 ? '99+' : archiveCount }}</span>
      </Button>
      <!-- A/C 双段图标开关（demo .mode-seg：surface 槽 + hairline 边 + 26×24 钮 + 13px 图标）：
           选中态 = demo Tier A 状态件范式（--sel-bg accent tint 底 + fg 字 + 1px --sel-edge 内描边）。
           title 承载模式名（无 label 文字，demo 悬停提示范式）。 -->
      <div class="flex items-center rounded-sm border border-hairline bg-surface p-[2px]">
        <Button
          variant="ghost"
          size="icon"
          data-testid="session-mode-flat"
          class="h-[24px] w-[26px] rounded-[var(--radius-xs)] p-0"
          :class="mode === 'flat'
            ? 'bg-[var(--sel-bg)] text-neutral-fg [font-weight:var(--fw-mid)] shadow-[inset_0_0_0_1px_var(--sel-edge)] hover:bg-[var(--sel-bg)] hover:text-neutral-fg'
            : 'bg-transparent text-neutral-dim hover:bg-transparent hover:text-neutral-fg'"
          :title="t('sidebar.sessionList.modeFlat')"
          :aria-pressed="mode === 'flat'"
          @click="emit('setMode', 'flat')"
        >
          <List class="size-[13px]" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          data-testid="session-mode-groups"
          class="h-[24px] w-[26px] rounded-[var(--radius-xs)] p-0"
          :class="mode === 'groups'
            ? 'bg-[var(--sel-bg)] text-neutral-fg [font-weight:var(--fw-mid)] shadow-[inset_0_0_0_1px_var(--sel-edge)] hover:bg-[var(--sel-bg)] hover:text-neutral-fg'
            : 'bg-transparent text-neutral-dim hover:bg-transparent hover:text-neutral-fg'"
          :title="t('sidebar.sessionList.modeGroup')"
          :aria-pressed="mode === 'groups'"
          @click="emit('setMode', 'groups')"
        >
          <Folder class="size-[13px]" :stroke-width="1.8" />
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Plus, Folder, List, Archive } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { SidebarSessionMode } from '@/composables/features/sidebar/useProjectGroups'

defineProps<{
  /** 全量会话计数（区头 mono 计数，来自 useProjectGroups.totalCount） */
  totalCount: number
  /** 归档条目数（D10 角标数据源；0 = 角标隐藏，按钮仍可点） */
  archiveCount: number
  /** 当前展示模式（A/C 选中态与 aria-pressed 数据源） */
  mode: SidebarSessionMode
  /** 新建项目入口可用性（§6.9：无有效项目数据形态禁用「+」） */
  editingEnabled: boolean
}>()

const emit = defineEmits<{
  /** 区头「+」→ 父级 startCreate（列表顶部出现草稿输入行） */
  startCreate: []
  /** 打开归档列表视图（D10 工具组归档入口钮，父级透传 openArchives） */
  openArchives: []
  /** 模式切换（父级 setMode：持久化 + 联动复位 folder 确认态） */
  setMode: [mode: SidebarSessionMode]
}>()

const { t } = useI18n()
</script>
