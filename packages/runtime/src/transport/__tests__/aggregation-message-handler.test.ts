/**
 * AggregationMessageHandler 广播收尾 + 触发点①钩子接线单测（provider-aggregation U4）：
 * - 广播收尾（U4 一致性修复）：saveRoute / deleteRoute 成功分支都必须触发 providerList
 *   广播（SC2 §2.5「路由保存后即触发广播，运行中会话的 model.list 立即含新条目」）——
 *   saveRoute 曾漏广播（U6 条目），启停/改名后的旧条目在选择器滞留至下一次无关广播；
 * - 触发点①接线（provider-aggregation D3/U4）：saveRoute / deleteRoute 成功分支都必须
 *   调用 ctx.aggregationRoutesMutated 钩子（routes 权威写方时刻的额度按需刷新）——
 *   handler→ctx 钩子段无断言时，重构移除该调用不会被抓（额度数据不再随 routes 保存/
 *   删除刷新，且 simple→advanced 等非 stale 语义翻转场景无补偿）。
 */
import type { WebSocket as WsType } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import type { ClientMessage } from '@taiji/shared'
import type { AggregationRoute } from '@taiji/shared'
import { AGGREGATION_PROVIDER_ID } from '@taiji/shared'
import { AggregationMessageHandler } from '../aggregation-message-handler.js'
import type { SettingsHandlerContext } from '../settings-message-handler.js'
import type { AggregationRoutesReadResult } from '../../services/provider-config-helper.js'

/** 保存/删除链消费的最小 routes 读形态（其余字段按空域语义缺省）。 */
function readResult(routes: AggregationRoute[]): AggregationRoutesReadResult {
  return { routes, scopedModels: [], orphanRefs: [], memberIssues: [], corrupted: false }
}

const sampleRoute: AggregationRoute = {
  id: 'route-a',
  name: 'Route A',
  modelId: 'route-a',
  enabled: true,
  mode: 'simple',
  members: [{ id: 'm1', providerId: 'p1', modelId: 'model-1', type: 'none' }],
  specials: [],
}

/**
 * handler 消费面 mock：只注入 handleSaveRoute/handleDeleteRoute 触达的成员（ctx 全量
 * 契约见 SettingsHandlerContext；缺省成员在本 handler 路径不可达）。vi.fn 挂在具名
 * 收尾方法上，用例按名字取用断言。
 */
function makeCtx(
  routes: AggregationRoute[],
  options: {
    scopedModels?: string[]
    providers?: Array<{ id: string; enabled?: boolean }>
    defaultModel?: { provider: string; modelId: string }
    scopedWriteFails?: boolean
  } = {},
): SettingsHandlerContext {
  const current = routes
  const ctx = {
    configService: {
      readAggregationRoutes: vi.fn(() => ({ ...readResult(current), scopedModels: options.scopedModels ?? [] })),
      modifyAggregationRoutes: vi.fn(async (fn: (cur: AggregationRoute[]) => AggregationRoute[]) => fn(current)),
      listProviders: vi.fn(() => options.providers ?? []),
      getDefaultModel: vi.fn(() => options.defaultModel),
      setDefaultModel: vi.fn(),
      modifyScopedModels: vi.fn(async (fn: (cur: string[]) => string[]) => {
        if (options.scopedWriteFails) throw new Error('scopedModels write failed')
        return fn(options.scopedModels ?? [])
      }),
    },
    reply: vi.fn(),
    sendError: vi.fn(),
    broadcast: vi.fn(),
    broadcastProviderList: vi.fn(),
    aggregationRoutesMutated: vi.fn(),
    nextPushId: vi.fn(() => 'push-1'),
  }
  return ctx as unknown as SettingsHandlerContext
}

const ws = {} as WsType

function saveRouteMsg(route: AggregationRoute): Extract<ClientMessage, { type: 'aggregation.saveRoute' }> {
  return { type: 'aggregation.saveRoute', id: 'msg-1', payload: { route } }
}

// ── saveRoute 拒绝路径（shared validateAggregationRouteUpsert 形态门，残留风险 4）：
//    非 UI 写入口的越界形态在保存入口拒绝（route_shape_invalid），不再把读侧会判损坏
//    （整文件隔离 .corrupt）的形态写进 providers.json。 ────────────────────────────────

describe('AggregationMessageHandler saveRoute 形态拒绝（route_shape_invalid）', () => {
  it('端点形态越界（type 非法值）→ sendError route_shape_invalid，不回执不广播不触发刷新钩子', async () => {
    const ctx = makeCtx([])
    const badRoute = {
      ...sampleRoute,
      id: 'route-bad',
      members: [{ id: 'm1', providerId: 'p1', modelId: 'model-1', type: 'score' }],
    } as unknown as AggregationRoute
    await new AggregationMessageHandler(ctx).handle(saveRouteMsg(badRoute), ws)
    expect(vi.mocked(ctx.sendError)).toHaveBeenCalledWith(ws, 'route_shape_invalid', expect.stringContaining('type'), 'msg-1')
    expect(vi.mocked(ctx.reply)).not.toHaveBeenCalled()
    expect(vi.mocked(ctx.broadcastProviderList)).not.toHaveBeenCalled()
    expect(vi.mocked(ctx.aggregationRoutesMutated)).not.toHaveBeenCalled()
    expect(vi.mocked(ctx.broadcast)).not.toHaveBeenCalled()
  })

  it('特殊日期形态越界（date 非 YYYY-MM-DD）→ 同样 route_shape_invalid 拒绝', async () => {
    const ctx = makeCtx([])
    const badRoute = {
      ...sampleRoute,
      id: 'route-bad-specials',
      specials: [{ id: 'sp', date: '20261001', mode: 'exclude' }],
    } as unknown as AggregationRoute
    await new AggregationMessageHandler(ctx).handle(saveRouteMsg(badRoute), ws)
    expect(vi.mocked(ctx.sendError)).toHaveBeenCalledWith(ws, 'route_shape_invalid', expect.stringContaining('特殊日期'), 'msg-1')
    expect(vi.mocked(ctx.reply)).not.toHaveBeenCalled()
  })

  it('合法路由载荷照常保存（既有成功路径不受形态门影响）', async () => {
    const ctx = makeCtx([])
    await new AggregationMessageHandler(ctx).handle(saveRouteMsg(sampleRoute), ws)
    expect(vi.mocked(ctx.sendError)).not.toHaveBeenCalled()
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(ws, 'msg-1', 'aggregation.routeSaved', { route: sampleRoute, memberIssues: [] })
  })
})

describe('AggregationMessageHandler 广播收尾（SC2 路由保存后即触发 provider 列表广播）', () => {
  it('saveRoute 成功 → broadcastProviderList 触发一次 + routeView 广播发出', async () => {
    const ctx = makeCtx([])
    await new AggregationMessageHandler(ctx).handle(saveRouteMsg(sampleRoute), ws)
    expect(vi.mocked(ctx.broadcastProviderList)).toHaveBeenCalledTimes(1)
    // 触发点①接线（D3/U4）：保存成功必须调用额度刷新钩子（可选钩子由 makeCtx 注入 spy）。
    expect(vi.mocked(ctx.aggregationRoutesMutated)).toHaveBeenCalledTimes(1)
    const viewBroadcasts = vi.mocked(ctx.broadcast).mock.calls.filter(
      ([m]) => (m as { type: string }).type === 'aggregation.routeView',
    )
    expect(viewBroadcasts).toHaveLength(1)
  })

  it('deleteRoute 成功 → broadcastProviderList 同样触发（既有行为防回归）', async () => {
    const ctx = makeCtx([sampleRoute])
    await new AggregationMessageHandler(ctx).handle(
      { type: 'aggregation.deleteRoute', id: 'msg-2', payload: { routeId: 'route-a' } },
      ws,
    )
    expect(vi.mocked(ctx.broadcastProviderList)).toHaveBeenCalledTimes(1)
    // 触发点①接线（D3/U4）：删除同样走 routes 写方时刻刷新钩子（与 saveRoute 分支对称）。
    expect(vi.mocked(ctx.aggregationRoutesMutated)).toHaveBeenCalledTimes(1)
  })
})

describe('AggregationMessageHandler 删除编排的 default 同步（U9 失败恢复语义）', () => {
  const aggRef = `${AGGREGATION_PROVIDER_ID}/route-a`
  /** 清理成功路径的正控制：清理后新首位是物理模型 → default 同步发生。 */
  it('清理成功 + 被删路由原为 scopedModels[0] + currentDefault 为其他模型 → setDefaultModel 同步新首位', async () => {
    const ctx = makeCtx([sampleRoute], {
      scopedModels: [aggRef, 'p1/model-1'],
      providers: [
        { id: AGGREGATION_PROVIDER_ID },
        { id: 'p1' },
      ],
      defaultModel: { provider: 'p2', modelId: 'model-2' },
    })
    await new AggregationMessageHandler(ctx).handle(
      { type: 'aggregation.deleteRoute', id: 'msg-3', payload: { routeId: 'route-a' } },
      ws,
    )
    expect(vi.mocked(ctx.configService.setDefaultModel)).toHaveBeenCalledWith('p1', 'model-1')
    const defaultsBroadcasts = vi.mocked(ctx.broadcast).mock.calls.filter(
      ([m]) => (m as { type: string }).type === 'config.defaults',
    )
    expect(defaultsBroadcasts).toHaveLength(1)
  })

  /**
   * 回归锁定（F1-25 修复语义）：清理失败时 cleaned 回落删除前原值（含被删路由引用），
   * 以它为基准同步 default 会把已删路由写入 settings.json default 并广播假默认——
   * 「新第一位即默认」前提不成立，必须整体跳过（残留 default 悬空由 findValidDefaultModel
   * 既有 auto-fix 兜底）。
   */
  it('清理失败 + 被删路由在 scopedModels[0] + currentDefault 为其他模型 → 不写 default、不广播 config.defaults', async () => {
    const ctx = makeCtx([sampleRoute], {
      scopedModels: [aggRef, 'p1/model-1'],
      providers: [
        { id: AGGREGATION_PROVIDER_ID },
        { id: 'p1' },
      ],
      defaultModel: { provider: 'p2', modelId: 'model-2' },
      scopedWriteFails: true,
    })
    await new AggregationMessageHandler(ctx).handle(
      { type: 'aggregation.deleteRoute', id: 'msg-4', payload: { routeId: 'route-a' } },
      ws,
    )
    expect(vi.mocked(ctx.configService.setDefaultModel)).not.toHaveBeenCalled()
    const defaultsBroadcasts = vi.mocked(ctx.broadcast).mock.calls.filter(
      ([m]) => (m as { type: string }).type === 'config.defaults',
    )
    expect(defaultsBroadcasts).toHaveLength(0)
    // 回执仍按删除主语义发出（cleaned = 删除前原值），广播收尾不受清理失败影响。
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      ws,
      'msg-4',
      'aggregation.routeDeleted',
      { routeId: 'route-a', scopedModels: [aggRef, 'p1/model-1'] },
    )
    expect(vi.mocked(ctx.broadcastProviderList)).toHaveBeenCalledTimes(1)
  })
})
