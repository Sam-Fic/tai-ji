/**
 * 模型切换行的回合归属分组（chat-flow-v2 G9，规则 4c）：
 * 回合进行中切换 → 归当前 turn 的 notices（不切断 turn，后续 assistant 仍归同一 turn）；
 * 回合之间切换 → 独立 systemNotice static 项 + 关闭当前 turn。
 * 归属判定向后看下一条非透明消息（isMidTurnSwitch），数组末尾窗口按回合活动信号
 * （isTurnGroupActive）——流式中 / 工具执行中 / user 锚待首回复读作进行中。
 *
 * 运行：pnpm --filter @taiji/core exec vitest run src/domain/chat/__tests__/message-turns-model-switch.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { Message } from '@taiji/shared'
import { toRenderItems, toRenderItemsIncremental, createTurnRenderCache, type RenderItem } from '../message-turns'

let seq = 0
function makeMsg(over: Partial<Message> = {}): Message {
  seq += 1
  return { id: `m${seq}`, role: 'assistant', content: '', status: 'complete', timestamp: 0, ...over }
}

const userMsg = (id: string, content = 'q'): Message => makeMsg({ id, role: 'user', content })

const assistantMsg = (id: string, over: Partial<Message> = {}): Message =>
  makeMsg({ id, role: 'assistant', content: `r-${id}`, ...over })

const switchMsg = (id: string, over: Partial<Message> = {}): Message =>
  makeMsg({
    id,
    role: 'system',
    content: 'faux-1 → faux-1-reasoning',
    modelSwitch: { provider: 'faux', modelId: 'faux-1-reasoning', previousProvider: 'faux', previousModelId: 'faux-1' },
    ...over,
  })

/** 隐藏完成通知（subagent-bg-notify，display:false——规则 2 边界触发器形态） */
const bgNotify = (id: string): Message => makeMsg({ id, role: 'system', customType: 'subagent-bg-notify', display: false, content: '' })

/** running 工具调用的 assistant（回合推进中的工具执行形态） */
const assistantWithRunningTool = (id: string): Message =>
  makeMsg({
    id,
    role: 'assistant',
    content: '',
    toolCalls: [{ id: `${id}-t1`, toolName: 'bash', input: {}, status: 'running', startTime: 1 }],
  })

function turnOf(item: RenderItem): Extract<RenderItem, { kind: 'turn' }>['turn'] {
  if (item.kind !== 'turn') throw new Error(`expected turn item, got ${item.kind}`)
  return item.turn
}

function staticNoticeIds(items: RenderItem[]): string[] {
  return items.filter((i) => i.kind === 'systemNotice').map((i) => (i as Extract<RenderItem, { kind: 'systemNotice' }>).message.id)
}

describe('规则 4c：回合进行中切换归当前 turn（不切断回合）', () => {
  it('向后看下一条是 assistant：切换行入 notices，锚 = 已有 assistant 数，后续 assistant 归同一 turn', () => {
    const items = toRenderItems([userMsg('u1'), assistantMsg('a1'), switchMsg('sw1'), assistantMsg('a2')])
    expect(items).toHaveLength(1)
    const turn = turnOf(items[0])
    expect(turn.assistants.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(turn.notices?.map((m) => m.id)).toEqual(['sw1'])
    expect(turn.switchAfter).toEqual({ sw1: 1 })
    expect(staticNoticeIds(items)).toEqual([])
  })

  it('连续两条切换行相互跳过：都归回合内部，锚同为到达时的 assistant 数', () => {
    const items = toRenderItems([
      userMsg('u1'),
      assistantMsg('a1'),
      switchMsg('sw1', { modelSwitch: { modelId: 'faux-1-b', previousModelId: 'faux-1' } }),
      switchMsg('sw2'),
      assistantMsg('a2'),
    ])
    const turn = turnOf(items[0])
    expect(turn.assistants.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(turn.notices?.map((m) => m.id)).toEqual(['sw1', 'sw2'])
    expect(turn.switchAfter).toEqual({ sw1: 1, sw2: 1 })
    expect(staticNoticeIds(items)).toEqual([])
  })

  it('数组末尾窗口、末位 assistant 流式中：归回合内部（等回合延续）', () => {
    const items = toRenderItems([userMsg('u1'), assistantMsg('a1', { status: 'streaming' }), switchMsg('sw1')])
    const turn = turnOf(items[0])
    expect(turn.notices?.map((m) => m.id)).toEqual(['sw1'])
    expect(turn.switchAfter).toEqual({ sw1: 1 })
    expect(staticNoticeIds(items)).toEqual([])
  })

  it('数组末尾窗口、末位 assistant 带 running 工具调用：归回合内部（工具执行中切）', () => {
    const items = toRenderItems([userMsg('u1'), assistantWithRunningTool('a1'), switchMsg('sw1')])
    const turn = turnOf(items[0])
    expect(turn.notices?.map((m) => m.id)).toEqual(['sw1'])
    expect(turn.switchAfter).toEqual({ sw1: 1 })
    expect(staticNoticeIds(items)).toEqual([])
  })

  it('数组末尾窗口、user 锚待首回复：归回合内部（等待延续），锚 = 0', () => {
    const items = toRenderItems([userMsg('u1'), switchMsg('sw1')])
    const turn = turnOf(items[0])
    expect(turn.user?.id).toBe('u1')
    expect(turn.notices?.map((m) => m.id)).toEqual(['sw1'])
    expect(turn.switchAfter).toEqual({ sw1: 0 })
    expect(staticNoticeIds(items)).toEqual([])
  })
})

describe('规则 4c：回合之间切换独立静态分隔行', () => {
  it('向后看下一条是 user：切换行落独立 static 项，两回合各自完整（无锚）', () => {
    const items = toRenderItems([userMsg('u1'), assistantMsg('a1'), switchMsg('sw1'), userMsg('u2'), assistantMsg('a2')])
    expect(items).toHaveLength(3)
    expect(staticNoticeIds(items)).toEqual(['sw1'])
    const t1 = turnOf(items[0])
    expect(t1.notices).toBeUndefined()
    expect(t1.switchAfter).toBeUndefined()
    expect(turnOf(items[2]).user?.id).toBe('u2')
  })

  it('数组末尾窗口、回合已落成（complete 无 running 工具）：独立 static 项（无锚）', () => {
    const items = toRenderItems([userMsg('u1'), assistantMsg('a1'), switchMsg('sw1')])
    expect(staticNoticeIds(items)).toEqual(['sw1'])
    const t1 = turnOf(items[0])
    expect(t1.notices).toBeUndefined()
    expect(t1.switchAfter).toBeUndefined()
  })

  it('切换行后是隐藏完成通知边界：独立 static 项，续跑 assistant 归 trigger turn', () => {
    const items = toRenderItems([userMsg('u1'), assistantMsg('a1'), switchMsg('sw1'), bgNotify('n1'), assistantMsg('a2')])
    expect(staticNoticeIds(items)).toEqual(['sw1'])
    const trigger = turnOf(items[2])
    expect(trigger.trigger).toBe('bg-notify')
    expect(trigger.assistants.map((m) => m.id)).toEqual(['a2'])
  })

  it('无当前 turn（切换行是首条消息）：独立 static 项，不抛', () => {
    const items = toRenderItems([switchMsg('sw1'), userMsg('u1'), assistantMsg('a1')])
    expect(staticNoticeIds(items)).toEqual(['sw1'])
    expect(turnOf(items[1]).assistants.map((m) => m.id)).toEqual(['a1'])
  })
})

describe('规则 4c：增量与全量分组等价', () => {
  it('切换行先到（回合延续未到）→ assistant 补达：增量输出与全量重跑 deepEqual', () => {
    const before: Message[] = [userMsg('u1'), assistantMsg('a1', { status: 'streaming' }), switchMsg('sw1')]
    const after: Message[] = [...before, assistantMsg('a2')]
    const cache = createTurnRenderCache()
    toRenderItemsIncremental(before, false, cache)
    const incremental = toRenderItemsIncremental(after, false, cache)
    expect(incremental).toEqual(toRenderItems(after))
    const turn = turnOf(incremental[0])
    expect(turn.assistants.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(turn.notices?.map((m) => m.id)).toEqual(['sw1'])
  })

  it('回合之间切换后新回合开启：增量输出与全量重跑 deepEqual', () => {
    const before: Message[] = [userMsg('u1'), assistantMsg('a1'), switchMsg('sw1')]
    const after: Message[] = [...before, userMsg('u2'), assistantMsg('a2')]
    const cache = createTurnRenderCache()
    toRenderItemsIncremental(before, false, cache)
    const incremental = toRenderItemsIncremental(after, false, cache)
    expect(incremental).toEqual(toRenderItems(after))
    expect(staticNoticeIds(incremental)).toEqual(['sw1'])
  })
})
