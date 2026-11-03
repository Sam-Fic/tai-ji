/**
 * use-session 切入链历史拉取测试（session-cold-switch-perf §3.3-4，impl-plan u3）。
 *
 * 覆盖切入链并行切口的时序结构（getHistory 与 switchSession 并行发出，两种到达
 * 顺序收敛同一终态）：
 * ① getHistory 先于 switch resolve 也能落库显示（「查看数据获取」与「执行就绪」解耦）；
 * ② switch 失败短路显示链，已发出的 history reply 仍独立落库（pi 不可用时查看数据仍可得）；
 * ③ 历史晚于 switch 返回：panel 先挂载、消息到达即落库（panel-first 时序保持）。
 *
 * 历史查看 = 请求-响应单一路径（turn-boundary-index D4）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionGroup, BatchDeleteResult, SessionSummary } from '@taiji/shared'
import { effectScope } from 'vue'
import { createUseSession, resetSessionListSubForTest, type UseSessionDeps, type SessionCleanupHooks, type ChatHydratePort } from '../use-session'
import { createSessionStore } from '../store'

/** 构造 SessionSummary 最小形状 */
function summary(id: string, cwd = '/a'): SessionSummary {
  return { id, label: `label-${id}`, cwd, status: 'idle', lastActiveAt: 1 }
}

/** 手动 deferred（时序结构断言用：把指定 RPC 钉在未 resolve 态） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 排空 microtask 队列（并行竞速用例的确定性推进） */
const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0))

interface Fixture { // oe-exempt:20261029:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  session: ReturnType<typeof createUseSession>
  store: ReturnType<typeof createSessionStore>
  api: {
    switchSession: ReturnType<typeof vi.fn>
    onConfigSessions: ReturnType<typeof vi.fn>
  }
  chat: {
    getHistory: ReturnType<typeof vi.fn>
    isHydrated: ReturnType<typeof vi.fn>
    hydrate: ReturnType<typeof vi.fn>
    reconcileHistory: ReturnType<typeof vi.fn>
    clearHistoryError: ReturnType<typeof vi.fn>
    markHistoryFailed: ReturnType<typeof vi.fn>
  }
  panel: { loadSession: ReturnType<typeof vi.fn> }
  navigation: { push: ReturnType<typeof vi.fn> }
  dispose: () => void
}

function makeFixture(): Fixture {
  const scope = effectScope(true)
  const store = scope.run(() => createSessionStore())!

  const api = {
    list: vi.fn().mockResolvedValue([] as SessionGroup[]),
    switchSession: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    removeByCwd: vi.fn().mockResolvedValue({ cwd: '/a', deleted: [], failed: [] } as BatchDeleteResult),
    migrateImage: vi.fn(),
    onConfigSessions: vi.fn(() => vi.fn()),
  }

  const panel = {
    focusedSessionId: vi.fn(() => null),
    activePanelId: vi.fn(() => 'p1'),
    findPanelBySession: vi.fn(() => null),
    loadSession: vi.fn(),
    openPanel: vi.fn(),
  }
  const navigation = { push: vi.fn() }
  const chat = {
    getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    isHydrated: vi.fn(() => false),
    hydrate: vi.fn(),
    reconcileHistory: vi.fn(),
    clearHistoryError: vi.fn(),
    markHistoryFailed: vi.fn(),
  }
  const hooks = {
    clearFileTree: vi.fn(), clearSubagent: vi.fn(), clearWorkflow: vi.fn(),
    clearExtensionUI: vi.fn(), clearExtensionHost: vi.fn(), evictChat: vi.fn(),
    evictVirtualKeys: vi.fn(), clearAgentCallMapping: vi.fn(), disposeChat: vi.fn(),
    invalidateStatus: vi.fn(), browserDestroy: vi.fn(),
  } as unknown as SessionCleanupHooks & Record<string, ReturnType<typeof vi.fn>>

  const deps: UseSessionDeps = {
    store,
    api: api as unknown as UseSessionDeps['api'],
    panel,
    navigation,
    chat: chat as ChatHydratePort,
    hooks,
  }
  const session = scope.run(() => createUseSession(deps))!
  return {
    session,
    store,
    api,
    chat,
    panel,
    navigation,
    dispose: () => scope.stop(),
  }
}

describe('切入链并行切口（session-cold-switch-perf §3.3-4）', () => {
  beforeEach(() => {
    resetSessionListSubForTest()
  })

  it('① getHistory 先于 switch resolve 也能落库显示：switch 钉在未 resolve 态时 reconcile 已执行（mock 层时序结构断言）', async () => {
    const f = makeFixture()
    const switchGate = deferred<void>()
    f.api.switchSession.mockReturnValue(switchGate.promise)
    f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'm1' } as never], truncated: true, loadedTurns: 3, totalTurnsEstimate: 3 })

    const done = f.session.selectSession('sid-1')
    await flush()

    // 并行发出：两个请求都已发出；switch 未 resolve 时数据已落库（「查看数据获取」与
    //「执行就绪」解耦——冷切首屏不等 spawn/全量重建）
    expect(f.api.switchSession).toHaveBeenCalledWith('sid-1')
    expect(f.chat.getHistory).toHaveBeenCalledWith('sid-1')
    expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith(
      'sid-1',
      [{ id: 'm1' }],
      { truncated: true, loadedTurns: 3, totalTurnsEstimate: 3 },
    )
    expect(f.chat.clearHistoryError).toHaveBeenCalledWith('sid-1')
    // 显示层仍随 switch：未 resolve 则 panel 挂载/导航未发生
    expect(f.panel.loadSession).not.toHaveBeenCalled()
    expect(f.navigation.push).not.toHaveBeenCalled()

    switchGate.resolve(undefined)
    await done
    // switch 返回后链补完：activeId 更新 + panel 挂载（panel 若晚于尾读返回，到达即显示——
    // 两种到达顺序收敛到同一终态）
    expect(f.store.activeId.value).toBe('sid-1')
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
    // 单飞：链步 9 消费同一 promise，无双拉
    expect(f.chat.getHistory).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('① switch 失败短路显示链，已发出的 history reply 仍落库（pi 不可用时查看数据仍可得）', async () => {
    const f = makeFixture()
    const switchGate = deferred<void>()
    f.api.switchSession.mockReturnValue(switchGate.promise)
    f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'm1' } as never], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })

    const done = f.session.selectSession('ghost')
    await flush()
    // 短路前数据已落库（独立于链短路的 reply 处理——场景 6 数据层断言的载体）
    expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)

    switchGate.reject(new Error('pi unavailable'))
    await expect(done).rejects.toThrow('pi unavailable')
    // 显示层短路：activeId 不更新、panel/navigation 不动；数据层落库保持
    expect(f.store.activeId.value).toBeNull()
    expect(f.panel.loadSession).not.toHaveBeenCalled()
    expect(f.navigation.push).not.toHaveBeenCalled()
    expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('① 历史晚于 switch 返回：链 await 并行 pull，panel 先挂载、消息到达即落库', async () => {
    const f = makeFixture()
    const historyGate = deferred<{ messages: never[]; truncated: boolean; loadedTurns: number; totalTurnsEstimate: number }>()
    f.chat.getHistory.mockReturnValue(historyGate.promise)

    const done = f.session.selectSession('sid-1')
    await flush()
    // switch 快速返回：panel 挂载先行（panel-first），历史未到不落库
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
    expect(f.chat.reconcileHistory).not.toHaveBeenCalled()

    historyGate.resolve({ messages: [{ id: 'm2' } as never], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    await done
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', [{ id: 'm2' }], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    // 链尾步骤（LRU 驱逐）在历史落库之后执行（时序保持）
    expect(f.store.activeId.value).toBe('sid-1')
    f.dispose()
  })
})
