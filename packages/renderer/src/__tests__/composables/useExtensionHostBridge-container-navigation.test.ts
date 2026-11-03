/**
 * useExtensionHostBridge-container-navigation.test.ts —— 容器导航执行器壳层接线单测
 * （容器扩展点统一 §6.4；bridge 的 CONTAINER_NAVIGATION_KEY 装配段）。
 *
 * 被测行为（initExtensionHostBridge 装配的生产 lookup/sink）：
 * - lookup.resolveTargets：内置抽屉声明命中（contentSlotRegistry 声明分支）/
 *   浮层内置 OVERLAY_REGISTRY 投影补解析 / 双未命中 → []（unknown-target）；
 * - lookup.hasData：workflow 唯一 openableWithoutData=false 成员的数据事实判据
 *   （焦点会话 workflow runs 分区非空才放行）；
 * - sink.openDrawerTab：剥内置前缀 + params 透传（recordId → subagent 记录反查）；
 * - sink.openOverlayContent：scheduler 直开 / workflow 凭 runId 参数化通道；
 * - bindSubagentRecordLookup：openDrawerTab('subagent') 的 recordId 反查读 renderer
 *   subagent store 分区。
 *
 * 校验逻辑本体（全局 id 解析/族匹配/会话优先级）归 core 执行器，container-navigation.test.ts
 * 已承载；本文件断言「壳层装配的端口接到了真实数据源与真实写入端」——效果断言消费
 * core drawer/overlay 域控制态真值（非 mock 回放）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useExtensionHostBridge-container-navigation.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { CONTAINER_NAVIGATION_KEY } from '@taiji/ui/rendering-protocol'
import { ContainerNavigationExecutor } from '@taiji/core'
import {
  bindDrawerSessionId,
  bindSubagentRecordLookup,
  getDrawerControlState,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import { getOverlayControlState, _resetOverlayForTest } from '@taiji/core/domain/overlay'
import type { SubagentRecord, WorkflowRunRecord } from '@taiji/shared'
import { initExtensionHostBridge, __testing } from '@/composables/shell/useExtensionHostBridge'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'

// ── mock 区 ──────────────────────────────────────────────────────────────

// commandStore：bridge 装配即调 useCommandStore()（依赖 getPlatform().storage），stub 判定输入
// （对齐 useExtensionHostBridge-host-commands.test.ts 同款 mock）
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({ getCommands: () => [] as Array<{ name: string }> }),
}))

// @/api：spread actual 仅覆写 session.getWorkflows——workflow store 的写权威入口
// loadWorkflows 经它拉取（applyRecords 为 store 私有，生产写入面不经测试直写）。
// mock 值由用例按需安装（getWorkflowsMock.mockResolvedValueOnce），缺省恒空列表。
const { getWorkflowsMock } = vi.hoisted(() => ({ getWorkflowsMock: vi.fn() }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    session: { ...actual.session, getWorkflows: getWorkflowsMock },
  }
})

// ── 夹具 ─────────────────────────────────────────────────────────────────

/** drawer 域绑定的焦点会话（导航执行器 getBoundSessionId 消费焦点会话）。 */
const FOCUS_SESSION = 'session-focus-1'

/** 壳层装配的生产导航执行器（initExtensionHostBridge provide 的 CONTAINER_NAVIGATION_KEY）。
 *  断言消费 core 执行器的结构化结果（ui 注入接口的 navigate 返回 void，生产实例是 core
 *  类——结构型适配零包装，结果类型经 core 类取回）。 */
function initBridgeNavigator(): InstanceType<typeof ContainerNavigationExecutor> {
  const provided: Array<{ key: unknown; value: unknown }> = []
  const app = {
    provide(key: unknown, value: unknown) {
      provided.push({ key, value })
      return app
    },
  }
  initExtensionHostBridge(app as never)
  const executor = provided.find((p) => p.key === CONTAINER_NAVIGATION_KEY)?.value
  if (!executor) throw new Error('CONTAINER_NAVIGATION_KEY 未 provide')
  return executor as InstanceType<typeof ContainerNavigationExecutor>
}

/** running 态 subagent 记录种子（记录反查判据：subagentId 命中分区）。 */
function seedRunningRecord(subagentId: string): void {
  const record: SubagentRecord = {
    subagentId,
    sessionFile: null,
    agent: 'reviewer',
    slug: 'reviewer',
    task: '审一遍 PR #123',
    status: 'running',
    startedAt: 1,
  }
  useSubagentStore().applyRecords(FOCUS_SESSION, [record])
}

/** workflow run 记录种子（hasData 判据：焦点会话 runs 分区非空）。经 store 公开写权威
 *  入口 loadWorkflows 拉取（@/api mock 供夹具——生产同链写入，不直写私有分区）。 */
function seedWorkflowRun(runId: string): void {
  const record: WorkflowRunRecord = {
    runId,
    scriptName: 'build',
    status: 'running',
    startedAt: '2026-11-03T00:00:00Z',
    agentCalls: [],
    stateFilePath: '/abs/state.jsonl',
  }
  getWorkflowsMock.mockResolvedValue({ workflows: [record] })
}

beforeEach(() => {
  setActivePinia(createPinia())
  bindDrawerSessionId(ref<string | null>(FOCUS_SESSION))
  _resetDrawerForTest()
  _resetOverlayForTest()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  __testing.lastInitHandles?.dispose()
  __testing.lastInitHandles = null
  // 解绑 subagent 记录反查（core 域模块级绑定，防跨用例残留——测试隔离用）
  bindSubagentRecordLookup(null)
  bindDrawerSessionId(ref<string | null>(null))
  getWorkflowsMock.mockReset()
  vi.restoreAllMocks()
})

// ── lookup.resolveTargets 三分支 ──────────────────────────────────────────

describe('lookup.resolveTargets：内置抽屉声明 → 浮层注册表投影 → 双未命中', () => {
  it('ui.subagent 命中内置抽屉声明：放行至 drawer sink，记录反查命中后开 subagent tab', () => {
    seedRunningRecord('sub-42')
    const navigator = initBridgeNavigator()

    const result = navigator.navigate({
      kind: 'drawer',
      tabId: 'ui.subagent',
      params: { recordId: 'sub-42' },
    })

    expect(result.ok).toBe(true)
    // sink.openDrawerTab → core openDrawerTab('subagent', {recordId}) → 反查命中 →
    // openSubagent 编排写选中态 + 开抽屉（core 控制态真值断言）
    const drawer = getDrawerControlState()
    expect(drawer.isOpen).toBe(true)
    expect(drawer.activeTab).toBe('subagent')
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('ui.scheduler 不经声明通道：OVERLAY_REGISTRY 投影补解析 → overlay sink 直开 scheduler', () => {
    const navigator = initBridgeNavigator()

    const result = navigator.navigate({ kind: 'overlay', tabId: 'ui.scheduler' })

    expect(result.ok).toBe(true)
    // sink.openOverlayContent → core openOverlayContent('scheduler') → openSchedulerOverlay
    const overlay = getOverlayControlState()
    expect(overlay.isOpen).toBe(true)
    expect(overlay.current).toEqual({ kind: 'scheduler', payload: { sessionId: FOCUS_SESSION } })
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('声明与浮层注册表双未命中 → unknown-target 一行 warning，零容器状态写入', () => {
    const navigator = initBridgeNavigator()

    const result = navigator.navigate({ kind: 'overlay', tabId: 'ui.does-not-exist' })

    expect(result).toMatchObject({ ok: false, reason: 'unknown-target' })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("'ui.does-not-exist' 不存在"))
    expect(getDrawerControlState().isOpen).toBe(false)
    expect(getOverlayControlState().isOpen).toBe(false)
  })
})

// ── lookup.hasData：workflow 唯一 openableWithoutData=false 成员 ──────────

describe('lookup.hasData：workflow 无数据不开空浮层', () => {
  it('焦点会话无 runs → hasData false → not-openable，浮层不打开', () => {
    const navigator = initBridgeNavigator()

    const result = navigator.navigate({
      kind: 'overlay',
      tabId: 'ui.workflow',
      params: { runId: 'run-7' },
    })

    expect(result).toMatchObject({ ok: false, reason: 'not-openable' })
    expect(getOverlayControlState().isOpen).toBe(false)
  })

  it('焦点会话有 runs → hasData true → 放行（workflow 凭 runId 走参数化通道）', async () => {
    seedWorkflowRun('run-7')
    await useWorkflowStore().loadWorkflows(FOCUS_SESSION)
    const navigator = initBridgeNavigator()

    const result = navigator.navigate({
      kind: 'overlay',
      tabId: 'ui.workflow',
      params: { runId: 'run-7' },
    })

    expect(result.ok).toBe(true)
    // workflow 打开经 renderer 绑定的浮层 opener（headless 测试态未绑定 = 可选调用 no-op，
    // 不写 overlay 控制态）；本用例断言校验链放行 + 未误报 not-openable
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('非 workflow 目标不走数据事实判据（hasData 仅 openableWithoutData=false 成员可达）', () => {
    seedRunningRecord('sub-42')
    const navigator = initBridgeNavigator()

    // ui.subagent 声明 openableWithoutData=true：无 runs 也不查数据事实，直接放行
    const result = navigator.navigate({ kind: 'drawer', tabId: 'ui.subagent' })

    expect(result.ok).toBe(true)
    expect(getDrawerControlState().isOpen).toBe(true)
  })
})
