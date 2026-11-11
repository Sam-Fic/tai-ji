/**
 * useQueueStackCards —— QueueBubble 堆叠相位机（卡片生命周期）composable。
 *
 * 自 QueueBubble.vue <script setup> 拆出（行数门禁 300）：卡片生命周期是组件内唯一
 * 可独立成块的职责——不触模板/DOM 契约（高度模型、展开交互、状态→视觉映射仍留组件），
 * 仅依赖 rows 数据源与堆叠根元素 ref（enter 翻相强制 reflow 用）。
 *
 * 三相（OD QueuedSendStack 同款）：cards = rows 显示序的镜像，enter（自下滑入，渲染后
 * 强制 reflow 化开起始帧）→ ready → exit（上滑淡出后计时移除），离场卡深度与内容走
 * 冻结快照（不跳位）。重建按 ids 签名对账——状态/预览变化不重建（内容经 displayOf
 * 渲染期实时读，避免逐帧重建），仅条目增删触发；复活边沿（exit 计时窗内回归）清计时器
 * 回 ready，会话切换边沿（全量换血）旧卡直接移除不播 200ms 跨会话残影。
 *
 * 显示序派生（orderedRows）与深度查表（displayOf/depthOf）随相位机同源导出：显示序
 * 唯一定义点是 useQueueRows.stackRows，深度渲染期查表与 exit 冻结快照回退共用此序
 * （溢出计数不在相位机——+N 角标纯展示派生，QueueBubble 直接消费 stackRows）。
 */
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { stackRows, type QueueRow } from '@/composables/panel/useQueueRows'

/** 离场卡移除延时 = CSS 离场时长（--duration，200ms）；改须与 .qb-card[data-phase='exit'] 同步 */
const CLOSE_MS = 200

// ── 相位机（OD 直译）：cards = rows 的显示镜像，exit 卡冻结深度与内容快照 ──
export type CardPhase = 'enter' | 'ready' | 'exit'

export interface StackCard { // oe-exempt:20261110:framework:堆叠卡数据契约——composable 返回形状，QueueBubble 跨文件消费（类型契约先行，非抽象接口单实现）
  clientUuid: string
  preview: string
  state: QueueRow['state']
  phase: CardPhase
  /** 深度快照：仅 exit 卡消费（离场瞬间冻结值，见 depthOf）——非 exit 卡显示深度渲染期查表 */
  depth: number
}

export function useQueueStackCards(rows: Ref<QueueRow[]>, rootRef: Ref<HTMLDivElement | null>): {
  cards: Ref<StackCard[]>
  /** 非离场卡内容实时取自 rows；离场卡读冻结快照（OD currentItems 同款回退） */
  displayOf: (card: StackCard) => QueueRow
  /** 显示序深度：非 exit 卡渲染期查表（状态转移即时重排），exit 卡读冻结快照 */
  depthOf: (card: StackCard) => number
} {
  const cards = ref<StackCard[]>([])
  const exitTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** 显示序唯一定义点（useQueueRows.stackRows：failed 置顶，其余保持帧序） */
  const orderedRows = computed(() => stackRows(rows.value).ordered)

  /** 非离场卡内容实时取自 rows（状态/预览随帧更新）；离场卡读冻结快照（OD currentItems 同款回退） */
  function displayOf(card: StackCard): QueueRow {
    if (card.phase === 'exit') return card
    return orderedRows.value.find((r) => r.clientUuid === card.clientUuid) ?? card
  }

  /**
   * 显示序深度渲染期派生：非 exit 卡从 orderedRows 当前索引查表——queued→failed 等状态
   * 转移改变显示序（failed 置顶）但重建 watch 只随 ids 触发，深度若冻结在重建瞬间，
   * 失败行会滞留旧深度被裁剪层静默吞掉重试/撤销入口（§3.4），故显示深度必须每帧查表。
   * exit 卡读进离场相位时冻结的 depth（离场瞬间快照，不跳位）；查表未命中防御性回退快照。
   */
  function depthOf(card: StackCard): number {
    if (card.phase === 'exit') return card.depth
    const index = orderedRows.value.findIndex((r) => r.clientUuid === card.clientUuid)
    return index === -1 ? card.depth : index
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
  const rowIdsSignature = computed(() => rows.value.map((r) => r.clientUuid).join('\n'))
  watch(rowIdsSignature, () => {
    const previous = cards.value
    const nextOrdered = orderedRows.value
    // 会话切换边沿（全量换血）：Composer 跨 session 复用实例（无 :key，切会话不重挂载），
    // 旧非 exit 卡与新序零交集且新序非空 = 切到有队列的其他会话——旧卡直接移除不设 exit
    // 相位（含遗留离场尾巴与计时器一并清掉），不在新会话面板播放 200ms 离场动画（跨会话
    // 残影）；新会话卡照常 enter。「新序非空」排除同会话内全部撤销/投递完成（同样零交集，
    // 但属正常离场须播 exit 动画）与切到无队列会话（离场尾巴 200ms 内随根门关闭，保留旧
    // 行为）。同会话内的增删不命中此边沿（有交集），走下方逐卡对账。
    const liveIds = new Set(nextOrdered.map((r) => r.clientUuid))
    const prevLive = previous.filter((c) => c.phase !== 'exit')
    if (prevLive.length > 0 && nextOrdered.length > 0 && prevLive.every((c) => !liveIds.has(c.clientUuid))) {
      exitTimers.forEach(clearTimeout)
      exitTimers.clear()
      cards.value = nextOrdered.map((row, index): StackCard => ({ ...row, depth: index, phase: 'enter' }))
      return
    }
    const next: StackCard[] = nextOrdered.map((row, index): StackCard => {
      const old = previous.find((c) => c.clientUuid === row.clientUuid && c.phase !== 'exit')
      // 复活边沿（exit 计时未到期又回来）：清计时器，回到 ready
      const pending = exitTimers.get(row.clientUuid)
      if (pending) {
        clearTimeout(pending)
        exitTimers.delete(row.clientUuid)
      }
      // depth 只作 exit 冻结快照的回退值——显示深度经 depthOf 渲染期查表（状态转移即时重排）
      return { ...row, depth: index, phase: old ? 'ready' : 'enter' }
    })
    for (const old of previous) {
      if (nextOrdered.some((r) => r.clientUuid === old.clientUuid)) continue
      // 冻结深度 = 离场瞬间的显示深度（depthOf 查当前序），不是上次重建快照——重建间隙
      // 发生的状态重排不丢，离场动画从真实位置上滑不跳位
      next.push({ ...old, depth: depthOf(old), phase: 'exit' })
      if (!exitTimers.has(old.clientUuid)) {
        exitTimers.set(old.clientUuid, setTimeout(() => {
          exitTimers.delete(old.clientUuid)
          cards.value = cards.value.filter((c) => !(c.clientUuid === old.clientUuid && c.phase === 'exit'))
        }, CLOSE_MS))
      }
    }
    cards.value = next
  }, { immediate: true })

  onBeforeUnmount(() => {
    exitTimers.forEach(clearTimeout)
    exitTimers.clear()
  })

  return { cards, displayOf, depthOf }
}
