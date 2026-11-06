/**
 * MermaidRenderer 组件级单测（font-re-render G12 载体：主题/字体变化触发重渲）。
 *
 * 覆盖面：
 * - 挂载成功路径：renderMermaid 以 (trim 后 source, 当前主题) 调用，SVG 注入气泡
 * - 等宽字体变化（<html style> 的 --font-mono 计算值）→ 重渲（主题不变）
 * - 无关 style 变化（计算值不变）→ 不重渲（计算值比较去抖的 early-return）
 * - 主题变化（<html data-theme>）→ 以新主题重渲
 * - 渲染失败 → 错误占位（渲染中/失败态的展示分支）
 * - 卸载 → 断开 MutationObserver
 *
 * mock 口径：renderMermaid 经 mockChatProvide 注入（组件经 useChatViewDeps inject 消费，
 * 不触真 mermaid 库）；--font-mono 计算值经 stubGlobal getComputedStyle 控制（happy-dom
 * 不展开 var()，真实计算值拿不到——与 mermaid.ts BUILD_TIME_FONT_FAMILY 回落注释同因）。
 * vue-i18n 由 ui 包 vitest.setup 全局 mock（t 回 key），文案断言按 key。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/MermaidRenderer.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import MermaidRenderer from '../MermaidRenderer.vue'
import { mockChatProvide } from './helpers'

const SVG = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

/** renderMermaid 依赖签名（与 ChatViewDeps.renderMermaid 同形——Mock 泛型显式给签名，类型检查过 mockChatProvide） */
type RenderMermaidFn = (source: string, theme: 'dark' | 'light') => Promise<{ svg: string }>

function makeRenderMermaid(): Mock<RenderMermaidFn> {
  return vi.fn<RenderMermaidFn>().mockResolvedValue({ svg: SVG })
}

/** --font-mono 计算值 stub（组件 setup 读取与 observer 回调比较都走 getComputedStyle） */
function stubMonoFont(font: string): void {
  vi.stubGlobal(
    'getComputedStyle',
    vi.fn(() => ({
      getPropertyValue: (name: string) => (name === '--font-mono' ? font : ''),
    })),
  )
}

/** mutation 事件与 doRender 异步链全部落地：observer 派发（微/宏任务两态都覆盖）+ promise 链 + DOM */
async function flushAll(): Promise<void> {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await flushPromises()
  await nextTick()
}

function mountRenderer(renderMermaid: RenderMermaidFn, source = 'graph TD; A-->B') {
  return mount(MermaidRenderer, {
    props: { source },
    global: { provide: mockChatProvide({ renderMermaid }) },
  })
}

describe('MermaidRenderer', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('style')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('挂载成功：renderMermaid 以 (trim 后 source, dark) 调用，SVG 注入气泡', async () => {
    stubMonoFont("'Maple Mono', Menlo, monospace")
    const renderMermaid = makeRenderMermaid()
    const wrapper = mountRenderer(renderMermaid, '  graph TD; A-->B  ')
    await flushAll()
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    expect(renderMermaid).toHaveBeenCalledWith('graph TD; A-->B', 'dark')
    expect(wrapper.find('.md-mermaid__inline').exists()).toBe(true)
    expect(wrapper.find('.md-mermaid__inline').html()).toContain('<svg')
  })

  it('等宽字体变化（<html style>）→ 同主题重渲', async () => {
    stubMonoFont("'Maple Mono', Menlo, monospace")
    const renderMermaid = makeRenderMermaid()
    const wrapper = mountRenderer(renderMermaid)
    await flushAll()
    expect(renderMermaid).toHaveBeenCalledTimes(1)

    stubMonoFont("'IBM Plex Mono', Menlo, monospace")
    document.documentElement.setAttribute('style', "--font-mono: 'IBM Plex Mono', Menlo, monospace")
    await flushAll()
    expect(renderMermaid).toHaveBeenCalledTimes(2)
    expect(renderMermaid).toHaveBeenLastCalledWith('graph TD; A-->B', 'dark')
    wrapper.unmount()
  })

  it('无关 style 变化（--font-mono 计算值不变）→ 不重渲', async () => {
    stubMonoFont("'Maple Mono', Menlo, monospace")
    const renderMermaid = makeRenderMermaid()
    const wrapper = mountRenderer(renderMermaid)
    await flushAll()
    expect(renderMermaid).toHaveBeenCalledTimes(1)

    document.documentElement.setAttribute('style', 'font-size: 20px')
    await flushAll()
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('主题变化（data-theme=light）→ 以新主题重渲', async () => {
    stubMonoFont("'Maple Mono', Menlo, monospace")
    const renderMermaid = makeRenderMermaid()
    const wrapper = mountRenderer(renderMermaid)
    await flushAll()
    expect(renderMermaid).toHaveBeenCalledTimes(1)

    document.documentElement.setAttribute('data-theme', 'light')
    await flushAll()
    expect(renderMermaid).toHaveBeenCalledTimes(2)
    expect(renderMermaid).toHaveBeenLastCalledWith('graph TD; A-->B', 'light')
    wrapper.unmount()
  })

  it('渲染失败 → 错误占位（含查看源码入口），不注入 SVG', async () => {
    stubMonoFont("'Maple Mono', Menlo, monospace")
    const renderMermaid = makeRenderMermaid().mockRejectedValue(new Error('parse error'))
    const wrapper = mountRenderer(renderMermaid)
    await flushAll()
    expect(wrapper.find('.md-mermaid__error').exists()).toBe(true)
    expect(wrapper.find('.md-mermaid__inline').exists()).toBe(false)
    expect(wrapper.text()).toContain('panel.mermaid.renderFailed')
    expect(wrapper.text()).toContain('panel.mermaid.viewSource')
  })

  it('卸载 → 断开 MutationObserver', async () => {
    stubMonoFont("'Maple Mono', Menlo, monospace")
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const renderMermaid = makeRenderMermaid()
    const wrapper = mountRenderer(renderMermaid)
    await flushAll()
    expect(disconnect).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
