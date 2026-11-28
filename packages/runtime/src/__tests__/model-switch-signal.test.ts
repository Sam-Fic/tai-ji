/**
 * runtime 对模型切换信号的分诊（chat-flow-v2 msw-live）：host-internals 在 pi `model_select`
 * 之后发的隐藏 custom message → 广播 message.modelSwitch 帧。帧带切换前模型：pi 新建会话时
 * 落盘的初始记录不经事件送达，前端实时侧没有会话基线时要靠它补。
 */
import { describe, expect, it, vi } from 'vitest'
import { MODEL_SELECT_CUSTOM_TYPE } from '@zhushanwen/extension-protocol'
import type { ServerMessage } from '@taiji/shared'
import { EventInterpreter } from '../services/session/event-interpreter.js'
import type { PiTranslatedEvent } from '../services/session/types.js'

describe('runtime 广播 message.modelSwitch 帧携带切换前模型', () => {
  const customStart = (customType: string, details: Record<string, unknown>): PiTranslatedEvent =>
    ({ kind: 'message', message: { type: 'message.customStart', payload: { sessionId: 'sid-ms', customType, details } } as ServerMessage })

  function interpret(events: PiTranslatedEvent[]): ServerMessage[] {
    const sent: ServerMessage[] = []
    const interp = new EventInterpreter('sid-ms', {
      send: (m) => sent.push(m),
      onCompactingStateChange: vi.fn(),
      onContextUpdate: vi.fn(),
      onSessionRenamed: vi.fn(),
      onAgentSettled: vi.fn(),
      onOccupancyTransition: vi.fn(),
    })
    interp.interpret(events)
    return sent
  }

  it('信号带切换前模型：帧带 previousProvider / previousModelId', () => {
    const frames = interpret([
      customStart(MODEL_SELECT_CUSTOM_TYPE, {
        provider: 'faux',
        modelId: 'faux-1-reasoning',
        previousProvider: 'faux',
        previousModelId: 'faux-1',
        source: 'cycle',
      }),
    ]).filter((m) => m.type === 'message.modelSwitch')
    expect(frames).toHaveLength(1)
    expect(frames[0].payload).toMatchObject({
      sessionId: 'sid-ms',
      provider: 'faux',
      modelId: 'faux-1-reasoning',
      previousProvider: 'faux',
      previousModelId: 'faux-1',
    })
    expect(typeof (frames[0].payload as { timestamp: number }).timestamp).toBe('number')
  })

  it('信号不带切换前模型：帧不带 previous*', () => {
    const frames = interpret([customStart(MODEL_SELECT_CUSTOM_TYPE, { provider: 'faux', modelId: 'faux-1-b' })]).filter(
      (m) => m.type === 'message.modelSwitch',
    )
    expect(frames).toHaveLength(1)
    expect(frames[0].payload).not.toHaveProperty('previousModelId')
  })

  it('模型 id 为空、缺 details、或不是模型切换信号：不广播', () => {
    expect(interpret([customStart(MODEL_SELECT_CUSTOM_TYPE, { provider: 'faux', modelId: '' })])).not.toContainEqual(
      expect.objectContaining({ type: 'message.modelSwitch' }),
    )
    expect(interpret([{ kind: 'message', message: { type: 'message.customStart', payload: { sessionId: 'sid-ms', customType: MODEL_SELECT_CUSTOM_TYPE } } as ServerMessage }]))
      .not.toContainEqual(expect.objectContaining({ type: 'message.modelSwitch' }))
    expect(interpret([customStart('some.other.type', { provider: 'faux', modelId: 'faux-1-b' })])).not.toContainEqual(
      expect.objectContaining({ type: 'message.modelSwitch' }),
    )
  })
})
