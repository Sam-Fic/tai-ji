/**
 * message.modelSwitch 帧（chat-flow-v2 msw-live）：实时侧合成 model_change entry，喂与回放
 * 同一个 reducer。
 *
 * 切换行的派生依赖前置 state（上一生效模型），所以这条帧不走「空 state 派生」的 overlay
 * 骨架——权威 state 与渲染列表必须用同一基线、同一 reducer。这里用真实 reducer 缓冲
 * （镜像 store.applyEntryFrame / getLastModel 的实现）驱动真实 handler，断言两层一致。
 *
 * 基线来源两条：权威 state 已有基线时沿用；没有时（pi 新建会话落盘的初始记录不经事件
 * 送达）用帧携带的切换前模型补一条，等价于那条初始记录。
 */
import { describe, expect, it } from 'vitest'
import { shallowRef, type ShallowRef } from 'vue'
import type { Message, PiEntry, ServerMessage } from '@taiji/shared'
import {
  applyEntry,
  createChatViewStateBuffer,
  createInitialChatViewState,
  replayEntries,
  type ChatViewState,
  type ChatViewStateBuffer,
} from '../apply-entry'
import type { MessagesRef } from '../mutations'
import type { MessageEffectContext } from '../effect-types'
import { dispatchMessageEvent } from '../effects/registry'

const SID = 's1'
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0)
const T1 = T0 + 60_000

const stamp = (ms: number) => new Date(ms).toISOString()

function modelChange(id: string, provider: string, modelId: string, ms: number): PiEntry {
  return { type: 'model_change', id, timestamp: stamp(ms), provider, modelId }
}

function switchFrame(payload: Record<string, unknown>): ServerMessage {
  return { type: 'message.modelSwitch', payload: { sessionId: SID, ...payload } } as ServerMessage
}

/** 会话初始记录（pi 新建会话时落盘，不经事件送达前端）。 */
function sessionStart(ms = T0): ChatViewState {
  return replayEntries([modelChange('mc-init', 'faux', 'faux-1', ms)])
}

/** 测试 ctx：权威 state 用真实 reducer 缓冲，渲染列表用真实 messages ref 形态。 */
function createHarness(initial?: ChatViewState) {
  const messages: MessagesRef = shallowRef(new Map<string, ShallowRef<Message[]>>())
  const states = new Map<string, ChatViewStateBuffer>()
  states.set(SID, createChatViewStateBuffer(initial))
  const ctx = {
    messages,
    applyEntryFrame: (sid: string, entry: PiEntry): void => {
      let buf = states.get(sid)
      if (buf === undefined) {
        buf = createChatViewStateBuffer()
        states.set(sid, buf)
      }
      buf.feed(entry)
    },
    getLastModel: (sid: string) => states.get(sid)?.state.lastModel,
  } as unknown as MessageEffectContext
  return { ctx, messages, authoritative: states.get(SID) as ChatViewStateBuffer }
}

const rendered = (messages: MessagesRef): Message[] => messages.value.get(SID)?.value ?? []

const switchRows = (list: Message[]) => list.filter((m) => m.modelSwitch !== undefined)

/** 切换行的可观察字段（id 是客户端生成的 uuid，实时与回放异源，比较时剔除）。 */
const rowShape = (m: Message) => ({
  role: m.role,
  status: m.status,
  timestamp: m.timestamp,
  content: m.content,
  modelSwitch: m.modelSwitch,
})

describe('message.modelSwitch：实时切换行进渲染列表', () => {
  it('会话已有基线、切到不同模型：渲染列表与权威 state 各出一条「旧 → 新」', () => {
    const { ctx, messages, authoritative } = createHarness(sessionStart())
    dispatchMessageEvent(
      ctx,
      SID,
      switchFrame({
        provider: 'faux',
        modelId: 'faux-1-reasoning',
        previousProvider: 'faux',
        previousModelId: 'faux-1',
        timestamp: T1,
      }),
    )
    const rows = switchRows(rendered(messages))
    expect(rows).toHaveLength(1)
    expect(rowShape(rows[0])).toEqual({
      role: 'system',
      status: 'complete',
      timestamp: T1,
      content: 'faux-1 → faux-1-reasoning',
      modelSwitch: {
        provider: 'faux',
        modelId: 'faux-1-reasoning',
        previousProvider: 'faux',
        previousModelId: 'faux-1',
      },
    })
    expect(switchRows(authoritative.state.messages)).toHaveLength(1)
    expect(rowShape(switchRows(authoritative.state.messages)[0])).toEqual(rowShape(rows[0]))
  })

  it('新会话没有基线、帧带切换前模型：先补基线再出行', () => {
    const { ctx, messages, authoritative } = createHarness()
    dispatchMessageEvent(
      ctx,
      SID,
      switchFrame({
        provider: 'faux',
        modelId: 'faux-1-reasoning',
        previousProvider: 'faux',
        previousModelId: 'faux-1',
        timestamp: T1,
      }),
    )
    const rows = switchRows(rendered(messages))
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('faux-1 → faux-1-reasoning')
    expect(authoritative.state.lastModel).toEqual({ provider: 'faux', modelId: 'faux-1-reasoning' })
    expect(switchRows(authoritative.state.messages)).toHaveLength(1)
  })

  it('新会话没有基线、帧也不带切换前模型：只记基线，不出行', () => {
    const { ctx, messages, authoritative } = createHarness()
    dispatchMessageEvent(ctx, SID, switchFrame({ provider: 'faux', modelId: 'faux-1-reasoning', timestamp: T1 }))
    expect(rendered(messages)).toEqual([])
    expect(authoritative.state.messages).toEqual([])
    expect(authoritative.state.lastModel).toEqual({ provider: 'faux', modelId: 'faux-1-reasoning' })
  })

  it('切到同一模型：不出行，渲染列表不变', () => {
    const { ctx, messages } = createHarness(sessionStart())
    dispatchMessageEvent(
      ctx,
      SID,
      switchFrame({ provider: 'faux', modelId: 'faux-1', previousProvider: 'faux', previousModelId: 'faux-1', timestamp: T1 }),
    )
    expect(rendered(messages)).toEqual([])
  })

  it('同一帧重复到达：不重复出行', () => {
    const { ctx, messages } = createHarness(sessionStart())
    const frame = switchFrame({
      provider: 'faux',
      modelId: 'faux-1-reasoning',
      previousProvider: 'faux',
      previousModelId: 'faux-1',
      timestamp: T1,
    })
    dispatchMessageEvent(ctx, SID, frame)
    dispatchMessageEvent(ctx, SID, frame)
    expect(switchRows(rendered(messages))).toHaveLength(1)
  })

  it('权威 state 已有基线时以它为准，帧携带的切换前模型不参与派生', () => {
    const { ctx, messages } = createHarness(sessionStart())
    dispatchMessageEvent(
      ctx,
      SID,
      switchFrame({ provider: 'faux', modelId: 'faux-1-c', previousProvider: 'faux', previousModelId: 'faux-1-b', timestamp: T1 }),
    )
    const rows = switchRows(rendered(messages))
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('faux-1 → faux-1-c')
  })

  it('实时与回放同形：补基线 + 切换 与 初始记录 + 切换记录 派生出同一行', () => {
    const { ctx, messages } = createHarness()
    dispatchMessageEvent(
      ctx,
      SID,
      switchFrame({
        provider: 'faux',
        modelId: 'faux-1-reasoning',
        previousProvider: 'faux',
        previousModelId: 'faux-1',
        timestamp: T1,
      }),
    )
    const live = switchRows(rendered(messages))[0]
    const reloaded = replayEntries([modelChange('mc-init', 'faux', 'faux-1', T0), modelChange('mc-switch', 'faux', 'faux-1-reasoning', T1)])
    const rows = switchRows(reloaded.messages)
    expect(rows).toHaveLength(1)
    expect(rowShape(rows[0])).toEqual(rowShape(live))
  })

  it('连续两次切换：两条行各带自己的前后模型', () => {
    const { ctx, messages } = createHarness()
    dispatchMessageEvent(
      ctx,
      SID,
      switchFrame({ provider: 'faux', modelId: 'faux-1-reasoning', previousProvider: 'faux', previousModelId: 'faux-1', timestamp: T1 }),
    )
    dispatchMessageEvent(
      ctx,
      SID,
      switchFrame({ provider: 'faux', modelId: 'faux-1-b', previousProvider: 'faux', previousModelId: 'faux-1-reasoning', timestamp: T1 + 1000 }),
    )
    expect(switchRows(rendered(messages)).map((m) => m.content)).toEqual(['faux-1 → faux-1-reasoning', 'faux-1-reasoning → faux-1-b'])
  })
})

describe('message.modelSwitch：空 state 派生不出行（切换行依赖前置 state）', () => {
  it('同一条合成 entry 在没有基线的 state 上只记基线——handler 不能走空 state 派生的 overlay 骨架', () => {
    const state = applyEntry(createInitialChatViewState(), modelChange('ms-x', 'faux', 'faux-1-reasoning', T1))
    expect(state.messages).toEqual([])
    expect(state.lastModel).toEqual({ provider: 'faux', modelId: 'faux-1-reasoning' })
  })
})

describe('message.modelSwitch：流式中切插到流式 assistant 之前（G1-4，live 序对齐文件序）', () => {
  it('末位 assistant streaming：切换行插在它之前而非数组末尾', () => {
    const { ctx, messages } = createHarness(sessionStart())
    // 流式中的 assistant 已在渲染列表（帧序：assistant 在前）
    const streaming: Message = {
      id: 'a-live', role: 'assistant', content: '', status: 'streaming', timestamp: T1,
    }
    messages.value.set(SID, shallowRef([streaming]))
    dispatchMessageEvent(ctx, SID, switchFrame({ provider: 'faux', modelId: 'faux-1-reasoning', timestamp: T1 + 1000 }))
    const list = rendered(messages)
    expect(list.map((m) => m.role)).toEqual(['system', 'assistant'])
    expect(list[0]?.modelSwitch?.modelId).toBe('faux-1-reasoning')
  })

  it('末位 assistant 已完成（工具执行中/idle）：维持数组末尾 append', () => {
    const { ctx, messages } = createHarness(sessionStart())
    const done: Message = { id: 'a-done', role: 'assistant', content: '', status: 'complete', timestamp: T1 }
    messages.value.set(SID, shallowRef([done]))
    dispatchMessageEvent(ctx, SID, switchFrame({ provider: 'faux', modelId: 'faux-1-b', timestamp: T1 + 1000 }))
    const list = rendered(messages)
    expect(list.map((m) => m.role)).toEqual(['assistant', 'system'])
    expect(list[0]?.id).toBe('a-done')
    expect(list[1]?.modelSwitch?.modelId).toBe('faux-1-b')
  })
})
