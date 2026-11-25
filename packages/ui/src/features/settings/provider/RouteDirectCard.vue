<!--
  RouteDirectCard —— 渠道直连卡（provider-aggregation D10/U9：无 routes 定义的白名单物理
  模型条目，默认单端点形态；从 ModelRoutePage 拆出的卡片单元，与 RouteCard 同构）。

  卡头要素：拖拽把手 / 名称（providerName / modelName）/ 「直连」标记 / 「新增」徽标
  （本编辑会话新建未落盘）/ missing 或缺密钥异常 chip / 上移·下移 / 移除（NEW）/
  参与选择开关。端点与条件编辑不适用于直连卡（无 routes 定义，单端点无条件）。

  移除语义（新增能力）：未落盘新卡 = 草稿内丢弃，即时移除无确认；已落盘卡 = 确认对话框
  （白名单清理 + 默认模型回退提示，与删路由同构），确认后上抛 remove——草稿摘除由页面
  applyEditorOp 执行，白名单权威的实际清理由保存（scopedRefs 整表覆写）承载。

  草稿语义：scoped 开关上抛父级改（scoped 属页面草稿态不属条目本身）；change 通知标脏
  归父级。拖拽排序事件原样上抛（页面 useCardDnd 统一判定插入位）。
-->
<template>
  <div
    data-testid="route-direct-card"
    :data-ref="card.ref"
    class="rounded-lg border border-border bg-bg-card"
    @dragover="emit('cardDragOver', $event)"
    @drop.prevent="emit('cardDrop', $event)"
    @dragend="emit('cardDragEnd')"
  >
    <div class="flex flex-wrap items-center gap-2 px-4 py-3">
      <Button
        variant="ghost"
        size="icon"
        class="size-7 shrink-0 cursor-grab rounded-sm p-0 text-neutral-dim hover:text-neutral-fg active:cursor-grabbing"
        :aria-label="t('settings.modelRoute.dragCard')"
        :title="t('settings.modelRoute.dragCard')"
        data-testid="route-direct-drag-handle"
        draggable="true"
        @dragstart="emit('cardDragStart', $event)"
      >
        <GripVertical class="size-3.5" />
      </Button>
      <span class="text-[length:var(--text-sm)] font-medium text-neutral-fg" data-testid="route-direct-name">
        {{ card.providerName }} / {{ card.modelName }}
      </span>
      <span class="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[length:var(--text-3xs)] text-neutral-mid">
        {{ t('settings.modelRoute.directCardTag') }}
      </span>
      <!-- 本编辑会话新建（未落白名单）：保存后徽标随视图刷新消失 -->
      <span
        v-if="card.isNew"
        class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] text-accent"
        data-testid="route-direct-new"
      >
        {{ t('settings.modelRoute.directNewBadge') }}
      </span>
      <span
        v-else-if="card.missing"
        class="rounded-sm bg-warn-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] text-warn"
        data-testid="route-direct-missing"
      >
        {{ t('settings.modelRoute.directMissing') }}
      </span>
      <span
        v-else-if="!card.apiKeySet"
        class="rounded-sm bg-warn-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] text-warn"
      >
        {{ t('settings.modelRoute.issue.no-key') }}
      </span>
      <div class="ml-auto flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          class="size-7 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
          :disabled="index === 0"
          :aria-label="t('settings.modelRoute.moveUp')"
          :title="t('settings.modelRoute.moveUp')"
          data-testid="route-direct-move-up"
          @click="emit('move', 'up')"
        >
          <ChevronUp class="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="size-7 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
          :disabled="index === total - 1"
          :aria-label="t('settings.modelRoute.moveDown')"
          :title="t('settings.modelRoute.moveDown')"
          data-testid="route-direct-move-down"
          @click="emit('move', 'down')"
        >
          <ChevronDown class="size-3.5" />
        </Button>
        <!-- 移除直连模型（新增能力）：未落盘新卡即时丢弃；已落盘卡确认后上抛 -->
        <Button
          variant="ghost"
          size="icon"
          class="size-7 rounded-sm p-0 text-neutral-dim hover:text-danger"
          :aria-label="t('settings.modelRoute.directRemove')"
          :title="t('settings.modelRoute.directRemove')"
          data-testid="route-direct-remove"
          @click="onRemoveClick"
        >
          <Trash2 class="size-3.5" />
        </Button>
        <Switch
          :model-value="card.scoped"
          :aria-label="t('settings.modelRoute.scopedToggle')"
          data-testid="route-direct-scoped-toggle"
          @update:model-value="emit('toggleScoped')"
        />
      </div>
    </div>

    <!-- 移除确认（同步清理 scopedModels 引用与默认模型回退提示；RouteCard 删除路由同款原语） -->
    <ConfirmDialog
      :open="removeConfirmOpen"
      :title="t('settings.modelRoute.directRemoveConfirmTitle')"
      :description="removeConfirmDesc"
      :confirm-text="t('settings.modelRoute.directRemoveConfirmConfirm')"
      :cancel-text="t('settings.modelRoute.deleteConfirmCancel')"
      variant="danger"
      @update:open="removeConfirmOpen = $event"
      @confirm="confirmRemove"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, GripVertical, Trash2 } from '@lucide/vue'
import { Button, ConfirmDialog, Switch } from '@taiji/ui'
import type { RouteDirectCard } from '@taiji/core/domain/settings'

/**
 * 直连卡草稿数据（页面草稿态形状）：core RouteDirectCard 领域类型 + 草稿 scoped/isNew 态。
 * 与 wire 载荷有意不同——直连条目不经 wire 下发（D10：白名单半边走 settingsStore 通道），
 * 卡片由 core buildDirectCard / buildRoutePageCards 派生，scoped/isNew 属页面编辑态。
 * 渲染字段经 extends 与 core 领域类型对拍（C-state-07 单源）：core 字段演进时 UI 侧
 * 形状漂移有编译期信号，不靠逐字复刻的人肉同步（2026-11-25 dev-merge review dmg-r1-4）。
 */
export interface RouteDirectCardData extends RouteDirectCard {
  /** 参与选择（草稿态；保存进 scopedRefs 目标态）。 */
  scoped: boolean
  /** 本编辑会话新建（未落白名单）→ 显「新增」徽标 + 移除免确认。 */
  isNew: boolean
}

const props = defineProps<{
  card: RouteDirectCardData
  index: number
  total: number
}>()

const emit = defineEmits<{
  move: [dir: 'up' | 'down']
  toggleScoped: []
  /** 移除意图（草稿摘除由页面 applyEditorOp 执行；已落盘条目的白名单清理由保存承载）。 */
  remove: []
  cardDragStart: [e: DragEvent]
  cardDragOver: [e: DragEvent]
  cardDrop: [e: DragEvent]
  cardDragEnd: []
}>()

const { t } = useI18n()

/** 移除确认弹层开关（仅已落盘条目路径）。 */
const removeConfirmOpen = ref(false)

const removeConfirmDesc = computed(() =>
  t('settings.modelRoute.directRemoveConfirmDesc', { name: `${props.card.providerName} / ${props.card.modelName}` }),
)

/** 移除点击：未落盘新卡 = 草稿内丢弃（即时，无确认必要）；已落盘卡 = 确认对话框。 */
function onRemoveClick(): void {
  if (props.card.isNew) {
    emit('remove')
    return
  }
  removeConfirmOpen.value = true
}

function confirmRemove(): void {
  removeConfirmOpen.value = false
  emit('remove')
}
</script>
