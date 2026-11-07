// apply-entry-error-replay.test.ts —— 重放链错误 assistant 消息呈现错误文本（agg-error-presentation
// 重放态缺口修复的回归锁）。
//
// 被测缺口（真机实跑观察）：会话切换后再切回，session.history 重放链对失败回合落盘条目
// （pi agent.js handleRunFailure 构造的 failureMessage：stopReason='error' + errorMessage
// 原文、content 空串）不消费 stopReason/errorMessage——产物是 status:'complete' + 空正文
// + 无 error 的哑气泡，TextRow 的 error 独立行判据（status==='error' && !!error）不命中，
// 用户重开会话看不到错误文本。
//
// 修复后不变量（本文件锁定）：
// 1. stopReason='error' 条目 → status:'error' + error 非空（M2 追加形态不变量），文本经
//    formatTurnErrorPresentation 单点映射——与 live 链 event-adapter 出口同一实现，
//    live 与重放对同一落盘原文产出逐字相同文本；
// 2. errorMessage 缺失/空串 → 兜底 ASSISTANT_ERROR_FALLBACK_TEXT（错误不得静默）；
// 3. 'aborted' 与正常 stopReason 不产错误呈现（与 live 链 terminalMessagePatch 口径一致）；
// 4. 三条 fold 路径（applyEntry 单条 / replayEntries fold / buffer feed）产物同构——
//    「live ≡ reload」对错误条目构造性保持。

import { describe, it, expect } from 'vitest'
import { applyEntry, createChatViewStateBuffer, createInitialChatViewState, replayEntries } from '../apply-entry'
import { msgEntry } from './helpers/fixtures'
import { ASSISTANT_ERROR_FALLBACK_TEXT, formatTurnErrorPresentation, type Message } from '@taiji/shared'
import type { PiEntry } from '../apply-entry'

// 真机捕获的 pi 凭据缺失原文（agg-error-presentation 剧本 V4 逐字形态；形态二判定词表
// PI_VIRTUAL_ROUTE_NO_CREDENTIALS_PATTERN 的实装来源 = pi model-runtime.js resolveModel）
const VIRTUAL_ROUTE_RAW =
  'Virtual model aggregation/agg-err-route routed to mockllm/ep-cred-a, which has no credentials.'
// 形态一实装原文（pi agent-session checkAuth 变体）
const NO_API_KEY_RAW = 'No API key for mockllm/mock-1'
// 厂商失败原文（无统一形态、映射词表外——原样透传形态的载体）
const PROVIDER_401_RAW = 'Request failed with status 401'

/** pi 失败回合落盘条目形态（failureMessage：content 为空 text 块 + errorMessage 原文）。 */
function failureEntry(errorMessage: unknown, stopReason = 'error'): PiEntry {
  return msgEntry('e-fail', {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    api: 'openai-completions',
    provider: 'aggregation',
    model: 'agg-err-route',
    usage: { input: 0, output: 0 },
    stopReason,
    errorMessage,
    timestamp: 1000,
  })
}

/** 单条失败条目 replayEntries 重放的产物消息（重放链 = fold 到单条）。 */
function replaySingle(entry: PiEntry): Message | undefined {
  return replayEntries([entry]).messages[0]
}

describe('apply-entry 错误重放派生（重放链错误文本呈现）', () => {
  it('虚拟路由凭据缺失条目：status=error + 结构化映射文案（TextRow error 行判据命中源）', () => {
    const m = replaySingle(failureEntry(VIRTUAL_ROUTE_RAW))
    // 用户可见形态断言：status:'error' 且 error 非空 = TextRow isAppendError（block-text-error
    // 独立 danger 行）的完整驱动条件；content 空 = 纯 error 气泡（崩溃前无正文）
    expect(m?.status).toBe('error')
    expect(m?.error).toBe(
      '模型调用失败：mockllm/ep-cred-a 的凭据缺失或已失效，请到设置页 Provider 分区更新该渠道的 API Key',
    )
    expect(m?.content).toBe('')
  })

  it('No API key 形态条目：同一映射单点产出结构化文案（live 出口同函数）', () => {
    const m = replaySingle(failureEntry(NO_API_KEY_RAW))
    expect(m?.status).toBe('error')
    expect(m?.error).toBe(formatTurnErrorPresentation(NO_API_KEY_RAW))
  })

  it('词表外错误原文：原样透传（与 live 链 event-adapter 出口口径一致，不建死分支）', () => {
    const m = replaySingle(failureEntry(PROVIDER_401_RAW))
    expect(m?.status).toBe('error')
    expect(m?.error).toBe(PROVIDER_401_RAW)
  })

  it('errorMessage 缺失/空串：兜底文案保底非空（M2 不变量：status=error 则 error 必非空）', () => {
    const missing = replaySingle(failureEntry(undefined))
    expect(missing?.status).toBe('error')
    expect(missing?.error).toBe(ASSISTANT_ERROR_FALLBACK_TEXT)
    expect(missing?.error?.length).toBeGreaterThan(0)
    const empty = replaySingle(failureEntry(''))
    expect(empty?.error).toBe(ASSISTANT_ERROR_FALLBACK_TEXT)
  })

  it('aborted 条目按正常完成派生（live 链 terminalMessagePatch isErrorStop 同口径：中止不产错误行）', () => {
    const m = replaySingle(failureEntry('user aborted', 'aborted'))
    expect(m?.status).toBe('complete')
    expect(m?.error).toBeUndefined()
  })

  it('正常 assistant 条目零行为变化：status=complete、无 error 字段', () => {
    const m = replaySingle(failureEntry(undefined, 'stop'))
    expect(m?.status).toBe('complete')
    expect(m?.error).toBeUndefined()
  })

  it('user 条目不受 stopReason 字段影响（字段只存在于 assistant 落盘形态）', () => {
    const entry = msgEntry('e-user', { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 900 })
    const m = replayEntries([entry]).messages[0]
    expect(m?.role).toBe('user')
    expect(m?.status).toBe('complete')
    expect(m?.error).toBeUndefined()
  })

  it('三条 fold 路径产物同构：applyEntry 单条 ≡ replayEntries fold ≡ buffer feed（live ≡ reload 构造性）', () => {
    const entries = [failureEntry(VIRTUAL_ROUTE_RAW)]
    const viaApply = entries.reduce(applyEntry, createInitialChatViewState())
    const viaFold = replayEntries(entries)
    const viaBuffer = createChatViewStateBuffer()
    for (const e of entries) viaBuffer.feed(e)
    expect(viaApply.messages).toEqual(viaFold.messages)
    expect(viaApply.messages).toEqual(viaBuffer.state.messages)
    expect(viaFold.messages[0]?.error).toBe(formatTurnErrorPresentation(VIRTUAL_ROUTE_RAW))
  })
})
