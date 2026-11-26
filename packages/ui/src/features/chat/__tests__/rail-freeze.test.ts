import { describe, it, expect } from 'vitest'
import { railMemoFor, resetRailFreezeSlot } from '../rail-turn-memo'
import type { MessageTurn } from '@taiji/core/domain/chat'

/** 流式 turn 构造器：assistant 文本可增长（append-only 语义） */
function makeStreamingTurn (assistantText: string, opts: { id?: string; isStreaming?: boolean; user?: boolean } = {}): MessageTurn {
  return {
    index: 0,
    user: opts.user === false ? null : {
      id: 'u1', role: 'user', content: [{ type: 'text', text: '提示词' }], status: 'complete', timestamp: 1,
    } as never,
    assistants: [{
      id: opts.id ?? 'a1', role: 'assistant', content: [{ type: 'text', text: assistantText }], status: 'complete', timestamp: 2,
    }] as never,
    isStreaming: opts.isStreaming ?? true,
    hasFoldable: false,
  } as MessageTurn
}

/** 多 assistant turn 构造器（纯空白首块 + 后续真实文本块场景） */
function makeMultiAssistantTurn (blocks: Array<{ id: string; text: string }>, isStreaming = true): MessageTurn {
  return {
    index: 0,
    user: { id: 'u1', role: 'user', content: [{ type: 'text', text: '提示词' }], status: 'complete', timestamp: 1 } as never,
    assistants: blocks.map((b, i) => ({
      id: b.id, role: 'assistant', content: [{ type: 'text', text: b.text }], status: 'complete', timestamp: 2 + i,
    })) as never,
    isStreaming,
    hasFoldable: false,
  } as MessageTurn
}

describe('railMemoFor 流式冻结', () => {
  it('streaming 中同 id 且 content 长度 ≥ K 后复用上次摘要（不再逐 delta 重算）', () => {
    const first = makeStreamingTurn('x'.repeat(300))
    const m1 = railMemoFor(first)
    expect(m1.agentSummary).toBe('x'.repeat(19) + '…')
    // 同 id、内容变长（append-only）、仍 streaming → 冻结复用
    const second = makeStreamingTurn('x'.repeat(300) + 'y'.repeat(5000))
    const m2 = railMemoFor(second)
    expect(m2.agentSummary).toBe(m1.agentSummary)
  })

  it('长度未达 K 时不冻结（短消息期照常重算）', () => {
    const a = makeStreamingTurn('短')
    const b = makeStreamingTurn('短文本增长一点')
    expect(railMemoFor(a).agentSummary).toBe('短')
    expect(railMemoFor(b).agentSummary).toBe('短文本增长一点')
  })

  it('换 assistant id 冻结立即失效（新一轮回复）', () => {
    const a = makeStreamingTurn('x'.repeat(300))
    const ma = railMemoFor(a)
    const b = makeStreamingTurn('x'.repeat(300), { id: 'a2' })
    expect(railMemoFor(b).agentSummary).toBe(ma.agentSummary) // 同文本同结果，走了重算路径
  })

  it('同 id 但前缀不同（防御性指纹）→ 冻结失效重算', () => {
    railMemoFor(makeStreamingTurn('x'.repeat(300)))
    const c = makeStreamingTurn('完全不同的内容'.repeat(50))
    expect(railMemoFor(c).agentSummary).not.toBe('x'.repeat(19) + '…')
    expect(railMemoFor(c).agentSummary).toContain('完全不同的内容')
  })

  it('streaming 结束后正常重算（终态值干净，不残留冻结前缀）', () => {
    // ASCII 确定性文本：stripMarkdown 后 'ab ab ab …'，truncate 20 → keep=19 码点
    const body = 'ab '.repeat(80)
    const streaming = makeStreamingTurn(body)
    const frozen = railMemoFor(streaming).agentSummary
    // 流结束（isStreaming=false），内容定稿（append 后缀）
    const done = makeStreamingTurn(body + 'tail', { isStreaming: false })
    const terminal = railMemoFor(done).agentSummary
    expect(terminal).toBe('ab ab ab ab ab ab a…')
    expect(frozen).toBe(terminal) // 该场景冻结值与终态一致（前缀已稳定）
  })

  it('前缀含未闭合 fence 时也冻结（守卫③已删：fence 行无条件剥离使标记不可能进摘要）', () => {
    // P1-2 修复锚点：首条代码块落在前 256 字符内时，fenceOpen 是常量 true ⇒ 旧守卫让
    // 整个 turn 永不冻结（coding 主场景最常见长响应形态）。删守卫后该形态恢复冻结。
    const openFence = makeStreamingTurn('```ts\n' + 'x'.repeat(300))
    const m1 = railMemoFor(openFence)
    expect(m1.agentSummary).not.toContain('```') // fence 行被剥，标记不进摘要
    // 内容继续增长（仍含未闭合 fence）→ 冻结复用（不再每 delta 重算）
    const stillOpen = makeStreamingTurn('```ts\n' + 'x'.repeat(300) + 'y'.repeat(500))
    expect(railMemoFor(stillOpen).agentSummary).toBe(m1.agentSummary)
    // 闭合后摘要仍不含 fence 标记（stripMarkdown 行级剥离的结构性保证）
    const closed = makeStreamingTurn('```ts\n' + 'x'.repeat(300) + 'y'.repeat(500) + '\n```')
    expect(railMemoFor(closed).agentSummary).not.toContain('```')
  })

  it('摘要未触顶（空前缀/短前缀）不冻结：退回每 delta 重算，不把未成形值钉住', () => {
    resetRailFreezeSlot()
    // P6-1 修复锚点：前 256 字符是可被剥空的引导内容 ⇒ 摘要是空串（不带省略号）
    const junk = '[](u)'.repeat(70) // 70 个空链接，stripMarkdown 后为空
    const f0 = railMemoFor(makeStreamingTurn(junk))
    expect(f0.agentSummary).toBe('')
    // 正文到达：必须重算并显示出来（不能被空摘要冻结钉住）
    const f1 = railMemoFor(makeStreamingTurn(junk + '真正回答'))
    expect(f1.agentSummary).toBe('真正回答')
    const f2 = railMemoFor(makeStreamingTurn(junk + '真正回答继续增长变长'))
    expect(f2.agentSummary).toContain('真正回答')
    // 终态一致
    expect(railMemoFor(makeStreamingTurn(junk + '真正回答继续增长变长', { isStreaming: false })).agentSummary).toBe(f2.agentSummary)
  })

  it('前置空白 + 标题：未触顶期间不冻结，触顶后冻结', () => {
    resetRailFreezeSlot()
    const lead = '\n'.repeat(300)
    // 300 换行 + '# 标题'：stripMarkdown 剥标题标记后 = '标题'（2 码点，未触顶）⇒ 不冻结
    const t1 = railMemoFor(makeStreamingTurn(lead + '# 标题'))
    expect(t1.agentSummary).toBe('标题')
    // 正文继续增长超过 20 码点 ⇒ 触顶 ⇒ 此后冻结
    const t2 = railMemoFor(makeStreamingTurn(lead + '# 标题\n正文开始增长并且继续变长很多很多再多一些额外内容'))
    expect(t2.agentSummary).toBe('标题 正文开始增长并且继续变长很多很多…') // 19 码点 + 省略号 ⇒ 触顶
    const t3 = railMemoFor(makeStreamingTurn(lead + '# 标题\n正文开始增长并且继续变长很多很多再多一些额外内容再加长'))
    expect(t3.agentSummary).toBe(t2.agentSummary) // 冻结复用
  })

  it('failed/iconClass 字段不受冻结影响（按 turn 现算）', () => {
    const t = makeStreamingTurn('x'.repeat(300))
    const m = railMemoFor(t)
    expect(m.failed).toBe(false)
    expect(m.iconClass).toBe('text-neutral-ico')
    expect(typeof m.userSummary).toBe('string')
  })

  it('纯空白首块不成为冻结锚点（B-harden：摘要来源对齐）', () => {
    resetRailFreezeSlot()
    // 首块是 ≥K 的纯空白（normalizeContent 后 trim 为空 ⇒ 摘要函数跳过它，取第二块）
    const blank = ' \n\t'.repeat(200) // 600 字符纯空白
    const first = makeMultiAssistantTurn([
      { id: 'blank', text: blank },
      { id: 'real', text: '真实正文'.repeat(100) },
    ])
    const m1 = railMemoFor(first)
    // 摘要必须来自 real 块（不是空白块，也不是 fallback）
    expect(m1.agentSummary).toContain('真实正文')
    // 第二帧：空白块不变、real 块继续 append 增长 ⇒ 摘要前缀不变，可正常冻结复用
    const second = makeMultiAssistantTurn([
      { id: 'blank', text: blank },
      { id: 'real', text: '真实正文'.repeat(100) + '尾巴'.repeat(500) },
    ])
    expect(railMemoFor(second).agentSummary).toBe(m1.agentSummary)
  })

  it('纯空白首块 + 后续无文本 ⇒ 回落计数不冻结（fallback 无来源 message）', () => {
    resetRailFreezeSlot()
    const blank = ' \n\t'.repeat(200)
    const withThinking = {
      ...makeMultiAssistantTurn([{ id: 'blank', text: blank }]),
      assistants: [{
        id: 'blank', role: 'assistant', content: [{ type: 'text', text: blank }],
        status: 'complete', timestamp: 2, thinking: [{ id: 'th1', text: '思考中' }],
      }] as never,
    } as MessageTurn
    const m1 = railMemoFor(withThinking)
    expect(m1.agentSummary).toBe('1 thoughts') // fallback 计数
    // thinking 继续增长 ⇒ 计数必须随之更新（不能被冻结住）
    const grown = {
      ...withThinking,
      assistants: [{
        id: 'blank', role: 'assistant', content: [{ type: 'text', text: blank }],
        status: 'complete', timestamp: 2,
        thinking: [{ id: 'th1', text: '思考中' }, { id: 'th2', text: '再思考' }],
      }] as never,
    } as MessageTurn
    expect(railMemoFor(grown).agentSummary).toBe('2 thoughts')
  })

  it('resetRailFreezeSlot 显式清槽后下一帧重算（切 session 入口）', () => {
    resetRailFreezeSlot()
    const a = makeStreamingTurn('x'.repeat(300))
    const ma = railMemoFor(a)
    expect(ma.agentSummary).toBe('x'.repeat(19) + '…')
    resetRailFreezeSlot()
    // 清槽后同 id 同前缀也不再复用（走重算路径，值不变但证明槽已空）
    const b = makeStreamingTurn('x'.repeat(300) + 'y'.repeat(500))
    expect(railMemoFor(b).agentSummary).toBe(ma.agentSummary)
    // 重新记录后可再冻结
    const c = makeStreamingTurn('x'.repeat(300) + 'y'.repeat(500) + 'z'.repeat(500))
    expect(railMemoFor(c).agentSummary).toBe(ma.agentSummary)
  })

  it('跨 session 不串值：换 message id 的流式 turn 必重算（reset 漏跑也安全）', () => {
    resetRailFreezeSlot()
    const sa = makeStreamingTurn('session A 的流式正文'.repeat(30), { id: 'msg-A' })
    const ma = railMemoFor(sa)
    // 切到 session B（不调 reset，模拟 reset 漏跑）：不同 message id ⇒ 守卫 miss ⇒ 重算
    const sb = makeStreamingTurn('session B 的流式正文'.repeat(30), { id: 'msg-B' })
    const mb = railMemoFor(sb)
    expect(mb.agentSummary).toContain('session B')
    expect(mb.agentSummary).not.toContain('session A')
    // 回到 session A 且仍是同一 message ⇒ 可正常冻结复用（值同）
    const sa2 = makeStreamingTurn('session A 的流式正文'.repeat(30) + '尾巴'.repeat(50), { id: 'msg-A' })
    expect(railMemoFor(sa2).agentSummary).toBe(ma.agentSummary)
  })
})
