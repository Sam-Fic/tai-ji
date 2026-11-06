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
  ProviderInfo,
} from '@taiji/shared'
import { generateRouteIdFromName } from '@taiji/shared'

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
  /** 新建路由（U9 创建侧：「新建路由」按钮 → 默认草稿卡追加至草稿尾，参与选择默认开）。 */
  | { kind: 'route-add'; route: AggregationRoute }
  /** 删除路由（U9 删除侧：卡头删除确认后上抛；页面转发编排层走 deleteRoute 端口，草稿不乐观改）。 */
  | { kind: 'route-delete'; routeId: string }

/** 端点缺省阈值（spec §7.8：仅额度缺阈值默认 20%）。 */
export const DEFAULT_QUOTA_THRESHOLD_PERCENT = 20

// ── 新建路由默认草稿（U9 创建侧） ──────────────────────────────────────────────────

/** 端点临时 id 短码的数字基数（36 = 10 数字 + 26 字母，紧凑且 URL 安全）。 */
const ID_RADIX = 36
/** 端点临时 id 的抖动量级（短码碰撞域；id 只要求路由内唯一，时间戳已保证主序）。 */
const ID_JITTER_RANGE = 1e4

/** 新端点临时 id（路由内唯一对齐键；时间戳主序 + 短码防碰撞，与既有 endpoint-add 同一形态）。 */
export function newMemberId(): string {
  return `m-${Date.now().toString(ID_RADIX)}-${Math.floor(Math.random() * ID_JITTER_RANGE).toString(ID_RADIX)}`
}

/** buildNewRouteDraft 的输入（默认名由调用方 t() 注入，本模块不依赖 i18n）。 */
export interface NewRouteDraftInput {
  /** 默认显示名（「新路由」；用户可经卡内改名编辑改）。 */
  defaultName: string
  /** 已占用的路由 id 集（草稿 ∪ 视图，唯一性后缀判定基准）。 */
  takenRouteIds: readonly string[]
  /** 渠道目录（预填端点的种子源；候选语义同 candidateProviderIds 的启用判定）。 */
  providers: ReadonlyArray<Pick<ProviderInfo, 'id' | 'enabled' | 'models'>>
}

/**
 * 新建路由的默认草稿（U9 创建侧，GL5/V15）：
 * - id 缺省从名称生成（generateRouteIdFromName 既有形态）+ 既有 id 唯一性后缀（-2/-3…）；
 *   modelId 同值生成（编辑器恒与 id 同值的既有形态）。
 * - 端点预填第一个可用渠道的模型端点（无条件，endpoint-add 同形态）——保存校验要求
 *   至少一个端点，且 candidateProviderIds 按 route.modelId 过滤候选，预填真实模型是
 *   「创建后即可继续添加端点并保存」的唯一自洽初值。无可用渠道时落零端点草稿（保存被
 *   「至少一个端点」校验显式拒绝，不产假可保存态）。
 * - mode = 'advanced'（创建侧默认值）；enabled = true；specials = 空。
 */
export function buildNewRouteDraft(input: NewRouteDraftInput): AggregationRoute {
  const base = generateRouteIdFromName(input.defaultName)
  let id = base
  let suffix = 2
  const taken = new Set(input.takenRouteIds)
  while (taken.has(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  const seed = input.providers.find((p) => p.enabled !== false && p.models.length > 0)
  return {
    id,
    name: input.defaultName,
    modelId: seed?.models[0]?.id ?? id,
    enabled: true,
    mode: 'advanced',
    members: seed
      ? [{ id: newMemberId(), providerId: seed.id, modelId: seed.models[0]!.id, type: 'none' }]
      : [],
    specials: [],
  }
}
