/**
 * U7 机制半边单测（startup-readiness 设计 §7.5 / D2；RL9 机制半边看守面）。
 *
 * 三态各有用例（验收场景 A8 的机制半边；设计 §4.2 RL9 看守）：
 * 1. 标记写入：recordDisabled → disabled.json 条目落盘（pluginId + reason + disabledAt）；
 * 2. 扫描跳过：PluginRegistry.scan 对 disabled.json 命中的插件目录整体跳过（不产
 *    descriptor = 不装载）；清单缺失/损坏按空表容错（禁用机制故障不阻断正常装载）；
 * 3. 卸载清理：recordUninstalled 同步清 installed.json 与 disabled.json 两份条目
 *    （对称语义——「禁用 → 卸载 → 重装同 id」路径上重装即正常装载，无残留标记）。
 *
 * 呈现半边（failed 屏 + business 断言 + A8 全链）归 u-m2（M2-5），不在此覆盖。
 * 测试框架：vitest；fixture 落 mkdtemp 临时目录（自建自删）。
 * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/plugin-disabled-registry.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InstalledStore } from '../installed-store.js'
import { PluginRegistry } from '../plugin-registry.js'

/** 最小合法 taiji 插件 package.json 内容（manifest v1）。 */
function pluginPackageJson(name: string): string {
  return JSON.stringify({
    name,
    version: '0.0.1',
    displayName: name,
    taijiPlugin: { manifestVersion: 1 },
  })
}

function makePluginDir(pluginsDir: string, pluginId: string): string {
  const dir = join(pluginsDir, pluginId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), pluginPackageJson(pluginId))
  writeFileSync(join(dir, 'index.js'), 'export {}')
  return dir
}

describe('InstalledStore disabled 标记（U7 三态之 1：标记写入）', () => {
  let dir: string
  let store: InstalledStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'u7-installed-'))
    store = new InstalledStore(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('recordDisabled → disabled.json 条目含 pluginId/reason/disabledAt', async () => {
    await store.recordDisabled('plug-a', 'manifest invalid: bad JSON')
    const raw = JSON.parse(readFileSync(store.disabledPath, 'utf-8')) as Record<string, { reason: string; disabledAt: string }>
    expect(raw['plug-a']).toBeDefined()
    expect(raw['plug-a'].reason).toBe('manifest invalid: bad JSON')
    expect(typeof raw['plug-a'].disabledAt).toBe('string')
  })

  it('clearDisabled（重新启用）→ 条目移除；不存在时 no-op 不抛', async () => {
    await store.recordDisabled('plug-a', 'r1')
    await store.clearDisabled('plug-a')
    expect(await store.loadDisabled()).toEqual({})
    await expect(store.clearDisabled('plug-a')).resolves.toBeUndefined()
  })

  it('loadDisabled 容错：损坏 JSON / 非对象形态 → 空表不抛', async () => {
    writeFileSync(store.disabledPath, '{not-json')
    expect(await store.loadDisabled()).toEqual({})
    writeFileSync(store.disabledPath, '[1,2]')
    expect(await store.loadDisabled()).toEqual({})
  })

  it('条目级容错（读侧同语义闭合）：形状不合条目被丢弃，clearDisabled no-op 不写盘', async () => {
    // 形状不合条目（如手工编辑成字符串值）：写侧视图不认 → clearDisabled 不触发
    // 写回，disabled.json 原样保留——不产生「scan 认 / enable 不认」的单侧认知。
    writeFileSync(store.disabledPath, JSON.stringify({ 'plug-bad': 'bad', 'plug-ok': { reason: 'r', disabledAt: '2026-10-31T00:00:00Z' } }))
    const before = readFileSync(store.disabledPath, 'utf-8')
    expect(await store.loadDisabled()).toEqual({ 'plug-ok': { reason: 'r', disabledAt: '2026-10-31T00:00:00Z' } })
    await store.clearDisabled('plug-bad')
    expect(readFileSync(store.disabledPath, 'utf-8')).toBe(before)
    await store.clearDisabled('plug-ok')
    expect(await store.loadDisabled()).toEqual({})
  })

  it('卸载清理（U7 三态之 3）：recordUninstalled 同步清 installed 与 disabled 两份条目', async () => {
    await store.recordInstalled('plug-a')
    await store.recordDisabled('plug-a', 'activation failed')
    await store.recordUninstalled('plug-a')
    expect(await store.load()).toEqual({})
    expect(await store.loadDisabled()).toEqual({})
    // 「禁用 → 卸载 → 重装同 id」：重装（recordInstalled）后无残留禁用标记
    await store.recordInstalled('plug-a')
    expect(await store.loadDisabled()).toEqual({})
  })
})

describe('PluginRegistry 扫描跳过（U7 三态之 2）', () => {
  let dir: string
  let configDir: string
  let pluginsDir: string
  let registry: PluginRegistry

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'u7-registry-'))
    configDir = join(dir, 'config')
    pluginsDir = join(configDir, 'plugins')
    registry = new PluginRegistry(join(dir, 'project'), configDir, join(dir, 'builtin'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('disabled.json 命中的插件目录被 scan 跳过，未禁插件照常装载', async () => {
    makePluginDir(pluginsDir, 'plug-disabled')
    makePluginDir(pluginsDir, 'plug-normal')
    writeFileSync(
      join(pluginsDir, 'disabled.json'),
      JSON.stringify({ 'plug-disabled': { reason: 'manifest invalid', disabledAt: '2026-10-31T00:00:00Z' } }),
    )
    const descriptors = await registry.scan()
    const ids = descriptors.map((d) => d.pluginId)
    expect(ids).not.toContain('plug-disabled')
    expect(ids).toContain('plug-normal')
  })

  it('disabled.json 缺失（常态）→ 全部装载不受影响', async () => {
    makePluginDir(pluginsDir, 'plug-a')
    const descriptors = await registry.scan()
    expect(descriptors.map((d) => d.pluginId)).toContain('plug-a')
  })

  it('disabled.json 损坏 → 按空表容错（禁用机制故障不阻断正常装载）', async () => {
    makePluginDir(pluginsDir, 'plug-a')
    writeFileSync(join(pluginsDir, 'disabled.json'), '{broken')
    const descriptors = await registry.scan()
    expect(descriptors.map((d) => d.pluginId)).toContain('plug-a')
  })

  it('条目形状不合 → scan 不认该禁用键（读侧与 InstalledStore.loadDisabled 全同语义）', async () => {
    makePluginDir(pluginsDir, 'plug-bad')
    makePluginDir(pluginsDir, 'plug-ok')
    writeFileSync(
      join(pluginsDir, 'disabled.json'),
      JSON.stringify({
        'plug-bad': 'bad shape',
        'plug-ok': { reason: 'manifest invalid', disabledAt: '2026-10-31T00:00:00Z' },
      }),
    )
    const ids = (await registry.scan()).map((d) => d.pluginId)
    expect(ids).toContain('plug-bad') // 形状不合不入禁用集 → 不跳过
    expect(ids).not.toContain('plug-ok') // 合法条目照常跳过
  })

  it('禁用 → 重新启用（清条目）→ reload 后插件恢复装载', async () => {
    makePluginDir(pluginsDir, 'plug-a')
    writeFileSync(
      join(pluginsDir, 'disabled.json'),
      JSON.stringify({ 'plug-a': { reason: 'r', disabledAt: '2026-10-31T00:00:00Z' } }),
    )
    expect((await registry.scan()).map((d) => d.pluginId)).not.toContain('plug-a')
    // 重新启用 = 清条目（InstalledStore.clearDisabled）
    const store = new InstalledStore(pluginsDir)
    await store.clearDisabled('plug-a')
    expect((await registry.reload()).map((d) => d.pluginId)).toContain('plug-a')
  })
})
