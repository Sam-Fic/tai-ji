/**
 * 过程段切段纯函数单测（chat-flow-process-aggregate U1）。
 *
 * 覆盖任务书验收面：
 * - 段边界：空输入 / 纯 text / 段首段尾 / 多段交替 / 相邻 text 不产空段 / 跨 assistant 拍平序列
 * - 组分组：类型表三类 / 类型切换 / 思考打断重开组 / agentgraph 与类型表外工具独立成行（安全降级）
 * - 计数口径（AX7）：分类步数 / 思考数 / 总耗时（含思考，设计 §6）/ failedCount（RL4 混合状态）
 * - 三态判定输入（RL2）：followedByText 两边界（段后紧跟 text / 回合末段无后继 text——完成判定
 *   由调用方合成「回合落下」信号，纯函数契约见 splitProcessSegments JSDoc）
 * - 段 id 稳定性（AX1）：50 次增量流式追加模拟不抖
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/process-segment.test.ts
 */
import { describe, it, expect } from 'vitest'
import { flattenTurnBlocks, splitProcessSegments } from '../trace-window'
import type { ProcessSegment, ProcessToolGroup } from '../process-segment'
import type { Message, ThinkingBlock, ToolCall } from '@taiji/shared'

// ── fixture 构造 helper（形态同 trace-window.test.ts）──────────────────

let seq = 0

function makeTool(over: Partial<ToolCall> = {}): ToolCall {
  seq += 1
  return {
    id: over.id ?? `tc${seq}`,
    toolName: over.toolName ?? 'bash',
    input: over.input ?? {},
    status: over.status ?? 'completed',
    startTime: over.startTime ?? 0,
    ...over,
  }
}

function makeThinking(over: Partial<ThinkingBlock> = {}): ThinkingBlock {
  seq += 1
  return {
    id: over.id ?? `t${seq}`,
    content: over.content ?? 'think',
    collapsed: false,
    startTime: over.startTime,
    endTime: over.endTime,
  }
}

/** 块序列的紧凑描述：字符串 = text 块，其余按 ref 类型识别。 */
type BlockDesc = string | ThinkingBlock | ToolCall

/** 单 assistant Message：按 desc 顺序解出 contentBlocks（新引用——拍平 memo 按 Message 引用
 *  缓存，流式模拟必须每步重建 Message，原地 mutate 会命中旧值）。 */
function makeTurn(descs: BlockDesc[], id = 'a1'): Message {
  const thinking: ThinkingBlock[] = []
  const tools: ToolCall[] = []
  const blocks: Array<{ type: 'thinking' | 'toolCall' | 'text'; refId: string }> = []
  let hasText = false
  for (const d of descs) {
    if (typeof d === 'string') {
      hasText = true
      blocks.push({ type: 'text', refId: 'text' })
    } else if ('collapsed' in d) {
      thinking.push(d)
      blocks.push({ type: 'thinking', refId: d.id })
    } else {
      tools.push(d)
      blocks.push({ type: 'toolCall', refId: d.id })
    }
  }
  return {
    id,
    role: 'assistant',
    content: hasText ? '正文' : '',
    status: 'complete',
    timestamp: 0,
    thinking: thinking.length ? thinking : undefined,
    toolCalls: tools.length ? tools : undefined,
    contentBlocks: blocks.length ? blocks : undefined,
  }
}

/** 多 assistant 回合：每条 desc 列表一条 assistant（生产契约：单 message 最多 1 个 text 块，
 *  连续 text 场景用相邻 assistant 表达——与 pi tool 循环协议下每 message_start 新 assistant 同构）。 */
function splitOf(descLists: BlockDesc[][]): ProcessSegment[] {
  const msgs = descLists.map((descs, i) => makeTurn(descs, `a${i + 1}`))
  return splitProcessSegments(flattenTurnBlocks(msgs))
}

/** units 形态速览：group:<base> / member:<block kind>（断言可读性用）。 */
function unitShapes(seg: ProcessSegment): string[] {
  return seg.units.map((u) =>
    u.kind === 'group' ? `group:${u.group.base}` : `member:${u.block.block.kind}`,
  )
}

// ── 段边界 ────────────────────────────────────────────────────────────

describe('段边界', () => {
  it('空输入 → 无段', () => {
    expect(splitProcessSegments([])).toEqual([])
    expect(splitOf([[]])).toEqual([])
  })

  it('纯 text 序列（相邻 text 之间无过程块）→ 无段', () => {
    expect(splitOf([['正文一'], ['正文二']])).toEqual([])
  })

  it('首端第一个 text 之前的过程块自成一段（起始边界 = 序列开始）', () => {
    const segs = splitOf([[makeTool({ toolName: 'read' }), makeTool({ toolName: 'grep' }), '正文']])
    expect(segs).toHaveLength(1)
    expect(segs[0].id).toBe('seg:0')
    expect(segs[0].members.map((m) => m.flatIndex)).toEqual([0, 1])
    expect(segs[0].followedByText).toBe(true)
  })

  it('末端最后一条 text 之后的过程块同属一段（结束边界 = 序列结束）', () => {
    const segs = splitOf([['正文', makeTool(), makeTool()]])
    expect(segs).toHaveLength(1)
    expect(segs[0].id).toBe('seg:1')
    expect(segs[0].members.map((m) => m.flatIndex)).toEqual([1, 2])
    expect(segs[0].followedByText).toBe(false)
  })

  it('多段交替：每段由相邻 text 封闭，text 永不入段', () => {
    const segs = splitOf([[makeTool(), '正文一', makeTool(), '正文二', makeTool()]])
    expect(segs.map((s) => s.id)).toEqual(['seg:0', 'seg:2', 'seg:4'])
    expect(segs.map((s) => s.followedByText)).toEqual([true, true, false])
    for (const seg of segs) {
      expect(seg.members).toHaveLength(1)
      expect(seg.members.every((m) => m.block.kind !== 'text')).toBe(true)
    }
  })

  it('相邻 text 之间无过程块：不产生空段', () => {
    const segs = splitOf([['正文一', makeTool(), '正文二', '正文三']])
    expect(segs.map((s) => s.id)).toEqual(['seg:1'])
    expect(segs[0].followedByText).toBe(true)
  })

  it('跨 assistant 拍平序列：assistant 边界不是段边界', () => {
    // a1 [tool]，a2 [tool, text]——两个过程块跨 assistant 相邻，同段（切段只看拍平一维序）
    const segs = splitOf([[makeTool()], [makeTool(), '正文']])
    expect(segs).toHaveLength(1)
    expect(segs[0].id).toBe('seg:0')
    expect(segs[0].members.map((m) => m.assistantId)).toEqual(['a1', 'a2'])
    expect(segs[0].followedByText).toBe(true)
  })
})

// ── 组分组 ────────────────────────────────────────────────────────────

describe('组分组', () => {
  it('连续同 base 工具合成一组（复用 RUN_GROUP_TOOLS 类型表口径）', () => {
    const segs = splitOf([[makeTool({ toolName: 'read' }), makeTool({ toolName: 'grep' }), makeTool({ toolName: 'ls' })]])
    expect(segs[0].groups).toHaveLength(1)
    const group: ProcessToolGroup = segs[0].groups[0]
    expect(group.base).toBe('explore')
    expect(group.members).toHaveLength(3)
    // units 与 groups 引用同一组对象（渲染归属以 units 为准，禁止二次拼接）
    expect(unitShapes(segs[0])).toEqual(['group:explore'])
    expect(segs[0].units[0]).toEqual({ kind: 'group', group })
  })

  it('类型切换开新组；单成员组照出', () => {
    const segs = splitOf([[makeTool({ toolName: 'read' }), makeTool({ toolName: 'edit' })]])
    expect(segs[0].groups.map((g) => g.base)).toEqual(['explore', 'edit'])
    expect(segs[0].groups.every((g) => g.members.length === 1)).toBe(true)
    expect(unitShapes(segs[0])).toEqual(['group:explore', 'group:edit'])
  })

  it('思考行打断分组：同类型重新开组', () => {
    const segs = splitOf([[
      makeTool({ toolName: 'read', id: 'r1' }),
      makeThinking({ id: 'th1' }),
      makeTool({ toolName: 'read', id: 'r2' }),
    ]])
    expect(segs[0].groups).toHaveLength(2)
    expect(segs[0].groups.every((g) => g.base === 'explore')).toBe(true)
    expect(unitShapes(segs[0])).toEqual(['group:explore', 'member:thinking', 'group:explore'])
  })

  it('agentgraph 块不入组、独立成行（安全降级，U1 checkpoint 3）', () => {
    // toolName 'subagent' ∈ SUBAGENT_TOOL_NAMES → 拍平为 agentgraph kind（assistant-blocks.toolBlockOf）
    const segs = splitOf([[makeTool({ toolName: 'read' }), makeTool({ toolName: 'subagent' })]])
    expect(unitShapes(segs[0])).toEqual(['group:explore', 'member:agentgraph'])
    expect(segs[0].groups).toHaveLength(1)
    // agentgraph 不进分类步数（免取名不丢存在——仍计入 totalDurationMs / failedCount，见计数口径组）
    expect(segs[0].counts.categoryCounts).toEqual({ explore: 1, edit: 0, exec: 0 })
  })

  it('类型表外自定义工具独立成行、不计分类', () => {
    const segs = splitOf([[makeTool({ toolName: 'mcp__custom' }), makeTool({ toolName: 'bash' })]])
    expect(unitShapes(segs[0])).toEqual(['member:tool', 'group:exec'])
    expect(segs[0].counts.categoryCounts).toEqual({ explore: 0, edit: 0, exec: 1 })
  })

  it('组口径：running 入组（hasRunning 信号、耗时按 0）、error 计组内失败', () => {
    const done = makeTool({ toolName: 'bash', startTime: 0, endTime: 100, status: 'completed' })
    const failed = makeTool({ toolName: 'bash', startTime: 200, endTime: 500, status: 'error' })
    const running = makeTool({ toolName: 'bash', startTime: 600, status: 'running' })
    const segs = splitOf([[done, failed, running]])
    expect(segs[0].groups).toHaveLength(1)
    const group = segs[0].groups[0]
    expect(group.members).toHaveLength(3)
    expect(group.durationMs).toBe(100 + 300) // running 无 endTime 按 0
    expect(group.failedCount).toBe(1)
    expect(group.hasRunning).toBe(true)
  })

  it('text 边界同时打断组分组：相邻段的同类型工具不跨段合组', () => {
    const segs = splitOf([[
      makeTool({ toolName: 'read', id: 'r1' }),
      '正文',
      makeTool({ toolName: 'read', id: 'r2' }),
    ]])
    expect(segs).toHaveLength(2)
    expect(segs.every((s) => s.groups.length === 1 && s.groups[0].members.length === 1)).toBe(true)
  })
})

// ── 计数口径（AX7）────────────────────────────────────────────────────

describe('计数口径', () => {
  it('分类步数只统计类型表命中成员（含 running），思考数独立', () => {
    const segs = splitOf([[
      makeTool({ toolName: 'read' }),
      makeTool({ toolName: 'read', status: 'running' }),
      makeTool({ toolName: 'edit' }),
      makeThinking(),
      makeTool({ toolName: 'subagent' }),
    ]])
    expect(segs[0].counts.categoryCounts).toEqual({ explore: 2, edit: 1, exec: 0 })
    expect(segs[0].counts.thinkingCount).toBe(1)
  })

  it('总耗时含思考步骤（设计 §6 口径：所有步骤耗时之和）', () => {
    const th = makeThinking({ startTime: 0, endTime: 1000 })
    const tool = makeTool({ toolName: 'bash', startTime: 1000, endTime: 1500 })
    const segs = splitOf([[th, tool]])
    expect(segs[0].counts.totalDurationMs).toBe(1500)
  })

  it('时间戳缺失按 0、负值钳 0（数据不全时摘要行仍可用）', () => {
    const thNoTime = makeThinking({}) // 思考时间戳可选，双缺 → 0
    const toolNoEnd = makeTool({ toolName: 'read', startTime: 100, status: 'running' }) // endTime 缺 → 0
    const toolNegative = makeTool({ toolName: 'edit', startTime: 500, endTime: 100 }) // 负值钳 0
    const segs = splitOf([[thNoTime, toolNoEnd, toolNegative]])
    expect(segs[0].counts.totalDurationMs).toBe(0)
  })

  it('failedCount（RL4）：同段混合 completed/error/running 只数已完成失败块', () => {
    const done = makeTool({ toolName: 'read', status: 'completed' })
    const failed = makeTool({ toolName: 'bash', status: 'error', startTime: 0, endTime: 10 })
    const running = makeTool({ toolName: 'edit', status: 'running', startTime: 20 })
    const segs = splitOf([[done, failed, running]])
    expect(segs[0].counts.failedCount).toBe(1)
    // 失败块是段的正式成员（AX6：不做可见性剔除），仍在 members 与其组内
    expect(segs[0].members.map((m) => m.block.ref)).toContain(failed)
    const execGroup = segs[0].groups.find((g) => g.base === 'exec')
    expect(execGroup?.members.map((m) => m.block.ref)).toContain(failed)
    expect(execGroup?.failedCount).toBe(1)
  })

  it('agentgraph 计入总耗时与 failedCount（段正式成员，只是不取分类名）', () => {
    const ag = makeTool({ toolName: 'subagent', status: 'error', startTime: 0, endTime: 300 })
    const segs = splitOf([[ag]])
    expect(segs[0].counts.failedCount).toBe(1)
    expect(segs[0].counts.totalDurationMs).toBe(300)
    expect(segs[0].counts.categoryCounts).toEqual({ explore: 0, edit: 0, exec: 0 })
    expect(unitShapes(segs[0])).toEqual(['member:agentgraph'])
  })
})

// ── 三态判定输入（RL2）────────────────────────────────────────────────

describe('三态判定输入（RL2）', () => {
  it('段后紧跟 text → followedByText=true（完成态结构信号）', () => {
    const segs = splitOf([[makeTool(), makeThinking(), '正文']])
    expect(segs[0].followedByText).toBe(true)
  })

  it('回合末段无后继 text → followedByText=false；完成判定由调用方合成「回合落下」信号', () => {
    // 纯函数只吃块序列，不感知回合工作态（isWorkingTurn 是块序列之外的调用方状态）：
    // followedByText=false 的开放段，调用方在回合工作态翻 false 时判定为完成态——
    // 边界条款落在 splitProcessSegments 的函数契约 JSDoc（RL2 机器检查点）。
    // pi 回合以工具收尾是常见形态：末端段仍是完整段数据，不产生无主过程块。
    const segs = splitOf([['正文', makeTool()]])
    expect(segs[0].followedByText).toBe(false)
    expect(segs[0].members).toHaveLength(1)
  })
})

// ── 段 id 稳定性（AX1）────────────────────────────────────────────────

describe('段 id 稳定性（AX1）', () => {
  it('id 形态 = seg:<段首块 flatIndex>（十进制）', () => {
    const segs = splitOf([[makeTool(), makeThinking(), '正文', makeTool()]])
    expect(segs.map((s) => s.id)).toEqual(['seg:0', 'seg:3'])
    for (const id of segs.map((s) => s.id)) {
      expect(id).toMatch(/^seg:\d+$/)
    }
  })

  it('50 次增量流式追加模拟：既有段 id 不抖、新段出现才产生新 id', () => {
    // 流式模型：每步在回合尾部追加一个块，重建 assistants（新 Message 引用——对齐 ADR-0039
    // 不可变替换契约，原地 mutate 会命中 flattenTurnBlocks 的 per-assistant memo 旧值）后重新
    // 拍平切段。断言：既有段 id 列表恒为新 id 列表的前缀（不变 / 不消失 / 不重排）；两次 text
    // 边界使段从 1 生长到 3，全部以尾部追加方式出现。
    const descs: BlockDesc[] = []
    let prevIds: string[] = []
    let tailFollowedByText = false
    for (let i = 0; i < 50; i++) {
      if (i === 20 || i === 40) {
        descs.push(`正文 ${i}`)
      } else if (i % 3 === 2) {
        descs.push(makeThinking({ id: `t${i}` }))
      } else {
        descs.push(
          makeTool({
            id: `tc${i}`,
            toolName: i % 2 === 0 ? 'read' : 'bash',
            startTime: i,
            endTime: i + 1,
          }),
        )
      }
      const msgs: Message[] = [makeTurn(descs, 'a1')]
      const segs = splitProcessSegments(flattenTurnBlocks(msgs))
      const ids = segs.map((s) => s.id)
      expect(ids.slice(0, prevIds.length)).toEqual(prevIds)
      prevIds = ids
      // RL2 流式对照：text 落下前末段开放（followedByText=false），text 封闭后翻 true
      const tail = segs[segs.length - 1]
      if (i === 19) tailFollowedByText = tail.followedByText
      if (i === 20) {
        expect(tailFollowedByText).toBe(false)
        expect(segs[0].followedByText).toBe(true)
      }
    }
    expect(prevIds).toEqual(['seg:0', 'seg:21', 'seg:41'])
    expect(prevIds.every((id) => /^seg:\d+$/.test(id))).toBe(true)
  })
})
