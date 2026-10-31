/**
 * pi 会话 header 版本防御测试（startup 设计 §7.2「pi 格式版本防御」，终态同步修复 design-code-sync R1 G3〔§7.2 pi 格式版本防御条款〕）。
 *
 * 必测断言（设计条款：解析器读 pi 会话文件的版本标记，遇到不认识版本 → 显式告警计数，
 * 替代静默降级）：
 * - header version 高于已知最高（实测现行 3）：console.warn 出声 + 计数登记；
 *   header 本身仍宽松解析返回（字段守卫照常，不因版本未知产出 null）
 * - 同版本多文件：warn 按版本去重（扫描热路径防刷屏），计数持续累计
 * - version ≤ 已知最高（历史 1 在档可读）与缺 version 字段：安静，零计数
 *
 * fixture：mkdtempSync 自建自删（fs-guard 白名单 tmpdir），header 首行 + 一条占位 entry。
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/session-file-utils-header-version.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  _resetSessionHeaderVersionWarnForTest,
  getSessionHeaderUnknownVersionCounts,
  parseSessionHeader,
} from '../session-file-utils.js'

let tmpDir: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'header-version-'))
  _resetSessionHeaderVersionWarnForTest()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function writeHeader(name: string, headerJson: string): string {
  const filePath = join(tmpDir, name)
  writeFileSync(filePath, `${headerJson}\n{"type":"message","id":"e1"}\n`, 'utf-8')
  return filePath
}

describe('parseSessionHeader 版本防御（startup 设计 §7.2）', () => {
  it('version 高于已知最高：告警一次 + 计数登记，header 仍宽松解析返回（不静默 null）', () => {
    const filePath = writeHeader(
      'v4.jsonl',
      '{"type":"session","version":4,"id":"s-v4","cwd":"/w","timestamp":"2026-10-31T00:00:00.000Z"}',
    )
    const header = parseSessionHeader(filePath)
    expect(header).not.toBeNull()
    expect(header?.id).toBe('s-v4')
    expect(getSessionHeaderUnknownVersionCounts().get(4)).toBe(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('version 4')
  })

  it('同版本多文件：warn 按版本去重只出声一次，计数持续累计', () => {
    for (const name of ['a.jsonl', 'b.jsonl', 'c.jsonl']) {
      expect(parseSessionHeader(writeHeader(name, '{"type":"session","version":5,"id":"s-x"}'))).not.toBeNull()
    }
    expect(getSessionHeaderUnknownVersionCounts().get(5)).toBe(3)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('不同未知版本各告警一次，计数按版本分列', () => {
    expect(parseSessionHeader(writeHeader('a.jsonl', '{"type":"session","version":4,"id":"s-a"}'))).not.toBeNull()
    expect(parseSessionHeader(writeHeader('b.jsonl', '{"type":"session","version":7,"id":"s-b"}'))).not.toBeNull()
    expect(getSessionHeaderUnknownVersionCounts().get(4)).toBe(1)
    expect(getSessionHeaderUnknownVersionCounts().get(7)).toBe(1)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  it('version=3（现行）与历史 version=1：安静零计数（旧版本文件在档可读）', () => {
    const h3 = writeHeader(
      'v3.jsonl',
      '{"type":"session","version":3,"id":"s-3","cwd":"/w","timestamp":"2026-10-31T00:00:00.000Z"}',
    )
    const h1 = writeHeader('v1.jsonl', '{"type":"session","version":1,"id":"s-1"}')
    expect(parseSessionHeader(h3)?.id).toBe('s-3')
    expect(parseSessionHeader(h1)?.id).toBe('s-1')
    expect(getSessionHeaderUnknownVersionCounts().size).toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('缺 version 字段（测试 fixture 常见形态）：安静零计数', () => {
    const filePath = writeHeader('nov.jsonl', '{"type":"session","id":"s-nov"}')
    expect(parseSessionHeader(filePath)?.id).toBe('s-nov')
    expect(getSessionHeaderUnknownVersionCounts().size).toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
