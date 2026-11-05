import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileFontSource, suggestFontFamily, type FileFontSourceDeps } from '../file-font-source'
import { installFakeFontEnvironment } from './font-test-environment'

let environment: ReturnType<typeof installFakeFontEnvironment>

beforeEach(() => {
  environment = installFakeFontEnvironment()
})

afterEach(() => {
  environment.restore()
  vi.clearAllMocks()
})

function makeDeps(systemFamilies: string[]): FileFontSourceDeps {
  return {
    pickFile: vi.fn(async () => ({ canceled: false, path: '/fonts/Maple Mono.ttf' })),
    readFontBytes: vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([0, 1, 0, 0]) })),
    listSystemFamilies: vi.fn(async () => systemFamilies),
    now: () => 12345,
  }
}

describe('FileFontSource 导入命名与 FontFace 调用契约', () => {
  it('与系统字体同名 → 导入项改名，系统原名字符串仍可独立选择', async () => {
    const source = new FileFontSource(makeDeps(['Maple Mono']))
    const entry = await source.importFont('/fonts/Maple Mono.ttf', 'Maple Mono')

    expect(entry).toEqual({ family: 'Maple Mono (导入)', path: '/fonts/Maple Mono.ttf', addedAt: 12345 })
    expect(entry.family).not.toBe('Maple Mono')
    expect([...environment.faces][0]?.family).toBe('Maple Mono (导入)')
    expect(environment.fontSet.add).toHaveBeenCalledTimes(1)
    await expect(source.list()).resolves.toEqual([{ family: 'Maple Mono (导入)', source: 'file' }])
  })

  it('系统字体大小写变体撞名 → 同样改名（CSS 匹配大小写不敏感，AX1 归一口径）', async () => {
    const source = new FileFontSource(makeDeps(['Maple Mono']))
    // 文件名预填形态：'maple mono.ttf' → 用户确认名 'maple mono'，与已装 'Maple Mono'
    // 字符串级不同但渲染层解析到同一匹配族——必须加后缀保证渲染级唯一。
    const entry = await source.importFont('/fonts/maple mono.ttf', 'maple mono')
    expect(entry.family).toBe('maple mono (导入)')
    // 已导入名的小写变体同样占名（文件来源内部不重名，suffix 链跳过被占用项）
    const second = await source.importFont('/fonts/b.ttf', 'MAPLE MONO')
    expect(second.family).toBe('MAPLE MONO (导入) 2')
  })

  it('系统清单非空且无撞名 → 保留用户确认的家族名', async () => {
    const source = new FileFontSource(makeDeps(['Menlo']))
    const entry = await source.importFont('/fonts/Maple Mono.ttf', '  Maple Mono  ')
    expect(entry.family).toBe('Maple Mono')
  })

  it('权限被拒导致系统清单为空 → 不依赖清单判重，仍一律加后缀', async () => {
    const source = new FileFontSource(makeDeps([]))
    const entry = await source.importFont('/fonts/Maple Mono.ttf', 'Maple Mono')
    expect(entry.family).toBe('Maple Mono (导入)')
    expect([...environment.faces][0]?.family).not.toBe('Maple Mono')
  })

  it('已导入家族也占名 → 递增后缀，避免文件来源内部重名', async () => {
    const source = new FileFontSource(makeDeps([]))
    const first = await source.importFont('/fonts/a.ttf', 'Custom')
    const second = await source.importFont('/fonts/b.ttf', 'Custom')
    expect(first.family).toBe('Custom (导入)')
    expect(second.family).toBe('Custom (导入) 2')
    expect(environment.fontSet.size).toBe(2)
  })

  it('IPC 校验拒绝 → 不注册 FontFace 并透出原因', async () => {
    const deps = makeDeps(['Menlo'])
    deps.readFontBytes = vi.fn(async () => ({ ok: false, reason: 'bad magic' }))
    const source = new FileFontSource(deps)
    await expect(source.importFont('/fonts/bad.ttf', 'Bad')).rejects.toThrow('bad magic')
    expect(environment.fontSet.add).not.toHaveBeenCalled()
  })

  it('pickFontFile 只提供路径与文件名预填，不解析字体二进制', async () => {
    const deps = makeDeps(['Menlo'])
    const source = new FileFontSource(deps)
    await expect(source.pickFontFile()).resolves.toEqual({
      path: '/fonts/Maple Mono.ttf',
      suggestedFamily: 'Maple Mono',
    })
    expect(deps.pickFile).toHaveBeenCalledWith({
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
    })
    expect(suggestFontFamily('/fonts/My.Font.woff2')).toBe('My.Font')
  })
})
