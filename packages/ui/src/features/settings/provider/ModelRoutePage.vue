<!--
  ModelRoutePage —— 模型路由页容器（provider-aggregation U5b · spec §7.1-§7.2/§7.11/§9）。

  数据流（D10 视图半边）：props.view = runtime join 视图（AggregationRouteView，非权威），
  页面持有草稿态（深拷贝），所有编辑就地改草稿 + 标脏；「保存」emit 两权威目标态
  （routes 全量 + scopedRefs 复合串按卡片序）交上层编排（U9 通道：routes 写 +
  setScopedModels 既有通道）；「放弃」重建草稿回视图态。孤儿复合串不生成卡（视图层
  已保证），仅以提示条呈现（U1 读取标记承载，下一次保存清理）。

  未保存条挂载 = 两页共享形态的一侧（RouteUnsavedBar，spec §9.1 接缝）。
-->
<template>
  <div data-testid="model-route-page" class="mx-auto flex w-full max-w-[1000px] flex-col">
    <!-- 页头 -->
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('settings.modelRoute.kicker') }}</p>
        <h2 class="mt-0.5 text-[length:var(--text-lg)] font-medium text-neutral-fg">{{ t('settings.modelRoute.title') }}</h2>
        <p class="mt-1 max-w-[560px] text-[length:var(--text-xs)] text-neutral-mid">{{ t('settings.modelRoute.desc') }}</p>
      </div>
      <Button variant="secondary" size="dense" data-testid="route-open-providers" @click="emit('openProviders')">
        {{ t('settings.modelRoute.openProviders') }}
      </Button>
    </div>

    <!-- 配置隔离呈报（U1 损坏隔离语义的页面承载） -->
    <InlineNotice
      v-if="view.corrupted"
      tone="danger"
      :text="corruptedText"
      class="mt-3"
      data-testid="route-corrupted-notice"
    />

    <!-- 孤儿引用提示条（U1 读取标记；下一次保存清理，读取侧不自动写） -->
    <InlineNotice
      v-if="view.orphanRefs.length > 0"
      tone="warn"
      :text="orphanText"
      class="mt-3"
      data-testid="route-orphan-notice"
    />

    <!-- 概览条（spec §7.2；无卡隐藏） -->
    <div
      v-if="draft.length > 0"
      class="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-surface-2 px-3 py-2"
      data-testid="model-route-overview"
    >
      <span class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('settings.modelRoute.overviewModels', { n: draft.length }) }}</span>
      <span class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('settings.modelRoute.overviewEndpoints', { n: endpointTotal }) }}</span>
      <span class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('settings.modelRoute.overviewAdvanced', { n: advancedCount }) }}</span>
      <span class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('settings.modelRoute.overviewHint') }}</span>
    </div>

    <!-- 卡列表 -->
    <div v-if="draft.length > 0" class="mt-3 flex flex-col gap-3">
      <RouteCard
        v-for="(card, idx) in draft"
        :key="card.route.id"
        :card="card"
        :providers="providers"
        :index="idx"
        :total="draft.length"
        :now="resolvedNow"
        @op="applyEditorOp"
        @move="moveCard(idx, $event)"
        @toggle-scoped="toggleScoped(idx)"
        @open-providers="emit('openProviders')"
      />
    </div>

    <!-- 空状态（spec §7.11） -->
    <div
      v-else
      class="mt-8 flex flex-col items-center gap-3 rounded-lg border border-border bg-bg-card px-6 py-12"
      data-testid="model-route-empty"
    >
      <Server class="size-10 text-neutral-dim" />
      <p class="text-[length:var(--text-sm)] font-medium text-neutral-fg">{{ t('settings.modelRoute.emptyTitle') }}</p>
      <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('settings.modelRoute.emptyDesc') }}</p>
      <Button size="dense" data-testid="route-empty-goto-providers" @click="emit('openProviders')">
        {{ t('settings.modelRoute.goProviders') }}
      </Button>
    </div>

    <!-- 未保存条挂载点（两页共享形态的一侧） -->
    <div data-testid="route-unsaved-bar-slot">
      <RouteUnsavedBar :dirty="dirty" @save="save" @discard="discard" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Server } from '@lucide/vue'
import { Button, InlineNotice } from '@taiji/ui'
import type {
  AggregationMember,
  AggregationRoute,
  AggregationRouteCard,
  AggregationRouteView,
  ProviderInfo,
} from '@taiji/shared'
import { buildAggregationModelRef } from '@taiji/shared'
import RouteCard, { type RouteCardData } from './RouteCard.vue'
import RouteUnsavedBar from './RouteUnsavedBar.vue'
import { blankWindowTable, nowFromClock, weekdayBusinessWindow, type RouteNow } from './route-preview'
import { DEFAULT_QUOTA_THRESHOLD_PERCENT, type RouteEditorOp } from './route-editor-ops'

/** 端点临时 id 短码的数字基数（36 = 10 数字 + 26 字母，紧凑且 URL 安全）。 */
const ID_RADIX = 36
/** 端点临时 id 的抖动量级（短码碰撞域；id 只要求路由内唯一，时间戳已保证主序）。 */
const ID_JITTER_RANGE = 1e4

/** 保存载荷（两权威目标态；写编排归上层——routes 走 saveRoute、排序/开关走 setScopedModels 通道）。 */
export interface RoutePageSavePayload {
  /** 路由定义全量（卡片序）。 */
  routes: AggregationRoute[]
  /** 参与选择的模型复合串（`<聚合providerId>/<routeId>`，卡片序——scopedModels 数组即顺序）。 */
  scopedRefs: string[]
}

const props = defineProps<{
  view: AggregationRouteView
  providers: ProviderInfo[]
  /** 「此刻」求值坐标注入（测试确定性/展开时点墙钟；缺省 = 挂载时点墙钟一次，零定时器）。 */
  now?: RouteNow
}>()

const emit = defineEmits<{
  /** 任意草稿编辑（dirty 翻转或草稿内容变化）。 */
  change: [dirty: boolean]
  save: [payload: RoutePageSavePayload]
  discard: []
  openProviders: []
}>()

const { t } = useI18n()

const resolvedNow = computed<RouteNow>(() => props.now ?? nowFromClock(new Date()))

// ── 草稿态（深拷贝视图；scoped 是页面态与路由定义分离——D10 两权威分层） ──

function cloneDraft(): RouteCardData[] {
  const source = JSON.parse(JSON.stringify(props.view.cards)) as AggregationRouteCard[]
  return source.map((card) => ({ route: card.route, scoped: card.scoped }))
}

const draft = ref<RouteCardData[]>(cloneDraft())

const dirty = ref(false)

// 视图替换（外层刷新下发）时重置草稿——草稿属单次编辑会话，视图权威变化以新视图为准
watch(
  () => props.view,
  () => {
    draft.value = cloneDraft()
    dirty.value = false
    emit('change', false)
  },
)

function markDirty(): void {
  if (!dirty.value) {
    dirty.value = true
  }
  emit('change', true)
}

function resetDirty(): void {
  dirty.value = false
  emit('change', false)
}

/** 放弃：重建草稿回视图态（spec §9.3）。 */
function discard(): void {
  draft.value = cloneDraft()
  resetDirty()
  emit('discard')
}

/** 保存：两权威目标态上抛（spec §9.2；scopedRefs = 卡片序中 scoped 卡的复合串）。 */
function save(): void {
  const payload: RoutePageSavePayload = {
    routes: JSON.parse(JSON.stringify(draft.value.map((c) => c.route))) as AggregationRoute[],
    scopedRefs: draft.value.filter((c) => c.scoped).map((c) => buildAggregationModelRef(c.route.id)),
  }
  emit('save', payload)
}

// ── 编辑指令集中执行（唯一更新入口；指令契约见 route-editor-ops.ts） ──

/** 按路由 id 定位草稿卡。 */
function cardOf(routeId: string): RouteCardData | undefined {
  return draft.value.find((c) => c.route.id === routeId)
}

/**
 * applyEditorOp：草稿变更唯一入口（route-editor-ops.ts 指令词表的执行端）。
 * 词表外 kind 走穷举 never 分支 fail-fast（不静默吞未知指令）。
 */
function applyEditorOp(op: RouteEditorOp): void {
  switch (op.kind) {
    case 'route-patch': {
      const card = cardOf(op.routeId)
      if (!card) return
      Object.assign(card.route, op.patch)
      break
    }
    case 'endpoint-add': {
      const card = cardOf(op.routeId)
      if (!card) return
      const member: AggregationMember = {
        id: `m-${Date.now().toString(ID_RADIX)}-${Math.floor(Math.random() * ID_JITTER_RANGE).toString(ID_RADIX)}`,
        providerId: op.providerId,
        modelId: card.route.modelId,
        type: 'none',
      }
      if (card.route.mode === 'advanced') {
        const firstNone = card.route.members.findIndex((m) => m.type === 'none')
        card.route.members.splice(firstNone < 0 ? card.route.members.length : firstNone, 0, member)
      } else {
        card.route.members.push(member)
      }
      break
    }
    case 'endpoint-remove': {
      cardOf(op.routeId)?.route.members.splice(op.memberIndex, 1)
      break
    }
    case 'endpoint-move': {
      const members = cardOf(op.routeId)?.route.members
      if (!members) return
      const target = op.dir === 'up' ? op.memberIndex - 1 : op.memberIndex + 1
      if (target < 0 || target >= members.length) return
      const [moved] = members.splice(op.memberIndex, 1)
      members.splice(target, 0, moved!)
      break
    }
    case 'endpoint-patch': {
      const member = cardOf(op.routeId)?.route.members[op.memberIndex]
      if (!member) return
      Object.assign(member, op.patch)
      break
    }
    case 'endpoint-condition-type': {
      const member = cardOf(op.routeId)?.route.members[op.memberIndex]
      if (!member) return
      member.type = op.type
      if (op.type === 'none') {
        delete member.window
        delete member.quota
      } else if (op.type === 'window') {
        delete member.quota
        member.window ??= weekdayBusinessWindow()
      } else if (op.type === 'quota') {
        delete member.window
        member.quota ??= { thresholdPercent: DEFAULT_QUOTA_THRESHOLD_PERCENT }
      } else {
        member.window ??= weekdayBusinessWindow()
        member.quota ??= { thresholdPercent: DEFAULT_QUOTA_THRESHOLD_PERCENT }
      }
      break
    }
    case 'endpoint-window-set': {
      const member = cardOf(op.routeId)?.route.members[op.memberIndex]
      if (!member) return
      member.window ??= blankWindowTable()
      member.window[op.day]![op.slot] = op.value
      break
    }
    case 'endpoint-window-erase-cell': {
      const card = cardOf(op.routeId)
      if (!card) return
      for (const member of card.route.members) {
        if (member.type === 'window' || member.type === 'combo') {
          member.window?.[op.day]?.splice(op.slot, 1, false)
        }
      }
      break
    }
    case 'endpoint-window-replace': {
      const member = cardOf(op.routeId)?.route.members[op.memberIndex]
      if (!member) return
      member.window = op.table
      break
    }
    case 'special-add': {
      cardOf(op.routeId)?.route.specials.push(op.special)
      break
    }
    case 'special-remove': {
      cardOf(op.routeId)?.route.specials.splice(op.index, 1)
      break
    }
    default: {
      // 穷举守卫：编译期新 kind 未接线在此红灯（satisfies never 形态）
      const exhaustive: never = op
      throw new Error(`Unknown route editor op: ${JSON.stringify(exhaustive)}`)
    }
  }
  markDirty()
}

// ── 卡级编排 ──

function moveCard(index: number, dir: 'up' | 'down'): void {
  const target = dir === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= draft.value.length) return
  const [moved] = draft.value.splice(index, 1)
  draft.value.splice(target, 0, moved!)
  markDirty()
}

function toggleScoped(index: number): void {
  const card = draft.value[index]
  if (!card) return
  card.scoped = !card.scoped
  markDirty()
}

// ── 概览统计（已配置口径，spec §7.2/对抗审查 M3） ──

const endpointTotal = computed(() => draft.value.reduce((sum, c) => sum + c.route.members.length, 0))
const advancedCount = computed(() => draft.value.filter((c) => c.route.mode === 'advanced').length)

// ── 呈报文案 ──

const orphanText = computed(() =>
  t('settings.modelRoute.orphanNotice', { refs: props.view.orphanRefs.join('、') }),
)

const corruptedText = computed(() => {
  const base = t('settings.modelRoute.corruptedNotice')
  return props.view.corruptedFilePath ? `${base} ${props.view.corruptedFilePath}` : base
})
</script>
