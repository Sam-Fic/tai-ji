/**
 * 卡片列表拖拽排序 composable（原生 HTML5 DnD，零新增依赖——sortablejs/vuedraggable
 * 不在 @taiji/ui 依赖清单）。
 *
 * 交互契约：拖拽把手（draggable 元素）dragstart 记录源下标；卡根元素承载 dragover/drop
 * （dragover preventDefault 是允许 drop 的 HTML5 契约）；按指针位于目标卡中线上/下判定
 * 插入槽位（slot = 目标卡前缘 / 后缘），指示线经 cardClass 下发 Tailwind 任意值 shadow
 * 工具类（类挂卡根；inset box-shadow 不占布局——border 加宽会挤压内容抖动）。drop 换算
 * 成 moveCardToSlot（route-editor-ops 纯函数）执行重排，放回原位（slot === from 或
 * from + 1）不触发重排不标脏。dragend 兜底复位（drop 被取消也还原，侧栏 SessionItem
 * 同款纪律）。
 */
import { ref, type Ref } from 'vue'

/** 插入边缘判定分界：指针越过目标卡矩形中线（高 / 2）即判「插到其后」，否则「插到其前」。 */
const DROP_EDGE_MIDPOINT_DIVISOR = 2

export interface CardDndState { // oe-exempt:20261110:framework:composable 返回类型契约（消费方 TS 类型面），单实现为设计终态
  /** 拖拽源卡下标（null = 无拖拽进行中）。 */
  dragFromIndex: Ref<number | null>
  /** 指示线所在目标卡下标。 */
  dropTargetIndex: Ref<number | null>
  /** 指示线边缘（目标卡前缘/后缘 = 插入其前/其后）。 */
  dropEdge: Ref<'before' | 'after' | null>
  /** 把手 dragstart（页面把手元素绑定，index = 源卡下标）。 */
  startDrag(index: number, e: DragEvent): void
  /** 卡根 dragover（允许 drop + 更新插入指示）。 */
  dragOverCard(index: number, e: DragEvent): void
  /** 卡根 drop（换算插入槽位并触发 onReorder）。 */
  dropCard(index: number, e: DragEvent): void
  /** 卡根 dragend（兜底复位全部拖拽态）。 */
  endDrag(): void
  /** 卡根类计算（拖拽半透明源卡 + 前/后缘指示线，消费方 scoped style 定义样式）。 */
  cardClass(index: number): Record<string, boolean>
}

export function useCardDnd(onReorder: (from: number, slot: number) => void): CardDndState {
  const dragFromIndex = ref<number | null>(null)
  const dropTargetIndex = ref<number | null>(null)
  const dropEdge = ref<'before' | 'after' | null>(null)

  function reset(): void {
    dragFromIndex.value = null
    dropTargetIndex.value = null
    dropEdge.value = null
  }

  function startDrag(index: number, e: DragEvent): void {
    // setData 是 Firefox 触发 drag 行为的前提；内容不参与落点判定（源下标由闭包携带）
    e.dataTransfer?.setData('text/plain', String(index))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    dragFromIndex.value = index
  }

  function dragOverCard(index: number, e: DragEvent): void {
    if (dragFromIndex.value === null) return
    e.preventDefault()
    dropTargetIndex.value = index
    const rect = e.currentTarget instanceof HTMLElement ? e.currentTarget.getBoundingClientRect() : null
    dropEdge.value = rect !== null && e.clientY > rect.top + rect.height / DROP_EDGE_MIDPOINT_DIVISOR ? 'after' : 'before'
  }

  function dropCard(index: number, e: DragEvent): void {
    e.preventDefault()
    const from = dragFromIndex.value
    if (from === null) {
      reset()
      return
    }
    const edge = dropTargetIndex.value === index ? (dropEdge.value ?? 'before') : 'before'
    const slot = edge === 'after' ? index + 1 : index
    if (slot !== from && slot !== from + 1) onReorder(from, slot)
    reset()
  }

  function cardClass(index: number): Record<string, boolean> {
    const dragging = dragFromIndex.value !== null
    return {
      'opacity-50': dragFromIndex.value === index,
      'shadow-[inset_0_2px_0_0_var(--accent)]':
        dragging && dropTargetIndex.value === index && dropEdge.value === 'before',
      'shadow-[inset_0_-2px_0_0_var(--accent)]':
        dragging && dropTargetIndex.value === index && dropEdge.value === 'after',
    }
  }

  return { dragFromIndex, dropTargetIndex, dropEdge, startDrag, dragOverCard, dropCard, endDrag: reset, cardClass }
}
