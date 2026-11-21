<!--
  RouteQuickCreatePanel —— 快速创建面板（模型路由页 spec §4；视觉形态对齐 response.html demo）。

  两类创建入口（spec §3 创建入口收敛）：
  - 渠道展开后模型行「建简单路由」（emit createSimple，单模型；描边 pill，低视觉重量）。
  - 底部「创建高级路由 · n」（emit createAdvanced，勾选序多选，≥2 解禁）。

  面板只发创建意图，草稿构建与 route-add 由 ModelRoutePage 执行（applyEditorOp 唯一入口）；
  高级创建 emit 后即清空筛选/选择/展开态（spec §4.6）。
  折叠不丢状态；选择键 = providerId+modelId（§4.4）；只列可用模型（渠道启用+有密钥+模型启用）。
  重复创建防护（AC-Q13）走事实态：父级 existingSimpleOf 判定本编辑会话内已存在同模型未保存
  简单路由时该行按钮禁用（无时间窗逻辑，ADR-0190 精神）。
-->
<template>
  <div
    ref="rootEl"
    data-testid="route-quick-create"
    class="rounded-lg border border-border bg-bg-card"
  >
    <!-- 标题行（demo 形态：+ 圆标徽标 + 标题说明 + 「收起 ⌄」pill；折叠保留筛选/选择/展开态） -->
    <div class="flex items-start justify-between gap-3 px-4 py-3">
      <div class="flex items-start gap-2.5">
        <span class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-success-soft text-success">
          <Plus class="size-3.5" />
        </span>
        <div>
          <p class="text-[length:var(--text-sm)] font-medium text-neutral-fg">{{ t('settings.modelRoute.quickCreateTitle') }}</p>
          <p class="mt-0.5 text-[length:var(--text-2xs)] text-neutral-mid">{{ t('settings.modelRoute.quickCreateDesc') }}</p>
        </div>
      </div>
      <Button
        variant="secondary"
        size="dense"
        class="gap-1 rounded-full"
        :aria-expanded="open"
        data-testid="route-quick-create-toggle"
        @click="open = !open"
      >
        {{ open ? t('settings.modelRoute.quickCollapse') : t('settings.modelRoute.quickExpand') }}
        <ChevronDown class="size-3.5" :class="open ? '' : 'rotate-180'" />
      </Button>
    </div>

    <div v-if="open" class="border-t border-border px-4 pb-3 pt-3">
      <!-- 无可用渠道空态（spec §4.7） -->
      <div v-if="availableProviders.length === 0" class="flex flex-col items-center gap-2 py-6" data-testid="route-quick-empty-providers">
        <Server class="size-8 text-neutral-dim" />
        <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('settings.modelRoute.quickNoProviders') }}</p>
        <Button size="dense" @click="emit('openProviders')">{{ t('settings.modelRoute.goProviders') }}</Button>
      </div>

      <template v-else>
        <!-- 搜索框（demo 形态：全宽 + 内嵌放大镜；有原始输入即显清除） -->
        <div class="flex items-center gap-2">
          <div class="relative flex-1">
            <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-neutral-dim" />
            <Input
              v-model="filter"
              type="search"
              class="h-8 w-full pl-8 text-[length:var(--text-xs)]"
              :placeholder="t('settings.modelRoute.quickFilterPlaceholder')"
              :aria-label="t('settings.modelRoute.quickFilterPlaceholder')"
              data-testid="route-quick-filter"
            />
          </div>
          <Button
            v-if="filter !== ''"
            variant="ghost"
            size="dense"
            data-testid="route-quick-filter-clear"
            @click="filter = ''"
          >
            {{ t('settings.modelRoute.quickFilterClear') }}
          </Button>
        </div>

        <!-- 筛选无结果空态（spec §4.2） -->
        <div v-if="visibleProviders.length === 0" class="py-6 text-center" data-testid="route-quick-filter-empty">
          <p class="text-[length:var(--text-xs)] text-neutral-mid">
            {{ t('settings.modelRoute.quickFilterNoMatch', { q: filter.trim() }) }}
          </p>
        </div>

        <!-- 渠道平铺列表（demo 形态：行 + 分隔线；首字母头像 + 名称 + 计数 + 右侧 chevron） -->
        <div v-else class="mt-2 divide-y divide-border" data-testid="route-quick-provider-list">
          <div v-for="group in visibleProviders" :key="group.provider.id" :data-provider-id="group.provider.id">
            <Button
              variant="ghost"
              class="flex w-full justify-start gap-2 px-0 py-2 text-left"
              :aria-expanded="expandedProviders.has(group.provider.id)"
              data-testid="route-quick-provider-row"
              @click="toggleProvider(group.provider.id)"
            >
              <span
                class="flex size-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-[length:10px] font-medium leading-none text-success"
                aria-hidden="true"
              >
                {{ avatarChar(group.provider.name) }}
              </span>
              <span class="text-[length:var(--text-xs)] font-medium text-neutral-fg">{{ group.provider.name }}</span>
              <span class="text-[length:var(--text-2xs)] text-neutral-mid">
                {{ filtering ? t('settings.modelRoute.quickGroupMatchCount', { n: group.models.length }) : t('settings.modelRoute.quickGroupModelCount', { n: group.models.length }) }}
              </span>
              <span
                v-if="pickedCountOf(group.provider.id) > 0"
                class="rounded-sm bg-success-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] text-success"
                data-testid="route-quick-provider-picked"
              >
                {{ t('settings.modelRoute.quickPickedN', { n: pickedCountOf(group.provider.id) }) }}
              </span>
              <ChevronDown
                class="ml-auto size-3.5 shrink-0 text-neutral-dim transition-transform"
                :class="expandedProviders.has(group.provider.id) ? '' : '-rotate-90'"
              />
            </Button>

            <!-- 模型行列表 -->
            <div v-if="expandedProviders.has(group.provider.id)" class="pb-2">
              <div
                v-for="model in group.models"
                :key="model.id"
                class="flex flex-wrap items-center gap-2 py-1 pl-7 pr-1"
                data-testid="route-quick-model-row"
                :data-model-id="model.id"
              >
                <!-- 复选（demo 形态 Checkbox；选择键 = providerId+modelId，spec §4.4） -->
                <Checkbox
                  :model-value="isPicked(group.provider.id, model.id)"
                  class="shrink-0"
                  :aria-label="model.name ?? model.id"
                  :data-testid="`route-quick-pick-${group.provider.id}-${model.id}`"
                  @update:model-value="() => togglePick(group.provider.id, model.id, model.name ?? model.id)"
                />
                <span class="min-w-0 truncate text-[length:var(--text-xs)] text-neutral-fg" :title="model.id">{{ model.name ?? model.id }}</span>
                <span class="text-[length:var(--text-2xs)] text-neutral-dim">
                  {{ modelMeta(group.provider.id, model) }}
                </span>
                <div class="ml-auto flex items-center gap-1.5">
                  <Button
                    v-if="existingSimpleOf?.(group.provider.id, model.id)"
                    variant="ghost"
                    size="dense"
                    disabled
                    :title="t('settings.modelRoute.quickSimpleExists')"
                    data-testid="route-quick-simple-exists"
                  >
                    {{ t('settings.modelRoute.quickSimpleExists') }}
                  </Button>
                  <Button
                    v-else
                    variant="secondary"
                    size="dense"
                    class="rounded-full"
                    data-testid="route-quick-create-simple"
                    :disabled="disabled"
                    @click="emitSimple(group.provider, model)"
                  >
                    {{ t('settings.modelRoute.quickCreateSimple') }}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 底部选择摘要与批量创建（spec §4.4/§4.6） -->
        <div class="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-3" data-testid="route-quick-footer">
          <span class="text-[length:var(--text-2xs)] text-neutral-mid" data-testid="route-quick-selection-summary">{{ selectionSummary }}</span>
          <Button
            v-if="picked.length > 0"
            variant="ghost"
            size="dense"
            data-testid="route-quick-clear-picks"
            @click="picked = []"
          >
            {{ t('settings.modelRoute.quickClearPicks') }}
          </Button>
          <Button
            class="ml-auto"
            size="dense"
            :disabled="disabled || picked.length < MIN_ADVANCED_PICKS"
            data-testid="route-quick-create-advanced"
            @click="emitAdvanced"
          >
            {{ picked.length >= MIN_ADVANCED_PICKS ? t('settings.modelRoute.quickCreateAdvancedN', { n: picked.length }) : t('settings.modelRoute.quickCreateAdvanced') }}
          </Button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Plus, Search, Server } from '@lucide/vue'
import { Button, Checkbox, Input } from '@taiji/ui'
import type { ProviderInfo } from '@taiji/shared'
import type { QuickPickModel } from './route-quick-create'

/** 高级路由最少模型数（spec §4.6：已选 ≥2 才解禁）。 */
const MIN_ADVANCED_PICKS = 2
/** 摘要展示的模型名数（超出加「等」后缀）。 */
const SUMMARY_NAMES_SHOWN = 3
/** 多选软提示阈值（spec §4.4：超过提示分批，不硬性阻止）。 */
const MANY_PICKS_HINT_THRESHOLD = 12

/** 面板内可用模型行（providers.models 过滤启用后的展示形态）。 */
interface QuickModel {
  id: string
  name?: string
  supportedLevels?: string[]
}

/** 勾选态（有序；选择键 = providerId+modelId，spec §4.4）。 */
interface PickedEntry {
  providerId: string
  modelId: string
  displayName: string
}

const props = defineProps<{
  providers: ProviderInfo[]
  /** 创建入口禁用（视图加载中 / 保存进行中，spec §4.7/§6.3）。 */
  disabled?: boolean
  /** 「用于 m 条路由」统计（仅路由口径，spec §4.8）；缺省恒 0。 */
  usageOf?: (providerId: string, modelId: string) => number
  /** 事实态重复防护（AC-Q13）：draft 已存在同 provider+model 未保存简单路由 → true。 */
  existingSimpleOf?: (providerId: string, modelId: string) => boolean
}>()

const emit = defineEmits<{
  createSimple: [pick: QuickPickModel]
  createAdvanced: [payload: { picks: QuickPickModel[]; filterKeyword: string }]
  openProviders: []
}>()

const { t } = useI18n()

const rootEl = ref<HTMLElement | null>(null)
/** 面板展开态（默认展开，spec §4.1；折叠保留筛选/选择/展开态）。 */
const open = ref(true)
const filter = ref('')
const expandedProviders = ref(new Set<string>())
const picked = ref<PickedEntry[]>([])

/** 外部聚焦入口（页头「快速创建」按钮：展开 + 滚动到视野）。 */
function focusPanel(): void {
  open.value = true
  rootEl.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
defineExpose({ focusPanel })

// ── 可用模型目录（渠道启用 + 有密钥 + 模型启用；不可用渠道整体不出列表） ──

const availableProviders = computed(() =>
  props.providers.filter(
    (p) => p.kind !== 'aggregation' && p.enabled !== false && p.apiKeySet !== false,
  ),
)

/** 渠道 → 可用模型映射（含 supportedLevels 透传）。 */
const modelsByProvider = computed(() => {
  const map = new Map<string, QuickModel[]>()
  for (const p of availableProviders.value) {
    map.set(p.id, p.models.filter((m) => m.enabled !== false).map((m) => ({ id: m.id, name: m.name, supportedLevels: m.supportedLevels })))
  }
  return map
})

/** 渠道头像首字符（demo 形态：名称首字符圆标；空名回落 #）。 */
function avatarChar(name: string): string {
  const ch = name.trim().charAt(0)
  return ch === '' ? '#' : ch
}

/** 筛选词（trim 后小写；空串 = 未筛选）。匹配 = 模型显示名/id/渠道显示名/id。 */
const filterQuery = computed(() => filter.value.trim().toLowerCase())
const filtering = computed(() => filterQuery.value !== '')

const visibleProviders = computed(() => {
  const q = filterQuery.value
  return availableProviders.value
    .map((provider) => {
      const models = modelsByProvider.value.get(provider.id) ?? []
      const matched = q === ''
        ? models
        : models.filter(
          (m) =>
            (m.name ?? '').toLowerCase().includes(q) ||
              m.id.toLowerCase().includes(q) ||
              provider.name.toLowerCase().includes(q) ||
              provider.id.toLowerCase().includes(q),
        )
      return { provider, models: matched }
    })
    .filter((g) => g.models.length > 0)
})

function toggleProvider(id: string): void {
  const next = new Set(expandedProviders.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedProviders.value = next
}

// ── 多选（选择键 = provider+model；筛选/折叠不丢，spec §4.4/§8） ──

function isPicked(providerId: string, modelId: string): boolean {
  return picked.value.some((p) => p.providerId === providerId && p.modelId === modelId)
}

function togglePick(providerId: string, modelId: string, displayName: string): void {
  if (isPicked(providerId, modelId)) {
    picked.value = picked.value.filter((p) => !(p.providerId === providerId && p.modelId === modelId))
  } else {
    picked.value = [...picked.value, { providerId, modelId, displayName }]
  }
}

function pickedCountOf(providerId: string): number {
  return picked.value.filter((p) => p.providerId === providerId).length
}

/** 底部摘要（未选 / 已选 n 个：前三个名字 + 等；>12 软提示，spec §4.4；纯文本插值，零 v-html）。 */
const selectionSummary = computed(() => {
  const n = picked.value.length
  if (n === 0) return t('settings.modelRoute.quickSelectHint')
  const names = picked.value.slice(0, SUMMARY_NAMES_SHOWN).map((p) => p.displayName).join('、')
  const suffix = n > SUMMARY_NAMES_SHOWN ? t('settings.modelRoute.quickMoreSuffix') : ''
  const base = t('settings.modelRoute.quickSelectedN', { n }) + '：' + names + suffix
  return n > MANY_PICKS_HINT_THRESHOLD ? base + ' · ' + t('settings.modelRoute.quickManyPicksHint') : base
})

// ── 创建意图上抛 ──

function modelOf(providerId: string, modelId: string): QuickModel | undefined {
  return modelsByProvider.value.get(providerId)?.find((m) => m.id === modelId)
}

/** 单模型简单路由意图（spec §4.5）；重复点击防护走 existingSimpleOf 事实态按钮禁用。 */
function emitSimple(provider: ProviderInfo, model: QuickModel): void {
  if (props.disabled) return
  emit('createSimple', {
    providerId: provider.id,
    modelId: model.id,
    modelDisplayName: model.name ?? model.id,
    supportedLevels: model.supportedLevels,
  })
}

/** 多选高级路由意图（spec §4.6）：emit 后清空筛选/选择/展开态。 */
function emitAdvanced(): void {
  if (props.disabled || picked.value.length < MIN_ADVANCED_PICKS) return
  const picks: QuickPickModel[] = picked.value.map((p) => ({
    providerId: p.providerId,
    modelId: p.modelId,
    modelDisplayName: p.displayName,
    supportedLevels: modelOf(p.providerId, p.modelId)?.supportedLevels,
  }))
  emit('createAdvanced', { picks, filterKeyword: filter.value })
  filter.value = ''
  picked.value = []
  expandedProviders.value = new Set()
}

/** 模型行元信息：「支持 n 档 · 用于 m 条路由 / 未使用」（spec §4.3）。 */
function modelMeta(providerId: string, model: QuickModel): string {
  const levels = model.supportedLevels?.length
  const usage = props.usageOf?.(providerId, model.id) ?? 0
  const usageText = usage > 0 ? t('settings.modelRoute.quickUsedByN', { n: usage }) : t('settings.modelRoute.quickUnused')
  return (levels !== undefined ? t('settings.modelRoute.quickLevelsN', { n: levels }) + ' · ' : '') + usageText
}
</script>
