<!--
  RouteCard —— 模型路由卡（provider-aggregation U5b · spec §7.3-§7.11）。

  收起态：模型名 / 新会话可用徽标（U7）/ 端点数 chip / 停用 chip / 「此刻」chip（权威求值展示，D14）/
  模式文本 / 档位并集 / 排序·模式切换·启停·参与选择开关·删除（确认后 route-delete 上抛）·展开 / 端点 pill 摘要。
  展开体：渠道条 / 端点行列表 / 添加端点（高级模式插入第一个无条件端点之前，spec §7.9）/
  时间轴（穷举对照表，D14）/ 特殊日期（D13）。

  草稿语义：card.route 就地修改（字段/端点/条件/窗表），scoped 开关上抛父级改
  （scoped 属页面草稿态不属路由对象）；change 通知标脏。「此刻」坐标由 now 注入
  （展开时点墙钟，ADR-0190 零定时器）。
-->
<template>
  <div
    data-testid="route-card"
    :data-route-id="card.route.id"
    class="rounded-lg border border-border bg-bg-card"
  >
    <!-- 卡头 -->
    <div class="flex flex-wrap items-center gap-2 px-4 py-3">
      <Button
        variant="ghost"
        size="icon"
        class="size-7 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
        :aria-expanded="expanded"
        :aria-label="expanded ? t('settings.modelRoute.collapse') : t('settings.modelRoute.expand')"
        data-testid="route-card-toggle"
        @click="expanded = !expanded"
      >
        <ChevronDown class="size-4 transition-transform" :class="expanded ? 'rotate-180' : ''" />
      </Button>
      <span class="text-[length:var(--text-sm)] font-medium text-neutral-fg" data-testid="route-card-name">
        {{ card.route.name }}
      </span>
      <!-- 新会话可用徽标（U7/D1③）：本应用运行期内新建、当前 pi 会话未注册，重开会话方可绑定 -->
      <span
        v-if="newSessionAvailable"
        class="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[length:var(--text-3xs)] text-neutral-mid"
        data-testid="route-card-new-session-badge"
      >
        {{ t('settings.modelRoute.newSessionAvailable') }}
      </span>
      <span class="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[length:var(--text-3xs)] text-neutral-mid">
        {{ t('settings.modelRoute.endpointsCount', { n: card.route.members.length }) }}
      </span>
      <span
        v-if="!card.route.enabled"
        class="rounded-sm bg-warn-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] text-warn"
      >
        {{ t('settings.modelRoute.enabledBadge') }}
      </span>

      <!-- 「此刻」chip：求值语义可视权威（D14） -->
      <span
        data-testid="route-card-now-chip"
        class="rounded-sm px-1.5 py-0.5 font-mono text-[length:var(--text-3xs)]"
        :class="nowChipClass"
        :title="nowChipText"
      >
        {{ nowChipText }}
      </span>

      <span class="text-[length:var(--text-2xs)] text-neutral-mid" data-testid="route-card-mode-text">
        {{ modeText }}
      </span>
      <span class="text-[length:var(--text-2xs)] text-neutral-dim">
        {{ t('settings.modelRoute.levelsUnion') }}
        <span class="font-mono">{{ levelsUnionText || '—' }}</span>
      </span>

      <!-- 工具区 -->
      <div class="ml-auto flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          class="size-7 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
          :disabled="index === 0"
          :aria-label="t('settings.modelRoute.moveUp')"
          :title="t('settings.modelRoute.moveUp')"
          data-testid="route-move-up"
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
          data-testid="route-move-down"
          @click="emit('move', 'down')"
        >
          <ChevronDown class="size-3.5" />
        </Button>
        <!-- 模式切换（D12：可随时切换，条件数据保留） -->
        <div class="flex items-center gap-1" role="group" :aria-label="t('settings.modelRoute.modeToggleLabel')">
          <Button
            variant="secondary"
            size="dense"
            :aria-pressed="card.route.mode === 'simple'"
            data-testid="route-card-mode-simple"
            @click="setMode('simple')"
          >
            {{ t('settings.modelRoute.modeSimple') }}
          </Button>
          <Button
            variant="secondary"
            size="dense"
            :aria-pressed="card.route.mode === 'advanced'"
            data-testid="route-card-mode-advanced"
            @click="setMode('advanced')"
          >
            {{ t('settings.modelRoute.modeAdvanced') }}
          </Button>
        </div>
        <Switch
          :model-value="card.route.enabled"
          :aria-label="t('settings.modelRoute.routeEnabledLabel')"
          data-testid="route-card-enabled"
          @update:model-value="setEnabled"
        />
        <Switch
          :model-value="card.scoped"
          :aria-label="t('settings.modelRoute.scopedToggle')"
          data-testid="route-scoped-toggle"
          @update:model-value="emit('toggleScoped')"
        />
        <!-- 删除路由（U9 删除侧，GL5/V14）：确认后 route-delete 指令上抛，实际删除走编排层 -->
        <Button
          variant="ghost"
          size="icon"
          class="size-7 rounded-sm p-0 text-neutral-dim hover:text-danger"
          :aria-label="t('settings.modelRoute.deleteRoute')"
          :title="t('settings.modelRoute.deleteRoute')"
          data-testid="route-delete-btn"
          @click="deleteConfirmOpen = true"
        >
          <Trash2 class="size-3.5" />
        </Button>
      </div>
    </div>

    <!-- 删除确认（同步清理 scopedModels 引用与默认模型回退提示；SourceImportSection 同款原语） -->
    <ConfirmDialog
      :open="deleteConfirmOpen"
      :title="t('settings.modelRoute.deleteConfirmTitle')"
      :description="t('settings.modelRoute.deleteConfirmDesc')"
      :confirm-text="t('settings.modelRoute.deleteConfirmConfirm')"
      :cancel-text="t('settings.modelRoute.deleteConfirmCancel')"
      variant="danger"
      @update:open="deleteConfirmOpen = $event"
      @confirm="confirmDelete"
    />

    <!-- 收起态端点 pill 摘要（spec §7.3；点击 pill 展开该卡） -->
    <div v-if="!expanded" class="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-2">
      <Button
        v-for="(member, idx) in card.route.members"
        :key="member.id"
        variant="secondary"
        size="dense"
        class="gap-1 rounded-full"
        data-testid="route-card-pill"
        @click="expanded = true"
      >
        <span class="size-1.5 rounded-full" :class="dotColorClass(idx)" />
        {{ idx + 1 }}. {{ providerNameOf(member) }}
      </Button>
      <span v-if="card.route.members.length === 0" class="text-[length:var(--text-2xs)] text-neutral-dim">
        {{ t('settings.modelRoute.noEndpoints') }}
      </span>
    </div>

    <!-- 展开体 -->
    <div v-if="expanded" class="border-t border-border px-4 pb-4 pt-3">
      <!-- 渠道条（状态汇总，不阻止求值，spec §7.6） -->
      <div class="flex flex-wrap items-center gap-2" data-testid="route-provider-bar">
        <span class="text-[length:var(--text-2xs)] font-medium text-neutral-mid">{{ t('settings.modelRoute.providerBar') }}</span>
        <span class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('settings.modelRoute.providerEnabledN', { n: providerStats.enabled }) }}</span>
        <span v-if="providerStats.disabled > 0" class="text-[length:var(--text-2xs)] text-neutral-dim">
          {{ t('settings.modelRoute.providerDisabledN', { n: providerStats.disabled }) }}
        </span>
        <span v-if="providerStats.deleted > 0" class="rounded-sm bg-danger-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] text-danger">
          {{ t('settings.modelRoute.providerDeletedN', { n: providerStats.deleted }) }}
        </span>
        <Button variant="ghost" size="dense" data-testid="route-goto-providers" @click="emit('openProviders')">
          {{ t('settings.modelRoute.openProviders') }}
        </Button>
      </div>

      <!-- 端点列表 -->
      <div v-if="card.route.members.length > 0" class="mt-3 flex flex-col gap-2">
        <RouteEndpointRow
          v-for="(member, idx) in card.route.members"
          :key="member.id"
          :route="card.route"
          :member="member"
          :index="idx"
          :total="card.route.members.length"
          :providers="providers"
          :advanced="card.route.mode === 'advanced'"
          @op="emit('op', $event)"
          @paint="scrollToTimeGrid"
        />
      </div>
      <div v-else class="mt-3 text-[length:var(--text-2xs)] text-neutral-dim">
        {{ t('settings.modelRoute.noEndpointsHint') }}
      </div>

      <!-- 添加端点（spec §7.9） -->
      <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Select v-model="addProviderId" :disabled="candidates.length === 0">
          <SelectTrigger class="h-8 w-52" data-testid="add-endpoint-select" :aria-label="t('settings.modelRoute.addEndpoint')">
            <SelectValue :placeholder="candidates.length === 0 ? t('settings.modelRoute.noCandidates') : ''" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="id in candidates" :key="id" :value="id">
              {{ providerDisplayName(id) }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="dense"
          data-testid="add-endpoint-btn"
          :disabled="candidates.length === 0"
          @click="addMember"
        >
          {{ t('settings.modelRoute.addEndpoint') }}
        </Button>
        <span class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('settings.modelRoute.addEndpointHint') }}</span>
      </div>

      <!-- 时间轴与特殊日期（仅高级模式，D12；条件数据保留切换恢复） -->
      <template v-if="card.route.mode === 'advanced'">
        <div ref="timeGridWrap">
          <RouteTimeGrid
            :route="card.route"
            :providers="providers"
            :now="now"
            @op="emit('op', $event)"
          />
        </div>
        <RouteSpecialDates :route="card.route" @op="emit('op', $event)" />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Trash2 } from '@lucide/vue'
import { Button, ConfirmDialog, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Switch } from '@taiji/ui'
import type { AggregationMember, AggregationRoute, AggregationRouteMode, ProviderInfo } from '@taiji/shared'
import { candidateProviderIds, evaluateRouteAt, levelsUnion } from './route-preview'
import { dotColorClass } from './route-styles'
import type { RouteEditorOp } from './route-editor-ops'
import RouteEndpointRow from './RouteEndpointRow.vue'
import RouteTimeGrid from './RouteTimeGrid.vue'
import RouteSpecialDates from './RouteSpecialDates.vue'
import { useSettingsToast } from '../injection-keys'

/**
 * 卡草稿数据（页面草稿态形状）：route = 只读展示用路由定义 + scoped 参与选择态。
 * 与 wire 载荷 AggregationRouteCard（含 scopedIndex/memberIssues 派生字段）有意不同——
 * 编辑不就地改本对象，统一走 op 指令上抛（route-editor-ops.ts）；memberIssues 由
 * 组件层从 providers 快照现算（spec §4.5 展示语义）。
 */
export interface RouteCardData {
  route: AggregationRoute
  scoped: boolean
}

const props = defineProps<{
  card: RouteCardData
  providers: ProviderInfo[]
  index: number
  total: number
  now: { dow: number; slot: number }
  /** 新会话可用徽标（U7：路由 id 不在本应用生命周期首次快照内时为 true，页面层判定传入）。 */
  newSessionAvailable?: boolean
}>()

const emit = defineEmits<{ op: [op: RouteEditorOp]; move: [dir: 'up' | 'down']; toggleScoped: []; openProviders: [] }>()

const { t } = useI18n()
const toast = useSettingsToast()

const expanded = ref(false)
/** 时间轴包裹层（端点行「涂时段」平滑滚动定位目标，spec §9.5）。 */
const timeGridWrap = ref<HTMLElement | null>(null)
const addProviderId = ref('')
/** 删除确认弹层开关（U9 删除侧；确认即上抛 route-delete 指令，无草稿就地变更）。 */
const deleteConfirmOpen = ref(false)

/** 删除确认：关闭弹层 + route-delete 指令上抛（页面转发编排层走 deleteRoute 端口）。 */
function confirmDelete(): void {
  deleteConfirmOpen.value = false
  emit('op', { kind: 'route-delete', routeId: props.card.route.id })
}

const candidates = computed(() => candidateProviderIds(props.card.route, props.providers))

const levelsUnionText = computed(() => levelsUnion(props.card.route).join(' / '))

const modeText = computed(() =>
  props.card.route.mode === 'advanced'
    ? t('settings.modelRoute.modeAdvanced')
    : t('settings.modelRoute.modeSimple'),
)

// ── 「此刻」chip（evaluateRouteAt 真实时钟求值，D14 权威展示） ──

const nowEval = computed(() => evaluateRouteAt(props.card.route, props.now))

const nowChipText = computed(() => {
  if (!props.card.route.enabled) {
    return `${t('settings.modelRoute.nowIfEnabled')} → ${hitName.value ?? t('settings.modelRoute.nowNoHitSuffix')}`
  }
  if (nowEval.value.hit === null) return t('settings.modelRoute.nowNoHit')
  return `${t('settings.modelRoute.nowPrefix')} → ${hitName.value}`
})

const nowChipClass = computed(() => {
  if (nowEval.value.hit === null) return 'bg-danger-soft text-danger'
  const hitIndex = nowEval.value.hitIndex ?? 0
  const member = props.card.route.members[hitIndex]
  const provider = props.providers.find((p) => p.id === member?.providerId)
  const problem = provider === undefined || provider.enabled === false || provider.apiKeySet === false
  return problem ? 'bg-warn-soft text-warn' : 'bg-success-soft text-success'
})

const hitName = computed(() => {
  const hit = nowEval.value.hit
  if (!hit) return null
  return providerNameOf(hit)
})

function providerNameOf(member: AggregationMember): string {
  return props.providers.find((p) => p.id === member.providerId)?.name ?? member.providerId
}

function providerDisplayName(id: string): string {
  return props.providers.find((p) => p.id === id)?.name ?? id
}

// ── 渠道条统计（去重渠道计数，spec §7.6） ──

const providerStats = computed(() => {
  const ids = [...new Set(props.card.route.members.map((m) => m.providerId))]
  let enabled = 0
  let disabled = 0
  let deleted = 0
  for (const id of ids) {
    const p = props.providers.find((x) => x.id === id)
    if (p === undefined) deleted += 1
    else if (p.enabled === false) disabled += 1
    else enabled += 1
  }
  return { enabled, disabled, deleted }
})

// ── 编辑动作（就地改 + change 标脏） ──

function setMode(mode: AggregationRouteMode): void {
  if (props.card.route.mode === mode) return
  emit('op', { kind: 'route-patch', routeId: props.card.route.id, patch: { mode } })
}

function setEnabled(value: boolean): void {
  emit('op', { kind: 'route-patch', routeId: props.card.route.id, patch: { enabled: value } })
}

/** 「涂时段」定位：平滑滚动到时间轴并居中（spec §9.5）。 */
function scrollToTimeGrid(): void {
  timeGridWrap.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/**
 * 添加端点（spec §7.9）：候选约束由子组件下拉承担，插入规则（高级模式插到第一个
 * 无条件端点之前）在页面 reducer 执行；新端点默认无条件。
 */
function addMember(): void {
  const providerId = addProviderId.value || candidates.value[0]
  if (!providerId) return
  emit('op', { kind: 'endpoint-add', routeId: props.card.route.id, providerId })
  addProviderId.value = ''
  toast.info(t('settings.modelRoute.endpointAdded'))
}
</script>
