<!--
  RouteUnsavedBar —— 两页共享未保存状态条（provider-aggregation U5b · spec §9.1 接缝归属本单元）。

  「两页共享」形态：本组件是纯展示/指令条（dirty 进、save/discard 出），供应商接入页（U5a）
  与模型路由页挂同一份编辑态时复用同型实例——共享语义由上层挂载点保证（两页一份数据，
  spec §4.1），组件本身零页面知识。

  显隐用 v-show 而非 v-if：消费方（含测试）可恒定定位本组件读 dirty 态，条目出现/消失
  只是可见性切换（spec §9.1「任一页有改动都会出现」），无挂载成本差异。
-->
<template>
  <div
    v-show="dirty"
    data-testid="route-unsaved-bar"
    class="sticky bottom-0 z-10 mt-3 flex items-center gap-3 rounded-md border border-border bg-bg-elevated px-4 py-2 shadow-1"
    role="status"
  >
    <span class="flex-1 text-[length:var(--text-xs)] text-neutral-fg">
      {{ t('settings.modelRoute.unsavedText') }}
    </span>
    <Button variant="secondary" size="dense" data-testid="unsaved-discard" @click="emit('discard')">
      {{ t('settings.modelRoute.discard') }}
    </Button>
    <Button size="dense" data-testid="unsaved-save" @click="emit('save')">
      {{ t('settings.modelRoute.save') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@taiji/ui'

defineProps<{ dirty: boolean }>()

const emit = defineEmits<{ save: []; discard: [] }>()

const { t } = useI18n()
</script>
