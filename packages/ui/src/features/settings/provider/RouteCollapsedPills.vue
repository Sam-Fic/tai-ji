<!--
  RouteCollapsedPills —— 路由卡收起态端点 pill 摘要（provider-aggregation spec §7.3）。
  从 RouteCard 拆出（模板圈复杂度治理，行为/视觉不变）：序号色点 + 渠道名 pill，
  点击 pill 上抛 expand（父级展开该卡）；无端点时占位文案。
-->
<template>
  <div class="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-2">
    <Button
      v-for="(member, idx) in route.members"
      :key="member.id"
      variant="secondary"
      size="dense"
      class="gap-1 rounded-full"
      data-testid="route-card-pill"
      @click="emit('expand')"
    >
      <span class="size-1.5 rounded-full" :class="dotColorClass(idx)" />
      {{ idx + 1 }}. {{ providerNameOf(member) }}
    </Button>
    <span v-if="route.members.length === 0" class="text-[length:var(--text-2xs)] text-neutral-dim">
      {{ t('settings.modelRoute.noEndpoints') }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@taiji/ui'
import type { AggregationMember, AggregationRoute, ProviderInfo } from '@taiji/shared'
import { dotColorClass } from './route-styles'

const props = defineProps<{
  route: AggregationRoute
  providers: ProviderInfo[]
}>()

const emit = defineEmits<{ expand: [] }>()

const { t } = useI18n()

function providerNameOf(member: AggregationMember): string {
  return props.providers.find((p) => p.id === member.providerId)?.name ?? member.providerId
}
</script>
