/**
 * 系统字体来源（font-system §3.3 D4/D6）。
 *
 * 每次 list 都直接查询 Chromium，不增加应用层缓存：Chromium 已缓存枚举结果，
 * 再维护一份模块级快照只会引入失效语义。权限被拒时不同平台可能返回空数组或抛错，
 * 两种形态都降级为空清单，让文件导入通道继续可用。
 */
import type { FontEntry, FontSource } from './types'

interface LocalFontData { // oe-exempt:20261104:test:浏览器 API 形状的类型镜像（纯数据声明，无实现可数）
  family: string
}

interface LocalFontsWindow { // oe-exempt:20261104:test:浏览器全局的最小结构声明（测试注入缝，非抽象层）
  queryLocalFonts?: () => Promise<LocalFontData[]>
}

/** 查询并按 family 聚合去重（同家族多 style/face 只保留一项）。 */
export async function querySystemFontFamilies(): Promise<string[]> {
  if (typeof window === 'undefined') return []
  const query = (window as LocalFontsWindow).queryLocalFonts
  if (typeof query !== 'function') return []
  try {
    const faces = await query.call(window)
    return [...new Set(faces.map((face) => face.family).filter((family) => family.trim().length > 0))]
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export class SystemFontSource implements FontSource {
  async list(): Promise<FontEntry[]> {
    const families = await querySystemFontFamilies()
    return families.map((family) => ({ family, source: 'system' }))
  }
}
