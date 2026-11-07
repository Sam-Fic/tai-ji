/**
 * 模型路由（aggregation model）配置域契约根：类型全集 + 校验/标记纯函数。
 *
 * 本文件是路由配置 schema 的唯一定义点（设计 provider-aggregation D2「schema 一次定形，
 * 字段只加不改」——M2 额度接线 / M3 特殊日期编辑器只接线不迁移）；runtime 写侧校验、
 * 路由页视图编排（U9）、设置页 UI（U5）、选择器呈现（U6）与 pi 路由扩展（U2）共用同一套
 * 类型与判别语义，杜绝多端漂移（network-proxy / retry-rules 域同款纪律）。
 *
 * 权威分层（设计 D2/D10/AX1）：路由配置落 providers.json 顶层 routes 键（taiji 扩展域文件，
 * pi 引擎零消费——前提 AS20），是端点与条件的唯一权威；scopedModels 是可选性与顺序的正交
 * 权威（字段与全部读点零改动）。本模块只承载 routes 域形状与纯判别，不做任何 IO。
 *
 * 持久化形态（D2）：外层键 routes，值 = { version: 1, routes: [...] }——外层键与内层集合
 * 字段同名，沿外部 UI spec 数据模型命名（routes/members/specials/mode）。读写唯一层 =
 * runtime provider-extras-store（复用既有文件锁 + 原子写，唯一写点）；扩展侧只读。
 */

/** 聚合 provider 固定保留 id（D4 ③）：单一固定 id 聚合 provider 承载全部模型路由（models
 * 数组多条目）。用户 provider 保存校验排除与本 id 撞名（实施期定形：取项目 kebab 小写
 * id 惯用形态）——接线点 = provider 写侧两处：setProvider 新建分支（编辑既有条目不受
 * 影响）与 provider-importer 导入路径。通道形态区分：错误码 AGGREGATION_PROVIDER_ID_RESERVED
 * 仅 setProvider wire 通道使用（errorWithCode → error envelope）；provider-importer 的
 * 两处拒绝（主导入 + 孤儿凭据路径）走失败清单 failed 条目的 reason 文案形态（与其
 * 失败回执一致，不经错误码），两处拦截同一保留 id、同规则。 */
export const AGGREGATION_PROVIDER_ID = 'aggregation'

/** provider 新建/导入撞保留 id 的 wire error envelope code 词表（D4 ③）：runtime 写侧
 * 拒绝时以 errorWithCode 携带此 code 上抛，server 全局 catch 透传 error envelope；
 * 值域单值，扩码只加不改（D2 同承诺）。 */
export type AggregationProviderIdErrorCode = 'aggregation_provider_id_reserved'

export const AGGREGATION_PROVIDER_ID_RESERVED: AggregationProviderIdErrorCode = 'aggregation_provider_id_reserved'

export const AGGREGATION_PROVIDER_ID_ERROR_CODES: readonly AggregationProviderIdErrorCode[] = ['aggregation_provider_id_reserved']

/** routes 域外层结构版本（独立于 providers.json 文件级 version——routes schema 演进走
 * 自己的版本号，字段只加不改承诺下当前恒 1）。 */
export type AggregationRoutesVersion = 1

export const AGGREGATION_ROUTES_VERSION: AggregationRoutesVersion = 1

/** 时间窗表维度：7 行（周一..周日）× 48 列（半小时格）——坐标契约常量，求值/编辑器/校验三处同源。 */
export const TIME_WINDOW_DAYS = 7
export const TIME_WINDOW_SLOTS_PER_DAY = 48

/** 端点额度阈值百分比上界（0-100；100 = 恒耗尽判据，V3 场景技巧）。 */
export const AGGREGATION_QUOTA_THRESHOLD_MAX = 100

/**
 * 时间窗表：7 行 × 48 列布尔矩阵。
 *
 * 行下标 0-6 = 周一..周日（ISO 8601 顺序）；列下标 0-47 = 当日 00:00 起每 30 分钟一格
 * （列 c 覆盖 [c*30, c*30+30) 分钟）。true = 端点在该格「可路由」（时间窗语义 = 可用时段
 * 表，非禁用表——V1 场景「高峰期不可用」由用户在高峰格涂 false 表达）。求值取墙钟本地
 * 时区落格判断（设计不变量：区间起点对齐半小时边界、本地时区语义）。U2 求值函数与 U5
 * 时间轴涂抹组件（7 行 × 48 格）按下标约定对齐，两侧禁止各自另定坐标系。
 */
export type AggregationTimeWindowTable = boolean[][]

/** 端点条件四型（D5）：none 无条件 / window 仅时间窗 / quota 仅额度阈值 / combo 时间窗+额度。 */
export type AggregationMemberConditionType = 'none' | 'window' | 'quota' | 'combo'

export const AGGREGATION_MEMBER_CONDITION_TYPES: readonly AggregationMemberConditionType[] = ['none', 'window', 'quota', 'combo']

/** 端点额度条件：套餐剩余百分比 ≥ thresholdPercent 判可用（D5；100 = 恒耗尽，V3 技巧）。
 *  剩余 = 100 − 缓存已用百分比（QuotaWindow.pct 口径权威见 shared quota-types.ts；换算
 *  落在两侧判定点——扩展 router.ts isQuotaConditionSatisfied 与 ui route-preview.ts
 *  evaluateCondition 同型，2026-11-07 真机核实缓存 pct = 已用口径）。 */
export interface AggregationQuotaCondition { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  /** 阈值百分比（0-100 整数；额度数据缺失/过期时该条件按满足处理——fail-open，D5）。 */
  thresholdPercent: number
}

/**
 * 路由端点（member = 路由的一个供给渠道）。条件字段按 D2 schema 一次定形：
 * window/quota/levels 对全部条件型成员都可存在（与 type 的一致性由求值侧消费——type 是
 * 求值判别键，字段留驻是 D12「切换模式不丢条件」的数据保留语义，校验不按 type 拒绝字段）。
 */
export interface AggregationMember { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  /** 端点条目 id（路由内唯一；编辑器生成，仅作端点行对齐键，不参与跨进程对齐）。 */
  id: string
  /** 端点 provider id（须为有效模型合并视图中的 provider——悬空端点校验单点见
   * annotateDanglingMembers）。 */
  providerId: string
  /** 端点模型 id（provider 内有效模型——同上校验）。 */
  modelId: string
  /** 条件类型（D5 四型；simple 模式路由不判条件——type 仅在 advanced 模式参与求值）。 */
  type: AggregationMemberConditionType
  /** 时间窗表（type 含 window 维时参与求值；形态约定见 AggregationTimeWindowTable）。 */
  window?: AggregationTimeWindowTable
  /** 额度条件（M1 入 schema、M2 接线求值；字段只加不改承诺下先定形）。 */
  quota?: AggregationQuotaCondition
  /**
   * 端点 thinking 档位声明（复用 BuiltinModelSummary.thinkingLevelMap 字段形态，D7）：
   * key 存在且 value≠null = 该端点支持该档位。路由的档位并集与向上取档映射（D7）从各
   * 端点本声明派生；缺省 = 端点档位未知（并集按空集处理）；M1 编辑器不产生不回填
   * levels，档位声明编辑 / 按端点模型能力回填留后续增量。
   */
  levels?: Record<string, string | null> | null
}

/** 特殊日期双型（D13）：exclude 该日全天判窗外 / include 该日仅指定起止区间判窗内。 */
export type AggregationSpecialDateMode = 'exclude' | 'include'

export const AGGREGATION_SPECIAL_DATE_MODES: readonly AggregationSpecialDateMode[] = ['exclude', 'include']

/**
 * 特殊日期覆盖（按路由独立存储，D13）：求值优先于周表（时间窗表）。同一日期多条覆盖时
 * 取第一条匹配（spec 已知限制，去重合并留实施期）。
 */
export interface AggregationSpecialDate { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  id: string
  /** 覆盖日期，`YYYY-MM-DD` 本地日期（无时区偏移语义）。 */
  date: string
  mode: AggregationSpecialDateMode
  /** include 型起止时刻 `HH:mm`（24 小时制，同日内区间）；exclude 型省略（全天判窗外）。 */
  from?: string
  to?: string
}

/** 路由求值模式（D12）：simple 依次兜底（恒取第一个端点不判条件）/ advanced 按条件分流。 */
export type AggregationRouteMode = 'simple' | 'advanced'

export const AGGREGATION_ROUTE_MODES: readonly AggregationRouteMode[] = ['simple', 'advanced']

/**
 * 单条模型路由定义（routes 域集合元素，D2 schema）。id 是 set_model、会话还原、目录注入
 * 三处的对齐键（字符集约束见 ROUTE_ID_PATTERN）——一旦创建即跨进程契约，重命名 = 删除重建
 * （编辑器对 id 编辑按新建校验，撞既有 id 拒绝）。
 */
export interface AggregationRoute { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  /** 路由 id（kebab-case；唯一性保存校验见 validateAggregationRouteUpsert）。 */
  id: string
  /** 路由显示名（模型选择器与路由卡呈现；id 缺省从它生成——generateRouteIdFromName）。 */
  name: string
  /**
   * 路由对外暴露的模型 id（外部 spec §8 数据模型定形字段）。当前编辑器恒与 id 同值生成
   *（跨进程对齐键是 id——复合串 <聚合providerId>/<routeId> 与 pi 注册均用 id）；独立成
   * 字段是 schema 一次定形的忠实转写，语义收敛（分离/同值裁决）留实施期核对点。
   */
  modelId: string
  /** 启停（false = 选择器不出现、求值闭包显式失败「已停用」——D9 停用侧）。 */
  enabled: boolean
  mode: AggregationRouteMode
  /** 端点有序数组（D5：路由 = 按顺序找第一个条件全满足的端点；至少 1 条）。 */
  members: AggregationMember[]
  /** 特殊日期覆盖（D13；可空数组）。 */
  specials: AggregationSpecialDate[]
}

/** providers.json 顶层 routes 键的值结构（D2：外层键与内层集合字段同名）。 */
export interface AggregationRoutesFile { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  version: AggregationRoutesVersion
  routes: AggregationRoute[]
}

/** 空路由域（无 routes 键 / routes 数组空的读取结果形态——向后兼容语义，不迁移不报错）。 */
export function emptyAggregationRoutesFile(): AggregationRoutesFile {
  return { version: AGGREGATION_ROUTES_VERSION, routes: [] }
}

// ── 读取侧形态校验（损坏判别 SSOT；隔离动作在 runtime store，本模块只判别） ──────────

/** routes 段解析结果：ok = 合法段（含空）；fail = 形态损坏（runtime 据此走整文件隔离 +
 * 「路由配置已隔离」呈报，对齐 provider-extras-store 既有损坏语义，不发明部分接受态）。 */
export type AggregationRoutesParseResult =
  | { ok: true; file: AggregationRoutesFile }
  | { ok: false; reason: string }

/** `YYYY-MM-DD` 本地日期形态。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** `HH:mm` 24 小时制时刻形态。 */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 时间窗表形态：boolean[7][48]（行数/列数与元素类型逐一校验——缺格是坐标契约破坏）。 */
function isValidTimeWindowTable(v: unknown): v is AggregationTimeWindowTable {
  if (!Array.isArray(v) || v.length !== TIME_WINDOW_DAYS) return false
  return v.every(row => Array.isArray(row) && row.length === TIME_WINDOW_SLOTS_PER_DAY && row.every(cell => typeof cell === 'boolean'))
}

function isValidMember(v: unknown): v is AggregationMember {
  if (!isPlainObject(v)) return false
  const m = v as Record<string, unknown>
  if (typeof m.id !== 'string' || m.id === '' || typeof m.providerId !== 'string' || m.providerId === ''
    || typeof m.modelId !== 'string' || m.modelId === '') return false
  if (typeof m.type !== 'string' || !AGGREGATION_MEMBER_CONDITION_TYPES.includes(m.type as AggregationMemberConditionType)) return false
  if (m.window !== undefined && !isValidTimeWindowTable(m.window)) return false
  if (m.quota !== undefined) {
    if (!isPlainObject(m.quota)) return false
    const q = m.quota as Record<string, unknown>
    if (typeof q.thresholdPercent !== 'number' || !Number.isInteger(q.thresholdPercent)
      || q.thresholdPercent < 0 || q.thresholdPercent > AGGREGATION_QUOTA_THRESHOLD_MAX) return false
  }
  if (m.levels !== undefined && m.levels !== null) {
    if (!isPlainObject(m.levels)) return false
    if (!Object.values(m.levels).every(val => val === null || typeof val === 'string')) return false
  }
  return true
}

function isValidSpecialDate(v: unknown): v is AggregationSpecialDate {
  if (!isPlainObject(v)) return false
  const s = v as Record<string, unknown>
  if (typeof s.id !== 'string' || s.id === '' || typeof s.date !== 'string' || !DATE_PATTERN.test(s.date)) return false
  if (typeof s.mode !== 'string' || !AGGREGATION_SPECIAL_DATE_MODES.includes(s.mode as AggregationSpecialDateMode)) return false
  if (s.mode === 'include') {
    if (typeof s.from !== 'string' || !TIME_PATTERN.test(s.from)
      || typeof s.to !== 'string' || !TIME_PATTERN.test(s.to)) return false
    // include 区间须同日内起 < 止（起止相等 = 零长度窗，无业务语义，判损坏）
    if (s.from >= s.to) return false
  }
  return true
}

function isValidRoute(v: unknown): v is AggregationRoute {
  if (!isPlainObject(v)) return false
  const r = v as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id === '' || !isValidRouteId(r.id)) return false
  if (typeof r.name !== 'string' || r.name.trim() === '') return false
  if (typeof r.modelId !== 'string' || r.modelId === '') return false
  if (typeof r.enabled !== 'boolean') return false
  if (typeof r.mode !== 'string' || !AGGREGATION_ROUTE_MODES.includes(r.mode as AggregationRouteMode)) return false
  if (!Array.isArray(r.members) || r.members.length === 0 || !r.members.every(isValidMember)) return false
  if (!Array.isArray(r.specials) || !r.specials.every(isValidSpecialDate)) return false
  // 端点 id 路由内唯一（编辑器对齐键；重复 = 保存链 broken，判损坏）
  const memberIds = new Set<string>()
  for (const m of r.members as AggregationMember[]) {
    if (memberIds.has(m.id)) return false
    memberIds.add(m.id)
  }
  return true
}

/**
 * providers.json 顶层 routes 键的读取侧形态校验（判别 SSOT）。
 *
 * - 值 undefined（键缺失）= 合法空域（向后兼容：既有数据无 routes 键 = 空数组语义，
 *   不迁移不报错——U1 检查点）。
 * - 形态损坏（非对象 / version 非 1 / routes 非数组 / 任一条目字段非法）= fail——调用方
 *   （runtime store）据此走既有整文件隔离语义（quarantineCorruptFile）+「路由配置已隔离」
 *   呈报；本模块不做部分过滤（坏条目静默过滤 = 部分接受态，与隔离语义并存的第三种行为，
 *   不引入）。
 */
export function parseAggregationRoutesSection(value: unknown): AggregationRoutesParseResult {
  if (value === undefined) return { ok: true, file: emptyAggregationRoutesFile() }
  if (!isPlainObject(value)) return { ok: false, reason: 'routes section is not an object' }
  const section = value as Record<string, unknown>
  if (section.version !== AGGREGATION_ROUTES_VERSION) {
    return { ok: false, reason: `routes section version must be ${AGGREGATION_ROUTES_VERSION}` }
  }
  if (!Array.isArray(section.routes)) return { ok: false, reason: 'routes must be an array' }
  for (const route of section.routes) {
    if (!isValidRoute(route)) return { ok: false, reason: 'routes contains a malformed entry' }
  }
  return { ok: true, file: { version: AGGREGATION_ROUTES_VERSION, routes: section.routes as AggregationRoute[] } }
}

// ── 路由 id 规则（U1 检查点：id 是 set_model / 会话还原 / 目录注入三处的对齐键） ─────────

/** 路由 id 上界（对齐键会进 pi 虚拟模型 id 与模型复合串，防超长串污染显示与日志）。 */
export const ROUTE_ID_MAX_LENGTH = 64

/** 路由 id 字符集：小写字母/数字起头的 kebab-case（内部允许连字符，不以连字符开头/结尾）。 */
export const ROUTE_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/

/** 路由 id 字符集约束校验（保存侧拒绝 + 读取侧损坏判别共用同一谓词）。 */
export function isValidRouteId(id: string): boolean {
  return id.length > 0 && id.length <= ROUTE_ID_MAX_LENGTH && ROUTE_ID_PATTERN.test(id)
}

/**
 * 从路由显示名生成缺省 id（U1 检查点：默认从名称生成 kebab-case、用户可改）。
 *
 * 规则：小写 → 空白/下划线折叠为连字符 → 丢弃 [a-z0-9] 与连字符以外的字符（中文字符
 * 不转写不保留——转写需引 pinyin 依赖，缺省 id 是用户可改的初值而非身份锚点）→ 折叠
 * 连续连字符 → 去首尾连字符 → 截断到 ROUTE_ID_MAX_LENGTH（去尾随连字符）。产出为空时
 * 回退 'route'（调用方按唯一性规则追加序号）。
 */
export function generateRouteIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ROUTE_ID_MAX_LENGTH)
    .replace(/-+$/g, '')
  return slug === '' ? 'route' : slug
}

// ── 保存校验（U1 检查点：id 唯一 + 字符集；嵌套路由/重复渠道拒绝，悬空端点只标记不拒绝） ──

/** 路由域错误码词表（wire error envelope 的 code 值域；D10 请求级失败统一 error envelope）。 */
export type AggregationErrorCode = 'route_id_conflict' | 'route_id_invalid' | 'route_not_found' | 'route_member_nested'

export const AGGREGATION_ERROR_CODES: readonly AggregationErrorCode[] = ['route_id_conflict', 'route_id_invalid', 'route_not_found', 'route_member_nested']

/** 保存校验结果信封（network-proxy 域同款形态：ok 或面向用户的错误清单）。 */
export type AggregationRouteValidationResult =
  | { ok: true }
  | { ok: false; code: AggregationErrorCode; errors: string[] }

/**
 * 单条路由 upsert 的保存校验（保存语义 = 结构与 id 合法性把关；端点存在性走标记不拒绝——
 * 「允许保留悬空端点 + 标记提示」，不丢用户配置）。
 *
 * 端点引用两道硬拒绝（route-matrix.md「同系统内未穷举的组合清单」组合 1/3 的行为契约）：
 * 端点 providerId 为聚合保留 id（嵌套路由）→ route_member_nested 拒绝；同一
 * (providerId, modelId) 渠道重复出现 → 拒绝（重复渠道求值行为完全相同，无语义）。
 *
 * @param next 待保存路由
 * @param existing 既有路由全集（保存前磁盘态）
 * @param priorId 编辑场景的原 id（id 被编辑时传旧值判唯一性）。缺省 = 新建语义：next.id
 *   与任何既有路由相同即冲突（新建不存在「自身」豁免——本用例曾因把缺省误设为 next.id
 *   而放行新建撞名，修复为缺省 undefined 哨兵）。编辑改 id 撞其他路由 → route_id_conflict
 *   拒绝；next.id === priorId = 自身替换，合法。
 */
export function validateAggregationRouteUpsert(
  next: AggregationRoute,
  existing: readonly AggregationRoute[],
  priorId?: string,
): AggregationRouteValidationResult {
  const errors: string[] = []
  let code: AggregationErrorCode = 'route_id_invalid'
  if (!isValidRouteId(next.id)) {
    code = 'route_id_invalid'
    errors.push(`路由 id "${next.id}" 不合法：须为 ${ROUTE_ID_MAX_LENGTH} 字符内的小写字母/数字 kebab-case（字母或数字开头结尾）。`)
  }
  const conflict = existing.some(r => r.id === next.id && r.id !== priorId)
  if (conflict) {
    code = 'route_id_conflict'
    errors.push(`路由 id "${next.id}" 与既有路由冲突：id 是模型切换与会话还原的对齐键，请改用其他 id。`)
  }
  if (next.name.trim() === '') {
    errors.push('路由名称不能为空。')
  }
  if (next.members.length === 0) {
    errors.push('路由至少需要一个端点。')
  }
  const memberIds = new Set<string>()
  const memberChannels = new Set<string>()
  for (const m of next.members) {
    if (m.providerId === AGGREGATION_PROVIDER_ID) {
      code = 'route_member_nested'
      errors.push(`端点 "${m.providerId}/${m.modelId}" 引用了另一条模型路由：路由不能作为另一条路由的端点（嵌套路由不支持），请直接选择物理 provider 下的模型。`)
    }
    if (memberIds.has(m.id)) errors.push(`端点条目 id "${m.id}" 在路由内重复。`)
    memberIds.add(m.id)
    const channel = `${m.providerId}/${m.modelId}`
    if (memberChannels.has(channel)) errors.push(`端点 "${channel}" 在路由内重复：同一 provider + 模型渠道出现多次没有语义，请删除多余的重复端点行。`)
    memberChannels.add(channel)
  }
  if (errors.length === 0) return { ok: true }
  return { ok: false, code, errors }
}

// ── 端点悬空标记（U1 检查点：读取与保存两处共用的存在性标记，允许保留不拒绝） ──────────

/** 悬空端点两类标记（U1 检查点词表）：provider 已删 / 模型已移除。 */
export type AggregationDanglingReason = 'provider-deleted' | 'model-removed'

export const AGGREGATION_DANGLING_REASONS: readonly AggregationDanglingReason[] = ['provider-deleted', 'model-removed']

/** 单个端点的悬空标记（memberRef 形态与模型复合串一致，供 UI 直接呈现）。 */
export interface AggregationMemberIssue { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  routeId: string
  memberIndex: number
  /** 端点复合串 `<providerId>/<modelId>`。 */
  memberRef: string
  reason: AggregationDanglingReason
}

/**
 * 有效模型索引：providerId → 该 provider 下有效模型 id 集。
 *
 * 生产单点在 runtime provider-config-helper.buildValidModelIndex（catalog 侧 = 快照 ⊕
 * overlay 合并视图单点 getMergedCatalogModels，custom 侧 = models.json）；shared 侧只定义
 * 形状，扩展侧（U2）按同形态自建索引复用本标记函数。
 */
export type AggregationValidModelIndex = ReadonlyMap<string, ReadonlySet<string>>

/**
 * 悬空端点标记（读取与保存共用同一函数——同一输入同一标记，杜绝两处漂移）。
 * provider 不在索引 → 'provider-deleted'；provider 在但模型不在其集合 → 'model-removed'。
 */
export function annotateDanglingMembers(
  routes: readonly AggregationRoute[],
  validModels: AggregationValidModelIndex,
): AggregationMemberIssue[] {
  const issues: AggregationMemberIssue[] = []
  for (const route of routes) {
    route.members.forEach((member, memberIndex) => {
      const providerModels = validModels.get(member.providerId)
      if (providerModels === undefined) {
        issues.push({
          routeId: route.id,
          memberIndex,
          memberRef: `${member.providerId}/${member.modelId}`,
          reason: 'provider-deleted',
        })
        return
      }
      if (!providerModels.has(member.modelId)) {
        issues.push({
          routeId: route.id,
          memberIndex,
          memberRef: `${member.providerId}/${member.modelId}`,
          reason: 'model-removed',
        })
      }
    })
  }
  return issues
}

// ── scopedModels 聚合引用判别（复合串对齐键工具） ─────────────────────────────────────

/** 路由条目的模型复合串：`<聚合providerId>/<routeId>`（scopedModels / set_model / 目录注入对齐键）。 */
export function buildAggregationModelRef(routeId: string): string {
  return `${AGGREGATION_PROVIDER_ID}/${routeId}`
}

/** 复合串是否为路由引用（provider 段 = 聚合保留 id）。 */
export function isAggregationModelRef(ref: string): boolean {
  return ref.startsWith(`${AGGREGATION_PROVIDER_ID}/`)
}

/** 从路由引用复合串取路由 id 段；非路由引用返回 undefined。 */
export function aggregationRouteIdFromRef(ref: string): string | undefined {
  if (!isAggregationModelRef(ref)) return undefined
  const routeId = ref.slice(AGGREGATION_PROVIDER_ID.length + 1)
  return routeId === '' ? undefined : routeId
}

/**
 * scopedModels 中的失效引用收集（U1 检查点：读取侧标记，不自动写；清理归 U9 删除保存）。
 *
 * 判定 = 路由引用（provider 段为聚合保留 id 的复合串）解析不到 routes 定义；物理 provider
 * 的复合串不进本判定（与 routes 域无关）。返回失效复合串原值（UI 提示条数据）。
 */
export function collectOrphanAggregationRefs(
  scopedModels: readonly string[],
  routes: readonly AggregationRoute[],
): string[] {
  const routeIds = new Set(routes.map(r => r.id))
  return scopedModels.filter(ref => {
    const routeId = aggregationRouteIdFromRef(ref)
    return routeId !== undefined && !routeIds.has(routeId)
  })
}

// ── 供应商路由引用投影（provider-aggregation U5 补呈现 · 外部 spec §6.3 行摘要 / §6.4 引用区） ──

/** 引用 chip（spec §6.4「模型简称 · 第 N 顺位」的数据投影；点击跳转目标锚三元组）。 */
export interface AggregationProviderRouteRef { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  /** 引用该渠道的路由 id（跳转 = 路由页展开对应模型卡）。 */
  routeId: string
  /** 路由显示名（外部 spec 数据模型 route=model，「模型简称」即路由名）。 */
  routeName: string
  /** 端点条目 id（路由页端点行定位锚，RouteEndpointRow data-member-id 同源）。 */
  memberId: string
  /** 端点顺位（0 起；展示层 +1 =「第 N 顺位」）。 */
  memberIndex: number
}

/** 供应商路由引用投影（行摘要 routeCount 与引用区 refs 共用单源——两处派生分写即口径漂移点）。 */
export interface AggregationProviderRouteRefs { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  /** 引用该渠道的不同路由数量（spec §6.3：按路由去重统计，不是端点数）。 */
  routeCount: number
  /** 引用 chip 列表（每端点一条；按路由卡序 + 端点序稳定排序）。 */
  refs: AggregationProviderRouteRef[]
}

/**
 * 渠道被路由引用的投影（U5 供应商页补呈现单源）：入参 = 路由定义集合（routeView 卡片
 * 携带的 route 即本域类型，视图层无需二次拆包）+ 渠道 provider id。无引用 = 零值投影
 * （routeCount 0 / refs 空——行摘要「未参与路由」与引用区空文案的统一判据）。
 */
export function collectProviderRouteRefs(
  routes: readonly AggregationRoute[],
  providerId: string,
): AggregationProviderRouteRefs {
  const refs: AggregationProviderRouteRef[] = []
  let routeCount = 0
  for (const route of routes) {
    let routeHit = false
    for (let memberIndex = 0; memberIndex < route.members.length; memberIndex++) {
      const member = route.members[memberIndex]
      if (member?.providerId !== providerId) continue
      routeHit = true
      refs.push({ routeId: route.id, routeName: route.name, memberId: member.id, memberIndex })
    }
    if (routeHit) routeCount += 1
  }
  return { routeCount, refs }
}

// ── 额度数据新鲜度（provider-aggregation D3/RL3：「超阈值判未知」语义单源） ─────────────

/** 秒 → 毫秒换算锚（resetSec 剩余秒数与毫秒 epoch 墙钟的统一换算点）。 */
const MS_PER_SECOND = 1000

/**
 * 额度数据新鲜度阈值（毫秒）：距上次成功取数（quota-cache 条目的 lastFetchAt）超过该
 * 阈值判「未知」。判定消费方两方：pi 扩展组装额度快照（未知 → 端点额度条件 fail-open，
 * D5）、runtime 刷新编排的「过期才刷」过滤（U4）。浮层「额度数据 N 分钟前」标注（M2）
 * 是展示层相对时间格式化（useQuotaDisplay formatLastFetch），无布尔阈值判定语义，
 * 不在本单源约束内。
 *
 * 取值判据（D3）：正常对话节奏下 fail-open 分支只在异常触发（应用冷启动无缓存、长期
 * 未对话后首条消息）。当前取 10 分钟——高于回合内秒级触发密度（回合收尾刷新使数据年龄
 * 在连续对话下恒远低于阈值），低于「休息后回来」的典型回合间隔（数据及时跟进）；额度是
 * 小时级变化量，超阈值判未知后由事件驱动刷新追平，真耗尽由 D6 重试感知兜住。
 */
export const AGGREGATION_QUOTA_FRESHNESS_MS = 600_000

/** 新鲜度判定输入：quota-cache 条目的判定最小投影（lastFetchAt + 各窗口重置剩余秒数）。 */
export interface AggregationQuotaFreshnessProbe { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  /** QuotaService 上次成功取数时刻（毫秒 epoch）。缺失/非法（null/undefined/NaN/≤0）= 未知。 */
  lastFetchAt: number | null | undefined
  /**
   * 各计费窗口的重置剩余秒数（NormalizedQuotaRow.wins 逐窗的 resetSec 投影；快照取数
   * 时点值）。null/undefined = 该窗无重置信息（不参与跨窗判定）；任一窗口的重置点
   * （lastFetchAt + resetSec*1000）已过 = 快照描述已结束周期的余量 → 未知。
   */
  resetSecs: readonly (number | null | undefined)[]
}

/**
 * 额度缓存数据新鲜度判定（RL3 单源）：超阈值或跨重置窗口 = 未知（false）——调用方把
 * 未知数据按 fail-open 语义处理（端点额度条件按满足），不猜测数值。判定消费方两方
 * （扩展 / runtime 编排）共用本函数，禁止各自另写时间比较（多端漂移即语义分裂）。
 */
export function isAggregationQuotaDataFresh(
  probe: AggregationQuotaFreshnessProbe,
  now: number,
  freshnessMs: number = AGGREGATION_QUOTA_FRESHNESS_MS,
): boolean {
  const { lastFetchAt, resetSecs } = probe
  if (lastFetchAt === null || lastFetchAt === undefined || !Number.isFinite(lastFetchAt) || lastFetchAt <= 0) {
    return false
  }
  if (now - lastFetchAt > freshnessMs) return false
  for (const resetSec of resetSecs) {
    if (typeof resetSec !== 'number' || !Number.isFinite(resetSec)) continue
    // 重置点已到达（含 resetSec 为负的畸形快照——<= 恒真）即跨窗：旧快照属已结束周期。
    if (lastFetchAt + resetSec * MS_PER_SECOND <= now) return false
  }
  return true
}

// ── 路由视图 wire 载荷（F2 契约前移：U9 视图编排下发 / U5 设置页 / U6 选择器共同消费） ──

/** join 视图单卡：路由定义 + scopedModels 引用态（runtime 计算视图，非权威非持久化——D10）。 */
export interface AggregationRouteCard { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  route: AggregationRoute
  /** 是否已加入 scopedModels 白名单（true = 选择器可见可选）。 */
  scoped: boolean
  /** scopedModels 中的位置（未加入 = -1）；卡片顺序 = scopedModels 序在前、未参与在后。 */
  scopedIndex: number
  /** 悬空端点标记（annotateDanglingMembers 本路由子集；非空 = 卡片显示标记提示）。 */
  memberIssues: AggregationMemberIssue[]
}

/**
 * 路由页 join 视图（`aggregation.getRouteView` 的 reply 载荷 / `aggregation.routeView`
 * 广播载荷）：卡片集合 = scopedModels 条目 ∪ routes 定义的模型（孤儿复合串不生成卡——
 * 只进 orphanRefs 提示条，D10）；顺序 = scopedModels 序（未参与态卡片跟随其后）。
 */
export interface AggregationRouteView { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  cards: AggregationRouteCard[]
  /** scopedModels 中解析不到 routes 定义的失效引用（原值；下一次保存清理，读取侧不自动写）。 */
  orphanRefs: string[]
  /** routes 段（或所在 extras 文件）损坏被隔离：true = 设置页显示「路由配置已隔离」呈报。 */
  corrupted?: boolean
  /** 被隔离的坏文件路径（corrupted=true 时下发；呈报修复指引——用户可从 .corrupt-* 副本找回）。 */
  corruptedFilePath?: string
}

/** saveRoute 的 reply 载荷：保存后的路由 + 悬空端点标记（允许保留 + 标记提示的回执半边）。 */
export interface AggregationRouteSaved { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  route: AggregationRoute
  /** 本次保存后该路由的悬空端点标记（空 = 全部端点有效）。 */
  memberIssues: AggregationMemberIssue[]
}

/** deleteRoute 的 reply 载荷：删除完成 + scopedModels 精确清理后的白名单（U9 双写回执）。 */
export interface AggregationRouteDeleted { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
  routeId: string
  /** 清理 `<聚合providerId>/<routeId>` 后的 scopedModels 全量（供前端整表替换）。 */
  scopedModels: string[]
}
