import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { DEFAULT_SYSTEM, type FontLibraryEntry, type SystemSettings } from '@taiji/core'
import type { TerminalConfig, ReadFontBytesResult } from '@taiji/shared'
import { createFontRegistry, type FontRegistryDeps } from '../use-font-registry'
import { installFakeFontEnvironment } from './font-test-environment'

let environment: ReturnType<typeof installFakeFontEnvironment>

beforeEach(() => {
  environment = installFakeFontEnvironment()
})

afterEach(() => {
  environment.restore()
  vi.clearAllMocks()
})

function makeHarness(fontLibrary: FontLibraryEntry[] = []) {
  const system = ref<SystemSettings>({
    ...DEFAULT_SYSTEM,
    fontScales: { ...DEFAULT_SYSTEM.fontScales },
    fontLibrary,
  })
  const setSystem = vi.fn(async (patch: Partial<SystemSettings>) => {
    system.value = { ...system.value, ...patch }
  })
  let terminal: TerminalConfig = {
    version: 1,
    shell: '/bin/zsh',
    shellArgs: ['-l'],
    fontSize: 15,
    fontFamily: '',
    scrollback: 1200,
    cursorStyle: 'block',
    bell: false,
  }
  const transport = {
    getTerminalConfig: vi.fn(async () => ({ config: { ...terminal }, corrupted: false })),
    setTerminalConfig: vi.fn(async (config: TerminalConfig) => {
      terminal = { ...config }
      return { config: { ...terminal }, corrupted: false }
    }),
  }
  const readFontBytes = vi.fn(async (_path: string): Promise<ReadFontBytesResult> => ({
    ok: true,
    bytes: new Uint8Array([0, 1, 0, 0]),
  }))
  const deps: FontRegistryDeps = {
    store: { system, setSystem },
    transport,
    fileSource: {
      readFontBytes,
      listSystemFamilies: vi.fn(async () => ['Menlo']),
      now: () => 100,
    },
  }
  return {
    registry: createFontRegistry(deps),
    system,
    setSystem,
    transport,
    readFontBytes,
    terminal: () => terminal,
  }
}

describe('use-font-registry 删除通道', () => {
  it('删账本 + document.fonts.delete，并让 SystemSettings 与 TerminalConfig 两域同时回落', async () => {
    const harness = makeHarness()
    const entry = await harness.registry.importFont('/fonts/Maple.ttf', 'Maple Mono')
    harness.system.value = {
      ...harness.system.value,
      theme: 'light',
      fontSize: 'large',
      fontScales: { sidebar: 'small', chat: 'large', drawer: 'xlarge' },
      fonts: { ui: entry.family, mono: entry.family },
    }
    // 通过 transport 的真实可变快照设置终端当前字体，随后删除必须保留其余字段。
    const current = harness.terminal()
    await harness.transport.setTerminalConfig({ ...current, fontFamily: entry.family })
    harness.transport.setTerminalConfig.mockClear()

    await harness.registry.removeImportedFont(entry.family)

    expect(harness.system.value.fontLibrary).toEqual([])
    expect(harness.system.value.fonts).toBeUndefined()
    expect(harness.system.value.theme).toBe('light')
    expect(harness.system.value.fontSize).toBe('large')
    expect(harness.system.value.fontScales).toEqual({ sidebar: 'small', chat: 'large', drawer: 'xlarge' })
    expect(environment.fontSet.delete).toHaveBeenCalledTimes(1)
    expect(environment.fontSet.size).toBe(0)
    expect(harness.terminal().fontFamily).toBe('')
    expect(harness.terminal()).toMatchObject({
      shell: '/bin/zsh',
      shellArgs: ['-l'],
      fontSize: 15,
      scrollback: 1200,
      cursorStyle: 'block',
    })
    expect(harness.transport.setTerminalConfig).toHaveBeenCalledTimes(1)
  })
})

describe('use-font-registry 启动重放', () => {
  const library: FontLibraryEntry[] = [
    { family: 'Maple Mono (导入)', path: '/fonts/maple.ttf', addedAt: 200 },
    { family: 'Custom (导入)', path: '/fonts/custom.woff2', addedAt: 100 },
  ]

  it('每项只读一次；done 后列表刷新/主题变化/再次重放均不新增读盘', async () => {
    const harness = makeHarness(library)
    const replaying = harness.registry.replayFontLibrary()
    expect(harness.registry.replayState.value).toBe('replaying')
    const result = await replaying

    expect(harness.registry.replayState.value).toBe('done')
    expect(result).toEqual({ ok: library.map((item) => item.family), failed: [] })
    expect(harness.readFontBytes).toHaveBeenCalledTimes(2)
    expect(harness.readFontBytes).toHaveBeenNthCalledWith(1, '/fonts/maple.ttf')
    expect(harness.readFontBytes).toHaveBeenNthCalledWith(2, '/fonts/custom.woff2')
    expect(environment.fontSet.size).toBe(2)
    // 重放只读不写：失效标注与注册副作用不得回写 fontLibrary。
    expect(harness.setSystem).not.toHaveBeenCalled()

    await harness.registry.list()
    await harness.registry.list()
    await harness.registry.list()
    harness.system.value = { ...harness.system.value, theme: 'light' }
    harness.system.value = { ...harness.system.value, theme: 'dark' }
    await harness.registry.replayFontLibrary()
    expect(harness.readFontBytes).toHaveBeenCalledTimes(2)
  })

  it('单项失败不阻断其他项；失败标注只在本会话内，条目仍可删除', async () => {
    const harness = makeHarness(library)
    harness.readFontBytes.mockImplementation(async (path) => path.includes('custom')
      ? { ok: false, reason: '源文件已不存在' }
      : { ok: true, bytes: new Uint8Array([0, 1, 0, 0]) })

    const result = await harness.registry.replayFontLibrary()
    expect(result.ok).toEqual(['Maple Mono (导入)'])
    expect(result.failed).toEqual([{ family: 'Custom (导入)', reason: '源文件已不存在' }])
    expect(harness.registry.replayFailures.value).toEqual({ 'Custom (导入)': '源文件已不存在' })
    expect(harness.registry.entries.value.map((entry) => entry.family)).toContain('Custom (导入)')
    expect(harness.setSystem).not.toHaveBeenCalled()

    await harness.registry.removeImportedFont('Custom (导入)')
    expect(harness.system.value.fontLibrary).toEqual([library[0]])
    expect(harness.registry.replayFailures.value).toEqual({})
  })

  it('重放失败项仍占家族名；再次导入同名文件不会制造重复账本身份', async () => {
    const harness = makeHarness([{ family: 'Custom', path: '/fonts/missing.ttf', addedAt: 100 }])
    harness.readFontBytes.mockResolvedValueOnce({ ok: false, reason: '源文件已不存在' })
    await harness.registry.replayFontLibrary()

    const entry = await harness.registry.importFont('/fonts/new.ttf', 'Custom')
    expect(entry.family).toBe('Custom (导入)')
    expect(harness.system.value.fontLibrary?.map((item) => item.family)).toEqual(['Custom (导入)', 'Custom'])
  })
})
