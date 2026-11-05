/**
 * pending 注册表补充单测 —— 容量上限驱逐最老（overflow）、has / reject / rejectAll /
 * 未知 id no-op。现有 resolveEnvelope 细节在 pending.test.ts，本文件补齐注册表自身行为。
 * （超时 sweep 节随 pending 超时机制退役删除——ADR-0190：注册表结算全事件驱动。）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createCommandId, register, resolve, reject, has, rejectAll,
} from '../pending'

beforeEach(() => {
  // 清空残留 pending，防止跨用例污染；
  // 各用例自行 settle 或挂 catch，此处无未处理 rejection
  rejectAll(new Error('teardown'))
})
afterEach(() => {
  rejectAll(new Error('teardown'))
})

describe('pending 注册表 — 容量与批量清理', () => {
  it('超限（≥256）驱逐最老：oldest reject code=overflow，新条目正常注册', async () => {
    const oldest = createCommandId()
    const pOldest = register(oldest)
    const eOldest = expect(pOldest).rejects.toMatchObject({ code: 'overflow' })
    for (let i = 0; i < 300; i++) {
      // catch 吸附驱逐/teardown reject，防 unhandled rejection（条目本身不逐条断言）
      register(createCommandId()).catch(() => {})
    }
    await eOldest
    // 最新注册的条目仍存活可 resolve
    const newest = createCommandId()
    const pNewest = register<string>(newest)
    resolve(newest, 'ok')
    await expect(pNewest).resolves.toBe('ok')
  })

  it('has 区分注册中 / 已完成条目（广播误吞防线的判定依据）', async () => {
    const id = createCommandId()
    register(id)
    expect(has(id)).toBe(true)
    resolve(id, 'x')
    expect(has(id)).toBe(false)
    expect(has('ghost')).toBe(false)
  })

  it('reject：settled promise rejects + 未知 id no-op', async () => {
    const id = createCommandId()
    const p = register(id)
    reject(id, new Error('rpc failed'))
    await expect(p).rejects.toThrow('rpc failed')
    expect(() => reject('ghost', new Error('x'))).not.toThrow()
    expect(() => resolve('ghost', 'x')).not.toThrow()
  })

  it('rejectAll：全部 reject + map 清空（WS 断连场景）', async () => {
    const ids = [createCommandId(), createCommandId(), createCommandId()]
    const ps = ids.map((id) => register(id).catch((e: unknown) => e))
    rejectAll(new Error('disconnected'))
    const results = await Promise.all(ps)
    for (const r of results) {
      expect(r).toBeInstanceOf(Error)
    }
    for (const id of ids) {
      expect(has(id)).toBe(false)
    }
  })
})
