<template>
  <GroupCard>
    <template #head>
      <div class="gc-head-text">
        <h3 class="gc-title">{{ t('settings.fonts.title') }}</h3>
      </div>
    </template>
    <template #actions>
      <span v-if="loading" class="text-[length:var(--text-xs)] text-neutral-mid">
        {{ t('settings.fonts.loading') }}
      </span>
      <Button
        variant="ghost"
        class="h-7 gap-1.5 px-2 text-[length:var(--text-xs)]"
        :disabled="busy"
        data-testid="settings-font-import"
        @click="emit('pick-import')"
      >
        <Upload class="size-3.5" />
        {{ t('settings.fonts.import') }}
      </Button>
    </template>

    <div class="px-[10px] pt-[4px] pb-[8px]">
      <div
        v-for="slot in SLOTS"
        :key="slot.key"
        class="flex min-h-[44px] items-center gap-[16px] border-t border-hairline px-[6px] py-[10px] first:border-t-0"
      >
        <div class="min-w-0 flex-1">
          <div class="text-[length:var(--text-base)] font-semibold text-neutral-fg">{{ t(slot.labelKey) }}</div>
          <p class="setting-row-desc mt-0.5 text-[length:var(--text-sm)] text-neutral-mid">{{ t(slot.descKey) }}</p>
        </div>
        <Popover :open="openSlot === slot.key" @update:open="onPopoverOpen(slot.key, $event)">
          <PopoverTriggerButton
            :open="openSlot === slot.key"
            class="w-[220px] justify-between"
            :disabled="busy"
            :data-testid="`settings-font-${slot.key}-trigger`"
          >
            <span class="min-w-0 truncate">{{ selectedLabel(slot.key) }}</span>
          </PopoverTriggerButton>
          <PopoverContent align="end" class="w-[300px] p-1">
            <div class="p-1">
              <Input
                v-model="query"
                :placeholder="t('settings.fonts.searchPlaceholder')"
                class="h-8"
                data-testid="settings-font-search"
              />
            </div>
            <div class="max-h-[240px] overflow-y-auto overscroll-contain">
              <Button
                variant="ghost"
                class="h-auto w-full justify-start rounded-sm px-2.5 py-1.5 text-left text-[length:var(--text-sm)]"
                :disabled="busy"
                :data-testid="`settings-font-${slot.key}-default`"
                @click="selectFamily(slot.key, '')"
              >
                {{ defaultLabel(slot.key) }}
              </Button>
              <Button
                v-for="entry in filteredEntries"
                :key="`${entry.source}:${entry.family}`"
                variant="ghost"
                class="h-auto w-full justify-start rounded-sm px-2.5 py-1.5 text-left text-[length:var(--text-sm)]"
                :disabled="busy"
                :data-testid="`settings-font-${slot.key}-option-${entry.family}`"
                @click="selectFamily(slot.key, entry.family)"
              >
                <span class="min-w-0 flex-1 truncate">{{ entry.family }}</span>
                <span
                  v-if="entry.source === 'file'"
                  class="ml-2 shrink-0 text-[length:var(--text-xs)] text-neutral-dim"
                >
                  {{ t('settings.fonts.importedHint') }}
                </span>
              </Button>
              <p
                v-if="filteredEntries.length === 0"
                class="px-2.5 py-1.5 text-[length:var(--text-sm)] text-neutral-dim"
                data-testid="settings-font-empty"
              >
                {{ t('settings.fonts.empty') }}
              </p>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <!-- 系统字体列表为空：不区分「本机无字体」与「权限被拒」（探针实测两者都返回空数组） -->
      <p
        v-if="systemListEmpty"
        class="px-2 py-2 text-[length:var(--text-xs)] text-neutral-dim"
        data-testid="settings-font-permission-hint"
      >
        {{ t('settings.fonts.systemEmpty') }}
      </p>

      <!-- 已导入字体：重放未完成时显「正在恢复」，完成后才显失败原因 -->
      <div v-if="sortedLibrary.length > 0" class="flex flex-col gap-1 px-2 pb-2">
        <div
          v-for="(entry, index) in sortedLibrary"
          :key="entry.family"
          class="flex items-center gap-2 text-[length:var(--text-xs)]"
          :data-testid="`settings-font-library-${index}`"
        >
          <span class="min-w-0 flex-1 truncate text-neutral-mid">{{ entry.family }}</span>
          <span class="shrink-0 text-neutral-dim">{{ statusFor(entry.family) }}</span>
          <Button
            variant="ghost"
            class="h-6 shrink-0 px-2"
            :data-testid="`settings-font-remove-${entry.family}`"
            @click="emit('remove', entry.family)"
          >
            {{ t('settings.fonts.remove') }}
          </Button>
        </div>
      </div>

      <!-- 安装指引：静态文案，taiji 不代下载（D12） -->
      <details class="px-2 pb-2" data-testid="settings-font-install-guide">
        <summary class="cursor-pointer text-[length:var(--text-xs)] text-neutral-mid">
          {{ t('settings.fonts.installHint') }} {{ t('settings.fonts.installTitle') }}
        </summary>
        <div class="mt-2 flex flex-col gap-1.5 text-[length:var(--text-xs)] text-neutral-dim">
          <p>{{ t('settings.fonts.installRestart') }}</p>
          <p>{{ t('settings.fonts.installCjk') }}</p>
          <div
            v-for="item in FONT_INSTALL_GUIDE"
            :key="item.id"
            class="flex items-center gap-2"
            :data-testid="`settings-font-install-${item.id}`"
          >
            <span class="w-20 shrink-0 text-neutral-mid">{{ t(item.labelKey) }}</span>
            <code class="min-w-0 flex-1 truncate rounded-sm bg-bg-sunken px-2 py-1 text-neutral-mid">{{ t(item.valueKey) }}</code>
            <Button
              variant="ghost"
              class="h-6 shrink-0 px-2"
              :data-testid="`settings-font-copy-${item.id}`"
              @click="copy(t(item.valueKey))"
            >
              {{ copied === t(item.valueKey) ? t('settings.fonts.copied') : t('settings.fonts.copy') }}
            </Button>
          </div>
        </div>
      </details>

      <!-- 导入确认：家族名预填文件名派生值，用户可改（不解析字体二进制 name 表） -->
      <div
        v-if="importSelection"
        class="mx-2 mb-2 flex flex-col gap-2 rounded-sm border border-hairline p-2"
        data-testid="settings-font-import-panel"
      >
        <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('settings.fonts.importTitle') }}</p>
        <Input
          v-model="importName"
          :placeholder="t('settings.fonts.importFamilyLabel')"
          class="h-8"
          data-testid="settings-font-import-name"
        />
        <div class="flex gap-2">
          <Button
            class="h-7 px-2 text-[length:var(--text-xs)]"
            :disabled="!importName.trim()"
            data-testid="settings-font-import-confirm"
            @click="confirmImport"
          >
            {{ t('settings.fonts.importConfirm') }}
          </Button>
          <Button
            variant="ghost"
            class="h-7 px-2 text-[length:var(--text-xs)]"
            data-testid="settings-font-import-cancel"
            @click="emit('cancel-import')"
          >
            {{ t('settings.fonts.importCancel') }}
          </Button>
        </div>
      </div>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
/**
 * 字体卡片（font-system U6）。
 *
 * 三行下拉：界面正文 / 代码与等宽 / 终端字体。
 * - 前两行写 `SystemSettings.fonts.ui` / `.mono`（与主题/字号同通道，经 `select` 事件回宿主）
 * - 第三行写 `TerminalConfig.fontFamily`（**另一个持久化域**）——三行彼此独立，
 *   终端行**不跟随**代码行（避免「跟随」语义再引入一套机制，D7 裁决）
 *
 * 无刷新按钮：装完字体需重启应用才出现在列表（同进程内 Chromium 的系统字体快照不变，
 * 探针实测 reload / 新窗口均无效，只有新进程可见）。
 * 无字体预览：v1 不做（无需求方）。
 *
 * 组件是叶子视图：列数据、账本、导入选择全部由宿主注入，本组件只做展示与事件上抛。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Upload } from '@lucide/vue'
import { FONT_READ_REASON_NOT_FOUND, FONT_READ_REASON_UNREADABLE } from '@taiji/shared'
import { Button, Input, Popover, PopoverContent, PopoverTriggerButton } from '@taiji/ui'
import type { FontLibraryEntry } from '@taiji/core'
import GroupCard from './common/GroupCard.vue'
import { FONT_INSTALL_GUIDE } from './font-install-guide'
import { useCopy } from '../chat/composables/useCopy'

type FontSlot = 'ui' | 'mono' | 'terminal'
interface FontOption {
  family: string
  source: 'system' | 'file'
}
interface ImportSelection {
  path: string
  suggestedFamily: string
}

const props = defineProps<{
  entries: FontOption[]
  library: FontLibraryEntry[]
  uiFamily?: string
  monoFamily?: string
  terminalFamily?: string
  loading: boolean
  busy: boolean
  replayState: 'idle' | 'replaying' | 'done'
  replayFailures: Record<string, string>
  importSelection: ImportSelection | null
}>()

const emit = defineEmits<{
  select: [payload: { slot: FontSlot; family: string }]
  'pick-import': []
  'confirm-import': [payload: { path: string; family: string }]
  'cancel-import': []
  remove: [family: string]
}>()

const { t } = useI18n()
const { copied, copy: writeClipboard } = useCopy()

const SLOTS = [
  { key: 'ui', labelKey: 'settings.fonts.ui', descKey: 'settings.fonts.uiDesc' },
  { key: 'mono', labelKey: 'settings.fonts.mono', descKey: 'settings.fonts.monoDesc' },
  { key: 'terminal', labelKey: 'settings.fonts.terminal', descKey: 'settings.fonts.terminalDesc' },
] as const

const openSlot = ref<FontSlot | null>(null)
const query = ref('')
const importName = ref('')

watch(
  () => props.importSelection,
  (selection) => {
    importName.value = selection?.suggestedFamily ?? ''
  },
  { immediate: true },
)

const filteredEntries = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return props.entries
  return props.entries.filter((entry) => entry.family.toLocaleLowerCase().includes(needle))
})

const sortedLibrary = computed(() => [...props.library].sort((a, b) => b.addedAt - a.addedAt))

const systemListEmpty = computed(
  () => !props.loading && !props.entries.some((entry) => entry.source === 'system'),
)

function selectedFamily(slot: FontSlot): string {
  if (slot === 'ui') return props.uiFamily ?? ''
  if (slot === 'mono') return props.monoFamily ?? ''
  return props.terminalFamily ?? ''
}

/**
 * 已选值不在来源层列表（D9/V4 失效标注的成员资格判据）。
 *
 * - 重放未完成时一律 false（抑制失败标注）：导入字体尚未注册进 entries，此时判成员
 *   资格会假阴性——与 statusFor 的 restoring 优先语义一致，防启动闪一次错误告警。
 * - 比对大小写不敏感（AX1 归一口径）：CSS font-family 匹配按规范不区分大小写，
 *   列表里有大小写变体即渲染仍能命中，不该标「未找到」。
 */
function isSlotValueMissing(slot: FontSlot): boolean {
  if (props.replayState !== 'done') return false
  const family = selectedFamily(slot)
  if (!family) return false
  return !props.entries.some((entry) => entry.family.toLowerCase() === family.toLowerCase())
}

function defaultLabel(slot: FontSlot): string {
  return t(slot === 'terminal' ? 'settings.fonts.defaultTerminal' : 'settings.fonts.default')
}

function selectedLabel(slot: FontSlot): string {
  const family = selectedFamily(slot)
  if (!family) return defaultLabel(slot)
  // D9/V4：失效值旁加「未找到」标注，不修改用户存储的值（重装字体后自动恢复）。
  return isSlotValueMissing(slot) ? `${family}${t('settings.fonts.slotValueMissing')}` : family
}

function onPopoverOpen(slot: FontSlot, open: boolean): void {
  if (open) {
    openSlot.value = slot
    query.value = ''
  } else if (openSlot.value === slot) {
    openSlot.value = null
  }
}

function selectFamily(slot: FontSlot, family: string): void {
  emit('select', { slot, family })
  openSlot.value = null
}

function confirmImport(): void {
  const selection = props.importSelection
  const family = importName.value.trim()
  if (!selection || !family) return
  emit('confirm-import', { path: selection.path, family })
}

/**
 * 条目状态文案。
 * 重放未完成时一律显「正在恢复」——不能显示失败态，否则每次启动都会闪一次错误告警。
 */
function statusFor(family: string): string {
  if (props.replayState !== 'done') return t('settings.fonts.restoring')
  const reason = props.replayFailures[family]
  // 重放失效的两类已知 reason 走双侧共享常量（@taiji/shared FONT_READ_REASON_*，
  // 与 main 侧同源）转 locale；未命中映射的 reason 经 restoreFailed 透传原文——
  // main 新增 reason 时须同步扩展此处映射，否则 en-US 用户看到中文原文。
  if (reason === FONT_READ_REASON_NOT_FOUND) return t('settings.fonts.sourceMissing')
  if (reason === FONT_READ_REASON_UNREADABLE) return t('settings.fonts.sourceUnreadable')
  return reason ? t('settings.fonts.restoreFailed', { reason }) : ''
}

/** 安装指引复制：反馈态走全仓 useCopy 范式（copied 1200ms 回落，文案 settings.fonts.copied）。 */
function copy(text: string): void {
  writeClipboard(text, text)
}
</script>
