/**
 * session 切换幕布（session-switch-veil）单测：状态机（useSessionSwitchVeil）+ 编排
 * （useSidebarSessionActions.switchWithVeil / driveVeiledSwitch）。
 *
 * 幕布状态是模块级单例（消费方横跨 sidebar 与 PanelContainer），测试间用
 * releaseSessionSwitch() 复位；编排测试经 options 注入 selectSession/restoreSession
 * 替身（同 sidebar-actions-bundle 的 mock 形态：useChat/useToast 工厂，@/api 走真门面）。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/composables/session-switch-veil.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { SessionGroup } from '@taiji/shared'

const toastErrorMock = vi.hoisted(() => vi.fn())
const toastInfoMock = vi.hoisted(() => vi.fn())

vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ abort: vi.fn() }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock, info: toastInfoMock }),
}))

import {
  SESSION_SWITCH_VEIL_DELAY_MS,
  beginSessionSwitch,
  releaseSessionSwitch,
  retargetSessionSwitch,
  useSessionSwitchVeilState,
} from '@/composables/features/sidebar/useSessionSwitchVeil'
import { useSidebarSessionActions } from '@/composables/features/sidebar/useSidebarSessionActions'
import { useSessionStore } from '@/stores/session'

/** 灌 session store（唯一写入口 applySnapshot 整表形态；list 由 groups 派生）。 */
function seedSessions(entries: Array<{ id: string; label: string; status?: 'idle' | 'dead' }>): void {
  const groups: SessionGroup[] = [
    {
      cwd: '/proj',
      sessions: entries.map((e) => ({
        id: e.id,
        label: e.label,
        cwd: '/proj',
        status: e.status ?? 'idle',
        lastActiveAt: 1_700_000_000_000,
      })),
    },
  ]
  useSessionStore().applySnapshot({ groups })
}

function makeOptions() {
  return {
    selectSession: vi.fn<(id: string) => Promise<void>>(async () => {}),
    restoreSession: vi.fn<(id: string) => Promise<void>>(async () => {}),
    newSession: vi.fn(async () => null),
    loadSessions: vi.fn(),
    renameSession: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    deleteFolder: vi.fn(async () => ({ failed: [] })),
    assignSessionToProject: vi.fn(async () => {}),
    renameOpen: ref(false),
    targetSessionId: ref(''),
  }
}

// ═══════════ 幕布状态机（useSessionSwitchVeil 三态机：idle → pending → visible） ═══════════

describe('useSessionSwitchVeil 状态机', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    releaseSessionSwitch() // 模块级单例复位（防跨用例泄漏）
    vi.useFakeTimers()
  })

  afterEach(() => {
    releaseSessionSwitch()
    vi.useRealTimers()
  })

  it('VL1: 初始 idle；begin → pending（不出幕布）+ 登记 target/driverRunning；满延迟 → visible', () => {
    const veil = useSessionSwitchVeilState()
    expect(veil.phase).toBe('idle')

    beginSessionSwitch('s1', '会话一')
    expect(veil.phase).toBe('pending')
    expect(veil.targetId).toBe('s1')
    expect(veil.targetLabel).toBe('会话一')
    expect(veil.driverRunning).toBe(true)

    // 延迟内不出幕布（防闪烁：快切零 DOM）
    vi.advanceTimersByTime(SESSION_SWITCH_VEIL_DELAY_MS - 1)
    expect(veil.phase).toBe('pending')

    vi.advanceTimersByTime(1)
    expect(veil.phase).toBe('visible')
  })

  it('VL2: 延迟内 settle（release）→ 回 idle 且 timer 已清——推进时间不升 visible', () => {
    const veil = useSessionSwitchVeilState()
    beginSessionSwitch('s1', '会话一')
    releaseSessionSwitch()
    expect(veil.phase).toBe('idle')
    expect(veil.targetId).toBeNull()
    expect(veil.targetLabel).toBe('')
    expect(veil.driverRunning).toBe(false)

    vi.advanceTimersByTime(SESSION_SWITCH_VEIL_DELAY_MS * 2)
    expect(veil.phase).toBe('idle') // clearRevealTimer 生效，回调未把已 release 的状态升 visible
  })

  it('VL3: 等待中改投：retarget 只换 target/label，phase 与计时不动；延迟满仍升 visible（改投不影响判定）', () => {
    const veil = useSessionSwitchVeilState()
    beginSessionSwitch('s1', '会话一')
    vi.advanceTimersByTime(SESSION_SWITCH_VEIL_DELAY_MS - 1)

    retargetSessionSwitch('s2', '会话二')
    expect(veil.targetId).toBe('s2')
    expect(veil.targetLabel).toBe('会话二')
    expect(veil.phase).toBe('pending') // phase 不动（不闪不跳）
    expect(veil.driverRunning).toBe(true)

    vi.advanceTimersByTime(1)
    expect(veil.phase).toBe('visible') // 切换仍在继续（目标已换），幕布按新目标呈现
    expect(veil.targetId).toBe('s2')
  })

  it('VL4: visible 后再次 begin → 重开一轮 pending 窗口（旧 timer 清除，不提前升 visible）', () => {
    const veil = useSessionSwitchVeilState()
    beginSessionSwitch('s1', '会话一')
    vi.advanceTimersByTime(SESSION_SWITCH_VEIL_DELAY_MS)
    expect(veil.phase).toBe('visible')

    beginSessionSwitch('s2', '会话二')
    expect(veil.phase).toBe('pending')
    expect(veil.targetId).toBe('s2')

    vi.advanceTimersByTime(SESSION_SWITCH_VEIL_DELAY_MS)
    expect(veil.phase).toBe('visible')
  })

  it('VL5: useSessionSwitchVeilState 返回同一单例对象（sidebar 与 PanelContainer 跨消费方同态）', () => {
    expect(useSessionSwitchVeilState()).toBe(useSessionSwitchVeilState())
  })
})

// ═══════════ 切换编排（switchWithVeil / driveVeiledSwitch：改投 / dead 分流 / 失败口径） ═══════════

describe('useSidebarSessionActions 切换编排（session-switch-veil driver）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    releaseSessionSwitch() // 幕布单例复位
    toastErrorMock.mockClear()
    toastInfoMock.mockClear()
  })

  afterEach(() => {
    releaseSessionSwitch()
  })

  it('SV1: 常规切换：selectSession 被调，settle 后 release（回 idle、driverRunning 复位）', async () => {
    seedSessions([{ id: 's1', label: '会话一' }])
    const opts = makeOptions()
    const actions = useSidebarSessionActions(opts)
    const veil = useSessionSwitchVeilState()

    await actions.onSelectSession('s1')

    expect(opts.selectSession).toHaveBeenCalledWith('s1')
    expect(opts.restoreSession).not.toHaveBeenCalled()
    expect(veil.phase).toBe('idle')
    expect(veil.driverRunning).toBe(false)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('SV2: dead session → restoreSession 分流（selectSession 不被调），settle 后 release', async () => {
    seedSessions([{ id: 'd1', label: '已死会话', status: 'dead' }])
    const opts = makeOptions()
    const actions = useSidebarSessionActions(opts)

    await actions.onSelectSession('d1')

    expect(opts.restoreSession).toHaveBeenCalledWith('d1')
    expect(opts.selectSession).not.toHaveBeenCalled()
    expect(useSessionSwitchVeilState().driverRunning).toBe(false)
  })

  it('SV3: 等待中改投：在途第二次切换只 retarget 不打断；首个 settle 后 driver 接续新目标', async () => {
    seedSessions([
      { id: 's1', label: '会话一' },
      { id: 's2', label: '会话二' },
    ])
    const opts = makeOptions()
    const actions = useSidebarSessionActions(opts)
    const veil = useSessionSwitchVeilState()
    let releaseFirst!: () => void
    opts.selectSession.mockImplementationOnce(
      () => new Promise<void>((res) => { releaseFirst = res }),
    )

    const first = actions.onSelectSession('s1')
    expect(veil.phase).toBe('pending') // 切换进行中（延迟未满不出幕布）

    const second = actions.onSelectSession('s2') // 等待中再点 = 改投
    await second // 恒 resolve（改投不打断在途 driver）
    expect(opts.selectSession).toHaveBeenCalledTimes(1) // 在途切换未被打断
    expect(veil.targetId).toBe('s2') // 幕布目标已换

    releaseFirst()
    await first
    expect(opts.selectSession).toHaveBeenNthCalledWith(2, 's2') // settle 后按最新目标接续
    expect(veil.phase).toBe('idle')
    expect(veil.driverRunning).toBe(false)
  })

  it('SV4: 失败且未改投：release + toast「切换会话失败：<msg>」，恒 resolve 不上抛', async () => {
    seedSessions([{ id: 's1', label: '会话一' }])
    const opts = makeOptions()
    opts.selectSession.mockRejectedValueOnce(new Error('rpc boom'))
    const actions = useSidebarSessionActions(opts)
    const veil = useSessionSwitchVeilState()

    await expect(actions.onSelectSession('s1')).resolves.toBeUndefined()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('切换会话失败')
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('rpc boom')
    expect(veil.phase).toBe('idle')
    expect(veil.driverRunning).toBe(false) // 失败即收场，无残留 driver 态
  })

  it('SV5: 失败但已改投：旧目标失败静默接续新目标（新意图与用户相关），不出声', async () => {
    seedSessions([
      { id: 's1', label: '会话一' },
      { id: 's2', label: '会话二' },
    ])
    const opts = makeOptions()
    const actions = useSidebarSessionActions(opts)
    const veil = useSessionSwitchVeilState()
    let rejectFirst!: (e: Error) => void
    opts.selectSession.mockImplementationOnce(
      () => new Promise<void>((_, rej) => { rejectFirst = rej }),
    )

    const first = actions.onSelectSession('s1')
    const second = actions.onSelectSession('s2') // 改投 s2（在途）
    expect(veil.targetId).toBe('s2')

    rejectFirst(new Error('old target boom'))
    await first
    await second

    expect(opts.selectSession).toHaveBeenNthCalledWith(2, 's2') // 静默接续新目标
    expect(toastErrorMock).not.toHaveBeenCalled() // 旧目标失败与用户无关
    expect(veil.driverRunning).toBe(false)
  })

  it('SV6: 目标不在列表（列表过期形态）：label 回空串，切换照常驱动', async () => {
    seedSessions([{ id: 's1', label: '会话一' }])
    const opts = makeOptions()
    const actions = useSidebarSessionActions(opts)
    const veil = useSessionSwitchVeilState()

    await actions.onSelectSession('ghost')

    expect(opts.selectSession).toHaveBeenCalledWith('ghost')
    expect(veil.phase).toBe('idle')
    expect(toastErrorMock).not.toHaveBeenCalled()
  })
})
