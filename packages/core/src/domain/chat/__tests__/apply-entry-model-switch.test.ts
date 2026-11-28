/**
 * model_change entry → 模型切换行（chat-flow-v2 msw-replay）。
 *
 * 口径：首个记录只写基线（没有「从什么切到什么」）；与上一生效值相同的重复写入不出行
 *（pi 同模型 setModel 也会落 entry）；真实变化 → 一条 system 行，带前后模型。
 * 该派生是回放（真实 entry）与实时（扩展转发 model_select → runtime 帧 → 合成 entry）两路的
 * 唯一实现——两路喂同一 reducer，字段由同一构造产出。
 */
import { describe, expect, it } from 'vitest'
import type { PiEntry } from '@taiji/shared'
import { applyEntry, createInitialChatViewState, replayEntries, type ChatViewState } from '../apply-entry'

const stamp = (second: number) => new Date(Date.UTC(2026, 10, 24, 0, 0, second)).toISOString()

function modelChange(id: string, provider: string, modelId: string, second: number): PiEntry {
  return { type: 'model_change', id, timestamp: stamp(second), provider, modelId }
}

function userMessage(id: string, second: number): PiEntry {
  return {
    type: 'message',
    id,
    timestamp: stamp(second),
    message: { role: 'user', content: `hi-${second}`, timestamp: second * 1000 },
  }
}

function run(entries: PiEntry[]): ChatViewState {
  let state = createInitialChatViewState()
  for (const entry of entries) state = applyEntry(state, entry)
  return state
}

describe('applyEntry model_change：模型切换行派生', () => {
  it('会话首个 model_change 只记基线，不出行', () => {
    const state = run([modelChange('m1', 'faux', 'faux-1', 1)])
    expect(state.messages).toEqual([])
    expect(state.lastModel).toEqual({ provider: 'faux', modelId: 'faux-1' })
  })

  it('同模型重复写入不出行', () => {
    const state = run([modelChange('m1', 'faux', 'faux-1', 1), modelChange('m2', 'faux', 'faux-1', 2)])
    expect(state.messages).toEqual([])
    expect(state.lastModel).toEqual({ provider: 'faux', modelId: 'faux-1' })
  })

  it('模型真实变化 → 一条 system 行，带前后模型与兜底文本', () => {
    const state = run([modelChange('m1', 'faux', 'faux-1', 1), userMessage('u1', 2), modelChange('m2', 'faux', 'faux-1-reasoning', 3)])
    expect(state.messages).toHaveLength(2)
    const notice = state.messages[1]
    expect(notice.role).toBe('system')
    expect(notice.status).toBe('complete')
    expect(notice.content).toBe('faux-1 → faux-1-reasoning')
    expect(notice.timestamp).toBe(Date.UTC(2026, 10, 24, 0, 0, 3))
    expect(notice.modelSwitch).toEqual({
      provider: 'faux',
      modelId: 'faux-1-reasoning',
      previousProvider: 'faux',
      previousModelId: 'faux-1',
    })
  })

  it('provider 变化（modelId 相同）也算切换', () => {
    const state = run([modelChange('m1', 'provider-a', 'm', 1), modelChange('m2', 'provider-b', 'm', 2)])
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].modelSwitch).toEqual({ provider: 'provider-b', modelId: 'm', previousProvider: 'provider-a', previousModelId: 'm' })
  })

  it('连续切换各自出行；回到前一个模型也出行', () => {
    const state = run([
      modelChange('m1', 'faux', 'faux-1', 1),
      modelChange('m2', 'faux', 'faux-1-b', 2),
      modelChange('m3', 'faux', 'faux-1-c', 3),
      modelChange('m4', 'faux', 'faux-1-b', 4),
    ])
    expect(state.messages).toHaveLength(3)
    expect(state.messages.map((m) => [m.modelSwitch?.previousModelId, m.modelSwitch?.modelId])).toEqual([
      ['faux-1', 'faux-1-b'],
      ['faux-1-b', 'faux-1-c'],
      ['faux-1-c', 'faux-1-b'],
    ])
    expect(state.lastModel).toEqual({ provider: 'faux', modelId: 'faux-1-b' })
  })

  it('缺 provider / modelId 的畸形记录：不写基线也不出行', () => {
    const state = run([{ type: 'model_change', id: 'm1', timestamp: stamp(1) }])
    expect(state.messages).toEqual([])
    expect(state.lastModel).toBeUndefined()
  })

  it('replayEntries 与逐条 applyEntry 派生同形', () => {
    const entries = [modelChange('m1', 'faux', 'faux-1', 1), userMessage('u1', 2), modelChange('m2', 'faux', 'faux-1-b', 3)]
    const folded = replayEntries(entries)
    expect(folded.messages).toEqual(run(entries).messages)
    expect(folded.lastModel).toEqual({ provider: 'faux', modelId: 'faux-1-b' })
  })
})
