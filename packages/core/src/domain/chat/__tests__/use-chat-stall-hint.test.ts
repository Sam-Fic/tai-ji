// use-chat-stall-hint.test.ts —— session.stall_hint 帧消费直测（pi-stall-detection U4/D3）。
//
// coverage 文件级门槛暴露的缺口：useChat 的 case 'session.stall_hint' →
// handleSessionStallHint（帧 → chat store 分区写入）此前无任何测试触达。
// fixture 形态与 use-chat-disposition（store-merged-merged.test.ts）同构：chatApi
// streamSubscribe 捕获 handler，emit 驱动 session 级帧分发；send 先行建立订阅
// （ensureStreamSubscription 由 send 触发，emit 之前必须有登记条目）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { textToSegments, type ServerMessage } from '@taiji/shared'
import { createChatStore } from '../store'
import { createUseChat, resetChatModuleStateForTest, type UseChatDeps } from '../useChat'
import { createSessionLiveState } from '@taiji/core/domain/session'

function stallHintFrame(sid: string, active: boolean): ServerMessage {
  return {
    type: 'session.stall_hint',
    payload: { sessionId: sid, active, silentMs: active ? 12_000 : 0, phase: 'tool' },
  } as unknown as ServerMessage
}

describe('useChat session.stall_hint 帧消费（D3 store 分区写入）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeFixture() {
    const scope = effectScope(true)
    const streamHandlers = new Map<string, (m: ServerMessage) => void>()
    const chatStore = scope.run(() => createChatStore())!
    const chatApi = {
      submitDelivery: vi.fn().mockResolvedValue({ clientUuid: 'u-x', state: 'in-flight', lane: 'direct' }),
      streamSubscribe: vi.fn((sid: string, h: (m: ServerMessage) => void) => {
        streamHandlers.set(sid, h)
        return () => {
          streamHandlers.delete(sid)
        }
      }),
    }
    const deps: UseChatDeps = {
      chatApi: chatApi as unknown as UseChatDeps['chatApi'],
      writeSegments: vi.fn().mockResolvedValue(undefined),
      getChatStore: () => chatStore,
      getSessionStore: () => ({ applySnapshot: vi.fn(), revive: vi.fn() }),
      getLiveStateStore: () => createSessionLiveState(),
      toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() },
      t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k),
    }
    const useChat = createUseChat(deps)
    return {
      useChat,
      chatStore,
      emit: (sid: string, m: ServerMessage) => {
        streamHandlers.get(sid)?.(m)
      },
      dispose: () => scope.stop(),
    }
  }

  it('active=true 帧 → store 分区写入（getStallHint 读回 payload）', async () => {
    const f = makeFixture()
    await f.useChat.send('s1', textToSegments('hi')) // 建立订阅
    f.emit('s1', stallHintFrame('s1', true))
    expect(f.chatStore.getStallHint('s1')).toMatchObject({ active: true, silentMs: 12_000, phase: 'tool' })
    f.dispose()
  })

  it('active=false 帧 → 清除边沿（分区回落「无提示在显」）', async () => {
    const f = makeFixture()
    await f.useChat.send('s1', textToSegments('hi'))
    f.emit('s1', stallHintFrame('s1', true))
    expect(f.chatStore.getStallHint('s1')).toBeDefined()
    f.emit('s1', stallHintFrame('s1', false))
    expect(f.chatStore.getStallHint('s1')).toBeUndefined()
    f.dispose()
  })
})
