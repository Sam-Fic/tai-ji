/**
 * useSettingsShell locale 接线测试（W03 对抗式审查 Fix-1，major）。
 *
 * 断链背景：SettingsModal 的语言 radio → settingsStore.setSystem({locale}) 是用户切语言的
 * 唯一真实路径，但 useSettingsShell 的 watch 源数组原只有 [theme, themePreset, fontSize]
 * 不含 locale → applyCurrent 不触发 → setLocale 永不被调，切语言后 UI 不变。
 *
 * 端到端链路验证（mount 真实 shell setup + 真实 core store + 真实 @/i18n）：
 * setSystem({locale:'en-US'}) → watch(flush:pre) → applyCurrent → applySystemToDom →
 * setLocale('en-US')（spy 断言被调）→ i18n.global.locale 变为 'en-US'。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/shell/__tests__/useSettingsShell.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

// ── mock 与被测行为无关的壳接线依赖（避免拖入 WS/IPC/quota 真实链路）──
// setUiLocale spy 用 vi.hoisted 提升：RL9 用例断言「locale 未变不重复推送」需要拿到同一个
// spy 实例（vi.mock 工厂提升到文件顶部，普通 const 不可引用）。
const setUiLocaleSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() }),
}))
vi.mock('@/composables/features/settings/useQuotaConfigure', () => ({
  useQuotaConfigure: vi.fn(),
}))
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    config: {
      ...actual.config,
      // 壳接线测试只关心语言推送 + detectSources，真实 config 域其余方法保留但不会被调用
      setUiLocale: setUiLocaleSpy,
      detectSources: vi.fn().mockResolvedValue([]),
    },
  }
})
vi.mock('../settings-transport-adapter', () => ({
  createSettingsTransport: vi.fn(() => ({})),
}))
vi.mock('@/platform/desktop-platform', () => ({ provideDesktopPlatform: vi.fn() }))
vi.mock('@taiji/core/transport/mock/mock-ws', () => ({ createMockPlatform: vi.fn() }))

// ── @/i18n 包装 spy：委托真实 setLocale（保留端到端 locale 真变化断言）──
const setLocaleSpy = vi.fn()
vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>()
  return {
    ...actual,
    setLocale: (locale: import('@/i18n').Locale) => {
      setLocaleSpy(locale)
      return actual.setLocale(locale)
    },
  }
})

import { useSettingsShell } from '../useSettingsShell'
import { getSettingsStore, provideSettingsStore, createSettingsStore } from '@taiji/core'
import { getLocale } from '@/i18n'
// 深路径导入（对齐 vitest-i18n-setup 范式）：RL9 用例要覆写全局 mock 平台的 storage/WS
// 双 sink（providePlatform 覆盖默认注入是 setup 注释明示的 sanctioned 形态）
import { providePlatform } from '@taiji/core/platform/port'

/** 挂载一个 setup 内调用 useSettingsShell 的探针组件（provide/watch 需组件实例上下文） */
function mountShell() {
  const Probe = defineComponent({
    setup() {
      useSettingsShell()
      return () => h('div')
    },
  })
  return mount(Probe)
}

beforeEach(() => {
  localStorage.clear()
  setLocaleSpy.mockClear()
  setUiLocaleSpy.mockClear()
  provideSettingsStore(createSettingsStore())
})

describe('useSettingsShell · locale 接线（Fix-1）', () => {
  it('setSystem({locale}) 触发 setLocale 且 i18n.global.locale 真实切换（zh→en→zh）', async () => {
    const wrapper = mountShell()
    const store = getSettingsStore()
    expect(getLocale()).toBe('zh-CN') // 前置：store 默认 zh-CN

    // 用户切英文（SettingsModal 语言 Select 的真实路径）
    await store.setSystem({ locale: 'en-US' })
    await nextTick() // watch flush:pre 派发 applyCurrent
    expect(setLocaleSpy).toHaveBeenCalledWith('en-US')
    // en-US 动态 import 完成后 locale 真实翻转（端到端，非仅 spy）
    await vi.waitFor(() => expect(getLocale()).toBe('en-US'), { interval: 1 })

    // 切回中文同样即时生效（watch 源含 locale 后双向都有响应）
    await store.setSystem({ locale: 'zh-CN' })
    await nextTick()
    expect(setLocaleSpy).toHaveBeenLastCalledWith('zh-CN')
    await vi.waitFor(() => expect(getLocale()).toBe('zh-CN'), { interval: 1 })

    wrapper.unmount()
  })

  it('mount 时初始 applyCurrent 兜底调用过 setLocale（store 默认 zh-CN）', async () => {
    const wrapper = mountShell()
    // 初始 apply：applySystemToDom 以 store 当前 system（DEFAULT_SYSTEM.locale='zh-CN'）调用 setLocale
    expect(setLocaleSpy).toHaveBeenCalledWith('zh-CN')
    wrapper.unmount()
  })
})

describe('useSettingsShell · 字体槽位接线（font-system U3）', () => {
  const SLOT_UI = '--font-ui'
  const SLOT_MONO = '--font-mono-ui'

  /** 清掉上一例留下的内联槽位（watch 写入目标 = documentElement.style） */
  beforeEach(() => {
    const style = document.documentElement.style
    style.removeProperty(SLOT_UI)
    style.removeProperty(SLOT_MONO)
  })

  it('setSystem({fonts:{ui}}) 触发槽位写入（带引号），不需重启即生效', async () => {
    const wrapper = mountShell()
    const store = getSettingsStore()
    expect(document.documentElement.style.getPropertyValue(SLOT_UI)).toBe('')

    // 设置页选界面字体的唯一真实路径：settingsStore.setSystem({ fonts })
    await store.setSystem({ fonts: { ui: 'Maple Mono' } })
    await nextTick()

    // 断言 = 槽位变量被写（本用例即 watch 源含 fonts 的行为证据；漏加 fonts 则值为空）
    expect(document.documentElement.style.getPropertyValue(SLOT_UI)).toBe("'Maple Mono'")
    wrapper.unmount()
  })

  it('字体槽位 watch 覆盖 fonts 字段本身（就地改写 fonts 也触发写入）', async () => {
    const wrapper = mountShell()
    const store = getSettingsStore()
    // 就地改写（不替换 system 对象/引用）：只有 watch 源显式读取了 fonts 才会被追踪到，
    // 这也是「watch 源数组含 fonts」的行为判据——漏加 fonts 时本用例红（仅靠 setSystem
    // 替换 system.value 的引用变化会掩盖漏加，见历史 locale 事故）。
    store.system.value.fonts = { ui: 'Maple Mono' }
    await nextTick()

    expect(document.documentElement.style.getPropertyValue(SLOT_UI)).toBe("'Maple Mono'")
    wrapper.unmount()
  })

  it('两槽位兄弟字段互不覆盖：先后设置后两个槽位同在', async () => {
    const wrapper = mountShell()
    const store = getSettingsStore()

    await store.setSystem({ fonts: { ui: 'Maple Mono' } })
    await nextTick()
    // 写 mono 时必须 spread 既有值（兄弟字段语义）
    await store.setSystem({ fonts: { ...store.system.value.fonts, mono: 'Fira Code' } })
    await nextTick()

    expect(document.documentElement.style.getPropertyValue(SLOT_UI)).toBe("'Maple Mono'")
    expect(document.documentElement.style.getPropertyValue(SLOT_MONO)).toBe("'Fira Code'")
    wrapper.unmount()
  })

  it('清除选择（槽位缺失）→ removeProperty 回到「未声明」，回落链恢复', async () => {
    const wrapper = mountShell()
    const store = getSettingsStore()

    await store.setSystem({ fonts: { ui: 'Maple Mono', mono: 'Fira Code' } })
    await nextTick()
    expect(document.documentElement.style.getPropertyValue(SLOT_UI)).not.toBe('')

    await store.setSystem({ fonts: { mono: 'Fira Code' } })
    await nextTick()

    // 空字符串 = 属性已被 removeProperty 删除（未声明）；不是「声明为空值」
    expect(document.documentElement.style.getPropertyValue(SLOT_UI)).toBe('')
    expect(document.documentElement.style.getPropertyValue(SLOT_MONO)).toBe("'Fira Code'")
    wrapper.unmount()
  })
})

describe('useSettingsShell · RL9 渲染路径零 IO（font-system AX5 精确版 / V6 强形态）', () => {
  it(
    'fonts 变更触发 applyCurrent：恰好 1 次合法保存 + 渲染路径零额外 storage.set/零 WS send + locale 未变不重复推送',
    async () => {
      // 设计 §4.2 RL9 强形态（V6 步骤 3/4 的 L1 版，settings-suite.test.ts 原形之上的壳侧延伸）：
      // - V6 第 3 步：用户显式选择（setSystem）→ 恰好 1 次 storage.set（合法保存，不多不少）；
      // - V6 第 4 步：渲染路径（applyCurrent→applySystemToDom）零额外 storage.set、零 WS send；
      // - locale 未变 → pushUiLocale 幂等守卫不重复推送（mount 初始 apply 已推过一次，V3(b)）。
      // 双 sink spy 接在真实通道上：storage.set = KVStorage 缝（setSystem 的持久化落点），
      // WS send = 平台 webSocket 通道帧 + config.setUiLocale seam（locale 跨进程推送唯一出口）。
      const storageSet = vi.fn()
      const wsSend = vi.fn()
      providePlatform({
        kind: 'mock',
        storage: { get: async () => null, set: storageSet, remove: async () => {} },
        webSocket: {
          create: () => ({
            readyState: 0,
            send: wsSend,
            close: () => {},
            onopen: null,
            onclose: null,
            onmessage: null,
            onerror: null,
          }),
        },
      })

      const wrapper = mountShell()
      const store = getSettingsStore()

      // 前置：mount 初始 applyCurrent 只推一次 locale（lastPushedLocale undefined → 首推，V3(b)）
      expect(setUiLocaleSpy).toHaveBeenCalledTimes(1)

      storageSet.mockClear()
      await store.setSystem({ fonts: { ui: 'Maple Mono' } })
      await nextTick()

      // 渲染路径真实跑过（槽位已写，前置有效性）
      expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe("'Maple Mono'")
      // V6 第 3 步：用户显式选择恰好 1 次 storage.set（不多不少）
      expect(storageSet).toHaveBeenCalledTimes(1)
      // V6 第 4 步：渲染路径零 WS 帧（平台 WS 通道）
      expect(wsSend).toHaveBeenCalledTimes(0)
      // locale 未变 → 不重复推送（删 pushUiLocale 幂等守卫或渲染路径误发消息时红）
      expect(setUiLocaleSpy).toHaveBeenCalledTimes(1)

      wrapper.unmount()
    },
  )
})
