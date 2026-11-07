/**
 * streaming trace 拍平与过程段切段纯逻辑（chat 域 SSOT）。
 *
 * 数据模型：一个 turn 内可能有多条 assistant 消息（subagent 接力 / 多轮补写），
 * 每条 assistant 内部又含 thinking / toolCall / text 有序块（见 message-turns.expandAssistantBlocks）。
 * 渲染 trace 时先把「跨 assistant 的所有块」拍平成一维时序（flattenTurnBlocks → FlatBlock），
 * 再按 text 边界切段成聚合块段（splitProcessSegments → ProcessSegment）。
 *
 * 组成：
 * - flattenTurnBlocks：拍平一维（flatIndex 全 turn 全局递增），streaming 期间经 per-assistant
 *   展开段 memo 消除重复计算。
 * - run 分组判定原语：RUN_GROUP_TOOLS 类型表 + runBaseOf / memberDurationMs——段内组分组的
 *   唯一判定源，splitProcessSegments 复用，不另设第二判定源。
 * - splitProcessSegments（过程段切段，chat-flow-process-aggregate U1）：回合内拍平块序列按
 *   text 边界切成聚合块段（类型族与契约条文在 ./process-segment，本文件只放实现）。
 *
 * 归属：chat 域纯函数（零 Vue/renderer 依赖），对齐 w1-w6 chat 域绞杀模式（core SSOT）。
 * ui 包经 @taiji/core/domain/chat 子路径 import。
 */
import type { Message, ThinkingBlock, ToolCall } from '@taiji/shared'
import { expandAssistantBlocks, type OrderedBlock } from './message-turns'
import type { ProcessSegment, ProcessSegmentUnit, ProcessToolGroup } from './process-segment'

/**
 * 拍平后的渲染块单元。
 * - assistantId：所属 assistant 的 Message.id
 * - assistantStatus：所属 assistant 的 Message.status（MessageStatus，'streaming'|'complete'|'error'）
 * - block：原始有序块（复用 OrderedBlock，kind:'thinking'|'tool'|'text'|'agentgraph'）
 * - flatIndex：全 turn 内一维时序下标（从 0 全局递增，跨 assistant 连续）
 */
export interface FlatBlock {
  assistantId: string
  assistantStatus: Message['status']
  block: OrderedBlock
  flatIndex: number
}

/**
 * 把多条 assistant Message 的内部块按 contentBlocks 真实时序解出后拍平为一维。
 *
 * 按 assistants 数组顺序遍历，对每个 assistant 调 expandAssistantBlocks(msg)（from './message-turns'），
 * 把返回的 OrderedBlock[] 拼接，每个 block 包装成 FlatBlock，flatIndex 从 0 全局递增（跨 assistant 连续）。
 * 空数组 → 返回 []。纯函数无副作用（不修改入参）。
 */
/**
 * per-assistant 展开段 memo（streaming 性能优化，范式同 TurnRail.vue railMemo）。
 *
 * 背景：ui 侧 flatBlocks computed（Turn.vue）在 streaming 期间每 delta 拍重跑，本函数对
 * turn 内全部 assistant（含已完成的历史 assistant，实测单 turn 61 个）反复重跑
 * expandAssistantBlocks 的 contentBlocks 遍历 + thinking/toolCalls find 配对。
 * WeakMap 按 msg 引用缓存是正确的：ADR-0039 不可变替换——消息体任何内容变化（content/
 * status/thinking/toolCalls/contentBlocks）必产生新 Message 引用（填充点全部「新数组 +
 * { ...m }」形态），引用同 ⇒ 内容同 ⇒ 展开段值恒等（OrderedBlock.ref 透传 thinking/
 * toolCalls 数组元素，引用同 ⇒ 数组同 ⇒ 元素同）；内容变化必然 miss 后重算。
 * msg 对象被 GC 后 WeakMap 条目自动回收，无泄漏。
 * 缓存 OrderedBlock[]（展开段）而非 FlatBlock[]：flatIndex 是拼接时才可知的全局下标，
 * 缓存包装层需 mutate 写回或逐帧浅拷贝；包装成本远低于展开+配对，留在外层每帧新建
 * （与缓存前逐字节一致）。模块级：纯函数的值语义不变，缓存只消除重复计算。
 */
// @data-owner #58 —— chat 对话流渲染派生 memo ④（turn 展开段：assistant 消息引用 →
// OrderedBlock[]，纯派生可随时丢弃重建、无独立生命周期；WeakMap 条目随引用 GC 自动回收）
const expandSegmentMemo = new WeakMap<Message, OrderedBlock[]>()

export function flattenTurnBlocks(assistants: Message[]): FlatBlock[] {
  const result: FlatBlock[] = []
  let flatIndex = 0
  for (const msg of assistants) {
    let blocks = expandSegmentMemo.get(msg)
    if (blocks === undefined) {
      blocks = expandAssistantBlocks(msg)
      expandSegmentMemo.set(msg, blocks)
    }
    for (const block of blocks) {
      result.push({
        assistantId: msg.id,
        assistantStatus: msg.status,
        block,
        flatIndex,
      })
      flatIndex += 1
    }
  }
  return result
}

/**
 * tool/agentgraph 块是否为失败块（status==='error'）。
 *
 * 注意拼写陷阱：ToolCall 完成态是 'completed'（过去式），Message 完成态是 'complete'（无 d），
 * 两者不一致；failed 判定统一用 ToolCall 的 status==='error'（非 'failed'，ToolCallStatus 无 'failed'）。
 * 铁证：message-turns.ts hasFailedTool 用 t.status === 'error'；shared/message.ts error 字段注释
 * 「与 status:'error' 同源」。
 */
function isFailedProcessBlock(block: OrderedBlock): boolean {
  return (
    (block.kind === 'tool' || block.kind === 'agentgraph') &&
    (block.ref as ToolCall).status === 'error'
  )
}

/* ══ run 类型分组（demo specs/chat/history-load-and-run-grouping.md §3，real 侧落地）══
 * 长 run 折叠的判定源只有工具行的 toolName 一个字段，不解析参数内容：组名依赖对 agent 行为的
 * 语义解读，场景一变解读就会错；纯类型映射的错判在结构上不可能——漏登记工具的安全降级是
 * 「多显示一行」，不是「归错组」。
 */

/** 组类型：探索 / 改动 / 执行命令（中文名在 ui locale panel.message.runGroup*） */
export type RunGroupBase = 'explore' | 'edit' | 'exec'

/**
 * 类型判定表（唯一维护点）：名单与 pi 内置工具注册表对齐（shared BUILTIN_TOOLS 的 7 个内置工具
 * 全覆盖，pi 0.84.1 实装锚点见该常量注释）。
 *
 * 与 demo 表的差异是工具名对齐而非分类差异：demo 写 `glob` / `multiedit`，pi 注册表里对应的是
 * `find`（无 glob）、也没有 multiedit——照抄 demo 名单会让 find 这类高频只读工具掉进「原样」档。
 * 名单外的工具（子智能体 / workflow / MCP / 扩展工具）一律原样成行：归错组比归成自定义更糟
 * ——把一次子智能体派发画成「探索」是谎报。
 */
export const RUN_GROUP_TOOLS: Record<RunGroupBase, readonly string[]> = {
  explore: ['read', 'grep', 'find', 'ls'],
  edit: ['edit', 'write'],
  exec: ['bash'],
}

/** toolName → 组类型反查表（模块级构建一次，取代逐块线性查表） */
const TOOL_RUN_BASE: Map<string, RunGroupBase> = new Map(
  (Object.keys(RUN_GROUP_TOOLS) as RunGroupBase[]).flatMap((base) =>
    RUN_GROUP_TOOLS[base].map((name): [string, RunGroupBase] => [name, base]),
  ),
)

/** 组员候选判定（分组扫描 / 段首回查共用）：工具块且 toolName 在类型表内，两者都命中才给类型。 */
function runBaseOf(fb: FlatBlock): RunGroupBase | null {
  if (fb.block.kind !== 'tool') return null
  return TOOL_RUN_BASE.get((fb.block.ref as ToolCall).toolName) ?? null
}

/** 单成员耗时：endTime 缺失（end_not_received 等）按 0 计，负值钳 0。 */
function memberDurationMs(fb: FlatBlock): number {
  const tool = fb.block.ref as ToolCall
  if (typeof tool.startTime !== 'number' || typeof tool.endTime !== 'number') return 0
  return Math.max(0, tool.endTime - tool.startTime)
}

/* ══ 过程段切段（chat-flow-process-aggregate U1，设计 D8 / AX1 / AX4 / AX5 / AX7）══
 * 回合内拍平块序列按「两条正文块之间」切段，每段过程块（thinking / tool / agentgraph）收成一个
 * 聚合块（ProcessSegment）。类型族与契约条文在 ./process-segment（切段契约与切段实现双线并行
 * 的唯一对齐点），本文件只放实现。
 */

/** 思考步骤耗时：ThinkingBlock 的 startTime/endTime 均可选，任一缺失按 0、负值钳 0——
 *  与 memberDurationMs（工具步骤）同一条时间口径（ProcessSegmentCounts.totalDurationMs 契约），
 *  不另立第二套。 */
function thinkingDurationMs(block: OrderedBlock): number {
  const th = block.ref as ThinkingBlock
  if (typeof th.startTime !== 'number' || typeof th.endTime !== 'number') return 0
  return Math.max(0, th.endTime - th.startTime)
}

/**
 * 按 text 边界把拍平块序列切成过程段（切段纯函数，聚合块组件的唯一数据源）。
 *
 * 输入：flattenTurnBlocks 的输出序列（拍平一维序，flatIndex 升序）。切段只看拍平一维序，
 * assistant 边界不是段边界——跨 assistant 相邻的过程块同段。
 *
 * 边界条款（与 ProcessSegment 契约一致）：
 * - text 块恒为段边界，永不入段（正文原生展示、不并入计数摘要，AX5）；段成员数 ≥ 1，空段不存在。
 * - 序列首端第一个 text 之前的过程块自成一段（起始边界 = 序列开始）；序列末端最后一条 text
 *   之后的过程块同属一段（结束边界 = 序列结束）——pi 回合先调工具后写正文、以工具收尾都是
 *   常见形态，两种边界都不产生无主过程块。
 * - 相邻 text 之间无过程块时不产生段；空输入或纯 text 序列 → []。
 *
 * 段内组分组：复用 RUN_GROUP_TOOLS 类型表口径（runBaseOf 同一判定源，不重新发明）；连续同
 * base 工具成组，被思考行 / 独立行打断即重新开组，单成员组照出。类型表外
 * 工具与 agentgraph 块不入组、原样成行（member 单元）——纯类型映射的漏登记，安全降级是
 * 「多显示一行」而不是「归错组」（U1 checkpoint 3）。
 *
 * 计数口径（AX7）：分类步数 / 思考数 / 总耗时（含思考，设计 §6）/ failedCount（段内已完成
 * 失败块数，RL4）段级一次算好（口径条文见 ProcessSegmentCounts），渲染层零解析。
 *
 * 三态判定输入（RL2）：本函数只吃块序列，输出 followedByText 结构信号——true = 段已被后继
 * text 封闭（完成态）；false = 序列末端开放段，完成与否由调用方（ui）合成「回合落下」信号
 * （回合工作态 isWorkingTurn 翻 false，回合内全部未完成段同时完成）后判定。回合工作态是块
 * 序列之外的调用方状态，纯函数不感知回合生死。
 *
 * 段 id（AX1）：`seg:<段首块 flatIndex>`（十进制），派生源只有段首位置——流式段生长（成员
 * 追加）不改段首位置、新段只出现在序列尾部，既有段 id 流式全程不变、新段出现才产生新 id；
 * 禁止派生自消息 id / 成员集合 / 组内序号（条文见 ProcessSegment.id）。纯函数无副作用，
 * O(n) 单 pass。
 */
export function splitProcessSegments(blocks: FlatBlock[]): ProcessSegment[] {
  const segments: ProcessSegment[] = []
  // 开放段累积态：text 边界或序列末尾统一收拢（flush），单 pass O(n) 不回扫。
  let members: FlatBlock[] = []
  let units: ProcessSegmentUnit[] = []
  let groups: ProcessToolGroup[] = []
  let groupBase: RunGroupBase | null = null
  let groupMembers: FlatBlock[] = []
  const categoryCounts: Record<RunGroupBase, number> = { explore: 0, edit: 0, exec: 0 }
  let thinkingCount = 0
  let totalDurationMs = 0
  let failedCount = 0

  // 收拢当前开放工具组：组级三条口径（durationMs / failedCount / hasRunning）与段级口径
  // 同 pass 算好——组资格判定复用 runBaseOf（RUN_GROUP_TOOLS 类型表），不另设第二判定源。
  const flushGroup = (): void => {
    if (groupBase === null) return
    let durationMs = 0
    let groupFailed = 0
    let hasRunning = false
    for (const m of groupMembers) {
      durationMs += memberDurationMs(m)
      const status = (m.block.ref as ToolCall).status
      if (status === 'error') groupFailed += 1
      if (status === 'running') hasRunning = true
    }
    const group: ProcessToolGroup = {
      base: groupBase,
      members: groupMembers,
      durationMs,
      failedCount: groupFailed,
      hasRunning,
    }
    groups.push(group)
    units.push({ kind: 'group', group })
    groupBase = null
    groupMembers = []
  }

  // 收拢当前开放段并复位累积态：段 id 只在收拢时按段首位置派生（流式成员追加不触发射段，
  // 这是 id 稳定性的构造性来源）。
  const flushSegment = (followedByText: boolean): void => {
    if (members.length === 0) return
    segments.push({
      id: `seg:${members[0].flatIndex}`,
      members,
      groups,
      units,
      counts: {
        categoryCounts: { ...categoryCounts },
        thinkingCount,
        totalDurationMs,
        failedCount,
      },
      followedByText,
    })
    members = []
    units = []
    groups = []
    categoryCounts.explore = 0
    categoryCounts.edit = 0
    categoryCounts.exec = 0
    thinkingCount = 0
    totalDurationMs = 0
    failedCount = 0
  }

  for (const fb of blocks) {
    if (fb.block.kind === 'text') {
      // text 恒为段边界：封闭当前开放段（无开放段则无段产生），text 自身不入段。
      flushGroup()
      flushSegment(true)
      continue
    }
    members.push(fb)
    if (fb.block.kind === 'thinking') {
      thinkingCount += 1
      totalDurationMs += thinkingDurationMs(fb.block)
      flushGroup()
      units.push({ kind: 'member', block: fb })
      continue
    }
    // tool / agentgraph：段级口径计入（agentgraph 是段正式成员——计耗时与失败数，只是免取名）
    totalDurationMs += memberDurationMs(fb)
    if (isFailedProcessBlock(fb.block)) failedCount += 1
    const base = runBaseOf(fb)
    if (base === null) {
      // 类型表外工具与 agentgraph：不入组、原样成行（安全降级）
      flushGroup()
      units.push({ kind: 'member', block: fb })
      continue
    }
    if (groupBase !== null && groupBase !== base) flushGroup()
    if (groupBase === null) groupBase = base
    groupMembers.push(fb)
    categoryCounts[base] += 1
  }
  flushGroup()
  flushSegment(false)
  return segments
}
