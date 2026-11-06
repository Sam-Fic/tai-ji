/**
 * font:read-bytes 纯校验与读取顺序单测（font-system RL20）。
 * 全部 IO 为注入桩；超限长度用 FontByteView 小对象表达，不创建大 fixture。
 */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}))

import {
  MAX_FONT_FILE_BYTES,
  readFontFileBytes,
  validateFontFile,
  validateFontPath,
  type FontReadIo,
} from '../font-handlers'

// agentDir 显式注入：生产缺省走 paths.ts getPiAgentDir SSOT，测试按注入的 dataDir 同构推导
const POLICY = { homeDir: '/home/tester', dataDir: '/data/taiji', agentDir: '/data/taiji/agent' }

function bytes(values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('validateFontFile 内容三关', () => {
  it.each([
    ['wOF2', 'woff2', [0x77, 0x4f, 0x46, 0x32]],
    ['wOFF', 'woff', [0x77, 0x4f, 0x46, 0x46]],
    ['OTTO', 'otf', [0x4f, 0x54, 0x54, 0x4f]],
    ['0x00010000', 'ttf', [0x00, 0x01, 0x00, 0x00]],
    ['true', 'ttf', [0x74, 0x72, 0x75, 0x65]],
  ])('%s magic + .%s → 放行', (_name, extension, magic) => {
    expect(validateFontFile(bytes([...magic, 0, 0]), `.${extension}`)).toEqual({ ok: true })
    expect(validateFontFile(bytes([0xde, 0xad, 0xbe, 0xef]), `.${extension}`).ok).toBe(false)
  })

  it('扩展名大小写与点前缀归一；非字体扩展名拒绝', () => {
    expect(validateFontFile(bytes([0, 1, 0, 0]), '.TTF')).toEqual({ ok: true })
    expect(validateFontFile(bytes([0, 1, 0, 0]), '.txt').ok).toBe(false)
  })

  it('byteLength > 20MB 拒绝；边界值仍继续校验 magic', () => {
    expect(validateFontFile({ byteLength: MAX_FONT_FILE_BYTES + 1 }, 'ttf').ok).toBe(false)
    expect(validateFontFile({ 0: 0, 1: 1, 2: 0, 3: 0, byteLength: MAX_FONT_FILE_BYTES }, 'ttf')).toEqual({ ok: true })
  })
})

describe('validateFontPath 四类凭据禁区与系统字体目录', () => {
  it.each([
    ['ssh', join(POLICY.homeDir, '.ssh', 'key.ttf'), join(POLICY.homeDir, '.ssh-other', 'ok.ttf')],
    ['aws', join(POLICY.homeDir, '.aws', 'credential.ttf'), join(POLICY.homeDir, '.aws-other', 'ok.ttf')],
    ['keychains', join(POLICY.homeDir, 'Library', 'Keychains', 'font.ttf'), join(POLICY.homeDir, 'Library', 'Fonts', 'font.ttf')],
    ['agent', join(POLICY.dataDir, 'agent', 'models.json'), join(POLICY.dataDir, 'agent-other', 'font.ttf')],
  ])('%s 目录拒绝，名称相似的兄弟目录放行', (_name, forbidden, allowed) => {
    expect(validateFontPath(forbidden, POLICY).ok).toBe(false)
    expect(validateFontPath(allowed, POLICY)).toEqual({ ok: true })
  })

  it('agent/auth.json 与 agent/sessions/*.jsonl 都拒绝；系统字体目录放行', () => {
    expect(validateFontPath(join(POLICY.dataDir, 'agent', 'auth.json'), POLICY).ok).toBe(false)
    expect(validateFontPath(join(POLICY.dataDir, 'agent', 'sessions', 'x.jsonl'), POLICY).ok).toBe(false)
    expect(validateFontPath('/Library/Fonts/font.ttf', POLICY)).toEqual({ ok: true })
    expect(validateFontPath('/System/Library/Fonts/font.ttf', POLICY)).toEqual({ ok: true })
  })

  it('相对路径拒绝', () => {
    expect(validateFontPath('fonts/font.ttf', POLICY).ok).toBe(false)
  })
})

describe('readFontFileBytes 读取顺序', () => {
  function makeIo(size: number): FontReadIo {
    return {
      realpath: vi.fn(async (path: string) => path),
      stat: vi.fn(async () => ({ size, isFile: () => true })),
      readFile: vi.fn(async () => bytes([0, 1, 0, 0])),
    }
  }

  it('stat 发现超限 → 拒绝且不调用 readFile', async () => {
    const io = makeIo(MAX_FONT_FILE_BYTES + 1)
    const result = await readFontFileBytes('/fonts/too-large.ttf', { io, policy: POLICY })
    expect(result.ok).toBe(false)
    expect(io.stat).toHaveBeenCalledTimes(1)
    expect(io.readFile).not.toHaveBeenCalled()
  })

  it('realpath 指向禁区 → stat/readFile 均不调用', async () => {
    const io = makeIo(4)
    io.realpath = vi.fn(async () => join(POLICY.homeDir, '.ssh', 'font.ttf'))
    const result = await readFontFileBytes('/fonts/link.ttf', { io, policy: POLICY })
    expect(result.ok).toBe(false)
    expect(io.stat).not.toHaveBeenCalled()
    expect(io.readFile).not.toHaveBeenCalled()
  })

  it('合法文件 → realpath/stat/readFile 各一次并返回字节', async () => {
    const io = makeIo(4)
    const result = await readFontFileBytes('/fonts/valid.ttf', { io, policy: POLICY })
    expect(result).toEqual({ ok: true, bytes: bytes([0, 1, 0, 0]) })
    expect(io.realpath).toHaveBeenCalledTimes(1)
    expect(io.stat).toHaveBeenCalledTimes(1)
    expect(io.readFile).toHaveBeenCalledTimes(1)
  })
})
