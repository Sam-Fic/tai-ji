/**
 * 模型切换行的历史链路（chat-flow-v2）：pi 的 model_change entry 怎样到达 reducer，
 * 以及按窗口读取时窗口起点处的模型基线怎样补上。
 *
 * 链路：mapSessionEntries（entry → wire 伪角色 modelChange）→ liftHistoryToEntries
 *（伪角色 → 专用 entry）→ reducer（model_change case）。windowSource 让 convertWindowEntries
 * 在窗口不含文件头时补一条基线伪消息，基线由 findModelChangeBaselineBefore 从窗口第一条
 * 的真实父亲沿父链回溯得到。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ServerMessage } from '@taiji/shared'
import { forEachReversedLineChunk } from '../utils/history-reverse-read.js'
import { findModelChangeBaselineBefore } from '../infra/pi/session-model-tail-read.js'
import { mapSessionEntries } from '../infra/pi/session-entry-mapper.js'
import { convertPiHistory, liftHistoryToEntries } from '../infra/pi/message-converter.js'
import { convertWindowEntries } from '../services/session-history.js'
import type { ISessionStore } from '../services/ports/session.js'
import type { PiSessionEntry } from '../infra/pi/pi-protocol.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

let clock = 0
const stamp = () => new Date(Date.UTC(2026, 10, 27, 0, 0, 0, (clock += 1000))).toISOString()
// header 不在 PiSessionEntry 联合内（pi 类型层的已知盲区）：真实文件首行就是它，convertWindowEntries 运行时剥除
const header = () => ({ type: 'session', version: 3, id: 'sess-1', timestamp: stamp(), cwd: '/p' }) as unknown as PiSessionEntry
const modelChange = (id: string, parentId: string | null, modelId: string): PiSessionEntry => ({
  type: 'model_change',
  id,
  parentId,
  timestamp: stamp(),
  provider: 'faux',
  modelId,
})
// custom 记录的键序照 pi 落盘：customType / data 在前，id / parentId 在行尾
const dataEntry = (id: string, parentId: string): PiSessionEntry => ({ type: 'custom', customType: 'x', data: { v: 1 }, id, parentId, timestamp: stamp() })
const user = (id: string, parentId: string, text: string): PiSessionEntry => ({
  type: 'message',
  id,
  parentId,
  timestamp: stamp(),
  message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
})

/** 写一个会话文件，返回 { file, entries, offsetOf }；offsetOf(i) = 第 i 条 entry 的行首字节。 */
function writeSession(entries: PiSessionEntry[]) {
  const dir = mkdtempSync(join(tmpdir(), 'msw-history-'))
  dirs.push(dir)
  const file = join(dir, 's.jsonl')
  const lines = entries.map((e) => JSON.stringify(e))
  writeFileSync(file, lines.join('\n') + '\n')
  const offsetOf = (i: number) => Buffer.byteLength(lines.slice(0, i).join('\n') + (i > 0 ? '\n' : ''))
  return { file, entries, offsetOf }
}

const storeWith = (convertHistory: ISessionStore['convertHistory']) => ({ convertHistory }) as unknown as ISessionStore
const switchRows = (messages: ReturnType<typeof convertPiHistory>) => messages.filter((m) => m.modelSwitch !== undefined)

describe('model_change entry 到达 reducer 的链路', () => {
  it('mapSessionEntries：model_change → wire 伪角色 modelChange，entryIds 对齐', () => {
    const entry = modelChange('mc1', 'p0', 'faux-1-reasoning')
    const { messages, entryIds } = mapSessionEntries([entry])
    expect(messages).toEqual([{ role: 'modelChange', provider: 'faux', modelId: 'faux-1-reasoning', timestamp: Date.parse(entry.timestamp) }])
    expect(entryIds).toEqual(['mc1'])
  })

  it('liftHistoryToEntries：伪角色 modelChange 还原成专用 model_change entry（id / 时间 / 模型）', () => {
    const entries = liftHistoryToEntries([{ role: 'modelChange', provider: 'faux', modelId: 'faux-1-b', timestamp: 1_700_000_000_000 }], ['mc9'])
    expect(entries).toEqual([
      { type: 'model_change', id: 'mc9', parentId: null, timestamp: new Date(1_700_000_000_000).toISOString(), provider: 'faux', modelId: 'faux-1-b' },
    ])
  })

  it('整条链：初始记录不出行，真实切换出行，同模型重复不出行', () => {
    const raw = mapSessionEntries([modelChange('mc0', null, 'faux-1'), modelChange('mc1', 'mc0', 'faux-1-reasoning'), modelChange('mc2', 'mc1', 'faux-1-reasoning')])
    const rows = switchRows(convertPiHistory(raw.messages, raw.entryIds))
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('faux-1 → faux-1-reasoning')
    expect(rows[0].modelSwitch).toEqual({ provider: 'faux', modelId: 'faux-1-reasoning', previousProvider: 'faux', previousModelId: 'faux-1' })
  })
})

describe('convertWindowEntries：窗口不含文件头时补模型基线', () => {
  // 会话：初始 faux-1 → 第 1 回合后切到 faux-1-reasoning → 第 2 回合后切到 faux-1-b → 第 3 回合
  const fullSession = () => [
    header(),
    modelChange('mc0', null, 'faux-1'),
    user('u1', 'mc0', '1'),
    dataEntry('c1', 'u1'),
    modelChange('mc1', 'c1', 'faux-1-reasoning'),
    user('u2', 'mc1', '2'),
    dataEntry('c2', 'u2'),
    modelChange('mc2', 'c2', 'faux-1-b'),
    user('u3', 'mc2', '3'),
    dataEntry('c3', 'u3'),
  ]

  // 下标：0 header，1 mc0，2 u1，3 c1，4 mc1，5 u2，6 c2，7 mc2，8 u3，9 c3
  // 窗口 = [u2, c2, mc2, u3, c3]（下标 5 起）：切换记录 mc2 之前，窗口里没有更早的 model_change
  const WINDOW_START = 5

  it('传了窗口来源：切换行出行，上一模型 = 窗口起点处的生效模型', () => {
    const { file, entries, offsetOf } = writeSession(fullSession())
    const rows = switchRows(convertWindowEntries(entries.slice(WINDOW_START), storeWith(convertPiHistory), null, undefined, { filePath: file, endOffset: offsetOf(WINDOW_START) }))
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('faux-1-reasoning → faux-1-b')
    expect(rows[0].modelSwitch).toEqual({ provider: 'faux', modelId: 'faux-1-b', previousProvider: 'faux', previousModelId: 'faux-1-reasoning' })
  })

  it('不传窗口来源：窗口内首条切换记录被记成基线，不出行（补基线之前的行为）', () => {
    const { entries } = writeSession(fullSession())
    const messages = convertWindowEntries(entries.slice(WINDOW_START), storeWith(convertPiHistory))
    expect(switchRows(messages)).toHaveLength(0)
    expect(messages.map((m) => m.role)).toEqual(['user', 'user'])
  })

  it('窗口含文件头：初始记录就在窗口里，两条切换行都出行', () => {
    const { file, entries } = writeSession(fullSession())
    const rows = switchRows(convertWindowEntries(entries, storeWith(convertPiHistory), null, undefined, { filePath: file }))
    expect(rows.map((m) => m.content)).toEqual(['faux-1 → faux-1-reasoning', 'faux-1-reasoning → faux-1-b'])
  })

  it('窗口里没有切换记录：不读文件（给不存在的路径也不抛），不产出任何消息', () => {
    // [u1, c1]：没有任何 model_change
    const { entries } = writeSession(fullSession())
    const missing = join(tmpdir(), 'msw-not-exist', 's.jsonl')
    const messages = convertWindowEntries(entries.slice(2, 4), storeWith(convertPiHistory), null, undefined, { filePath: missing })
    expect(messages.map((m) => m.role)).toEqual(['user'])
  })
})

describe('findModelChangeBaselineBefore：从窗口第一条的父亲沿父链回溯', () => {
  it('线性会话：取起点之前最近一条切换记录', () => {
    const { file } = writeSession([
      header(),
      modelChange('mc0', null, 'faux-1'),
      user('u1', 'mc0', '1'),
      modelChange('mc1', 'u1', 'faux-1-reasoning'),
      user('u2', 'mc1', '2'),
      modelChange('mc2', 'u2', 'faux-1-b'),
      user('u3', 'mc2', '3'),
    ])
    expect(findModelChangeBaselineBefore(file, 'mc2')).toEqual({ provider: 'faux', modelId: 'faux-1-b' })
    expect(findModelChangeBaselineBefore(file, 'mc1')).toEqual({ provider: 'faux', modelId: 'faux-1-reasoning' })
    expect(findModelChangeBaselineBefore(file, 'mc0')).toEqual({ provider: 'faux', modelId: 'faux-1' })
  })

  it('被撤子树里的切换记录不在父链上，不会被当成基线', () => {
    // a1 之后分叉：mcB → u2old 是被撤分支；u2 是当前分支，父亲仍是 a1
    const { file } = writeSession([
      header(),
      modelChange('mc0', null, 'faux-1'),
      user('u1', 'mc0', '1'),
      dataEntry('a1', 'u1'),
      modelChange('mcB', 'a1', 'faux-1-b'),
      user('u2old', 'mcB', 'old'),
      user('u2', 'a1', '2'),
    ])
    expect(findModelChangeBaselineBefore(file, 'a1')).toEqual({ provider: 'faux', modelId: 'faux-1' })
  })

  it('endOffset：只读终点之前的内容（起点在窗口内时读不到它）', () => {
    const { file, offsetOf } = writeSession([
      header(),
      modelChange('mc0', null, 'faux-1'),
      user('u1', 'mc0', '1'),
      modelChange('mc1', 'u1', 'faux-1-reasoning'),
      user('u2', 'mc1', '2'),
    ])
    // 终点 = mc1 的行首：mc1 读不到，窗口第一条 u2 的父亲 mc1 不在已读范围 → 无基线
    expect(findModelChangeBaselineBefore(file, 'mc1', offsetOf(3))).toBeUndefined()
    // 终点 = u2 的行首：mc1 在已读范围内
    expect(findModelChangeBaselineBefore(file, 'mc1', offsetOf(4))).toEqual({ provider: 'faux', modelId: 'faux-1-reasoning' })
  })

  it('文件不存在 / 起点不是合法 id → undefined，不抛', () => {
    expect(findModelChangeBaselineBefore(join(tmpdir(), 'msw-not-exist', 's.jsonl'), 'mc1')).toBeUndefined()
    const { file } = writeSession([header(), modelChange('mc0', null, 'faux-1')])
    expect(findModelChangeBaselineBefore(file, null)).toBeUndefined()
    expect(findModelChangeBaselineBefore(file, undefined)).toBeUndefined()
  })

  it('非常规文件占位：目录与 FIFO 都按无值降级，不抛不挂（G2-1/G2-2 回归）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msw-odd-file-'))
    dirs.push(dir)
    // 目录占位（readSync EISDIR 族）
    const asDir = join(dir, 's.jsonl')
    mkdirSync(asDir)
    expect(findModelChangeBaselineBefore(asDir, 'mc1')).toBeUndefined()
    // FIFO 占位（openSync 阻塞族）——mkfifo 后立刻调用，挂起会被 vitest 超时暴露
    const asFifo = join(dir, 'f.jsonl')
    spawnSync('mkfifo', [asFifo])
    expect(findModelChangeBaselineBefore(asFifo, 'mc1')).toBeUndefined()
  })
})

describe('forEachReversedLineChunk：endOffset 只向前读到指定位置', () => {
  it('终点落在行首：只交付终点之前的完整行', () => {
    const lines = ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']
    const dir = mkdtempSync(join(tmpdir(), 'msw-reverse-'))
    dirs.push(dir)
    const file = join(dir, 'r.jsonl')
    writeFileSync(file, lines.join('\n') + '\n')
    const endOffset = Buffer.byteLength(lines.slice(0, 2).join('\n') + '\n')
    const got: string[] = []
    const summary = forEachReversedLineChunk(file, { endOffset, chunkBytes: 3 }, (chunk) => {
      got.unshift(...chunk.lines)
    })
    expect(got).toEqual(lines.slice(0, 2))
    expect(summary.sawStart).toBe(true)
    expect(summary.fullyScanned).toBe(true)
  })

  it('终点为 0：无行可交付，视为已读完整段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msw-reverse-'))
    dirs.push(dir)
    const file = join(dir, 'r.jsonl')
    writeFileSync(file, '{"n":1}\n')
    let visited = 0
    const summary = forEachReversedLineChunk(file, { endOffset: 0 }, () => {
      visited += 1
    })
    expect(visited).toBe(0)
    expect(summary).toMatchObject({ fullyScanned: true, totalBytesRead: 0 })
  })
})
