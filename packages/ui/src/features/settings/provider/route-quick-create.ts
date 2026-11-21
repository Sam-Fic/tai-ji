/**
 * 快速创建路由草稿构建器（模型路由页快速创建面板 · spec §4.5/§4.6/§7.2）。
 *
 * 纯函数模块：面板组件与页面层共用的「一次点击生成完整草稿」构建逻辑——
 * 简单路由（单模型无条件单端点）/ 高级路由（多模型全无条件多端点，勾选序）。
 * 产出 AggregationRoute 草稿，经既有 route-add 指令进页面草稿，保存链路照走
 * validateAggregationRouteUpsert 形态校验（零改动）。
 *
 * levels 契约（spec §5.4 / D7）：端点 levels 是**支持声明**——快速创建初始化为该模型
 * 全部支持档位（`{ [level]: level }`，router 只消费 key 与 null 语义）；supportedLevels
 * 缺省（能力标注链路失败的过渡态）时 levels 整体缺省（档位未知，不伪装成全支持）。
 */
import type { AggregationMember, AggregationRoute } from '@taiji/shared'
import { generateRouteIdFromName } from '@taiji/shared'
import { newMemberId } from './route-editor-ops'

/** 路由 id 长度上界（= extension-protocol ROUTE_ID_MAX_LENGTH，约束同源镜像）。 */
const ID_MAX = 64

/** 快速创建选中的一个模型（渠道 + 模型 + 展示元数据，勾选序承载于数组序）。 */
export interface QuickPickModel { // oe-exempt:20261121:framework:快速创建跨文件形状契约（builder/组件/composable/测试多消费方，单实现为设计终态）
  providerId: string
  modelId: string
  /** 模型显示名（name ?? id；命名规则消费）。 */
  modelDisplayName: string
  /** 该模型支持档位（ProviderInfo.models[].supportedLevels 原样；缺省 = 档位未知）。 */
  supportedLevels?: readonly string[]
}

/**
 * 模型全部支持档位 → levels 支持声明（`{ [level]: level }`）。
 * supportedLevels 缺省/空 → undefined（端点档位未知，schema 允许缺省）。
 */
export function levelsFromSupported(
  supportedLevels?: readonly string[],
): Record<string, string> | undefined {
  const levels = supportedLevels?.filter((l) => l !== '')
  if (!levels || levels.length === 0) return undefined
  return Object.fromEntries(levels.map((l) => [l, l]))
}

/** 端点条目（type=none + levels 支持声明；快速创建两端点形态同构，spec §7.2）。 */
export function quickMember(pick: QuickPickModel): AggregationMember {
  return {
    id: newMemberId(),
    providerId: pick.providerId,
    modelId: pick.modelId,
    type: 'none',
    levels: levelsFromSupported(pick.supportedLevels),
  }
}

/** 名称去重：与已占用名重复时追加 ` 2`/` 3`…（spec §4.5；先 trim 对齐展示口径）。 */
export function uniqueDisplayName(base: string, taken: ReadonlySet<string>): string {
  const trimmed = base.trim() === '' ? 'route' : base.trim()
  if (!taken.has(trimmed)) return trimmed
  let suffix = 2
  while (taken.has(`${trimmed} ${suffix}`)) suffix += 1
  return `${trimmed} ${suffix}`
}

/**
 * 路由 id 去重：generateRouteIdFromName（kebab + ≤64 截断内建）+ 冲突后缀 -2/-3…。
 * 后缀追加在截断之后做（修剪 P5）：base 截满 64 时先缩 base 再拼后缀，产物恒 ≤64
 * 且过 isValidRouteId（否则保存报 route_id_invalid、草稿丢失且错误指向用户未输入的 id）。
 */
export function uniqueRouteId(base: string, taken: ReadonlySet<string>): string {
  const slug = generateRouteIdFromName(base)
  if (!taken.has(slug)) return slug
  let suffix = 2
  while (true) {
    // 64 = ROUTE_ID_MAX_LENGTH；'-'.length + suffix 位宽先预留，base 前段截缩
    const room = ID_MAX - 1 - String(suffix).length
    const candidate = `${slug.slice(0, room)}-${suffix}`
    if (!taken.has(candidate)) return candidate
    suffix += 1
  }
}

/** buildSimpleQuickRoute 输入。 */
export interface SimpleQuickRouteInput { // oe-exempt:20261121:framework:快速创建跨文件形状契约（builder/组件/composable/测试多消费方，单实现为设计终态）
  /** 所点模型行（渠道 + 模型 + 元数据）。 */
  pick: QuickPickModel
  /** 已占用路由 id / 显示名（草稿 ∪ 视图；唯一性判定基准）。 */
  takenRouteIds: readonly string[]
  takenNames: readonly string[]
}

/**
 * 单模型简单路由草稿（spec §4.5）：mode=simple、单端点无条件、levels=全支持档、
 * name=模型显示名（重名序号）、id 从模型 id 生成、enabled=true、specials=[]。
 */
export function buildSimpleQuickRoute(input: SimpleQuickRouteInput): AggregationRoute {
  const takenIds = new Set(input.takenRouteIds)
  const takenNames = new Set(input.takenNames)
  const name = uniqueDisplayName(input.pick.modelDisplayName, takenNames)
  const id = uniqueRouteId(input.pick.modelId, takenIds)
  return {
    id,
    name,
    modelId: id,
    enabled: true,
    mode: 'simple',
    members: [quickMember(input.pick)],
    specials: [],
  }
}

/** buildAdvancedQuickRoute 输入。 */
export interface AdvancedQuickRouteInput { // oe-exempt:20261121:framework:快速创建跨文件形状契约（builder/组件/composable/测试多消费方，单实现为设计终态）
  /** 勾选序模型集（≥2 由面板入口约束；本函数不重复校验）。 */
  picks: readonly QuickPickModel[]
  /** 渠道显示名查找（命名规则「渠道名 多模型」消费）。 */
  providerNameOf: (providerId: string) => string
  /** 当前筛选词（跨渠道且有词 → 「筛选词 路由」；空/纯空格 = 无词）。 */
  filterKeyword: string
  takenRouteIds: readonly string[]
  takenNames: readonly string[]
}

/** 高级路由默认名（spec §4.6 三规则：同渠道 / 跨渠道有筛选词 / 跨渠道无词）。 */
export function advancedRouteName(input: AdvancedQuickRouteInput): string {
  const keyword = input.filterKeyword.trim()
  const providers = new Set(input.picks.map((p) => p.providerId))
  if (providers.size === 1) {
    return `${input.providerNameOf([...providers][0]!)} 多模型`
  }
  return keyword === '' ? '多模型路由' : `${keyword} 路由`
}

/**
 * 多模型高级路由草稿（spec §4.6）：mode=advanced、端点按勾选序全无条件 + 全支持档 levels、
 * enabled=true、specials=[]、name/id 按规则生成（id 由模型 id 拼接，生成器截断 64）。
 */
export function buildAdvancedQuickRoute(input: AdvancedQuickRouteInput): AggregationRoute {
  const takenIds = new Set(input.takenRouteIds)
  const takenNames = new Set(input.takenNames)
  const name = uniqueDisplayName(advancedRouteName(input), takenNames)
  const id = uniqueRouteId(input.picks.map((p) => p.modelId).join('-'), takenIds)
  return {
    id,
    name,
    modelId: id,
    enabled: true,
    mode: 'advanced',
    members: input.picks.map(quickMember),
    specials: [],
  }
}

/** 「用于 m 条路由」统计键（口径 = 仅路由，不含渠道直连条目，spec §4.8）。 */
export function quickPickKey(providerId: string, modelId: string): string {
  return `${providerId}\n${modelId}`
}

/** 路由集合 → usage 计数表（quickPickKey → 出现路由数）。 */
export function buildUsageIndex(routes: readonly AggregationRoute[]): Map<string, number> {
  const usage = new Map<string, number>()
  for (const route of routes) {
    for (const member of route.members) {
      const key = quickPickKey(member.providerId, member.modelId)
      usage.set(key, (usage.get(key) ?? 0) + 1)
    }
  }
  return usage
}
