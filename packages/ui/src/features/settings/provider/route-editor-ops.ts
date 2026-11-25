/**
 * 路由页编辑操作指令契约（provider-aggregation U5b）：子组件 emit、页面草稿层
 * （ModelRoutePage.applyEditorOp）执行的唯一更新通道。
 *
 * 数据流形态：草稿所有权在页面层（Vue 单向数据流，vue/no-mutating-props 红线）——
 * 子组件对草稿的每个编辑意图都折叠为一条 typed 指令上抛，页面集中执行后经响应式
 * 回灌子组件。这是「唯一更新入口」规约的 UI 层落点：草稿变更只发生在 applyEditorOp
 * 一处，指令词表 = 编辑动作全集（新增编辑动作先进本词表再接线）。
 */
import type {
  AggregationMember,
  AggregationRoute,
  AggregationSpecialDate,
  AggregationTimeWindowTable,
} from '@taiji/shared'

/**
 * 分布式 Omit（union 成员逐个剥键）：Omit 对 union 取键交集会抹掉各成员特有键，
 * op 构造辅助（子组件 opWith）需要按成员保留 patch/type/day 等字段，必须分布式。
 */
export type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 带 memberIndex 的编辑指令子集（端点定位族）。 */
export type MemberEditorOp = Extract<RouteEditorOp, { memberIndex: number }>

/** MemberEditorOp 去定位键后的构造入参形态（子组件 opWith 的实参类型）。 */
export type MemberOpInput = DistributedOmit<MemberEditorOp, 'routeId' | 'memberIndex'>

/** 端点条件/渠道等字段的就地补丁（id 不可变——端点条目 id 是路由内对齐键）。 */
export type AggregationMemberPatch = Partial<Omit<AggregationMember, 'id'>>

/** 路由级字段补丁（id 不可变——路由 id 是 set_model/会话还原/目录注入的对齐键）。 */
export type AggregationRoutePatch = Partial<Pick<AggregationRoute, 'name' | 'enabled' | 'mode' | 'modelId'>>

/** 编辑操作指令词表（kind 穷举，新增动作先登记再消费）。 */
export type RouteEditorOp =
  /** 路由级字段（启停/模式/名称）。 */
  | { kind: 'route-patch'; routeId: string; patch: AggregationRoutePatch }
  /** 添加端点（providerId 已由子组件候选约束）。 */
  | { kind: 'endpoint-add'; routeId: string; providerId: string }
  /** 删除端点（最后端点保护由子组件承担）。 */
  | { kind: 'endpoint-remove'; routeId: string; memberIndex: number }
  /** 端点排序。 */
  | { kind: 'endpoint-move'; routeId: string; memberIndex: number; dir: 'up' | 'down' }
  /** 端点字段补丁（渠道/条件类型/阈值等）。 */
  | { kind: 'endpoint-patch'; routeId: string; memberIndex: number; patch: AggregationMemberPatch }
  /** 条件类型切换（切窗型缺表补工作日窗、缺阈值补默认——spec §7.8 切换语义表）。 */
  | { kind: 'endpoint-condition-type'; routeId: string; memberIndex: number; type: AggregationMember['type'] }
  /** 时间轴涂抹单格（拖选涂/擦；value = 目标态）。 */
  | { kind: 'endpoint-window-set'; routeId: string; memberIndex: number; day: number; slot: number; value: boolean }
  /** 时间轴橡皮（清除该格全部窗端点）。 */
  | { kind: 'endpoint-window-erase-cell'; routeId: string; day: number; slot: number }
  /** 快捷涂抹/条件切换缺表补默认（整表替换）。 */
  | { kind: 'endpoint-window-replace'; routeId: string; memberIndex: number; table: AggregationTimeWindowTable }
  /** 新增特殊日期覆盖。 */
  | { kind: 'special-add'; routeId: string; special: AggregationSpecialDate }
  /** 删除特殊日期覆盖。 */
  | { kind: 'special-remove'; routeId: string; index: number }
  /** 新建路由（快速创建面板 → 草稿卡追加至草稿尾，参与选择默认开，spec §4.5/§4.6）。 */
  | { kind: 'route-add'; route: AggregationRoute }
  /** 删除路由（U9 删除侧：卡头删除确认后上抛；页面转发编排层走 deleteRoute 端口，草稿不乐观改）。 */
  | { kind: 'route-delete'; routeId: string }
  /** 添加渠道直连模型（快速创建面板模型行「加直连」→ 草稿追加直连卡，参与选择默认开）。
   *  落卡态 = scopedModels 白名单条目（保存经 scopedRefs 整表覆写生效，无 routes 定义）。 */
  | { kind: 'direct-add'; providerId: string; modelId: string }
  /** 移除渠道直连卡（直连卡移除按钮 → 草稿摘除；已落盘条目的白名单清理由保存承载）。
   *  ref = 直连卡复合串（草稿内唯一键；路由卡不受影响）。 */
  | { kind: 'direct-remove'; ref: string }

/** 端点缺省阈值（spec §7.8：仅额度缺阈值默认 20%）。 */
export const DEFAULT_QUOTA_THRESHOLD_PERCENT = 20

// ── 端点临时 id（快速创建与新端点条目共用形态） ──────────────────────────────

/** 端点临时 id 短码的数字基数（36 = 10 数字 + 26 字母，紧凑且 URL 安全）。 */
const ID_RADIX = 36
/** 端点临时 id 的抖动量级（短码碰撞域；id 只要求路由内唯一，时间戳已保证主序）。 */
const ID_JITTER_RANGE = 1e4

/** 新端点临时 id（路由内唯一对齐键；时间戳主序 + 短码防碰撞，快速创建草稿同源）。 */
export function newMemberId(): string {
  return `m-${Date.now().toString(ID_RADIX)}-${Math.floor(Math.random() * ID_JITTER_RANGE).toString(ID_RADIX)}`
}

// ── 卡片重排（拖拽排序数据层；上移/下移按钮与拖拽共用同一草稿数组语义） ──────────────

/**
 * 把 from 位置的卡片移动到插入槽位 slot（slot = 目标边界在原坐标系的插入位置，0..length）。
 * 纯函数返回新数组（不就地改），供 ModelRoutePage 拖拽排序（HTML5 DnD drop 落点换算后的
 * 数据层执行）与测试直接消费。越界或无位移（slot === from 或 slot === from + 1）时返回
 * 等值副本——调用方据引用是否变化可跳过标脏。
 */
export function moveCardToSlot<T>(list: readonly T[], from: number, slot: number): T[] {
  if (from < 0 || from >= list.length || slot < 0 || slot > list.length) return [...list]
  if (slot === from || slot === from + 1) return [...list]
  const next = [...list]
  const [moved] = next.splice(from, 1)
  // from 元素已摘除，slot 若在其后方需左移一位才是删除后坐标系的目标下标
  next.splice(from < slot ? slot - 1 : slot, 0, moved!)
  return next
}
