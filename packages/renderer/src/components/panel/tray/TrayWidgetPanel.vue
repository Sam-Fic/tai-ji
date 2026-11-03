<!--
  TrayWidgetPanel —— composer 任务托盘（Widget Tray）的协议 widget 面板
  （设计 docs/design/composer-task-tray.md（已删除，git 可追溯）§3.1 场景 B + §3.3 D3/D5/D7 + §3.4 终态数据流）。

  ── 契约（供 u-tray-shell 消费）──
  props.viewId: string —— widget key（= ViewHostStore viewId）；面板 head 标题兜底
  props.meta?: WidgetMeta —— head 渲染源（title + 状态点 + 进度 mini bar/label）
  props.guiTree: GuiComponent[] —— body 渲染源（entry.guiTree，逐项交 GuiComponentRenderer）
  emits: 无 —— 只读渲染面板：协议无 UI→extension 写通道（面板内人写操作 out-of-scope），交互
    原语（如 tab-bar 本地切 tab）由原语自身承载，本组件不解析协议语义（D3：托盘不解释 guiTree）
  pin 态：不由本组件读——外壳（TrayPanelSurface）provide TRAY_PIN_STATE_KEY，body 内的
    交互原语（Actionbar / list-tree 可点命令行）作为其子树 inject 同键决定交互项是否降级
    纯展示（D6）；本组件是协议原语子树的挂载位，注入覆盖面即 body 子树。standalone 直挂
    （无外壳）时注入缺失 = 门控不生效（RL4）
  尺寸：面板不设宽度（w-full）与高度——外壳内容区固定高 h-[340px]（小屏 max-h 60vh 兜底，
  固定高裁决 2026-09-16：切内部 tab 容器不塌缩，hover 态指针不落空），body 超出经外壳
  ScrollArea（flex-1 + min-h-0）内部滚动；浮层宽 400px / 锚定 icon 上方由外壳承载（D8）。

  ── 数据链（D3/D7）──
  条目存在与否由外壳 entries computed 决定（ViewHostStore 有 entry 即渲染、invalidate 即消失）；
  本组件只渲染传入的 entry 切片。guiTree 为空（异常 payload / 清屏竞态）→ 整体零 DOM，不出空壳。
  依赖追踪契约：外壳 entries computed 必须 `getViewIds` + `getView` 同路径（承自已退役的对话流
  widget pill entries 头注；拆开即断链 → 推送后不重算）。可运行样例见
  __tests__/panel/tray/tray-widget-bundle.test.ts 的「外壳契约复刻」宿主
  （TrayWidgetStrip；原 tray-widget.test.ts 已并入该 bundle）。

  ── 形态（与原对话流 widget 详情卡同视觉语言，该卡已随 pill 退役、形态迁入托盘）──
  head：状态点（7px，D4 色：running=accent / done=success / failed=danger / idle=dim）+ 标题
  （meta.title ?? viewId）+ 进度计数文本（progress.label ?? current/total）+ mini bar（3px 宽 40px，
  fill 按 severity/status 取色，宽度 clamp 0-100%）；缺 meta（v1 旧 extension）→ 标题回退 viewId、
  无状态点色、无进度。
  断连提示条（D7）：ws 连接状态非 connected 时置顶一行「连接已断开，内容可能过期」，重连自动
  消失（wsState 响应式）。「面板打开」由挂载本身承载——零帧 = 图标不存在 = 面板不可开（AX3），
  故判据只有连接态一项，无加载态/首帧骨架分支（走查修正：原「首帧骨架」已撤销）。
-->
<template>
  <div
    v-if="guiTree.length > 0"
    data-testid="tray-widget-panel"
    :data-widget-key="viewId"
    :aria-label="displayTitle"
    class="flex w-full min-w-0 flex-col gap-1.5"
  >
    <!-- 断连提示条（D7）：ws 非 connected 即显示；重连边沿由 wsState 响应式驱动自动消失 -->
    <div
      v-if="showDisconnectBanner"
      data-testid="tray-widget-disconnect-banner"
      class="flex shrink-0 items-center gap-1.5 rounded-sm bg-bg-input px-2 py-1 text-[length:var(--text-2xs)] text-neutral-mid"
    >
      <WifiOff class="size-[14px] shrink-0" />
      <span class="min-w-0 flex-1">{{ t('panel.tray.widgetDisconnectBanner') }}</span>
    </div>
    <!-- head（meta 驱动）：状态点 + 标题 + 计数 + mini bar -->
    <div class="flex h-6 items-center gap-2 px-1">
      <span
        data-testid="tray-widget-panel-dot"
        class="size-[7px] shrink-0 rounded-full"
        :class="statusDotClass"
        aria-hidden="true"
      />
      <span
        data-testid="tray-widget-panel-title"
        class="min-w-0 truncate text-[length:var(--text-xs)] text-[color:var(--neutral-fg-2)]"
      >
        {{ displayTitle }}
      </span>
      <template v-if="meta?.progress">
        <span
          data-testid="tray-widget-panel-label"
          class="ml-auto shrink-0 font-mono text-[length:var(--text-3xs)] tabular-nums text-neutral-dim"
        >
          {{ progressLabel }}
        </span>
        <!-- [RD-2#8] 数值非有限（NaN/Infinity，第三方 widget 脏数据）→ 不渲染 mini bar：
             只挡 total<=0 时 NaN 会直写 style width:'NaN%' -->
        <span
          v-if="progressFinite"
          class="h-[3px] w-10 shrink-0 overflow-hidden rounded-full bg-surface-hover"
        >
          <span
            data-testid="tray-widget-panel-progress-fill"
            class="block h-full rounded-full transition-[width] duration-300 ease-[var(--ease)]"
            :class="progressFillClass"
            :style="{ width: progressWidth }"
          />
        </span>
      </template>
    </div>
    <!-- body：guiTree 逐项交渲染协议（index key 前提 = 原语均 props-only 无内部状态，
         原语引入本地状态时需改稳定 key，与已退役的对话流 widget 详情卡同约定） -->
    <div class="flex min-w-0 flex-col gap-1">
      <GuiComponentRenderer
        v-for="(component, i) in guiTree"
        :key="i"
        :component="component"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { WifiOff } from '@lucide/vue'
import type { GuiComponent, WidgetMeta } from '@zhushanwen/extension-protocol'
import { GuiComponentRenderer } from '@taiji/ui/rendering-protocol'
import { getState } from '@taiji/core/transport/ws-client'
import { widgetToneDot } from '@/components/panel/tray/tray-tone'

const props = defineProps<{
  /** widget key（= ViewHostStore viewId）：head 标题兜底 */
  viewId: string
  /** widget 宿主元数据（可选：v1 旧 extension 推送无 meta） */
  meta?: WidgetMeta
  /** entry.guiTree（body 渲染源；空数组 → 整体零 DOM） */
  guiTree: GuiComponent[]
}>()

const { t } = useI18n()

/**
 * ws 连接态（ws-client 单例 readonly ref；与 TrayNativePanel 断连条同源判据）。
 * pin 态门控不经过本组件读：外壳 TrayPanelSurface provide TRAY_PIN_STATE_KEY（响应式
 * 源），body 原语（Actionbar / list-tree 可点命令行）作为其子树 inject 同键——本组件是
 * 协议原语的挂载位，注入覆盖面即 body 子树；standalone 直挂（无外壳）时注入缺失 =
 * 门控不生效（RL4 方向，scheduler-manager 浮层等独立挂载位零变化）。
 */
const wsState = getState()

/** 断连提示条（D7）：非 connected 即显示；「面板打开」由挂载承载（AX3：图标出现即有树） */
const showDisconnectBanner = computed(() => wsState.value !== 'connected')

/** head 标题：meta.title（空串视为缺省）→ viewId（v1 旧 extension 与脏数据兜底） */
const displayTitle = computed(() => {
  const title = props.meta?.title
  return title !== undefined && title.trim() !== '' ? title : props.viewId
})

/** 状态点色（D4）：running=accent / done=success / failed=danger / idle 与无 meta=弱中性点 */
const statusDotClass = computed(() => widgetToneDot(props.meta?.status))

/** 进度 fill 色：显式 severity 优先（预算阈值），否则 done→success、默认 accent */
const progressFillClass = computed(() => {
  const severity = props.meta?.progress?.severity
  if (severity === 'danger') return 'bg-danger'
  if (severity === 'warn') return 'bg-warn'
  if (severity === 'ok') return 'bg-accent'
  return props.meta?.status === 'done' ? 'bg-success' : 'bg-accent'
})

/**
 * [RD-2#8] 进度数值有限性闸：第三方 widget 的 meta.progress.current/total 非有限
 * （NaN/Infinity）→ 无进度可画。ViewHostStore.narrowMeta 只校验 title 是 string，
 * progress 深度字段由本消费端按可选处理——这里是协议指定的数值把关层，非纯纵深防御。
 */
const progressFinite = computed(() => {
  const p = props.meta?.progress
  if (!p) return false
  return Number.isFinite(p.current) && Number.isFinite(p.total)
})

/** 进度计数文本：extension 格式化值 ?? current/total；数值非有限 → 「无进度」（WidgetMeta.progress.label 契约） */
const progressLabel = computed(() => {
  const p = props.meta?.progress
  if (!p) return ''
  if (p.label !== undefined) return p.label
  return progressFinite.value ? `${p.current}/${p.total}` : t('panel.trayWidget.progressUnavailable')
})

/** 百分比换算因子（no-magic-numbers 具名，承自已退役 widget 详情卡的 PCT_SCALE 模式） */
const PCT_SCALE = 100

/** 进度 fill 宽度（0-100 clamp；total<=0 防除零；非有限 → 0%（bar 已隐藏，值仅防 NaN 直写 style） */
const progressWidth = computed(() => {
  const p = props.meta?.progress
  if (!p || !progressFinite.value || p.total <= 0) return '0%'
  return `${Math.min(PCT_SCALE, Math.max(0, (p.current / p.total) * PCT_SCALE))}%`
})
</script>
