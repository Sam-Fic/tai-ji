<!--
  WorkflowVizDagNode —— DAG 画布的单节点卡片内容（SVG 子组件，方案 C 三层结构）。

  只承担调用点主体卡片与其实例小卡的形态渲染（方案 C demo §3.3/§6 形态）：主体框
  恒高 DAG_NODE_H（44，实边框 + surface-2 亮底浮在分区暗底上）承载中性状态点 +
  调用点模板名（变量段 ${…} warn 高亮）+ 元信息行（调用点 · n 实例[ · k 失败] /
  未触发 · L<行号>）；实例小卡画在主体框之外下方（独立 rect 边框卡：≥1 实例每实例
  一张，done/failed 状态染边框 + 状态点 + 真实 agent 名；0 实例一张虚线占位卡
  「未触发 · 0 实例」，不伪造运行名）。小卡与主体同宽左右边框对齐，状态点与
  文字锚主体同一垂直线（DOT_CX/LABEL_X）——两卡点列、文字列、边框全对齐。

  卡片中性化（方案 C §3.2/§9.1 裁决）：调用点是静态结构，状态语义归实例小卡承载——
  实例失败/完成只染对应实例小卡的边框与点，不染调用点主体（消除「一个实例失败整个
  调用点红边红点」的污染）；skipped（run 终局后零实例）保留淡化虚线形态，pending 与
  有实例态均为中性实线。run 级停止叠加（stopTone）作用于在途实例小卡点（dotTone），
  主体无状态可叠加。data-state 属性仍承载节点七态派生值（测试观察锚点，非着色源）。

  命名规则（方案 C §4）：标题恒为调用点模板名——单实例不再替换标题（保留「这是
  调用点」的结构信息，真实 agent 名在下方实例小卡）；多实例逐卡展开；0 实例不伪造
  运行名。模板名变量段 = u1 解析器合成标记 `${…}`（非源码原文），warn 色标识
  「还不是运行名」；全通配 `*`（description 非静态）原样展示。

  实例小卡 data-wfvz-instance 锚点保留为测试观察锚（非交互语义）：[2026-10-19]
  agent 钻取入口收归实例 trace 行，节点/实例卡点击不上抛 callId。

  检查：node prop 违约（缺失 / id 非法）时 fail-fast throw——本组件渲染抛错由外层
  WorkflowVizDagNodeGuard（errorCaptured 节点级边界）捕获并渲染占位错误态，不挂
  整画布（设计 §3.1 失败路径「单节点 SVG 生成失败 = 节点占位错误态不挂画布」）。
  errorCaptured 只捕获后代组件错误，边界必须是与本组件分离的父层组件。
-->
<template>
  <g
    :class="[
      'cursor-default',
      status === 'skipped' ? 'opacity-50' : '',
    ]"
    :data-state="status"
    :data-kind="node.kind"
    :data-stop-tone="stopTone ?? undefined"
  >
    <rect
      :class="['fill-surface-2 [rx:var(--radius-sm)] transition-[stroke] duration-[var(--duration-fast)] ease-[var(--ease)]', rectTone]"
      :width="DAG_NODE_W"
      :height="DAG_NODE_H"
    />
    <circle
      class="stroke-surface-2 [stroke-width:1.5] fill-[var(--neutral-dim)] transition-[fill] duration-[var(--duration-fast)] ease-[var(--ease)]"
      :cx="DOT_CX"
      :cy="DOT_CY"
      r="4"
    />
    <text class="text-[length:var(--text-3xs)] font-semibold fill-[var(--neutral-fg)]" :x="LABEL_X" :y="TITLE_BASELINE_Y">
      <title>{{ node.templateName }}</title>
      <tspan
        v-for="(part, i) in titleParts"
        :key="i"
        :class="part.variable ? 'fill-warn font-medium' : ''"
      >{{ part.text }}</tspan>
    </text>
    <text class="text-[length:var(--text-3xs)] font-mono fill-[var(--neutral-dim)]" :x="LABEL_X" :y="META_BASELINE_Y">
      <title>{{ metaText }}</title>
      {{ truncate(metaText, META_MAX_CHARS) }}
    </text>
    <!-- 实例小卡区（主体框之外下方，方案 C demo §3.3）：≥1 实例每实例一张独立边框卡
         （done/failed 状态染边 + 状态点归实例卡）；0 实例一张虚线占位卡。几何常量与
         layout.instanceZoneHeight 同源口径（高度表由画布按实例数派生传入布局）。
         data-wfvz-instance = 测试观察锚，非交互语义——agent 钻取已收归 trace 行 -->
    <g
      v-for="(call, i) in instances ?? []"
      :key="call.id"
      :data-testid="`wfvz-dag-instance-${call.id}`"
      :data-wfvz-instance="call.id"
      :data-state="call.status"
    >
      <rect
        :class="['fill-[var(--surface)] [rx:3] transition-[stroke] duration-[var(--duration-fast)] ease-[var(--ease)]', chipEdgeTone(call.status)]"
        :x="0"
        :y="chipTopY(i)"
        :width="DAG_NODE_W"
        :height="INSTANCE_CHIP_H"
      />
      <circle
        :class="['transition-[fill] duration-[var(--duration-fast)] ease-[var(--ease)]', dotTone(call.status, stopTone)]"
        :cx="DOT_CX"
        :cy="chipCenterY(i)"
        r="3"
      />
      <text
        class="text-[length:var(--text-3xs)] font-mono fill-[var(--neutral-mid)]"
        :x="LABEL_X"
        :y="chipLabelBaselineY(i)"
      >
        <title>{{ call.agent }}</title>
        {{ truncate(call.agent, INSTANCE_NAME_MAX_CHARS) }}
      </text>
    </g>
    <g
      v-if="(instances?.length ?? 0) === 0"
      :data-testid="`wfvz-dag-placeholder-${node.id}`"
      data-wfvz-placeholder="true"
    >
      <rect
        class="fill-transparent stroke-[var(--border-strong)] [stroke-dasharray:3_3] [rx:3]"
        :x="0"
        :y="placeholderTopY"
        :width="DAG_NODE_W"
        :height="INSTANCE_PLACEHOLDER_H"
      />
      <text
        class="text-[length:var(--text-3xs)] font-mono fill-[var(--neutral-faint)]"
        :x="LABEL_X"
        :y="placeholderLabelBaselineY"
      >{{ t('panel.workflowViz.callPointPlaceholder') }}</text>
    </g>
  </g>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WorkflowAgentCall, WorkflowDagNode } from '@taiji/shared'
import {
  DAG_NODE_H,
  DAG_NODE_W,
  INSTANCE_CHIP_GAP,
  INSTANCE_CHIP_H,
  INSTANCE_PLACEHOLDER_H,
  INSTANCE_ZONE_TOP_GAP,
} from './layout'
import { dotTone } from './tone'
import type { WorkflowVizDagNodeStatus, WorkflowVizDagStopTone } from './types'

const props = defineProps<{
  node: WorkflowDagNode
  status: WorkflowVizDagNodeStatus
  stopTone?: WorkflowVizDagStopTone
  /** 挂接的执行实例（D2 匹配产物，taskIndex 升序；缺省 = 无实例数据）。 */
  instances?: WorkflowAgentCall[]
}>()

const { t } = useI18n()

const DOT_CX = 14
/** 状态点纵向锚定标题行（与原形态一致；实例卡在主体之外不随行区漂移）。 */
const DOT_CY = 22
const LABEL_X = 26
const TITLE_BASELINE_Y = 20
const META_BASELINE_Y = 34
/** 标题最大字符数（超出按段截断 + 省略号；全名经 <title> 悬停可见）。 */
const NAME_MAX_CHARS = 18
/** 实例名最大字符数（卡内 mono 小字，与主体同宽 156 内容纳）。 */
const INSTANCE_NAME_MAX_CHARS = 20
/** 元信息行最大字符数（全串经 <title> 悬停可见）。 */
const META_MAX_CHARS = 26
/** 文字基线到卡中心的半行高（点与文字视觉对齐的固定修正量）。 */
const TEXT_CENTER_LIFT = 3
/** 取半除数（卡中心 = 卡顶 + 卡高/2；具名以过 no-magic-numbers）。 */
const HALF = 2
/** 实例小卡与主体卡同宽对齐（2026-11-08 用户裁决，覆盖 demo §6 的 8px 缩进形态）：
 *  小卡 rect x=0 宽 DAG_NODE_W，状态点与文字锚主体同一垂直线（DOT_CX / LABEL_X）
 *  ——两卡边框、点列、文字列全对齐。 */

// fail-fast 检查：prop 违约即抛（布局产物正常不可达；防御脏数据以占位错误态显形
// 而非静默渲染空卡）。抛出点被父层 WorkflowVizDagNodeGuard 捕获。
if (!props.node || typeof props.node.id !== 'string' || props.node.id === '') {
  throw new Error('[WorkflowVizDagNode] node prop 违约：缺失或 id 非法')
}

/**
 * 实例小卡边框着色（方案 C demo §3.3「失败态只染实例卡」）：done/failed 状态染
 * 对应状态线 token（35% 透明描边档），其余（running/retrying/pending/cancelled）
 * 中性边框——状态语义归实例卡，主体框恒中性。
 */
function chipEdgeTone(status: WorkflowAgentCall['status']): string {
  if (status === 'done') return 'stroke-[var(--success-ring)]'
  if (status === 'failed') return 'stroke-[var(--danger-ring)]'
  return 'stroke-[var(--border)]'
}

/** 第 i 张（0-based）实例小卡的顶部 y（主体底 + 上间隙 + 步进 i×(卡高+卡间距)）。 */
function chipTopY(i: number): number {
  return DAG_NODE_H + INSTANCE_ZONE_TOP_GAP + i * (INSTANCE_CHIP_H + INSTANCE_CHIP_GAP)
}

/** 第 i 张实例小卡的视觉中心 y（状态点锚）与文字基线 y。 */
function chipCenterY(i: number): number {
  return chipTopY(i) + INSTANCE_CHIP_H / HALF
}
function chipLabelBaselineY(i: number): number {
  return chipCenterY(i) + TEXT_CENTER_LIFT
}

/** 0 实例占位卡的顶部 y 与文字基线（卡高 18）。 */
const placeholderTopY = DAG_NODE_H + INSTANCE_ZONE_TOP_GAP
const placeholderLabelBaselineY = placeholderTopY + INSTANCE_PLACEHOLDER_H / HALF + TEXT_CENTER_LIFT

/** 模板名变量段标记长度（u1 解析器合成标记 `${…}` 的字符数，截断预算计入）。 */
const VAR_MARKER_LENGTH = '${…}'.length

/**
 * 标题分段（方案 C §4）：模板名按变量段标记 `${…}` 拆为字面/变量段序列，变量段
 * warn 高亮（「还不是运行名」）；超出 NAME_MAX_CHARS 按段截断（末段追加省略号，
 * 后续段丢弃——截断发生在段内不产生空 tspan）。全通配 `*` 单段原样。
 */
const titleParts = computed<Array<{ text: string; variable: boolean }>>(() => {
  const raw = props.node.templateName
  const parts: Array<{ text: string; variable: boolean }> = []
  let rest = raw
  for (;;) {
    const idx = rest.indexOf('${…}')
    if (idx === -1) {
      if (rest.length > 0) parts.push({ text: rest, variable: false })
      break
    }
    if (idx > 0) parts.push({ text: rest.slice(0, idx), variable: false })
    parts.push({ text: '${…}', variable: true })
    rest = rest.slice(idx + VAR_MARKER_LENGTH)
  }
  let budget = NAME_MAX_CHARS
  const out: Array<{ text: string; variable: boolean }> = []
  for (const part of parts) {
    if (budget <= 0) break
    if (part.text.length <= budget) {
      out.push(part)
      budget -= part.text.length
      continue
    }
    const cut = part.text.slice(0, Math.max(budget - 1, 0))
    out.push({ text: `${cut}…`, variable: part.variable })
    budget = 0
  }
  return out.length > 0 ? out : [{ text: '…', variable: false }]
})

/** 失败实例计数（元信息行的「k 失败」段来源；主体不染失败色）。 */
const failedCount = computed(() => props.instances?.filter((c) => c.status === 'failed').length ?? 0)

/**
 * 元信息行（方案 C §3.2）：调用点身份 + 实例计数（含失败计数文字化——状态归实例
 * 小卡后，主体层的失败信息以文字承载）+ 行号定位。
 */
const metaText = computed(() => {
  const count = props.instances?.length ?? 0
  const kind = t('panel.workflowViz.callPointKind')
  if (count === 0) return `${kind} · ${t('panel.workflowViz.callPointUntriggered')} · L${props.node.line}`
  const instances = t('panel.workflowViz.callPointInstances', { n: count })
  const failed = failedCount.value > 0 ? ` · ${t('panel.workflowViz.callPointFailed', { n: failedCount.value })}` : ''
  return `${kind} · ${instances}${failed} · L${props.node.line}`
})

/**
 * 主体描边（中性化两分支）：skipped（run 终局后零实例）虚线 + 底色淡化；其余
 * （pending / 有实例各态）中性实线——实例状态不染主体（方案 C §9.1 裁决）。
 */
const rectTone = computed(() =>
  props.status === 'skipped'
    ? 'stroke-[var(--neutral-dim)] [stroke-dasharray:4_3] fill-[var(--surface-hover)]'
    : 'stroke-[var(--neutral-dim)]',
)

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
</script>
