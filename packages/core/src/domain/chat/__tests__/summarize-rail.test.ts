import { describe, it, expect } from 'vitest'
import { truncate, stripMarkdown, summarizeTurnForRail, summarizeAssistantForRail, summarizeAssistantForRailWithSource, streamingRailAnchor, isRailSummarySettled, RAIL_FREEZE_PREFIX } from '../summarize-turn'
import type { MessageTurn } from '../message-turns'

/** 构造最小 MessageTurn（rail 摘要单测够用） */
function makeTurn (userContent: unknown, assistantTexts: string[], isStreaming = false): MessageTurn {
  return {
    index: 0,
    user: userContent === undefined ? null : {
      id: 'u1', role: 'user', content: userContent, status: 'complete', timestamp: 1,
    } as never,
    assistants: assistantTexts.map((text, i) => ({
      id: `a${i}`, role: 'assistant', content: [{ type: 'text', text }], status: 'complete', timestamp: 2 + i,
    })) as never,
    isStreaming,
    hasFoldable: false,
  } as MessageTurn
}

describe('truncate 边界', () => {
  it('maxChars=0 与 1 均返回省略号（对齐旧实现）', () => {
    expect(truncate('abc', 0)).toBe('…')
    expect(truncate('abc', 1)).toBe('…')
  })

  it('不超过 maxChars 时原文返回（UTF-16 长度即码点数上界）', () => {
    expect(truncate('abc', 3)).toBe('abc')
    expect(truncate('a你', 2)).toBe('a你')
  })

  it('超长按码点截断（代理对不被切断）', () => {
    // 😀 = U+1F600（代理对 2 个 UTF-16 单元，1 个码点）
    expect(truncate('😀😀😀', 2)).toBe('😀…')
    expect(truncate('😀😀😀', 3)).toBe('😀😀😀') // 3 码点 ≤ 3 ⇒ 原样（旧实现同）
    // 旧实现 Array.from 同样语义——逐字对拍锚点
    const legacy = (t: string, n: number) => {
      const chars = Array.from(t)
      return chars.length <= n ? t : chars.slice(0, Math.max(0, n - 1)).join('') + '…'
    }
    for (const s of ['abc', '你好世界', '😀a😀b', 'x'.repeat(100), '中文english混合123']) {
      for (const n of [0, 1, 2, 5, 20]) {
        expect(truncate(s, n)).toBe(legacy(s, n))
      }
    }
  })

  it('长输入不全量分配码点数组（early-exit：迭代次数有界，与输入长度无关）', () => {
    // 1MB 输入 + 计数迭代器：early-exit 的确定性证明（不依赖墙钟——加载抖动会误报）
    const huge = 'x'.repeat(1_000_000)
    let iterations = 0
    const counting = {
      length: huge.length,
      [Symbol.iterator] () {
        let i = 0
        return {
          next (): IteratorResult<string> {
            if (i >= huge.length) return { value: undefined, done: true }
            iterations++
            return { value: huge[i++], done: false }
          },
        }
      },
    }
    expect(truncate(counting as unknown as string, 20)).toBe('x'.repeat(19) + '…')
    // maxChars=20 ⇒ 迭代 21 次即判定超长（第 21 次后 break）；与 1MB 长度无关
    expect(iterations).toBe(21)
    // 真实大字符串同样即时返回且结果正确
    expect(truncate(huge, 20)).toBe('x'.repeat(19) + '…')
  })
})

describe('stripMarkdown fence 行无条件剥离', () => {
  it('闭合代码块：fence 行删除、代码内容保留（与旧实现终态一致）', () => {
    const md = '前言\n```ts\nconst a = 1\nconst b = 2\n```\n后记'
    const out = stripMarkdown(md)
    expect(out).toContain('const a = 1')
    expect(out).not.toContain('```')
  })

  it('未闭合代码块：fence 行同样被剥离（流式期不再泄漏标记到 rail）', () => {
    const md = '```ts\nexport function foo() {'
    const out = stripMarkdown(md)
    expect(out).not.toContain('```')
    expect(out).toContain('export function foo()')
  })

  it('代码块开头消息的 rail 终态/流式态一致（D1 反例 1 锁定）', () => {
    const streaming = makeTurn(undefined, ['```ts\nexport function foo() {'])
    const closed = makeTurn(undefined, ['```ts\nexport function foo() { }\n```\n收尾'])
    const railStreaming = summarizeAssistantForRail(streaming)
    const railClosed = summarizeAssistantForRail(closed)
    expect(railStreaming).not.toContain('```')
    expect(railClosed).not.toContain('```')
    // 前 20 码点内容一致（闭合不改变代码内容前缀）
    expect(railClosed.startsWith(railStreaming.replace('…', ''))).toBe(true)
  })

  it('其余规则不变：标题/列表/强调/链接照旧剥离', () => {
    expect(stripMarkdown('# 标题')).toBe('标题')
    expect(stripMarkdown('- 列表项')).toBe('列表项')
    expect(stripMarkdown('**粗体** 普通')).toBe('粗体 普通')
    expect(stripMarkdown('[链接](https://x.com)')).toBe('链接')
    expect(stripMarkdown('`行内码`')).toBe('行内码')
  })
})

describe('rail 摘要纯函数契约', () => {
  it('summarizeTurnForRail 取 user 正文前 20 码点', () => {
    const turn = makeTurn([{ type: 'text', text: '这是一段很长的用户输入用来测试截断行为yes' }], [])
    expect(summarizeTurnForRail(turn)).toBe('这是一段很长的用户输入用来测试截断行为…')
  })

  it('summarizeTurnForRail 无 user 时返回空串', () => {
    expect(summarizeTurnForRail(makeTurn(undefined, []))).toBe('')
  })

  it('summarizeAssistantForRail 无 user 时回落首条 assistant', () => {
    const turn = makeTurn(undefined, ['第一条回复内容'])
    expect(summarizeAssistantForRail(turn)).toBe('第一条回复内容')
  })
})

describe('summarizeAssistantForRailWithSource 来源对齐（B-harden 冻结判据）', () => {
  it('有文本时 sourceId = 产出摘要的 assistant message id', () => {
    const turn = makeTurn(undefined, ['第一条回复内容', '第二条回复内容'])
    const r = summarizeAssistantForRailWithSource(turn)
    expect(r.text).toBe('第一条回复内容')
    expect(r.sourceId).toBe('a0')
  })

  it('纯空白首块被跳过：sourceId 指向首个非空白块（与锚点块级规则对齐）', () => {
    const turn = makeTurn(undefined, ['   \n\t  ', '真实正文'])
    const r = summarizeAssistantForRailWithSource(turn)
    expect(r.text).toBe('真实正文')
    expect(r.sourceId).toBe('a1') // 不是空白块的 a0
  })

  it('无任何文本时回落计数且 sourceId = null（永不可被冻结复用）', () => {
    const turn = makeTurn(undefined, ['   ', '\n\n'])
    const r = summarizeAssistantForRailWithSource(turn)
    expect(r.text).toBe('') // 无 thinking/toolCalls ⇒ 空串
    expect(r.sourceId).toBeNull()
  })

  it('带 thinking 时回落计数且 sourceId = null', () => {
    const turn = {
      ...makeTurn(undefined, []),
      assistants: [{
        id: 'a0', role: 'assistant', content: [], status: 'complete', timestamp: 2,
        thinking: [{ id: 'th1', text: '思考' }],
      }] as never,
    } as MessageTurn
    const r = summarizeAssistantForRailWithSource(turn)
    expect(r.text).toBe('1 thoughts')
    expect(r.sourceId).toBeNull()
  })
})

describe('streamingRailAnchor 流式冻结锚点（B1：块级规则，不物化全文）', () => {
  /** anchor 专用构造：content 形态自由（string / segment 数组） */
  function anchorTurn (assistants: unknown[]): MessageTurn {
    return { index: 0, user: null, assistants, isStreaming: true, hasFoldable: false } as MessageTurn
  }

  it('string content：返回首条 assistant 的 (id, length, prefix=slice(0, RAIL_FREEZE_PREFIX))', () => {
    const turn = anchorTurn([
      { id: 'a0', role: 'assistant', content: 'x'.repeat(300), status: 'streaming', timestamp: 2 },
    ])
    expect(streamingRailAnchor(turn)).toEqual({ id: 'a0', length: 300, prefix: 'x'.repeat(RAIL_FREEZE_PREFIX) })
  })

  it('segment content：取首个非空 text 块（后续块不参与）', () => {
    const turn = anchorTurn([
      { id: 'a0', role: 'assistant', content: [
        { type: 'text', text: 'y'.repeat(100) },
        { type: 'text', text: 'z'.repeat(100) },
      ], status: 'streaming', timestamp: 2 },
    ])
    expect(streamingRailAnchor(turn)).toEqual({ id: 'a0', length: 100, prefix: 'y'.repeat(RAIL_FREEZE_PREFIX) })
  })

  it('无文本 message 被 continue 跳过，命中后续有文本 message', () => {
    const turn = anchorTurn([
      { id: 'a0', role: 'assistant', content: [], status: 'streaming', timestamp: 2 },
      { id: 'a1', role: 'assistant', content: '正文', status: 'streaming', timestamp: 3 },
    ])
    expect(streamingRailAnchor(turn)).toEqual({ id: 'a1', length: 2, prefix: '正文' })
  })

  it('string content 为空串同样被跳过（text.length === 0 分支）', () => {
    const turn = anchorTurn([
      { id: 'a0', role: 'assistant', content: '', status: 'streaming', timestamp: 2 },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '第二块' }], status: 'streaming', timestamp: 3 },
    ])
    expect(streamingRailAnchor(turn)).toEqual({ id: 'a1', length: 3, prefix: '第二块' })
  })

  it('segment 全部空 text 块 / 无 assistants → null', () => {
    const emptyBlocks = anchorTurn([
      { id: 'a0', role: 'assistant', content: [{ type: 'text', text: '' }], status: 'streaming', timestamp: 2 },
    ])
    expect(streamingRailAnchor(emptyBlocks)).toBeNull()
    expect(streamingRailAnchor(anchorTurn([]))).toBeNull()
  })
})

describe('isRailSummarySettled 触顶判定（B-harden：省略号后缀即显示预算已满）', () => {
  it('省略号结尾 = settled；否则未触顶', () => {
    expect(isRailSummarySettled('这是一段很长的用户输入用来测试截断行为…')).toBe(true)
    expect(isRailSummarySettled('短')).toBe(false)
    expect(isRailSummarySettled('')).toBe(false)
  })
})
