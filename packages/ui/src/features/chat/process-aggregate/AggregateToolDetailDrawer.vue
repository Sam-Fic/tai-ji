<!--
  聚合块 · 单步详情抽屉内容装配（chat-flow-process-aggregate U4 接线半边，D4）。
  壳 = primitives/dialog ToolDetailDrawer（420px 右贴边模态原语，开合态由挂载方持有——
  不接入右抽屉 DrawerPanel tab 注册制、不写 core drawer/bottom-drawer 开合态，与既有
  抽屉/浮层通道无共享开合态，邻居不变量验收 V5）。
  内容装配（设计 D4 字段单）：完整命令/参数 + 完整输出（240px 内滚，复用 BlockScrollBox
  与其限高令牌）+ 耗时 + 状态；修改类按增删着色——壳注入 toolDetailRenderer 时 read/
  write/edit 走富渲染通道（ToolRow 同款路由），缺壳（测试 mock 壳/移动壳未接）或失败态
  回退本组件：edit 的 unified patch（details.patch，ToolRow 同款取数口径）按行首 +/-/@@
  着色；运行中步骤打开时显示「仍在执行」注记（重开会话/reload 后未完成步骤的可见形态）。
  「阶段」无独立结构源（ToolCall 无 phase 字段；workflow phases chips 为已删形态）——
  执行阶段由状态词承担（running/completed/error），不虚构第二套阶段数据。
-->
<template>
  <ToolDetailDrawer
    :open="open"
    :title="detailTitle"
    @update:open="emit('update:open', $event)"
  >
    <template v-if="tool">
      <!-- 元信息行：工具名 + 状态 + 耗时（mono 元信息档，AggregateHoverCard 头行同构） -->
      <div
        class="flex items-baseline gap-2 font-mono text-[length:var(--text-2xs)] text-neutral-dim"
        data-testid="agg-detail-meta"
      >
        <span class="text-neutral-mid">{{ tool.toolName }}</span>
        <span :class="isFailed ? 'text-danger' : ''">{{ statusLabel }}</span>
        <span v-if="duration">{{ duration }}</span>
      </div>
      <!-- 运行中注记：抽屉打开时刻该步骤尚未结束的显式说明（锚定 id 现查段数据，状态词
           翻转即消失——响应式跟随，无定时刷新） -->
      <div
        v-if="isRunning"
        class="mt-2 rounded-[var(--radius-xs)] bg-accent-soft px-2 py-1 text-[length:var(--text-2xs)] text-accent"
        data-testid="agg-detail-running"
      >{{ t('panel.message.aggDetailStillRunning') }}</div>
      <!-- 失败注记：error 文本显式在场（失败响亮契约，AX6 同族） -->
      <pre
        v-if="errorText"
        class="mt-2 whitespace-pre-wrap break-all rounded-[var(--radius-xs)] bg-danger-soft px-2 py-1 font-mono text-[length:var(--text-2xs)] leading-[1.5] text-danger"
        data-testid="agg-detail-error"
      >{{ errorText }}</pre>
      <!-- 完整命令/参数（pre-wrap 原样全量，与单步行超宽省略相对的「看全」通道） -->
      <section v-if="paramText" class="mt-4">
        <h3 class="text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] text-neutral-dim">{{ t('panel.message.aggDetailParams') }}</h3>
        <pre
          class="mt-1 whitespace-pre-wrap break-all font-mono text-[length:var(--text-2xs)] leading-[1.5] text-neutral-mid"
          data-testid="agg-detail-params"
        >{{ paramText }}</pre>
      </section>
      <!-- 完整输出（240px 内滚，BlockScrollBox 限高令牌共用——G6 保留复用）：
           富渲染（壳注入）→ patch 增删着色（缺壳兜底）→ ANSI/纯文本（output/error 兜底） -->
      <section v-if="hasOutputContent" class="mt-4">
        <h3 class="text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] text-neutral-dim">{{ t('panel.message.aggDetailOutput') }}</h3>
        <div class="mt-1" data-testid="agg-detail-output">
          <BlockScrollBox v-if="richRenderer" surface="recessed">
            <component :is="richRenderer" :tool="tool" :session-id="sessionId" />
          </BlockScrollBox>
          <!-- unified patch 增删着色（缺壳兜底通道）：行首 +/-/@@ 是 diff 固有语法
               （结构信号，非内容语义解析）；水平滚动自管理（BlockScrollBox 仅 overflow-y） -->
          <div v-else-if="patchLines" class="agg-detail-patch">
            <pre class="m-0 overflow-x-auto whitespace-pre font-mono text-[length:var(--text-2xs)] leading-[1.5]"><span
              v-for="(line, i) in patchLines"
              :key="i"
              class="block"
              :class="diffLineClass(line)"
            >{{ line || ' ' }}</span></pre>
          </div>
          <BlockScrollBox v-else surface="recessed">
            <div class="font-mono text-[length:var(--text-2xs)] leading-[1.5] text-neutral-mid">
              <AnsiText v-if="tool.outputRaw" :content="tool.outputRaw" />
              <span v-else>{{ displayContent }}</span>
            </div>
          </BlockScrollBox>
        </div>
      </section>
    </template>
  </ToolDetailDrawer>
</template>

<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ToolCall } from '@taiji/shared'
import ToolDetailDrawer from '../../../primitives/dialog/ToolDetailDrawer.vue'
import BlockScrollBox from '../BlockScrollBox.vue'
import { AnsiText } from '../../../rendering-protocol'
import { useChatViewDeps } from '../chat-view-deps'
import { formatDuration } from '../format-utils'

const props = defineProps<{
  /** 详情锚定的工具调用（null = 关闭后无内容）；挂载方按 id 现查段数据——运行中步骤
      状态翻转（不可变替换新对象）时本组件拿到的是最新对象，内容实时跟随 */
  tool: ToolCall | null
  /** 受控开关（透传壳 v-model:open） */
  open: boolean
  /** 所属 session（透传富渲染组件） */
  sessionId?: string | null
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
}>()

const { t } = useI18n()
const chatViewDeps = useChatViewDeps()

const isRunning = computed(() => props.tool?.status === 'running')
const isFailed = computed(() => props.tool?.status === 'error')

const detailTitle = computed(() => (props.tool ? `${props.tool.toolName} · 详情` : ''))

/** 状态词（复用聚合块既有三键，不另立第二套状态词）；end_not_received 无行态词显示「—」 */
const statusLabel = computed(() => {
  if (props.tool?.status === 'error') return t('panel.message.aggRowFailed')
  if (props.tool?.status === 'running') return t('panel.message.aggGroupRunning')
  if (props.tool?.status === 'completed') return t('panel.message.aggStatusDone')
  return '—'
})

const duration = computed(() => {
  const { startTime, endTime } = props.tool ?? {}
  if (typeof startTime !== 'number' || typeof endTime !== 'number') return ''
  return formatDuration(Math.max(0, endTime - startTime))
})

/** 失败错误文本（抽屉在场显式标注） */
const errorText = computed(() => (isFailed.value ? (props.tool?.error ?? '') : ''))

/** 输出纯文本（output；失败态回退 error——ToolRow displayContent 同口径） */
const displayContent = computed(() => props.tool?.output || errorText.value)

/**
 * 参数摘要字段序（AggregateHoverCard 同款同序；未覆盖形态回退单行 JSON——抽屉是
 * 「完整参数」通道，不可空手而归）。展示级提取，非成员资格判定。
 */
const paramText = computed(() => {
  const input = props.tool?.input
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    for (const key of ['command', 'path', 'pattern', 'query', 'code'] as const) {
      const v = obj[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
    try {
      return JSON.stringify(obj)
    } catch {
      return ''
    }
  }
  return ''
})

/**
 * edit 的 unified patch（ToolRow 同款取数：details.patch；details.diff 是展示格式不可用）。
 * 失败态短路——错误信息走 error 渲染，不把未应用成功的 patch 当内容呈现。
 */
const patchText = computed(() => {
  if (props.tool?.status === 'error' || props.tool?.toolName !== 'edit') return ''
  const patch = props.tool?.details?.patch
  return typeof patch === 'string' ? patch : ''
})

const patchLines = computed(() => (patchText.value ? patchText.value.split('\n') : null))

/**
 * [tool-detail-rich] 富渲染路由（ToolRow hasRichDetail 同款判据：壳注入 toolDetailRenderer
 * 且非失败态——read 看 output / edit 看 details.patch / write 看 input.content）；
 * 返回组件本身供动态渲染，不可路由时 null。
 */
const richRenderer = computed<Component | null>(() => {
  const renderer = chatViewDeps.toolDetailRenderer
  if (!renderer || isFailed.value) return null
  const name = props.tool?.toolName
  if (name === 'read') return displayContent.value ? renderer : null
  if (name === 'edit') return patchText.value ? renderer : null
  if (name === 'write') {
    const input = props.tool?.input as Record<string, unknown> | undefined
    return typeof input?.content === 'string' ? renderer : null
  }
  return null
})

/** 输出区显隐：三条渲染通道全空则整节不渲染（无空态占位） */
const hasOutputContent = computed(() => Boolean(richRenderer.value || patchLines.value || displayContent.value))

/** unified patch 行首着色（增 accent / 删 danger / 头与 hunk 元信息 dim） */
function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('Index:') || line.startsWith('diff ')) {
    return 'text-neutral-dim'
  }
  if (line.startsWith('@@')) return 'text-neutral-dim'
  if (line.startsWith('+')) return 'text-accent'
  if (line.startsWith('-')) return 'text-danger'
  return 'text-neutral-mid'
}
</script>
