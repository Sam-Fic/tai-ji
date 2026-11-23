/**
 * rail 节点摘要 per-turn memo（自 TurnRail.vue 模块级 WeakMap 上移为共享导出）。
 *
 * 背景：rail 模板每 render 对全部节点跑 summarize*（summarizeAssistantForRail →
 * stripMarkdown 15+ 次全文正则），WeakMap 按 turn 引用缓存——引用同 ⇒ 内容同
 * （ADR-0039 不可变替换 + core toRenderItemsIncremental 对签名未变的 turn 逐引用
 * 复用）⇒ 摘要同；内容变化必然走不可变替换产生新引用（miss 后重算一次）。
 * turn 对象被 GC 后 WeakMap 条目自动回收，无泄漏。
 *
 * 模块级单例的两个消费方：
 * - TurnRail.vue 渲染：railMemoFor 命中零重算（既有行为，原文迁出）。
 * - useMessageStreamRail 的 railTurns 派生视图恒等判定（streaming perf）：streaming 末位
 *   turn 每帧新引用 → 命中判定需比对「rail 可见派生视图签名」（memo 四字段）而非 turn
 *   引用——与渲染消费同一 memo，每帧对末位 turn 至多算一次签名，且命中帧 TurnRail
 *   因 props 引用不变整体跳过重渲（零 vnode diff）。判定与渲染同源，签名漂移不可能。
 *
 * 无实例/props/session 维度（同 turn 引用 ⇒ 同派生值，跨 TurnRail/MessageStream 实例
 * 共享同一缓存条目安全——原 TurnRail.vue memo 注释同款论证）。
 */
import type { MessageTurn } from '@taiji/core/domain/chat'
import { hasFailedTool } from '@taiji/core/domain/chat'
import { summarizeTurnForRail, summarizeAssistantForRailWithSource, streamingRailAnchor, isRailSummarySettled, RAIL_FREEZE_K } from '@taiji/core/domain/chat'

/** memo 条目的纯数据形状（非待实现契约——无 implements/extends 变体，用 type 别名；导出 =
 * railMemoFor 返回类型可命名，消费方 useMessageStreamRail 做派生视图签名比对时字段有权威源） */
export type RailTurnMemo = {
  /** user 行摘要（summarizeTurnForRail，无 user turn 为空串——模板 `|| ' '` 兜底不变） */
  userSummary: string
  /** agent 行摘要（summarizeAssistantForRail，空串时模板经占位门判定「进行中…」或空格 fallback——判据不在 memo 内） */
  agentSummary: string
  /** hasFailedTool 结果（agent 行文本 hover 升色依据） */
  failed: boolean
  /** agent 行 Bot 图标着色 class（agentIconClass 产出，与 failed 同帧同源） */
  iconClass: string
}

// @data-owner #58 —— chat 对话流渲染派生 memo ①（rail 节点摘要，纯派生可丢弃重建）
const railMemo = new WeakMap<MessageTurn, RailTurnMemo>()

/**
 * 流式冻结槽（B1 派生归零）：streaming turn 每 delta 新引用 ⇒ WeakMap 必 miss ⇒ 旧行为
 * 每 delta 对全文跑 19 条 regex。append-only 语义下首个 assistant 文本达到
 * RAIL_FREEZE_K 后前 K 字符不再变化 ⇒ 摘要可跨 delta 复用。
 * 守卫（四重，全部满足才复用）：
 *  ① 同 message id（anchor.id === sourceId——摘要确实由该 message 产出，防纯空白首块把
 *     别块摘要/过期 fallback 错绑过来）；
 *  ② 同前缀指纹（FREEZE_PREFIX 长度，防御 id 复用/内容被换的极端形态）；
 *  ③ 长度 ≥ K（原始文本前 K 字符已定形）；
 *  ④ 摘要已触顶（isRailSummarySettled——带省略号后缀说明纯文本前 20 码点已超出显示预算，
 *     未触顶的空/短摘要其前 20 码点仍可能被后续 delta 改变，冻结它会把「尚未成形」的值钉住）。
 * 单槽模块级（随 WeakMap 条目一同自然轮换，无泄漏面）。切 session 的显式 reset 入口 =
 * resetRailFreezeSlot()（useMessageStreamRail 在 sessionId 变化时调用）——守卫①②已使跨
 * session 错用在结构上不可能（message id 全局唯一），reset 是让不变量可局部检验的显式化。
 *
 * 已知代价（登记于 docs/fact-check.md R1 / tp-design.md G5）：守卫①②③④保证的是「摘要的前
 * 20 码点由前 K 原始字符决定」这一**充分条件**，不是必要条件。跨 K 才闭合的 markdown 构造
 * （`**…**` / `[a](b)` 的闭合符落在 K 之外）仍可能让冻结值残留标记，直到流结束才自愈——
 * 旧实现下一 delta 即更新，故这是本批引入的新鲜度回退，触发条件确定（非偶发）：消息以跨 K
 * 未闭合的强调/链接开头。收窄它需要在 delta 粒度上验「闭合后摘要是否已变」（O(K)/delta），\ * 代价大于收益，本批不做。
 */
let frozenAgent: { id: string; prefix: string; agentSummary: string } | null = null

/** 显式重置冻结槽（切 session 入口调用）。幂等；无槽时零操作。 */
export function resetRailFreezeSlot(): void {
  frozenAgent = null
}

/** agent 行 Bot 图标的着色 class（仅非 active 态消费；active 态走 loader-spin 不读本字段）：
 * failed（hasFailedTool）→ text-danger（§5.6B 常驻红），其余 → text-neutral-ico。 */
function agentIconClass(turn: MessageTurn): string {
  if (hasFailedTool(turn)) return 'text-danger'
  return 'text-neutral-ico'
}

/** 取 turn 的 rail 摘要 memo（首见计算并缓存，命中零重算）。模板每 render 调用。
 *  streaming turn 每 delta 新引用（WeakMap 必 miss）：达到冻结条件时 agentSummary 跨 delta
 *  复用（userSummary/failed/iconClass 仍按 turn 现算——O(工具数)，不随文本长度涨）。 */
export function railMemoFor(turn: MessageTurn): RailTurnMemo {
  let memo = railMemo.get(turn)
  if (memo === undefined) {
    // 锚点只算一次（miss 路径上旧实现算两次：复用判定一次 + 记录一次）。
    // streaming 态外不算——anchor 为 null 时两个消费点都短路，省掉 O(块数 + K)。
    const anchor = turn.isStreaming ? streamingRailAnchor(turn) : null
    const lengthReady = anchor !== null && anchor.length >= RAIL_FREEZE_K
    let agentSummary: string | null = null
    let sourceId: string | null = null
    if (lengthReady && frozenAgent && frozenAgent.id === anchor.id && frozenAgent.prefix === anchor.prefix) {
      agentSummary = frozenAgent.agentSummary // 冻结复用：前 K 字符不再变 ⇒ 摘要稳定
      sourceId = frozenAgent.id
    }
    if (agentSummary === null) {
      const summarized = summarizeAssistantForRailWithSource(turn)
      agentSummary = summarized.text
      sourceId = summarized.sourceId
      // 记录冻结槽：长度够 + 摘要确由该锚点 message 产出 + 摘要已触顶（前 20 码点已定形）
      if (lengthReady && sourceId !== null && anchor.id === sourceId && isRailSummarySettled(agentSummary)) {
        frozenAgent = { id: sourceId, prefix: anchor.prefix, agentSummary }
      }
    }
    memo = {
      userSummary: summarizeTurnForRail(turn),
      agentSummary,
      failed: hasFailedTool(turn),
      iconClass: agentIconClass(turn),
    }
    railMemo.set(turn, memo)
  }
  return memo
}
