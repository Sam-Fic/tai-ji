/**
 * 过程段（ProcessSegment）类型族——对话流「聚合块」的段契约（chat 域 SSOT）。
 *
 * 职责边界：本文件只承载类型族与契约条文（零运行时逻辑）；切段纯函数落在 trace-window.ts
 * （与 flattenTurnBlocks 同文件族），消费本文件的导出。
 * 类型族独立成文件的原因：切段契约与切段实现由两条并行工作线分别落地，同文件并行写互斥——
 * 契约先在此定死，实现侧与渲染侧（fixture 驱动开发）同以本文件为唯一对齐点。
 *
 * 派生分工：切段、组分组、计数口径在 core 纯函数一次算好，渲染层零解析——UI 只按本文件的
 * 字段接线（口径 core 单点、ui 消费结果）。成员资格、计数
 * 口径、段 id 派生规则的任何调整只改 core，不进渲染层。
 */
import type { FlatBlock, RunGroupBase } from './trace-window'

/**
 * 段内工具组：段内连续同类型工具块的归组结果。
 *
 * 组资格只看工具类型、不看状态（running 与已完成一视同仁，running 也入组），类型判定用
 * trace-window 的 RUN_GROUP_TOOLS 类型表（runBaseOf 同一判定源）——不另设第二判定源，两处口径
 * 漂移即计数对账失真。类型表外工具（自定义 / MCP / 扩展工具）与 agentgraph（子代理派发）块
 * 不入组、原样成行：组名是对 agent 行为的语义解读，场景一变解读就会错，纯类型映射的漏登记
 * 安全降级是「多显示一行」而不是「归错组」——成员资格零内容解析的原因。
 */
export interface ProcessToolGroup { // oe-exempt:20261106:framework:chat 域契约类型族——数据形状 SSOT（core 定口径 ui 消费），类型契约先行单实现常态，非策略接口
  /** 组类型（判定源 = RUN_GROUP_TOOLS 类型表）：渲染层据此取名与图标 */
  base: RunGroupBase
  /** 组成员：连续同 base 类型的工具块（与 ProcessSegment.members 共享同一批 FlatBlock 引用），flatIndex 升序 */
  members: FlatBlock[]
  /**
   * 组耗时口径 = 已完成成员耗时合计（endTime − startTime 之和；endTime 缺失的成员按 0 计，
   * 负值钳 0）。running 成员 endTime 必缺失，天然按 0 不计入。
   * （同一条 memberDurationMs 规则，不另立第二套时间口径。）
   */
  durationMs: number
  /** 组内失败计数 = 成员中 status==='error' 的数量（口径与段级 failedCount 一致，见 ProcessSegmentCounts） */
  failedCount: number
  /**
   * 组内是否含 status==='running' 成员（渲染信号，不是计数口径）：进行中聚合条「当前项高亮 +
   * 自动滚到最新」与流光动效的判定谓词。放接口顶层不进计数字段。
   */
  hasRunning: boolean
}

/**
 * 段级计数口径：完成态摘要行（分类步数 + 思考数 + 总耗时 + 失败标记）的唯一数据源；进行中
 * 聚合条与展开态组头复用同一口径——三处显示不同时在场，对账以口径同源为准（三处各算一套
 * 即数字打架，失败可见性契约要求三处恒等）。
 */
export interface ProcessSegmentCounts { // oe-exempt:20261106:framework:chat 域契约类型族——数据形状 SSOT（core 定口径 ui 消费），类型契约先行单实现常态，非策略接口
  /**
   * 分类步数：按类型表三类（探索 / 修改 / 执行命令）统计段内工具成员数（含 running）。
   * 类型表命中成员全部入组，故本值恒等于该类型各组成员合计；类型表外成员（独立成行的
   * 自定义工具 / agentgraph）不计入分类步数，但仍计入 totalDurationMs 与 failedCount——
   * 它们是段的正式成员，不计分类只免取名，不丢存在。无成员的类型为 0，渲染层按 0 省略该类。
   */
  categoryCounts: Record<RunGroupBase, number>
  /** 思考步数 = kind==='thinking' 的成员数 */
  thinkingCount: number
  /**
   * 总耗时 = 段内所有步骤耗时之和（含思考）。步骤耗时 = endTime − startTime，两端时间戳
   * 任一缺失按 0、负值钳 0：工具步骤读 ToolCall、思考步骤读 ThinkingBlock，两者时间戳均可选
   * 缺失（end_not_received / 历史会话无时间戳），按 0 计保证摘要行在数据不全时仍可用，
   * 与 memberDurationMs 既有口径一致。
   */
  totalDurationMs: number
  /**
   * 失败计数 = 段内已完成失败块数：kind ∈ {tool, agentgraph} 且 ref.status==='error' 的成员数。
   * 'error' 是 ToolCall 的终态（running 未定型、end_not_received 未确认，均不算失败）；
   * thinking 无失败形态。本字段是段内全量口径：失败块是段正式成员，不做任何可见性剔除。
   */
  failedCount: number
}

/**
 * 段内渲染单元：展开平铺序（真实发生顺序）的一维投影——思考行 / 独立工具行 / agentgraph 行
 * 为 member 单元，连续同类型工具组为 group 单元。两个变体引用的都是段数据里的既有对象
 * （block ∈ members、group ∈ groups），本类型只承载渲染序，不复制数据。
 */
export type ProcessSegmentUnit =
  | { kind: 'member'; block: FlatBlock }
  | { kind: 'group'; group: ProcessToolGroup }

/**
 * 过程段：两条正文块之间的全部过程块（thinking / tool / agentgraph）收成的聚合单元。
 *
 * 切段规则（边界条款）：
 * - text 块恒为段边界，永不入段（正文原生展示，不并入计数摘要）；段成员数 ≥ 1，空段不存在。
 * - 序列首端第一个 text 之前的过程块自成一段（起始边界 = 序列开始）；序列末端最后一条 text
 *   之后的过程块同属一段（结束边界 = 序列结束）——回合先调工具后写正文、以工具收尾都是常见
 *   形态，两种边界都不产生无主过程块。
 * - 相邻 text 之间无过程块时不产生段；输入空序列（无任何块）或纯 text 序列 → 无段。
 * - 切段只看拍平一维序（flatIndex），assistant 边界不是段边界：输入是 flattenTurnBlocks 的
 *   输出序列，跨 assistant 相邻的过程块同段。
 *
 * 三态判定（调用方合成，段数据不携带状态字段）：段完成 ⇔ followedByText=true ∨ 回合工作态
 * 落下（isWorkingTurn 翻 false，回合落下时回合内全部未完成段同时完成）；followedByText=false
 * 且回合进行中的段即进行中态。展开 / 收起是组件本地交互态（不落 store 不持久化），不属于段数据。
 *
 * 键消费义务（与段 id 契约配套）：聚合块 :key 用 id；v-memo 依赖必须覆盖段内全部可变信号
 * （成员 ref 逐个 + counts + followedByText），不得假设「只有末成员会变」——成员中途改状态
 * 是常态（失败可发生在非末位成员上）。
 */
export interface ProcessSegment { // oe-exempt:20261106:framework:chat 域契约类型族——数据形状 SSOT（core 定口径 ui 消费），类型契约先行单实现常态，非策略接口
  /**
   * 段 id（结构定位），形态 `seg:<段首块 flatIndex>`（十进制，如 seg:0、seg:17）。
   *
   * 稳定性规则（硬约束，实现不得偏离）：
   * - 派生源只有段首块在拍平序列中的位置——流式段生长（成员追加）不改段首位置，新段只出现
   *   在序列尾部，故既有段 id 在流式全程不变，新段出现才产生新 id；
   * - 禁止派生自消息 id：会话重载对账可能更换消息 id（回合级展开键曾派生自首条消息 id，
   *   重载换 id 即展开态孤儿的事故根因），段 id 与消息 id 解耦；
   * - 禁止派生自成员集合：成员追加即变，流式全程抖动；
   * - 禁止派生自组内序号：组数随类型切换增长即变；
   * - live 与 reload 走同一拍平序，id 复现（重载不换键）；
   * - 同 turn 内唯一；跨 turn 的键隔离由列表层级（:key 兄弟作用域）保证。
   *
   * 前缀 `seg:` 的原因：trace 区单元收敛为「正文块 + 聚合块」两型后同列表共存，正文块沿用
   * flatIndex 形态的键——非数字前缀使两型键空间不相交，同层键不撞。
   */
  id: string
  /**
   * 段内成员：thinking / tool / agentgraph 的 FlatBlock，按 flatIndex 升序（text 恒不入段）。
   * 双窗可见性纯派生的判定源：思考窗 = 存在 thinking 成员；聚合窗 = 存在 tool / agentgraph
   * 成员（「首个工具步骤开始」——agentgraph 结构上同是工具调用，独立成行但同样触发聚合窗）。
   */
  members: FlatBlock[]
  /**
   * 组分组结果：段内连续同类型工具块的归组（可为空数组——纯思考段 / 仅独立行成员时无组）。
   * 同 base 的多个组并存合法（被思考行 / 独立行打断即重新开组），组数与步数解耦；单成员组照出。
   */
  groups: ProcessToolGroup[]
  /**
   * 展开平铺序：段内单元按真实发生顺序的一维投影（成员原样成行 + 工具组交替），渲染层按序
   * 遍历、零拼接。与 members / groups 引用同一对象集合，渲染归属以本字段为准，禁止渲染层
   * 二次拼接——拼接规则漂移即「组内外成员重复 / 丢失」。
   */
  units: ProcessSegmentUnit[]
  /** 段级计数口径（完成态摘要行数据源；组头与聚合条复用同口径） */
  counts: ProcessSegmentCounts
  /**
   * 段后是否存在 text 块（段完成的结构信号）：true = 段已被后继 text 封闭（完成态）；false =
   * 段是序列末端的开放段，完成与否由调用方合成「回合工作态落下」信号后判定。这是切段纯函数
   * 的输入边界：回合工作态是块序列之外的调用方状态，纯函数只吃块序列，不感知回合生死。
   */
  followedByText: boolean
}
