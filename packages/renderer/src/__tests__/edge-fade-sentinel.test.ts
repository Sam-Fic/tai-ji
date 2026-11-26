import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import EdgeFade from '../components/ui/edge-fade/EdgeFade.vue'

/** IntersectionObserver stub（哨兵驱动：用例手动 trigger(isIntersecting)，照 media-suite.test.ts 范式）。
 *  happy-dom 的 IO 是 no-op stub（回调不触发），必须 stubGlobal 才能确定性驱动翻转。 */
class MockIO {
  static instances: MockIO[] = []
  callback: IntersectionObserverCallback
  opts: IntersectionObserverInit | undefined
  observe = vi.fn()
  disconnect = vi.fn()
  constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    this.callback = cb
    this.opts = opts
    MockIO.instances.push(this)
  }
  trigger(isIntersecting: boolean): void {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

describe('EdgeFade IO 哨兵（batch2 F4：scroll 回调零几何读）', () => {
  beforeEach(() => {
    MockIO.instances = []
    vi.stubGlobal('IntersectionObserver', MockIO)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('哨兵滚离顶 → 渐焦激活 + scroller mask = active 常量；回可见 → 摘除', async () => {
    const wrapper = mount(EdgeFade)
    // onMounted 建立 IO（root=scroller，观察哨兵）
    expect(MockIO.instances).toHaveLength(1)
    const io = MockIO.instances[0]
    expect(io.observe).toHaveBeenCalled()
    const scroller = io.opts?.root as unknown as HTMLElement
    const fade = wrapper.find('[data-testid="edge-fade"]')

    // 初始（未触发）：on=false → 渐焦层 opacity-0、mask 空
    expect(fade.findAll('i').some((i) => i.classes().includes('opacity-0'))).toBe(true)
    expect(scroller.style.maskImage).toBe('')

    // 哨兵不可见（滚离顶）→ on=true → 层 opacity-100 + mask = active 常量（非空 linear-gradient）
    io.trigger(false)
    await nextTick()
    expect(fade.findAll('i').some((i) => i.classes().includes('opacity-100'))).toBe(true)
    expect(scroller.style.maskImage).toContain('linear-gradient')
    expect(scroller.style.maskImage).toContain('#000 40px')

    // 哨兵回可见（贴顶）→ on=false → 层 opacity-0 + mask 摘除
    io.trigger(true)
    await nextTick()
    expect(fade.findAll('i').some((i) => i.classes().includes('opacity-0'))).toBe(true)
    expect(scroller.style.maskImage).toBe('')
  })

  it('无 IntersectionObserver 环境 → 降级不激活（绝不回退读 scrollTop）', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const wrapper = mount(EdgeFade)
    await nextTick()
    // on 恒 false：渐焦层 opacity-0
    expect(wrapper.find('[data-testid="edge-fade"]').findAll('i').some((i) => i.classes().includes('opacity-0'))).toBe(true)
  })

  it('卸载 → IO disconnect（哨兵元素卸载清理）', () => {
    const wrapper = mount(EdgeFade)
    const io = MockIO.instances[0]
    wrapper.unmount()
    expect(io.disconnect).toHaveBeenCalled()
  })
})
