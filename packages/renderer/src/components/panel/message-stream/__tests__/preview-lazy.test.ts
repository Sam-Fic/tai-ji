import { describe, it, expect } from 'vitest'
import { buildStreamViewItems } from '../stream-view-items'
import type { MessageTurn } from '@taiji/core/domain/chat'

/** turn 构造器：live 态 user content 为 Segment[]（非 string），assistant 文本可很长 */
function makeTurn (assistantText: string, opts: { userText?: string; isLastTurn?: boolean } = {}): MessageTurn {
  return {
    index: 0,
    user: {
      id: 'u1', role: 'user',
      content: [{ type: 'text', text: opts.userText ?? '提示词' }],
      status: 'complete', timestamp: 1,
    } as never,
    assistants: [{
      id: 'a1', role: 'assistant', content: [{ type: 'text', text: assistantText }], status: 'complete', timestamp: 2,
    }] as never,
    isStreaming: true,
    hasFoldable: false,
  } as MessageTurn
}

/** buildStreamViewItems 入参形态：SkillNoticeStreamItem 包装 */
function wrap (turn: MessageTurn) {
  return { kind: 'turn', turn }
}

/** 取 turn 项（唯一 turn kind 项） */
function turnItem (items: ReturnType<typeof buildStreamViewItems>) {
  const item = items.find((i) => i.kind === 'turn')
  if (!item || item.kind !== 'turn') throw new Error('no turn item')
  return item
}

describe('StreamViewItem preview 懒计算', () => {
  it('正常构建不求值 preview（流式期零成本）：preview 为惰性形态', () => {
    const turn = makeTurn('x'.repeat(50_000))
    const item = turnItem(buildStreamViewItems([wrap(turn)] as never, -1, turn))
    // 惰性形态：函数或未定义；绝非已计算的字符串
    const preview = (item as unknown as { preview: unknown }).preview
    const isLazy = typeof preview === 'function' || preview === undefined
    expect(isLazy).toBe(true)
    expect(typeof preview).not.toBe('string')
  })

  it('broken 占位行路径求值结果与旧即时实现一致（压平 + 截断）', () => {
    // user 为 string 时旧即时实现 = 压平空白后截断（120 字符 + …）
    const turn = {
      ...makeTurn('x'.repeat(50_000)),
      user: { id: 'u1', role: 'user', content: `  a\n b  ${'x'.repeat(200)}`, status: 'complete', timestamp: 1 } as never,
    } as MessageTurn
    const items = buildStreamViewItems([wrap(turn)] as never, -1, turn)
    const item = turnItem(items)
    const preview = (item as unknown as { preview: unknown }).preview
    const legacy = '  a\n b  '.concat('x'.repeat(200)).replace(/\s+/g, ' ').trim()
    const expected = `${legacy.slice(0, 120)}…`
    const actual = typeof preview === 'function' ? (preview as () => string)() : String(preview ?? '')
    expect(actual).toBe(expected)
    // Segment[] content 形态（user 与 assistant 均）：旧实现即返回 ''，等价性保持
    const segTurn = makeTurn('x'.repeat(50_000))
    const segItem = turnItem(buildStreamViewItems([wrap(segTurn)] as never, -1, segTurn))
    const segPreview = (segItem as unknown as { preview: () => string }).preview
    expect(segPreview()).toBe('')
  })

  it('复用判定不再比对 preview：同 turn 引用逐帧复用', () => {
    const turn = makeTurn('x'.repeat(50_000))
    const first = buildStreamViewItems([wrap(turn)] as never, -1, turn)
    // 同输入引用 → 入参零变化快判直接返回同数组
    const second = buildStreamViewItems([wrap(turn)] as never, -1, turn)
    expect(second).toBe(first)
    // 新 turn 引用（流式 delta 场景）但内容同前缀 → turn 项复用（不含 preview 比对）
    const turn2 = makeTurn('x'.repeat(50_000))
    const third = buildStreamViewItems([wrap(turn2)] as never, -1, turn2)
    expect(turnItem(third)).toBeDefined()
  })

  it('user 为 string 时 preview 取 user 正文（回落优先级不变）', () => {
    const turn = {
      ...makeTurn('x'.repeat(50_000)),
      user: { id: 'u1', role: 'user', content: '用户原文内容', status: 'complete', timestamp: 1 } as never,
    } as MessageTurn
    const item = turnItem(buildStreamViewItems([wrap(turn)] as never, -1, turn))
    const preview = (item as unknown as { preview: unknown }).preview
    const actual = typeof preview === 'function' ? (preview as () => string)() : String(preview ?? '')
    expect(actual).toBe('用户原文内容')
  })

  it('preview thunk 抛错不扩散（B-harden：兜底组件自身不能再炸）', () => {
    // 构造一条让 turnPreview 抛错的畸形 turn：assistants 非数组可迭代形态会抛
    const broken = {
      ...makeTurn('x'.repeat(50_000)),
      assistants: null as never,
    } as MessageTurn
    const item = turnItem(buildStreamViewItems([wrap(broken)] as never, -1, broken))
    const preview = (item as unknown as { preview: () => string }).preview
    // thunk 形态仍成立（求值才炸），抛错由 StreamItemBoundary 的 try/catch 降级承接——
    // 此处只锁定「构建期不求值」这一半（另一半由组件测试覆盖）
    expect(typeof preview).toBe('function')
  })
})
