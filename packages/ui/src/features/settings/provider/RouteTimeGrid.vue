<!--
  RouteTimeGrid —— 时间窗时间轴（provider-aggregation U5b · D14 / spec §7.7）。

  形态 = 穷举对照表载体：7 行 × 48 格（半小时吸附），每格 aria-label 穷举归属
  （时间窗端点覆盖 / 无条件兜底 / 无覆盖），着色是「时间窗覆盖预览」而非完整求值——
  第一个无条件端点截断其后时间窗着色（coverOwnersAt），权威求值展示归卡头「此刻」chip。

  涂抹交互（spec §7.7）：图例选端点 → 按下第一格取反决定涂/擦 → 拖动保持一致 →
  橡皮清除整格 → 快捷涂抹作用于选中端点 → 松开收笔（每格经 op 指令响应式即时更新，
  无独立松开信号——demo 的「松开整体重渲染」渲染形态不适用于响应式草稿语义）。
  窗表就地修改 route.members[].window（编辑器草稿语义），change 通知标脏。

  红线对齐（ADR-0190）：「此刻」格高亮坐标由 now prop 注入（页面挂载时点墙钟一次，
  props.now 注入优先；卡展开不重采样），零定时器。
-->
<template>
  <div data-testid="route-time-grid" class="mt-4 overflow-hidden rounded-md border border-border bg-bg-card p-3">
    <div class="flex items-baseline gap-2">
      <span class="text-[length:var(--text-xs)] font-medium text-neutral-fg">{{ t('settings.modelRoute.timelineTitle') }}</span>
      <span class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('settings.modelRoute.timelineHint') }}</span>
    </div>

    <!-- 截断警告（C2 修订语义：首个无条件端点截断其后时间窗） -->
    <InlineNotice
      v-if="truncation?.suppressedAfter"
      tone="warn"
      :text="t('settings.modelRoute.timelineWarning', { n: truncation!.unconditionalIndex + 1 })"
      class="mt-2"
      data-testid="route-time-warning"
    />

    <!-- 图例：窗端点色 chip（选中态）+ 橡皮 -->
    <div class="mt-2 flex flex-wrap items-center gap-1.5" data-testid="route-time-legend">
      <Button
        v-for="member in windowMembers"
        :key="member.id"
        variant="secondary"
        size="dense"
        class="gap-1.5"
        :aria-pressed="!eraser && selectedMemberId === member.id"
        :data-testid="`route-time-legend-${member.id}`"
        @click="selectMember(member.id)"
      >
        <span class="size-2 rounded-full" :class="colorClassOf(member)" />
        {{ providerNameOf(member) }}
      </Button>
      <Button
        variant="secondary"
        size="dense"
        :aria-pressed="eraser"
        data-testid="route-time-eraser"
        @click="selectEraser"
      >
        {{ t('settings.modelRoute.eraser') }}
      </Button>
    </div>

    <!-- 快捷涂抹 -->
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <span class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('settings.modelRoute.paintQuick') }}</span>
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

    <!-- 7×48 网格（拖选涂抹；pointerup/pointercancel 仅收笔——painting 复位，外加 window 级兜底；格更新为每 op 即时生效，无收笔批量刷新） -->
    <div
      class="mt-2 select-none"
      @pointerup="endPaint"
      @pointercancel="endPaint"
    >
      <div
        v-for="(day, dayIndex) in DAY_COUNT"
        :key="day"
        class="mb-0.5 grid items-center gap-px"
        :style="{ gridTemplateColumns: `44px repeat(${SLOT_COUNT}, minmax(0, 1fr))` }"
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
          class="h-3.5 min-w-0 cursor-pointer rounded-[2px] border border-transparent"
          :class="cellClass(dayIndex, slot - 1)"
          :style="{ background: cellBackground(dayIndex, slot - 1) }"
          @pointerdown.prevent="startPaint(dayIndex, slot - 1)"
          @pointerenter="paintCell(dayIndex, slot - 1)"
        />
      </div>
    </div>

    <!-- 标尺（每 3 小时一刻度） -->
    <div class="mt-1 grid gap-px" :style="{ gridTemplateColumns: `44px repeat(${SLOT_COUNT}, minmax(0, 1fr))` }">
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

    <!-- 兜底条 -->
    <div
      data-testid="route-time-fallback-bar"
      class="mt-2 flex flex-wrap items-center gap-2 rounded-sm bg-surface-2 px-2 py-1.5"
    >
      <template v-if="fallback">
        <span class="size-2 rounded-full" :class="colorClassOf(fallback)" />
        <span class="text-[length:var(--text-xs)] font-medium text-neutral-fg">
          {{ t('settings.modelRoute.fallbackBar', { name: providerNameOf(fallback) }) }}
        </span>
        <span
          v-for="kind in fallbackIssueKinds"
          :key="kind"
          class="rounded-sm px-1.5 py-0.5 text-[length:var(--text-3xs)]"
          :class="issueChipClass(kind)"
        >
          {{ t(endpointIssueKey(kind)) }}
        </span>
        <span class="ml-auto text-[length:var(--text-2xs)] text-neutral-dim">{{ t('settings.modelRoute.fbTruncateNote') }}</span>
      </template>
      <template v-else>
        <span class="text-[length:var(--text-xs)] font-medium text-warn" data-testid="noFallback">{{ t('settings.modelRoute.noFallback') }}</span>
        <span class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('settings.modelRoute.noFallbackHint') }}</span>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, InlineNotice } from '@taiji/ui'
import type { AggregationMember, AggregationRoute, ProviderInfo } from '@taiji/shared'
import type { RouteNow } from './route-preview'
import {
  blankWindowTable,
  coverOwnersAt,
  DAY_COUNT,
  endpointIssueKinds,
  endpointIssueKey,
  fallbackMemberOf,
  fmtSlot,
  fmtSlotRange,
  nightWindow,
  SLOT_COUNT,
  truncationInfo,
  weekdayBusinessWindow,
} from './route-preview'
import { dotColorClass, issueChipClass } from './route-styles'
import type { MemberOpInput, RouteEditorOp } from './route-editor-ops'
import { useSettingsToast } from '../injection-keys'

const props = defineProps<{
  route: AggregationRoute
  providers: ProviderInfo[]
  now: RouteNow
}>()

const emit = defineEmits<{ op: [op: RouteEditorOp] }>()

/** 编辑指令构造便捷闭包（routeId/memberIndex 在本组件按端点定位）。 */
function memberOp(memberIndex: number, partial: MemberOpInput): RouteEditorOp {
  return { ...partial, routeId: props.route.id, memberIndex } as RouteEditorOp
}

const { t } = useI18n()
const toast = useSettingsToast()

// DAY_COUNT / SLOT_COUNT 经上方 import 自 route-preview（值源 = @taiji/shared TIME_WINDOW 常量，坐标契约单源）

/** 标尺刻度间隔（每 3 小时 = 6 格）。 */
const SLOTS_PER_TICK = 6

/**
 * 端点色板（按端点序循环取色）：CSS 变量语义色（禁硬编码色值）。
 * 格底透明度派生用 color-mix（Tailwind v3 对 var() 色不支持 /opacity 修饰符）；
 * 色点/图例 chip 用同变量的完整字面静态类（JIT 扫描可达）。
 */
const CELL_COLOR_VARS = ['var(--accent)', 'var(--info)', 'var(--warn)', 'var(--danger)', 'var(--success)', 'var(--neutral-fg)'] as const
// ── 涂抹交互状态 ──
const selectedMemberId = ref<string | null>(null)
const eraser = ref(false)
const painting = ref(false)
/** 本次拖动的方向（第一格取反决定，拖动中恒定）。 */
const paintValue = ref(false)

const windowMembers = computed(() =>
  props.route.members.filter((m) => m.type === 'window' || m.type === 'combo'),
)

const truncation = computed(() => truncationInfo(props.route))
const fallback = computed(() => fallbackMemberOf(props.route))

const issueMap = computed(() => endpointIssueKinds(props.route, props.providers))

const fallbackIssueKinds = computed(() => {
  if (!fallback.value) return []
  const idx = props.route.members.findIndex((m) => m.id === fallback.value!.id)
  return issueMap.value.get(idx) ?? []
})

function colorIndexOf(member: AggregationMember): number {
  return props.route.members.findIndex((m) => m.id === member.id)
}

function colorClassOf(member: AggregationMember): string {
  return dotColorClass(colorIndexOf(member))
}

function colorVarOf(member: AggregationMember): string {
  return CELL_COLOR_VARS[colorIndexOf(member) % CELL_COLOR_VARS.length]!
}

function providerNameOf(member: AggregationMember): string {
  return props.providers.find((p) => p.id === member.providerId)?.name ?? member.providerId
}

function memberIssueSuffix(memberIndex: number): string {
  const kinds = issueMap.value.get(memberIndex) ?? []
  if (kinds.includes('provider-deleted')) return t('settings.modelRoute.deletedProviderLabel')
  if (kinds.includes('provider-disabled')) return t('settings.modelRoute.disabledProviderLabel')
  return ''
}

// ── 格着色与 aria（穷举对照表内容） ──

function cellOwners(day: number, slot: number): AggregationMember[] {
  return coverOwnersAt(props.route, day, slot)
}

function cellClass(day: number, slot: number): string {
  const owners = cellOwners(day, slot)
  if (owners.length > 0) return ''
  return fallback.value ? '' : 'bg-surface-2'
}

/** 格底色：owner 覆盖 70% / 兜底格 18% / 空 = 透明（类已给 surface-2 底）。 */
function cellBackground(day: number, slot: number): string {
  const owners = cellOwners(day, slot)
  if (owners.length > 0) return `color-mix(in srgb, ${colorVarOf(owners[0]!)} 70%, transparent)`
  const fb = fallback.value
  if (fb) return `color-mix(in srgb, ${colorVarOf(fb)} 18%, transparent)`
  return 'transparent'
}

function isNowCell(day: number, slot: number): boolean {
  return props.now.dow === day && props.now.slot === slot
}

function cellAriaLabel(day: number, slot: number): string {
  const range = fmtSlotRange(slot)
  const dayLabel = t(`settings.modelRoute.day${day}`)
  const owners = cellOwners(day, slot)
  if (owners.length > 0) {
    const owner = owners[0]!
    const idx = colorIndexOf(owner)
    return `${dayLabel} ${range}，${providerNameOf(owner)}${memberIssueSuffix(idx)}`
  }
  const fb = fallback.value
  if (fb) {
    const idx = colorIndexOf(fb)
    return `${dayLabel} ${range}，${t('settings.modelRoute.cellFb', { name: providerNameOf(fb) })}${memberIssueSuffix(idx)}`
  }
  return `${dayLabel} ${range}，${t('settings.modelRoute.cellNoCover')}`
}

// ── 涂抹 ──

function selectMember(id: string): void {
  selectedMemberId.value = id
  eraser.value = false
}

function selectEraser(): void {
  eraser.value = true
}

/** 选中参与涂抹的窗端点（图例未选时回落第一个窗端点；仅额度路由无可涂端点）。调用点均已先拦截橡皮模式。 */
function paintTarget(): AggregationMember | null {
  const active = windowMembers.value.find((m) => m.id === selectedMemberId.value)
  return active ?? windowMembers.value[0] ?? null
}

function applyCell(day: number, slot: number): void {
  if (eraser.value) {
    emit('op', { kind: 'endpoint-window-erase-cell', routeId: props.route.id, day, slot })
    return
  }
  const target = paintTarget()
  if (!target) return
  const memberIndex = props.route.members.findIndex((m) => m.id === target.id)
  emit('op', memberOp(memberIndex, { kind: 'endpoint-window-set', day, slot, value: paintValue.value }))
}

function startPaint(day: number, slot: number): void {
  if (eraser.value) {
    // 橡皮不解析端点目标（清除整格，作用于全部窗端点）：直接进涂抹态，由 applyCell 橡皮分流逐格清除
    painting.value = true
    applyCell(day, slot)
    return
  }
  const target = paintTarget()
  if (!target) {
    // 拖拽涂抹被阻挡的场景是「路由无时间窗端点」（如仅额度端点），与快捷涂抹的「先选端点」文案分键
    toast.warning(t('settings.modelRoute.paintNoWindowEndpoint'))
    return
  }
  paintValue.value = !(target.window?.[day]?.[slot] ?? false)
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

// ── 快捷涂抹（作用于当前选中端点；橡皮模式下拒绝，spec §7.7） ──

function applyPreset(kind: 'work' | 'night' | 'clear'): void {
  if (eraser.value) {
    toast.warning(t('settings.modelRoute.paintEraserNoPreset'))
    return
  }
  const target = paintTarget()
  if (!target) {
    toast.warning(t('settings.modelRoute.paintSelectFirst'))
    return
  }
  const table = kind === 'work' ? weekdayBusinessWindow() : kind === 'night' ? nightWindow() : blankWindowTable()
  const memberIndex = props.route.members.findIndex((m) => m.id === target.id)
  emit('op', memberOp(memberIndex, { kind: 'endpoint-window-replace', table }))
}
</script>
