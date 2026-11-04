/**
 * 本地字体文件来源（font-system §3.1 AX1、§3.3 D4/D10/D11）。
 *
 * 只负责字体生命周期：选择文件、经 main IPC 读字节、注册/删除 FontFace。
 * fontLibrary 持久化与启动重放编排归 use-font-registry；本类只保存本次进程内
 * 「family → FontFace」映射，供 list/delete 精确操作，不缓存系统字体清单。
 */
import type { FontLibraryEntry } from '@taiji/core'
import type { ReadFontBytesResult } from '@taiji/shared'
import { pickFile } from '@/lib/ipc'
import { readFontBytes } from '@/api/domains/settings'
import { querySystemFontFamilies } from './system-font-source'
import type { FontEntry, FontSource } from './types'

/** `FontFace` 的 BufferSource 要求 ArrayBuffer 语义；Uint8Array 需切片出独立 buffer。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

export interface FontFileSelection { // oe-exempt:20261104:test:返回值数据形状（纯数据声明）
  path: string
  /** 文件名去扩展名，仅供 UI 预填；最终家族名必须由用户确认。 */
  suggestedFamily: string
}

export interface FileFontSourceDeps { // oe-exempt:20261104:test:依赖注入缝（单测注入假 IPC / 假 pickFile）
  pickFile: typeof pickFile
  readFontBytes: (path: string) => Promise<ReadFontBytesResult>
  listSystemFamilies: () => Promise<string[]>
  now: () => number
}

const IMPORTED_SUFFIX = '(导入)'

function defaultDeps(): FileFontSourceDeps {
  return {
    pickFile,
    readFontBytes,
    listSystemFamilies: querySystemFontFamilies,
    now: () => Date.now(),
  }
}

/** 从选中路径派生 UI 预填名；不解析字体二进制 name 表。 */
export function suggestFontFamily(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? ''
  const withoutExtension = fileName.replace(/\.[^.]+$/, '')
  return withoutExtension.trim() || 'Imported Font'
}

/**
 * 保证导入家族名唯一（AX1）。
 *
 * 系统清单为空可能意味着权限被拒，不能据此认定“没有同名系统字体”，故一律加后缀；
 * 非空时仅在实际撞名时加后缀。随后再避开已有导入项，保证文件来源内部也不重名。
 */
export function resolveImportedFamily(
  requestedFamily: string,
  systemFamilies: readonly string[],
  importedFamilies: readonly string[] = [],
): string {
  const base = requestedFamily.trim() || 'Imported Font'
  const occupied = new Set([...systemFamilies, ...importedFamilies])
  const mustSuffix = systemFamilies.length === 0 || occupied.has(base)
  if (!mustSuffix) return base

  const first = `${base} ${IMPORTED_SUFFIX}`
  if (!occupied.has(first)) return first
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${IMPORTED_SUFFIX} ${index}`
    if (!occupied.has(candidate)) return candidate
  }
}

export class FileFontSource implements FontSource {
  private readonly deps: FileFontSourceDeps
  private readonly faces = new Map<string, FontFace>()

  constructor(deps: Partial<FileFontSourceDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps }
  }

  /** 已成功注册的字体；重放失败项由 registry 从 fontLibrary 补入列表以便标注与删除。 */
  async list(): Promise<FontEntry[]> {
    return [...this.faces.keys()].map((family) => ({ family, source: 'file' }))
  }

  /** 打开原生文件选择器；取消返回 null。 */
  async pickFontFile(): Promise<FontFileSelection | null> {
    const picked = await this.deps.pickFile({
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
    })
    if (picked.canceled || !picked.path) return null
    return { path: picked.path, suggestedFamily: suggestFontFamily(picked.path) }
  }

  /** 用户确认家族名后读字节并注册；返回待写入 fontLibrary 的三字段账本项。 */
  async importFont(
    path: string,
    requestedFamily: string,
    libraryFamilies: readonly string[] = [],
  ): Promise<FontLibraryEntry> {
    const systemFamilies = await this.deps.listSystemFamilies()
    const family = resolveImportedFamily(
      requestedFamily,
      systemFamilies,
      [...this.faces.keys(), ...libraryFamilies],
    )
    const result = await this.deps.readFontBytes(path)
    if (!result.ok) throw new Error(result.reason)

    const face = new FontFace(family, toArrayBuffer(result.bytes))
    document.fonts.add(face)
    this.faces.set(family, face)
    return { family, path, addedAt: this.deps.now() }
  }

  /** 启动重放单项：使用账本中已确认的家族名，不再次做同名派生。 */
  async registerImportedFont(entry: FontLibraryEntry): Promise<void> {
    if (this.faces.has(entry.family)) return
    const result = await this.deps.readFontBytes(entry.path)
    if (!result.ok) throw new Error(result.reason)
    const face = new FontFace(entry.family, toArrayBuffer(result.bytes))
    document.fonts.add(face)
    this.faces.set(entry.family, face)
  }

  /** 删除本次进程内注册的 FontFace；未注册（如重放失败）时返回 false。 */
  delete(family: string): boolean {
    const face = this.faces.get(family)
    if (!face) return false
    const deleted = document.fonts.delete(face)
    if (deleted) this.faces.delete(family)
    return deleted
  }
}
