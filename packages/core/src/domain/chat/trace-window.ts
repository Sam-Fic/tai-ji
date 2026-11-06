/**
 * streaming trace 窗口切片纯逻辑（chat 域 SSOT）。
 *
 * 数据模型：一个 turn 内可能有多条 assistant 消息（subagent 接力 / 多轮补写），
 * 每条 assistant 内部又含 thinking / toolCall / text 有序块（见 message-turns.expandAssistantBlocks）。
 * 渲染 trace 时需要把「跨 assistant 的所有块」拍平成一维时序，再按窗口策略决定哪些可见、
 * 哪些收编（compacted）、哪些是失败块（failed）独立计数。
 *
 * 三个输出语义（TraceWindowResult）：
 * - visible：按 flatIndex 升序的可见块（takeover=false 时由三类互斥块合并；takeover=true 时全量）
 * - compactedCount：被收编的「已完成过程块」数量（非 error、非进行中、非 text 的已定型块，
 *   超出窗口宽度 W 的靠前部分被折叠）。failed 块不计入此计数（见 failedCount）
 * - failedCount：被收编的 status==='error' 的 tool/agentgraph 块数量（失败重试独立计数，
 *   不污染 compactedCount）
 *
 * 归属：chat 域纯函数（零 Vue/renderer 依赖），对齐 w1-w6 chat 域绞杀模式（core SSOT）。
 * ui 包经 @taiji/core/domain/chat 子路径 import。
 *
 * 另含 groupToolRuns（run 类型分组）：连续同类型（探索 / 改动 / 执行命令）工具行折叠为组块的
 * 下游纯变换，接线点在 Turn.vue visibleBlocks 三分支汇合之后；不修改上方三函数的输入输出契约。
 *
 * 另含 splitProcessSegments（过程段切段，chat-flow-process-aggregate U1）：回合内拍平块序列按
 * text 边界切成聚合块段（类型族与契约条文在 ./process-segment）；既有三符号语义不动（设计 D8）。
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
 * 窗口切片结果。
 * - visible：按 flatIndex 升序的可见块
 * - compactedCount：被收编的非 error 已定型过程块数（已完成过程块总数 − visible 内该类数）
 * - failedCount：被收编的 status==='error' 的 tool/agentgraph 块数（不在 visible 内的失败块）
 */
export interface TraceWindowResult {
  visible: FlatBlock[]
  compactedCount: number
  failedCount: number
}

/** 窗口宽度（已完成过程块保留条数）。导出供 window wave 使用。
 *
 * 本常量无 ADR 依据（未登记进 docs/adr/）。ui-signal-density 第一批（候选 E）把它从 6 收窄到 4：
 * 收窄理由 = 工作回合（路径 B）首屏过程行从 ≤7 压到 ≤5（运行中口径，含 running 独立行），
 * 省 2 行——本设计全部改动里收益 / 成本比最高的一项（一个常量，窗口语义不变）。
 * 已接受代价 = 更多的已完成过程块并入计数摘要（compactedCount 收编口径；被收编块默认只剩计数，
 * 要看行内容须 takeover / 手动展开——恢复路径为既有机制）。
 * 重审触发条件 = 用户反馈「过程行不够看 / 要反复展开计数摘要才够用」，
 * 或 trace-window.test.ts 的收编断言需再次放宽。 */
export const W = 4

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

/**
 * 按窗口策略切片拍平后的块。
 *
 * takeover=true → visible=全部 blocks（按 flatIndex 升序），compactedCount=0，failedCount=0。
 * takeover=false → visible 收集三类互斥块后合并按 flatIndex 升序：
 *   ① 每个 assistant 的末位 text：按 assistantId 分组，各保留 flatIndex 最大的 text 块。多 assistant
 *      turn（ask-user 续写/compact 续写/subagent 接力）下每个 assistant 的最终回复默认可见；单 assistant
 *      内的过渡碎片只留末位（design §3.3 D2「只留最后一条」针对单 assistant 过渡碎片，不套用到多 assistant）
 *   ② 进行中块：对每个 assistantStatus==='streaming' 的 assistant（按 assistantId 分组），取其拍平块中
 *      最后一个 kind ∈ {thinking,tool,agentgraph} 的块（flatIndex 最大者）
 *   ③ 已完成过程块（压缩候选）：所有满足 kind!=='text' 且不在②集合内 且（kind==='thinking' 或
 *      tool/agentgraph 且 status!=='error'）的块；从这池子按 flatIndex 降序取前 windowSize 个
 *   三类按 flatIndex 标识去重后合并，最终按 flatIndex 升序输出。
 * compactedCount = ③候选池总数 − visible 内属于③的数量。
 * failedCount = 所有 tool/agentgraph 且 status==='error' 的块中不在 visible 内的数量。
 *   （若某 error tool 恰好是 streaming assistant 末尾块被②收入 visible，按「不在 visible 内」判定
 *   自然不计入 failedCount，无需特判。）
 * 空 blocks → { visible: [], compactedCount: 0, failedCount: 0 }。纯函数无副作用。
 */
/** ① 全 turn 末位 text（flatIndex 最大的 text 块，单个）——不按 assistant 分组。
 *  [2026-08-14 修正] 原「按 assistantId 分组各保留末位 text」针对多 assistant turn（ask-user/compact
 *  续写），但 pi tool 循环协议下每 message_start 新 assistant Message，单 agent 一个 turn 跑几十次
 *  循环产生几十个 assistant，按 assistant 分组会每 assistant 末位 text 都保留致 visible 爆炸（实测
 *  61 assistant → ①=12 text）。改为全 turn 最后 text：流式正文始终可见，历史 text 进③候选池可被窗口收编。
 *  多 assistant 续写场景的非末位回复经 takeover「展开全部」或历史 turn 查看。 */
function findLastText(blocks: FlatBlock[]): FlatBlock | undefined {
  let lastText: FlatBlock | undefined
  for (const fb of blocks) {
    if (fb.block.kind === 'text' && (!lastText || fb.flatIndex > lastText.flatIndex)) {
      lastText = fb
    }
  }
  return lastText
}

/** ② 进行中块：只保留全 turn 最后一个 streaming 块（flatIndex 最大的 streaming 非 text，单个）。
 *  [2026-08-14 修正] 原按 streaming assistant 分组每 assistant 各一个，但 pi tool 循环历史 assistant
 *  未正确 complete（上游 bug）致多 streaming assistant，②爆炸（实测 61 streaming → ②=61）。
 *  改为单个最后 streaming 块：只展示「当前正在进行的最新动作」。 */
function findLastInProgress(blocks: FlatBlock[]): FlatBlock | undefined {
  let lastInProgress: FlatBlock | undefined
  for (const fb of blocks) {
    if (
      fb.assistantStatus === 'streaming' &&
      fb.block.kind !== 'text' &&
      (!lastInProgress || fb.flatIndex > lastInProgress.flatIndex)
    ) {
      lastInProgress = fb
    }
  }
  return lastInProgress
}

/** ③ 已完成过程块（压缩候选）：kind!=='text' 且不在②内 且（thinking 或 tool/agentgraph 非 error）。 */
function collectCompletedProcessPool(blocks: FlatBlock[], inProgressSet: Set<number>): FlatBlock[] {
  const completedProcessPool: FlatBlock[] = []
  for (const fb of blocks) {
    if (fb.block.kind === 'text') continue
    if (inProgressSet.has(fb.flatIndex)) continue
    if (fb.block.kind === 'thinking' || !isFailedProcessBlock(fb.block)) {
      completedProcessPool.push(fb)
    }
  }
  return completedProcessPool
}

/** 合并①②③三类（按 flatIndex 去重），按 flatIndex 升序输出；mergedIds = 去重后的
 *  flatIndex 全集（compactedCount 的「属于 visible」判定用，与原 merged Map.has 同语义）。 */
function mergeVisibleBlocks(
  lastText: FlatBlock | undefined,
  lastInProgress: FlatBlock | undefined,
  windowed: FlatBlock[],
): { visible: FlatBlock[]; mergedIds: Set<number> } {
  const merged = new Map<number, FlatBlock>()
  if (lastText) merged.set(lastText.flatIndex, lastText)
  if (lastInProgress) merged.set(lastInProgress.flatIndex, lastInProgress)
  for (const fb of windowed) merged.set(fb.flatIndex, fb)
  const visible = [...merged.values()].sort((a, b) => a.flatIndex - b.flatIndex)
  return { visible, mergedIds: new Set(merged.keys()) }
}

/** failedCount = 所有 error tool/agentgraph 块中不在 visible 内的数量。 */
function countFailedOutsideVisible(blocks: FlatBlock[], visibleSet: Set<number>): number {
  let failedCount = 0
  for (const fb of blocks) {
    if (isFailedProcessBlock(fb.block) && !visibleSet.has(fb.flatIndex)) {
      failedCount += 1
    }
  }
  return failedCount
}

/* ══ run 类型分组（demo specs/chat/history-load-and-run-grouping.md §3，real 侧落地）══
 * 长 run 折叠的判定源只有工具行的 toolName 一个字段，不解析参数内容：组名依赖对 agent 行为的
 * 语义解读，场景一变解读就会错；纯类型映射的错判在结构上不可能——漏登记工具的安全降级是
 * 「多显示一行」，不是「归错组」。
 */

/** 组类型：探索 / 改动 / 执行命令（中文名在 ui locale panel.message.runGroup*） */
export type RunGroupBase = 'explore' | 'edit' | 'exec'

/**
 * 里程碑徽标类型（demo spec §3.6 的 tool row `mile` 契约在 real 侧的落地形态）。
 *
 * 信号来源裁决（与分组判定同族的原则——零内容解析、零启发式）：
 * - `firstEdit`（首个改动）= 全 turn 第一个 status==='completed' 的 edit/write 工具行。
 *   纯结构信号（工具类型 + 状态 + 次序），不读参数、不读输出。
 * - 语义里程碑（demo 示例的「测试通过」等）**不派生**：判定它需要解析 bash 参数/输出
 *   （关键词启发式）——正是 spec v4 废除、AGENTS.md 事实驱动原则禁止的乐观呈现。
 *   待上游显式信号（pi tool details 带标注）出现时按同契约扩展本联合类型，
 *   不做「先从输出里猜」的中间态。
 */
export type RunGroupMile = 'firstEdit'

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

/** edit 组工具名集合（里程碑判定用：首个改动 = 第一个 completed 的改动类工具行）。 */
const EDIT_TOOLS: ReadonlySet<string> = new Set(RUN_GROUP_TOOLS.edit)

/**
 * 首个改动里程碑的锚点：flatBlocks 全序列中第一个 status==='completed' 的 edit/write 行 flatIndex。
 * 无（无改动 / 改动全 error / 无 completed）→ null。
 *
 * 在 flatBlocks（全序列）而非 visible（窗口切片）上判定：窗口化后首个 edit 可能被收编出窗，
 * 此时承载它的组根本不渲染——锚点缺失自然无徽标，不会出现「把段内第一个可见 edit 误标成
 * 首个改动」的假呈现。
 */
function firstEditFlatIndex(flatBlocks: FlatBlock[]): number | null {
  for (const fb of flatBlocks) {
    if (fb.block.kind !== 'tool') continue
    const tool = fb.block.ref as ToolCall
    if (tool.status === 'completed' && EDIT_TOOLS.has(tool.toolName)) return fb.flatIndex
  }
  return null
}

/**
 * run 组块：`groupToolRuns` 输出的新序列单元，不是 FlatBlock（组块没有单一 flatIndex）。
 * 组身份 = 类型 + 成员集合本身，成员增减是组内容变化。
 */
export interface RunGroupBlock {
  kind: 'run-group'
  /** 组类型（判定源 RUN_GROUP_TOOLS）：渲染层据此取名与图标 */
  base: RunGroupBase
  /** 组成员（连续同类型的可见块，按 flatIndex 升序；组资格只看工具类型，running 也入组） */
  members: FlatBlock[]
  /** 组头聚合（三条计数口径）：值在纯函数侧一次算好，渲染层零解析 */
  header: {
    /** N = 成员数（含 running） */
    count: number
    /** 耗时 = 已完成成员耗时合计（endTime − startTime 之和；endTime 缺失的成员按 0 计；running 成员不计入——其 endTime 必缺失，天然按 0） */
    durationMs: number
    /** 含 M 次失败 = 成员中 status==='error' 的数量（组内口径，与窗口全局 failedCount 是两套独立计数——后者统计不在 visible 内的失败块） */
    failedCount: number
  }
  /** 组内是否含 status==='running' 的成员（放接口顶层——它是渲染信号不是计数口径，不入 header）。
   *  渲染层据此给组头套执行态视觉：loader 图标（挂载一律收起，2026-10-15 ①A 裁决——展开态只由用户点击驱动）。 */
  hasRunning: boolean
  /** 里程碑徽标（demo spec §3.6）：成员命中结构确定性信号时聚合上组头，无则空数组（无则不显示）。
    当前唯一信号 = firstEdit（首个改动），判定口径见 RunGroupMile 注释。 */
  miles: RunGroupMile[]
  /** 段首锚定 key（run head）：members[0] 在 flatBlocks 全序列中所属连续同类型段的段首 flatIndex。
   *  对窗口滑动（段首成员被收编出窗）与段尾延长（running 并入）两个生长方向都稳定——窗口滑动
   *  不改段首在 flatBlocks 里的位置、段尾延长也不改段首，故 :key 不抖（remount = 展开态丢 + 滚动锚点跳）。 */
  headFlatIndex: number
}

/** Turn.vue visibleBlocks 三分支汇合后的渲染单元：普通块或 run 组块 */
export type TraceRenderUnit = FlatBlock | RunGroupBlock

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

/**
 * 段首回查（key 规则）：从首成员在 flatBlocks 中的位置沿 flatIndex 递减方向扫描同类型工具块至段头。
 * 段 = flatBlocks 全序列中相邻连续的同类型工具块（纯几何概念，不筛 status——error 成员也是段内成员）。
 * 入参一致性不变量：flatBlocks 与 visible 同源同拍（Turn.vue 两者都从 props.turn.assistants 的
 * computed 派生、同一渲染拍计算），首成员必在 flatBlocks 中；防御缺省（调用方违约）回落成员自身
 * flatIndex，不 throw。
 */
function runHeadIndex(
  firstMember: FlatBlock,
  base: RunGroupBase,
  flatBlocks: FlatBlock[],
  positionByFlatIndex: Map<number, number>,
): number {
  const startIdx = positionByFlatIndex.get(firstMember.flatIndex)
  if (startIdx === undefined) return firstMember.flatIndex
  let head = firstMember.flatIndex
  for (let i = startIdx - 1; i >= 0; i--) {
    if (runBaseOf(flatBlocks[i]) !== base) break
    head = flatBlocks[i].flatIndex
  }
  return head
}

/** 组块构建：三条计数口径 + hasRunning 一次算好 + 段首锚定 key + 里程碑徽标。 */
function buildRunGroup(
  base: RunGroupBase,
  members: FlatBlock[],
  flatBlocks: FlatBlock[],
  positionByFlatIndex: Map<number, number>,
  firstEditIndex: number | null,
): RunGroupBlock {
  let durationMs = 0
  let failedCount = 0
  let hasRunning = false
  for (const m of members) {
    durationMs += memberDurationMs(m)
    const status = (m.block.ref as ToolCall).status
    if (status === 'error') failedCount += 1
    if (status === 'running') hasRunning = true
  }
  // 里程碑聚合（demo「聚合挂组头徽标」）：锚点行是本组成员才挂——首个 edit 被窗口收编出窗时
  // 其组不渲染，锚点行不在任何可见组成员内，徽标自然不出现（无假呈现）。
  const miles: RunGroupMile[] =
    firstEditIndex !== null && members.some((m) => m.flatIndex === firstEditIndex) ? ['firstEdit'] : []
  return {
    kind: 'run-group',
    base,
    members,
    header: { count: members.length, durationMs, failedCount },
    hasRunning,
    headFlatIndex: runHeadIndex(members[0], base, flatBlocks, positionByFlatIndex),
    miles,
  }
}

/**
 * run 组块类型检查：TraceRenderUnit 收窄用。FlatBlock 无 kind 字段（非判别属性齐全的联合），
 * `unit.kind` 直访在 TS 下非法，必须经 'kind' in 判定（ui Turn.vue 与测试共用本检查）。
 */
export function isRunGroupBlock(unit: TraceRenderUnit): unit is RunGroupBlock {
  return 'kind' in unit && unit.kind === 'run-group'
}

/**
 * run 类型分组（demo chat spec §3 的切分算法，本函数不修改任何入参、不碰既有三函数契约）。
 *
 * 输入是可见派生序列（Turn.vue visibleBlocks 三分支汇合后的 FlatBlock[]）+ 同源同拍的 flatBlocks
 * （段首回查用）。规则：
 * - 逐块查表：命中类型表 → 与当前组同类型则并入、切型则收拢旧组开新组；
 *   未命中（自定义工具 / 子智能体 / workflow）+ 非工具块（thinking / text）→ 先收拢当前组再
 *   原样成行，并打断分组。
 * - 组资格只看工具类型、不看状态：running 与已完成一视同仁（running 不入「独立行」，其进度由
 *   组头的 hasRunning 执行态承载）。
 * - 组数 = 类型切换次数，与步数解耦；单成员组照出（demo 同口径：一个 read 也成「探索 1 步」，
 *   回看历史时组头就是该段的标题）。
 * - 组成员不在可见序列时（工作 turn 的 W 窗口把 error 成员剔出可见、前后两段按假邻接合并）：
 *   合并后的组只统计可见成员，被剔除的 error 由窗口切片结果的 failedCount 报告（TraceWindowResult.failedCount，不在 visible 内的失败块数）。
 * - 里程碑徽标（§3.6）：结构信号在 flatBlocks 全序列一次预计算后聚合上组头——锚点行不在可见
 *   组成员内（被窗口收编）则徽标不出现，窗口化不产生假呈现。
 * - 组块排序位置 = members[0] 在输入序列中的位置；输出保持输入序列原序。空输入 → 返回 []。
 */
export function groupToolRuns(visible: FlatBlock[], flatBlocks: FlatBlock[]): TraceRenderUnit[] {
  const units: TraceRenderUnit[] = []
  // 段首回查用的位置表：一次构建 O(n)，组数 × 线性查找的二次复杂度不再出现。
  const positionByFlatIndex = new Map<number, number>()
  for (let i = 0; i < flatBlocks.length; i++) positionByFlatIndex.set(flatBlocks[i].flatIndex, i)
  // 首个改动锚点：全序列一次预计算（O(n)），组构建时 O(1) 判定。
  const firstEditIndex = firstEditFlatIndex(flatBlocks)

  let members: FlatBlock[] = []
  let base: RunGroupBase | null = null

  const flush = (): void => {
    if (base === null) return
    units.push(buildRunGroup(base, members, flatBlocks, positionByFlatIndex, firstEditIndex))
    members = []
    base = null
  }

  for (const fb of visible) {
    const next = runBaseOf(fb)
    if (next === null) {
      flush()
      units.push(fb)
      continue
    }
    if (base !== null && base !== next) flush()
    base = next
    members.push(fb)
  }
  flush()
  return units
}

export function computeTraceWindow(
  blocks: FlatBlock[],
  opts: { windowSize: number; takeover: boolean },
): TraceWindowResult {
  if (blocks.length === 0) {
    return { visible: [], compactedCount: 0, failedCount: 0 }
  }

  // takeover=true：全量展开，计数归零（收编区为空）。
  if (opts.takeover) {
    return { visible: [...blocks], compactedCount: 0, failedCount: 0 }
  }

  const lastText = findLastText(blocks)
  const lastInProgress = findLastInProgress(blocks)
  const inProgressSet = new Set<number>(lastInProgress ? [lastInProgress.flatIndex] : [])
  const completedProcessPool = collectCompletedProcessPool(blocks, inProgressSet)

  // 按 flatIndex 降序取前 windowSize 个作为 visible 的③部分。
  const windowed = [...completedProcessPool]
    .sort((a, b) => b.flatIndex - a.flatIndex)
    .slice(0, opts.windowSize)

  const { visible, mergedIds } = mergeVisibleBlocks(lastText, lastInProgress, windowed)

  // compactedCount = ③候选池总数 − visible 内属于③的数量。
  const visibleInWindowed = windowed.filter((fb) => mergedIds.has(fb.flatIndex)).length
  const compactedCount = completedProcessPool.length - visibleInWindowed

  const failedCount = countFailedOutsideVisible(blocks, new Set(visible.map((fb) => fb.flatIndex)))

  return { visible, compactedCount, failedCount }
}

/* ══ 过程段切段（chat-flow-process-aggregate U1，设计 D8 / AX1 / AX4 / AX5 / AX7）══
 * 回合内拍平块序列按「两条正文块之间」切段，每段过程块（thinking / tool / agentgraph）收成一个
 * 聚合块（ProcessSegment）。与上方 computeTraceWindow / W / groupToolRuns 三符号零交集：旧窗口
 * 切片的消费路径随聚合块形态退役，符号去留按死代码纪律单独处置。类型族与契约条文在
 * ./process-segment（切段契约与切段实现双线并行的唯一对齐点），本文件只放实现。
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
 * 段内组分组：复用 groupToolRuns 的 RUN_GROUP_TOOLS 类型表口径（runBaseOf 同一判定源，不
 * 重新发明）；连续同 base 工具成组，被思考行 / 独立行打断即重新开组，单成员组照出。类型表外
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
 * O(n) 单 pass（同 groupToolRuns 量级）。
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
