<!--
  RouteEndpointLevels —— 端点行思考等级标签区（provider-aggregation spec §5.2-§5.4，
  demo 形态：7 档多选标签带迷你柱状 icon、选中填充、右侧对外并集）。
  从 RouteEndpointRow 拆出（模板圈复杂度治理，行为/视觉不变）：按模型能力置灰，
  档位未知不伪装置灰；编辑走 endpoint-patch 上抛 op（routeId/memberIndex 由父组件补齐）。
-->
<template>
  <div class="rounded-sm bg-surface-2 px-2 py-1.5" data-testid="endpoint-levels-row">
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-[length:var(--text-2xs)] font-medium text-neutral-mid">{{ t('settings.modelRoute.levelsTitle') }}</span>
      <span class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('settings.modelRoute.levelsHelper') }}</span>
      <span class="ml-auto text-[length:var(--text-2xs)] text-neutral-mid" data-testid="endpoint-levels-union">
        {{ t('settings.modelRoute.levelsUnionInline') }}
        <span class="font-medium text-neutral-fg">{{ levelsUnionDisplay }}</span>
      </span>
    </div>
    <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
      <Button
        v-for="level in PI_THINKING_LEVELS"
        :key="level"
        variant="secondary"
        size="dense"
        class="gap-1 rounded-full"
        :class="levelBtnClass(level)"
        :aria-pressed="isLevelDeclared(level)"
        :disabled="levelDisabled(level)"
        :title="levelTitle(level)"
        :data-testid="`endpoint-level-${level}`"
        @click="toggleLevel(level)"
      >
        <svg viewBox="0 0 10 10" class="size-2.5 shrink-0" aria-hidden="true">
          <rect x="0" y="6" width="2.4" height="4" rx="0.5" fill="currentColor" />
          <rect x="3.8" y="3" width="2.4" height="7" rx="0.5" fill="currentColor" />
          <rect x="7.6" y="0" width="2.4" height="10" rx="0.5" fill="currentColor" />
        </svg>
        {{ t(`composable.thinkingLevel.${level}`) }}
      </Button>
      <span v-if="supportedUnknown" class="text-[length:var(--text-2xs)] text-neutral-dim">
        {{ t('settings.modelRoute.levelsUnknown') }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@taiji/ui'
import type { AggregationMember, AggregationRoute, ProviderInfo } from '@taiji/shared'
import { PI_THINKING_LEVELS } from '@taiji/shared'
import { levelsUnion } from './route-preview'
import { useSettingsToast } from '../injection-keys'

const props = defineProps<{
  route: AggregationRoute
  member: AggregationMember
  providers: ProviderInfo[]
}>()

const emit = defineEmits<{ levels: [levels: Record<string, string | null>] }>()

const { t } = useI18n()
const toast = useSettingsToast()

/** 本端点模型的 supportedLevels（归一后）；null = 档位未知（能力标注缺失，不伪装置灰）。 */
const supportedLevelsOfModel = computed<string[] | null>(() => {
  const model = props.providers
    .find((p) => p.id === props.member.providerId)
    ?.models.find((m) => m.id === props.member.modelId)
  return model?.supportedLevels ?? null
})

const supportedUnknown = computed(() => supportedLevelsOfModel.value === null)

function isLevelAvailable(level: string): boolean {
  const supported = supportedLevelsOfModel.value
  return supported === null ? true : supported.includes(level)
}

function isLevelDeclared(level: string): boolean {
  const levels = props.member.levels
  if (!levels) return false
  return levels[level] !== undefined && levels[level] !== null
}

// ── 模板下沉的展示判定（单一语义化值，模板零组合条件） ──

const levelsUnionText = computed(() => levelsUnion(props.route).join(' · '))
const levelsUnionDisplay = computed(() => levelsUnionText.value || '—')

/** 标签样式（选中填充，demo 同形）。 */
function levelBtnClass(level: string): string {
  return isLevelDeclared(level) ? 'border-success bg-success-soft text-success' : 'border-border text-neutral-mid'
}

/** 置灰判定（修剪 F2）：只有未声明且不支持才置灰；已声明但新模型不支持仍可点（取消声明）。 */
function levelDisabled(level: string): boolean {
  return !isLevelAvailable(level) && !isLevelDeclared(level)
}

function levelTitle(level: string): string {
  if (!isLevelAvailable(level)) {
    // 已声明但新模型不支持：仍可点（取消声明），只有未声明且不支持才置灰（修剪 F2）
    return isLevelDeclared(level)
      ? t('settings.modelRoute.levelsDeclaredStale')
      : t('settings.modelRoute.levelsUnsupported')
  }
  return isLevelDeclared(level) ? t('settings.modelRoute.levelsDeclared') : t('settings.modelRoute.levelsUndeclared')
}

/** 档位 toggle（spec §5.4）：levels 缺省时首点初始化为「支持集全选」再 toggle 所点档；
 *  档位未知时以 7 档全集初始化。编辑走 endpoint-patch（AggregationMemberPatch 已含 levels）。 */
function toggleLevel(level: string): void {
  // 未声明且不支持 → 置灰拦截；已声明但模型不支持 → 放行（唯一动作 = 取消声明，修剪 F2）
  if (levelDisabled(level)) {
    toast.info(t('settings.modelRoute.levelsUnsupported'))
    return
  }
  const supported = supportedLevelsOfModel.value ?? [...PI_THINKING_LEVELS]
  const base: Record<string, string | null> = props.member.levels
    ? { ...props.member.levels }
    : Object.fromEntries(supported.map((l) => [l, l]))
  base[level] = isLevelDeclared(level) ? null : level
  emit('levels', base)
}
</script>
