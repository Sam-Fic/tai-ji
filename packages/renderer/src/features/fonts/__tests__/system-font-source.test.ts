import { afterEach, describe, expect, it, vi } from 'vitest'
import { SystemFontSource } from '../system-font-source'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SystemFontSource 家族聚合', () => {
  it('同家族多 face/style 去重，按家族名排序（小样本覆盖 1031→316 的同一算法）', async () => {
    const query = vi.fn(async () => [
      { family: 'Maple Mono', style: 'Regular' },
      { family: 'Menlo', style: 'Regular' },
      { family: 'Maple Mono', style: 'Bold' },
      { family: 'PingFang SC', style: 'Regular' },
      { family: 'Menlo', style: 'Italic' },
      { family: 'Maple Mono', style: 'Italic' },
      { family: 'Menlo', style: 'Bold' },
    ])
    vi.stubGlobal('queryLocalFonts', query)

    const entries = await new SystemFontSource().list()
    expect(entries).toEqual([
      { family: 'Maple Mono', source: 'system' },
      { family: 'Menlo', source: 'system' },
      { family: 'PingFang SC', source: 'system' },
    ])
  })

  it('无应用层缓存：连续 list 都调用 queryLocalFonts', async () => {
    const query = vi.fn(async () => [{ family: 'Menlo' }])
    vi.stubGlobal('queryLocalFonts', query)
    const source = new SystemFontSource()
    await source.list()
    await source.list()
    expect(query).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['返回空数组', async () => []],
    ['抛权限错误', async () => { throw new Error('permission denied') }],
  ])('权限受限形态：%s → 空清单且不抛错', async (_name, implementation) => {
    vi.stubGlobal('queryLocalFonts', vi.fn(implementation))
    await expect(new SystemFontSource().list()).resolves.toEqual([])
  })
})
