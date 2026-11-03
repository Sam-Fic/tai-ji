/**
 * v3 DeliveryStore 持久化存储端口契约（设计 unified-delivery §3.5.1 / §3.5.5）：
 * - persist 先于投递尝试（耐久承诺先于投递，与账本 record 先于 deliver 同律）
 * - 终局 delivered / cancelled 时 ack（含 drain 全量终局）
 * - persist 失败 = 承诺未落 → 拒收（send rejected / sendChecked throw），不投递
 * - forget 失败 discard（无终局语义的记录无痕移除）/ retain 失败记录保留
 * - loadUndelivered / loadTerminalIds（内存假实现的差集 / 终局视图）
 * - ack 写盘失败 = 磁盘权威（2026-10-30 用户裁决）：内存不登记终态（条目留守活跃集
 *   非终态）+ 分型错误 DeliveryAckPersistError 显式上报；外部送达事实不回滚，恢复后
 *   可能重投（at-least-once 显式接受）
 *
 * 内核零 fs 知识锚：store 由测试注入内存假实现（tests/helpers MemoryDeliveryStore），
 * 内核仅经端口方法交互。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery, DeliveryAckPersistError } from '../src/index.js'
import type { DeliveryMessage, DeliveryPort } from '../src/types.js'
import { MemoryDeliveryStore, customMsg, makeMockPort, textMsg } from './helpers.js'

function makeStoreWithPort(overrides?: Partial<DeliveryPort>) {
  const store = new MemoryDeliveryStore()
  const port = makeMockPort(overrides)
  return { store, port }
}

describe('DeliveryStore 契约：persist 先于投递尝试', () => {
  it('send 受理前 persist 已落——port.send 执行时 store 差集已含该条目', () => {
    const { store, port } = makeStoreWithPort()
    // port.send 执行时点检查：投递尝试发生前 persist 必须已落（耐久承诺先序）
    const persistedAtSend: string[] = []
    port.send = (msg) => {
      const id = (msg as DeliveryMessage & { __id?: string }).__id
      void id
      // 时序锚：send 调用时 store.persistOrder 已含全部已提交条目 id
      persistedAtSend.push(...store.persistOrder)
      return undefined
    }

    const handle = createDelivery(port, { store })
    try {
      const result = handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' })
      expect(result).toEqual({ kind: 'accepted', id: 'sid-1' })
      expect(persistedAtSend).toContain('sid-1') // persist 发生在 port.send 之前
      expect(store.undelivered.has('sid-1')).toBe(true)
      expect(store.calls.persist).toBe(1)
    } finally {
      handle.dispose()
    }
  })

  it('record 携带重建投递所需最小信息（id/lane/payload/intent/anchor）', () => {
    const { store, port } = makeStoreWithPort()
    const handle = createDelivery(port, { store })
    try {
      handle.send(customMsg('subagents:notify', 'n-1', { intent: 'after-run', meta: { notifyId: 'nid-1' } }), {
        id: 'sid-1',
        lane: 'queued',
        receiptAnchor: 'details-id',
      })
      const record = store.undelivered.get('sid-1')
      expect(record).toMatchObject({
        id: 'sid-1',
        lane: 'queued',
        receiptAnchor: 'details-id',
        intent: 'after-run',
      })
      expect(record!.payload).toEqual({ kind: 'custom', customType: 'subagents:notify', content: 'n-1', display: true })
      expect(record!.meta).toEqual({ notifyId: 'nid-1' })
    } finally {
      handle.dispose()
    }
  })

  it('sendChecked 同样受理前 persist（checked 路径同律）', async () => {
    const { store, port } = makeStoreWithPort()
    const handle = createDelivery(port, { store })
    try {
      await expect(handle.sendChecked(textMsg('hello'), { id: 'cid-1' })).resolves.toBeUndefined()
      expect(store.persistOrder).toEqual(['cid-1'])
    } finally {
      handle.dispose()
    }
  })
})

describe('DeliveryStore 契约：终局 ack', () => {
  it('confirmDelivered 终局 → ack：差集移除 + 终局集合登记', () => {
    const { store, port } = makeStoreWithPort()
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(store.undelivered.has('sid-1')).toBe(true)
      expect(handle.confirmDelivered('sid-1')).toBe(true)
      expect(store.undelivered.has('sid-1')).toBe(false)
      expect(store.terminals.has('sid-1')).toBe(true)
      expect(store.calls.ack).toBe(1)
    } finally {
      handle.dispose()
    }
  })

  it('cancel 终局 → ack：已撤销消息的防复活凭据 = 撤销时写持久终局', () => {
    const { store, port } = makeStoreWithPort({
      // hold 拒（设计内等待）：条目受理前留守 queued（未出站，cancel 直接终局）
      send: () => ({ accepted: false as const, deferred: 'merge-commit-hold' as const }),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      const result = handle.cancel('sid-1')
      expect(result.kind).toBe('cancelled')
      expect(store.undelivered.has('sid-1')).toBe(false)
      expect(store.terminals.has('sid-1')).toBe(true) // 持久终局（防复活）
      expect(store.loadTerminalIds()).toContain('sid-1')
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('drain 全量终局 → 全部 ack', () => {
    const { store, port } = makeStoreWithPort()
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      handle.send(textMsg('m-2'), { id: 'sid-2' })
      const drained = handle.drain()
      expect(drained).toHaveLength(2)
      expect(store.undelivered.size).toBe(0)
      expect(store.terminals).toEqual(new Set(['sid-1', 'sid-2']))
    } finally {
      handle.dispose()
    }
  })

  it('ack 写盘失败（磁盘权威）：confirmDelivered false、内存不登记终态、条目留守活跃集、错误显式留痕', () => {
    const { store, port } = makeStoreWithPort()
    const originalAck = store.ack.bind(store)
    let ackBroken = true
    vi.spyOn(store, 'ack').mockImplementation((id: string) => {
      if (ackBroken) throw new Error('disk full')
      originalAck(id)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSettled = vi.fn()
    const handle = createDelivery(port, { store, onSettled })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' }) // port.send 受理成功 → in-flight 等回执
      expect(handle.confirmDelivered('sid-1')).toBe(false) // 终局未落定
      expect(handle.entriesFull().tombstones).toHaveLength(0) // 内存终局记录不登记
      const active = handle.entriesFull().active
      expect(active.map((e) => e.id)).toEqual(['sid-1']) // 条目留守活跃集
      expect(active[0]!.state).toBe('in-flight') // 原态保持（未终态）
      expect(onSettled).not.toHaveBeenCalled() // 终态未落定，送达回调不触发
      // 判重一级（在途集）仍含该 id：同 id 重报照常被吞（在途 = 未终态，口径一致）
      expect(handle.send(textMsg('m-1', { dedupeKey: 'k2' }), { id: 'sid-1' })).toEqual({
        kind: 'swallowed',
        reason: 'already-seen',
      })
      // 显式失败面：warn 携带分型错误（含「已送达但终态未持久化，恢复后可能重投」文案）
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('store.ack failed'),
        expect.any(DeliveryAckPersistError),
      )
      const logged = warnSpy.mock.calls.find((c) => String(c[0]).includes('store.ack failed'))![1] as DeliveryAckPersistError
      expect(logged.message).toContain('recovery may redeliver')
      expect(logged.entryId).toBe('sid-1')
      expect(logged.state).toBe('delivered')
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('ack 写盘失败重试路径：写盘恢复后同一回执入口重驱动 → 终局补落（回调补触发）', () => {
    const { store, port } = makeStoreWithPort()
    const originalAck = store.ack.bind(store)
    let ackBroken = true
    vi.spyOn(store, 'ack').mockImplementation((id: string) => {
      if (ackBroken) throw new Error('disk full')
      originalAck(id)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSettled = vi.fn()
    const handle = createDelivery(port, { store, onSettled })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(handle.confirmDelivered('sid-1')).toBe(false) // 写盘失败：未终态
      ackBroken = false // 磁盘故障恢复
      expect(handle.confirmDelivered('sid-1')).toBe(true) // 同一入口重驱动即重试
      expect(store.terminals.has('sid-1')).toBe(true) // 持久终局补落
      expect(handle.entriesFull().tombstones.map((t) => t.id)).toEqual(['sid-1'])
      expect(handle.entriesFull().active).toHaveLength(0)
      expect(onSettled).toHaveBeenCalledWith(expect.anything(), 'delivered') // 送达回调补触发
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('ack 写盘失败（磁盘权威）：cancel 上抛 DeliveryAckPersistError、条目转 failed 留守；恢复后重试 cancel 补落终局', () => {
    const { store, port } = makeStoreWithPort({
      // port.send 永不 settle：条目留守 queued（cancel 直终局分支）
      send: () => new Promise(() => {}),
    })
    const originalAck = store.ack.bind(store)
    let ackBroken = true
    vi.spyOn(store, 'ack').mockImplementation((id: string) => {
      if (ackBroken) throw new Error('disk full')
      originalAck(id)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(() => handle.cancel('sid-1')).toThrow(DeliveryAckPersistError) // 用户驱动入口：显式失败上抛
      const active = handle.entriesFull().active
      expect(active.map((e) => e.id)).toEqual(['sid-1']) // 留守活跃集（未终态）
      expect(active[0]!.state).toBe('failed') // 歧义留守：不参与 pump 重投
      expect(handle.entriesFull().tombstones).toHaveLength(0)
      expect(store.terminals.has('sid-1')).toBe(false) // 磁盘无终局（唯一权威）
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('store.ack failed'),
        expect.any(DeliveryAckPersistError),
      )
      ackBroken = false // 磁盘故障恢复
      const result = handle.cancel('sid-1') // cancel 接受 failed 态：重试即补落
      expect(result.kind).toBe('cancelled')
      expect(store.terminals.has('sid-1')).toBe(true)
      expect(handle.entriesFull().active).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('ack 写盘失败（磁盘权威）：drain 逐条降级——失败条目文本照常取回 + 转 failed 留守，成功条目照常终局', () => {
    const { store, port } = makeStoreWithPort()
    const originalAck = store.ack.bind(store)
    let brokenId: string | undefined = 'sid-2'
    vi.spyOn(store, 'ack').mockImplementation((id: string) => {
      if (id === brokenId) throw new Error('disk full')
      originalAck(id)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      handle.send(textMsg('m-2'), { id: 'sid-2' })
      const drained = handle.drain()
      expect(drained.map((d) => d.id)).toEqual(['sid-1', 'sid-2']) // 文本照常取回（本地取回事实成立）
      expect(store.terminals).toEqual(new Set(['sid-1'])) // 成功条目持久终局
      expect(handle.entriesFull().tombstones.map((t) => t.id)).toEqual(['sid-1'])
      const active = handle.entriesFull().active
      expect(active.map((e) => e.id)).toEqual(['sid-2']) // 失败条目留守（未终态）
      expect(active[0]!.state).toBe('failed')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('store.ack failed in drain'),
        expect.any(DeliveryAckPersistError),
      )
      brokenId = undefined // 磁盘故障恢复
      expect(handle.cancel('sid-2').kind).toBe('cancelled') // cancel 接受 failed 态：补落终局
      expect(handle.entriesFull().active).toHaveLength(0)
      expect(store.terminals.has('sid-2')).toBe(true)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('DeliveryStore 契约：persist 失败拒收（承诺未落）', () => {
  it('send：persist 抛错 → rejected(persist-failed)，条目不入队、不投递', () => {
    const { store, port } = makeStoreWithPort()
    vi.spyOn(store, 'persist').mockImplementation(() => {
      throw new Error('disk full')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      const result = handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(result).toEqual({ kind: 'rejected', reason: 'persist-failed' })
      expect(handle.depth()).toBe(0) // 未入队
      expect(port.sendCalls).toHaveLength(0) // 未投递
      expect(handle.entriesFull().active).toHaveLength(0) // 条目已回滚
      expect(store.persistOrder).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('sendChecked：persist 抛错 → 同步 throw', async () => {
    const { store, port } = makeStoreWithPort()
    vi.spyOn(store, 'persist').mockImplementation(() => {
      throw new Error('disk full')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      await expect(handle.sendChecked(textMsg('m-1'), { id: 'cid-1' })).rejects.toThrow('store.persist failed')
      expect(port.sendCalls).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('DeliveryStore 契约：失败处置的存储面（discard / 保留）', () => {
  it('forget 条目首败 → store.discard（无终局语义，防重启复活）', () => {
    const { store, port } = makeStoreWithPort({
      send: () => ({ accepted: false, reason: 'transient' }),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' }) // text 缺省 forget
      expect(store.undelivered.has('sid-1')).toBe(false) // 记录已无痕移除
      expect(store.calls.discard).toBe(1)
      expect(store.terminals.has('sid-1')).toBe(false) // 不进终局（无判重语义）
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('retain 条目首败 → store 记录保留（重启经 loadUndelivered 重入队）', () => {
    const { store, port } = makeStoreWithPort({
      send: () => ({ accepted: false, reason: 'transient' }),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' }) // custom 缺省 retain
      expect(store.undelivered.has('sid-1')).toBe(true) // 留账
      expect(store.calls.discard).toBe(0)
      expect(store.terminals.has('sid-1')).toBe(false)
      // 重启重入队读取源：loadUndelivered 返回该记录
      expect(store.loadUndelivered().map((r) => r.id)).toEqual(['sid-1'])
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('DeliveryStore 契约：loadUndelivered / loadTerminalIds（假实现视图）', () => {
  it('内存假实现差集语义：persist 进差集、ack 移入终局、discard 无痕移除', () => {
    const store = new MemoryDeliveryStore()
    store.persist({ id: 'a', lane: 'direct', payload: { kind: 'text', content: 'x' }, intent: 'interrupt-at-turn-boundary', recordedAt: 1 })
    store.persist({ id: 'b', lane: 'direct', payload: { kind: 'text', content: 'y' }, intent: 'interrupt-at-turn-boundary', recordedAt: 2 })
    expect(store.loadUndelivered().map((r) => r.id).sort()).toEqual(['a', 'b'])
    store.ack('a')
    expect(store.loadUndelivered().map((r) => r.id)).toEqual(['b'])
    expect(store.loadTerminalIds()).toEqual(['a'])
    store.discard('b')
    expect(store.loadUndelivered()).toEqual([])
    expect(store.loadTerminalIds()).toEqual(['a'])
  })
})
