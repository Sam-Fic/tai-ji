import { vi } from 'vitest'

/** happy-dom 无 FontFace / document.fonts；仅实现 SUT 消费的调用契约，不模拟真实渲染。 */
export class FakeFontFace {
  readonly family: string
  readonly source: Uint8Array

  constructor(family: string, source: Uint8Array) {
    this.family = family
    this.source = source
  }
}

export function installFakeFontEnvironment() {
  const faces = new Set<FakeFontFace>()
  const fontSet = {
    add: vi.fn((face: FakeFontFace) => {
      faces.add(face)
      return fontSet
    }),
    delete: vi.fn((face: FakeFontFace) => faces.delete(face)),
    has: vi.fn((face: FakeFontFace) => faces.has(face)),
    forEach: vi.fn((callback: (face: FakeFontFace) => void) => {
      faces.forEach(callback)
    }),
    get size() {
      return faces.size
    },
  }
  const previous = Object.getOwnPropertyDescriptor(document, 'fonts')
  vi.stubGlobal('FontFace', FakeFontFace)
  Object.defineProperty(document, 'fonts', { configurable: true, value: fontSet })

  return {
    faces,
    fontSet,
    restore() {
      vi.unstubAllGlobals()
      if (previous) Object.defineProperty(document, 'fonts', previous)
      else Reflect.deleteProperty(document, 'fonts')
    },
  }
}
