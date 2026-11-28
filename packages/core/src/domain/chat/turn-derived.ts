/**
 * turn 标量派生纯函数（chat 域）：回合成员 → 标量信号的唯一判定点。
 *
 * - isStreaming 期望值（MessageTurn 派生字段）：turnFromGroup 构造 / reuseOrRebuildTurn
 *   复用校正 / redriveLastTurnStreaming 快路径重驱动三处共用同一判定，不另设第二套口径
 * - hasFoldable（MessageTurn 派生字段）：chevron 渲染门
 * - countThinking / countToolCalls / hasFailedTool：折叠条 badge 与 trace 失败红框判定
 *
 * 纯函数（零 Vue/renderer 依赖）；消费方经 message-turns 原位 re-export（import 路径零改动）。
 */
import type { Message } from '@taiji/shared'
// 与 message-turns 仅类型相贯（type import 编译期擦除，无运行时环）
import type { MessageTurn } from './message-turns'
// 正文块计数与 trace 区渲染单元同口径（expandAssistantBlocks 产出），不另设第二套 text 块判定
import { expandAssistantBlocks } from './assistant-blocks'

/**
 * turn 派生字段：isStreaming（「回合内末位 assistant 是否 streaming」）。
 * [chat-flow-consistency D2] 不再以末位回合短路：插话回流开出新回合后，旧回合的 assistant
 * 仍 streaming（到回合级 message.complete 才收尾）→ 保持 true，双工作态并存是期望形态。
 * forceWorking 仍只作用于末位回合（虚拟会话历史回合无 streaming assistant 天然 false）。
 */
export function computeIsStreaming(
  assistants: Message[],
  isLastTurn: boolean,
  forceWorking: boolean,
): boolean {
  if (isLastTurn && forceWorking) return true
  const last = assistants[assistants.length - 1]
  return last?.status === 'streaming'
}

/**
 * turn 正文块数是否 > 1（chat-turn-fold-redesign §1 展开入口保证）：折叠态只保留末位一条
 * 正文，多正文 turn 缺展开入口 = 中间正文折叠后不可达。计数口径 = expandAssistantBlocks
 * 产出的 text 块（与 trace 区渲染单元同源，ADR-0122 error 宿主块同计）。提前退出：纯
 * text turn 无过程块时本函数是 computeHasFoldable 唯一要跑的判据，多数 turn 数到 2 即返。
 */
function hasMultipleTextBlocks(assistants: Message[]): boolean {
  let count = 0
  for (const m of assistants) {
    for (const b of expandAssistantBlocks(m)) {
      if (b.kind === 'text') {
        count += 1
        if (count > 1) return true
      }
    }
  }
  return false
}

/**
 * turn 派生字段：是否有展开入口（chevron 渲染门）。三判据任一命中：
 * - 含 thinking/toolCalls 块（折叠态过程段收进聚合块，展开才见）
 * - 正文块数 > 1（折叠态中间正文收起，展开才见——多正文纯 text turn 的唯一入口）
 * - 被收纳完成通知（折叠标签 / 明细行同受展开门控），计入口径与块同权。
 */
export function computeHasFoldable(assistants: Message[], foldedNotices?: Message[]): boolean {
  return (
    assistants.some(
      (m) => (m.thinking?.length ?? 0) > 0 || (m.toolCalls?.length ?? 0) > 0,
    ) ||
    hasMultipleTextBlocks(assistants) ||
    (foldedNotices?.length ?? 0) > 0
  )
}

/** 统计 turn 内 thinking 块数（折叠条 badge） */
export function countThinking(turn: MessageTurn): number {
  return turn.assistants.reduce((sum, m) => sum + (m.thinking?.length ?? 0), 0)
}

/** 统计 turn 内 toolCall 块数（折叠条 badge） */
export function countToolCalls(turn: MessageTurn): number {
  return turn.assistants.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0)
}

/** turn 是否含失败的 tool（影响 trace 渲染：失败 tool 整块红框） */
export function hasFailedTool(turn: MessageTurn): boolean {
  return turn.assistants.some((m) =>
    m.toolCalls?.some((t) => t.status === 'error'),
  )
}
