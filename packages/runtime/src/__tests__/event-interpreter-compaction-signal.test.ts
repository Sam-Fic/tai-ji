/**
 * C1 分界行实时化（feat-compaction-closure）：smart-context 后台压缩落盘信号的分诊与合成帧。
 *
 * 链路：扩展 persistBackgroundCompaction 成功 → sendMessage（customType smart-context +
 * details.source compaction-entry-appended，display:false）→ pi emit message_start →
 * event-adapter 翻译 message.customStart → interpreter 分诊（本文件覆盖段）→ getPiEntries
 * 取 compaction entry → 合成 message.compactionSummary 帧（字段口径与 compaction_end 通路
 * CompactionNotifier.onCompactionEnd 成功分支一致）。
 *
 * 覆盖：命中合成 / id 未命中尾部兜底 / 非目标 customType 与 source 不触发 / entry 缺失与
 * 拉取失败降级（不发帧、不抛、warn 留痕）/ pickCompactionEntryForSignal 纯函数选择序。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/event-interpreter-compaction-signal.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import type { PiTranslatedEvent } from '../services/session/types.js'
import { EventInterpreter } from '../services/session/event-interpreter.js'
import { COMPACTION_ENTRY_APPENDED_SOURCE, SMART_CONTEXT_NOTICE_CUSTOM_TYPE } from '@zhushanwen/extension-protocol'
import { pickCompactionEntryForSignal } from '../services/session/event-interpreter-compaction.js'

const SID = 'sid-c1'

function makeInterpreter(overrides: {
  send?: (m: ServerMessage) => void
  getPiEntries?: () => Promise<readonly unknown[] | undefined>
} = {}) {
  const sent: ServerMessage[] = []
  const send = overrides.send ?? ((m: ServerMessage) => { sent.push(m) })
  const getPiEntries = overrides.getPiEntries
  const interp = new EventInterpreter(SID, { send, getPiEntries })
  return { interp, sent, getPiEntries }
}

/** 构造 customStart message 事件（落盘信号载体，形态与 event-adapter 翻译产物一致）。 */
function customStart(customType: string, details: Record<string, unknown> | undefined): PiTranslatedEvent {
  return {
    kind: 'message',
    message: {
      type: 'message.customStart',
      payload: { sessionId: SID, customType, details },
    } as ServerMessage,
  }
}

function signalDetails(compactionId?: string): Record<string, unknown> {
  return { source: COMPACTION_ENTRY_APPENDED_SOURCE, ...(compactionId !== undefined ? { compactionId } : {}) }
}

function compactionEntry(id: string, summary: string, tokensBefore: number) {
  return { type: 'compaction', id, parentId: null, timestamp: new Date(0).toISOString(), summary, tokensBefore, firstKeptEntryId: 'e1' }
}

function messageEntry(id: string) {
  return { type: 'message', id, parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'user', content: 'hi', timestamp: 0 } }
}

/** flush 信号链的异步收尾（emit 是 fire-and-forget，内部仅一次 await）。 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('C1 落盘信号分诊 → 合成 message.compactionSummary 帧', () => {
  it('命中（customType + source + compactionId）→ 按该 entry 合成帧，customStart 帧照发前端', async () => {
    const entries = [messageEntry('m1'), compactionEntry('c-old', '旧摘要', 1000), compactionEntry('c-new', '本次摘要', 9000)]
    const { interp, sent } = makeInterpreter({ getPiEntries: async () => entries })

    const events = [customStart(SMART_CONTEXT_NOTICE_CUSTOM_TYPE, signalDetails('c-new'))]
    interp.interpret(events)
    await flushAsync()

    // customStart 帧照常转发（core 侧 display:false 透明跳过，对话流不渲染）
    expect(sent.filter((m) => m.type === 'message.customStart')).toHaveLength(1)
    const frames = sent.filter((m) => m.type === 'message.compactionSummary')
    expect(frames).toHaveLength(1)
    // 字段口径与 compaction_end 通路一致（sessionId 精确 + summary/tokensBefore 同源透传）
    expect(frames[0]!.payload).toMatchObject({ sessionId: SID, summary: '本次摘要', tokensBefore: 9000 })
    expect(typeof (frames[0]!.payload as { timestamp?: number }).timestamp).toBe('number')
  })

  it('compactionId 在 entries 中定位失败 → 尾部最近一条 compaction entry（抢先落盘漂移窗口的正确呈现）', async () => {
    const entries = [compactionEntry('c-old', '旧摘要', 1000), compactionEntry('c-tail', '尾部摘要', 8000), messageEntry('m2')]
    const { interp, sent } = makeInterpreter({ getPiEntries: async () => entries })

    interp.interpret([customStart(SMART_CONTEXT_NOTICE_CUSTOM_TYPE, signalDetails('c-stale'))])
    await flushAsync()

    const frames = sent.filter((m) => m.type === 'message.compactionSummary')
    expect(frames).toHaveLength(1)
    expect(frames[0]!.payload).toMatchObject({ sessionId: SID, summary: '尾部摘要', tokensBefore: 8000 })
  })

  it('信号未携带 compactionId（undefined）→ 尾部兜底', async () => {
    const entries = [messageEntry('m1'), compactionEntry('c-only', '唯一摘要', 500)]
    const { interp, sent } = makeInterpreter({ getPiEntries: async () => entries })

    interp.interpret([customStart(SMART_CONTEXT_NOTICE_CUSTOM_TYPE, signalDetails(undefined))])
    await flushAsync()

    expect(sent.filter((m) => m.type === 'message.compactionSummary')).toHaveLength(1)
    expect(sent.find((m) => m.type === 'message.compactionSummary')!.payload).toMatchObject({ summary: '唯一摘要', tokensBefore: 500 })
  })

  it('非目标 customType → 不触发拉取、不发帧', async () => {
    const getPiEntries = vi.fn(async () => [compactionEntry('c1', 's', 1)])
    const { interp, sent } = makeInterpreter({ getPiEntries })

    interp.interpret([customStart('subagent-bg-notify', { id: 'bg-1' })])
    await flushAsync()

    expect(getPiEntries).not.toHaveBeenCalled()
    expect(sent.filter((m) => m.type === 'message.compactionSummary')).toHaveLength(0)
  })

  it('customType 命中但 details.source 不符（如普通可见通知）→ 不发帧', async () => {
    const getPiEntries = vi.fn(async () => [compactionEntry('c1', 's', 1)])
    const { interp, sent } = makeInterpreter({ getPiEntries })

    interp.interpret([customStart(SMART_CONTEXT_NOTICE_CUSTOM_TYPE, { source: 'compact-complete' })])
    interp.interpret([customStart(SMART_CONTEXT_NOTICE_CUSTOM_TYPE, undefined)])
    await flushAsync()

    expect(getPiEntries).not.toHaveBeenCalled()
    expect(sent.filter((m) => m.type === 'message.compactionSummary')).toHaveLength(0)
  })
})

describe('C1 落盘信号降级契约（entry 缺失 / 拉取失败：不发帧、不抛、warn 留痕）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('getPiEntries 返回 undefined（client 未就绪）→ 无帧 + warn', async () => {
    const { interp, sent } = makeInterpreter({ getPiEntries: async () => undefined })

    interp.interpret([customStart(SMART_CONTEXT_NOTICE_CUSTOM_TYPE, signalDetails('c1'))])
    await flushAsync()

    expect(sent.filter((m) => m.type === 'message.compactionSummary')).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('entries 无任何 compaction entry → 无帧 + warn', async () => {
    const { interp, sent } = makeInterpreter({ getPiEntries: async () => [messageEntry('m1')] })

    interp.interpret([customStart(SMART_CONTEXT_NOTICE_CUSTOM_TYPE, signalDetails('c1'))])
    await flushAsync()

    expect(sent.filter((m) => m.type === 'message.compactionSummary')).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('getPiEntries 未注入（存量构造形态）→ 无帧、不抛', async () => {
    const { interp, sent } = makeInterpreter()

    expect(() => interp.interpret([customStart(SMART_CONTEXT_NOTICE_CUSTOM_TYPE, signalDetails('c1'))])).not.toThrow()
    await flushAsync()
    expect(sent.filter((m) => m.type === 'message.compactionSummary')).toHaveLength(0)
  })

  it('getPiEntries reject → 异步内吞不逃逸（unhandled rejection 防线）+ warn', async () => {
    const { interp, sent } = makeInterpreter({ getPiEntries: async () => { throw new Error('rpc boom') } })

    expect(() => interp.interpret([customStart(SMART_CONTEXT_NOTICE_CUSTOM_TYPE, signalDetails('c1'))])).not.toThrow()
    await flushAsync()

    expect(sent.filter((m) => m.type === 'message.compactionSummary')).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('compaction persist signal handling failed'))
  })
})

describe('pickCompactionEntryForSignal 纯函数（选择序：id 精确 → 尾部最近 → undefined）', () => {
  it('id 命中优先于尾部', () => {
    const entries = [compactionEntry('c-a', 'A', 1), compactionEntry('c-b', 'B', 2)]
    expect(pickCompactionEntryForSignal(entries, 'c-a')).toEqual({ summary: 'A', tokensBefore: 1 })
  })

  it('id 未命中 / 无 id → 尾部最近一条', () => {
    const entries = [compactionEntry('c-a', 'A', 1), compactionEntry('c-b', 'B', 2), messageEntry('m1')]
    expect(pickCompactionEntryForSignal(entries, 'c-x')).toEqual({ summary: 'B', tokensBefore: 2 })
    expect(pickCompactionEntryForSignal(entries, undefined)).toEqual({ summary: 'B', tokensBefore: 2 })
  })

  it('无 entries / 无 compaction entry / 形状缺失字段 → 逐级降级', () => {
    expect(pickCompactionEntryForSignal(undefined, 'c1')).toBeUndefined()
    expect(pickCompactionEntryForSignal([], 'c1')).toBeUndefined()
    expect(pickCompactionEntryForSignal([messageEntry('m1')], 'c1')).toBeUndefined()
    // summary/tokensBefore 非预期形状 → 字段置 undefined（消费方 readCompactionSummary 缺省透传）
    expect(pickCompactionEntryForSignal([{ type: 'compaction', id: 'c1' }], 'c1')).toEqual({ summary: undefined, tokensBefore: undefined })
  })
})
