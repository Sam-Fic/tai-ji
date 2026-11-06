/**
 * 字体来源注册表（font-system §3.3 D4/D11）。
 *
 * 新增来源只需加入 sources 数组；核心渲染计算不感知来源。这里同时负责
 * fontLibrary 账本写入、一次性启动重放、失败内存态，以及删除时 SystemSettings
 * 与 TerminalConfig 两个持久化域的悬空引用清理。
 */
import { ref, type Ref } from 'vue'
import {
  getSettingsStore,
  getSettingsTransport,
  type FontLibraryEntry,
  type SystemSettings,
} from '@taiji/core'
import type { TerminalConfig } from '@taiji/shared'
import { FileFontSource, type FileFontSourceDeps, type FontFileSelection } from './file-font-source'
import { SystemFontSource } from './system-font-source'
import type { FontEntry, FontSource } from './types'

const REPLAY_SLOW_WARNING_MS = 3000

export type FontReplayState = 'idle' | 'replaying' | 'done'
export interface FontReplayFailure { // oe-exempt:20261104:test:返回值数据形状
  family: string
  reason: string
}
export interface FontReplayResult { // oe-exempt:20261104:test:返回值数据形状
  ok: string[]
  failed: FontReplayFailure[]
}

export interface FontRegistryStore { // oe-exempt:20261104:test:依赖注入缝（单测注入假 store，真实实现是既有 settings store）
  system: Ref<SystemSettings>
  setSystem: (patch: Partial<SystemSettings>) => Promise<void>
}

export interface FontRegistryTransport { // oe-exempt:20261104:test:依赖注入缝（单测注入假 transport）
  getTerminalConfig: () => Promise<{ config: TerminalConfig; corrupted: boolean }>
  setTerminalConfig: (config: TerminalConfig) => Promise<{ config: TerminalConfig; corrupted: boolean }>
}

export interface FontRegistryDeps { // oe-exempt:20261104:test:依赖注入参数形状
  store?: FontRegistryStore
  transport?: FontRegistryTransport
  fileSource?: Partial<FileFontSourceDeps>
  now?: () => number
}

/** 清除被删除家族在 fonts.ui / fonts.mono 中的引用，保留另一槽位。 */
function withoutDeletedFamily(
  fonts: SystemSettings['fonts'],
  family: string,
): { value: SystemSettings['fonts']; changed: boolean } {
  const next = { ...fonts }
  let changed = false
  if (next.ui === family) {
    delete next.ui
    changed = true
  }
  if (next.mono === family) {
    delete next.mono
    changed = true
  }
  return {
    value: Object.keys(next).length > 0 ? next : undefined,
    changed,
  }
}

export function createFontRegistry(deps: FontRegistryDeps = {}) {
  const store = deps.store ?? getSettingsStore()
  const transport = deps.transport ?? getSettingsTransport()
  const now = deps.now ?? (() => Date.now())
  const fileSource = new FileFontSource(deps.fileSource)
  // GL3 的可验证实例：新增来源只改此数组，不改核心层渲染计算。
  const sources: FontSource[] = [new SystemFontSource(), fileSource]

  // @data-owner #88 —— #88 字体清单的进程内聚合视图（来源枚举与 fontLibrary 账本补行
  // 经 list() 聚合去重排序后整体重建；权威仍是 SystemSettings.fontLibrary 与各来源
  // 实况，非第二权威）。
  const entries = ref<FontEntry[]>([])
  const replayState = ref<FontReplayState>('idle')
  // @data-owner #88 —— #88 重放失败的会话内存态标注（登记表空值语义已声明「失效标注
  // 不写回账本」；removeImportedFont 删除时同步清除，非持久化、非第二权威）。
  const replayFailures = ref<Record<string, string>>({})
  let replayPromise: Promise<FontReplayResult> | null = null
  let replayResult: FontReplayResult = { ok: [], failed: [] }

  /** 聚合来源；重放失败的账本项也保留为 file 行，供 UI 标注与手动删除。 */
  async function list(): Promise<FontEntry[]> {
    const settled = await Promise.allSettled(sources.map((source) => source.list()))
    const collected: FontEntry[] = []
    for (const result of settled) {
      if (result.status === 'fulfilled') collected.push(...result.value)
      else console.warn('[fonts] source list failed', result.reason)
    }

    const library = store.system.value.fontLibrary ?? []
    const knownFiles = new Set(collected.filter((entry) => entry.source === 'file').map((entry) => entry.family))
    for (const item of library) {
      if (!knownFiles.has(item.family)) collected.push({ family: item.family, source: 'file' })
    }

    const addedAt = new Map(library.map((item) => [item.family, item.addedAt]))
    const seen = new Set<string>()
    const files: FontEntry[] = []
    const system: FontEntry[] = []
    for (const entry of collected) {
      if (seen.has(entry.family)) continue
      seen.add(entry.family)
      if (entry.source === 'file') files.push(entry)
      else system.push(entry)
    }
    files.sort((a, b) => (addedAt.get(b.family) ?? 0) - (addedAt.get(a.family) ?? 0))
    system.sort((a, b) => a.family.localeCompare(b.family))
    entries.value = [...files, ...system]
    return entries.value
  }

  /** 每个 registry 生命周期只执行一次；并发调用共享同一 Promise，稳态调用不重读文件。 */
  function replayFontLibrary(): Promise<FontReplayResult> {
    if (replayPromise) return replayPromise
    replayState.value = 'replaying'
    replayPromise = (async () => {
      const startedAt = now()
      const ok: string[] = []
      const failed: FontReplayFailure[] = []
      const library = [...(store.system.value.fontLibrary ?? [])]
        .sort((a, b) => b.addedAt - a.addedAt)
      await list()
      for (const item of library) {
        try {
          await fileSource.registerImportedFont(item)
          ok.push(item.family)
        } catch (error) {
          failed.push({
            family: item.family,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      replayResult = { ok, failed }
      replayFailures.value = Object.fromEntries(failed.map((item) => [item.family, item.reason]))
      await list()
      replayState.value = 'done'
      const elapsed = now() - startedAt
      if (elapsed > REPLAY_SLOW_WARNING_MS) {
        console.warn(`[fonts] startup replay took ${elapsed}ms for ${library.length} item(s)`)
      }
      return replayResult
    })()
    return replayPromise
  }

  async function pickFontFile(): Promise<FontFileSelection | null> {
    return fileSource.pickFontFile()
  }

  /** 先注册 FontFace，再写账本；写账本失败时回滚注册，避免产生无账本字体。 */
  async function importFont(path: string, requestedFamily: string): Promise<FontLibraryEntry> {
    const entry = await fileSource.importFont(
      path,
      requestedFamily,
      (store.system.value.fontLibrary ?? []).map((item) => item.family),
    )
    try {
      await store.setSystem({
        fontLibrary: [entry, ...(store.system.value.fontLibrary ?? [])],
      })
    } catch (error) {
      fileSource.delete(entry.family)
      throw error
    }
    await list()
    return entry
  }

  /**
   * 删除账本 + FontFace，并清理两个配置域的当前引用。终端写前先读最新完整配置，
   * 避免与 TerminalPage / AppearancePage 的 read-modify-write 互相覆盖兄弟字段。
   */
  async function removeImportedFont(family: string): Promise<void> {
    const library = store.system.value.fontLibrary ?? []
    if (!library.some((item) => item.family === family)) return

    const terminal = await transport.getTerminalConfig()
    if (terminal.config.fontFamily === family) {
      await transport.setTerminalConfig({ ...terminal.config, fontFamily: '' })
    }

    const fonts = withoutDeletedFamily(store.system.value.fonts, family)
    await store.setSystem({
      fontLibrary: library.filter((item) => item.family !== family),
      ...(fonts.changed ? { fonts: fonts.value } : {}),
    })
    fileSource.delete(family)
    if (replayFailures.value[family] !== undefined) {
      const next = { ...replayFailures.value }
      delete next[family]
      replayFailures.value = next
    }
    await list()
  }

  return {
    entries,
    replayState,
    replayFailures,
    list,
    replayFontLibrary,
    pickFontFile,
    importFont,
    removeImportedFont,
  }
}

export type FontRegistry = ReturnType<typeof createFontRegistry>

// @data-owner #88 —— #88 registry 模块级单例句柄（控制面：共享实例保证启动重放只发生
// 一次；其持有的 entries / replayFailures 派生视图同属 #88 登记，非独立数据源）。
let singleton: FontRegistry | null = null

/** 应用级共享注册表；启动装配与设置页读取同一实例，保证重放只发生一次。 */
export function useFontRegistry(): FontRegistry {
  if (!singleton) singleton = createFontRegistry()
  return singleton
}
