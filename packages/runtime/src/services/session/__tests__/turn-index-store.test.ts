/**
 * turn 边界索引 sidecar 存储测试（turn-boundary-index RL2/RL3/RL5 单测层）。
 *
 * 覆盖（任务书验收②全集）：首次建索引落盘与逐字段口径、零 turn 合法落盘、残尾续扫、
 * 末 turn 长度同步延长、追加续扫不落盘（写入点全集①）、touch / size 变小 / 校验失配
 * 重建（含边界解析失败与非 user 对象）、版本不支持与结构损坏分类重建、tmp 残留忽略、
 * 内存 LRU 上限 8 与命中、在途合并、取消标记拒绝无 await 提交段、onSessionDisposed
 * 对照、落盘失败降级。fixture 均 mkdtempSync 自建自删；路径经构造注入 indexFileOf
 * 隔离（不触共享推导路径——TEST-STRATEGY 测试数据隔离防线）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { parseTurnIndexContent, TURN_INDEX_VERSION } from '../../../infra/pi/turn-index-types.js'
import { scanTurnBoundariesForward, verifyTurnBoundaries } from '../../../infra/pi/turn-index-scanner.js'
import { TURN_INDEX_MEMORY_LIMIT, TURN_INDEX_TMP_SUFFIX, TurnIndexStore } from '../turn-index-store.js'

let root = ''
let store: TurnIndexStore
let warnSpy: MockInstance

/** sessionId → turns.json 推导（测试注入：落 mkdtemp 根，不触 getDataDir 共享树）。 */
const indexFileOf = (sessionId: string): string => join(root, sessionId, 'history-index', 'turns.json')

/**
 * 扫描 port 生产同源装配（组合根 index.ts 同款同名函数简写——scanner 经构造注入后，
 * services 层不再 value import infra 实现，测试直 import infra 装配同源行为）。
 */
const scanner = { scanTurnBoundariesForward, verifyTurnBoundaries }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'turn-index-store-'))
  store = new TurnIndexStore({ indexFileOf, scanner })
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function userJson(id: string, content: string): string {
  return JSON.stringify({ type: 'message', id, message: { role: 'user', content } })
}

function otherJson(role: string, content: string): string {
  return JSON.stringify({ type: 'message', message: { role, content } })
}

function headJson(sid: string): string {
  return JSON.stringify({ type: 'session', id: sid })
}

function writeJsonl(sid: string, lines: string[]): string {
  const file = join(root, `${sid}.jsonl`)
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function appendJsonl(file: string, lines: string[]): void {
  const existing = readFileSync(file, 'utf-8')
  writeFileSync(file, existing + lines.join('\n') + '\n')
}

function readPersisted(sid: string): string {
  return readFileSync(indexFileOf(sid), 'utf-8')
}

function expectPersistedOk(sid: string): Extract<ReturnType<typeof parseTurnIndexContent>, { ok: true }> {
  const parsed = parseTurnIndexContent(readPersisted(sid))
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error('persisted turns.json failed guard — see preceding expect')
  return parsed
}

describe('首次建索引与落盘口径（§3.1 存储与格式）', () => {
  it('完整构建落盘：turns.json 逐字段符合设计（version / fileSize / mtimeMs / scannedOffset / turns）', async () => {
    const lines = [
      headJson('s1'),
      userJson('u1', 'first'),
      otherJson('assistant', 'reply-a'),
      userJson('u2', 'second'),
      otherJson('assistant', 'reply-b'),
    ]
    const file = writeJsonl('s1', lines)
    const snapshot = await store.ensureFresh('s1', file)
    expect(snapshot).not.toBeNull()
    const persisted = expectPersistedOk('s1')
    expect(persisted.index.version).toBe(TURN_INDEX_VERSION)
    const st = statSync(file)
    expect(persisted.index.fileSize).toBe(st.size)
    expect(persisted.index.mtimeMs).toBe(st.mtimeMs)
    expect(persisted.index.scannedOffset).toBe(st.size)
    expect(persisted.index.turns.map((t) => t.entryId)).toEqual(['u1', 'u2'])
    // budgetBytes 对齐尾读口径（边界行计入、不含换行）；byteLength 含换行、止于下一边界行首
    expect(persisted.index.turns[0]!.budgetBytes).toBe(
      Buffer.byteLength(lines[1]!, 'utf-8') + Buffer.byteLength(lines[2]!, 'utf-8'),
    )
    expect(persisted.index.turns[0]!.byteOffset + persisted.index.turns[0]!.byteLength).toBe(
      persisted.index.turns[1]!.byteOffset,
    )
    // 快照与落盘一致；紧凑序列化（无空白的 JSON.stringify 形态）
    expect(snapshot!.turns).toEqual(persisted.index.turns)
    expect(snapshot!.fileSize).toBe(persisted.index.fileSize)
    expect(snapshot!.scannedOffset).toBe(persisted.index.scannedOffset)
    expect(readPersisted('s1')).not.toContain(', ')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('零 turn 合法落盘（仅 assistant 的文件）且走完整构建路径', async () => {
    const file = writeJsonl('s-empty', [headJson('s-empty'), otherJson('assistant', 'only')])
    const snapshot = await store.ensureFresh('s-empty', file)
    expect(snapshot!.turns).toEqual([])
    expect(snapshot!.scannedOffset).toBe(statSync(file).size)
    const persisted = expectPersistedOk('s-empty')
    expect(persisted.index.turns).toEqual([])
  })

  it('主文件 ENOENT 返回 null（空页语义），不写任何索引文件', async () => {
    const missing = join(root, 'missing.jsonl')
    expect(await store.ensureFresh('s-missing', missing)).toBeNull()
    expect(existsSync(indexFileOf('s-missing'))).toBe(false)
  })
})

describe('增量与失效（RL3 / RL2）', () => {
  it('残尾续扫：残尾不产 turn、落盘 scannedOffset < fileSize；补全后从原残尾起点续扫不重复不漏新', async () => {
    const base = [headJson('s-res'), userJson('u1', 'one'), otherJson('assistant', 'r1')]
    const u2Line = userJson('u2', 'two')
    const partial = u2Line.slice(0, 14)
    const file = join(root, 's-res.jsonl')
    writeFileSync(file, base.join('\n') + '\n' + partial)
    const first = await store.ensureFresh('s-res', file)
    expect(first!.turns.map((t) => t.entryId)).toEqual(['u1'])
    expect(first!.scannedOffset).toBeLessThan(statSync(file).size)
    // 补全残行 + 追加 assistant 行，重读：从残尾起点续扫，u2 恰好入账一次
    const full = base.join('\n') + '\n' + u2Line + '\n' + otherJson('assistant', 'r2') + '\n'
    writeFileSync(file, full)
    const second = await store.ensureFresh('s-res', file)
    expect(second!.turns.map((t) => t.entryId)).toEqual(['u1', 'u2'])
    expect(second!.turns[1]!.budgetBytes).toBe(
      Buffer.byteLength(u2Line, 'utf-8') + Buffer.byteLength(otherJson('assistant', 'r2'), 'utf-8'),
    )
    expect(second!.scannedOffset).toBe(Buffer.byteLength(full, 'utf-8'))
    // u1 的记录不被续扫改写
    expect(second!.turns[0]).toEqual(first!.turns[0]!)
  })

  it('追加续扫只更新内存不落盘：末 turn 长度同步延长，磁盘 turns.json 停留上次完整构建快照', async () => {
    const file = writeJsonl('s-append', [headJson('s-append'), userJson('u1', 'one'), otherJson('assistant', 'r1')])
    const first = await store.ensureFresh('s-append', file)
    const persistedBefore = readPersisted('s-append')
    const extra = otherJson('assistant', 'r1-extra')
    appendJsonl(file, [extra])
    const second = await store.ensureFresh('s-append', file)
    expect(second!.turns[0]!.budgetBytes).toBe(first!.turns[0]!.budgetBytes + Buffer.byteLength(extra, 'utf-8'))
    expect(second!.turns[0]!.byteLength).toBe(first!.turns[0]!.byteLength + Buffer.byteLength(extra, 'utf-8') + 1)
    // 写入点全集①：续扫不回写，磁盘字节不变
    expect(readPersisted('s-append')).toBe(persistedBefore)
  })

  it('size 不变而 mtime 变化按 touch 重建：分类计数 + 落盘刷新为新 stat 快照', async () => {
    const file = writeJsonl('s-touch', [headJson('s-touch'), userJson('u1', 'one'), otherJson('assistant', 'aaaa')])
    await store.ensureFresh('s-touch', file)
    // 同尺寸重写（等长替换内容）+ 显式设置新 mtime（确定性 touch 信号）
    writeFileSync(file, [headJson('s-touch'), userJson('u1', 'one'), otherJson('assistant', 'bbbb')].join('\n') + '\n')
    const future = new Date(Date.now() + 5000)
    utimesSync(file, future, future)
    const snapshot = await store.ensureFresh('s-touch', file)
    expect(snapshot!.mtimeMs).toBe(statSync(file).mtimeMs)
    const counters = store.getRebuildCounters('s-touch')!
    expect(counters.rebuilds.touch).toBe(1)
    expect(counters.rebuilds.mismatch).toBeUndefined()
    // touch 重建属完整重建：落盘刷新
    expect(expectPersistedOk('s-touch').index.mtimeMs).toBe(statSync(file).mtimeMs)
  })

  it('size 变小按 mismatch 全量重建：分类计数 + 落盘刷新为新文件形态', async () => {
    const file = writeJsonl('s-shrink', [headJson('s-shrink'), userJson('u1', 'one'), userJson('u2', 'two')])
    await store.ensureFresh('s-shrink', file)
    writeFileSync(file, [headJson('s-shrink'), userJson('u1', 'only')].join('\n') + '\n')
    const snapshot = await store.ensureFresh('s-shrink', file)
    expect(snapshot!.turns.map((t) => t.entryId)).toEqual(['u1'])
    expect(store.getRebuildCounters('s-shrink')!.rebuilds.mismatch).toBe(1)
    expect(expectPersistedOk('s-shrink').index.turns.map((t) => t.entryId)).toEqual(['u1'])
  })

  describe('rebuildAfterMismatch（实际 entryId 校验失败的重建承接，SI4）', () => {
    it('边界行被重写为非 user 对象后全量重建并刷新落盘', async () => {
      const file = writeJsonl('s-role', [headJson('s-role'), userJson('u1', 'one'), otherJson('assistant', 'r1')])
      await store.ensureFresh('s-role', file)
      writeFileSync(file, [headJson('s-role'), otherJson('assistant', 'impostor'), userJson('u2', 'later')].join('\n') + '\n')
      const snapshot = await store.rebuildAfterMismatch('s-role', file, 'verify failed: not-user-boundary at index 0')
      expect(snapshot!.turns.map((t) => t.entryId)).toEqual(['u2'])
      expect(store.getRebuildCounters('s-role')!.rebuilds.mismatch).toBe(1)
      expect(expectPersistedOk('s-role').index.turns.map((t) => t.entryId)).toEqual(['u2'])
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not-user-boundary'))
    })

    it('边界行解析失败（残缺 JSON 重写）同样全量重建', async () => {
      const file = writeJsonl('s-parse', [headJson('s-parse'), userJson('u1', 'one')])
      await store.ensureFresh('s-parse', file)
      writeFileSync(file, '{broken json\n' + userJson('u9', 'still here') + '\n')
      const snapshot = await store.rebuildAfterMismatch('s-parse', file, 'verify failed: parse-failed at index 0')
      // 坏行不再是边界，后续合法 user 行开新 turn
      expect(snapshot!.turns.map((t) => t.entryId)).toEqual(['u9'])
      expect(store.getRebuildCounters('s-parse')!.rebuilds.mismatch).toBe(1)
    })
  })

  it('新实例读合法 sidecar 且 stat 不变：复用不重建（重启后读盘路径）', async () => {
    const file = writeJsonl('s-reuse', [headJson('s-reuse'), userJson('u1', 'one'), otherJson('assistant', 'r1')])
    const builder = new TurnIndexStore({ indexFileOf, scanner })
    const built = await builder.ensureFresh('s-reuse', file)
    const reader = new TurnIndexStore({ indexFileOf, scanner })
    const snapshot = await reader.ensureFresh('s-reuse', file)
    expect(snapshot!.turns).toEqual(built!.turns)
    const counters = reader.getRebuildCounters('s-reuse')!
    expect(counters.reads).toBe(1)
    expect(counters.rebuilds.corrupted).toBeUndefined()
    expect(counters.rebuilds.touch).toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('sidecar 版本不支持按 unsupported-version 分类重建并按当前版本重新落盘', async () => {
    const file = writeJsonl('s-ver', [headJson('s-ver'), userJson('u1', 'one')])
    const builder = new TurnIndexStore({ indexFileOf, scanner })
    await builder.ensureFresh('s-ver', file)
    mkdirSync(dirname(indexFileOf('s-ver')), { recursive: true })
    writeFileSync(indexFileOf('s-ver'), JSON.stringify({ version: 99, fileSize: 1, mtimeMs: 0, scannedOffset: 0, turns: [] }))
    const reader = new TurnIndexStore({ indexFileOf, scanner })
    const snapshot = await reader.ensureFresh('s-ver', file)
    expect(snapshot!.turns.map((t) => t.entryId)).toEqual(['u1'])
    expect(reader.getRebuildCounters('s-ver')!.rebuilds['unsupported-version']).toBe(1)
    expect(expectPersistedOk('s-ver').index.version).toBe(TURN_INDEX_VERSION)
  })

  it.each([
    ['顶层非 object', '[1,2]'],
    ['非 JSON 文本', 'not-json-at-all'],
    ['scannedOffset 越出文件', JSON.stringify({ version: 1, fileSize: 1, mtimeMs: 0, scannedOffset: 5, turns: [] })],
    ['turns 元素字段非法', JSON.stringify({ version: 1, fileSize: 9, mtimeMs: 0, scannedOffset: 9, turns: [{ entryId: '', byteOffset: 0, byteLength: 0, budgetBytes: 0 }] })],
    ['byteOffset 非严格递增', JSON.stringify({ version: 1, fileSize: 9, mtimeMs: 0, scannedOffset: 9, turns: [{ entryId: 'a', byteOffset: 5, byteLength: 1, budgetBytes: 1 }, { entryId: 'b', byteOffset: 5, byteLength: 1, budgetBytes: 1 }] })],
    ['turns 非数组', JSON.stringify({ version: 1, fileSize: 0, mtimeMs: 0, scannedOffset: 0, turns: 'nope' })],
  ])('sidecar 结构损坏（%s）按 corrupted 分类重建并恢复落盘', async (_label, raw) => {
    const file = writeJsonl('s-corrupt', [headJson('s-corrupt'), userJson('u1', 'one')])
    const builder = new TurnIndexStore({ indexFileOf, scanner })
    await builder.ensureFresh('s-corrupt', file)
    writeFileSync(indexFileOf('s-corrupt'), raw)
    const reader = new TurnIndexStore({ indexFileOf, scanner })
    const snapshot = await reader.ensureFresh('s-corrupt', file)
    expect(snapshot!.turns.map((t) => t.entryId)).toEqual(['u1'])
    expect(reader.getRebuildCounters('s-corrupt')!.rebuilds.corrupted).toBe(1)
    expect(expectPersistedOk('s-corrupt').index.turns.map((t) => t.entryId)).toEqual(['u1'])
  })
})

describe('残留处置与生命周期（RL5）', () => {
  it('turns.json 缺失而 .tmp 残留时视为无索引：正常构建提交并覆盖残留', async () => {
    const file = writeJsonl('s-tmp', [headJson('s-tmp'), userJson('u1', 'one')])
    mkdirSync(dirname(indexFileOf('s-tmp')), { recursive: true })
    writeFileSync(indexFileOf('s-tmp') + TURN_INDEX_TMP_SUFFIX, 'crash residue')
    const snapshot = await store.ensureFresh('s-tmp', file)
    expect(snapshot).not.toBeNull()
    expect(expectPersistedOk('s-tmp').index.turns.map((t) => t.entryId)).toEqual(['u1'])
    expect(existsSync(indexFileOf('s-tmp') + TURN_INDEX_TMP_SUFFIX)).toBe(false)
  })

  it('onSessionDeleted 后 ensureFresh 返回 null 且无写回（取消标记拒绝无 await 提交段）', async () => {
    const file = writeJsonl('s-del', [headJson('s-del'), userJson('u1', 'one')])
    store.onSessionDeleted('s-del')
    expect(await store.ensureFresh('s-del', file)).toBeNull()
    expect(existsSync(indexFileOf('s-del'))).toBe(false)
    expect(existsSync(indexFileOf('s-del') + TURN_INDEX_TMP_SUFFIX)).toBe(false)
    expect(await store.rebuildAfterMismatch('s-del', file, 'post-delete verify')).toBeNull()
  })

  it('在途构建期间真删除：提交段复检取消标记拒绝写回，请求按空页收尾', async () => {
    const file = writeJsonl('s-race', [headJson('s-race'), userJson('u1', 'one')])
    const pending = store.ensureFresh('s-race', file)
    // 同步落标记：提交段的复检在 await 链之后执行，必然晚于本调用（构造性时序）
    store.onSessionDeleted('s-race')
    expect(await pending).toBeNull()
    expect(existsSync(indexFileOf('s-race'))).toBe(false)
    expect(existsSync(indexFileOf('s-race') + TURN_INDEX_TMP_SUFFIX)).toBe(false)
  })

  it('onSessionDisposed 只清内存不取消读取：构建照常完成并落盘', async () => {
    const file = writeJsonl('s-dispose', [headJson('s-dispose'), userJson('u1', 'one')])
    const pending = store.ensureFresh('s-dispose', file)
    store.onSessionDisposed('s-dispose')
    const snapshot = await pending
    expect(snapshot).not.toBeNull()
    expect(expectPersistedOk('s-dispose').index.turns.map((t) => t.entryId)).toEqual(['u1'])
    expect(store.hasMemoryIndex('s-dispose')).toBe(true)
  })

  it('落盘失败只损失加速能力：快照仍由内存返回且 warn 含恢复动作', async () => {
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'occupied by a regular file')
    const file = writeJsonl('s-nowrite', [headJson('s-nowrite'), userJson('u1', 'one')])
    // indexFileOf 落在普通文件之下 → mkdir/write 必失败
    const blocked = new TurnIndexStore({ indexFileOf: () => join(blocker, 'history-index', 'turns.json'), scanner })
    const snapshot = await blocked.ensureFresh('s-nowrite', file)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.turns.map((t) => t.entryId)).toEqual(['u1'])
    expect(blocked.hasMemoryIndex('s-nowrite')).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('恢复动作'))
  })
})

describe('内存 LRU 与在途合并', () => {
  it('LRU 上限 8：第 9 个会话驱逐最旧条目', async () => {
    const files = new Map<string, string>()
    for (let i = 0; i < TURN_INDEX_MEMORY_LIMIT; i++) {
      const sid = `s-lru-${i}`
      files.set(sid, writeJsonl(sid, [headJson(sid), userJson('u1', 'one')]))
    }
    for (const [sid, file] of files) await store.ensureFresh(sid, file)
    expect(store.getMemoryCachedCount()).toBe(TURN_INDEX_MEMORY_LIMIT)
    expect(store.hasMemoryIndex('s-lru-0')).toBe(true)
    files.set('s-lru-9', writeJsonl('s-lru-9', [headJson('s-lru-9'), userJson('u1', 'one')]))
    await store.ensureFresh('s-lru-9', files.get('s-lru-9')!)
    expect(store.getMemoryCachedCount()).toBe(TURN_INDEX_MEMORY_LIMIT)
    expect(store.hasMemoryIndex('s-lru-0')).toBe(false)
    expect(store.hasMemoryIndex('s-lru-1')).toBe(true)
  })

  it('内存命中时不读 sidecar（stat 未变直接复用，坏落盘文件被无视）', async () => {
    const file = writeJsonl('s-hit', [headJson('s-hit'), userJson('u1', 'one')])
    await store.ensureFresh('s-hit', file)
    writeFileSync(indexFileOf('s-hit'), 'corrupted garbage')
    const snapshot = await store.ensureFresh('s-hit', file)
    expect(snapshot!.turns.map((t) => t.entryId)).toEqual(['u1'])
    expect(store.getRebuildCounters('s-hit')!.rebuilds.corrupted).toBeUndefined()
  })

  it('并发 ensureFresh 合并在途编排：两次调用同一结果，reads 只计一次', async () => {
    const file = writeJsonl('s-inflight', [headJson('s-inflight'), userJson('u1', 'one')])
    const [a, b] = await Promise.all([store.ensureFresh('s-inflight', file), store.ensureFresh('s-inflight', file)])
    expect(a).toEqual(b)
    expect(store.getRebuildCounters('s-inflight')!.reads).toBe(1)
  })
})
