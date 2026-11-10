<template>
<!-- split-justified: 插件 Provider 接入流程单一语义域（family/confirm/authorize 三段状态机 + S13 崩溃态重启 + U2 挂载位清理 + 两段式安装停点——围绕同一流程状态机的编排，数据源已拆 PluginProviderSource；崩溃/重启/清理依赖流程局部状态，拆出即转发壳） -->
  <!--
    插件 Provider 接入流程（provider-plugin-access 设计 U6 / D1/D2/D3/D5）。
    四段视图（显式 phase 状态机：family → version → confirm → authorize）：
      ① family 家族卡网格：清单 family 条目（名称/厂商/授权方式/模型数/安装状态），
         S1；已装家族插件崩溃时呈「插件已停止」+ 重启按钮（S13，plugin.toggle off/on）；
      ①-b version 版本选择：npm 全部已发布版本下拉（plugin.listVersions），默认最新
         dist-tag，可改选历史版本（最新走裸包名 spec，显式版本 pkg@version）；
      ② confirm 安装确认卡：preparePluginInstall 回包知情面全量展示（capabilities/
         readPaths 逐项），展示物 = 暂存解压物 manifest（同源），S27——确认前不落盘
        （取消/关闭 = cancelPluginInstall 清暂存）；
      ③ authorize 授权挂载位容器：ViewHost(global:provider.authorize) 渲染插件推的树，
         重新授权复用同一挂载位（D5，focus intent=authorize 直达本段）。进入本段即
         invoke getAuthorizeView 驱动插件推初始树（快照 store 只存插件推送内容，无宿主
         驱动则初始树无生产者、容器恒占位空态）。
  -->
  <Dialog :open="open" @update:open="onDialogToggle">
    <DialogContent data-testid="plugin-provider-flow" class="max-w-[720px]">
      <DialogHeader>
        <DialogTitle>{{ dialogTitle }}</DialogTitle>
        <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ dialogSubtitle }}</p>
      </DialogHeader>

      <!-- ① 家族卡网格 -->
      <div v-if="phase === 'family'" data-testid="plugin-family-grid" class="flex flex-col gap-2">
        <p
          v-if="flowError"
          data-testid="plugin-flow-error"
          class="text-[length:var(--text-xs)] text-danger"
        >{{ flowError }}</p>
        <div
          v-if="preparing"
          data-testid="plugin-install-preparing"
          class="flex items-center gap-2 rounded-md bg-surface p-3 text-[length:var(--text-xs)] text-neutral-mid"
        >
          <Loader2 class="size-3.5 animate-spin" />
          <span>{{ installIntent === 'update' ? t('pluginProvider.flow.preparingUpdate') : t('pluginProvider.flow.preparingInstall') }}</span>
        </div>
        <div
          v-for="entry in familyEntries"
          :key="entry.pluginId"
          data-testid="plugin-family-card"
          class="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-bg-card p-3 hover:border-accent hover:bg-surface-2"
          :class="{ 'pointer-events-none opacity-60': preparing || activatingPluginId !== null }"
          role="button"
          :aria-label="entry.family?.displayName"
          :aria-disabled="preparing"
          @click="onFamilySelect(entry)"
        >
          <span
            class="grid size-9 shrink-0 place-items-center rounded-sm bg-accent text-[length:var(--text-base)] font-bold text-accent-fg"
          >{{ familyAvatarChar(entry) }}</span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="truncate text-[length:var(--text-sm)] font-semibold text-neutral-fg">{{ entry.family?.displayName }}</span>
              <span class="shrink-0 text-[length:var(--text-3xs)] text-neutral-mid">{{ entry.family?.vendor }}</span>
              <span
                v-if="entry.installed"
                data-testid="plugin-family-installed"
                class="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] font-medium text-accent"
              >{{ t('pluginProvider.flow.installedBadge') }}</span>
              <!-- 激活中标记（已装未激活卡点击后的激活段；审批门等待期覆盖此处） -->
              <span
                v-if="activatingPluginId === entry.pluginId"
                data-testid="plugin-family-activating"
                class="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] font-medium text-accent"
              >{{ t('pluginProvider.flow.activating') }}</span>
            </span>
            <span class="mt-0.5 flex items-center gap-2 text-[length:var(--text-3xs)] text-neutral-mid">
              <span>{{ credentialSourceLabel(entry.family?.credentialSource) }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ t('pluginProvider.flow.modelCount', { count: entry.family?.modelCount ?? 0 }) }}</span>
              <span
                v-if="entry.updateAvailable"
                data-testid="plugin-family-update-badge"
                class="rounded-sm bg-warn-soft px-1.5 py-0.5 font-medium text-warn"
              >{{ t('pluginProvider.flow.updateBadge') }}</span>
              <!-- S13 崩溃标记（失败路径表：crashed 家族卡显示「插件已停止」） -->
              <span
                v-if="isCrashed(entry)"
                data-testid="plugin-family-crashed-badge"
                class="rounded-sm bg-danger-soft px-1.5 py-0.5 font-medium text-danger"
              >{{ t('pluginProvider.flow.stoppedBadge') }}</span>
            </span>
          </span>
          <!-- S13 重启按钮（失败路径表：plugin.toggle off/on，用户显式触发不自动重激活，ADR-0122） -->
          <Button
            v-if="isCrashed(entry)"
            variant="secondary"
            size="sm"
            data-testid="plugin-family-restart-btn"
            :disabled="restartingPluginId !== null"
            @click.stop="onRestartPlugin(entry)"
          >{{ restartingPluginId === entry.pluginId ? t('pluginProvider.flow.restarting') : t('pluginProvider.flow.restart') }}</Button>
          <!-- 未装家族的显式安装引导（失败路径表：家族卡显示「需要先安装插件」） -->
          <span
            v-if="!entry.installed"
            class="shrink-0 rounded-sm bg-surface-hover px-2 py-1 text-[length:var(--text-3xs)] text-neutral-mid"
          >{{ t('pluginProvider.flow.installHint') }}</span>
        </div>

        <!-- S15① 陈旧提示条（R-2 wire 字段 stale：缓存兜底生效、数据可浏览但非确认新鲜） -->
        <div
          v-if="source.catalogStale.value"
          data-testid="plugin-catalog-stale"
          class="flex items-center justify-between gap-2 rounded-sm bg-warn-soft px-2.5 py-1.5"
        >
          <p class="text-[length:var(--text-3xs)] text-warn">{{ t('pluginProvider.flow.staleHint') }}</p>
          <Button
            variant="ghost"
            size="sm"
            data-testid="plugin-catalog-stale-retry"
            :disabled="catalogRefreshing"
            @click="onRetryCatalog"
          >{{ t('pluginProvider.flow.retry') }}</Button>
        </div>

        <!-- 清单空/失败态（S15② R-2 wire 字段 available：无缓存且拉取失败 = 报错态，
             与「缓存清单为空」区分呈现；宿主始终提供重试入口） -->
        <div
          v-if="!familyEntries.length"
          data-testid="plugin-family-empty"
          class="flex flex-col items-center gap-2 px-2 py-8 text-center"
        >
          <p
            v-if="source.catalogUnavailable.value"
            data-testid="plugin-catalog-error"
            class="text-[length:var(--text-sm)] text-danger"
          >{{ t('pluginProvider.flow.catalogUnavailable') }}</p>
          <p v-else class="text-[length:var(--text-sm)] text-neutral-mid">
            {{ source.catalogLoaded.value ? t('pluginProvider.flow.emptyCatalog') : t('pluginProvider.flow.catalogLoading') }}
          </p>
          <Button
            variant="ghost"
            size="sm"
            data-testid="plugin-catalog-retry"
            :disabled="catalogRefreshing"
            @click="onRetryCatalog"
          >{{ t('pluginProvider.flow.retry') }}</Button>
        </div>

        <!-- 包名直装（D3/S27 第二路径：清单是发现通道不是白名单，用户可直接输入包名安装；
             与家族卡同一确认停点——确认卡全量展示 capabilities/readPaths） -->
        <div class="mt-1 flex items-center gap-2 border-t border-hairline pt-3">
          <Input
            v-model="directSpec"
            data-testid="plugin-direct-spec"
            :placeholder="t('pluginProvider.flow.directInstallPlaceholder')"
            class="h-8"
            :disabled="preparing"
            @keyup.enter="onDirectInstall"
          />
          <Button
            variant="secondary"
            data-testid="plugin-direct-install-btn"
            :disabled="directSpec.trim() === '' || catalogRefreshing || preparing"
            @click="onDirectInstall"
          >{{ t('pluginProvider.flow.directInstallBtn') }}</Button>
        </div>
      </div>

      <!-- ①-b 版本选择段（数据拉取/选中态在 PluginVersionSelect；spec 构造与两段式安装在本组件） -->
      <PluginVersionSelect
        v-else-if="phase === 'version' && versionEntry"
        :package-name="versionEntry.packageName"
        :display-name="versionEntry.displayName"
        :intent="installIntent"
        :preparing="preparing"
        :install-error="flowError"
        @cancel="onVersionCancel"
        @install="onVersionInstall"
      />

      <!-- ② 安装确认卡（prepare 成功、停在确认停点；S27 知情面） -->
      <div v-else-if="phase === 'confirm' && installPreview" data-testid="plugin-install-confirm" class="flex flex-col gap-3">
        <p class="text-[length:var(--text-sm)] text-neutral-fg">
          {{ installIntent === 'update' ? t('pluginProvider.flow.confirmUpdateDesc') : t('pluginProvider.flow.confirmInstallDesc') }}
          <span class="font-mono text-[length:var(--text-xs)]">{{ installPreview.packageName }}@{{ installPreview.version }}</span>
        </p>
        <div class="flex flex-col gap-2 rounded-md bg-surface p-3">
          <PluginConfirmField
            :label="t('pluginProvider.flow.capabilitiesLabel')"
            :items="installPreview.capabilities"
            :empty-label="t('pluginProvider.flow.noneDeclared')"
            test-id="plugin-confirm-capabilities"
          />
          <PluginConfirmField
            :label="t('pluginProvider.flow.readPathsLabel')"
            :items="installPreview.readPaths"
            :empty-label="t('pluginProvider.flow.noneDeclared')"
            test-id="plugin-confirm-read-paths"
          />
          <PluginConfirmField
            v-if="installPreview.permissions.length"
            :label="t('pluginProvider.flow.permissionsLabel')"
            :items="installPreview.permissions"
            :empty-label="t('pluginProvider.flow.noneDeclared')"
            test-id="plugin-confirm-permissions"
          />
        </div>
        <p class="text-[length:var(--text-3xs)] text-neutral-mid">{{ t('pluginProvider.flow.confirmHint') }}</p>
        <p
          v-if="flowError"
          data-testid="plugin-install-error"
          class="text-[length:var(--text-xs)] text-danger"
        >{{ flowError }}</p>
        <div class="flex justify-end gap-2">
          <Button
            variant="ghost"
            data-testid="plugin-install-cancel"
            :disabled="confirming"
            @click="onInstallCancel"
          >{{ t('pluginProvider.flow.cancel') }}</Button>
          <Button
            variant="default"
            data-testid="plugin-install-confirm-btn"
            :disabled="confirming"
            @click="onInstallConfirm"
          >
            <Loader2 v-if="confirming" class="size-3.5 animate-spin" />
            {{ confirming
              ? (installIntent === 'update' ? t('pluginProvider.flow.updating') : t('pluginProvider.flow.installing'))
              : (installIntent === 'update' ? t('pluginProvider.flow.confirmUpdate') : t('pluginProvider.flow.confirmInstall')) }}
          </Button>
        </div>
      </div>

      <!-- ③ 授权挂载位容器（插件渲染区：宿主仅提供容器，D2） -->
      <div v-else-if="phase === 'authorize' && pendingAuthorizePluginId" data-testid="plugin-authorize-container" class="flex min-h-[240px] flex-col">
        <ViewHost
          :scope="{ kind: 'global', mountId: AUTHORIZE_MOUNT_ID, pluginId: pendingAuthorizePluginId }"
          :view-id="AUTHORIZE_VIEW_ID"
          :title="authorizeTitle"
          empty="placeholder"
        />
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * PluginProviderFlow —— 家族卡 + 授权挂载位容器 + 安装引导 + 安装确认卡（U6）。
 *
 * 安装通路（两段式，U4/U6）：经 resolvePluginInstallPort 消费 SettingsTransport 的
 * 三方法（preparePluginInstall / confirmPluginInstall / cancelPluginInstall）——
 * adapter 直连 plugin domain，WS 帧转发 runtime 两段式编排；确认停点对接本组件
 * 确认卡（S27：capabilities/readPaths 全量展示，未确认不落盘）。
 */
import { computed, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from '@lucide/vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
} from '@taiji/ui'
import { ViewHost } from '@taiji/ui/extension-host'
import { ACTION_EXECUTOR_KEY, UI_EVENT_SENDER_KEY } from '@taiji/ui/rendering-protocol'
import { getSettingsTransport } from '@taiji/core'
import {
  createPluginActionExecutor,
  createPluginUiEventSender,
  resolvePluginInstallPort,
  usePluginProviderSource,
  type PluginCatalogItem,
  type PluginFlowFocus,
  type PluginInstallPreview,
} from './PluginProviderSource'
import PluginConfirmField from './PluginConfirmField.vue'
import PluginVersionSelect from './PluginVersionSelect.vue'

/** 授权挂载位 id（core bootstrap 注册 + 本组件消费，同字面量即约定）。 */
const AUTHORIZE_MOUNT_ID = 'provider.authorize'
/** 授权主视图 viewId 约定 = 挂载位 id（插件推树时用同名 viewId；跨仓契约）。 */
const AUTHORIZE_VIEW_ID = AUTHORIZE_MOUNT_ID

const props = defineProps<{
  open: boolean
  /** 焦点家族（ProviderRowCard 的重新授权/更新入口；缺省 = 家族选择段起步） */
  focus?: PluginFlowFocus
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
}>()

const { t } = useI18n()
const source = usePluginProviderSource()

/** 流程段状态机（family 家族选择 / version 版本选择 / confirm 安装确认停点 / authorize 授权挂载位）。 */
type FlowPhase = 'family' | 'version' | 'confirm' | 'authorize'
const phase = ref<FlowPhase>('family')
/** 确认卡知情面（preparePluginInstall 回包；非 null = 停在确认停点）。 */
const installPreview = ref<PluginInstallPreview | null>(null)
/** 确认卡意图（全新安装 / 已装家族更新——文案与确认按钮差异）。 */
const installIntent = ref<'install' | 'update'>('install')
/** 当前段错误（family 段 = 清单/通路错误；version 段 = 版本列表拉取失败；confirm 段 = prepare/confirm 失败）。 */
const flowError = ref('')
const confirming = ref(false)
/** preparePluginInstall 进行中（点击安装后立即置真，回包前提供可见等待态并防重入）。 */
const preparing = ref(false)
/** 流程代次：关闭/重开会自增，迟到的 prepare/listVersions 回包按旧代次丢弃，避免陈旧确认卡复活。 */
let flowGeneration = 0
/** 版本选择段目标（family 卡 / update focus 进入时的包名与显示名；列表拉取与选中态在 PluginVersionSelect）。 */
const versionEntry = ref<{ packageName: string; displayName: string } | null>(null)
const catalogRefreshing = ref(false)
/** 包名直装输入（S27 第二路径：清单是发现通道，用户可直接输入包名） */
const directSpec = ref('')
/** S13 重启中的插件 id（null = 无；重启按钮 loading/互斥判据） */
const restartingPluginId = ref<string | null>(null)
/** 激活中的插件 id（已装未激活家族卡点击路径；审批门等待期覆盖此处，null = 无） */
const activatingPluginId = ref<string | null>(null)

/** 家族条目（清单 family 非空者——Provider 来源插件的家族卡数据）。 */
const familyEntries = computed(() => source.catalog.value.filter((e) => e.family !== undefined))

/** S13 崩溃态判定：该家族对应插件在 plugin.list 运行态中 status=crashed（未拉到 = 不猜测）。 */
function isCrashed(entry: PluginCatalogItem): boolean {
  return source.pluginInfoOf(entry.pluginId)?.status === 'crashed'
}

/**
 * S13 重启动作（失败路径表）：plugin.toggle off 再 on，经 source.restartPlugin 执行；
 * 执行中按钮 loading + 互斥，完成后运行态缓存由 restartPlugin 以 toggle 回包刷新
 * （家族卡崩溃标记随之消失）。失败呈 family 段错误条，不静默。
 */
async function onRestartPlugin(entry: PluginCatalogItem): Promise<void> {
  if (restartingPluginId.value !== null) return
  restartingPluginId.value = entry.pluginId
  flowError.value = ''
  try {
    await source.restartPlugin(entry.pluginId)
  } catch (e) {
    flowError.value = t('pluginProvider.flow.restartFailed', { reason: e instanceof Error ? e.message : String(e) })
  } finally {
    restartingPluginId.value = null
  }
}

const dialogTitle = computed(() => {
  if (phase.value === 'version' || phase.value === 'confirm') {
    return installIntent.value === 'update' ? t('pluginProvider.flow.updateTitle') : t('pluginProvider.flow.installTitle')
  }
  if (phase.value === 'authorize' && pendingAuthorizePluginId.value !== null) {
    return props.focus?.intent === 'update'
      ? t('pluginProvider.flow.updateTitle')
      : t('pluginProvider.flow.authorizeTitle', { name: authorizeTitle.value })
  }
  return t('pluginProvider.flow.title')
})

const dialogSubtitle = computed(() => {
  if (phase.value === 'version' || phase.value === 'confirm') return t('pluginProvider.flow.installSubtitle')
  if (phase.value === 'authorize') return t('pluginProvider.flow.authorizeSubtitle')
  return t('pluginProvider.flow.subtitle')
})

/** 授权段的目标插件 id（清单刷新后回读最新条目；包名直装可能不在清单内）。 */
const pendingAuthorizePluginId = ref<string | null>(null)

/** 授权段的清单条目（缺失 = 直装包未进清单，标题回落 pluginId）。 */
const authorizeEntry = computed<PluginCatalogItem | undefined>(() => {
  const pluginId = pendingAuthorizePluginId.value
  if (pluginId === null) return undefined
  return source.catalog.value.find((e) => e.pluginId === pluginId)
})

/**
 * 进入授权挂载位段（三入口共用：focus 直达 / 家族卡已装 / 安装确认成功）。进入即
 * invoke getAuthorizeView——插件初始树的唯一生产者是插件该方法（快照 store 只存
 * 插件 views.update 推送的内容，无此驱动容器恒占位空态）；activate 完成是安装确认
 * 的一部分，命令通道在容器渲染前已就绪，树经实时帧到达后 ViewHost 渲染。
 */
function enterAuthorize(pluginId: string): void {
  pendingAuthorizePluginId.value = pluginId
  phase.value = 'authorize'
  void source.pullAuthorizeView(pluginId)
}

/**
 * 授权挂载位的快照分区清理（plugin.ui.clearMount，U2 悬置二选一已裁决 = ①调用防陈旧
 * ——2026-10-25 用户裁决）。调用点 = 离开授权段（Dialog 关闭，挂载位退役）：防旧家族
 * 树残留进快照恢复源——重进授权段恒经 enterAuthorize → invoke getAuthorizeView 驱动
 * 插件重推初始树，不依赖旧快照；家族切换必经关闭重开，同一清理覆盖。清理失败 warn
 * 降级不阻断关闭（残留由插件重推覆盖 / clearForPlugin 生命周期链兜底）。
 */
async function clearAuthorizeMountSnapshots(): Promise<void> {
  try {
    await getSettingsTransport().clearPluginMountUi?.(AUTHORIZE_MOUNT_ID)
  } catch (e) {
    // best-effort 降级：清理失败不阻断 Dialog 关闭（残留由插件重推覆盖 / clearForPlugin
    // 生命周期链兜底），warn 可见
    console.warn('[plugin-provider-flow] clearPluginMountUi on authorize-exit failed:', e)
  }
}

const authorizeTitle = computed<string>(() =>
  authorizeEntry.value?.family?.displayName ?? pendingAuthorizePluginId.value ?? '',
)

// text-input 值回传出口（D8/S7）：挂载位容器同时掌握 pluginId + viewId，故在此 provide；
// 原语只报 (componentId, event, value)。插件侧始终持有最新值（fire-and-forget）。
provide(UI_EVENT_SENDER_KEY, createPluginUiEventSender(() => pendingAuthorizePluginId.value, AUTHORIZE_VIEW_ID))
// action-bar 命令执行器（D7）：授权容器树内 action-bar 的命令活在插件 fork，容器 provide
// 局部执行器直发 plugin.executeCommand（与 sender 同范式，覆盖 app 级 pi 扩展命令执行器）。
provide(ACTION_EXECUTOR_KEY, createPluginActionExecutor(() => pendingAuthorizePluginId.value))

watch(() => props.open, (open) => {
  if (!open) {
    resetFlow()
    return
  }
  void enterFlow()
}, { immediate: true })

/** 打开：拉清单 + 插件运行态（S13 崩溃标记判定源）→ 有焦点则直达（authorize 直进挂载位容器；update 直进确认卡）。 */
async function enterFlow(): Promise<void> {
  flowError.value = ''
  catalogRefreshing.value = true
  try {
    await source.refreshCatalog()
    // 并行不 await 阻塞清单呈现：运行态只影响家族卡崩溃标记（后到后渲染，S13 拉为主）
    void source.refreshPlugins()
  } finally {
    catalogRefreshing.value = false
  }
  const focus = props.focus
  if (!focus) return
  const entry = source.catalog.value.find((e) => e.pluginId === focus.pluginId)
  if (entry === undefined) {
    flowError.value = t('pluginProvider.flow.focusMissing')
    return
  }
  if (focus.intent === 'authorize') {
    enterAuthorize(entry.pluginId)
    return
  }
  // update 意图：进版本选择段（安装链与首次安装同构，文案按 update 差异化）
  enterVersionSelect({ packageName: entry.packageName, displayName: entry.family?.displayName ?? entry.displayName }, 'update')
}

/** 关闭/重开复位：确认停点残留的暂存交 cancelPluginInstall 清理（S27 未确认不落盘）。 */
function resetFlow(): void {
  flowGeneration += 1
  preparing.value = false
  if (installPreview.value !== null) {
    resolvePluginInstallPort()?.cancelPluginInstall(installPreview.value.pluginId).catch((e: unknown) => {
      console.warn('[plugin-provider-flow] cancelPluginInstall on close failed:', e)
    })
  }
  // 离开授权段（挂载位退役）→ 清该挂载位快照分区（U2 裁决①防陈旧，见函数注释）
  if (phase.value === 'authorize') void clearAuthorizeMountSnapshots()
  phase.value = 'family'
  installPreview.value = null
  pendingAuthorizePluginId.value = null
  directSpec.value = ''
  restartingPluginId.value = null
  versionEntry.value = null
  flowError.value = ''
}

function onRetryCatalog(): void {
  catalogRefreshing.value = true
  void source.refreshCatalog().finally(() => { catalogRefreshing.value = false })
}

function credentialSourceLabel(credentialSource: NonNullable<PluginCatalogItem['family']>['credentialSource'] | undefined): string {
  return credentialSource === 'oauth' ? t('pluginProvider.flow.credentialOauth') : t('pluginProvider.flow.credentialExtract')
}

function familyAvatarChar(entry: PluginCatalogItem): string {
  return (entry.family?.displayName ?? entry.pluginId).charAt(0).toUpperCase()
}

/** 家族卡点击：已装 → 授权容器；已装未激活 → 先激活再进授权段；未装 → 版本选择段。 */
function onFamilySelect(entry: PluginCatalogItem): void {
  if (preparing.value || confirming.value || activatingPluginId.value !== null) return
  if (entry.installed) {
    // 已装未激活（安装中断在审批门后重启 / 停用态）：直接进授权段会 invoke 一个未注册
    // 的命令面（插件未激活无命令），容器恒空态——用户看到的「点了没反应」即此形态
    if (source.pluginInfoOf(entry.pluginId)?.status !== 'active') {
      void activateThenAuthorize(entry.pluginId)
      return
    }
    enterAuthorize(entry.pluginId)
    return
  }
  enterVersionSelect({ packageName: entry.packageName, displayName: entry.family?.displayName ?? entry.displayName }, 'install')
}

/**
 * 已装未激活家族卡的激活路径（plugin.toggle on，经 source.activatePlugin）：
 * 审批门等待期 elevated 审批弹窗浮于本卡片区之上，批准/拒绝后 toggle 回包——
 * 激活达 active 进授权段；未达 active（权限被拒等）显错不进段，失败显错不静默。
 */
async function activateThenAuthorize(pluginId: string): Promise<void> {
  activatingPluginId.value = pluginId
  flowError.value = ''
  try {
    await source.activatePlugin(pluginId)
    if (source.pluginInfoOf(pluginId)?.status !== 'active') {
      flowError.value = t('pluginProvider.flow.activateNotActive')
      return
    }
    enterAuthorize(pluginId)
  } catch (e) {
    flowError.value = t('pluginProvider.flow.activateFailed', { reason: e instanceof Error ? e.message : String(e) })
  } finally {
    activatingPluginId.value = null
  }
}

/**
 * 进入版本选择段（版本列表拉取与选中态在 PluginVersionSelect，挂载即拉）。
 * port 未挂载 listPluginVersions（旧 runtime/stub）时回退直装最新版（免版本
 * 选择步骤，安装链不因此断）。
 */
function enterVersionSelect(entry: { packageName: string; displayName: string }, intent: 'install' | 'update'): void {
  if (preparing.value || confirming.value) return
  installIntent.value = intent
  flowError.value = ''
  const port = resolvePluginInstallPort()
  if (port === null) {
    flowError.value = t('pluginProvider.flow.channelUnavailable')
    return
  }
  if (port.listPluginVersions === undefined) {
    void beginInstall(entry.packageName, intent, 'family')
    return
  }
  versionEntry.value = entry
  phase.value = 'version'
}

/** 版本选择取消：退回家族卡（无暂存产生，无清理动作）。 */
function onVersionCancel(): void {
  if (preparing.value) return
  versionEntry.value = null
  flowError.value = ''
  phase.value = 'family'
}

/** 版本选择确认：按选中版本构造 spec 发起 prepare（latest = 裸包名 → dist-tags latest）。 */
function onVersionInstall(version: string): void {
  const entry = versionEntry.value
  if (entry === null || preparing.value || confirming.value) return
  const spec = version === 'latest' || version === '' ? entry.packageName : `${entry.packageName}@${version}`
  void beginInstall(spec, installIntent.value, 'version')
}

/** 包名直装（S27 第二路径）：与家族卡共用确认停点。 */
function onDirectInstall(): void {
  const spec = directSpec.value.trim()
  if (spec === '' || preparing.value || confirming.value) return
  void beginInstall(spec, 'install')
}

/**
 * prepare → 确认卡（成功）或发起段错误提示（失败/通路未就绪）。errorPhase =
 * prepare 失败后退回的段（version 段发起 → 退回版本选择可改选重试；family 段
 * 直装 → 退回家族卡）。
 */
async function beginInstall(packageSpec: string, intent: 'install' | 'update', errorPhase: FlowPhase = 'family'): Promise<void> {
  if (preparing.value || confirming.value) return
  installIntent.value = intent
  flowError.value = ''
  const port = resolvePluginInstallPort()
  if (port === null) {
    flowError.value = t('pluginProvider.flow.channelUnavailable')
    return
  }
  const generation = flowGeneration
  preparing.value = true
  try {
    const preview = await port.preparePluginInstall(packageSpec)
    if (generation !== flowGeneration) {
      // 弹窗已在 prepare 期间关闭：不复活确认卡，清掉暂存避免残留等待下次启动清扫。
      void port.cancelPluginInstall(preview.pluginId).catch((e: unknown) => {
        console.warn('[plugin-provider-flow] cancelPluginInstall for stale prepare failed:', e)
      })
      return
    }
    installPreview.value = preview
    phase.value = 'confirm'
    // 版本选择段数据退役（确认卡展示实际解析版本；失败重试不再回版本段的旧数据）
    if (errorPhase === 'version') versionEntry.value = null
  } catch (e) {
    if (generation !== flowGeneration) return
    // prepare 失败（下载/校验/NAMESPACE_MISMATCH）：错误可见 + 不进确认卡（暂存由
    // runtime prepare 失败路径自清，S18）；version 段发起时退回版本段可改选重试
    flowError.value = e instanceof Error ? e.message : String(e)
    installPreview.value = null
    phase.value = errorPhase
  } finally {
    if (generation === flowGeneration) preparing.value = false
  }
}

/** 确认安装/更新：提交落盘 + 激活；成功后清单刷新（installed/updateAvailable 复位）。 */
async function onInstallConfirm(): Promise<void> {
  const preview = installPreview.value
  if (preview === null || confirming.value) return
  const port = resolvePluginInstallPort()
  if (port === null) {
    flowError.value = t('pluginProvider.flow.channelUnavailable')
    return
  }
  confirming.value = true
  flowError.value = ''
  try {
    const result = await port.confirmPluginInstall(preview.pluginId)
    if (!result.success) {
      flowError.value = result.error ?? t('pluginProvider.flow.confirmFailed')
      return
    }
    installPreview.value = null
    enterAuthorize(preview.pluginId)
    // 安装状态刷新不阻塞进入授权容器（家族卡在下次打开时呈现最新安装态）
    void source.refreshCatalog()
  } catch (e) {
    flowError.value = e instanceof Error ? e.message : String(e)
  } finally {
    confirming.value = false
  }
}

/** 取消安装：清暂存 + 退回家族卡（S27 未确认不发生安装落盘）。 */
async function onInstallCancel(): Promise<void> {
  const preview = installPreview.value
  installPreview.value = null
  phase.value = 'family'
  if (preview === null) return
  try {
    await resolvePluginInstallPort()?.cancelPluginInstall(preview.pluginId)
  } catch (e) {
    // 取消清理失败不阻断 UI（暂存残留由 runtime 启动清扫收敛），warn 可见
    console.warn('[plugin-provider-flow] cancelPluginInstall failed:', e)
  }
}

/** Dialog 关闭（X / 遮罩 / esc）：父侧 v-model:open 更新后 watch 复位流程态。 */
function onDialogToggle(open: boolean): void {
  emit('update:open', open)
}
</script>
