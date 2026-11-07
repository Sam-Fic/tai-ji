<!--
  ModelRoutePage —— 模型路由页容器（provider-aggregation U5b · spec §7.1-§7.2/§7.11/§9）。

  数据流（D10 视图半边）：props.view = runtime join 视图（AggregationRouteView，非权威；
  wire 卡只含 routes 定义的模型），props.scopedModels = 白名单全量（渠道直连条目经它抵达
  ——D10 卡片集合 = scopedModels ∪ routes）；页面草稿经 core buildRoutePageCards 派生
  （直连卡 ∪ 路由卡，scopedModels 序交错 = 选择器顺序），所有编辑就地改草稿 + 标脏；
  「保存」emit 两权威目标态（routes 全量 + scopedRefs = scopedModels 全量目标态：
  直连卡原值 + 路由引用按卡片序——整表覆写经 config.setScopedModels 既有通道，不含
  直连条目即静默丢物理模型白名单的半边载荷不成立）交上层编排（U9
  createRouteSaveOrchestrator）；「放弃」重建草稿回视图态。删除路由不经保存载荷
  （runtime deleteRoute 单 RPC 双写编排）：route-delete 指令原样上抛编排层，卡移除由
  删除成功后的视图刷新承载（事实驱动，无乐观回显）。孤儿复合串不生成卡（视图层
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
      <div class="flex items-center gap-2">
        <Button variant="secondary" size="dense" data-testid="route-open-providers" @click="emit('openProviders')">
          {{ t('settings.modelRoute.openProviders') }}
        </Button>
        <!-- 新建路由（U9 创建侧，GL5/V15）：默认草稿卡走 applyEditorOp 唯一入口 -->
        <Button size="dense" data-testid="route-create-btn" @click="createRoute">
          {{ t('settings.modelRoute.createRoute') }}
        </Button>
      </div>
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

    <!-- 卡列表（直连卡 ∪ 路由卡，scopedModels 序交错） -->
    <div v-if="draft.length > 0" class="mt-3 flex flex-col gap-3">
      <template v-for="(card, idx) in draft" :key="card.kind === 'route' ? card.card.route.id : card.ref">
        <RouteCard
          v-if="card.kind === 'route'"
          :card="card.card"
          :providers="providers"
          :index="idx"
          :total="draft.length"
          :now="resolvedNow"
          :new-session-available="newSessionRouteIds?.has(card.card.route.id) ?? false"
          :focus="focus && focus.routeId === card.card.route.id ? focus : undefined"
          :quota-of="quotaOf"
          @op="applyEditorOp"
          @move="moveCard(idx, $event)"
          @toggle-scoped="toggleScoped(idx)"
          @open-providers="emit('openProviders')"
        />
        <!-- 渠道直连卡（无 routes 定义的物理模型白名单条目，D10/U9「默认单端点形态」）：
             仅排序 + 参与选择开关，端点/条件编辑不适用 -->
        <div
          v-else
          data-testid="route-direct-card"
          :data-ref="card.ref"
          class="rounded-lg border border-border bg-bg-card"
        >
          <div class="flex flex-wrap items-center gap-2 px-4 py-3">
            <span class="text-[length:var(--text-sm)] font-medium text-neutral-fg" data-testid="route-direct-name">
              {{ card.providerName }} / {{ card.modelName }}
            </span>
            <span class="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[length:var(--text-3xs)] text-neutral-mid">
              {{ t('settings.modelRoute.directCardTag') }}
            </span>
            <span
              v-if="card.missing"
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
                :disabled="idx === 0"
                :aria-label="t('settings.modelRoute.moveUp')"
                :title="t('settings.modelRoute.moveUp')"
                data-testid="route-direct-move-up"
                @click="moveCard(idx, 'up')"
              >
                <ChevronUp class="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="size-7 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
                :disabled="idx === draft.length - 1"
                :aria-label="t('settings.modelRoute.moveDown')"
                :title="t('settings.modelRoute.moveDown')"
                data-testid="route-direct-move-down"
                @click="moveCard(idx, 'down')"
              >
                <ChevronDown class="size-3.5" />
              </Button>
              <Switch
                :model-value="card.scoped"
                :aria-label="t('settings.modelRoute.scopedToggle')"
                data-testid="route-direct-scoped-toggle"
                @update:model-value="toggleScoped(idx)"
              />
            </div>
          </div>
        </div>
      </template>
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
      <!-- 全部路由删完 = V8 零配置态：同一空状态承载「新建路由」引导（U9 创建侧） -->
      <Button size="dense" data-testid="route-empty-create" @click="createRoute">
        {{ t('settings.modelRoute.createRoute') }}
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
import { ChevronDown, ChevronUp, Server } from '@lucide/vue'
import { Button, InlineNotice, Switch } from '@taiji/ui'
import {
  buildRoutePageCards,
  type RouteDefinitionCard,
  type RouteDirectCard,
} from '@taiji/core/domain/settings'
import type {
  AggregationMember,
  AggregationRoute,
  AggregationRouteView,
  ProviderInfo,
} from '@taiji/shared'
import { buildAggregationModelRef } from '@taiji/shared'
import RouteCard from './RouteCard.vue'
import RouteUnsavedBar from './RouteUnsavedBar.vue'
import { blankWindowTable, nowFromClock, weekdayBusinessWindow, type RouteNow } from './route-preview'
import { DEFAULT_QUOTA_THRESHOLD_PERCENT, buildNewRouteDraft, newMemberId, type RouteEditorOp } from './route-editor-ops'

/** 保存载荷（两权威目标态；写编排归上层——routes 逐条 saveRoute、scopedModels 全量走
 *  setScopedModels 既有通道，编排端 = core createRouteSaveOrchestrator）。 */
export interface RoutePageSavePayload {
  /** 路由定义全量（卡片序；直连卡无 routes 定义不进本载荷）。 */
  routes: AggregationRoute[]
  /**
   * scopedModels 全量目标态（卡片序中 scoped 卡的复合串：渠道直连卡原值 + 路由引用
   * `<聚合providerId>/<routeId>`——数组即顺序，上层整表覆写写回白名单权威）。
   */
  scopedRefs: string[]
}

/** 供应商页引用 chip 跳转的定位锚（外部 spec §6.4：展开对应模型卡 + 滚动到对应端点 + 闪烁高亮）。
 *  memberId = 端点条目 id（编辑期稳定键，RouteEndpointRow data-member-id 同源——顺位会随
 *  编辑漂移，不作定位锚）。 */
export interface RoutePageFocus {
  routeId: string
  memberId: string
}

const props = defineProps<{
  view: AggregationRouteView
  providers: ProviderInfo[]
  /** scopedModels 白名单全量（渠道直连卡数据源；宿主传 settingsStore.scopedModels）。
   * 缺省 = 空白名单（测试/纯路由视图形态，仅路由卡）。 */
  scopedModels?: readonly string[]
  /** 「此刻」求值坐标注入（测试确定性/展开时点墙钟；缺省 = 挂载时点墙钟一次，零定时器）。 */
  now?: RouteNow
  /** 新会话可用路由 id 集（U7：不在本应用生命周期首次快照内的卡显徽标；宿主 = 编排 composable）。
   * 缺省 = 空集（不显徽标）。 */
  newSessionRouteIds?: ReadonlySet<string>
  /** 引用 chip 跳转定位（外部 spec §6.4：命中卡自动展开 + 滚动到端点行 + 闪烁高亮；
   *  null/缺省 = 无定位）。宿主 = SettingsModal（ProviderPage open-route-page 透传）。 */
  focus?: RoutePageFocus | null
  /** 额度数据供给（M2 接线，透传 RouteCard「此刻」chip）：providerId → 首窗口已用百分比
   *  投影，与 pi 扩展 quota-cache-reader wins[0].pct 同源（剩余换算在判定式内完成——
   *  route-preview.ts evaluateCondition，与扩展 router.ts 同型）；缺省不传 = 额度
   *  数据未知（chip 以 fail-open + 区分呈现承载）。宿主 = SettingsModal（useQuotaStore 投影）。 */
  quotaOf?: (providerId: string) => number | undefined
}>()

const emit = defineEmits<{
  /** 任意草稿编辑（dirty 翻转或草稿内容变化）。 */
  change: [dirty: boolean]
  save: [payload: RoutePageSavePayload]
  discard: []
  openProviders: []
  /** 删除路由意图（U9 删除侧；实际删除走编排层 deleteRoute 端口，成功后视图刷新承载卡移除）。 */
  routeDelete: [routeId: string]
}>()

const { t } = useI18n()

const resolvedNow = computed<RouteNow>(() => props.now ?? nowFromClock(new Date()))

// ── 草稿态（core buildRoutePageCards 派生：直连卡 ∪ 路由卡，scopedModels 序交错）──

/** 草稿直连卡 = 派生卡 + 草稿 scoped 态（派生侧直连卡全部来自 scopedModels 条目，初始恒
 * 参与选择；route 卡 scoped 内嵌 AggregationRouteCard）。 */
type DraftDirectCard = RouteDirectCard & { scoped: boolean }
type DraftCard = DraftDirectCard | RouteDefinitionCard

function cloneDraft(): DraftCard[] {
  return buildRoutePageCards(props.view, props.scopedModels ?? [], props.providers).map((card) => {
    if (card.kind === 'direct') return { ...card, scoped: true }
    return {
      kind: 'route',
      card: { ...card.card, route: JSON.parse(JSON.stringify(card.card.route)) as AggregationRoute },
    }
  })
}

const draft = ref<DraftCard[]>(cloneDraft())

const dirty = ref(false)

// 视图或白名单替换（外层刷新下发）时重置草稿——草稿属单次编辑会话，权威变化以新视图为准
watch(
  () => [props.view, props.scopedModels] as const,
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

/** 保存：两权威目标态上抛（spec §9.2；scopedRefs = scopedModels 全量目标态——直连卡
 *  原值 + 路由引用按卡片序，整表覆写语义防物理模型条目静默丢失）。 */
function save(): void {
  const routes = draft.value
    .filter((c): c is RouteDefinitionCard => c.kind === 'route')
    .map((c) => JSON.parse(JSON.stringify(c.card.route)) as AggregationRoute)
  const scopedRefs = draft.value
    .filter((c) => (c.kind === 'route' ? c.card.scoped : c.scoped))
    .map((c) => (c.kind === 'route' ? buildAggregationModelRef(c.card.route.id) : c.ref))
  emit('save', { routes, scopedRefs })
}

// ── 编辑指令集中执行（唯一更新入口；指令契约见 route-editor-ops.ts） ──

/** 按路由 id 定位草稿卡（直连卡无路由定义，不参与路由编辑指令）。 */
function cardOf(routeId: string): RouteDefinitionCard | undefined {
  return draft.value.find((c): c is RouteDefinitionCard => c.kind === 'route' && c.card.route.id === routeId)
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
      Object.assign(card.card.route, op.patch)
      break
    }
    case 'endpoint-add': {
      const card = cardOf(op.routeId)
      if (!card) return
      const member: AggregationMember = {
        id: newMemberId(),
        providerId: op.providerId,
        modelId: card.card.route.modelId,
        type: 'none',
      }
      if (card.card.route.mode === 'advanced') {
        const firstNone = card.card.route.members.findIndex((m) => m.type === 'none')
        card.card.route.members.splice(firstNone < 0 ? card.card.route.members.length : firstNone, 0, member)
      } else {
        card.card.route.members.push(member)
      }
      break
    }
    case 'endpoint-remove': {
      cardOf(op.routeId)?.card.route.members.splice(op.memberIndex, 1)
      break
    }
    case 'endpoint-move': {
      const members = cardOf(op.routeId)?.card.route.members
      if (!members) return
      const target = op.dir === 'up' ? op.memberIndex - 1 : op.memberIndex + 1
      if (target < 0 || target >= members.length) return
      const [moved] = members.splice(op.memberIndex, 1)
      members.splice(target, 0, moved!)
      break
    }
    case 'endpoint-patch': {
      const member = cardOf(op.routeId)?.card.route.members[op.memberIndex]
      if (!member) return
      Object.assign(member, op.patch)
      break
    }
    case 'endpoint-condition-type': {
      const member = cardOf(op.routeId)?.card.route.members[op.memberIndex]
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
      const member = cardOf(op.routeId)?.card.route.members[op.memberIndex]
      if (!member) return
      member.window ??= blankWindowTable()
      member.window[op.day]![op.slot] = op.value
      break
    }
    case 'endpoint-window-erase-cell': {
      const card = cardOf(op.routeId)
      if (!card) return
      for (const member of card.card.route.members) {
        if (member.type === 'window' || member.type === 'combo') {
          member.window?.[op.day]?.splice(op.slot, 1, false)
        }
      }
      break
    }
    case 'endpoint-window-replace': {
      const member = cardOf(op.routeId)?.card.route.members[op.memberIndex]
      if (!member) return
      member.window = op.table
      break
    }
    case 'special-add': {
      cardOf(op.routeId)?.card.route.specials.push(op.special)
      break
    }
    case 'special-remove': {
      cardOf(op.routeId)?.card.route.specials.splice(op.index, 1)
      break
    }
    case 'route-add': {
      // 新卡参与选择默认开（新建即入选择器，V15 语义）；未入 scopedModels 前 scopedIndex = -1
      draft.value.push({ kind: 'route', card: { route: op.route, scoped: true, scopedIndex: -1, memberIssues: [] } })
      break
    }
    case 'route-delete': {
      // 事实驱动（ADR-0122 ⑨）：草稿不乐观移除——卡消失 = 删除 RPC 成功后的视图刷新；
      // 失败经编排层 toast 显式呈报。不标脏（本指令无草稿变更）。
      emit('routeDelete', op.routeId)
      return
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

/** 「新建路由」（U9 创建侧，页头与空状态两入口共用）：默认草稿交 applyEditorOp 唯一入口。 */
function createRoute(): void {
  applyEditorOp({
    kind: 'route-add',
    route: buildNewRouteDraft({
      defaultName: t('settings.modelRoute.newRouteName'),
      takenRouteIds: draft.value.flatMap((c) => (c.kind === 'route' ? [c.card.route.id] : [])),
      providers: props.providers,
    }),
  })
}

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
  if (card.kind === 'route') card.card.scoped = !card.card.scoped
  else card.scoped = !card.scoped
  markDirty()
}

// ── 概览统计（已配置口径，spec §7.2/对抗审查 M3；直连卡 = 默认单端点形态计 1 端点） ──

const endpointTotal = computed(() =>
  draft.value.reduce((sum, c) => sum + (c.kind === 'route' ? c.card.route.members.length : 1), 0),
)
const advancedCount = computed(() => draft.value.filter((c) => c.kind === 'route' && c.card.route.mode === 'advanced').length)

// ── 呈报文案 ──

const orphanText = computed(() =>
  t('settings.modelRoute.orphanNotice', { refs: props.view.orphanRefs.join('、') }),
)

const corruptedText = computed(() => {
  const base = t('settings.modelRoute.corruptedNotice')
  return props.view.corruptedFilePath ? `${base} ${props.view.corruptedFilePath}` : base
})
</script>
