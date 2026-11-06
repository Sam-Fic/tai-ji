/**
 * 模型路由页求值预览纯函数（provider-aggregation U5b · D14「覆盖预览 + 此刻权威展示」的逻辑半边）。
 *
 * 分工边界（D14 / spec §7.7 语义边界）：时间轴着色是「时间窗覆盖预览」而非完整求值结果
 *（不消费运行时状态）；卡头「此刻」chip 按真实时钟对当前坐标求值命中端点，是求值语义的
 * 可视权威。两者共用本模块，与 pi 扩展求值函数（U2 router.ts）语义对齐但各自实现——
 * UI 预览不 import 扩展侧代码（包边界），穷举语义一致性由同源坐标契约（shared
 * aggregation.ts TIME_WINDOW 常量）与单测对拍守护。
 *
 * 时间机制红线对齐（ADR-0190）：本模块零定时器。「实时」语义 = 打开/展开路由页时点取
 * 墙钟求值一次（事件驱动：组件 mount 传入），不做周期刷新。
 */
import type {
  AggregationMember,
  AggregationRoute,
  AggregationSpecialDate,
  AggregationTimeWindowTable,
} from '@taiji/shared'
import type { ProviderInfo } from '@taiji/shared'
import { annotateDanglingMembers } from '@taiji/shared'

/** 时间窗表维度（shared aggregation.ts 坐标契约同源，禁止另定坐标系）。 */
export const DAY_COUNT = 7
export const SLOT_COUNT = 48

/** 一天 30 分钟格数下的一刻钟粒度换算常量（slot = floor(分钟 / 30)）。 */
const MINUTES_PER_SLOT = 30

/** 一小时分钟数（时间换算中间量）。 */
const MINUTES_PER_HOUR = 60

/** 一天小时数（slot 换算中间量）。 */
const HOURS_PER_DAY = 24

/** `HH:mm` 各段时间位宽度（padStart 位宽）。 */
const TIME_PART_PAD = 2

/** JS getDay()（周日=0）→ ISO dow（周一=0..周日=6）的取模偏移。 */
const JS_SUNDAY_TO_ISO_OFFSET = 6

/** 工作日数（周一..周五的 ISO dow 行下标集，0-4）。 */
const WORKDAY_DOW_COUNT = 5

/** 连续 dow 行下标集 [0, n)（paintRange 的天数坐标输入）。 */
function dowRange(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

const WORKDAY_DOWS = dowRange(WORKDAY_DOW_COUNT)
const ALL_DOWS = dowRange(DAY_COUNT)

/**
 * 「此刻」求值坐标：dow 0-6 = 周一..周日（ISO 8601 顺序，时间窗表行下标同构）；
 * slot 0-47 = 当日 00:00 起每 30 分钟一格（时间窗表列下标同构）。
 */
export interface RouteNow { // oe-exempt:20261106:framework:评测纯函数类型契约，单实现为设计终态
  dow: number
  slot: number
}

/** 求值可选输入（M2 额度接线前的缺省形态：额度数据未知 = fail-open）。 */
export interface RouteEvalOptions { // oe-exempt:20261106:framework:评测纯函数类型契约，单实现为设计终态
  /**
   * 额度数据供给：providerId → 套餐剩余百分比；返回 undefined = 数据未知（该条件按
   * 满足处理，D5 fail-open）。M1 缺省不传（额度刷新 M2 接线），M2 接线后由上层注入。
   */
  quotaOf?: (providerId: string) => number | undefined
  /**
   * 「今天」的本地日期 `YYYY-MM-DD`（特殊日期匹配键）。缺省 = 调用时点墙钟；测试注入
   * 固定值保证确定性（不依赖真机日期）。
   */
  nowDate?: string
}

/** 墙钟 → 路由坐标（本地时区；dow 转 ISO 顺序：JS getDay() 周日=0 → ISO 周一=0..周日=6）。 */
export function nowFromClock(d: Date): RouteNow {
  const dow = (d.getDay() + JS_SUNDAY_TO_ISO_OFFSET) % DAY_COUNT
  const slot = Math.floor((d.getHours() * MINUTES_PER_HOUR + d.getMinutes()) / MINUTES_PER_SLOT)
  return { dow, slot }
}

/** 本地日期 `YYYY-MM-DD`（特殊日期匹配键；调用时点墙钟）。 */
export function todayLocalIso(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(TIME_PART_PAD, '0')
  const dd = String(d.getDate()).padStart(TIME_PART_PAD, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** `HH:mm` → slot（非法输入落 0；编辑器输入侧另行校验，本函数只做展示换算）。 */
export function slotFromTime(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  const hours = Number(h)
  const minutes = Number(m)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0
  return Math.min(SLOT_COUNT - 1, Math.floor((hours * MINUTES_PER_HOUR + minutes) / MINUTES_PER_SLOT))
}

/** slot → `HH:mm`（格起点；48 → '24:00' 标尺末位）。 */
export function fmtSlot(slot: number): string {
  const total = slot * MINUTES_PER_SLOT
  const h = Math.floor(total / MINUTES_PER_HOUR) % HOURS_PER_DAY
  const m = total % MINUTES_PER_HOUR
  return `${String(h).padStart(TIME_PART_PAD, '0')}:${String(m).padStart(TIME_PART_PAD, '0')}`
}

/** slot → `HH:mm–HH:mm`（格区间，末格封口 24:00）。 */
export function fmtSlotRange(slot: number): string {
  const start = fmtSlot(slot)
  const end = slot + 1 >= SLOT_COUNT ? '24:00' : fmtSlot(slot + 1)
  return `${start}–${end}`
}

// ── 特殊日期（D13 双型；求值优先于周表） ────────────────────────────────────────────

/** 日期匹配：同日期多条覆盖取第一条（spec 已知限制，去重合并留实施期）。 */
export function specialOverrideFor(
  specials: readonly AggregationSpecialDate[],
  isoDate: string,
): AggregationSpecialDate | undefined {
  return specials.find((s) => s.date === isoDate)
}

/** include 型区间判定：slot ∈ [from, to)。 */
function withinSpecialWindow(sp: AggregationSpecialDate, slot: number): boolean {
  const from = slotFromTime(sp.from ?? '00:00')
  const to = slotFromTime(sp.to ?? '00:00')
  return slot >= from && slot < to
}

/**
 * 时间窗判定（单端点 @ 单格）：特殊日期优先于周表（D13）——exclude 全天判窗外；
 * include 仅区间内判窗内、区间外回落周表；无特殊日期按周表。
 */
export function isWindowAt(member: AggregationMember, now: RouteNow, route: AggregationRoute, nowDate: string): boolean {
  if (!member.window) return false
  const sp = specialOverrideFor(route.specials, nowDate)
  if (sp) {
    if (sp.mode === 'exclude') return false
    if (withinSpecialWindow(sp, now.slot)) return true
  }
  return member.window[now.dow]?.[now.slot] === true
}

// ── 此刻求值（evaluateRouteAt · 卡头「此刻」chip 权威展示） ─────────────────────────

/** 单端点求值结论（steps 序列元素，逐端点落选原因可见——AX5 呈现分层）。 */
export interface RouteEvalStep { // oe-exempt:20261106:framework:评测纯函数类型契约，单实现为设计终态
  member: AggregationMember
  index: number
  ok: boolean
  /** 该端点被跳过（前面的端点已命中）时 true。 */
  skipped?: boolean
  reason: RouteEvalReason
}

/** 求值原因词表（UI chip / aria-label / 落选明细共用）。 */
export type RouteEvalReason =
  | 'mode-simple'
  | 'unconditional'
  | 'in-window'
  | 'out-window'
  | 'quota-ok'
  | 'quota-low'
  | 'quota-unknown-open'
  | 'after-hit'

/** 此刻求值结果：hit = 命中端点（null = 无可用端点）。 */
export interface RouteEvalResult { // oe-exempt:20261106:framework:评测纯函数类型契约，单实现为设计终态
  hit: AggregationMember | null
  hitIndex: number | null
  steps: RouteEvalStep[]
}

/**
 * 路由此刻求值（D5 矩阵 UI 预览半边）：simple 恒取第一个端点不判条件；advanced 从第一个
 * 端点起命中第一个条件满足者即停。quota 数据未知按满足（fail-open，D5）——reason 单列
 * 'quota-unknown-open' 供 UI 区分「数据在且满足」与「数据未知放行」两种呈现。
 */
export function evaluateRouteAt(
  route: AggregationRoute,
  now: RouteNow,
  options: RouteEvalOptions = {},
): RouteEvalResult {
  const nowDate = options.nowDate ?? todayLocalIso()
  const steps: RouteEvalStep[] = []
  let hit: AggregationMember | null = null
  let hitIndex: number | null = null
  route.members.forEach((member, index) => {
    if (hit !== null) {
      steps.push({ member, index, ok: true, skipped: true, reason: 'after-hit' })
      return
    }
    if (route.mode === 'simple') {
      hit = member
      hitIndex = index
      steps.push({ member, index, ok: true, reason: 'mode-simple' })
      return
    }
    const verdict = evaluateCondition(member, route, now, nowDate, options)
    steps.push({ member, index, ok: verdict.ok, reason: verdict.reason })
    if (verdict.ok) {
      hit = member
      hitIndex = index
    }
  })
  return { hit, hitIndex, steps }
}

/** 单端点条件求值（D5：时间窗 × 额度 × 无条件；combo 需同时满足）。 */
function evaluateCondition(
  member: AggregationMember,
  route: AggregationRoute,
  now: RouteNow,
  nowDate: string,
  options: RouteEvalOptions,
): { ok: boolean; reason: RouteEvalReason } {
  if (member.type === 'none') return { ok: true, reason: 'unconditional' }
  let timeOk = true
  let timeReason: RouteEvalReason = 'in-window'
  let quotaOk = true
  let quotaReason: RouteEvalReason = 'quota-ok'
  if (member.type === 'window' || member.type === 'combo') {
    timeOk = isWindowAt(member, now, route, nowDate)
    timeReason = timeOk ? 'in-window' : 'out-window'
  }
  if (member.type === 'quota' || member.type === 'combo') {
    const pct = options.quotaOf?.(member.providerId)
    if (pct === undefined) {
      quotaOk = true
      quotaReason = 'quota-unknown-open'
    } else {
      quotaOk = pct >= (member.quota?.thresholdPercent ?? 0)
      quotaReason = quotaOk ? 'quota-ok' : 'quota-low'
    }
  }
  if (member.type === 'window') return { ok: timeOk, reason: timeReason }
  if (member.type === 'quota') return { ok: quotaOk, reason: quotaReason }
  if (!timeOk) return { ok: false, reason: timeReason }
  if (!quotaOk) return { ok: false, reason: quotaReason }
  return { ok: true, reason: quotaReason === 'quota-unknown-open' ? 'in-window' : quotaReason }
}

// ── 覆盖预览着色（coverOwnersAt · 时间轴穷举对照表，D14） ───────────────────────────

/**
 * 单格覆盖 owner 集：被可达时间窗端点覆盖的端点序列（多端点 = 多色条纹）。截断语义
 *（C2 修订）：在第一个「无条件」端点处停止——排在它后面的时间窗不会命中，不着色；
 * 仅额度端点不进时间轴（spec §7.7）；simple 模式不判条件但条件数据保留显示——覆盖
 * 预览仍按窗表着色（切回 advanced 恢复语义一致）。
 */
export function coverOwnersAt(route: AggregationRoute, dow: number, slot: number, nowDate: string = todayLocalIso()): AggregationMember[] {
  const owners: AggregationMember[] = []
  for (const member of route.members) {
    if (member.type === 'none') break
    const isWindowKind = member.type === 'window' || member.type === 'combo'
    if (isWindowKind && isWindowAt(member, { dow, slot }, route, nowDate)) owners.push(member)
  }
  return owners
}

/** 兜底端点 = 第一个「无条件」端点（spec §7.7：仅额度端点不作为兜底）。 */
export function fallbackMemberOf(route: AggregationRoute): AggregationMember | null {
  return route.members.find((m) => m.type === 'none') ?? null
}

/**
 * 截断警告数据：null = 无无条件端点（显示「无兜底」条，非截断警告）；unconditionalIndex =
 * 第一个无条件端点位置；suppressedAfter = 其后还有 window/combo 端点（true → 时间轴顶部
 * 警告「第 N 个端点是无条件端点，排在它后面的时间窗不会命中」）。
 */
export function truncationInfo(route: AggregationRoute): { unconditionalIndex: number; suppressedAfter: boolean } | null {
  const idx = route.members.findIndex((m) => m.type === 'none')
  if (idx < 0) return null
  const suppressedAfter = route.members
    .slice(idx + 1)
    .some((m) => m.type === 'window' || m.type === 'combo')
  return { unconditionalIndex: idx, suppressedAfter }
}

/** 端点是否会截断后续端点（非最后位的无条件端点，spec §7.8 行内标记）。 */
export function truncatesAfter(route: AggregationRoute, index: number): boolean {
  return route.members[index]?.type === 'none' && index < route.members.length - 1
}

/** 端点是否位于第一个无条件端点之后（不会命中标记，spec §7.8）。 */
export function suppressedByEarlierUnconditional(route: AggregationRoute, index: number): boolean {
  const idx = route.members.findIndex((m) => m.type === 'none')
  return idx >= 0 && idx < index
}

// ── 端点展示态（spec §4.5 配置保留优先：异常标记不剔除求值） ────────────────────────

/** 端点异常词表（i18n 键段 + 语义分级消费）。 */
export type EndpointIssueKind = 'provider-deleted' | 'model-removed' | 'provider-disabled' | 'no-key'

/**
 * 逐端点异常标记（memberIndex → 异常词表）。
 *
 * provider-deleted / model-removed 复用 shared annotateDanglingMembers 单点判定（有效模型
 * 索引从 ProviderInfo 快照构建——与 U1 悬空标记同一函数，杜绝两处漂移）；provider-disabled /
 * no-key 是 UI 展示层附加态（设计 D9：禁用渠道路由仍在使用，标记不剔除）。
 */
export function endpointIssueKinds(
  route: AggregationRoute,
  providers: readonly ProviderInfo[],
): Map<number, EndpointIssueKind[]> {
  const validModels = new Map<string, Set<string>>()
  for (const p of providers) {
    validModels.set(p.id, new Set(p.models.map((m) => m.id)))
  }
  const dangling = annotateDanglingMembers([route], validModels)
  const result = new Map<number, EndpointIssueKind[]>()
  const byProvider = new Map<string, ProviderInfo>(providers.map((p) => [p.id, p]))
  route.members.forEach((member, index) => {
    const kinds: EndpointIssueKind[] = []
    const reason = dangling.find((issue) => issue.memberIndex === index)?.reason
    if (reason === 'provider-deleted') kinds.push('provider-deleted')
    if (reason === 'model-removed') kinds.push('model-removed')
    const provider = byProvider.get(member.providerId)
    if (provider !== undefined && provider.enabled === false) kinds.push('provider-disabled')
    if (provider !== undefined && provider.apiKeySet === false) kinds.push('no-key')
    if (kinds.length > 0) result.set(index, kinds)
  })
  return result
}

/** 端点异常词表 → i18n 键段（异常 chip 文案键；供组件 t() 拼接）。 */
export function endpointIssueKey(kind: EndpointIssueKind): string {
  return `settings.modelRoute.issue.${kind}`
}

// ── 档位并集（D7） ──────────────────────────────────────────────────────────────────

/** thinking 档位序（pi EXTENDED_THINKING_LEVELS 七档全集；并集按此序输出）。 */
const THINKING_LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * 路由档位并集（D7：各端点 levels 声明并集；null 值键 = 不支持，不入并集；缺省端点 =
 * 空集）。输出按档位序排列。
 */
export function levelsUnion(route: AggregationRoute): string[] {
  const supported = new Set<string>()
  for (const member of route.members) {
    if (!member.levels) continue
    for (const [level, ok] of Object.entries(member.levels)) {
      if (ok !== null && ok !== undefined) supported.add(level)
    }
  }
  return THINKING_LEVEL_ORDER.filter((l) => supported.has(l))
}

// ── 时间窗表构造（快捷涂抹与默认窗共用，坐标契约 7×48） ─────────────────────────────

/** 全空时间窗表。 */
export function blankWindowTable(): AggregationTimeWindowTable {
  return Array.from({ length: DAY_COUNT }, () => Array.from({ length: SLOT_COUNT }, () => false))
}

/** 区间涂真（[fromSlot, toSlot)；跨 0 点不处理——编辑器按两天各自格表达，spec §7.7）。 */
function paintRange(table: AggregationTimeWindowTable, days: readonly number[], fromSlot: number, toSlot: number): void {
  for (const day of days) {
    for (let slot = fromSlot; slot < toSlot && slot < SLOT_COUNT; slot++) {
      table[day]![slot] = true
    }
  }
}

/** 工作日白天窗：周一~五 09:00-18:00（快捷涂抹「工作日白天」同源缺省窗，spec §7.8）。 */
export function weekdayBusinessWindow(): AggregationTimeWindowTable {
  const table = blankWindowTable()
  paintRange(table, WORKDAY_DOWS, slotFromTime('09:00'), slotFromTime('18:00'))
  return table
}

/** 夜间窗：每天 18:00-24:00 + 00:00-02:00（快捷涂抹「夜间」同源，demo 同款定义）。 */
export function nightWindow(): AggregationTimeWindowTable {
  const table = blankWindowTable()
  paintRange(table, ALL_DOWS, slotFromTime('18:00'), SLOT_COUNT)
  paintRange(table, ALL_DOWS, slotFromTime('00:00'), slotFromTime('02:00'))
  return table
}

// ── 添加端点候选（spec §7.9：存在 / 启用 / 提供该模型 / 未被本路由占用） ────────────

/** 换渠道候选（端点行下拉）：当前渠道即使不满足条件也保留（异常标注，spec §7.8）。 */
export function endpointProviderOptions(
  route: AggregationRoute,
  member: AggregationMember,
  providers: readonly ProviderInfo[],
): Array<{ provider: ProviderInfo; issues: EndpointIssueKind[] }> {
  const usedByOthers = new Set(route.members.filter((m) => m.id !== member.id).map((m) => m.providerId))
  const issues = endpointIssueKinds(route, providers)
  const out: Array<{ provider: ProviderInfo; issues: EndpointIssueKind[] }> = []
  for (const p of providers) {
    if (usedByOthers.has(p.id)) continue
    const memberIndex = route.members.findIndex((m) => m.id === member.id)
    const memberIssues = issues.get(memberIndex) ?? []
    if (p.id === member.providerId) {
      out.push({ provider: p, issues: memberIssues })
      continue
    }
    if (p.enabled === false) continue
    if (!p.models.some((m) => m.id === route.modelId)) continue
    if (memberIssues.length > 0) continue
    out.push({ provider: p, issues: [] })
  }
  return out
}

/** 添加端点候选 provider id 序（存在 / 启用 / 提供该模型 / 未被本路由占用，spec §7.9）。 */
export function candidateProviderIds(route: AggregationRoute, providers: readonly ProviderInfo[]): string[] {
  const used = new Set(route.members.map((m) => m.providerId))
  return providers
    .filter(
      (p) =>
        !used.has(p.id) &&
        p.enabled !== false &&
        p.models.some((m) => m.id === route.modelId),
    )
    .map((p) => p.id)
}
