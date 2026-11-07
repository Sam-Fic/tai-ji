<template>
<!-- split-justified: 安装前版本选择段（自持数据组件）——挂载即拉取版本列表，选中与
     等待/错误态本地自治；spec 构造与两段式安装编排归 PluginProviderFlow（流程状态机
     单一持有者），版本值经 install 事件上抛（'latest' = dist-tags latest） -->
  <div data-testid="plugin-version-select" class="flex flex-col gap-3">
    <p class="text-[length:var(--text-sm)] text-neutral-fg">
      {{ props.intent === 'update'
        ? t('pluginProvider.flow.versionSelectDescUpdate', { name: props.displayName })
        : t('pluginProvider.flow.versionSelectDesc', { name: props.displayName }) }}
    </p>
    <div
      v-if="loading"
      data-testid="plugin-version-loading"
      class="flex items-center gap-2 rounded-md bg-surface p-3 text-[length:var(--text-xs)] text-neutral-mid"
    >
      <Loader2 class="size-3.5 animate-spin" />
      <span>{{ t('pluginProvider.flow.versionLoading') }}</span>
    </div>
    <Select
      v-else-if="versions"
      :model-value="selected"
      @update:model-value="onSelect"
    >
      <SelectTrigger data-testid="plugin-version-options" class="w-full" :aria-label="t('pluginProvider.flow.versionSelectLabel')">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="latest" data-testid="plugin-version-option-latest">
          {{ t('pluginProvider.flow.versionLatestOption', { version: versions.latest }) }}
        </SelectItem>
        <SelectItem
          v-for="v in versions.versions"
          :key="v"
          :value="v"
          :data-testid="`plugin-version-option-${v}`"
        >{{ v }}</SelectItem>
      </SelectContent>
    </Select>
    <p
      v-if="error || props.installError"
      data-testid="plugin-version-error"
      class="text-[length:var(--text-xs)] text-danger"
    >{{ error !== '' ? error : props.installError }}</p>
    <div class="flex justify-end gap-2">
      <Button
        variant="ghost"
        data-testid="plugin-version-cancel"
        :disabled="props.preparing"
        @click="emit('cancel')"
      >{{ t('pluginProvider.flow.cancel') }}</Button>
      <Button
        variant="default"
        data-testid="plugin-version-install-btn"
        :disabled="loading || versions === null || selected === '' || props.preparing"
        @click="emit('install', selected)"
      >
        <Loader2 v-if="props.preparing" class="size-3.5 animate-spin" />
        {{ props.intent === 'update' ? t('pluginProvider.flow.confirmUpdate') : t('pluginProvider.flow.confirmInstall') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * PluginVersionSelect —— 安装前版本选择（自持数据）。
 *
 * 挂载即经 resolvePluginInstallPort 拉取该包全部已发布版本（plugin.listVersions），
 * 等待/错误态本地呈现；选中态默认 'latest'（latest 不在列表的异常形态回落列表首位）。
 * spec 构造（latest → 裸包名）与两段式安装归父组件，版本值经 install 事件上抛。
 * 父侧在进入本段前已判定 port 挂载了 listPluginVersions（旧 runtime 回退直装）。
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { resolvePluginInstallPort, type PluginVersionList } from './PluginProviderSource'

const props = defineProps<{
  packageName: string
  displayName: string
  intent: 'install' | 'update'
  preparing: boolean
  /** 父侧安装失败错误（prepare reject 等；本段发起的安装失败回落本段展示，可改选重试） */
  installError: string
}>()

const emit = defineEmits<{
  cancel: []
  /** version = 'latest'（dist-tag）或显式版本串 */
  install: [version: string]
}>()

const { t } = useI18n()

const versions = ref<PluginVersionList | null>(null)
const loading = ref(true)
const error = ref('')
const selected = ref('latest')

onMounted(async () => {
  const port = resolvePluginInstallPort()
  const listVersions = port?.listPluginVersions
  if (listVersions === undefined) {
    // 结构性缺口（父侧已判定过，防御兜底）：呈错误不静默
    loading.value = false
    error.value = t('pluginProvider.flow.channelUnavailable')
    return
  }
  try {
    const result = await listVersions(props.packageName)
    versions.value = result
    // latest 不在版本列表（异常形态）时选中态回落到列表首位
    if (result.versions.length > 0 && !result.versions.includes(result.latest)) {
      selected.value = result.versions[0]
    }
  } catch (e) {
    // 拉取失败停留本段呈错误（重进可重试），不自动降级直装
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

// reka Select 的 update:modelValue payload 是宽联合（AcceptableValue），先运行时检查收窄
function onSelect(value: unknown): void {
  if (typeof value !== 'string') return
  selected.value = value
}
</script>
