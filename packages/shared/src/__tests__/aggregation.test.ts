import { describe, it, expect, expectTypeOf } from 'vitest'
import type { ClientMessageType, ClientMessageMap, ReplyPayloadMap, ServerMessageMap } from '../protocol'
import type {
  AggregationMemberIssue,
  AggregationProviderRouteRef,
  AggregationRoute,
  AggregationRouteDeleted,
  AggregationRouteSaved,
  AggregationRouteView,
  ProviderInfo,
  ProviderKind,
  ModelInfo,
} from '../index'
import {
  AGGREGATION_ERROR_CODES,
  AGGREGATION_PROVIDER_ID,
  AGGREGATION_ROUTES_VERSION,
  annotateDanglingMembers,
  aggregationRouteIdFromRef,
  buildAggregationModelRef,
  collectOrphanAggregationRefs,
  collectProviderRouteRefs,
  emptyAggregationRoutesFile,
  generateRouteIdFromName,
  isAggregationModelRef,
  isValidRouteId,
  parseAggregationRoutesSection,
  ROUTE_ID_MAX_LENGTH,
  validateAggregationRouteUpsert,
} from '../index'

/** 构造合法路由条目的 fixture 工厂（覆盖用例按需覆写字段）。 */
function makeRoute(overrides: Partial<AggregationRoute> = {}): AggregationRoute {
  return {
    id: 'glm-flash',
    name: 'GLM Flash',
    modelId: 'glm-flash',
    enabled: true,
    mode: 'advanced',
    members: [
      { id: 'ep-1', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'none' },
    ],
    specials: [],
    ...overrides,
  }
}

// ── A11-1 向后兼容：无 routes 键 = 空数组语义，不迁移不报错 ──────────────────────────

describe('routes 键向后兼容（U1 检查点）', () => {
  it('键缺失（undefined）= 合法空域，不迁移不报错', () => {
    const result = parseAggregationRoutesSection(undefined)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.file).toEqual(emptyAggregationRoutesFile())
  })

  it('空路由数组 = 合法空域', () => {
    const result = parseAggregationRoutesSection({ version: AGGREGATION_ROUTES_VERSION, routes: [] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.file.routes).toEqual([])
  })

  it('合法单条路由解析保真（members/specials 全字段往返）', () => {
    const route = makeRoute({
      mode: 'simple',
      members: [
        { id: 'ep-1', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'window', window: Array.from({ length: 7 }, () => Array<boolean>(48).fill(false)) },
        { id: 'ep-2', providerId: 'opencode-go', modelId: 'zai-glm-5.3-flash', type: 'quota', quota: { thresholdPercent: 20 }, levels: { high: 'high', medium: null } },
      ],
      specials: [
        { id: 'sp-1', date: '2026-10-01', mode: 'exclude' },
        { id: 'sp-2', date: '2026-10-02', mode: 'include', from: '20:00', to: '22:00' },
      ],
    })
    const result = parseAggregationRoutesSection({ version: 1, routes: [route] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.file.routes).toEqual([route])
  })
})

// ── A11-2 损坏判别（shared 判别单点；runtime 据此整文件隔离 +「路由配置已隔离」呈报） ──

describe('routes 段损坏判别（parseAggregationRoutesSection）', () => {
  it.each([
    ['键值非对象（数组）', []],
    ['键值非对象（字符串）', 'broken'],
    ['键值 null', null],
    ['version 非 1', { version: 2, routes: [] }],
    ['version 缺失', { routes: [] }],
    ['routes 非数组', { version: 1, routes: {} }],
  ])('%s → 判损坏', (_label, value) => {
    const result = parseAggregationRoutesSection(value)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(typeof result.reason).toBe('string')
  })

  it.each([
    ['条目非对象', ['broken']],
    ['id 非法字符集（大写）', [makeRoute({ id: 'GLM-Flash' })]],
    ['id 为空', [makeRoute({ id: '' })]],
    ['name 空白', [makeRoute({ name: '   ' })]],
    ['modelId 缺失', [{ ...makeRoute(), modelId: undefined } as unknown as AggregationRoute]],
    ['enabled 缺失', [{ ...makeRoute(), enabled: undefined } as unknown as AggregationRoute]],
    ['mode 非法值', [makeRoute({ mode: 'fastest' as AggregationRoute['mode'] })]],
    ['members 为空数组', [makeRoute({ members: [] })]],
    ['member 缺 providerId', [{ ...makeRoute(), members: [{ id: 'ep', providerId: '', modelId: 'm', type: 'none' }] }]],
    ['member type 非法', [{ ...makeRoute(), members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'score' }] } as unknown as AggregationRoute]],
    ['member 端点 id 重复', [makeRoute({ members: [
      { id: 'dup', providerId: 'a', modelId: 'm1', type: 'none' },
      { id: 'dup', providerId: 'b', modelId: 'm2', type: 'none' },
    ] })]],
    ['window 表行数非 7', [makeRoute({ members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'window', window: Array.from({ length: 6 }, () => Array<boolean>(48).fill(false)) }] })]],
    ['window 表列数非 48', [makeRoute({ members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'window', window: Array.from({ length: 7 }, () => Array<boolean>(47).fill(false)) }] })]],
    ['window 表元素非布尔', [makeRoute({ members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'window', window: Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => 'yes' as unknown as boolean)) }] })]],
    ['quota 阈值越界（>100）', [makeRoute({ members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'quota', quota: { thresholdPercent: 101 } }] })]],
    ['quota 阈值非整数', [makeRoute({ members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'quota', quota: { thresholdPercent: 12.5 } }] })]],
    ['specials date 形态非法', [makeRoute({ specials: [{ id: 'sp', date: '20261001', mode: 'exclude' }] })]],
    ['specials include 缺 from/to', [makeRoute({ specials: [{ id: 'sp', date: '2026-10-01', mode: 'include' }] })]],
    ['specials include 起止倒挂', [makeRoute({ specials: [{ id: 'sp', date: '2026-10-01', mode: 'include', from: '22:00', to: '20:00' }] })]],
  ])('%s → 判损坏（整段 fail，不做部分过滤）', (_label, routes) => {
    const result = parseAggregationRoutesSection({ version: 1, routes: routes as unknown[] })
    expect(result.ok).toBe(false)
  })
})

// ── A11-3 路由 id 规则：kebab-case 缺省生成 + 字符集约束 ─────────────────────────────

describe('路由 id 规则（U1 检查点）', () => {
  it('generateRouteIdFromName：英文名 → kebab-case', () => {
    expect(generateRouteIdFromName('GLM 5.3 Flash Route')).toBe('glm-53-flash-route')
  })

  it('generateRouteIdFromName：空白与下划线折叠为连字符，连续连字符折叠', () => {
    expect(generateRouteIdFromName('  my__cool   route  ')).toBe('my-cool-route')
  })

  it('generateRouteIdFromName：非 [a-z0-9] 字符（中文/点号）丢弃', () => {
    expect(generateRouteIdFromName('智谱 GLM')).toBe('glm')
    expect(generateRouteIdFromName('glm-5.3')).toBe('glm-53')
  })

  it('generateRouteIdFromName：全非法字符 → 回退 route', () => {
    expect(generateRouteIdFromName('智谱')).toBe('route')
    expect(generateRouteIdFromName('')).toBe('route')
  })

  it('generateRouteIdFromName：截断到上界且不留尾随连字符', () => {
    const long = `${'a'.repeat(ROUTE_ID_MAX_LENGTH)}-bbb`
    const generated = generateRouteIdFromName(long)
    expect(generated.length).toBeLessThanOrEqual(ROUTE_ID_MAX_LENGTH)
    expect(generated.endsWith('-')).toBe(false)
  })

  it('isValidRouteId：合法形态放行（字母/数字起头、内部连字符、数字 id）', () => {
    expect(isValidRouteId('glm-flash')).toBe(true)
    expect(isValidRouteId('route2')).toBe(true)
    expect(isValidRouteId('a'.repeat(ROUTE_ID_MAX_LENGTH))).toBe(true)
  })

  it('isValidRouteId：非法形态拒绝（空/超长/大写/连字符起尾/下划线/空白/中文）', () => {
    expect(isValidRouteId('')).toBe(false)
    expect(isValidRouteId('a'.repeat(ROUTE_ID_MAX_LENGTH + 1))).toBe(false)
    expect(isValidRouteId('GLM')).toBe(false)
    expect(isValidRouteId('-lead')).toBe(false)
    expect(isValidRouteId('trail-')).toBe(false)
    expect(isValidRouteId('snake_case')).toBe(false)
    expect(isValidRouteId('has space')).toBe(false)
    expect(isValidRouteId('路由')).toBe(false)
  })
})

// ── A11-4 保存校验：id 唯一性（冲突拒绝）+ 字符集 ────────────────────────────────────

describe('保存校验（validateAggregationRouteUpsert）', () => {
  const existing = [makeRoute({ id: 'glm-flash' }), makeRoute({ id: 'opencode-fallback' })]

  it('新建撞既有 id → route_id_conflict 拒绝', () => {
    const result = validateAggregationRouteUpsert(makeRoute({ id: 'glm-flash', name: 'New Route' }), existing)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('route_id_conflict')
  })

  it('编辑自身（priorId = 自身 id）不冲突', () => {
    const result = validateAggregationRouteUpsert(makeRoute({ id: 'glm-flash' }), existing, 'glm-flash')
    expect(result.ok).toBe(true)
  })

  it('编辑改 id 撞其他路由 → route_id_conflict 拒绝', () => {
    const edited = makeRoute({ id: 'opencode-fallback' })
    const result = validateAggregationRouteUpsert(edited, existing, 'glm-flash')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('route_id_conflict')
  })

  it('id 字符集违规 → route_id_invalid 拒绝', () => {
    const result = validateAggregationRouteUpsert(makeRoute({ id: 'Bad_Id' }), existing)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('route_id_invalid')
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })

  it('空端点集合 / 端点 id 路由内重复 → 拒绝（结构把关）', () => {
    expect(validateAggregationRouteUpsert(makeRoute({ members: [] }), existing).ok).toBe(false)
    const dupMembers = makeRoute({ members: [
      { id: 'dup', providerId: 'a', modelId: 'm1', type: 'none' },
      { id: 'dup', providerId: 'b', modelId: 'm2', type: 'none' },
    ] })
    expect(validateAggregationRouteUpsert(dupMembers, existing).ok).toBe(false)
  })

  it('嵌套路由端点（providerId = 聚合保留 id）→ route_member_nested 拒绝（矩阵组合 1）', () => {
    const nested = makeRoute({ id: 'nested-route', members: [{ id: 'ep-1', providerId: AGGREGATION_PROVIDER_ID, modelId: 'other-route', type: 'none' }] })
    const result = validateAggregationRouteUpsert(nested, existing)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('route_member_nested')
      expect(result.errors[0]).toContain('嵌套')
    }
  })

  it('同一 (providerId, modelId) 渠道以不同端点 id 重复 → 拒绝（矩阵组合 3）', () => {
    const dupChannel = makeRoute({ id: 'dup-channel-route', members: [
      { id: 'ep-1', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'none' },
      { id: 'ep-2', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'window' },
    ] })
    const result = validateAggregationRouteUpsert(dupChannel, existing)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('；')).toContain('没有语义')
  })

  it('不同 provider 的同名模型渠道不误伤（渠道键含 providerId）', () => {
    const sameModelDiffProvider = makeRoute({ id: 'multi-channel-route', members: [
      { id: 'ep-1', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'none' },
      { id: 'ep-2', providerId: 'opencode-go', modelId: 'glm-5.3-flash', type: 'none' },
    ] })
    expect(validateAggregationRouteUpsert(sameModelDiffProvider, existing).ok).toBe(true)
  })

  it('悬空端点不拒绝（允许保留 + 标记提示的保存语义——存在性校验归标记函数）', () => {
    // provider 明显不在任何有效模型索引中，保存校验仍放行（id 取不撞既有的值，隔离冲突语义）
    const dangling = makeRoute({ id: 'ghost-route', name: 'Ghost', members: [{ id: 'ep', providerId: 'ghost-provider', modelId: 'ghost-model', type: 'none' }] })
    expect(validateAggregationRouteUpsert(dangling, existing).ok).toBe(true)
  })

  it('错误码词表完备（wire error envelope code 值域五值）', () => {
    expect(AGGREGATION_ERROR_CODES).toEqual(['route_id_conflict', 'route_id_invalid', 'route_not_found', 'route_member_nested', 'route_shape_invalid'])
  })
})

// ── 写侧形态门（残留风险 4 处置：写侧校验补齐读侧损坏判别的真子集缺口——读侧判损坏、
//    写侧此前放行的全部形态，现在 saveRoute 单点拒绝，不再把越界形态写进 providers.json） ──

describe('保存载荷形态门（route_shape_invalid，与读取侧损坏判别同谓词）', () => {
  const existing = [makeRoute({ id: 'glm-flash' })]

  /** 形态门用例构造助手（越界形态不满足 AggregationRoute 类型，逐例断言 cast）。 */
  function routeWith(overrides: Record<string, unknown>): AggregationRoute {
    return { ...makeRoute(), ...overrides } as unknown as AggregationRoute
  }

  it.each([
    ['端点 id 非字符串', { members: [{ id: 123, providerId: 'p', modelId: 'm', type: 'none' }] }],
    ['端点 id 空串', { members: [{ id: '', providerId: 'p', modelId: 'm', type: 'none' }] }],
    ['端点 providerId 空串', { members: [{ id: 'ep', providerId: '', modelId: 'm', type: 'none' }] }],
    ['端点 modelId 非字符串', { members: [{ id: 'ep', providerId: 'p', modelId: 42, type: 'none' }] }],
    ['端点 type 缺失', { members: [{ id: 'ep', providerId: 'p', modelId: 'm' }] }],
    ['端点 type 非法值', { members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'score' }] }],
    ['window 表非数组', { members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'window', window: 'busy' }] }],
    ['window 表行数非 7', { members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'window', window: Array.from({ length: 6 }, () => Array<boolean>(48).fill(false)) }] }],
    ['window 表列数非 48', { members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'window', window: Array.from({ length: 7 }, () => Array<boolean>(47).fill(false)) }] }],
    ['window 表元素非布尔', { members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'window', window: Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => 'yes' as unknown as boolean)) }] }],
    ['quota 非对象', { members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'quota', quota: 'ok' }] }],
    ['quota 阈值越界（>100）', { members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'quota', quota: { thresholdPercent: 101 } }] }],
    ['quota 阈值非整数', { members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'quota', quota: { thresholdPercent: 12.5 } }] }],
    ['levels 值非 string|null', { members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'none', levels: { high: 1 } }] }],
    ['levels 数组形态', { members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'none', levels: ['high'] }] }],
  ])('member 越界：%s → route_shape_invalid 拒绝', (_label, overrides) => {
    const result = validateAggregationRouteUpsert(routeWith(overrides), existing)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('route_shape_invalid')
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })

  it.each([
    ['route.modelId 空串', { modelId: '' }],
    ['route.enabled 非布尔', { enabled: 'yes' }],
    ['route.mode 非词表值', { mode: 'fastest' }],
    ['members 非数组', { members: 'all-members' }],
    ['specials 非数组', { specials: {} }],
    ['special 条目 date 形态非法', { specials: [{ id: 'sp', date: '20261001', mode: 'exclude' }] }],
    ['special 条目 id 空串', { specials: [{ id: '', date: '2026-10-01', mode: 'exclude' }] }],
    ['special 条目 mode 非词表', { specials: [{ id: 'sp', date: '2026-10-01', mode: 'off' }] }],
    ['special include 缺 from/to', { specials: [{ id: 'sp', date: '2026-10-01', mode: 'include' }] }],
    ['special include from 非 HH:mm', { specials: [{ id: 'sp', date: '2026-10-01', mode: 'include', from: '9:00', to: '12:00' }] }],
    ['special include 起止相等（零长度窗）', { specials: [{ id: 'sp', date: '2026-10-01', mode: 'include', from: '10:00', to: '10:00' }] }],
  ])('路由级越界：%s → route_shape_invalid 拒绝', (_label, overrides) => {
    const result = validateAggregationRouteUpsert(routeWith(overrides), existing)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('route_shape_invalid')
  })

  it('载荷整体非对象（null）→ route_shape_invalid 拒绝（此前该形态在语义检查处 TypeError）', () => {
    const result = validateAggregationRouteUpsert(null as unknown as AggregationRoute, existing)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('route_shape_invalid')
  })

  it('错误消息逐字段指名（可定位到端点条目与字段）', () => {
    const bad = routeWith({ members: [{ id: 'ep', providerId: 'p', modelId: 'm', type: 'score' }] })
    const result = validateAggregationRouteUpsert(bad, existing)
    if (!result.ok) expect(result.errors.join('；')).toContain('type')
  })

  it('UI 正常保存形态照常通过（新建路由草稿 + 条件切换产出的全字段端点 + 特殊日期双型）', () => {
    const uiRoute = makeRoute({
      id: 'new-route',
      name: '新路由',
      modelId: 'seed-model',
      mode: 'advanced',
      members: [
        // buildNewRouteDraft 预填端点形态（route-editor-ops.ts：短码 id + type none）
        { id: 'm-lz3k9x-7f2a', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'none' },
        // endpoint-condition-type 切换产出的形态：整表 window + 缺省阈值 quota（缺表补工作日窗）
        { id: 'm-lz3k9y-91cd', providerId: 'opencode-go', modelId: 'zai-glm-5.3-flash', type: 'combo', window: Array.from({ length: 7 }, () => Array<boolean>(48).fill(false)), quota: { thresholdPercent: 20 } },
        // schema 定形字段（M1 编辑器不产不回填，形态契约仍在写侧放行域内）
        { id: 'm-lz3k9z-ab3e', providerId: 'zhipu', modelId: 'glm-5.2', type: 'quota', quota: { thresholdPercent: 100 }, levels: { high: 'high', medium: null } },
      ],
      specials: [
        { id: 'sp-lz3ka0-01', date: '2026-12-24', mode: 'exclude' },
        { id: 'sp-lz3ka1-02', date: '2026-12-25', mode: 'include', from: '10:00', to: '12:00' },
      ],
    })
    expect(validateAggregationRouteUpsert(uiRoute, existing).ok).toBe(true)
  })

  it('id 字符集格式违规仍走既有 route_id_invalid 专用语义（形态门不接管格式类，修复指引保留）', () => {
    const result = validateAggregationRouteUpsert(routeWith({ id: 'Bad_Id' }), existing)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('route_id_invalid')
  })
})

// ── A11-5 悬空端点标记（provider 已删 / 模型已移除两类） ─────────────────────────────

describe('悬空端点标记（annotateDanglingMembers）', () => {
  const validModels = new Map<string, ReadonlySet<string>>([
    ['zhipu', new Set(['glm-5.3-flash', 'glm-5.2'])],
    ['opencode-go', new Set(['zai-glm-5.3-flash'])],
  ])

  it('有效端点零标记', () => {
    const routes = [makeRoute({
      members: [
        { id: 'ep-1', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'none' },
        { id: 'ep-2', providerId: 'opencode-go', modelId: 'zai-glm-5.3-flash', type: 'none' },
      ],
    })]
    expect(annotateDanglingMembers(routes, validModels)).toEqual([])
  })

  it('provider 不在索引 → provider-deleted 标记', () => {
    const routes = [makeRoute({ members: [{ id: 'ep', providerId: 'ghost', modelId: 'm', type: 'none' }] })]
    const issues: AggregationMemberIssue[] = annotateDanglingMembers(routes, validModels)
    expect(issues).toEqual([{
      routeId: 'glm-flash',
      memberIndex: 0,
      memberRef: 'ghost/m',
      reason: 'provider-deleted',
    }])
  })

  it('provider 在但模型不在其集合 → model-removed 标记', () => {
    const routes = [makeRoute({ members: [{ id: 'ep', providerId: 'zhipu', modelId: 'removed-model', type: 'none' }] })]
    const issues = annotateDanglingMembers(routes, validModels)
    expect(issues).toHaveLength(1)
    expect(issues[0].reason).toBe('model-removed')
    expect(issues[0].memberRef).toBe('zhipu/removed-model')
  })

  it('多路由混合：标记携带 routeId 与 memberIndex 定位', () => {
    const routes = [
      makeRoute({ id: 'route-a', members: [
        { id: 'ep-1', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'none' },
        { id: 'ep-2', providerId: 'ghost', modelId: 'm', type: 'none' },
      ] }),
      makeRoute({ id: 'route-b', members: [
        { id: 'ep-1', providerId: 'opencode-go', modelId: 'gone', type: 'none' },
      ] }),
    ]
    const issues = annotateDanglingMembers(routes, validModels)
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatchObject({ routeId: 'route-a', memberIndex: 1, reason: 'provider-deleted' })
    expect(issues[1]).toMatchObject({ routeId: 'route-b', memberIndex: 0, reason: 'model-removed' })
  })
})

// ── A11-6 scopedModels 失效引用标记（读取侧标记，不自动写） ──────────────────────────

describe('失效引用收集（collectOrphanAggregationRefs）', () => {
  const routes = [makeRoute({ id: 'glm-flash' })]

  it('解析不到 routes 定义的聚合复合串 → 失效引用', () => {
    expect(collectOrphanAggregationRefs([`${AGGREGATION_PROVIDER_ID}/deleted-route`], routes))
      .toEqual([`${AGGREGATION_PROVIDER_ID}/deleted-route`])
  })

  it('解析得到的路由引用不是失效引用', () => {
    expect(collectOrphanAggregationRefs([buildAggregationModelRef('glm-flash')], routes)).toEqual([])
  })

  it('物理 provider 复合串不进失效引用判定（与 routes 域无关）', () => {
    expect(collectOrphanAggregationRefs(['zhipu/glm-5.3-flash', 'opencode-go/zai-glm-5.3-flash'], routes)).toEqual([])
  })

  it('provider 段为聚合 id 但 model 段为空 → 不收集（该形态被上游 sanitizeScopedModels 的 isModelRef 过滤，读取入口恒不可见——分层职责，非本函数判定对象）', () => {
    expect(collectOrphanAggregationRefs([`${AGGREGATION_PROVIDER_ID}/`], routes)).toEqual([])
  })
})

// ── U5 补呈现：供应商路由引用投影（外部 spec §6.3 行摘要 / §6.4 引用区单源） ──────────

describe('供应商路由引用投影（collectProviderRouteRefs）', () => {
  const routes = [
    makeRoute({
      id: 'glm-flash',
      name: 'GLM Flash',
      members: [
        { id: 'ep-z1', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'none' },
        { id: 'ep-o1', providerId: 'opencode-go', modelId: 'zai-glm-5.3-flash', type: 'quota', quota: { thresholdPercent: 20 } },
        { id: 'ep-z2', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'window', window: Array.from({ length: 7 }, () => Array<boolean>(48).fill(false)) },
      ],
    }),
    makeRoute({ id: 'sonnet-route', name: 'Sonnet', members: [{ id: 'ep-z3', providerId: 'zhipu', modelId: 'glm-5.3-flash', type: 'none' }] }),
    makeRoute({ id: 'unrelated', name: 'Unrelated', members: [{ id: 'ep-x', providerId: 'other', modelId: 'm', type: 'none' }] }),
  ]

  it('routeCount 按路由去重（spec §6.3：不是端点数）', () => {
    const refs = collectProviderRouteRefs(routes, 'zhipu')
    expect(refs.routeCount).toBe(2) // glm-flash 两端点 + sonnet-route 一端点，去重后 2 条路由
  })

  it('refs 每端点一条，按路由卡序 + 端点序稳定排序', () => {
    const refs = collectProviderRouteRefs(routes, 'zhipu')
    expect(refs.refs).toEqual([
      { routeId: 'glm-flash', routeName: 'GLM Flash', memberId: 'ep-z1', memberIndex: 0 },
      { routeId: 'glm-flash', routeName: 'GLM Flash', memberId: 'ep-z2', memberIndex: 2 },
      { routeId: 'sonnet-route', routeName: 'Sonnet', memberId: 'ep-z3', memberIndex: 0 },
    ])
  })

  it('无引用渠道 = 零值投影（行摘要「未参与路由」与引用区空文案统一判据）', () => {
    expect(collectProviderRouteRefs(routes, 'no-ref-provider')).toEqual({ routeCount: 0, refs: [] })
    expect(collectProviderRouteRefs([], 'zhipu')).toEqual({ routeCount: 0, refs: [] })
  })

  it('投影类型随路由 wire 域演进而编译期锁定（memberIndex 数字 / memberId 锚字符串）', () => {
    expectTypeOf<AggregationProviderRouteRef['memberIndex']>().toEqualTypeOf<number>()
    expectTypeOf<AggregationProviderRouteRef['memberId']>().toEqualTypeOf<string>()
  })
})

// ── A11-7 复合串对齐键工具 ────────────────────────────────────────────────────────────

describe('复合串对齐键工具（set_model / 会话还原 / 目录注入共用）', () => {
  it('buildAggregationModelRef = <聚合providerId>/<routeId>', () => {
    expect(buildAggregationModelRef('glm-flash')).toBe(`${AGGREGATION_PROVIDER_ID}/glm-flash`)
  })

  it('isAggregationModelRef：聚合前缀命中、物理 provider 不命中', () => {
    expect(isAggregationModelRef(`${AGGREGATION_PROVIDER_ID}/glm-flash`)).toBe(true)
    expect(isAggregationModelRef('zhipu/glm-5.3-flash')).toBe(false)
    expect(isAggregationModelRef(`${AGGREGATION_PROVIDER_ID}-like/model`)).toBe(false)
  })

  it('aggregationRouteIdFromRef：取路由 id 段；非聚合引用 / 空 id 段 → undefined', () => {
    expect(aggregationRouteIdFromRef(`${AGGREGATION_PROVIDER_ID}/glm-flash`)).toBe('glm-flash')
    expect(aggregationRouteIdFromRef('zhipu/glm-5.3-flash')).toBeUndefined()
    expect(aggregationRouteIdFromRef(`${AGGREGATION_PROVIDER_ID}/`)).toBeUndefined()
  })
})

// ── A11-8 wire 类型与 kind 枚举完备（编译期契约断言） ────────────────────────────────

describe('wire 帧与 kind 枚举完备（F2 契约前移）', () => {
  it('ProviderKind 含 aggregation（D4 ① 枚举扩展）', () => {
    expectTypeOf<ProviderKind>().toEqualTypeOf<'catalog' | 'custom' | 'aggregation'>()
  })

  it('ProviderInfo.kind 可选 ProviderKind（既有构造点零破坏）', () => {
    expectTypeOf<ProviderInfo['kind']>().toEqualTypeOf<ProviderKind | undefined>()
  })

  it('ModelInfo.aggregation 路由标记字段：可选 boolean（undefined = 物理模型）', () => {
    expectTypeOf<ModelInfo['aggregation']>().toEqualTypeOf<boolean | undefined>()
  })

  it('三 RPC 在 ClientMessageType 登记', () => {
    expectTypeOf<'aggregation.getRouteView'>().toExtend<ClientMessageType>()
    expectTypeOf<'aggregation.saveRoute'>().toExtend<ClientMessageType>()
    expectTypeOf<'aggregation.deleteRoute'>().toExtend<ClientMessageType>()
  })

  it('request payload 形状（形状 SSOT = aggregation.ts，本 map 仅登记）', () => {
    expectTypeOf<ClientMessageMap['aggregation.getRouteView']>().toEqualTypeOf<Record<string, never>>()
    expectTypeOf<ClientMessageMap['aggregation.saveRoute']>().toEqualTypeOf<{ route: AggregationRoute }>()
    expectTypeOf<ClientMessageMap['aggregation.deleteRoute']>().toEqualTypeOf<{ routeId: string }>()
  })

  it('reply payload 与 request 异名配对（payload 消费型同名段模式）', () => {
    expectTypeOf<ServerMessageMap['aggregation.routeView']>().toEqualTypeOf<AggregationRouteView>()
    expectTypeOf<ServerMessageMap['aggregation.routeSaved']>().toEqualTypeOf<AggregationRouteSaved>()
    expectTypeOf<ServerMessageMap['aggregation.routeDeleted']>().toEqualTypeOf<AggregationRouteDeleted>()
    expectTypeOf<ReplyPayloadMap['aggregation.getRouteView']>().toEqualTypeOf<AggregationRouteView>()
    expectTypeOf<ReplyPayloadMap['aggregation.saveRoute']>().toEqualTypeOf<AggregationRouteSaved>()
    expectTypeOf<ReplyPayloadMap['aggregation.deleteRoute']>().toEqualTypeOf<AggregationRouteDeleted>()
  })
})
