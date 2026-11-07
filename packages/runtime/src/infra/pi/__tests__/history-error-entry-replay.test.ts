// history-error-entry-replay.test.ts —— session.history 重放链全链回归：JSONL 失败回合
// 条目（stopReason='error' + errorMessage 原文）经 liftHistoryToEntries（wire 透传）+
// convertPiHistory（core reducer fold）产出带映射错误文本的 Message。
//
// 缺口背景（agg-error-presentation 真机实跑）：用户切走会话再切回，对话流错误行
// （block-text-error）不出现或为空——重放链此前不消费落盘的 stopReason/errorMessage，
// 失败回合在重放态是哑气泡。本文件锁 wire 层字段透传不被裁剪（`message: rec` 整体
// 透传是重放链拿到 errorMessage 的前提）+ 端到端产物形态。

import { describe, it, expect } from 'vitest'
import { convertPiHistory } from '../message-converter.js'
import { formatTurnErrorPresentation } from '@taiji/shared'

// 真机捕获的 pi 凭据缺失原文（agg-error-presentation 剧本 V4 逐字形态）
const VIRTUAL_ROUTE_RAW =
  'Virtual model aggregation/agg-err-route routed to mockllm/ep-cred-a, which has no credentials.'

/** pi session JSONL 失败回合 assistant 条目的 message 体形态（agent.js handleRunFailure 产物）。 */
function failureMessageRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    api: 'openai-completions',
    provider: 'aggregation',
    model: 'agg-err-route',
    usage: { input: 0, output: 0 },
    stopReason: 'error',
    errorMessage: VIRTUAL_ROUTE_RAW,
    timestamp: 1762000000000,
    ...overrides,
  }
}

describe('convertPiHistory 失败回合条目重放', () => {
  it('stopReason=error 条目产出 status=error + 映射错误文本（live 与重放同文本）', () => {
    const messages = convertPiHistory([failureMessageRecord()])
    expect(messages).toHaveLength(1)
    const m = messages[0]
    expect(m?.role).toBe('assistant')
    expect(m?.status).toBe('error')
    // TextRow error 独立行（block-text-error）的驱动字段：非空结构化文案
    expect(m?.error).toBe(formatTurnErrorPresentation(VIRTUAL_ROUTE_RAW))
    expect(m?.error).toContain('凭据缺失或已失效')
  })

  it('正常 assistant 条目（stopReason=stop）保持 complete、无 error 字段', () => {
    const messages = convertPiHistory([failureMessageRecord({ stopReason: 'stop', errorMessage: undefined })])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.status).toBe('complete')
    expect(messages[0]?.error).toBeUndefined()
  })

  it('user/assistant 混合序列：失败条目不影响相邻消息派生', () => {
    const user = { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1762000000000 }
    const messages = convertPiHistory([user, failureMessageRecord()])
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.status).toBe('complete')
    expect(messages[1]?.status).toBe('error')
    expect(messages[1]?.error).toBe(formatTurnErrorPresentation(VIRTUAL_ROUTE_RAW))
  })
})
