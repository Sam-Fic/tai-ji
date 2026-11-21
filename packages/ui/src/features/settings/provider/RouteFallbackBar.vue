<!--
  RouteFallbackBar —— 路由卡底兜底条（provider-aggregation spec §7.7，demo 卡底形态）。
  从 RouteCard 拆出（模板圈复杂度治理，行为/视觉不变）：无条件兜底 → 模型名 + 异常 chip；
  无无条件端点时警示文案。求值数据（fallbackMemberOf / endpointIssueKinds）由本组件现算。
-->
<template>
  <div
    data-testid="route-time-fallback-bar"
    class="mt-2 flex flex-wrap items-center gap-2 rounded-sm bg-surface-2 px-2 py-1.5"
  >
    <template v-if="fallbackMember">
      <span class="size-2 rounded-full" :class="dotColorClass(fallbackIndex)" />
      <span class="text-[length:var(--text-xs)] font-medium text-neutral-fg">
        {{ t('settings.modelRoute.fallbackBar', { name: providerNameOf(fallbackMember) }) }}
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
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AggregationMember, AggregationRoute, ProviderInfo } from '@taiji/shared'
import { endpointIssueKey, endpointIssueKinds, fallbackMemberOf } from './route-preview'
import { dotColorClass, issueChipClass } from './route-styles'

const props = defineProps<{
  route: AggregationRoute
  providers: ProviderInfo[]
}>()

const { t } = useI18n()

/** 兜底端点与其异常标记（求值同源 route-preview，时间轴迁移行内网格后由卡承载）。 */
const fallbackMember = computed(() => fallbackMemberOf(props.route))
const fallbackIndex = computed(() => props.route.members.findIndex((m) => m.id === fallbackMember.value?.id))
const fallbackIssueKinds = computed(() => {
  if (!fallbackMember.value) return []
  return endpointIssueKinds(props.route, props.providers).get(fallbackIndex.value) ?? []
})

function providerNameOf(member: AggregationMember): string {
  return props.providers.find((p) => p.id === member.providerId)?.name ?? member.providerId
}
</script>
