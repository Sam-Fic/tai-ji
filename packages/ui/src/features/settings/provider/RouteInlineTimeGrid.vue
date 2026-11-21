<!--
  RouteInlineTimeGrid —— 端点行内紧凑时间轴（provider-aggregation · spec §5.3 行内网格 /
  §12 迁移项落地；demo response.html 同形）。

  迁移语义（对齐 spec §12「端点行内网格 + 保留涂抹能力」）：
  - 7 行（周一至周日）× 48 列（半小时），绿色 = 该端点可路由的时段（isWindowAt 单端点
    求值，特殊日期优先于周表——与扩展侧同源语义）。
  - 涂抹：按下首格取反决定涂/擦 → 拖动保持一致；橡皮 = 本端点格清除；快捷涂抹直接
    作用于本端点（endpoint-window-replace），无图例选端点步骤（行内网格端点天然唯一）。
  - 每格经 op 指令响应式即时更新（同旧 RouteTimeGrid 草稿语义）；窗表就地修改。
  - 红线（ADR-0190）：「当前格」坐标由 now prop 注入，零定时器；拖动收笔靠 pointerup
    全局兜底（事件驱动）。
  - 兜底条/截断警告不在本组件：兜底条归卡底（RouteCard），截断/不命中归端点行 chip。
-->
<template>
  <div data-testid="route-inline-time-grid" class="rounded-md border border-border bg-surface-2/50 p-2.5">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-[length:var(--text-2xs)] font-medium text-neutral-mid">{{ t('settings.modelRoute.timelineTitle') }}</span>
      <span class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('settings.modelRoute.timelineHint') }}</span>
      <div class="ml-auto flex items-center gap-1">
        <Button variant="secondary" size="dense" :aria-pressed="eraser" data-testid="route-time-eraser" @click="eraser = !eraser">
          {{ t('settings.modelRoute.eraser') }}
        </Button>
        <Button variant="ghost" size="dense" data-testid="route-time-preset-work" @click="applyPreset('work')">
          {{ t('settings.modelRoute.paintWorkday') }}
        </Button>
        <Button variant="ghost" size="dense" data-testid="route-time-preset-night" @click="applyPreset('night')">
          {{ t('settings.modelRoute.paintNight') }}
        </Button>
        <Button variant="ghost" size="dense" data-testid="route-time-preset-clear" @click="applyPreset('clear')">
          {{ t('settings.modelRoute.paintClear') }}
        </Button>
      </div>
    </div>

    <!-- 7×48 网格（拖选涂抹） -->
    <div class="mt-2 select-none" @pointerup="endPaint" @pointercancel="endPaint">
      <div
        v-for="(day, dayIndex) in DAY_COUNT"
        :key="day"
        class="mb-0.5 grid items-center gap-px"
        :style="{ gridTemplateColumns: `36px repeat(${SLOT_COUNT}, minmax(0, 1fr))` }"
      >
        <span class="pr-1 text-right text-[length:var(--text-3xs)] text-neutral-dim">
          {{ t(`settings.modelRoute.day${dayIndex}`) }}
        </span>
        <div
          v-for="slot in SLOT_COUNT"
          :key="slot"
          role="gridcell"
          data-testid="route-time-cell"
          :data-day="dayIndex"
          :data-slot="slot - 1"
          :data-now="isNowCell(dayIndex, slot - 1) || undefined"
          :aria-label="cellAriaLabel(dayIndex, slot - 1)"
          :title="cellAriaLabel(dayIndex, slot - 1)"
          class="h-2.5 min-w-0 cursor-pointer rounded-[2px] border border-transparent"
          :class="covered(dayIndex, slot - 1) ? '' : 'bg-surface-2'"
          :style="covered(dayIndex, slot - 1) ? { background: 'var(--success)' } : undefined"
          @pointerdown.prevent="startPaint(dayIndex, slot - 1)"
          @pointerenter="paintCell(dayIndex, slot - 1)"
        />
      </div>
    </div>

    <!-- 标尺（每 3 小时一刻度） -->
    <div class="mt-1 grid gap-px" :style="{ gridTemplateColumns: `36px repeat(${SLOT_COUNT}, minmax(0, 1fr))` }">
      <span />
      <span
        v-for="slot in SLOT_COUNT"
        :key="slot"
        class="min-w-0 text-[length:var(--text-3xs)] leading-none text-neutral-dim"
        :class="(slot - 1) % SLOTS_PER_TICK === 0 ? '' : 'invisible'"
      >
        {{ fmtSlot(slot - 1) }}
      </span>
    </div>
    <p class="mt-1 text-[length:var(--text-2xs)] text-neutral-dim">{{ t('settings.modelRoute.inlineGridNote') }}</p>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@taiji/ui'
import type { AggregationMember, AggregationRoute, ProviderInfo } from '@taiji/shared'
import type { RouteNow } from './route-preview'
import {
  blankWindowTable,
  DAY_COUNT,
  fmtSlot,
  fmtSlotRange,
  isWindowAt,
  nightWindow,
  SLOT_COUNT,
  weekdayBusinessWindow,
} from './route-preview'
import type { RouteEditorOp } from './route-editor-ops'

/** 标尺刻度间隔（每 3 小时 = 6 格）。 */
const SLOTS_PER_TICK = 6

/** ISO 日期位宽（YYYY-MM-DD 各段 pad 位宽）。 */
const ISO_PART_PAD = 2

const props = defineProps<{
  route: AggregationRoute
  /** 本网格归属端点（行内网格 = 单端点可路由时段预览 + 涂抹目标）。 */
  member: AggregationMember
  /** 端点序（op 指令定位）。 */
  index: number
  providers: ProviderInfo[]
  now: RouteNow
}>()

const emit = defineEmits<{ op: [op: RouteEditorOp] }>()

const { t } = useI18n()

// ── 格着色与 aria（单端点可路由语义；特殊日期优先于周表，同扩展侧 isWindowAt）──

function covered(day: number, slot: number): boolean {
  return isWindowAt(props.member, { dow: day, slot }, props.route, todayLocalIso())
}

function isNowCell(day: number, slot: number): boolean {
  return props.now.dow === day && props.now.slot === slot
}

function providerNameOf(): string {
  return props.providers.find((p) => p.id === props.member.providerId)?.name ?? props.member.providerId
}

function cellAriaLabel(day: number, slot: number): string {
  const range = fmtSlotRange(slot)
  const dayLabel = t(`settings.modelRoute.day${day}`)
  return covered(day, slot)
    ? `${dayLabel} ${range}，${providerNameOf()}`
    : `${dayLabel} ${range}，${t('settings.modelRoute.cellNoCover')}`
}

/** 本地日期 YYYY-MM-DD（isWindowAt 特殊日期匹配键；调用时点墙钟，零定时器）。 */
function todayLocalIso(): string {
  // 与 route-preview todayLocalIso 同式（HH:mm 位宽 2；重复实现为避免该文件再扩导出面）
  const pad = (v: number): string => String(v).padStart(ISO_PART_PAD, '0')
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ── 涂抹（本端点；首格取反定方向，拖动保持一致）──

const eraser = ref(false)
const painting = ref(false)
const paintValue = ref(false)

function applyCell(day: number, slot: number): void {
  if (eraser.value) {
    emit('op', { kind: 'endpoint-window-set', routeId: props.route.id, memberIndex: props.index, day, slot, value: false })
    return
  }
  emit('op', { kind: 'endpoint-window-set', routeId: props.route.id, memberIndex: props.index, day, slot, value: paintValue.value })
}

function startPaint(day: number, slot: number): void {
  paintValue.value = eraser.value ? false : !(props.member.window?.[day]?.[slot] ?? false)
  painting.value = true
  applyCell(day, slot)
}

function paintCell(day: number, slot: number): void {
  if (!painting.value) return
  applyCell(day, slot)
}

function endPaint(): void {
  if (!painting.value) return
  painting.value = false
}

// 拖动可能移出容器后松手——全局收笔兜底（事件驱动，非轮询）
function onWindowPointerUp(): void {
  endPaint()
}

onMounted(() => {
  window.addEventListener('pointerup', onWindowPointerUp)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerup', onWindowPointerUp)
  painting.value = false
})

// ── 快捷涂抹（作用于本端点；橡皮模式下拒绝，同旧语义）──

function applyPreset(kind: 'work' | 'night' | 'clear'): void {
  if (eraser.value) return
  const table = kind === 'work' ? weekdayBusinessWindow() : kind === 'night' ? nightWindow() : blankWindowTable()
  emit('op', { kind: 'endpoint-window-replace', routeId: props.route.id, memberIndex: props.index, table })
}
</script>
