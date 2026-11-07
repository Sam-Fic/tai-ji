<!--
  RouteSpecialDates —— 特殊日期双型编辑器（provider-aggregation U5b · D13 / spec §7.10）。

  双型：exclude 该日全天判窗外 / include 仅指定起止区间判窗内（区间外回落周表）。
  条目就地修改 route.specials（编辑器草稿语义），change 通知标脏。同一日期允许多条
  覆盖（求值取第一条匹配——spec 已知限制，去重合并留实施期）。
-->
<template>
  <div data-testid="route-special-dates" class="mt-4 rounded-md border border-border bg-bg-card p-3">
    <div class="flex items-baseline gap-2">
      <span class="text-[length:var(--text-xs)] font-medium text-neutral-fg">{{ t('settings.modelRoute.specialsTitle') }}</span>
    </div>

    <!-- 已有覆盖列表 -->
    <div v-if="route.specials.length" class="mt-2 flex flex-col gap-1">
      <div
        v-for="(sp, idx) in route.specials"
        :key="sp.id"
        data-testid="special-row"
        class="flex items-center gap-2 rounded-sm bg-surface-2 px-2 py-1.5"
      >
        <span class="font-mono text-[length:var(--text-xs)] text-neutral-fg">{{ sp.date }}</span>
        <span
          v-if="sp.mode === 'exclude'"
          class="rounded-sm bg-warn-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] text-warn"
        >
          {{ t('settings.modelRoute.specialExclude') }}
        </span>
        <span
          v-else
          class="rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-[length:var(--text-3xs)] text-accent"
        >
          {{ t('settings.modelRoute.specialInclude') }} {{ sp.from }}–{{ sp.to }}
        </span>
        <Button
          variant="ghost"
          size="icon"
          class="ml-auto size-6 rounded-sm p-0 text-danger hover:bg-danger-soft"
          :aria-label="t('settings.modelRoute.remove')"
          :data-testid="`special-remove-${idx}`"
          @click="removeSpecial(idx)"
        >
          <Trash2 class="size-3.5" />
        </Button>
      </div>
    </div>
    <div v-else class="mt-2 text-[length:var(--text-2xs)] text-neutral-dim">
      {{ t('settings.modelRoute.specialsEmpty') }}
    </div>

    <!-- 新增行 -->
    <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <Label :for="dateInputId" class="text-[length:var(--text-2xs)] text-neutral-mid">
        {{ t('settings.modelRoute.specialDate') }}
      </Label>
      <Input
        :id="dateInputId"
        v-model="draftDate"
        type="date"
        data-testid="special-date-input"
        class="h-8 w-36 text-[length:var(--text-xs)]"
      />
      <div class="flex items-center gap-1">
        <Button
          variant="secondary"
          size="dense"
          :aria-pressed="draftMode === 'exclude'"
          data-testid="special-mode-exclude"
          @click="draftMode = 'exclude'"
        >
          {{ t('settings.modelRoute.specialExclude') }}
        </Button>
        <Button
          variant="secondary"
          size="dense"
          :aria-pressed="draftMode === 'include'"
          data-testid="special-mode-include"
          @click="draftMode = 'include'"
        >
          {{ t('settings.modelRoute.specialInclude') }}
        </Button>
      </div>
      <template v-if="draftMode === 'include'">
        <Input
          v-model="draftFrom"
          type="time"
          data-testid="special-from-input"
          class="h-8 w-24 font-mono text-[length:var(--text-xs)]"
          :aria-label="t('settings.modelRoute.specialFrom')"
        />
        <span class="text-[length:var(--text-xs)] text-neutral-dim">–</span>
        <Input
          v-model="draftTo"
          type="time"
          data-testid="special-to-input"
          class="h-8 w-24 font-mono text-[length:var(--text-xs)]"
          :aria-label="t('settings.modelRoute.specialTo')"
        />
      </template>
      <Button size="dense" data-testid="special-add-btn" @click="addSpecial">
        {{ t('settings.modelRoute.specialAdd') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2 } from '@lucide/vue'
import { Button, Input, Label } from '@taiji/ui'
import type { AggregationRoute, AggregationSpecialDate } from '@taiji/shared'
import type { RouteEditorOp } from './route-editor-ops'
import { useSettingsToast } from '../injection-keys'

const props = defineProps<{ route: AggregationRoute }>()

const emit = defineEmits<{ op: [op: RouteEditorOp] }>()

const { t } = useI18n()
const toast = useSettingsToast()

/** 新增行草稿态（spec §7.10 缺省：日期 2026-12-24 / include 起止 10:00-12:00）。 */
const draftDate = ref('2026-12-24')
const draftMode = ref<'exclude' | 'include'>('exclude')
const draftFrom = ref('10:00')
const draftTo = ref('12:00')

const dateInputId = useId()

/** 特殊日期临时 id 短码的数字基数（与端点 id 同款，紧凑短码）。 */
const ID_RADIX = 36

let specialSeq = 0
function nextSpecialId(): string {
  specialSeq += 1
  return `sp-${Date.now().toString(ID_RADIX)}-${specialSeq}`
}

function addSpecial(): void {
  const date = draftDate.value.trim()
  if (date === '') {
    toast.error(t('settings.modelRoute.specialNeedDate'))
    return
  }
  if (draftMode.value === 'include') {
    // include 必填起止（shared aggregation.ts include 校验同源语义：起 < 止且同日）
    if (draftFrom.value === '' || draftTo.value === '' || draftFrom.value >= draftTo.value) {
      toast.error(t('settings.modelRoute.specialNeedRange'))
      return
    }
  }
  const entry: AggregationSpecialDate =
    draftMode.value === 'exclude'
      ? { id: nextSpecialId(), date, mode: 'exclude' } // exclude 全天判窗外：起止字段省略（schema 语义）
      : { id: nextSpecialId(), date, mode: 'include', from: draftFrom.value, to: draftTo.value }
  emit('op', { kind: 'special-add', routeId: props.route.id, special: entry })
}

function removeSpecial(index: number): void {
  emit('op', { kind: 'special-remove', routeId: props.route.id, index })
}
</script>
