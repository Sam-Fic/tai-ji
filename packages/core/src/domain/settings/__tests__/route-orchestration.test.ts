/**
 * 模型路由双权威编排单测（provider-aggregation A10：join 视图 / 孤儿引用 / 保存顺序与
 * 回滚 / 删除精确清理；设计 D10/D11，U9 检查点全集）。
 *
 * 被测模块 = route-orchestration deep module（纯函数 + port 注入编排器，第①/②档判据：
 * 同步逻辑直进直出、异步 await 确定性 promise，无真进程/真 IO/时间窗）。IO 半边
 * （runtime aggregation-message-handler 的 store 读写与 wire reply/广播）不在 core 包
 * testCommand 覆盖范围——由 D2 Gate A 全量回归承担（实施计划验收分工）。
 */
import { describe, it, expect } from 'vitest'
import type {
  AggregationMemberIssue,
  AggregationRoute,
  AggregationRouteView,
  ProviderId,
} from '@taiji/shared'
import {
  AGGREGATION_PROVIDER_ID,
  buildAggregationModelRef,
} from '@taiji/shared'
import {
  buildAggregationRouteView,
  buildRoutePageCards,
  createRouteSaveOrchestrator,
  resolveDefaultSyncAfterScopedWrite,
  scopedModelsWithRouteRemoved,
  type RouteOrchestrationPorts,
  type RoutePageProviderIndex,
} from '../route-orchestration'

// ── fixture（结构满足 shared parseAggregationRoutesSection 的合法路由形态） ────────────

function makeMember(id: string, overrides: Partial<{ providerId: string; modelId: string }> = {}) {
  return {
    id,
    providerId: overrides.providerId ?? 'zhipu',
    modelId: overrides.modelId ?? 'glm-5.3',
    type: 'none' as const,
  }
}

function makeRoute(id: string, overrides: Partial<AggregationRoute> = {}): AggregationRoute {
  return {
    id,
    name: `路由 ${id}`,
    modelId: id,
    enabled: true,
    mode: 'simple',
    members: [makeMember(`${id}-m1`)],
    specials: [],
    ...overrides,
  }
}

function makeView(overrides: Partial<AggregationRouteView> = {}): AggregationRouteView {
  return { cards: [], orphanRefs: [], ...overrides }
}

/** 悬空端点标记 fixture（provider 已删）。 */
function danglingIssue(routeId: string, memberIndex = 0): AggregationMemberIssue {
  return { routeId, memberIndex, memberRef: 'ghost/gone-model', reason: 'provider-deleted' }
}

describe('A10 join 视图：buildAggregationRouteView', () => {
  it('卡片集合 = routes 定义的模型全集（含 scopedModels 未参与条目——卡片开关关形态）', () => {
    const view = buildAggregationRouteView({
      routes: [makeRoute('alpha'), makeRoute('beta')],
      scopedModels: [buildAggregationModelRef('alpha')],
      memberIssues: [],
      orphanRefs: [],
    })
    expect(view.cards.map(c => c.route.id)).toEqual(['alpha', 'beta'])
    const alpha = view.cards.find(c => c.route.id === 'alpha')!
    const beta = view.cards.find(c => c.route.id === 'beta')!
    expect(alpha.scoped).toBe(true)
    expect(alpha.scopedIndex).toBe(0)
    // routes 定义但未加入 scopedModels → 「未参与选择」态（卡片开关关），加入后即出现在选择器
    expect(beta.scoped).toBe(false)
    expect(beta.scopedIndex).toBe(-1)
  })

  it('卡片顺序 = scopedModels 序在前（按 scopedIndex 升序交错）、未参与路由卡跟后', () => {
    const view = buildAggregationRouteView({
      routes: [makeRoute('a'), makeRoute('b'), makeRoute('c'), makeRoute('d')],
      // 白名单序：c(3) < a(5)；b 未参与；routes 数组序 = a,b,c,d——期望 c,a 在前（按白名单位置），b,d 跟后
      scopedModels: [
        'phys/one',
        buildAggregationModelRef('c'),
        'phys/two',
        buildAggregationModelRef('a'),
      ],
      memberIssues: [],
      orphanRefs: [],
    })
    expect(view.cards.map(c => c.route.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(view.cards.map(c => c.scopedIndex)).toEqual([1, 3, -1, -1])
  })

  it('悬空端点标记按 routeId 分组进卡（卡片显示标记提示的数据半边）', () => {
    const issues = [danglingIssue('b', 0), danglingIssue('a', 1), danglingIssue('b', 2)]
    const view = buildAggregationRouteView({
      routes: [makeRoute('a'), makeRoute('b')],
      scopedModels: [],
      memberIssues: issues,
      orphanRefs: [],
    })
    expect(view.cards.find(c => c.route.id === 'a')!.memberIssues).toEqual([issues[1]])
    expect(view.cards.find(c => c.route.id === 'b')!.memberIssues).toEqual([issues[0], issues[2]])
  })

  it('损坏隔离呈报透传（corrupted=true 带 corruptedFilePath；未损坏不携带字段）', () => {
    const clean = buildAggregationRouteView({
      routes: [], scopedModels: [], memberIssues: [], orphanRefs: [],
    })
    expect('corrupted' in clean).toBe(false)
    expect('corruptedFilePath' in clean).toBe(false)
    const corrupted = buildAggregationRouteView({
      routes: [], scopedModels: [], memberIssues: [], orphanRefs: [],
      corrupted: true, corruptedFilePath: '/data/agent/config/.corrupt-123',
    })
    expect(corrupted.corrupted).toBe(true)
    expect(corrupted.corruptedFilePath).toBe('/data/agent/config/.corrupt-123')
  })
})

describe('A10 孤儿引用：不生成路由卡，只进提示条', () => {
  it('scopedModels 中解析不到 routes 定义的聚合引用不出现在卡片集合、原值进 orphanRefs', () => {
    const ghostRef = buildAggregationModelRef('deleted-route')
    const view = buildAggregationRouteView({
      routes: [makeRoute('alpha')],
      scopedModels: [buildAggregationModelRef('alpha'), ghostRef, 'zhipu/glm-5.3'],
      memberIssues: [],
      orphanRefs: [ghostRef],
    })
    expect(view.cards.map(c => c.route.id)).toEqual(['alpha'])
    expect(view.orphanRefs).toEqual([ghostRef])
  })

  it('物理模型复合串不进孤儿判定输入时视图原样保留 orphanRefs（读取侧已过滤非聚合引用）', () => {
    const view = buildAggregationRouteView({
      routes: [], scopedModels: ['zhipu/glm-5.3'], memberIssues: [], orphanRefs: [],
    })
    expect(view.cards).toEqual([])
    expect(view.orphanRefs).toEqual([])
  })
})

describe('A10 路由页卡片派生：buildRoutePageCards（scopedModels 条目 ∪ routes 定义的模型）', () => {
  // id 走 branded ProviderId 断言（scopedModels 拆段是裸 string，provider 索引按宽 key 构建）
  const providers: RoutePageProviderIndex = [
    { id: 'zhipu' as ProviderId, name: '智谱', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }], apiKeySet: true },
    { id: 'opencode-go' as ProviderId, name: 'OpenCode Go', models: [{ id: 'glm-5.2', name: 'GLM-5.2' }], apiKeySet: true },
  ]

  it('卡片顺序 = scopedModels 序交错（路由卡与渠道直连卡按白名单位置排列）+ 未参与路由卡跟后', () => {
    const view = buildAggregationRouteView({
      routes: [makeRoute('route-a'), makeRoute('route-b')],
      scopedModels: ['zhipu/glm-5.3', buildAggregationModelRef('route-a')],
      memberIssues: [],
      orphanRefs: [],
    })
    const cards = buildRoutePageCards(view, ['zhipu/glm-5.3', buildAggregationModelRef('route-a')], providers)
    expect(cards.map(c => c.kind)).toEqual(['direct', 'route', 'route'])
    // 未参与路由卡（route-b）跟在 scoped 段之后
    expect(cards.map(c => (c.kind === 'route' ? c.card.route.id : c.ref))).toEqual(['zhipu/glm-5.3', 'route-a', 'route-b'])
  })

  it('无 routes 的白名单模型显示渠道直连形态（渲染元数据由 providers 派生）', () => {
    const view = makeView()
    const cards = buildRoutePageCards(view, ['zhipu/glm-5.3'], providers)
    expect(cards).toHaveLength(1)
    const direct = cards[0]!
    expect(direct).toMatchObject({
      kind: 'direct',
      ref: 'zhipu/glm-5.3',
      providerId: 'zhipu',
      modelId: 'glm-5.3',
      providerName: '智谱',
      modelName: 'GLM-5.3',
      apiKeySet: true,
      missing: false,
    })
  })

  it('provider 已删 / 模型已移除的直连条目 missing=true、名称降级回 id（原值保留不丢弃）', () => {
    const cards = buildRoutePageCards(makeView(), ['ghost/gone-model', 'zhipu/removed-model'], providers)
    expect(cards[0]).toMatchObject({ kind: 'direct', ref: 'ghost/gone-model', providerName: 'ghost', modelName: 'gone-model', missing: true })
    expect(cards[1]).toMatchObject({ kind: 'direct', ref: 'zhipu/removed-model', providerName: '智谱', modelName: 'removed-model', missing: true })
  })

  it('孤儿引用不生成卡（失效引用提示条数据 = view.orphanRefs，由 UI 直接取用）', () => {
    const ghostRef = buildAggregationModelRef('deleted-route')
    const view = buildAggregationRouteView({
      routes: [makeRoute('route-a')],
      scopedModels: [ghostRef],
      memberIssues: [],
      orphanRefs: [ghostRef],
    })
    const cards = buildRoutePageCards(view, [ghostRef], providers)
    expect(cards.map(c => c.kind)).toEqual(['route'])
    expect(cards).toHaveLength(1)
    expect((cards[0] as { card: { route: { id: string } } }).card.route.id).toBe('route-a')
  })
})

// ── 保存编排（跨两权威：routes 先写、scopedModels 后写、失败回滚 routes） ──────────────

interface PortCallLog { // oe-exempt:20261106:framework:PortCallLog 测试 fixture，单实现为设计终态
  calls: Array<{ port: string; arg: unknown }>
}

function makePorts(overrides: Partial<RouteOrchestrationPorts> = {}, log: PortCallLog = { calls: [] }): {
  ports: RouteOrchestrationPorts
  log: PortCallLog
} {
  const record = (port: string, arg: unknown) => log.calls.push({ port, arg })
  // overrides 以 wrapper 形态叠加（保留调用账记录，替换实现语义）。
  const ports: RouteOrchestrationPorts = {
    async getRouteView() {
      record('getRouteView', undefined)
      return makeView()
    },
    saveRoute: overrides.saveRoute
      ? async (route) => { record('saveRoute', route.id); return overrides.saveRoute!(route) }
      : async (route) => { record('saveRoute', route.id); return { route, memberIssues: [] } },
    deleteRoute: overrides.deleteRoute
      ? async (routeId) => { record('deleteRoute', routeId); return overrides.deleteRoute!(routeId) }
      : async (routeId) => { record('deleteRoute', routeId); return { routeId, scopedModels: [] } },
    setScopedModels: overrides.setScopedModels
      ? async (models) => { record('setScopedModels', models); return overrides.setScopedModels!(models) }
      : async (models) => { record('setScopedModels', models); return models },
  }
  return { ports, log }
}

describe('A10 保存顺序与回滚：createRouteSaveOrchestrator', () => {
  const prior = makeRoute('alpha', { members: [makeMember('old')] })
  const next = makeRoute('alpha', { members: [makeMember('new', { providerId: 'opencode-go', modelId: 'glm-5.2' })] })

  it('一次保存跨两权威：saveRoute 先于 setScopedModels（routes 先写、白名单后写）', async () => {
    const { ports, log } = makePorts()
    const outcome = await createRouteSaveOrchestrator(ports).save({
      route: next,
      priorRoute: prior,
      scopedModels: [buildAggregationModelRef('alpha'), 'zhipu/glm-5.3'],
    })
    expect(outcome.ok).toBe(true)
    expect(log.calls.map(c => c.port)).toEqual(['saveRoute', 'setScopedModels'])
    expect(log.calls[0]).toEqual({ port: 'saveRoute', arg: 'alpha' })
    if (outcome.ok) {
      expect(outcome.saved?.route.id).toBe('alpha')
      expect(outcome.scopedModels).toEqual([buildAggregationModelRef('alpha'), 'zhipu/glm-5.3'])
    }
  })

  it('纯排序/开关保存只写 scopedModels（既有通道，default 同步编排内建于该通道）', async () => {
    const { ports, log } = makePorts()
    const outcome = await createRouteSaveOrchestrator(ports).save({
      scopedModels: ['zhipu/glm-5.3', buildAggregationModelRef('alpha')],
    })
    expect(outcome.ok).toBe(true)
    expect(log.calls.map(c => c.port)).toEqual(['setScopedModels'])
    if (outcome.ok) expect(outcome.saved).toBeNull()
  })

  it('routes 写失败：scopedModels 未动（两权威一致），stage=routes', async () => {
    const { ports, log } = makePorts({ saveRoute: async () => { throw new Error('route_id_conflict') } })
    const outcome = await createRouteSaveOrchestrator(ports).save({ route: next, priorRoute: prior, scopedModels: [] })
    expect(outcome).toMatchObject({ ok: false, stage: 'routes' })
    expect(log.calls.map(c => c.port)).toEqual(['saveRoute'])
  })

  it('scopedModels 写失败（编辑）：routes 回滚到 priorRoute，stage=scoped-rolled-back', async () => {
    const { ports, log } = makePorts({ setScopedModels: async () => { throw new Error('write failed') } })
    const outcome = await createRouteSaveOrchestrator(ports).save({ route: next, priorRoute: prior, scopedModels: ['zhipu/glm-5.3'] })
    expect(outcome).toMatchObject({ ok: false, stage: 'scoped-rolled-back' })
    // 回滚 = saveRoute(priorRoute)（幂等替换回旧值）——不是 deleteRoute（编辑语义）
    expect(log.calls.map(c => c.port)).toEqual(['saveRoute', 'setScopedModels', 'saveRoute'])
    expect(log.calls[2]).toEqual({ port: 'saveRoute', arg: 'alpha' })
  })

  it('scopedModels 写失败（新建）：回滚 = deleteRoute 撤销刚建条目（priorRoute=null 语义）', async () => {
    const { ports, log } = makePorts({ setScopedModels: async () => { throw new Error('write failed') } })
    const outcome = await createRouteSaveOrchestrator(ports).save({ route: next, priorRoute: null, scopedModels: ['zhipu/glm-5.3'] })
    expect(outcome).toMatchObject({ ok: false, stage: 'scoped-rolled-back' })
    expect(log.calls.map(c => c.port)).toEqual(['saveRoute', 'setScopedModels', 'deleteRoute'])
    expect(log.calls[2]).toEqual({ port: 'deleteRoute', arg: 'alpha' })
  })

  it('scopedModels 写失败且无 routes 写：不触发回滚（两权威一致），stage=scoped', async () => {
    const { ports, log } = makePorts({ setScopedModels: async () => { throw new Error('write failed') } })
    const outcome = await createRouteSaveOrchestrator(ports).save({ scopedModels: ['zhipu/glm-5.3'] })
    expect(outcome).toMatchObject({ ok: false, stage: 'scoped' })
    expect(log.calls.map(c => c.port)).toEqual(['setScopedModels'])
  })

  it('回滚也失败：stage=scoped-rollback-failed 显式残留态（routes 已写、白名单未跟上），rollbackError 携带', async () => {
    const rollbackError = new Error('rollback failed')
    // 编辑语义 prior/next 的 id 相同（id 不改名），按调用次数分流：主写成功、回滚失败。
    let saveRouteCalls = 0
    const { ports, log } = makePorts({
      setScopedModels: async () => { throw new Error('write failed') },
      saveRoute: async (route) => {
        saveRouteCalls += 1
        if (saveRouteCalls === 1) return { route, memberIssues: [] }
        throw rollbackError
      },
    })
    const outcome = await createRouteSaveOrchestrator(ports).save({ route: next, priorRoute: prior, scopedModels: ['zhipu/glm-5.3'] })
    expect(outcome).toMatchObject({ ok: false, stage: 'scoped-rollback-failed', rollbackError })
    expect(log.calls.map(c => c.port)).toEqual(['saveRoute', 'setScopedModels', 'saveRoute'])
  })

  it('删除：透传 runtime 双写编排（routes 删除 + scopedModels 精确清理内建于 aggregation.deleteRoute）', async () => {
    const { ports, log } = makePorts()
    const deleted = await createRouteSaveOrchestrator(ports).delete('alpha')
    expect(deleted.routeId).toBe('alpha')
    expect(log.calls.map(c => c.port)).toEqual(['deleteRoute'])
  })

  it('空意图 fail-fast（保存按钮在无变化时不应可点——调用方编排错误显式暴露）', async () => {
    const { ports, log } = makePorts()
    const outcome = await createRouteSaveOrchestrator(ports).save({})
    expect(outcome).toMatchObject({ ok: false, stage: 'routes' })
    expect(log.calls).toEqual([])
  })
})

// ── 删除精确清理 + 复合串形态兼容 ──────────────────────────────────────────────────────

describe('A10 删除精确清理：scopedModelsWithRouteRemoved', () => {
  it('只移除目标路由复合串的全部出现；物理条目与其他路由条目原样保留、顺序不变', () => {
    const scoped = [
      'zhipu/glm-5.3',
      buildAggregationModelRef('alpha'),
      buildAggregationModelRef('beta'),
      'opencode-go/glm-5.2',
      buildAggregationModelRef('alpha'), // 重复条目（sanitize 前形态）同样精确移除
    ]
    const cleaned = scopedModelsWithRouteRemoved(scoped, 'alpha')
    expect(cleaned).toEqual([
      'zhipu/glm-5.3',
      buildAggregationModelRef('beta'),
      'opencode-go/glm-5.2',
    ])
  })

  it('同一聚合 provider 承载全部路由：清理不得按 provider 前缀误删其他路由条目（D9 回归锚）', () => {
    const scoped = [buildAggregationModelRef('alpha'), buildAggregationModelRef('beta'), buildAggregationModelRef('gamma')]
    const cleaned = scopedModelsWithRouteRemoved(scoped, 'beta')
    expect(cleaned).toEqual([buildAggregationModelRef('alpha'), buildAggregationModelRef('gamma')])
  })

  it('路由模型条目复合串形态与既有 isModelRef 校验兼容（provider/modelId 两段非空、单分隔符）', () => {
    // isModelRef 真实执行点 = runtime config.setScopedModels 入口格式校验；本断言以同语义
    // 谓词锁定兼容性（保留 id 与 routeId 规则变化时此处红灯）。
    const isModelRefShape = (ref: string) => /^[^/]+\/.+$/.test(ref)
    for (const routeId of ['alpha', 'route-with-dash', 'r1']) {
      const ref = buildAggregationModelRef(routeId)
      expect(isModelRefShape(ref)).toBe(true)
      expect(ref.startsWith(`${AGGREGATION_PROVIDER_ID}/`)).toBe(true)
    }
  })
})

// ── 默认编排决策（与 setScopedModels 既有编排同语义的决策单点） ────────────────────────

describe('A10 默认编排决策：resolveDefaultSyncAfterScopedWrite', () => {
  const providers = [
    { id: 'zhipu' as ProviderId, enabled: true },
    { id: 'opencode-go' as ProviderId, enabled: false },
  ]

  it('scopedModels 删空：返回 null（保留现有 default，auto-fix 回退归 runtime 既有链）', () => {
    expect(resolveDefaultSyncAfterScopedWrite([], providers)).toBeNull()
  })

  it('新首位 provider 不在目录或已禁用：返回 null（跳过同步保留现有 default）', () => {
    expect(resolveDefaultSyncAfterScopedWrite(['ghost/gone'], providers)).toBeNull()
    expect(resolveDefaultSyncAfterScopedWrite([buildAggregationModelRef('x')], providers)).toBeNull()
    expect(resolveDefaultSyncAfterScopedWrite(['opencode-go/glm-5.2'], providers)).toBeNull()
  })

  it('正常首位：返回写侧目标（provider/modelId 拆解；modelId 段可含 "/" 的复合串同型支持）', () => {
    expect(resolveDefaultSyncAfterScopedWrite(['zhipu/glm-5.3'], providers)).toEqual({
      ref: 'zhipu/glm-5.3', provider: 'zhipu', modelId: 'glm-5.3',
    })
    expect(resolveDefaultSyncAfterScopedWrite(['zhipu/a/b'], providers)).toEqual({
      ref: 'zhipu/a/b', provider: 'zhipu', modelId: 'a/b',
    })
  })

  it('删除路由后清理使首位变化：新首位成为默认目标（V14 默认同步语义的数据半边）', () => {
    const scoped = [buildAggregationModelRef('beta'), 'zhipu/glm-5.3']
    const cleaned = scopedModelsWithRouteRemoved(scoped, 'beta')
    expect(resolveDefaultSyncAfterScopedWrite(cleaned, providers)).toEqual({
      ref: 'zhipu/glm-5.3', provider: 'zhipu', modelId: 'glm-5.3',
    })
  })
})
