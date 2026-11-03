/**
 * message.complete 终态段的共享写点 + streaming 气泡收尾实现（registry.ts 拆出——
 * max-lines 红线与按职责聚合的平衡点：本文件持有 complete 终态相关的消息流写点，
 * registry.ts 只留 handler 分发编排）。
 *
 * 内容三组：
 *  1. 自然终态标记（complete{stop|error} 置位 / message_start / message_end 复位 /
 *     dispose 清理 / 测试复位）——complete{aborted} 提示行竞态守卫的判定源；
 *  2. appendFallbackErrorBubble / appendTurnNoticeLine——秒败兜底与提示行的单点写入口；
 *  3. finalizeCompleteStreamingBubbles——message.complete 的 streaming 气泡终态段
 *     （收尾全部 streaming 气泡 + 秒败兜底 + 停止/截断提示行）。
 *
 * 生命周期（自然终态标记）：complete{stop|error} 处理时置位；message_start /
 * message_end 新回合帧到达时复位；store.disposeSession 同点清理（与 executingBash
 * 同编排清理范式）。重连/重订阅回放经同一 handler 链按序重放，标记状态随帧序重建
 * （无陈旧复用）。
 */
import type { Message } from '@taiji/shared'
import type { MessageEffectContext } from '../effect-types'
import { readString } from '../readers'
import { findLastAssistantIndex } from '../chunk-processor'
import { commitMessages, REASON_FALLBACK_ERROR_TEXT, terminalMessagePatch } from '../mutations'
import { chatNoticeText, TRUNCATED_STOP_REASONS, type ChatNoticeKey } from './notice-text'
import { randomUuid } from '../../../utils/random-uuid'

// ── 自然终态标记（回合级「已见非 abort 终态」事实） ──────────────────────────

// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构）：回合终态竞态标记（纯 effect
// 内部判定簿记，非任何数据源的缓存派生视图——事实来源是 complete/message_start 帧本身）
const naturalTurnEndSeenSessions = new Set<string>()

/** complete{stop|error} 处理时置位（见文件头生命周期注释）。 */
export function markNaturalTurnEnd(sid: string): void {
  naturalTurnEndSeenSessions.add(sid)
}

/** message_start / message_end 新回合帧到达时复位。 */
export function resetNaturalTurnEnd(sid: string): void {
  naturalTurnEndSeenSessions.delete(sid)
}

/** 本回合已见非 abort 回合终态（complete{aborted} 提示行分支的竞态守卫读口）。 */
export function hasNaturalTurnEnd(sid: string): boolean {
  return naturalTurnEndSeenSessions.has(sid)
}

/** session 级清除（store.disposeSession cleanup 编排同点调用，与 clearExecutingBash 同范式）。 */
export function clearNaturalTurnEndSeen(sessionId: string): void {
  naturalTurnEndSeenSessions.delete(sessionId)
}

/** 测试复位（vitest 隔离；生产路径不调，notice-text resetChatNoticeTextForTest 同款先例）。 */
export function resetNaturalTurnEndSeenForTest(): void {
  naturalTurnEndSeenSessions.clear()
}

// ── 秒败兜底气泡与提示行写点 ────────────────────────────────────────────────

/**
 * 无前置 streaming entity 的 error 兜底气泡（complete 秒败分支 / error /
 * stream_error 共用——开始/结束时刻取同一读数，秒级展示口径下一致）。原 3 处同款
 * 对象字面量收敛于此。store.ts markSessionError 第 4 处同款字面量不在本收敛批
 * （store.ts 非本批领地，登记）。
 */
export function appendFallbackErrorBubble(
  messages: MessageEffectContext['messages'],
  sid: string,
  prev: Message[],
  errorText: string,
): void {
  const errNow = Date.now()
  commitMessages(messages, sid, [
    ...prev,
    { id: `a-${randomUuid()}`, role: 'assistant', content: '', error: errorText, status: 'error', timestamp: errNow, endedAt: errNow },
  ])
}

/**
 * liveOnly 提示行（停止/截断，id `s-<uuid>`，分组归 turn 内 notice 不切断回合——W3
 * 消费；pi 无对应 entry、重开即消失——live ≠ reload 差异与 stream_warn 同型，W2 已
 * 裁决豁免等价性断言）。幂等：末位消息已是 liveOnly 行且携带同一文案时跳过——
 * complete{aborted} 双通道到达（缺陷 9：runtime 必达广播 + pi 自发翻译帧，消费方
 * 幂等契约）防重复追加两行。
 */
export function appendTurnNoticeLine(
  messages: MessageEffectContext['messages'],
  sid: string,
  key: ChatNoticeKey,
): void {
  const prev = messages.value.get(sid)?.value ?? []
  const last = prev[prev.length - 1]
  if (last?.role === 'system' && last.liveOnly === true && last.content === chatNoticeText(key)) return
  commitMessages(messages, sid, [
    ...prev,
    { id: `s-${randomUuid()}`, role: 'system', content: chatNoticeText(key), status: 'complete', timestamp: Date.now(), liveOnly: true },
  ])
}

// ── streaming 气泡终态段（message.complete 拆出） ───────────────────────────

/**
 * message.complete 的 streaming 气泡终态段（复杂度拆出——handler 只留编排）：
 * 收尾所有 status==='streaming' 的 assistant 气泡（一个 turn 可产生多个 assistant
 * 气泡——工具调用气泡 + 文字总结气泡：只转最后一条会让前面的 toolCall 气泡永远
 * streaming，状态机不一致）+ 秒败兜底 + 停止/截断提示行。
 */
export function finalizeCompleteStreamingBubbles(
  ctx: MessageEffectContext,
  sid: string,
  payload: Record<string, unknown>,
  prev: Message[],
  opts: {
    reason: string
    isErrorStop: boolean
    errorMessage: string | undefined
    finalContent: string | undefined
  },
): void {
  const { messages } = ctx
  const { reason, isErrorStop, errorMessage, finalContent } = opts
  const lastAssistantIdx = findLastAssistantIndex(prev)
  let changed = false
  const next = prev.map((m, i) => {
    if (m.role !== 'assistant' || m.status !== 'streaming') return m
    changed = true
    // 终态字段 patch 单源（S4-A6）：status/error/content 只作用于末位 assistant。
    // [chat-flow-consistency D3 规则 5] usage/endedAt 不再经本 patch 回填——定稿重建
    //（message_end assistant 分支）按逐条载荷唯一承担，回合级覆写会使 turn 聚合双计。
    return terminalMessagePatch(m, i, { lastAssistantIdx, isErrorStop, errorMessage, finalContent })
  })
  if (changed) commitMessages(messages, sid, next)
  // 秒败 turn（message_start 丢失/未广播）无 streaming 气泡可收尾：错误信息必须以纯 error
  // 气泡落进聊天流，否则 complete 事件被消费后错误只剩 stopReason 标志，用户不可见。
  // errorMessage 缺失（pi extras.errorMessage 可 undefined）走 error reason 兜底文案——
  // 条件只看 isErrorStop，文案用 errorMessage || 兜底，错误不得静默。
  if (isErrorStop && !changed) {
    // [M2 形态统一] 错误文本只住 error 字段，content 空（无崩溃前正文）
    appendFallbackErrorBubble(messages, sid, prev, errorMessage || REASON_FALLBACK_ERROR_TEXT.error)
  }
  // [chat-flow-consistency 缺陷 3] dispatching 窗口点停止：complete{aborted} 无实体可收尾
  // （changed=false，用户消息可能已入 pi transcript 但无任何 streaming 实体）→ 追加 liveOnly
  // 停止提示行（「已停止：回复尚未开始」），消除「乐观气泡孤挂、无回复无说明」的静默形态。
  // 幂等防双通道重复（缺陷 9：runtime 必达广播 + pi 自发翻译帧，末位已是本提示则跳过）。
  // [fix-chat-flow-stuck C-3] 竞态守卫：本回合已见非 abort 终态（complete{stop/error} 先到，
  // 回复已完整生成/已错误收尾）→ 迟到的 aborted 帧不追加提示行（提示与事实相反）。
  if (reason === 'aborted' && !changed && !hasNaturalTurnEnd(sid)) {
    appendTurnNoticeLine(messages, sid, 'stoppedBeforeStart')
  }
  // [chat-flow-consistency 缺陷 7] 终态截断提示：max_tokens（输出半截）/content_filter
  // （内容被安全过滤拒绝）按正常完成收尾但实为异常截断——追加 liveOnly 截断提示行
  // （白名单不含 end_turn/tool_use，零行为变化）。apply-entry 重放链不消费 stopReason
  // 字段，entry 化升级随跨单元裁决另行处理（本期维持 liveOnly 最简档）。
  const finalStopReason = readString(payload, 'stopReason')
  if (finalStopReason !== undefined && TRUNCATED_STOP_REASONS.has(finalStopReason)) {
    appendTurnNoticeLine(messages, sid, finalStopReason === 'max_tokens' ? 'truncatedMaxTokens' : 'truncatedContentFilter')
  }
}
