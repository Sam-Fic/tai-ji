/**
 * components/ui 家族 colocated 合并产物（round5-f C3）。
 *
 * 来源（本目录同源三件，环境均为 vitest 默认）：
 *   - AsyncErrorFallback.test.ts（主文件：错误占位两态 + 重试状态机 + 全链路，零 mock）
 *   - InboundFrameDroppedNotice.test.ts（入站丢帧终止阀静态提示）
 *   - ToastContainer.test.ts（session 定位行 + 排版 + hover 暂停 + 溢出摘要）
 *
 * mock 说明：两条 vi.mock 互异且经 grep 复筛各自只进本节组件链——
 *   - useInboundFrameGuard 仅 InboundFrameDroppedNotice.vue 消费
 *   - features/sidebar/useSidebar 仅 ToastContainer.vue 消费（只出 selectSession spy）
 * 均为纯派生视图的状态源替换形态，无需保留式改造。
 *
 * 合并纪律：describe/it 名零改动；AsyncErrorFallback / ToastContainer 两节的
 * 原文件级 beforeEach/afterEach 下沉包裹层 describe（作用域与原单文件等价）；
 * vi.hoisted 的 stateMock 改名 inboundStateMock 消冲突。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineAsyncComponent, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AsyncErrorFallback from '@/components/ui/AsyncErrorFallback.vue'
import { createLazyChunkRetry } from '@/components/ui/lazy-chunk-retry'
import InboundFrameDroppedNotice from '../InboundFrameDroppedNotice.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import { useToast, setToastLimiter } from '@/composables/useToast'

/* ════════ 来源：InboundFrameDroppedNotice.test.ts 的状态源 mock ════════ */

const inboundStateMock = vi.hoisted(() => ({
  trippedSessionIds: { value: new Set<string>() },
}))

vi.mock('@/composables/useInboundFrameGuard', () => ({
  useInboundFrameGuardState: () => ({ trippedSessionIds: inboundStateMock.trippedSessionIds }),
}))

/* ════════ 来源：ToastContainer.test.ts 的状态源 mock ════════ */

const selectSessionSpy = vi.fn()
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ selectSession: selectSessionSpy }),
}))

/* ════════ 来源：AsyncErrorFallback.test.ts（主文件） ════════ */

describe('AsyncErrorFallback', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('AsyncErrorFallback loading/error 两态渲染（D6：无重试按钮）', () => {
    it('无 error prop → loading 态（spinner 占位）', () => {
      const wrapper = mount(AsyncErrorFallback)
      expect(wrapper.find('[data-testid="async-loading"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(false)
    })

    it('error prop → error 态：加载失败文案 + 恢复指引 + 无重试按钮', () => {
      const wrapper = mount(AsyncErrorFallback, {
        props: { error: new Error('chunk 404') },
      })
      expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(true)
      // 界面不出现重试按钮——自动重试已删（时间机制删除裁决），失败直接进错误态
      expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(false)
      // 文案给恢复指引：关闭重开 + Esc/⌘W 退出
      expect(wrapper.text()).toContain('加载失败')
      expect(wrapper.text()).toContain('关闭后重新打开可恢复')
      expect(wrapper.text()).toContain('Esc / ⌘W')
    })

    it('overlay=true + error → 占位 fixed 全屏遮罩（不参与宿主布局流），指引文案随形态保留', () => {
      const wrapper = mount(AsyncErrorFallback, {
        props: { error: new Error('chunk 404'), overlay: true },
      })
      const el = wrapper.find('[data-testid="async-error-fallback"]')
      expect(el.exists()).toBe(true)
      expect(el.classes()).toContain('fixed')
      expect(el.classes()).not.toContain('h-full')
      expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('关闭后重新打开可恢复')
    })

    it('overlay=true 无 error → loading 占位同样 fixed（loading 超 delay 也不挤压布局）', () => {
      const wrapper = mount(AsyncErrorFallback, { props: { overlay: true } })
      const el = wrapper.find('[data-testid="async-loading"]')
      expect(el.exists()).toBe(true)
      expect(el.classes()).toContain('fixed')
      expect(el.classes()).not.toContain('h-full')
    })

    it('默认形态不变（drawer 内面板占位 h-full w-full，回归防护）', () => {
      const wrapper = mount(AsyncErrorFallback, { props: { error: new Error('chunk 404') } })
      const el = wrapper.find('[data-testid="async-error-fallback"]')
      expect(el.classes()).toContain('h-full')
      expect(el.classes()).not.toContain('fixed')
    })
  })

  describe('defineAsyncComponent × createLazyChunkRetry 全链路（失败即错误态）', () => {
    // [HISTORICAL] 用例间 wrapper 必须自动 unmount（原因见 panel-container-drawer-mode.test.ts 同注释）
    enableAutoUnmount(afterEach)

    it('loader 失败 → 直接错误态呈现（无自动重试轮、无重试按钮）', async () => {
      const calls = vi.fn(() =>
        Promise.reject(new Error('Failed to fetch dynamically imported module')),
      )
      const retryState = createLazyChunkRetry(calls)
      const LazyComp = defineAsyncComponent({
        loader: retryState.loader,
        loadingComponent: AsyncErrorFallback,
        errorComponent: AsyncErrorFallback,
        delay: 0,
        onError: retryState.onError,
      })
      const Host = defineComponent({
        setup: () => () => h(LazyComp, { key: retryState.retryKey.value }),
      })

      const wrapper = mount(Host)
      await flushPromises()
      // 失败 → onError 直接 fail → errorComponent 渲染（无重试调度：时间推进 loader 不重跑）
      expect(calls).toHaveBeenCalledTimes(1)
      expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(false)
      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()
      expect(calls).toHaveBeenCalledTimes(1)
    })
  })
})

/* ════════ 来源：InboundFrameDroppedNotice.test.ts ════════ */

describe('InboundFrameDroppedNotice 入站丢帧终止阀静态提示（D8 / A6）', () => {
  beforeEach(() => {
    inboundStateMock.trippedSessionIds.value = new Set<string>()
  })

  it('终止阀生效 session：提示可见（role=alert + 标题 + 恢复指引）且标题含会话暂停语义', () => {
    inboundStateMock.trippedSessionIds.value = new Set(['s1'])
    const wrapper = mount(InboundFrameDroppedNotice, { props: { sessionId: 's1' } })

    const notice = wrapper.find('[data-testid="inbound-frame-dropped-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.attributes('role')).toBe('alert') // 静态错误页形态：响亮降级
    expect(wrapper.find('[data-testid="inbound-frame-dropped-title"]').text()).toBe('本会话数据流已暂停')
    // 恢复指引必须指向唯一恢复动作（切走再切回），不得给「对端自行恢复」的隐性承诺
    expect(wrapper.find('[data-testid="inbound-frame-dropped-hint"]').text()).toContain('切换')
    expect(wrapper.text()).toContain('再切回')
  })

  it('单 session 作用域：tripped 集合含别的 session → 本 session 不渲染（不连坐）', () => {
    inboundStateMock.trippedSessionIds.value = new Set(['other'])
    const wrapper = mount(InboundFrameDroppedNotice, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
  })

  it('终止阀未生效（集合为空）→ 不渲染', () => {
    const wrapper = mount(InboundFrameDroppedNotice, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
  })
})

/* ════════ 来源：ToastContainer.test.ts ════════ */

describe('ToastContainer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    selectSessionSpy.mockReset()
  })

  afterEach(() => {
    // 模块级单例：清空在列 toast + 归零丢弃计数，避免跨用例污染
    const { toasts, remove, resetDropped } = useToast()
    for (const t of [...toasts.value]) remove(t.id)
    resetDropped()
    vi.useRealTimers()
  })

  describe('ToastContainer session 定位行', () => {
    it('有 sessionLabel+sessionId → 渲染定位行，点击跳转并关闭 toast', async () => {
      const { toasts, warning } = useToast()
      warning('Goal blocked. Use /goal resume.', {
        sessionLabel: '修通知组件 · taiji',
        sessionId: 'sid-9',
      })
      const wrapper = mount(ToastContainer)
      const id = toasts.value[0].id

      const locator = wrapper.find(`[data-testid="toast-session-${id}"]`)
      expect(locator.exists()).toBe(true)
      expect(locator.text()).toContain('修通知组件 · taiji')

      await locator.trigger('click')
      expect(selectSessionSpy).toHaveBeenCalledWith('sid-9')
      expect(toasts.value).toHaveLength(0) // 跳转后关闭
    })

    it('无 sessionLabel → 不渲染定位行（纯消息形态）', () => {
      const { toasts, info } = useToast()
      info('plain message')
      const wrapper = mount(ToastContainer)

      expect(wrapper.find(`[data-testid="toast-session-${toasts.value[0].id}"]`).exists()).toBe(false)
      expect(wrapper.find(`[data-testid="toast-message-${toasts.value[0].id}"]`).exists()).toBe(true)
    })
  })

  describe('ToastContainer 尺寸与多行排版', () => {
    it('消息体带 pre-line + line-clamp-5，容器 max-w 收敛', () => {
      const { toasts, info } = useToast()
      info('第一行\n第二行\n第三行')
      const wrapper = mount(ToastContainer)

      const body = wrapper.find(`[data-testid="toast-message-${toasts.value[0].id}"]`)
      expect(body.classes()).toContain('whitespace-pre-line')
      expect(body.classes()).toContain('line-clamp-5')
      expect(body.classes()).toContain('break-words')

      const card = body.element.closest('div.pointer-events-auto') as HTMLElement
      expect(card.className).toContain('max-w-[min(360px,100%)]')
    })

    it('定位契约：absolute 右上角锚定（非视口 fixed），随挂载点（main-area/main）定位', () => {
      const wrapper = mount(ToastContainer)

      // 容器即 TransitionGroup tag 元素（测试环境 VTU 将其 stub，class 透传在 stub 元素上）
      const container = wrapper.find('.absolute')
      expect(container.exists()).toBe(true)
      expect(container.classes()).toContain('top-4')
      expect(container.classes()).toContain('inset-x-4')
      expect(container.classes()).not.toContain('fixed')
      expect(container.classes()).not.toContain('bottom-6')
    })
  })

  describe('ToastContainer hover 暂停自动移除', () => {
    it('mouseenter 冻结计时，mouseleave 按剩余时长续走', async () => {
      vi.useFakeTimers()
      const { toasts, info } = useToast()
      info('hover to read')
      const wrapper = mount(ToastContainer)
      const id = toasts.value[0].id
      const card = wrapper.find('div.pointer-events-auto')

      await card.trigger('mouseenter')
      vi.advanceTimersByTime(10_000) // 暂停期间不消失
      expect(toasts.value).toHaveLength(1)

      await card.trigger('mouseleave')
      vi.advanceTimersByTime(4000) // 恢复后到期移除
      await nextTick() // timer 回调改 toasts 后 DOM 异步重渲染
      expect(toasts.value).toHaveLength(0)
      expect(wrapper.find(`[data-testid="toast-message-${id}"]`).exists()).toBe(false)
    })
  })

  describe('ToastContainer 溢出折叠摘要（RD-3#7：droppedCount 的 UI 消费方）', () => {
    it('droppedCount > 0 → 渲染「还有 N 条」摘要；点击关闭归零（resetDropped）', async () => {
      const { info, droppedCount, resetDropped } = useToast()
      // 恒丢弃限流器强制产生一次丢弃（不依赖逐个入列到 MAX_IN_FLIGHT）
      setToastLimiter(() => true)
      info('dropped-1')
      expect(droppedCount.value).toBeGreaterThan(0)
      setToastLimiter(null) // 恢复默认，避免影响其它用例

      const wrapper = mount(ToastContainer)
      const summary = wrapper.find('[data-testid="toast-overflow-summary"]')
      expect(summary.exists()).toBe(true)
      // 摘要文案含当前 droppedCount（i18n mock 从 zh-CN 取词，{count} 已替换）
      expect(wrapper.find('[data-testid="toast-overflow-text"]').text()).toContain(String(droppedCount.value))

      // 点击关闭 → resetDropped 归零 → 摘要消失（droppedCount 有消费 + 重置出口）
      await summary.find('button').trigger('click')
      expect(droppedCount.value).toBe(0)
      expect(wrapper.find('[data-testid="toast-overflow-summary"]').exists()).toBe(false)

      resetDropped() // 兜底归零（幂等）
    })

    it('droppedCount = 0 → 不渲染摘要（默认态无溢出）', () => {
      const wrapper = mount(ToastContainer)
      expect(wrapper.find('[data-testid="toast-overflow-summary"]').exists()).toBe(false)
    })
  })
})
