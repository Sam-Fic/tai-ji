<template>
  <!--
    展示组件 · 默认项目轻量头行（默认区锚定/新建/拖放/开合入口的单一承载）。
    背景：默认项目 = 未归类收件箱（2026-10-13 裁决：不渲染 ProjectGroup 框——无组头/
    无左线/无缩进），锚定一旦切到命名项目后没有任何 UI 路径切回，新会话从此进不了
    默认项目。本行以「轻量标签行」形态补齐入口，不恢复项目框：无框/无左线/缩进仅
    chevron 内移，文字 + 「当前」chip + 会话计数 + hover 浮现「+」，与 SessionDirLabel
    目录标签行同量级。
    交互：点行主体 = 父级按模式裁决（平铺 = 非锚定锚定+展开 / 已锚定翻转开合；
    目录 = 仅翻转开合——锚定不切，与命名组头同构）；点「+」= 先锚定再进空态新建
    （与命名组头「+」onCreateTaskIn 同构）；整行是 session 拖拽落点
    （useSessionDropTarget，drop 即归回默认项目）。开合态由父级持有（默认收起 +
    持久化），本组件只按 expanded prop 渲染 chevron 指示。
  -->
  <div
    class="group/dph flex min-h-[26px] select-none items-center gap-[6px] rounded-sm px-[8px] py-[4px] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]"
    :class="dropActive ? 'bg-surface-hover' : ''"
    data-testid="default-project-head"
    :data-dragover="dropActive ? 'true' : undefined"
    :data-expanded="expanded ? 'true' : 'false'"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div
      role="button"
      tabindex="0"
      class="flex min-w-0 flex-1 cursor-pointer items-center gap-[6px] text-left"
      data-testid="default-project-anchor"
      :aria-expanded="expanded ? 'true' : 'false'"
      :aria-label="name"
      @click="emit('headClick')"
      @keydown.enter.prevent="emit('headClick')"
      @keydown.space.prevent="emit('headClick')"
    >
      <!-- chevron 展开指示（与 ProjectGroup 组头同语系：展开向下 / 收起向右） -->
      <ChevronDown
        class="flex-none text-neutral-dim transition-transform duration-[var(--duration)] ease-[var(--ease-out)] [&_svg]:size-[12px] size-[12px]"
        :class="expanded ? '' : '-rotate-90'"
        :stroke-width="1.8"
        data-testid="default-project-chevron"
      />
      <span class="min-w-0 truncate text-[12.5px] [font-weight:var(--fw-mid)] text-neutral-fg-2 group-hover/dph:text-neutral-fg">
        {{ name }}
      </span>
      <span
        v-if="current"
        class="flex-none rounded-full px-[6px] py-[3px] text-[10px] leading-none text-neutral-fg bg-[var(--sel-bg)] shadow-[inset_0_0_0_1px_var(--sel-edge)]"
        data-testid="default-project-current-chip"
      >
        {{ t('sidebar.projectGroup.currentChip') }}
      </span>
      <!-- 会话计数（命名组头同位：mono 小字，hover 操作钮浮现时让位） -->
      <span
        class="ml-auto flex-none font-mono text-[length:var(--text-2xs)] text-neutral-fg-2 group-hover/dph:hidden"
        data-testid="default-project-count"
      >
        {{ count }}
      </span>
    </div>
    <Button
      variant="ghost"
      size="icon"
      class="relative hidden flex-none grid size-[20px] place-items-center rounded-[5px] p-0 text-neutral-dim after:absolute after:inset-[-2px] after:content-[''] hover:bg-surface-hover hover:text-neutral-fg group-hover/dph:grid group-focus-within/dph:grid [&_svg]:size-[12px]"
      :title="t('sidebar.sessionList.newSessionInDefault')"
      :aria-label="t('sidebar.sessionList.newSessionInDefault')"
      data-testid="default-project-new-task"
      @click.stop="emit('createTask')"
    >
      <Plus :stroke-width="1.8" />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ChevronDown, Plus } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useSessionDropTarget } from '@/composables/features/sidebar/use-session-drop-target'

const { t } = useI18n()

defineProps<{
  /** 是否锚定在默认项目（「当前」chip 渲染条件） */
  current: boolean
  /** 头行文字（父级解析默认项目兜底文案后传入，组件不做 i18n 查找耦合） */
  name: string
  /** 展开态（父级持有并持久化，默认收起；本组件只渲染 chevron 指示） */
  expanded: boolean
  /** 默认区内会话数（计数徽标） */
  count: number
}>()

const emit = defineEmits<{
  /** 点行主体：父级按模式裁决（平铺 = 锚定/翻转开合，目录 = 仅翻转开合） */
  headClick: []
  /** 点「+」：先锚定默认项目再 emit（父级编排，同 onCreateTaskIn 范式） */
  createTask: []
  /** session 拖入本行：归回默认项目（父级转 setProject，projectId=''） */
  dropSession: [sessionId: string]
}>()

const { dropActive, onDragOver, onDragLeave, onDrop } = useSessionDropTarget((sessionId) =>
  emit('dropSession', sessionId),
)
</script>
