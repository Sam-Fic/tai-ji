/**
 * SmartContextConfigMessageHandler 6 case 契约测试（C3 独立压缩设置页：5 setter + get）。
 *
 * 逐 case 断言三件事：①路由命中（handle 返回 true）②调对 configService setter（透传
 * payload）③reply 帧类型 / id / payload = getSmartContextConfig 读回的对应键生效值
 * （setter 均无返回值，reply 读回是生效值唯一来源）。未知 type 返回 false 由上层继续路由。
 *
 * configService 以闭包模拟存储桩接（handler-settings-bundle mockCtx_m4 同款形态）：
 * setter 记值、get 读回，reply「读回生效值」语义在桩内可见；smart-context-config.ts
 * 的落盘/RMW 行为由 services/__tests__/（threshold-ratio / default-parity）覆盖，不在此重复。
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ServerMessage } from '@taiji/shared'
import { SmartContextConfigMessageHandler } from '../smart-context-config-message-handler.js'
import type { SettingsHandlerContext } from '../settings-message-handler.js'

const TEST_WS = {} as never as WsType

/** 闭包模拟存储桩：setter 记值 + get 读回（全量快照形状与 SmartContextConfigSnapshot 一致）。 */
function mockCtx() {
  const replies: ServerMessage[] = []
  const stored = {
    enabled: true,
    compactModel: '',
    reminderThresholds: [400_000, 500_000, 600_000],
    excludedModels: [] as string[],
    autoCompactThresholdRatio: 0.9,
  }
  const configService = {
    getSmartContextConfig: vi.fn(() => ({
      ...stored,
      reminderThresholds: [...stored.reminderThresholds],
      excludedModels: [...stored.excludedModels],
    })),
    setSmartContextEnabled: vi.fn((enabled: boolean) => {
      stored.enabled = enabled
    }),
    setSmartContextCompactModel: vi.fn((model: string) => {
      stored.compactModel = model
    }),
    setSmartContextThresholds: vi.fn((thresholds: number[]) => {
      stored.reminderThresholds = [...thresholds]
    }),
    setSmartContextExcludedModels: vi.fn((models: string[]) => {
      stored.excludedModels = [...models]
    }),
    setSmartContextAutoCompactThresholdRatio: vi.fn((ratio: number) => {
      stored.autoCompactThresholdRatio = ratio
    }),
  }
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService,
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, configService }
}

function msg(type: ClientMessage['type'], payload: unknown, id = 'm1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

describe('SmartContextConfigMessageHandler 6 case 契约（C3）', () => {
  it('config.getSmartContextConfig → reply 全量快照（含 autoCompactThresholdRatio）', async () => {
    const { ctx, replies, configService } = mockCtx()
    const handled = await new SmartContextConfigMessageHandler(ctx).handle(msg('config.getSmartContextConfig', {}), TEST_WS)

    expect(handled).toBe(true)
    expect(configService.getSmartContextConfig).toHaveBeenCalledTimes(1)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'config.smartContextConfig', id: 'm1' })
    expect(replies[0].payload).toEqual({
      enabled: true,
      compactModel: '',
      reminderThresholds: [400_000, 500_000, 600_000],
      excludedModels: [],
      autoCompactThresholdRatio: 0.9,
    })
  })

  it('config.setSmartContextEnabled → 透传 payload + reply 读回 enabled 生效值', async () => {
    const { ctx, replies, configService } = mockCtx()
    const handled = await new SmartContextConfigMessageHandler(ctx).handle(
      msg('config.setSmartContextEnabled', { enabled: false }),
      TEST_WS,
    )

    expect(handled).toBe(true)
    expect(configService.setSmartContextEnabled).toHaveBeenCalledWith(false)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'config.smartContextEnabled', id: 'm1', payload: { enabled: false } })
  })

  it('config.setSmartContextCompactModel → 透传 payload + reply 读回 model 生效值', async () => {
    const { ctx, replies, configService } = mockCtx()
    const handled = await new SmartContextConfigMessageHandler(ctx).handle(
      msg('config.setSmartContextCompactModel', { model: 'p1/m1' }),
      TEST_WS,
    )

    expect(handled).toBe(true)
    expect(configService.setSmartContextCompactModel).toHaveBeenCalledWith('p1/m1')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'config.smartContextCompactModel', id: 'm1', payload: { model: 'p1/m1' } })
  })

  it('config.setSmartContextThresholds → 透传 payload + reply 读回 thresholds 生效值', async () => {
    const { ctx, replies, configService } = mockCtx()
    const handled = await new SmartContextConfigMessageHandler(ctx).handle(
      msg('config.setSmartContextThresholds', { thresholds: [300_000, 500_000, 600_000] }),
      TEST_WS,
    )

    expect(handled).toBe(true)
    expect(configService.setSmartContextThresholds).toHaveBeenCalledWith([300_000, 500_000, 600_000])
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      type: 'config.smartContextThresholds',
      id: 'm1',
      payload: { thresholds: [300_000, 500_000, 600_000] },
    })
  })

  it('config.setSmartContextExcludedModels → 透传 payload + reply 读回 models 生效值', async () => {
    const { ctx, replies, configService } = mockCtx()
    const handled = await new SmartContextConfigMessageHandler(ctx).handle(
      msg('config.setSmartContextExcludedModels', { models: ['p1/m1'] }),
      TEST_WS,
    )

    expect(handled).toBe(true)
    expect(configService.setSmartContextExcludedModels).toHaveBeenCalledWith(['p1/m1'])
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'config.smartContextExcludedModels', id: 'm1', payload: { models: ['p1/m1'] } })
  })

  it('config.setSmartContextAutoCompactThresholdRatio → 透传 payload + reply 读回 ratio 生效值（C3 新增 case）', async () => {
    const { ctx, replies, configService } = mockCtx()
    const handled = await new SmartContextConfigMessageHandler(ctx).handle(
      msg('config.setSmartContextAutoCompactThresholdRatio', { ratio: 0.85 }),
      TEST_WS,
    )

    expect(handled).toBe(true)
    expect(configService.setSmartContextAutoCompactThresholdRatio).toHaveBeenCalledWith(0.85)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      type: 'config.smartContextAutoCompactThresholdRatio',
      id: 'm1',
      payload: { ratio: 0.85 },
    })
  })

  it('set 后 get：getSmartContextConfig 回填 setter 写入的存储态（读回生效值语义）', async () => {
    const { ctx, replies } = mockCtx()
    const handler = new SmartContextConfigMessageHandler(ctx)
    await handler.handle(msg('config.setSmartContextAutoCompactThresholdRatio', { ratio: 0.95 }), TEST_WS)
    await handler.handle(msg('config.getSmartContextConfig', {}, 'm2'), TEST_WS)

    expect(replies).toHaveLength(2)
    expect((replies[1].payload as { autoCompactThresholdRatio: number }).autoCompactThresholdRatio).toBe(0.95)
  })

  it('不匹配的 type 返回 false（由 SettingsMessageHandler 继续路由）', async () => {
    const { ctx } = mockCtx()
    const handled = await new SmartContextConfigMessageHandler(ctx).handle(msg('config.setRetryConfig', {}), TEST_WS)
    expect(handled).toBe(false)
  })
})
