/**
 * SettingsModal 懒加载错误态的 Esc 退出通道（provider-aggregation 验收登记实证 + 回归锁定）。
 *
 * 背景：SettingsModal 经 defineAsyncComponent 懒加载（AppShell，v-if 门控），装载失败时
 * errorComponent（AsyncErrorFallback overlay，模态表面 'async-error-fallback-overlay'）
 * 替换其挂载——SettingsModal 自身的 window 级 Esc 兜底监听随组件消失，而占位表面在
 * modal-surface-registry 登记 yieldsEsc ⇒ 编排器 Esc 分支让位后无人消费。文案
 * （common.loadFailedHint「Esc / ⌘W 可退出」）承诺的退出通道在此态是否真实可用，由本文件
 * 以组件级真实事件驱动判定。
 *
 * 装配复刻（与 AppShell.vue 同构）：useKeyOrchestrator（AppShell setup 首位注册）+
 * defineAsyncComponent（loader 失败 / errorComponent = overlay 包装）+ v-if settingsOpen
 * 宿主。组件件全部用实装（createLazyChunkRetry / AsyncErrorFallback / 编排器 / 登记表），
 * 仅宿主装配为最小复刻。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/settings-error-esc.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineAsyncComponent, defineComponent, h, ref } from 'vue'
import type { Component } from 'vue'
import AsyncErrorFallback from '@/components/ui/AsyncErrorFallback.vue'
import { createLazyChunkRetry } from '@/components/ui/lazy-chunk-retry'
import {
  registerModalSurface,
  resetModalSurfaceRegistry,
  isModalSurfaceOpen,
} from '@/composables/features/app/modal-surface-registry'
import {
  useKeyOrchestrator,
  _resetKeyOrchestratorForTest,
} from '@/composables/features/app/key-orchestrator'
import { useSettingsErrorEsc } from '@/composables/shell/useSettingsErrorEsc'

/** overlay 包装（复刻 AppShell 的 SettingsModalFallback：defineAsyncComponent 的
 *  errorComponent 只收 error prop，overlay 由包装固定传入） */
const OverlayFallbackShell = defineComponent({
  name: 'OverlayFallbackShell',
  props: { error: null },
  setup: (fallbackProps) => () => h(AsyncErrorFallback, { error: fallbackProps.error, overlay: true }),
})

function escEvent(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
}

/**
 * 挂载懒加载宿主（复刻 AppShell 装配全量：编排器首位注册 + 错误态 Esc 兜底 + v-if 门控 +
 * v-model:open 形态）。loader 由调用方给定（恒失败 / 两态切换）。
 */
function mountHost(loader: () => Promise<Component>) {
  const settingsOpen = ref(true)
  const retry = createLazyChunkRetry(loader)
  const LazySettings = defineAsyncComponent({
    loader: retry.loader,
    loadingComponent: OverlayFallbackShell,
    errorComponent: OverlayFallbackShell,
    delay: 0,
    onError: retry.onError,
  })
  const Host = defineComponent({
    setup() {
      useKeyOrchestrator()
      useSettingsErrorEsc(
        () => settingsOpen.value,
        () => retry.failed.value,
        () => { settingsOpen.value = false },
      )
      return () => (settingsOpen.value ? h(LazySettings) : null)
    },
  })
  const host = mount(Host, { attachTo: document.body })
  return { host, settingsOpen, retry }
}

/** 正常态设置页 stub（loader 成功分支的 resolved 组件；自身无任何 Esc 通道） */
const LoadedSettingsStub = defineComponent({
  name: 'LoadedSettingsStub',
  setup: () => () => h('div', { 'data-testid': 'settings-loaded' }),
})

beforeEach(() => {
  setActivePinia(createPinia())
  resetModalSurfaceRegistry()
})

enableAutoUnmount(afterEach)

afterEach(() => {
  _resetKeyOrchestratorForTest()
  resetModalSurfaceRegistry()
})

describe('SettingsModal 懒加载错误态 Esc 退出（AsyncErrorFallback overlay 占位）', () => {
  const failLoader = (): Promise<never> => Promise.reject(new Error('chunk load failed'))

  it('错误态按 Esc 关闭设置弹层（defaultPrevented + 占位卸载）', async () => {
    const { settingsOpen } = mountHost(failLoader)
    await flushPromises()

    // 前提锁定：错误态呈现（无重试按钮）+ 占位表面已注册（编排器让位的判定来源）
    expect(document.body.querySelector('[data-testid="async-error-fallback"]')).not.toBeNull()
    expect(isModalSurfaceOpen('async-error-fallback-overlay')).toBe(true)

    // 真实事件驱动：window keydown Escape（焦点任意位置，bubble 相位）
    const evt = escEvent()
    window.dispatchEvent(evt)
    await flushPromises()

    expect(evt.defaultPrevented, 'Esc 被消费（preventDefault）').toBe(true)
    expect(settingsOpen.value, 'settingsOpen 已关（关闭路径生效）').toBe(false)
    expect(
      document.body.querySelector('[data-testid="async-error-fallback"]'),
      '占位随宿主关闭卸载',
    ).toBeNull()
  })

  it('其他让位成员开着 → Esc 归内层（错误态不自关，内层让位口径同 SettingsModal 兜底）', async () => {
    const { settingsOpen } = mountHost(failLoader)
    await flushPromises()

    // 模拟占位上叠着另一让位成员（search-modal 族 yieldsEsc）
    const dispose = registerModalSurface({ surface: 'search-modal', key: 'esc-yield-stub', isOpen: () => true })
    const evt = escEvent()
    window.dispatchEvent(evt)
    await flushPromises()

    // 让位口径（同 SettingsModal window 兜底）：不动作、不消费（defaultPrevented=false，
    // 事件留给真实内层消费者），错误态不自关
    expect(evt.defaultPrevented, '让位不消费事件').toBe(false)
    expect(settingsOpen.value, '错误态不自关').toBe(true)
    expect(document.body.querySelector('[data-testid="async-error-fallback"]')).not.toBeNull()
    dispose()
  })

  it('正常态零介入：加载成功后宿主兜底退出，Esc 不被宿主抢消费', async () => {
    const { settingsOpen, retry } = mountHost(() => Promise.resolve(LoadedSettingsStub))
    await flushPromises()

    // 正常态呈现（SettingsModal 本体在位），failed 已随成功复位
    expect(document.body.querySelector('[data-testid="settings-loaded"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="async-error-fallback"]')).toBeNull()
    expect(retry.failed.value, 'loader 成功复位 failed').toBe(false)

    // Esc：编排器全关态不动作，宿主兜底已随 failed=false 卸载 → 关闭路径不触发
    // （正常态 Esc 归 SettingsModal 自身通道，其内层弹层让位语义不被宿主干扰）
    const evt = escEvent()
    window.dispatchEvent(evt)
    await flushPromises()

    expect(evt.defaultPrevented, '正常态无消费者（编排器全关 + 宿主兜底已卸载）').toBe(false)
    expect(settingsOpen.value, '正常态弹层不被宿主兜底关闭').toBe(true)
    expect(document.body.querySelector('[data-testid="settings-loaded"]')).not.toBeNull()
  })

  it('失败 → Esc 关闭 → 重开加载成功：failed 复位，正常态 Esc 不再走错误兜底', async () => {
    let failFirst = true
    const { settingsOpen, retry } = mountHost(() =>
      failFirst ? Promise.reject(new Error('chunk load failed')) : Promise.resolve(LoadedSettingsStub),
    )
    await flushPromises()

    // 第一轮失败：错误态 Esc 关闭（文案承诺的「关闭后重新打开」出路真实可用）
    expect(document.body.querySelector('[data-testid="async-error-fallback"]')).not.toBeNull()
    window.dispatchEvent(escEvent())
    await flushPromises()
    expect(settingsOpen.value).toBe(false)
    expect(document.body.querySelector('[data-testid="async-error-fallback"]')).toBeNull()

    // 重开（v-if 重挂 = 全新一轮 fresh load）：第二轮成功 → 正常态，failed 复位
    failFirst = false
    settingsOpen.value = true
    await flushPromises()
    expect(document.body.querySelector('[data-testid="settings-loaded"]')).not.toBeNull()
    expect(retry.failed.value, '重开成功后 failed 复位（宿主兜底退出）').toBe(false)

    // 正常态 Esc 不被宿主兜底关闭（消费权归 SettingsModal 自身通道）
    window.dispatchEvent(escEvent())
    await flushPromises()
    expect(settingsOpen.value, '正常态弹层保持开着').toBe(true)
  })
})
