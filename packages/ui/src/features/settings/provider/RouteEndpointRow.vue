<!--
  RouteEndpointRow —— 路由端点行（provider-aggregation U5b · spec §7.8/§7.9；视觉形态对齐
  response.html demo：序号圆徽标 + 条件 joined 分段 + 「思考等级 n」行内折叠 + 编辑时段行内网格）。

  行要素：顺位圆徽标（端点色板底 + 序号）/ 渠道下拉（候选 = 存在·启用·未被占用；当前渠道
  即使异常也保留并标注）/ 模型下拉（候选 = 本渠道启用模型；当前值禁用/已移除也保留并标注）/
  异常 chip（配置保留优先，不剔除求值）/ 截断与不命中标记 / 条件区（高级模式：四型 joined
  分段 + 时间摘要 + 额度阈值 + 编辑时段行内网格开关）/ 思考等级区（简单模式常驻；高级模式
  「思考等级 n」折叠）/ 操作（上移·下移·删除；最后端点删除 aria-disabled + toast 阻止）。

  时间轴迁移（spec §12）：编辑时段 = 展开本端点行内 7×48 网格（RouteInlineTimeGrid，
  单端点可路由语义 + 涂抹/橡皮/快捷涂抹），替代旧共享网格的图例选端点形态。

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
    <!-- 顺位圆徽标（demo 形态：端点色板底 + 序号；文字色取卡底 token 保证对比） -->
    <span
      class="flex size-5 shrink-0 items-center justify-center rounded-full text-[length:10px] font-medium leading-none"
      :class="dotColorClass(index)"
      :style="{ color: 'var(--bg-card)' }"
      aria-hidden="true"
    >{{ index + 1 }}</span>

    <!-- 渠道下拉：候选过滤 + 当前渠道异常保留标注 -->
    <Select
      :model-value="member.providerId"
      data-testid="endpoint-provider-select"
      @update:model-value="(providerId: unknown) => emit('op', opWith({ kind: 'endpoint-patch', patch: { providerId: String(providerId) } }))"
    >
      <SelectTrigger class="h-8 w-40" :aria-label="t('settings.modelRoute.providerLabel')" data-testid="endpoint-provider-select">
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
      @update:model-value="(modelId: unknown) => emit('op', opWith({ kind: 'endpoint-patch', patch: patchModelSwitch(String(modelId)) }))"
    >
      <SelectTrigger class="h-8 min-w-40 flex-1 font-mono" :aria-label="t('settings.modelRoute.modelLabel')" data-testid="endpoint-model-select">
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
      class="rounded-sm border border-warn px-1.5 py-0.5 text-[length:var(--text-3xs)] text-warn"
      data-testid="endpoint-truncates"
    >
      {{ t('settings.modelRoute.condTruncates') }}
    </span>
    <span
      v-else-if="neverHit"
      class="rounded-sm border border-danger px-1.5 py-0.5 text-[length:var(--text-3xs)] text-danger"
      data-testid="endpoint-never-hit"
    >
      {{ t('settings.modelRoute.neverHit') }}
    </span>

    <!-- 思考等级折叠开关（仅高级模式；简单模式常驻，demo 同形） -->
    <Button
      v-if="advanced"
      variant="ghost"
      size="dense"
      class="gap-1"
      :aria-expanded="levelsOpen"
      data-testid="endpoint-levels-toggle"
      @click="levelsOpen = !levelsOpen"
    >
      {{ t('settings.modelRoute.levelsToggle', { n: declaredLevelsCount }) }}
      <ChevronDown class="size-3" :class="levelsToggleChevronClass" />
    </Button>

    <!-- 条件区（仅高级模式；joined 分段 demo 形态） -->
    <template v-if="advanced">
      <div class="flex items-center overflow-hidden rounded-md border border-border" data-testid="endpoint-condition-type" role="group" :aria-label="t('settings.modelRoute.conditionType')">
        <Button
          v-for="ct in CONDITION_TYPES"
          :key="ct"
          variant="ghost"
          size="dense"
          class="rounded-none"
          :class="condTypeClass(ct)"
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
      <!-- 编辑时段（spec §12：行内网格开关；仅窗型端点） -->
      <Button
        v-if="hasWindow"
        variant="ghost"
        size="dense"
        class="underline-offset-2"
        :aria-expanded="gridOpen"
        data-testid="endpoint-edit-time"
        @click="gridOpen = !gridOpen"
      >
        {{ t('settings.modelRoute.editTime') }}
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
        :aria-disabled="removeAriaDisabled"
        data-testid="endpoint-remove"
        @click="onRemove"
      >
        <Trash2 class="size-3.5" />
      </Button>
    </div>

    <!-- 思考等级标签区（spec §5.2-§5.4：7 档多选，按模型能力置灰；简单模式常驻 / 高级折叠。
         demo 形态：标签带迷你柱状 icon、选中填充、右侧对外并集；拆出组件治理模板圈复杂度） -->
    <RouteEndpointLevels
      v-if="levelsVisible"
      class="w-full"
      :route="route"
      :member="member"
      :providers="providers"
      @levels="(levels) => emit('op', opWith({ kind: 'endpoint-patch', patch: { levels } }))"
    />

    <!-- 编辑时段行内网格（spec §12 迁移；仅窗型端点，demo 同形） -->
    <RouteInlineTimeGrid
      v-if="gridVisible"
      class="w-full"
      :route="route"
      :member="member"
      :index="index"
      :providers="providers"
      :now="now"
      @op="emit('op', $event)"
    />
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
import RouteInlineTimeGrid from './RouteInlineTimeGrid.vue'
import RouteEndpointLevels from './RouteEndpointLevels.vue'
import { useSettingsToast } from '../injection-keys'

const props = defineProps<{
  route: AggregationRoute
  member: AggregationMember
  index: number
  total: number
  providers: ProviderInfo[]
  /** 高级模式条件区显隐（D12：simple 只显示依次兜底，条件数据保留）。 */
  advanced: boolean
  /** 「当前格」坐标（行内网格 now 高亮；页面挂载时点墙钟一次注入，ADR-0190 零定时器）。 */
  now: { dow: number; slot: number }
}>()

const emit = defineEmits<{ op: [op: RouteEditorOp] }>()

/** 编辑指令构造便捷闭包（routeId/memberIndex 在本组件恒定）。 */
function opWith(partial: MemberOpInput): RouteEditorOp {
  return { ...partial, routeId: props.route.id, memberIndex: props.index } as RouteEditorOp
}

const { t } = useI18n()
const toast = useSettingsToast()

const CONDITION_TYPES: readonly AggregationMemberConditionType[] = ['none', 'window', 'quota', 'combo']

const issueMap = computed(() => endpointIssueKinds(props.route, props.providers))
const issueKinds = computed(() => issueMap.value.get(props.index) ?? [])
const providerOptions = computed(() => endpointProviderOptions(props.route, props.member, props.providers))

const truncates = computed(() => truncatesAfter(props.route, props.index))
const neverHit = computed(() => suppressedByEarlierUnconditional(props.route, props.index))
const isLast = computed(() => props.index === props.total - 1)

// ── 模板下沉的展示判定（单一语义化值，模板零组合条件） ──

const levelsToggleChevronClass = computed(() => (levelsOpen.value ? '' : '-rotate-90'))

/** 条件类型分段按钮样式（选中段填充，demo joined 形态）。 */
function condTypeClass(type: AggregationMemberConditionType): string {
  return props.member.type === type ? 'bg-surface-2 font-medium text-neutral-fg' : 'text-neutral-mid'
}

/** 最后端点删除保护：aria-disabled 用 undefined 摘除属性（保留点击，toast 阻止）。 */
const removeAriaDisabled = computed(() => isLast.value || undefined)

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

// ── 思考等级（spec §5.4：支持声明编辑；能力唯一依据 = runtime 下发 supportedLevels）──
// 标签区拆出 RouteEndpointLevels（模板圈复杂度治理），本组件只留折叠态与折叠开关计数。

const levelsOpen = ref(false)
/** 简单模式常驻（demo 同形）；高级模式经「思考等级 n」折叠。 */
const levelsVisible = computed(() => !props.advanced || levelsOpen.value)

const declaredLevelsCount = computed(
  () => Object.values(props.member.levels ?? {}).filter((v) => v !== null && v !== undefined).length,
)

// ── 编辑时段行内网格 ──

const gridOpen = ref(false)
/** 网格可见 = 展开开关且窗型端点（spec §12 仅窗型可编辑）。 */
const gridVisible = computed(() => gridOpen.value && hasWindow.value)

/**
 * 模型切换补丁（修剪 F2）：modelId 换到新模型时，已声明档位按新模型 supportedLevels
 * 过滤（未知能力保留不过滤——零事实不伪装置灰同族语义）；过滤后空集删除 levels 字段。
 */
function patchModelSwitch(modelId: string): { modelId: string; levels?: Record<string, string | null> } {
  if (modelId === props.member.modelId) return { modelId }
  // 新模型的 supportedLevels（非当前 member 的——切换目标能力才是过滤依据）
  const supported =
    props.providers
      .find((p) => p.id === props.member.providerId)
      ?.models.find((m) => m.id === modelId)?.supportedLevels ?? null
  if (supported === null || !props.member.levels) return { modelId }
  const kept = Object.fromEntries(
    Object.entries(props.member.levels).filter(([level, v]) => v !== null && v !== undefined && supported.includes(level)),
  )
  return Object.keys(kept).length === 0 ? { modelId } : { modelId, levels: kept }
}

// ── 编辑时段行内网格 ──
</script>
