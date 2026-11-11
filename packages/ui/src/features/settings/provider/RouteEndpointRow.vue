<!--
  RouteEndpointRow —— 路由端点行（provider-aggregation U5b · spec §7.8 / §7.9 编辑语义）。

  行要素：顺位号 / 颜色点 / 渠道下拉（候选 = 存在·启用·未被占用；当前渠道
  即使异常也保留并标注）/ 模型下拉（候选 = 本渠道启用模型；当前值禁用/已移除也保留
  并标注）/ 异常 chip（配置保留优先，不剔除求值）/
  条件区（高级模式：四型分段 + 时间摘要 + 额度阈值）/ 截断与不命中标记 / 操作
  （涂时段·上移·下移·删除；最后端点删除 aria-disabled + toast 阻止）。

  字段就地修改 route.members[index]（编辑器草稿语义），change 通知标脏。
  条件类型切换语义按 spec §7.8 表格：无条件清空窗与额度；仅时间窗清额度、缺窗填
  工作日白天；仅额度清窗、缺阈值默认 20；组合补齐缺省。
-->
<template>
  <div
    data-testid="route-endpoint-row"
    :data-index="index"
    :data-member-id="member.id"
    class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-card px-3 py-2"
  >
    <span class="w-5 text-center text-[length:var(--text-2xs)] font-medium text-neutral-dim">{{ index + 1 }}</span>
    <span class="size-2 shrink-0 rounded-full" :class="colorClass" />

    <!-- 渠道下拉：候选过滤 + 当前渠道异常保留标注 -->
    <Select
      :model-value="member.providerId"
      data-testid="endpoint-provider-select"
      @update:model-value="(providerId: unknown) => emit('op', opWith({ kind: 'endpoint-patch', patch: { providerId: String(providerId) } }))"
    >
      <SelectTrigger class="h-8 w-44" :aria-label="t('settings.modelRoute.providerLabel')" data-testid="endpoint-provider-select">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem
          v-for="opt in providerOptions"
          :key="opt.provider.id"
          :value="opt.provider.id"
          :disabled="opt.issues.includes('provider-deleted')"
        >
          {{ optionLabel(opt) }}
        </SelectItem>
      </SelectContent>
    </Select>

    <!-- 模型下拉：候选 = 本渠道启用模型；当前值即使禁用/已移除也保留为选项并标注
         （与渠道下拉「当前渠道异常也保留」同型，spec §7.8 配置保留优先） -->
    <Select
      :model-value="member.modelId"
      data-testid="endpoint-model-select"
      @update:model-value="(modelId: unknown) => emit('op', opWith({ kind: 'endpoint-patch', patch: { modelId: String(modelId) } }))"
    >
      <SelectTrigger class="h-8 w-44 font-mono" :aria-label="t('settings.modelRoute.modelLabel')" data-testid="endpoint-model-select">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="opt in modelOptions" :key="opt.id" :value="opt.id">
          {{ opt.label }}
        </SelectItem>
      </SelectContent>
    </Select>

    <!-- 异常 chip（配置保留优先，spec §4.5） -->
    <span
      v-for="kind in issueKinds"
      :key="kind"
      class="rounded-sm px-1.5 py-0.5 text-[length:var(--text-3xs)]"
      :class="issueChipClass(kind)"
    >
      {{ t(endpointIssueKey(kind)) }}
    </span>

    <!-- 截断 / 不命中标记（spec §7.8 求值顺序提示） -->
    <span
      v-if="truncates"
      class="rounded-sm bg-warn-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] text-warn"
      data-testid="endpoint-truncates"
    >
      {{ t('settings.modelRoute.condTruncates') }}
    </span>
    <span
      v-else-if="neverHit"
      class="rounded-sm bg-danger-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] text-danger"
      data-testid="endpoint-never-hit"
    >
      {{ t('settings.modelRoute.neverHit') }}
    </span>

    <!-- 条件区（仅高级模式；simple 显示依次兜底） -->
    <template v-if="advanced">
      <div class="flex items-center gap-1" data-testid="endpoint-condition-type" role="group" :aria-label="t('settings.modelRoute.conditionType')">
        <Button
          v-for="ct in CONDITION_TYPES"
          :key="ct"
          variant="secondary"
          size="dense"
          :aria-pressed="member.type === ct"
          :data-testid="`endpoint-cond-${ct}`"
          @click="setConditionType(ct)"
        >
          {{ t(`settings.modelRoute.cond${ct[0]!.toUpperCase()}${ct.slice(1)}`) }}
        </Button>
      </div>
      <span v-if="hasWindow" class="font-mono text-[length:var(--text-2xs)] text-neutral-mid">
        {{ t('settings.modelRoute.windowSummary', { n: windowCellCount }) }}
      </span>
      <template v-if="hasQuota">
        <Label :for="quotaInputId" class="text-[length:var(--text-2xs)] text-neutral-mid">
          {{ t('settings.modelRoute.quotaThresholdLabel') }}
        </Label>
        <Input
          :id="quotaInputId"
          :model-value="quotaThreshold"
          data-testid="endpoint-quota-threshold"
          class="h-8 w-16 text-[length:var(--text-xs)]"
          :aria-label="t('settings.modelRoute.quotaThresholdLabel')"
          @update:model-value="setQuotaThreshold"
        />
        <span class="text-[length:var(--text-2xs)] text-neutral-dim">%</span>
      </template>
      <span v-if="member.type === 'none'" class="text-[length:var(--text-2xs)] text-neutral-dim">
        {{ t('settings.modelRoute.condUnconditionalNote') }}
      </span>
      <Button
        variant="ghost"
        size="dense"
        data-testid="endpoint-paint-btn"
        @click="emit('paint')"
      >
        {{ t('settings.modelRoute.paintWindow') }}
      </Button>
    </template>
    <span v-else class="text-[length:var(--text-2xs)] text-neutral-dim" data-testid="simpleFallback">
      {{ t('settings.modelRoute.simpleFallbackText') }}
    </span>

    <!-- 操作 -->
    <div class="ml-auto flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        class="size-7 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
        :disabled="index === 0"
        :aria-label="t('settings.modelRoute.moveUp')"
        data-testid="endpoint-move-up"
        @click="emit('op', { kind: 'endpoint-move', routeId: route.id, memberIndex: index, dir: 'up' })"
      >
        <ChevronUp class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="size-7 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
        :disabled="index === total - 1"
        :aria-label="t('settings.modelRoute.moveDown')"
        data-testid="endpoint-move-down"
        @click="emit('op', { kind: 'endpoint-move', routeId: route.id, memberIndex: index, dir: 'down' })"
      >
        <ChevronDown class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="size-7 rounded-sm p-0 text-danger hover:bg-danger-soft"
        :aria-label="t('settings.modelRoute.remove')"
        :aria-disabled="isLast || undefined"
        data-testid="endpoint-remove"
        @click="onRemove"
      >
        <Trash2 class="size-3.5" />
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronUp, ChevronDown, Trash2 } from '@lucide/vue'
import { Button, Input, Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@taiji/ui'
import type { AggregationMember, AggregationRoute, AggregationMemberConditionType, ProviderInfo } from '@taiji/shared'
import { AGGREGATION_QUOTA_THRESHOLD_MAX } from '@taiji/shared'
import {
  endpointIssueKey,
  endpointIssueKinds,
  endpointProviderOptions,
  truncatesAfter,
  suppressedByEarlierUnconditional,
  type EndpointIssueKind,
} from './route-preview'
import { dotColorClass, issueChipClass } from './route-styles'
import { DEFAULT_QUOTA_THRESHOLD_PERCENT, type MemberOpInput, type RouteEditorOp } from './route-editor-ops'
import { useSettingsToast } from '../injection-keys'

const props = defineProps<{
  route: AggregationRoute
  member: AggregationMember
  index: number
  total: number
  providers: ProviderInfo[]
  /** 高级模式条件区显隐（D12：simple 只显示依次兜底，条件数据保留）。 */
  advanced: boolean
}>()

const emit = defineEmits<{ op: [op: RouteEditorOp]; paint: [] }>()

/** 编辑指令构造便捷闭包（routeId/memberIndex 在本组件恒定）。 */
function opWith(partial: MemberOpInput): RouteEditorOp {
  return { ...partial, routeId: props.route.id, memberIndex: props.index } as RouteEditorOp
}

const { t } = useI18n()
const toast = useSettingsToast()

const CONDITION_TYPES: readonly AggregationMemberConditionType[] = ['none', 'window', 'quota', 'combo']

const colorClass = computed(() => dotColorClass(props.index))

const issueMap = computed(() => endpointIssueKinds(props.route, props.providers))
const issueKinds = computed(() => issueMap.value.get(props.index) ?? [])
const providerOptions = computed(() => endpointProviderOptions(props.route, props.member, props.providers))

const truncates = computed(() => truncatesAfter(props.route, props.index))
const neverHit = computed(() => suppressedByEarlierUnconditional(props.route, props.index))
const isLast = computed(() => props.index === props.total - 1)

/**
 * 模型下拉候选（当前渠道维度）：启用模型全集 + 当前值保留项。当前 member.modelId 不在
 * 启用集时插到首位——渠道禁用标注 modelDisabledLabel、模型已移除（含渠道已删除）标注
 * modelRemovedLabel，配置保留优先不产生「当前值无对应选项」的空显示。
 */
const modelOptions = computed(() => {
  const provider = props.providers.find((p) => p.id === props.member.providerId)
  const options = (provider?.models ?? [])
    .filter((m) => m.enabled !== false)
    .map((m) => ({ id: m.id, label: m.name ?? m.id }))
  const current = props.member.modelId
  if (!options.some((o) => o.id === current)) {
    const raw = provider?.models.find((m) => m.id === current)
    const suffix = raw !== undefined ? t('settings.modelRoute.modelDisabledLabel') : t('settings.modelRoute.modelRemovedLabel')
    options.unshift({ id: current, label: (raw?.name ?? current) + suffix })
  }
  return options
})

const hasWindow = computed(() => props.member.type === 'window' || props.member.type === 'combo')
const hasQuota = computed(() => props.member.type === 'quota' || props.member.type === 'combo')

const quotaInputId = useId()

/** 阈值输入本地态（草稿值经 op 回写后由 watch 回灌；缺省 = 默认阈值）。 */
const quotaThreshold = ref(props.member.quota?.thresholdPercent ?? DEFAULT_QUOTA_THRESHOLD_PERCENT)
watch(
  () => props.member.quota?.thresholdPercent,
  (v) => {
    quotaThreshold.value = v ?? DEFAULT_QUOTA_THRESHOLD_PERCENT
  },
)

const windowCellCount = computed(() =>
  props.member.window?.reduce((sum, row) => sum + row.filter(Boolean).length, 0) ?? 0,
)

function optionLabel(opt: { provider: ProviderInfo; issues: EndpointIssueKind[] }): string {
  let label = opt.provider.name
  if (opt.issues.includes('provider-deleted')) label += t('settings.modelRoute.deletedProviderLabel')
  else if (opt.issues.includes('provider-disabled')) label += t('settings.modelRoute.disabledProviderLabel')
  if (opt.issues.includes('model-removed')) label += t('settings.modelRoute.modelRemovedLabel')
  return label
}

/** 条件类型切换（spec §7.8 切换语义表的补齐执行在页面 reducer）。 */
function setConditionType(type: AggregationMemberConditionType): void {
  if (props.member.type === type) return
  emit('op', opWith({ kind: 'endpoint-condition-type', type }))
}

/** 阈值编辑（0-100 整数钳制；空值回默认）。 */
function setQuotaThreshold(value: string | number): void {
  const n = Math.round(Number(value))
  const clamped = Number.isFinite(n)
    ? Math.min(AGGREGATION_QUOTA_THRESHOLD_MAX, Math.max(0, n))
    : DEFAULT_QUOTA_THRESHOLD_PERCENT
  quotaThreshold.value = clamped
  emit('op', opWith({ kind: 'endpoint-patch', patch: { quota: { thresholdPercent: clamped } } }))
}

/** 最后端点删除保护（spec §7.8：aria-disabled 保留点击，toast 阻止不置 disabled）。 */
function onRemove(): void {
  if (isLast.value) {
    toast.warning(t('settings.modelRoute.lastEndpointProtect'))
    return
  }
  emit('op', { kind: 'endpoint-remove', routeId: props.route.id, memberIndex: props.index })
}
</script>
