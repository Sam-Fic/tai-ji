<!--
  展示组件 · 投递队列区（composer-box 顶部；卡片堆叠形态，交互参照 OpenDesign QueuedSendStack）。

  **单一数据源**：队列条目 = runtime 内核 `session.delivery` 状态帧派生视图（core
  getDeliveryProjectionRef），不再读 queue_update 快照 + 本地 defer 队列双拼（D7）。
  显示序与溢出计数由 stackRows 单点提供（useQueueRows）：failed 行置顶占最浅层
  （重试/撤销入口不落被裁剪层），其余保持帧序；**全部行都渲染为卡片**，收起态 depth>2
  层由 CSS（data-overflow）隐藏而非 DOM 移除——enter/exit 动画跨可见窗边界保持连续。

  堆叠形态（OD QueuedSendStack 同款相位机）：depth 0 卡在最前（底部），旧卡每层上移
  12px 缩 6%、透明度 1/0.6/0.36 递减，depth 钳 3；hover/focus 展开成自底向上铺开的
  可滚动视口（5 张半上限 + 可用空间封顶），条目进出场走 enter（自下滑入）→ ready →
  exit（上滑淡出后计时移除）三相，离场卡深度冻结不跳位。+N 仅为信息角标（aria-hidden，
  非按钮——展开即全量浏览，无点击展开开关）。depth 0 卡可交互（编辑/重试/撤销），其余
  层 inert。展开态为组件内瞬态（hover/focus），不持 per-session 分区。

  行操作沿用内核编排：× 撤销（delivery.cancel，V9 queued 态 / V10 投递中收回-重投）、
  行内编辑（D6：peek 预填 + 锚定登记，编排经壳层 beginEdit）、failed 行重试
  （delivery.resync，§3.4）、failed ≥2「重试全部失败项」（Q5）。编辑态提示条锚定在册
  渲染，条目离场由壳层帧驱动 watch 自动解除。

  [HISTORICAL] 前身形态（v6 §8.5 静态行列表 + +N 点击展开开关）：+N 开关与 per-session
  expanded 分区已随堆叠形态退役（hover/focus 展开替代，Q2 复裁）；静态行的 hover 揭示
  操作钮改为卡上前排恒显（depth>0 层 inert 无干扰）。
-->
<template>
  <div
    v-if="rows.length > 0 || cards.length > 0"
    class="qb-inline border-b border-[color-mix(in_oklch,var(--accent)_18%,transparent)] px-3.5 pt-2 pb-1.5"
    role="region"
    :aria-label="t('panel.queueBubble.regionLabel', { n: liveCount })"
    data-testid="queue-bubble"
  >
    <!-- 编辑态提示条（chat-flow-consistency D6）：锚定在册时显示（条目离场由壳层帧驱动
         watch 自动解除锚定 → 本条随之消失；「放弃编辑」解除锚定但草稿文本保留） -->
    <div
      v-if="editingClientUuid"
      class="mb-1 flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[length:var(--text-2xs)] text-accent"
      data-testid="queue-edit-banner"
    >
      <PenLine class="size-3 shrink-0" />
      <span class="min-w-0 flex-1 truncate">{{ t('panel.queueBubble.editingBanner') }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-auto shrink-0 px-1 py-px text-[length:var(--text-2xs)] text-accent underline-offset-2 hover:underline"
        :data-testid="'queue-edit-abandon'"
        :title="t('panel.queueBubble.editingBannerAbandonHint')"
        @click="emit('abandonEdit')"
      >
        {{ t('panel.queueBubble.editingBannerAbandon') }}
      </Button>
    </div>
    <!-- 堆叠本体：根高恒为收起态 reserve（层数可视化占位），展开视口绝对定位向上生长 -->
    <div
      ref="rootRef"
      class="qb-stack relative w-full"
      :data-expanded="expanded"
      :style="stackStyle"
      tabindex="0"
      @pointerenter="onPointerEnter"
      @focusin="focusInside = true"
      @focusout="onFocusOut"
    >
      <div ref="viewportRef" class="qb-viewport absolute inset-x-0 bottom-0 h-full overflow-visible z-[var(--z-popover)]">
        <div class="qb-column relative h-full">
          <div
            v-for="card in cards"
            :key="card.clientUuid"
            class="qb-card group absolute left-0 bottom-0 w-full h-[var(--qb-banner-height)] flex items-center border border-border rounded-[var(--radius-card)] bg-bg-card origin-bottom"
            :data-testid="`queue-item-${card.clientUuid}`"
            :data-phase="card.phase"
            :data-depth="Math.min(card.depth, 3)"
            :data-overflow="card.depth >= QUEUE_VISIBLE_MAX"
            :aria-hidden="inactiveOf(card) || undefined"
            :inert="inactiveOf(card) || undefined"
            :title="rowTitleOf(displayOf(card))"
            :style="cardStyleOf(card)"
          >
            <div
              class="flex w-full items-center gap-1.5 px-2 py-1 text-[length:var(--text-xs)]"
              data-qb-card-content
            >
              <component
                :is="iconOf(displayOf(card).state)"
                class="size-[13px] shrink-0"
                :class="toneOf(displayOf(card).state)"
              />
              <span
                class="shrink-0 rounded-[var(--radius-sm)] px-1 py-px text-[length:var(--text-2xs)] leading-[1.4]"
                :class="chipClassOf(displayOf(card).state)"
                :data-testid="`queue-state-${card.clientUuid}`"
              >{{ stateLabelOf(displayOf(card).state) }}</span>
              <span class="qb-card-text min-w-0 flex-1 line-clamp-2 [overflow-wrap:anywhere] text-neutral-fg">{{ displayOf(card).preview }}</span>
              <!-- 行内编辑钮（chat-flow-consistency D6）：卡上恒显（depth>0 层 inert 无干扰）；
                   编排经壳层 beginEdit -->
              <Button
                variant="ghost"
                size="icon"
                class="size-5 shrink-0 rounded-sm p-0 text-neutral-dim hover:text-accent"
                :title="t('panel.queueBubble.editQueued')"
                :data-testid="`queue-edit-${card.clientUuid}`"
                :tabindex="inactiveOf(card) ? -1 : undefined"
                @click="emit('edit', card.clientUuid)"
              >
                <PenLine class="size-3" />
              </Button>
              <!-- 重试钮（仅 failed 行）：顺序为「重试 → 撤销」 -->
              <Button
                v-if="displayOf(card).state === 'failed'"
                variant="ghost"
                size="icon"
                class="size-5 shrink-0 rounded-sm p-0 text-danger"
                :title="t('panel.queueBubble.retry')"
                :data-testid="`queue-retry-${card.clientUuid}`"
                :tabindex="inactiveOf(card) ? -1 : undefined"
                @click="emit('retry', card.clientUuid)"
              >
                <RefreshCw class="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="size-5 shrink-0 rounded-sm p-0 text-neutral-dim hover:text-danger"
                :title="t('panel.queueBubble.cancelQueued')"
                :data-testid="`queue-cancel-${card.clientUuid}`"
                :tabindex="inactiveOf(card) ? -1 : undefined"
                @click="emit('cancel', card.clientUuid)"
              >
                <X class="size-3" />
              </Button>
            </div>
          </div>
        </div>
      </div>
      <!-- +N 信息角标（非按钮）：收起态被裁剪层数提示；展开即全量浏览无溢出 -->
      <div
        v-if="overflowCount > 0 && !expanded"
        class="pointer-events-none absolute -top-1 left-2 z-[1] rounded-full border border-border bg-bg px-1.5 text-[length:var(--text-2xs)] leading-[1.4] text-neutral-dim"
        aria-hidden="true"
        data-testid="queue-overflow-badge"
      >+{{ overflowCount }}</div>
    </div>
    <!-- 重试全部失败项（Q5）：failed ≥2 时一次 RPC 保序重投全部失败条目 -->
    <Button
      v-if="failedCount >= 2"
      variant="ghost"
      size="sm"
      class="mt-0.5 h-auto px-1 py-px text-[length:var(--text-2xs)] text-danger"
      :data-testid="'queue-retry-all'"
      @click="emit('retryAll')"
    >
      {{ t('panel.queueBubble.retryAll') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Hourglass, PenLine, RefreshCw, X, Zap } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { stackRows, QUEUE_VISIBLE_MAX, type QueueRow } from '@/composables/panel/useQueueRows'

const props = defineProps<{
  /** 队列条目（调用方已按「非 direct 且未 delivered」过滤，帧序 = 内核 FIFO 发送序；显示序在组件内经 stackRows） */
  rows: QueueRow[]
  /** 行 hover title（session 级单一值：按占用分档的「等什么结束」，由 Composer 传入） */
  hint: string
  /** 编辑态锚定的条目 id（chat-flow-consistency D6；null/undefined = 非编辑态，提示条不渲染） */
  editingClientUuid?: string | null
}>()

const emit = defineEmits<{
  /** × 撤销（delivery.cancel；queued 立即移除 / 投递中走内核收回-重投） */
  cancel: [clientUuid: string]
  /** 编辑（delivery.peek 预填 + 锚定登记，D6——单锚定判定与 peek 编排在壳层） */
  edit: [clientUuid: string]
  /** 重试（delivery.resync 单条重报，仅 failed 行渲染入口） */
  retry: [clientUuid: string]
  /** 重试全部失败项（delivery.resync 批量重报，failed ≥2 时渲染入口，Q5） */
  retryAll: []
  /** 放弃编辑（解除锚定，草稿文本保留——D6 提示条按钮） */
  abandonEdit: []
}>()

const { t } = useI18n()

// ── 堆叠常量（OD QueuedSendStack 同款数值；时长取既有 token 对应值，CSS 侧用 var()） ──
/** 离场卡移除延时 = CSS 离场时长（--duration，200ms）；改须与 .qb-card[data-phase='exit'] 同步 */
const CLOSE_MS = 200
/** 卡间距（展开态纵向 gap，px） */
const SPREAD_GAP = 4
/** 卡高测量下限（px） */
const MIN_CARD_HEIGHT = 32
/** 展开视口整卡上限（第 6 张露半卡作滚动暗示） */
const FULLY_VISIBLE_CARDS = 5
/** 收起态层叠每层上移量（px；CSS .qb-card depth 变换同值，改须两处同步） */
const LAYER_SHIFT_PX = 12
/** 收起态最多可见层数-1（首卡之下偏移层数钳 2 = depth 0..2 可见窗；CSS data-overflow 同口径） */
const RESERVE_EXTRA_LAYERS = 2
/** depth 变换钳制值（CSS 变换与透明度档位只定义到 3） */
const DEPTH_CLAMP = 3
/** 卡内容高实测的边框补偿（上下 1px 边框，OD 同款） */
const CARD_BORDER_COMP_PX = 2
/** 展开视口与消息流容器顶的呼吸间距（px） */
const VIEWPORT_GAP_PX = 4
/** 滚动暗示：上限外第 6 卡露出比例的分母（半卡，OD 同款） */
const SCROLL_CUE_FRACTION = 2

// ── 相位机（OD 直译）：cards = rows 的显示镜像，exit 卡冻结深度与内容快照 ──
type CardPhase = 'enter' | 'ready' | 'exit'
interface StackCard {
  clientUuid: string
  preview: string
  state: QueueRow['state']
  phase: CardPhase
  /** 显示序深度（0 = 最前底部；exit 卡保持离场瞬间值不跳位） */
  depth: number
}

const rootRef = ref<HTMLDivElement | null>(null)
const viewportRef = ref<HTMLDivElement | null>(null)
const cards = ref<StackCard[]>([])
const pointerInside = ref(false)
const focusInside = ref(false)
const cardHeight = ref(MIN_CARD_HEIGHT)
/** 展开视口可用空间上限（消息流滚动容器顶到堆叠底的间距；0 = 无上限信息，跳过封顶） */
const availableHeight = ref(0)
const exitTimers = new Map<string, ReturnType<typeof setTimeout>>()

const liveCount = computed(() => props.rows.length)
/** 展开态 = 瞬态（hover/focus），不持 per-session 分区；无条目时恒收起 */
const expanded = computed(() => liveCount.value > 0 && (pointerInside.value || focusInside.value))
/** 显示序 + 溢出计数唯一定义点（useQueueRows.stackRows） */
const orderedRows = computed(() => stackRows(props.rows).ordered)
const overflowCount = computed(() => stackRows(props.rows).overflowCount)
const failedCount = computed(() => props.rows.filter((r) => r.state === 'failed').length)

/** 非离场卡内容实时取自 rows（状态/预览随帧更新）；离场卡读冻结快照（OD currentItems 同款回退） */
function displayOf(card: StackCard): QueueRow {
  if (card.phase === 'exit') return card
  return orderedRows.value.find((r) => r.clientUuid === card.clientUuid) ?? card
}

/** 收起态不可交互卡：离场中或被裁剪层（inert + aria-hidden；可见窗 = 前 QUEUE_VISIBLE_MAX 层） */
function inactiveOf(card: StackCard): boolean {
  return card.phase === 'exit' || (!expanded.value && card.depth >= QUEUE_VISIBLE_MAX)
}

// enter→ready 翻相（flush post = 渲染后）：**必须先于重建 watch 注册**——重建 immediate 在
// setup 期同步赋值 cards，注册顺序靠后才收不到这次变更（首帧卡会卡在 enter 起始帧不可见）
watch(cards, () => {
  if (!cards.value.some((c) => c.phase === 'enter') || !rootRef.value) return
  void rootRef.value.offsetHeight
  cards.value = cards.value.map((c) => (c.phase === 'enter' ? { ...c, phase: 'ready' } : c))
}, { flush: 'post' })

// ids 签名驱动重建（状态/预览变化不走此 watch——内容经 displayOf 实时读，避免逐帧重建）；
// immediate = 首挂载即从当前 rows 建卡（无 immediate 则首帧空堆叠）
const rowIdsSignature = computed(() => props.rows.map((r) => r.clientUuid).join('\n'))
watch(rowIdsSignature, () => {
  const previous = cards.value
  const next: StackCard[] = orderedRows.value.map((row, index): StackCard => {
    const old = previous.find((c) => c.clientUuid === row.clientUuid && c.phase !== 'exit')
    // 复活边沿（exit 计时未到期又回来）：清计时器，回到 ready
    const pending = exitTimers.get(row.clientUuid)
    if (pending) {
      clearTimeout(pending)
      exitTimers.delete(row.clientUuid)
    }
    return { ...row, depth: index, phase: old ? 'ready' : 'enter' }
  })
  for (const old of previous) {
    if (orderedRows.value.some((r) => r.clientUuid === old.clientUuid)) continue
    next.push({ ...old, phase: 'exit' })
    if (!exitTimers.has(old.clientUuid)) {
      exitTimers.set(old.clientUuid, setTimeout(() => {
        exitTimers.delete(old.clientUuid)
        cards.value = cards.value.filter((c) => !(c.clientUuid === old.clientUuid && c.phase === 'exit'))
      }, CLOSE_MS))
    }
  }
  cards.value = next
}, { immediate: true })

// ── 高度模型：卡高实测（内容 scrollHeight），收起 reserve / 展开封顶（5.5 卡 + 可用空间） ──
const fullHeight = computed(() => Math.max(cardHeight.value, liveCount.value * (cardHeight.value + SPREAD_GAP) - SPREAD_GAP))
/** 收起态占位高：首卡 + 至多两层偏移（OD --chat-queue-reserve 同款） */
const reserveHeight = computed(() => cardHeight.value + Math.min(Math.max(liveCount.value - 1, 0), RESERVE_EXTRA_LAYERS) * LAYER_SHIFT_PX)
const expandedHeightLimit = computed(() => FULLY_VISIBLE_CARDS * (cardHeight.value + SPREAD_GAP) + cardHeight.value / SCROLL_CUE_FRACTION)
const viewportHeight = computed(() => {
  const capped = Math.min(fullHeight.value, expandedHeightLimit.value)
  return availableHeight.value > 0 ? Math.min(capped, availableHeight.value) : capped
})

const stackStyle = computed(() => ({
  height: `${reserveHeight.value}px`,
  '--qb-banner-height': `${cardHeight.value}px`,
  '--qb-column-height': `${fullHeight.value}px`,
  '--qb-viewport-height': `${viewportHeight.value}px`,
}))

function cardStyleOf(card: StackCard): Record<string, string | number> {
  return {
    '--qb-depth': Math.min(card.depth, DEPTH_CLAMP),
    '--qb-offset': `${card.depth * (cardHeight.value + SPREAD_GAP)}px`,
    zIndex: card.phase === 'exit' ? 0 : Math.max(1, liveCount.value - card.depth),
  }
}

function measure(): void {
  const root = rootRef.value
  if (!root) return
  const contents = root.querySelectorAll<HTMLElement>('[data-qb-card-content]')
  cardHeight.value = Math.max(MIN_CARD_HEIGHT, ...Array.from(contents, (n) => n.scrollHeight + CARD_BORDER_COMP_PX))
  // 可用空间 = 堆叠底到消息流滚动容器顶的间距（向上展开的活动上限；找不到容器则跳过封顶）
  const stream = document.querySelector('.message-stream')
  if (stream) {
    const bottom = root.getBoundingClientRect().bottom
    const top = stream.getBoundingClientRect().top
    availableHeight.value = Math.max(MIN_CARD_HEIGHT, bottom - top - VIEWPORT_GAP_PX)
  }
}

watch([rowIdsSignature, expanded], () => { void measure() }, { flush: 'post' })

// ── 展开触发：pointer 进入（触屏除外）/ focus 捕获；document 级矩形校验负责退出 ──
function onPointerEnter(event: PointerEvent): void {
  if (event.pointerType === 'touch') return
  // 事件坐标必须落在堆叠当前矩形内：入场滑行卡（自 +80px 滑入）可瞬态穿过光标停留点
  // （输入框中心恰在滑行走廊内，真机实证），Chrome 对静止光标下的元素变化会补发
  // enter/over——坐标校验一次性排除滑行误触发；真悬停坐标必在矩形内不受影响
  const rect = rootRef.value?.getBoundingClientRect()
  if (!rect) return
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return
  pointerInside.value = true
}

function onFocusOut(event: FocusEvent): void {
  const root = rootRef.value
  if (!root || !root.contains(event.relatedTarget as Node | null)) focusInside.value = false
}

watch(pointerInside, (inside) => {
  // 整个展开矩形（含卡间 gap）都是驻留区；快速滑出经 document move 校验退出（OD 同款）
  document.removeEventListener('pointermove', onDocPointerMove)
  window.removeEventListener('blur', onWindowBlur)
  if (!inside) return
  document.addEventListener('pointermove', onDocPointerMove)
  window.addEventListener('blur', onWindowBlur)
})

function onDocPointerMove(event: PointerEvent): void {
  if (event.pointerType === 'touch') return
  const rect = viewportRef.value?.getBoundingClientRect()
  if (rect && (event.clientX < rect.left || event.clientX > rect.right
    || event.clientY < rect.top || event.clientY > rect.bottom)) pointerInside.value = false
}

function onWindowBlur(): void {
  pointerInside.value = false
}

// 展开时从首卡读起（overflow 可下滚）；内容更新不重置用户选定的滚动位（OD 同款）
watch(expanded, (open) => {
  if (open && viewportRef.value) viewportRef.value.scrollTop = 0
})

onMounted(() => {
  window.addEventListener('resize', measure)
  measure()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  document.removeEventListener('pointermove', onDocPointerMove)
  window.removeEventListener('blur', onWindowBlur)
  exitTimers.forEach(clearTimeout)
  exitTimers.clear()
})

// ── 状态 → 视觉映射（沿用 v6 语义：等待=info / 进行中=accent / 失败=danger） ──
function iconOf(state: QueueRow['state']) {
  if (state === 'in-flight') return Zap
  if (state === 'failed') return AlertCircle
  return Hourglass
}

function toneOf(state: QueueRow['state']): string {
  if (state === 'in-flight') return 'text-accent'
  if (state === 'failed') return 'text-danger'
  return 'text-info'
}

function chipClassOf(state: QueueRow['state']): string {
  if (state === 'in-flight') return 'bg-[var(--accent-soft)] text-accent'
  if (state === 'failed') return 'bg-[var(--danger-soft)] text-danger'
  return 'bg-info-soft text-info'
}

/** 状态 → 用户可见文案（G3：排队中 / 投递中；failed 统一「发送未确认」，Q6） */
function stateLabelOf(state: QueueRow['state']): string {
  if (state === 'in-flight') return t('panel.queueBubble.stateInFlight')
  if (state === 'failed') return t('panel.queueBubble.stateFailed')
  return t('panel.queueBubble.stateQueued')
}

/** 卡 hover title：failed 卡在占用分档 hint 之外补判重说明（Q6 分层——行 = 状态 + 恢复指引） */
function rowTitleOf(row: QueueRow): string {
  if (row.state === 'failed') return `${props.hint}\n${t('panel.queueBubble.retryDedupHint')}`
  return props.hint
}
</script>

<style scoped>
/* 堆叠动效层（布局与静态视觉走模板 Tailwind 类，此处只留状态形变与过渡——特殊动画除外）。
   根高恒为收起 reserve（inline style）；展开视口自底向上生长，z 在流内容之上、浮层之下。 */
.qb-stack:focus-visible {
  outline: 1px solid var(--accent-ring);
  outline-offset: 2px;
  border-radius: var(--radius-card);
}
.qb-viewport {
  @apply transition-[height] duration-[var(--duration-slow)] ease-[var(--ease-out-soft)];
}
.qb-stack[data-expanded='true'] .qb-viewport {
  height: var(--qb-viewport-height);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
/* 展开态列高切全量（OD 同款：收起列跟随视口高，卡锚定视口底；展开列 = 全高可滚动） */
.qb-stack[data-expanded='true'] .qb-column {
  height: var(--qb-column-height);
}

/* 卡片收起态基础形 = depth 层叠（OD 同款公式：每层上移 12px 缩 6%；数值与脚本
   LAYER_SHIFT_PX/DEPTH_CLAMP 常量同源，改须两处同步）+ 过渡 */
.qb-card {
  @apply translate-y-[calc(var(--qb-depth)_*_-12px)] scale-[calc(1_-_var(--qb-depth)_*_0.06)];
  transition:
    transform var(--duration-slow) var(--ease-out-soft),
    opacity var(--duration-slow) var(--ease-out-soft),
    filter var(--duration-slow) var(--ease-out-soft),
    visibility 0s;
}
.qb-card[data-depth='1'] { opacity: 0.6; }
.qb-card[data-depth='2'] { opacity: 0.36; }
/* 收起态被裁剪层：淡出 + blur + 延迟 visibility（离场同时长族） */
.qb-card[data-overflow='true'] {
  opacity: 0;
  filter: blur(2px);
  visibility: hidden;
  transition-property: opacity, filter, visibility;
  transition-duration: var(--duration), var(--duration), 0s;
  transition-delay: 0s, 0s, var(--duration);
}

/* 展开态：自底向上铺开全亮（覆盖 depth/overflow 形） */
.qb-stack[data-expanded='true'] .qb-card {
  transform: translateY(calc(var(--qb-offset) * -1)) scale(1);
  opacity: 1;
  filter: blur(0);
  visibility: visible;
}

/* 相位：enter 起始帧（强制 reflow 后由基础过渡化开）；exit 上滑淡出（计时移除，时长= CLOSE_MS） */
.qb-card[data-phase='enter'] {
  transition: none;
  transform: translateY(80px) scale(0.97);
  opacity: 0;
  filter: blur(2px);
}
.qb-card[data-phase='exit'] {
  transform: translateY(-36px) scale(0.82);
  opacity: 0;
  filter: blur(2px);
  transition-property: transform, opacity, filter;
  transition-duration: var(--duration), var(--duration), var(--duration);
}
.qb-card[aria-hidden='true'] {
  pointer-events: none;
}

/* reduced-motion：全局兜底（style.css 0.01ms 瞬切）已覆盖；相位位移保留（瞬切不丢帧序） */
</style>
