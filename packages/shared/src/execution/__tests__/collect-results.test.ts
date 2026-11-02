/**
 * M0-3 契约测试：collect_results 新通道拍板四项的可机检部分。
 *
 * 四项拍板（设计 §3.4 M0 / 执行 API notice.collect 行 / S15）：
 * ① 未知 id 判定源 = 执行域已知键集补集；
 * ② 混合键集两路聚合口径与单一 timeout 共享（等待键集为并集，不设路级解除）；
 * ③ notice.collect 幂等两层交叉（先 commandId、后 noticeId，领域层回执返回首次
 *    collected 修订号而非当前修订号）；
 * ④ 通知内容快照读取通道 = 执行事件流派生通知缓存（折叠输入四事件、快照不设 notices）。
 */

import { describe, expect, it } from 'vitest'

import {
  COLLECT_KEY_ERROR_CODES,
  COLLECT_RESULTS_DEFAULT_TIMEOUT_MS,
  COLLECT_RESULT_BUCKETS,
  COLLECT_WAIT_RELEASE_CONDITIONS,
  NOTICE_COLLECT_IDEMPOTENCY_ORDER,
  resolveCollectTimeoutMs,
  resolveNoticeCollectRevision,
  routeCollectKeys,
} from '../collect-results'
import { NOTICE_CACHE_FOLD_EVENT_TYPES } from '../notice'

describe('拍板 ①：未知 id 判定源 = 执行域已知键集补集', () => {
  it('既不在执行域四集合也不在旧 pending 链的键 → errors.unknown_id，不进等待集', () => {
    const routing = routeCollectKeys({
      requested: ['ghost'],
      execution: { active: [], ready: [], collected: [], nonCollectable: [] },
      pendingKnown: [],
    })
    expect(routing.waitKeys).toEqual([])
    expect(routing.errors).toHaveLength(1)
    expect(routing.errors[0]).toMatchObject({ key: 'ghost', code: 'unknown_id' })
    expect(routing.errors[0]?.recovery).toContain('派发')
  })

  it('unknown_id 文案含升级窗口期语义（reason 标注未知/未导入，M0 定稿义务）', () => {
    const routing = routeCollectKeys({
      requested: ['pre-upgrade-run'],
      execution: { active: [], ready: [], collected: [], nonCollectable: [] },
      pendingKnown: [],
    })
    expect(routing.errors[0]?.message).toContain('尚未导入执行域')
    expect(routing.errors[0]?.recovery).toContain('M5')
    expect(routing.errors[0]?.recovery).toContain('resume')
  })

  it('执行域已知但不可收集（interrupted 暂停态）→ errors.not_collectable', () => {
    const routing = routeCollectKeys({
      requested: ['paused-run'],
      execution: { active: [], ready: [], collected: [], nonCollectable: ['paused-run'] },
      pendingKnown: [],
    })
    expect(routing.waitKeys).toEqual([])
    expect(routing.errors[0]).toMatchObject({ key: 'paused-run', code: 'not_collectable' })
  })

  it('错误码封闭词表仅两值', () => {
    expect([...COLLECT_KEY_ERROR_CODES]).toEqual(['unknown_id', 'not_collectable'])
  })
})

describe('拍板 ②：混合键集两路聚合口径与单一 timeout 共享', () => {
  it('执行域 active 与旧 pending 键都进等待集，waitKeys = 两路并集', () => {
    const routing = routeCollectKeys({
      requested: ['wf-1', 'bash-1', 'member-1', 'session-1'],
      execution: { active: ['wf-1', 'member-1'], ready: [], collected: [], nonCollectable: [] },
      pendingKnown: ['bash-1', 'session-1'],
    })
    expect(routing.executionWait).toEqual(['wf-1', 'member-1'])
    expect(routing.pendingWait).toEqual(['bash-1', 'session-1'])
    expect(routing.waitKeys).toEqual(['wf-1', 'member-1', 'bash-1', 'session-1'])
    expect(routing.errors).toEqual([])
  })

  it('等待解除条件恰三项，无「任一路完成」路级解除', () => {
    expect([...COLLECT_WAIT_RELEASE_CONDITIONS]).toEqual([
      'wait_set_all_terminal_or_collected',
      'timeout',
      'aborted',
    ])
    expect(COLLECT_WAIT_RELEASE_CONDITIONS.some((condition) => condition.includes('path'))).toBe(false)
  })

  it('三桶封闭词表 + 请求键去重保序', () => {
    const routing = routeCollectKeys({
      requested: ['a', 'a', 'b'],
      execution: { active: ['b'], ready: [], collected: ['a'], nonCollectable: [] },
      pendingKnown: [],
    })
    expect([...COLLECT_RESULT_BUCKETS]).toEqual(['collected', 'stillOpen', 'errors'])
    expect(routing.collected).toEqual(['a'])
    expect(routing.waitKeys).toEqual(['b'])
  })

  it('执行域优先于旧 pending（同一 id 在旧链残留时以执行域权威为准）', () => {
    const routing = routeCollectKeys({
      requested: ['dual'],
      execution: { active: ['dual'], ready: [], collected: [], nonCollectable: [] },
      pendingKnown: ['dual'],
    })
    expect(routing.executionWait).toEqual(['dual'])
    expect(routing.pendingWait).toEqual([])
  })

  it('键同时误入多集合时按 nonCollectable > collected > ready > active 优先（fail-visible）', () => {
    const routing = routeCollectKeys({
      requested: ['x'],
      execution: { active: ['x'], ready: ['x'], collected: ['x'], nonCollectable: ['x'] },
      pendingKnown: ['x'],
    })
    expect(routing.errors[0]).toMatchObject({ key: 'x', code: 'not_collectable' })
    expect(routing.waitKeys).toEqual([])
  })

  it('ready 与 collected 同为 collected 桶（前者本次回写收集，后者幂等返回快照）', () => {
    const routing = routeCollectKeys({
      requested: ['fresh', 'done'],
      execution: { active: [], ready: ['fresh'], collected: ['done'], nonCollectable: [] },
      pendingKnown: [],
    })
    expect(routing.collected).toEqual(['fresh', 'done'])
    expect(routing.waitKeys).toEqual([])
  })

  it('timeout_ms：缺省 = 契约默认 3600000；0 合法；非法值回退默认并标记 invalid', () => {
    expect(COLLECT_RESULTS_DEFAULT_TIMEOUT_MS).toBe(3_600_000)
    expect(resolveCollectTimeoutMs(undefined)).toEqual({ timeoutMs: 3_600_000, valid: true })
    expect(resolveCollectTimeoutMs(0)).toEqual({ timeoutMs: 0, valid: true })
    expect(resolveCollectTimeoutMs(120_000)).toEqual({ timeoutMs: 120_000, valid: true })
    expect(resolveCollectTimeoutMs(-1)).toEqual({ timeoutMs: 3_600_000, valid: false })
    expect(resolveCollectTimeoutMs(1.5)).toEqual({ timeoutMs: 3_600_000, valid: false })
    expect(resolveCollectTimeoutMs(Number.NaN)).toEqual({ timeoutMs: 3_600_000, valid: false })
    expect(resolveCollectTimeoutMs(Number.POSITIVE_INFINITY)).toEqual({ timeoutMs: 3_600_000, valid: false })
  })
})

describe('拍板 ③：notice.collect 幂等两层交叉', () => {
  it('判定顺序固定为先 command 层、后 notice 层', () => {
    expect([...NOTICE_COLLECT_IDEMPOTENCY_ORDER]).toEqual(['command', 'notice'])
  })

  it('命令层命中优先：返回首次受理修订号（即使通知已 collected 且当前 revision 更高）', () => {
    expect(
      resolveNoticeCollectRevision({ commandReplayRevision: 7, noticeCollectedRevision: 9, currentRevision: 42 }),
    ).toBe(7)
  })

  it('领域层命中：返回 NoticeCollected 首次发生修订号，不随会话当前修订号漂移', () => {
    expect(resolveNoticeCollectRevision({ noticeCollectedRevision: 9, currentRevision: 42 })).toBe(9)
  })

  it('两层都未命中：本次首次收集，回执 = 当前批次修订号', () => {
    expect(resolveNoticeCollectRevision({ currentRevision: 42 })).toBe(42)
  })
})

describe('拍板 ④：通知内容快照读取通道 = 事件流派生通知缓存', () => {
  it('折叠输入恰四个通知事件（不引入其他推断源）', () => {
    expect([...NOTICE_CACHE_FOLD_EVENT_TYPES]).toEqual([
      'NoticeQueued',
      'NoticeDelivered',
      'NoticeCollected',
      'NoticeAbandoned',
    ])
  })
})
