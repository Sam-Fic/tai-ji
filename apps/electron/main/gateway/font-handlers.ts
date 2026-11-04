/**
 * font:read-bytes IPC（font-system §3.3 D10）。
 *
 * 准入是无状态内容校验，不依赖“本次文件选择”状态，因此同一通道也可服务启动重放。
 * 顺序：扩展名 → realpath 后凭据目录禁区 → stat 大小 → readFile → magic bytes。
 * stat 先于 readFile，避免把明显超限文件读入内存后才拒绝。
 */
import { ipcMain } from 'electron'
import { realpath, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  READ_FONT_BYTES,
  type ReadFontBytesPayload,
  type ReadFontBytesResult,
} from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import { mainLogger } from '../logs/main-logger.js'

const BYTES_PER_KIB = 1024
const MAX_FONT_FILE_MIB = 20
export const MAX_FONT_FILE_BYTES = MAX_FONT_FILE_MIB * BYTES_PER_KIB * BYTES_PER_KIB
const SUPPORTED_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2'])
const asciiMagic = (value: string): number[] => [...value].map((char) => char.charCodeAt(0))
const FONT_MAGICS: readonly (readonly number[])[] = [
  asciiMagic('wOF2'),
  asciiMagic('wOFF'),
  asciiMagic('OTTO'),
  [0x00, 0x01, 0x00, 0x00], // TrueType
  asciiMagic('true'),
]

const REASON_UNSUPPORTED = '不是受支持的字体文件（仅支持 ttf/otf/woff/woff2）'
const REASON_TOO_LARGE = '字体文件超过 20MB 上限'
const REASON_MAGIC = '文件内容不是有效的字体格式'
const REASON_FORBIDDEN = '字体文件位于凭据保护目录，已拒绝读取'
const REASON_UNREADABLE = '无法读取字体文件，可能已损坏'
const REASON_NOT_FOUND = '源文件已不存在'
const REASON_INVALID_PATH = '字体文件路径无效'

export type FontValidationResult = { ok: true } | { ok: false; reason: string }

/** 校验所需的最小字节视图；测试可用小对象表达超限长度，无需分配 20MB fixture。 */
export interface FontByteView { // oe-exempt:20261104:test:只读字节视图的最小形状（让超限用例不必分配 20MB fixture）
  readonly byteLength: number
  readonly [index: number]: number | undefined
}

export interface FontPathPolicy { // oe-exempt:20261104:test:校验策略参数形状（纯数据）
  homeDir: string
  dataDir: string
}

function normalizeExtension(extension: string): string {
  return extension.trim().toLowerCase().replace(/^\./, '')
}

function isSupportedExtension(extension: string): boolean {
  return SUPPORTED_EXTENSIONS.has(normalizeExtension(extension))
}

/** 内容三关：扩展名、20MB 上限、五种字体 magic。 */
export function validateFontFile(bytes: FontByteView, extension: string): FontValidationResult {
  if (!isSupportedExtension(extension)) return { ok: false, reason: REASON_UNSUPPORTED }
  if (bytes.byteLength > MAX_FONT_FILE_BYTES) return { ok: false, reason: REASON_TOO_LARGE }
  const validMagic = FONT_MAGICS.some((magic) =>
    bytes.byteLength >= magic.length && magic.every((value, index) => bytes[index] === value),
  )
  return validMagic ? { ok: true } : { ok: false, reason: REASON_MAGIC }
}

function isInsideDirectory(candidate: string, directory: string): boolean {
  const rel = relative(resolve(directory), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 对 realpath 后的路径执行四类凭据目录禁区；其余位置（含系统字体目录）不按路径封禁。 */
export function validateFontPath(
  filePath: string,
  policy: FontPathPolicy = { homeDir: homedir(), dataDir: getDataDir() },
): FontValidationResult {
  if (!isAbsolute(filePath)) return { ok: false, reason: REASON_INVALID_PATH }
  const forbidden = [
    join(policy.homeDir, '.ssh'),
    join(policy.homeDir, '.aws'),
    join(policy.homeDir, 'Library', 'Keychains'),
    join(policy.dataDir, 'agent'),
  ]
  return forbidden.some((directory) => isInsideDirectory(filePath, directory))
    ? { ok: false, reason: REASON_FORBIDDEN }
    : { ok: true }
}

export interface FontReadIo { // oe-exempt:20261104:test:IO 注入缝（单测注入假 fs，用于断言「stat 后不 readFile」）
  realpath: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ size: number; isFile: () => boolean }>
  readFile: (path: string) => Promise<Uint8Array>
}

export interface ReadFontFileOptions { // oe-exempt:20261104:test:函数参数形状
  io?: FontReadIo
  policy?: FontPathPolicy
}

function hasErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return (error as { code?: unknown }).code === code
}

function readFailure(error: unknown): ReadFontBytesResult {
  return { ok: false, reason: hasErrorCode(error, 'ENOENT') ? REASON_NOT_FOUND : REASON_UNREADABLE }
}

/** 可注入 IO 的读取实现；纯校验与读取顺序均可脱离 Electron 真机测试。 */
export async function readFontFileBytes(
  rawPath: string,
  options: ReadFontFileOptions = {},
): Promise<ReadFontBytesResult> {
  if (!isAbsolute(rawPath)) return { ok: false, reason: REASON_INVALID_PATH }
  const extension = extname(rawPath)
  if (!isSupportedExtension(extension)) return { ok: false, reason: REASON_UNSUPPORTED }
  const io = options.io ?? { realpath, stat, readFile }
  const policy = options.policy ?? { homeDir: homedir(), dataDir: getDataDir() }

  let actualPath: string
  try {
    actualPath = await io.realpath(rawPath)
  } catch (error) {
    return readFailure(error)
  }
  const pathValidation = validateFontPath(actualPath, policy)
  if (!pathValidation.ok) return pathValidation

  let metadata: { size: number; isFile: () => boolean }
  try {
    metadata = await io.stat(actualPath)
  } catch (error) {
    return readFailure(error)
  }
  mainLogger.info('[main] font read-bytes stat', { path: actualPath, byteSize: metadata.size })
  if (!metadata.isFile()) return { ok: false, reason: REASON_UNREADABLE }
  if (metadata.size > MAX_FONT_FILE_BYTES) return { ok: false, reason: REASON_TOO_LARGE }

  let bytes: Uint8Array
  try {
    bytes = await io.readFile(actualPath)
  } catch (error) {
    return readFailure(error)
  }
  const contentValidation = validateFontFile(bytes, extension)
  if (!contentValidation.ok) return contentValidation
  return { ok: true, bytes }
}

function readPayloadPath(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('path' in payload)) return null
  const path = (payload as { path?: unknown }).path
  return typeof path === 'string' && path.length > 0 ? path : null
}

export function registerFontHandlers(): void {
  ipcMain.removeHandler(READ_FONT_BYTES)
  ipcMain.handle(READ_FONT_BYTES, async (_event, payload: ReadFontBytesPayload): Promise<ReadFontBytesResult> => {
    const path = readPayloadPath(payload)
    return path ? readFontFileBytes(path) : { ok: false, reason: REASON_INVALID_PATH }
  })
}
