/**
 * trace-window 纯函数单测。
 *
 * 覆盖：flattenTurnBlocks 拍平（TC1-TC4 拍平断言：跨 assistant flatIndex 连续、
 * assistantId/assistantStatus 透传、contentBlocks 有序块解出、failed retry-loop 形态）
 * + ADR-0122 纯 error 气泡的 text 块宿主 + 展开段 memo 命中信号（OrderedBlock 引用复用）
 * + RUN_GROUP_TOOLS 类型表与 pi 内置工具注册表对齐（上游新增内置工具时这里会红）。
 * 切段（splitProcessSegments）用例在 process-segment.test.ts。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/trace-window.test.ts
 */
import { describe, it, expect } from 'vitest'
import { flattenTurnBlocks, RUN_GROUP_TOOLS } from '../trace-window'
import type { FlatBlock } from '../trace-window'
import type { Message, ToolCall, ThinkingBlock } from '@taiji/shared'
import { BUILTIN_TOOLS } from '@taiji/shared'

// ── fixture 构造 helper ───────────────────────────────────────────────

let toolSeq = 0
let thinkSeq = 0

function makeThinking(over: Partial<ThinkingBlock> = {}): ThinkingBlock {
  thinkSeq += 1
  return { id: over.id ?? `t${thinkSeq}`, content: over.content ?? 'think', collapsed: false }
}

function makeTool(over: Partial<ToolCall> = {}): ToolCall {
  toolSeq += 1
  return {
    id: over.id ?? `tc${toolSeq}`,
    toolName: over.toolName ?? 'bash',
    input: over.input ?? {},
    status: over.status ?? 'completed',
    startTime: over.startTime ?? 0,
    ...over,
  }
}

/** 构造 assistant Message：按 contentBlocks 顺序解出，自动建对应的 thinking/toolCalls。 */
function makeAssistant(
  over: Partial<Message> & {
    thinkingBlocks?: ThinkingBlock[]
    tools?: ToolCall[]
    blocks?: Array<{ type: 'thinking' | 'toolCall' | 'text'; refId: string }>
  },
): Message {
  const id = over.id ?? 'a1'
  const thinkingBlocks = over.thinkingBlocks ?? []
  const tools = over.tools ?? []
  return {
    id,
    role: 'assistant',
    content: over.content ?? '',
    status: over.status ?? 'complete',
    timestamp: 0,
    thinking: thinkingBlocks.length ? thinkingBlocks : undefined,
    toolCalls: tools.length ? tools : undefined,
    contentBlocks: over.blocks,
  }
}

/** flatIndex 序列提取 helper（断言用）。 */
function flatIndices(visible: FlatBlock[]): number[] {
  return visible.map((fb) => fb.flatIndex)
}

// ── TC1：空块拍平 ─────────────────────────────────────────────────────

describe('TC1 空块拍平', () => {
  it('flattenTurnBlocks([]) 返回 []', () => {
    expect(flattenTurnBlocks([])).toEqual([])
  })
})

// ── TC2：单 assistant 单 thinking 块 ─────────────────────────────────

describe('TC2 单 assistant 单 thinking 块', () => {
  const th = makeThinking({ id: 't1', content: 'hello-think' })
  const a1 = makeAssistant({
    id: 'a1',
    status: 'complete',
    thinkingBlocks: [th],
    blocks: [{ type: 'thinking', refId: 't1' }],
  })

  it('flatten 返回 1 个 FlatBlock，透传 assistantId/Status，flatIndex=0', () => {
    const flat = flattenTurnBlocks([a1])
    expect(flat).toHaveLength(1)
    expect(flat[0].assistantId).toBe('a1')
    expect(flat[0].assistantStatus).toBe('complete')
    expect(flat[0].flatIndex).toBe(0)
    expect(flat[0].block.kind).toBe('thinking')
    expect((flat[0].block.ref as ThinkingBlock).id).toBe('t1')
  })
})

// ── TC3：全 failed retry-loop 的拍平形态 ─────────────────────────────

describe('TC3 全 failed retry-loop', () => {
  // 5 个 tool 块全部 status='error'（典型 retry-loop 失败重试场景）
  const tools: ToolCall[] = []
  const blocks: Array<{ type: 'toolCall'; refId: string }> = []
  for (let i = 0; i < 5; i++) {
    const id = `tc${i}`
    tools.push(makeTool({ id, status: 'error' }))
    blocks.push({ type: 'toolCall', refId: id })
  }
  const a1 = makeAssistant({ id: 'a1', status: 'complete', tools, blocks })
  const flat = flattenTurnBlocks([a1])

  it('flatten 返回 5 个 tool 块，flatIndex 0-4', () => {
    expect(flat).toHaveLength(5)
    expect(flat.every((fb) => fb.block.kind === 'tool')).toBe(true)
    expect(flatIndices(flat)).toEqual([0, 1, 2, 3, 4])
  })
})

// ── TC4：多 assistant 混合时序（硬编码 fixture + 确定期望值） ─────────

describe('TC4 多 assistant 混合（2 assistant: complete + streaming）', () => {
  // 硬编码 fixture：
  //  a1 status='complete': contentBlocks=[thinking(t1), toolCall(tc1 completed), text]
  //    → expand = [thinking, tool, text] → flatIndex 0,1,2
  //  a2 status='streaming': contentBlocks=[toolCall(tc2 completed), thinking(t2)]
  //    → expand = [tool, thinking] → flatIndex 3,4
  const a1 = makeAssistant({
    id: 'a1',
    status: 'complete',
    content: 'hello-text',
    thinkingBlocks: [makeThinking({ id: 't1' })],
    tools: [makeTool({ id: 'tc1', status: 'completed' })],
    blocks: [
      { type: 'thinking', refId: 't1' },
      { type: 'toolCall', refId: 'tc1' },
      { type: 'text', refId: 'text' },
    ],
  })
  const a2 = makeAssistant({
    id: 'a2',
    status: 'streaming',
    thinkingBlocks: [makeThinking({ id: 't2' })],
    tools: [makeTool({ id: 'tc2', status: 'completed' })],
    blocks: [
      { type: 'toolCall', refId: 'tc2' },
      { type: 'thinking', refId: 't2' },
    ],
  })
  const flat = flattenTurnBlocks([a1, a2])

  it('flatten flatIndex 跨 a1/a2 连续 0..4，kind 与 assistantId 正确', () => {
    expect(flat).toHaveLength(5)
    expect(flatIndices(flat)).toEqual([0, 1, 2, 3, 4])
    // a1: fb0=thinking, fb1=tool(tc1), fb2=text
    expect(flat[0]).toMatchObject({ assistantId: 'a1', assistantStatus: 'complete' })
    expect(flat[0].block.kind).toBe('thinking')
    expect(flat[1].block.kind).toBe('tool')
    expect(flat[2].block.kind).toBe('text')
    // a2: fb3=tool(tc2), fb4=thinking
    expect(flat[3]).toMatchObject({ assistantId: 'a2', assistantStatus: 'streaming' })
    expect(flat[3].block.kind).toBe('tool')
    expect(flat[4].block.kind).toBe('thinking')
  })
})

// ── RUN_GROUP_TOOLS 类型表对齐（splitProcessSegments 段内组分组的判定源）──

describe('RUN_GROUP_TOOLS 类型表与 pi 内置工具注册表对齐', () => {
  it('类型表与 pi 内置工具注册表对齐：7 个内置工具全覆盖（上游新增内置工具时这里会红）', () => {
    const mapped = new Set<string>(Object.values(RUN_GROUP_TOOLS).flat())
    expect([...BUILTIN_TOOLS].filter((name) => !mapped.has(name))).toEqual([])
  })
})

// ── [ADR-0122 断连未确认终局] 纯 error 气泡的 text 块宿主保证 ──────────────────
// content 空 + error 非空的 error 消息（秒败 turn / 断连显式失败上报）必须产出 text 块：
// Block 的 error danger 行只挂 text 分支，零块消息的 error 文案在对话流不可见（静默悬挂）。

describe('纯 error 气泡的 text 块宿主（ADR-0122 断连未确认终局）', () => {
  it('fallback 路径：content 空 + error 非空（status error）→ 产 1 个空正文 text 块（error 行宿主）', () => {
    // makeAssistant 是显式字段列表（不带 error），按 Message 真实形态补 error 字段
    const errMsg: Message = {
      ...makeAssistant({ id: 'a-err', content: '', status: 'error' }),
      error: '执行结果未确认',
    }
    const flat = flattenTurnBlocks([errMsg])
    expect(flat).toHaveLength(1)
    expect(flat[0]!.block.kind).toBe('text')
    expect(flat[0]!.block.ref).toBe('')
    expect(flat[0]!.assistantStatus).toBe('error')
  })

  it('非 error 的空 content 消息保持零块（不误产空块）', () => {
    const silent = makeAssistant({ id: 'a-silent', content: '', status: 'complete' })
    expect(flattenTurnBlocks([silent])).toHaveLength(0)
  })

  it('error 非空 + content 非空：单 text 块（追加形态，正文 + error 行）不双产', () => {
    const errMsg: Message = {
      ...makeAssistant({ id: 'a-both', content: '崩溃前正文', status: 'error' }),
      error: '会话出错',
    }
    const flat = flattenTurnBlocks([errMsg])
    expect(flat).toHaveLength(1)
    expect(flat[0]!.block.kind).toBe('text')
    expect(flat[0]!.block.ref).toBe('崩溃前正文')
  })
})

// ── 展开段 memo（streaming 性能，TurnRail.vue railMemo 同族范式）──────────────
// WeakMap 按 msg 引用缓存 expandAssistantBlocks 输出段：引用同 ⇒ 内容同（ADR-0039
// 不可变替换）⇒ 段值恒等；对外可观察的命中信号 = OrderedBlock 包装引用复用（重算则新建）。

describe('flattenTurnBlocks 展开段 memo', () => {
  it('同 assistant 引用二次调用：memo 命中（OrderedBlock 引用相同），输出值恒等', () => {
    const a1 = makeAssistant({
      id: 'a1',
      contentBlocks: [{ type: 'toolCall', refId: 'tc1' }],
      tools: [makeTool({ id: 'tc1' })],
    })
    const flat1 = flattenTurnBlocks([a1])
    const flat2 = flattenTurnBlocks([a1])
    expect(flat2).toEqual(flat1)
    expect(flat2[0]!.block).toBe(flat1[0]!.block)
  })

  it('不同引用内容相同的 assistant：各自计算，不误命中', () => {
    const build = () =>
      makeAssistant({
        id: 'a1',
        contentBlocks: [{ type: 'toolCall', refId: 'tc1' }],
        tools: [makeTool({ id: 'tc1', toolName: 'bash' })],
      })
    const flat1 = flattenTurnBlocks([build()])
    const flat2 = flattenTurnBlocks([build()])
    expect(flat2).toEqual(flat1)
    expect(flat2[0]!.block).not.toBe(flat1[0]!.block)
  })
})
