/**
 * pending.test.ts — PendingTracker 全 API 契约（F5 失败路径验收 + 原语行为，自 pending-tracker.test.ts 归并）。
 *
 * 背景：PendingTracker 是「三处同构 Map+resolve/reject 样板」的提取物，被 plugin-rpc-client、
 * plugin-rpc-server、plugin-commands-executor 等多处消费。锁定：resolve / reject /
 * rejectAll / 乱序并发 resolve / 泛型 K 等原语语义（无墙钟——时间机制删除裁决后
 * pending 挂到回复到达或 dispose rejectAll 收尾）。
 *
 * 运行：cd packages/runtime && npx vitest run test/pending.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { PendingTracker } from '../src/utils/async/pending-tracker.js'

describe('PendingTracker · F5 请求/回复登记契约', () => {
  let tracker: PendingTracker<string, string>

  beforeEach(() => {
    tracker = new PendingTracker()
  })

  it('F5: 响应到达 — resolve + 从 pending Map 删除', async () => {
    const promise = tracker.register('cmd-1')

    // 验证已注册
    expect(tracker.has('cmd-1')).toBe(true)
    expect(tracker.size).toBe(1)

    const resolved = tracker.resolve('cmd-1', 'response-data')
    expect(resolved).toBe(true)

    // 应 resolve
    await expect(promise).resolves.toBe('response-data')

    // 应从 pending Map 删除
    expect(tracker.has('cmd-1')).toBe(false)
    expect(tracker.size).toBe(0)
  })

  it('F5: 已结算的 key 上迟到响应静默丢弃 — resolve 返回 false', async () => {
    const promise = tracker.register('cmd-2').catch(() => {})

    tracker.reject('cmd-2', new Error('failed'))
    await promise

    // 迟到响应 — 应返回 false（未命中）
    const resolved = tracker.resolve('cmd-2', 'late-response')
    expect(resolved).toBe(false)
    expect(tracker.size).toBe(0)
  })

  it('F5: rejectAll — 拒绝所有 pending 请求', async () => {
    const promise1 = tracker.register('cmd-x').catch(() => {})
    const promise2 = tracker.register('cmd-y').catch(() => {})
    const promise3 = tracker.register('cmd-z').catch(() => {})

    expect(tracker.size).toBe(3)

    // rejectAll
    tracker.rejectAll(new Error('Process exited'))

    // 所有都应 reject
    await promise1
    await promise2
    await promise3

    expect(tracker.size).toBe(0)
  })

  it('F5: reject 单个请求 — 只拒绝指定的', async () => {
    const promise1 = tracker.register('cmd-1').catch(() => {})
    const promise2 = tracker.register('cmd-2')

    // 只 reject cmd-1
    const rejected = tracker.reject('cmd-1', new Error('RPC error'))
    expect(rejected).toBe(true)

    await promise1

    // cmd-2 仍在 pending
    expect(tracker.has('cmd-2')).toBe(true)
    expect(tracker.size).toBe(1)

    // cmd-2 正常 resolve
    tracker.resolve('cmd-2', 'ok')
    await expect(promise2).resolves.toBe('ok')
  })

  it('F5: 不存在的 key — resolve/reject 返回 false', () => {
    const resolved = tracker.resolve('non-existent', 'data')
    expect(resolved).toBe(false)

    const rejected = tracker.reject('non-existent', new Error('err'))
    expect(rejected).toBe(false)
  })

  // ── 原语增量语义（自 pending-tracker.test.ts 归并）──────────────────

  it('handles concurrent out-of-order resolution by key', async () => {
    const t = new PendingTracker<number, string>()
    const promises = [
      t.register(1),
      t.register(2),
      t.register(3),
    ]
    t.resolve(3, 'C')
    t.resolve(1, 'A')
    t.resolve(2, 'B')
    await expect(Promise.all(promises)).resolves.toEqual(['A', 'B', 'C'])
  })

  it('number and string keys both work as generic K', async () => {
    const numT = new PendingTracker<number, string>()
    const strT = new PendingTracker<string, string>()
    const pn = numT.register(1)
    const ps = strT.register('id-1')
    numT.resolve(1, 'n')
    strT.resolve('id-1', 's')
    await expect(pn).resolves.toBe('n')
    await expect(ps).resolves.toBe('s')
  })
})
