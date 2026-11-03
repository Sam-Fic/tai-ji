/**
 * turn 边界索引正序分块扫描器测试（turn-boundary-index RL2/RL3 单测层）。
 *
 * 覆盖：全量扫描的物理/预算口径、跨块行拼接与多字节 UTF-8 安全、残尾保守位置、
 * 续扫（末 turn 延长 + 新边界开新记录）、重写缩小竞态的透传形态、空文件 / 无 user
 * turn、文件打开失败，以及 verifyTurnBoundaries 的三分类失配（RL2 的校验原语层）。
 * fixture 均为 mkdtempSync 自建自删的几行小文件（TEST-STRATEGY 新写测试判据第②档：
 * 异步有确定性完成信号）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanTurnBoundariesForward, verifyTurnBoundaries } from '../turn-index-scanner.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'turn-index-scanner-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** pi session JSONL 行构造（scanner 收窄口径：type=message + message.role=user + 非空 string id）。 */
function userJson(id: string, content: string): string {
  return JSON.stringify({ type: 'message', id, message: { role: 'user', content } })
}

/** 非边界行（assistant / toolResult 同形态：无 string id 的 user 判定外行都延长当前 turn）。 */
function otherJson(role: string, content: string): string {
  return JSON.stringify({ type: 'message', message: { role, content } })
}

/** session header（首条 turn 之前的前导段：不建记录）。 */
function headJson(sid: string): string {
  return JSON.stringify({ type: 'session', id: sid })
}

function writeJsonl(name: string, lines: string[]): string {
  const file = join(root, name)
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf-8')
}

describe('scanTurnBoundariesForward 全量扫描', () => {
  it('user 边界开新 turn、其余行延长当前 turn，物理与预算口径逐字段成立', async () => {
    const lines = [
      headJson('sess-head'),
      userJson('u1', 'first'),
      otherJson('assistant', 'reply-a'),
      otherJson('toolResult', 'tool-out'),
      userJson('u2', 'second'),
      otherJson('assistant', 'reply-b'),
      userJson('u3', 'third'),
      otherJson('assistant', 'reply-c'),
    ]
    const file = writeJsonl('session.jsonl', lines)
    const result = await scanTurnBoundariesForward(file)
    expect(result).not.toBeNull()
    const { turns, scannedOffset } = result!
    expect(turns.map((t) => t.entryId)).toEqual(['u1', 'u2', 'u3'])
    expect(turns).toHaveLength(3)
    // 物理不变量：turn N 的 [byteOffset, byteOffset+byteLength) 恰到下一边界行首；末 turn 截到已扫完整行末尾
    let cursor = bytes(lines[0]!) + 1
    for (let i = 0; i < turns.length; i++) {
      expect(turns[i]!.byteOffset).toBe(cursor)
      cursor = turns[i]!.byteOffset + turns[i]!.byteLength
      if (i + 1 < turns.length) expect(cursor).toBe(turns[i + 1]!.byteOffset)
    }
    expect(cursor).toBe(scannedOffset)
    expect(scannedOffset).toBe(bytes(lines.join('\n') + '\n'))
    // budgetBytes 对齐尾读口径（session-history.ts collectLineIntoWindow：边界行入列即按
    // Buffer.byteLength 累计、不计行尾换行）——turn1 = 边界行 + assistant + toolResult
    expect(turns[0]!.budgetBytes).toBe(bytes(lines[1]!) + bytes(lines[2]!) + bytes(lines[3]!))
    expect(turns[0]!.byteLength).toBe(turns[0]!.budgetBytes + 3)
    // 前导段不建记录，首 turn 从其边界行首开始（前导段字节由「窗口包含首 turn 时从 byte 0 读」覆盖）
    expect(turns[0]!.byteOffset).toBe(bytes(lines[0]!) + 1)
  })

  it('小块扫描跨块行拼接正确，且与整块结果一致（多字节 UTF-8 行内安全）', async () => {
    const lines = [
      userJson('u1', '中文内容——多字节字符跨块不得产 U+FFFD'),
      otherJson('assistant', 'réponse avec accents 与更多中文'),
      userJson('u2', 'второй turn'),
    ]
    const file = writeJsonl('utf8.jsonl', lines)
    const chunked = await scanTurnBoundariesForward(file, undefined, { chunkBytes: 7 })
    const whole = await scanTurnBoundariesForward(file)
    expect(chunked).toEqual(whole)
    expect(chunked!.turns.map((t) => t.entryId)).toEqual(['u1', 'u2'])
    expect(chunked!.turns[0]!.byteOffset).toBe(0)
  })
})

describe('scanTurnBoundariesForward 残尾与续扫（RL3）', () => {
  it('残尾停在最后完整换行之后，半截行不产 turn 也不入预算', async () => {
    const complete = [userJson('u1', 'one'), otherJson('assistant', 'x')]
    const partial = userJson('u2', 'half-written').slice(0, 18)
    const file = join(root, 'residue.jsonl')
    const text = complete.join('\n') + '\n' + partial
    writeFileSync(file, text)
    const result = await scanTurnBoundariesForward(file)
    expect(result!.turns.map((t) => t.entryId)).toEqual(['u1'])
    expect(result!.scannedOffset).toBe(bytes(complete.join('\n') + '\n'))
    expect(result!.scannedOffset).toBeLessThan(bytes(text))
    // 残尾行字节未计入任何 turn（末 turn 长度恰止于最后一个完整换行）
    expect(result!.turns[0]!.byteOffset + result!.turns[0]!.byteLength).toBe(result!.scannedOffset)
  })

  it('续扫：先延长当前末 turn 的物理与预算长度，遇新 user 边界开新记录且旧末 turn 不越过新边界', async () => {
    const initial = [userJson('u1', 'one'), otherJson('assistant', 'r1'), userJson('u2', 'two'), otherJson('assistant', 'r2')]
    const file = writeJsonl('resume.jsonl', initial)
    const first = await scanTurnBoundariesForward(file)
    expect(first!.turns).toHaveLength(2)
    const appended = [otherJson('assistant', 'r2-extra'), userJson('u3', 'three'), otherJson('assistant', 'r3')]
    writeFileSync(file, initial.join('\n') + '\n' + appended.join('\n') + '\n')
    const resumed = await scanTurnBoundariesForward(file, {
      startOffset: first!.scannedOffset,
      priorTurns: first!.turns,
    })
    expect(resumed!.turns.map((t) => t.entryId)).toEqual(['u1', 'u2', 'u3'])
    // u2 被追加行延长：恰止于 u3 边界行首（不越过新边界），预算含新增行
    expect(resumed!.turns[1]!.byteOffset + resumed!.turns[1]!.byteLength).toBe(resumed!.turns[2]!.byteOffset)
    expect(resumed!.turns[1]!.budgetBytes).toBe(
      bytes(initial[2]!) + bytes(initial[3]!) + bytes(appended[0]!),
    )
    // 末 turn 截到已扫完整行末尾
    expect(resumed!.turns[2]!.byteOffset + resumed!.turns[2]!.byteLength).toBe(resumed!.scannedOffset)
    // 入参不被修改（priorTurns 深拷贝）
    expect(first!.turns[1]!.byteLength).toBeLessThan(resumed!.turns[1]!.byteLength)
  })

  it('startOffset 超出当前文件大小时无迭代返回且原样透传（重写缩小竞态由调用方 stat 判定裁决）', async () => {
    const file = writeJsonl('shrunk.jsonl', [userJson('u1', 'one')])
    const result = await scanTurnBoundariesForward(file, { startOffset: 9999, priorTurns: [] })
    expect(result!.turns).toEqual([])
    expect(result!.scannedOffset).toBe(9999)
  })
})

describe('scanTurnBoundariesForward 边界输入', () => {
  it('空文件返回空 turns；无 user turn 的文件不建记录但推进 scannedOffset', async () => {
    const empty = join(root, 'empty.jsonl')
    writeFileSync(empty, '')
    expect(await scanTurnBoundariesForward(empty)).toEqual({ turns: [], scannedOffset: 0, observedSize: 0 })
    const onlyAssistant = [otherJson('assistant', 'only')]
    const file = writeJsonl('no-user.jsonl', onlyAssistant)
    const result = await scanTurnBoundariesForward(file)
    expect(result!.turns).toEqual([])
    expect(result!.scannedOffset).toBe(bytes(onlyAssistant.join('\n') + '\n'))
  })

  it('畸形行（坏 JSON / 非 object / 无 id 的 user 行）按普通行降级留在当前 turn', async () => {
    const lines = [
      userJson('u1', 'one'),
      '{broken json',
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'no-id' } }),
      otherJson('assistant', 'tail'),
    ]
    const file = writeJsonl('malformed.jsonl', lines)
    const result = await scanTurnBoundariesForward(file)
    expect(result!.turns.map((t) => t.entryId)).toEqual(['u1'])
    expect(result!.turns[0]!.budgetBytes).toBe(
      bytes(lines[0]!) + bytes(lines[1]!) + bytes(lines[2]!) + bytes(lines[3]!),
    )
  })

  it('文件打开失败返回 null（ENOENT 不抛）', async () => {
    expect(await scanTurnBoundariesForward(join(root, 'missing.jsonl'))).toBeNull()
  })
})

describe('verifyTurnBoundaries（RL2 校验原语）', () => {
  it('记录与实际边界精确相等时 ok', async () => {
    const file = writeJsonl('verify-ok.jsonl', [userJson('u1', 'one'), otherJson('assistant', 'x'), userJson('u2', 'two')])
    const scan = await scanTurnBoundariesForward(file)
    expect(await verifyTurnBoundaries(file, scan!.turns)).toEqual({ ok: true })
  })

  it('边界行解析失败按 parse-failed 报告（含下标与期望 id）', async () => {
    const bad = '{broken json'
    const file = writeJsonl('verify-parse.jsonl', [bad, otherJson('assistant', 'x')])
    const failure = await verifyTurnBoundaries(file, [
      { entryId: 'u1', byteOffset: 0, byteLength: bytes(bad) + 1, budgetBytes: bytes(bad) },
    ])
    expect(failure).toEqual({ ok: false, index: 0, reason: 'parse-failed', expected: 'u1' })
  })

  it('边界位置是非 user 对象按 not-user-boundary 报告', async () => {
    const impostor = otherJson('assistant', 'reply')
    const file = writeJsonl('verify-role.jsonl', [impostor, userJson('u9', 'later')])
    const failure = await verifyTurnBoundaries(file, [
      { entryId: 'u1', byteOffset: 0, byteLength: bytes(impostor) + 1, budgetBytes: bytes(impostor) },
    ])
    expect(failure).toEqual({ ok: false, index: 0, reason: 'not-user-boundary', expected: 'u1' })
  })

  it('entryId 不符按 entry-id-mismatch 报告（同尺寸重写攻击形态，SI4）', async () => {
    const rewritten = userJson('real-id', 'rewritten')
    const file = writeJsonl('verify-id.jsonl', [rewritten])
    const failure = await verifyTurnBoundaries(file, [
      { entryId: 'old-id', byteOffset: 0, byteLength: bytes(rewritten) + 1, budgetBytes: bytes(rewritten) },
    ])
    expect(failure).toEqual({ ok: false, index: 0, reason: 'entry-id-mismatch', expected: 'old-id' })
  })

  it('空校验集合直接 ok；文件打开失败按首记录 parse-failed 收敛', async () => {
    const missing = join(root, 'missing.jsonl')
    expect(await verifyTurnBoundaries(missing, [])).toEqual({ ok: true })
    expect(await verifyTurnBoundaries(missing, [
      { entryId: 'u1', byteOffset: 0, byteLength: 1, budgetBytes: 1 },
    ])).toEqual({ ok: false, index: 0, reason: 'parse-failed', expected: 'u1' })
  })
})
