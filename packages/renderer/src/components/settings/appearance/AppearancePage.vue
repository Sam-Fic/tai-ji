<template>
  <!--
    Settings · 外观菜单页（v6 §6.4 + §5.8）。
    聚合系统级外观偏好：外观模式（light/dark/system）、太极配色、全局字号（D17），
    以及分区字号（sidebar/chat/drawer 档位 + 终端 px，后者与 TerminalPage 同一 config SSOT）。
    尾部保留 Token 读值（原 TokenDebugPage 调试能力的留存量产部分）；
    原调试用的主题/字号即时覆盖已由本页持久化控件取代，不再保留。
    [w2] demo 对照（AppearanceSection.vue）：首卡 = 无卡头单卡 6 行（外观模式/字体大小/
    左侧边栏/对话流/侧边抽屉/终端，gcard-body tight）；配色主题卡头 = gc-title + gc-sub，
    主题行 = btn ghost 全宽（px 10px py 8px）+ 16px check 占位（选中 accent 对勾）+
    inset 1px border-strong 环 + hover 底 + fg 字（P0-5 选中范式，三键无外描边；
    未选中行 hover 同步底字双提亮 = demo .btn.ghost:hover）+ 12px 圆点 swatch gap 4px；
    Token 行 = min-h 36 / px 6px / border-t hairline + mono text-xs + 14px 色块（仅色值）。
    卡间距靠 GroupCard 相邻 margin（16px）。
  -->
  <div class="flex flex-col">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.appearance') }}</h1>
        <p class="desc">{{ t('settings.menu.appearanceDesc') }}</p>
      </div>
    </header>

    <!-- 外观模式 + 全局字号 + 分区字号（demo：单张无卡头卡 6 行） -->
    <GroupCard>
      <div class="px-[10px] pt-[4px] pb-[8px]">
        <SettingRow :label="t('settings.system.appearance')" :desc="t('settings.system.appearanceDesc')">
          <!-- 外观模式 segmented 平铺：三值域封闭，比 Select 少一层浮层；
               视觉同 sidebar SegmentedTab 范式（凹陷槽 bg-bg-input + active 浮起）。
               点击仍走 onThemeSelect 运行时检查（isThemeMode 收窄后才 emit），非模板 as 断言。 -->
          <div class="flex w-[200px] gap-0.5 rounded-lg bg-bg-input p-[3px]" data-testid="appearance-mode-seg">
            <Button
              v-for="m in THEME_MODES"
              :key="m"
              variant="ghost"
              type="button"
              class="h-7 flex-1 justify-center rounded-sm px-1 text-[length:var(--text-xs)]"
              :class="(system.theme ?? 'dark') === m
                ? 'bg-surface-hover text-neutral-fg hover:bg-surface-hover hover:text-neutral-fg'
                : 'text-neutral-mid hover:bg-transparent hover:text-neutral-fg'"
              :data-testid="`appearance-mode-${m}`"
              :aria-pressed="(system.theme ?? 'dark') === m"
              @click="onThemeSelect(m)"
            >
              {{ t(m === 'light' ? 'settings.system.themeLight' : m === 'dark' ? 'settings.system.themeDark' : 'settings.system.themeSystem') }}
            </Button>
          </div>
        </SettingRow>
        <SettingRow :label="t('settings.system.fontSize')" :desc="t('settings.system.fontSizeDesc')">
          <!-- 全局字号 segmented：三档值域封闭，同上范式；点击走 onFontSizeSelect 运行时检查。 -->
          <div class="flex w-[200px] gap-0.5 rounded-lg bg-bg-input p-[3px]" data-testid="appearance-fs-global-seg">
            <Button
              v-for="fs in FONT_SIZE_OPTIONS"
              :key="fs"
              variant="ghost"
              type="button"
              class="h-7 flex-1 justify-center rounded-sm px-1 text-[length:var(--text-xs)]"
              :class="(system.fontSize ?? 'medium') === fs
                ? 'bg-surface-hover text-neutral-fg hover:bg-surface-hover hover:text-neutral-fg'
                : 'text-neutral-mid hover:bg-transparent hover:text-neutral-fg'"
              :data-testid="`appearance-fs-global-${fs}`"
              :aria-pressed="(system.fontSize ?? 'medium') === fs"
              @click="onFontSizeSelect(fs)"
            >
              {{ t(fs === 'small' ? 'settings.system.fontSmall' : fs === 'medium' ? 'settings.system.fontMedium' : 'settings.system.fontLarge') }}
            </Button>
          </div>
        </SettingRow>
        <SettingRow
          v-for="region in FONT_REGIONS"
          :key="region.key"
          :label="t(`settings.appearance.region.${region.key}`)"
          :desc="t(region.descKey)"
        >
          <Select
            :model-value="system.fontScales?.[region.key] ?? DEFAULT_FONT_SCALES[region.key]"
            @update:model-value="onRegionScaleSelect(region.key, $event)"
          >
            <SelectTrigger class="w-[200px]" :data-testid="`appearance-fs-${region.key}-trigger`">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">{{ t('settings.appearance.tierSmall') }}</SelectItem>
              <SelectItem value="medium">{{ t('settings.appearance.tierMedium') }}</SelectItem>
              <SelectItem value="large">{{ t('settings.appearance.tierLarge') }}</SelectItem>
              <SelectItem value="xlarge">{{ t('settings.appearance.tierXLarge') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow :label="t('settings.appearance.region.terminal')" :desc="t('settings.appearance.terminalFontDesc')">
          <Input
            type="number"
            min="8"
            max="24"
            placeholder="14"
            class="w-[120px] font-mono"
            data-testid="appearance-terminal-font-size-input"
            :disabled="terminalLoading"
            :model-value="terminalFontSize"
            @update:model-value="onTerminalFontSize"
            @blur="saveTerminalFontSize"
          />
        </SettingRow>
      </div>
    </GroupCard>

    <SettingsFontsSection
      :entries="fontEntries"
      :library="fontLibrary"
      :ui-family="system.fonts?.ui"
      :mono-family="system.fonts?.mono"
      :terminal-family="terminalFontFamily"
      :loading="fontListLoading"
      :busy="fontActionBusy"
      :replay-state="fontReplayState"
      :replay-failures="fontReplayFailures"
      :import-selection="fontImportSelection"
      @select="onFontSelect"
      @pick-import="pickFontImport"
      @confirm-import="confirmFontImport"
      @cancel-import="fontImportSelection = null"
      @remove="removeImportedFont"
    />

    <!-- 配色主题（太极 · 即时切换；demo：卡头 gc-sub + 全宽 ghost 行 + check/inset 环选中范式） -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.system.themePresetTitle') }}</h3>
          <p class="gc-sub">{{ t('settings.system.themePresetHint') }}</p>
        </div>
      </template>
      <div class="flex flex-col px-[10px] pt-[4px] pb-[8px]">
        <Button
          v-for="th in TAIJI_THEMES"
          :key="th.label"
          variant="ghost"
          type="button"
          class="theme-row flex h-[32px] w-full cursor-pointer items-center justify-between rounded-md px-[10px] py-[8px] text-[length:var(--text-sm)] [font-weight:var(--fw-mid)] transition-colors"
          :class="th.label === currentTheme.label
            ? 'bg-surface-hover text-neutral-fg shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-surface-hover'
            : 'text-neutral-mid hover:text-neutral-fg'"
          :aria-pressed="th.label === currentTheme.label"
          :data-testid="`appearance-theme-${th.preset || th.theme}`"
          @click="applyTaijiTheme(th)"
        >
          <span class="inline-flex min-w-0 items-center gap-[6px]">
            <!-- P0-5：选中持久标记（accent 对勾），与瞬态键盘焦点（outline 内缩环，壳同款）
                 拉开；16px 固定占位保证未选中行文字对齐不跳动（demo 同款） -->
            <span class="flex size-[16px] flex-none items-center justify-center">
              <Check v-if="th.label === currentTheme.label" class="size-[14px] text-accent" />
            </span>
            <span class="truncate">{{ th.label }}</span>
          </span>
          <span class="flex gap-[4px]">
            <span
              v-for="(c, i) in th.swatch"
              :key="i"
              class="size-[12px] rounded-full"
              :style="{ background: c }"
            />
          </span>
        </Button>
      </div>
    </GroupCard>

    <!-- Token 读值（getComputedStyle 读 :root，反映当前主题/字号实际渲染值；清单 = real 令牌体系） -->
    <GroupCard
      v-for="g in tokenRows"
      :key="g.titleKey"
      :title="t('settings.appearance.tokenGroup.' + g.titleKey)"
    >
      <div class="px-[10px] pt-[4px] pb-[8px]">
        <div v-for="row in g.rows" :key="row.name" class="flex min-h-[36px] items-center gap-[16px] border-t border-hairline px-[6px] py-[6px] font-mono text-[length:var(--text-xs)] first:border-t-0">
          <span class="flex-1 text-neutral-fg-2">{{ row.name }}</span>
          <span
            v-if="row.value.startsWith('#') || row.value.startsWith('rgb')"
            class="size-[14px] shrink-0 rounded-[3px] border border-border"
            :style="{ background: row.value }"
          />
          <span class="text-neutral-mid">{{ row.value || '—' }}</span>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GroupCard, SettingsFontsSection } from '@taiji/ui/features/settings'
import { useFontRegistry } from '@/features/fonts/use-font-registry'
import type { FontFileSelection } from '@/features/fonts/file-font-source'
import SettingRow from '../SettingRow.vue'
import type { SystemSettings, FontScaleTier, ThemeMode } from '@taiji/core'
import { DEFAULT_FONT_SCALES } from '@taiji/core'
import type { TerminalConfig } from '@taiji/shared'
import { TAIJI_THEMES, resolveTaijiTheme, type TaijiTheme } from '@/composables/useTaijiThemes'
import { getSettingsTransport } from '@taiji/core'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  system: SystemSettings
  /** 壳激活信号（SettingsModal v-show 常挂载形态独有）：false→true = 切回本页（重新拉取终端
   *  配置 + 刷新 token 读值快照），true→false = 切出（失焦兜底保存终端字号输入）。缺省
   *  （undefined，测试/独立宿主直挂）不参与信号，行为同旧版。 */
  isActive?: boolean
}>()

const emit = defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

// ── Select payload 运行时检查 ──
// reka Select 的 update:modelValue payload 是宽联合（AcceptableValue），先运行时检查收窄
// 再 emit（对齐 ModelListSection onCtxSelect/onStrategySelect 的 unknown+guard 范式），
// 不用模板 as 断言把非法 payload 直接放行。成员校验用 some 严格相等比较，不做强转。
const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']
const FONT_SIZE_OPTIONS: readonly NonNullable<SystemSettings['fontSize']>[] = ['small', 'medium', 'large']
const FONT_SCALE_TIERS: readonly FontScaleTier[] = ['small', 'medium', 'large', 'xlarge']

function isThemeMode(v: unknown): v is ThemeMode {
  return typeof v === 'string' && THEME_MODES.some((m) => m === v)
}

function isFontSize(v: unknown): v is NonNullable<SystemSettings['fontSize']> {
  return typeof v === 'string' && FONT_SIZE_OPTIONS.some((o) => o === v)
}

function isFontScaleTier(v: unknown): v is FontScaleTier {
  return typeof v === 'string' && FONT_SCALE_TIERS.some((tier) => tier === v)
}

function onThemeSelect(value: unknown): void {
  if (!isThemeMode(value)) return
  emit('update', { theme: value })
}

function onFontSizeSelect(value: unknown): void {
  if (!isFontSize(value)) return
  emit('update', { fontSize: value })
}

function onRegionScaleSelect(region: 'sidebar' | 'chat' | 'drawer', value: unknown): void {
  if (!isFontScaleTier(value)) return
  onRegionScale(region, value)
}

// ── 太极主题（即时切换：写 store + 同步 DOM） ──
const currentTheme = computed<TaijiTheme>(() => resolveTaijiTheme(props.system))
function applyTaijiTheme(th: TaijiTheme): void {
  emit('update', { theme: th.theme, themePreset: th.preset })
}

// ── 分区字号（setSystem 浅合并，须回传完整 fontScales 对象）──
// 显示回落逐区域取 DEFAULT_FONT_SCALES（SSOT，三区域均 medium），不写死档位字面量。
const FONT_REGIONS = [
  { key: 'sidebar', descKey: 'settings.appearance.regionSidebarDesc' },
  { key: 'chat', descKey: 'settings.appearance.regionChatDesc' },
  { key: 'drawer', descKey: 'settings.appearance.regionDrawerDesc' },
] as const

function onRegionScale(region: 'sidebar' | 'chat' | 'drawer', tier: FontScaleTier): void {
  emit('update', { fontScales: { ...props.system.fontScales, [region]: tier } })
}

// ── 终端字号（xterm 画布渲染不走 CSS，直接编辑 terminal config，与 TerminalPage 同一 SSOT） ──
const TERMINAL_FONT_MIN = 8
const TERMINAL_FONT_MAX = 24
const TERMINAL_FONT_DEFAULT = 14
const terminalFontSize = ref<number>(TERMINAL_FONT_DEFAULT)
const terminalLoading = ref(true)
let terminalConfig: TerminalConfig | null = null

async function loadTerminalConfig(): Promise<void> {
  try {
    const res = await getSettingsTransport().getTerminalConfig()
    terminalConfig = res.config
    terminalFontSize.value = res.config.fontSize
    terminalFontFamily.value = res.config.fontFamily
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    terminalLoading.value = false
  }
}

/**
 * 输入中仅更新本地值；blur 时写回 fontSize。
 *
 * [HISTORICAL] 不在此处回写终端字体家族：`terminalConfig` 是**本地快照**，而终端配置有
 * 三个写者（TerminalPage 整对象保存 / 本页字号 / 字体卡片第三行字体）。用旧快照
 * `{ ...terminalConfig, fontSize }` 整对象写回，会把别处刚写好的 `fontFamily` 覆盖回旧值
 * （字体系统 D7 登记的三写者 RMW 风险）。现在的做法：**先读当前完整 config 再 patch**，
 * 只改自己负责的字段。
 */
async function saveTerminalFontSize(): Promise<void> {
  const size = Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(Number(terminalFontSize.value) || TERMINAL_FONT_DEFAULT)))
  if (!terminalConfig) return
  try {
    const current = (await getSettingsTransport().getTerminalConfig()).config
    terminalConfig = current
    terminalFontFamily.value = current.fontFamily
    if (size === current.fontSize) return
    await getSettingsTransport().setTerminalConfig({ ...current, fontSize: size })
    terminalConfig = { ...current, fontSize: size }
    terminalFontSize.value = size
    toastInfo(t('settings.appearance.terminalFontSaved'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

function onTerminalFontSize(v: string | number): void {
  terminalFontSize.value = Number(v)
}

// ── 字体来源与三槽位选择（ui/mono 写 SystemSettings，terminal 写 TerminalConfig）──
const fontRegistry = useFontRegistry()
const fontEntries = fontRegistry.entries
const fontReplayState = fontRegistry.replayState
const fontReplayFailures = fontRegistry.replayFailures
const fontLibrary = computed(() => props.system.fontLibrary ?? [])
const fontListLoading = ref(true)
const fontActionBusy = ref(false)
const fontImportSelection = ref<FontFileSelection | null>(null)
const terminalFontFamily = ref('')

async function loadFontList(): Promise<void> {
  fontListLoading.value = true
  try {
    await fontRegistry.list()
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    fontListLoading.value = false
  }
}

function onFontSelect(payload: { slot: 'ui' | 'mono' | 'terminal'; family: string }): void {
  const { slot, family } = payload
  if (slot === 'terminal') {
    void saveTerminalFontFamily(family)
    return
  }
  const fonts = { ...props.system.fonts }
  if (family) fonts[slot] = family
  else delete fonts[slot]
  emit('update', { fonts })
}

async function pickFontImport(): Promise<void> {
  if (fontActionBusy.value) return
  fontActionBusy.value = true
  try {
    fontImportSelection.value = await fontRegistry.pickFontFile()
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    fontActionBusy.value = false
  }
}

async function confirmFontImport(payload: { path: string; family: string }): Promise<void> {
  if (fontActionBusy.value) return
  fontActionBusy.value = true
  try {
    const entry = await fontRegistry.importFont(payload.path, payload.family)
    fontImportSelection.value = null
    toastInfo(t('settings.fonts.importedToast', { family: entry.family }))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    fontActionBusy.value = false
  }
}

async function removeImportedFont(family: string): Promise<void> {
  if (fontActionBusy.value) return
  fontActionBusy.value = true
  try {
    await fontRegistry.removeImportedFont(family)
    toastInfo(t('settings.fonts.removedToast', { family }))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    fontActionBusy.value = false
  }
}

/** 终端字体独立写 TerminalConfig.fontFamily；同字号路径一样先读当前完整配置。 */
async function saveTerminalFontFamily(family: string): Promise<void> {
  if (fontActionBusy.value) return
  fontActionBusy.value = true
  try {
    const current = (await getSettingsTransport().getTerminalConfig()).config
    terminalConfig = current
    terminalFontFamily.value = current.fontFamily
    if (current.fontFamily === family) return
    await getSettingsTransport().setTerminalConfig({ ...current, fontFamily: family })
    terminalConfig = { ...current, fontFamily: family }
    terminalFontFamily.value = family
    toastInfo(t('settings.fonts.terminalSaved'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    fontActionBusy.value = false
  }
}

// ── Token 读值（getComputedStyle 读 :root 实际渲染值；主题切换后由 watch 刷新） ──
const TOKEN_GROUPS = [
  { titleKey: 'bg', tokens: ['--bg', '--bg-sunken', '--surface', '--surface-hover', '--surface-2', '--bg-elevated', '--bg-input', '--bg-card'] },
  { titleKey: 'text', tokens: ['--neutral-fg', '--neutral-mid', '--neutral-dim', '--neutral-faint', '--neutral-ico'] },
  { titleKey: 'accent', tokens: ['--accent', '--accent-hover', '--accent-fg', '--success', '--warn', '--danger', '--info', '--reasoning'] },
  { titleKey: 'border', tokens: ['--border', '--border-strong', '--hairline'] },
  { titleKey: 'misc', tokens: ['--radius-sm', '--radius', '--radius-card', '--radius-lg', '--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8'] },
]
const tokenValues = ref<Record<string, string>>({})

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function refreshTokens(): void {
  const out: Record<string, string> = {}
  for (const g of TOKEN_GROUPS) for (const tk of g.tokens) out[tk] = readToken(tk)
  tokenValues.value = out
}

const tokenRows = computed(() =>
  TOKEN_GROUPS.map((g) => ({
    titleKey: g.titleKey,
    rows: g.tokens.map((tk) => ({ name: tk, value: tokenValues.value[tk] ?? '' })),
  })),
)

// 主题/预设/字号变化 → token 实际值变化；DOM 属性由壳层 useSettingsShell 同步，rAF 后读到新值
watch(
  () => [props.system.theme, props.system.themePreset, props.system.fontSize, props.system.fontScales],
  () => requestAnimationFrame(refreshTokens),
)
onMounted(() => {
  void loadTerminalConfig()
  void loadFontList()
  refreshTokens()
  window.addEventListener('resize', refreshTokens)
})

// 壳激活信号（v-show 常挂载形态）：切回重新拉取终端配置（终端分区与本页共用 TerminalConfig
// SSOT，双向同步）+ 刷新 token 读值快照；切出即失焦兜底保存未落盘的终端字号输入
// （saveTerminalFontSize 同值短路，不产生多余写入）。
watch(() => props.isActive, (now, prev) => {
  if (prev === undefined) return
  if (now) {
    void loadTerminalConfig()
    void loadFontList()
    refreshTokens()
  } else {
    void saveTerminalFontSize()
  }
})
onUnmounted(() => {
  window.removeEventListener('resize', refreshTokens)
  // 终端字号失焦兜底：直接卸载（如关闭设置）时保存未落盘的输入
  void saveTerminalFontSize()
})
</script>
