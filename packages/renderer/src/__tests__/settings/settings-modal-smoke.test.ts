/**
 * SettingsModal 首屏冒烟（W4 · AC12 渲染 gate）。
 *
 * 验证 useSettingsShell 壳接入后 SettingsModal 能渲染关键 DOM（AGENTS.md 测试规范 §8）：
 * mount SettingsModal(open=true)，providePlatform(in-memory) + provideSettingsTransport(stub)
 * + provide ui 注入 key stub + mock @/api 门面（避免 WS），断言：
 *   ① Dialog 内容渲染（标题 + 导航）
 *   ② provider 导航项存在（settings-nav-provider）
 *   ③ 默认 provider 页区渲染（ProviderPage 表单区）
 *
 * 另含（原独立文件 settings-modal-skill-dirs.test.ts 并入，同 mount 脚手架）：
 * W2 · D10 回归——onUpdateSkillDirs 的 transport.setSkillDirs reject 时 error toast
 * 反馈（非静默吞，AGENTS.md 规则 #3）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/settings-modal-smoke.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  providePlatform,
  provideSettingsTransport,
  __resetPlatformForTesting,
  provideSettingsStore,
  createSettingsStore,
} from '@taiji/core'
import {
  SETTINGS_TOAST_KEY,
  QUOTA_CONFIGURE_FACTORY_KEY,
} from '@taiji/ui/features/settings'

// @/api 门面 mock：所有 config/extension/model/settings 域返回空/resolved，避免 WS 调用。
// 成员面单源在 helpers/settings-modal-api-mock.ts（成员存在理由注释亦在该文件）。
vi.mock('@/api', () => settingsModalApiModule())

// lib/ipc mock：SystemPage/TerminalPage 读 systemSounds 等 ipc，避免 electronAPI 缺失报错。
vi.mock('@/lib/ipc', () => ({
  listSystemSounds: vi.fn(async () => ({ sounds: [] })),
  getProxyConfig: vi.fn(async () => ({})),
  setProxyConfig: vi.fn(async () => undefined),
  testProxy: vi.fn(async () => ({ success: true })),
  // SettingsResourcePage forcedDirs 动态化调用（返回 undefined → user 级强制目录不展示）
  getDataDir: vi.fn(async () => undefined),
  // 目录选择（SystemPage chooseDirectory）
  chooseDirectory: vi.fn(async () => null),
}))

// '@/api' mock 工厂 import 必须先于组件 import 求值：SettingsModal 模块图加载 '@/api' 时
// vi.mock 工厂立即执行，晚于组件 import 的工厂绑定仍在 TDZ（vi.hoisted 同族坑）。
import { settingsModalApiModule } from '../helpers/settings-modal-api-mock'
import { inMemoryStorage } from '../helpers/platform-storage-stub'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import SettingsResourcePage from '@/components/settings/resource/SettingsResourcePage.vue'
import ProviderPage from '@/components/settings/provider/ProviderPage.vue'
import { makeQuotaModuleStub } from '@taiji/core/testing'
import type { SkillDirConfig } from '@taiji/shared'
import { useToast } from '@/composables/useToast'
import { getSettingsStore } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'
import { ModelRoutePage } from '@taiji/ui/features/settings'
import { config as configApi } from '@/api'
import type { AggregationRouteCard, ProviderInfo } from '@taiji/shared'

/** 挂载 open=true 的 SettingsModal（spy toast provide：toast 三面用 spy，不桥接 useToast；
 *  quota 工厂键保留 InjectionKey 类型，契约门由 makeQuotaModuleStub 的 QuotaConfigureModule
 *  返回标注承担，契约漏成员即编译错）。initialSection 传深链直达分区（U10 深链直开形态）。 */
function mountOpenModalWithSpyToasts(initialSection?: string): ReturnType<typeof mount> {
  return mount(SettingsModal, {
    props: initialSection === undefined ? { open: true } : { open: true, initialSection },
    attachTo: document.body,
    global: {
      provide: {
        [SETTINGS_TOAST_KEY as symbol]: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
        [QUOTA_CONFIGURE_FACTORY_KEY]: () => makeQuotaModuleStub(),
      },
    },
  })
}

/** mock 平台注入（in-memory storage + 立即关闭的 no-op WebSocket，避免 WS 连接）。 */
function provideMockPlatform(): void {
  providePlatform({
    kind: 'mock',
    storage: inMemoryStorage(),
    webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetPlatformForTesting()
  provideSettingsStore(createSettingsStore())
})

// 懒加载语义测试断言 document.activeElement，用例间必须卸载 teleport 到 body 的挂载件
enableAutoUnmount(afterEach)

describe('SettingsModal 首屏冒烟（AC12 渲染 gate）', () => {
  it('open=true 时渲染 Dialog 标题 + provider 导航项 + provider 页区', async () => {
    provideMockPlatform()
    provideSettingsTransport(makeSettingsTransportStub())

    mountOpenModalWithSpyToasts()
    await flushPromises()

    // ① Dialog 标题渲染（settings.title → 中文「设置」）
    const body = document.body.textContent ?? ''
    expect(body).toContain('设置')
    // ② provider 导航项存在（Dialog 内容 teleport 到 document.body，用 DOM 查询）
    expect(document.body.querySelector('[data-testid="settings-nav-provider"]')).not.toBeNull()
    // ③ provider 页区渲染（ProviderPage「添加供应商」按钮，i18n 中文）
    expect(body).toContain('添加') // settings.provider.add 含「添加」
  })
})

describe('SettingsModal 懒加载挂载即 open 的 open 语义（W31 review major-1 回归防护）', () => {
  it('挂载即 open=true：refreshProviders 被调用 + 焦点落点 = 顶栏关闭钮（demo settings spec §3.1）', async () => {
    provideMockPlatform()
    // refreshProviders → getSettingsTransport().listProviders()（模块级单例）→ spy 在此
    const listProvidersSpy = vi.fn(async () => ({ providers: [] }))
    provideSettingsTransport({ ...makeSettingsTransportStub(), listProviders: listProvidersSpy })

    // 模拟 AppShell 懒加载场景：settingsOpen=true 与组件挂载同帧，props.open 初始即 true。
    // 修复前 watch 无 immediate，无变化沿 → 回调不执行 → refreshProviders/焦点初始化全部跳过。
    mountOpenModalWithSpyToasts()
    await flushPromises()

    // ① open 语义：providers 快照刷新被触发（settings-lifecycle「打开 modal 时刷新」契约）
    expect(listProvidersSpy).toHaveBeenCalledTimes(1)
    // ② 焦点语义：nextTick 后焦点落在顶栏关闭钮（demo 锚定行为；Tab 不会游走到被遮住的背景控件）
    const closeBtn = document.body.querySelector<HTMLElement>('[data-testid="settings-close-btn"]')
    expect(closeBtn).not.toBeNull()
    expect(document.activeElement).toBe(closeBtn)
  })
})

describe('SettingsModal 分区切换 v-show 常挂载语义（demo settings spec §2/§3.3 裁决 6A）', () => {
  /** 点击 nav 分区项（DOM 级 click，与真机同路径） */
  async function clickNav(testid: string): Promise<void> {
    const btn = document.body.querySelector<HTMLElement>(`[data-testid="settings-nav-${testid}"]`)
    expect(btn).toBeTruthy()
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
  }

  it('切走再切回：ProviderPage 组件实例保留（v-show 常挂载非销毁重建，已填表单态不丢）', async () => {
    provideMockPlatform()
    provideSettingsTransport(makeSettingsTransportStub())

    const wrapper = mountOpenModalWithSpyToasts()
    await flushPromises()

    const providerBefore = wrapper.findComponent(ProviderPage)
    expect(providerBefore.exists()).toBe(true)

    // 切到 skill：两个分区 div 都常挂载（v-show），可见态恰一个且随激活位移
    await clickNav('skill')
    const providerDuring = wrapper.findComponent(ProviderPage)
    expect(providerDuring.exists()).toBe(true)
    // 实例身份 = $.uid（内部实例 id，挂载一次生成一次；v-if 重建形态下会换新，断言即红）
    expect(providerDuring.vm.$.uid).toBe(providerBefore.vm.$.uid)
    const visibleDivs = (): HTMLElement[] =>
      [...document.body.querySelectorAll<HTMLElement>('.content-col-inner .sec-fade')]
        .filter((d) => d.style.display !== 'none')
    expect(document.body.querySelectorAll('.content-col-inner .sec-fade').length).toBe(2)
    expect(visibleDivs().length).toBe(1)

    // 切回 provider：实例未变 + 可见态切回 provider
    await clickNav('provider')
    const providerAfter = wrapper.findComponent(ProviderPage)
    expect(providerAfter.exists()).toBe(true)
    expect(providerAfter.vm.$.uid).toBe(providerBefore.vm.$.uid)
    expect(visibleDivs().length).toBe(1)
    expect(providerAfter.element.closest('.sec-fade.on')).not.toBeNull()
  })
})

describe('SettingsModal onUpdateSkillDirs 错误反馈（W2 D10，原 settings-modal-skill-dirs.test.ts 并入）', () => {
  it('transport.setSkillDirs reject → 触发 error toast（非静默失败）', async () => {
    provideMockPlatform()
    provideSettingsTransport(makeSettingsTransportStub({ setSkillDirs: () => Promise.reject(new Error('network down')) }))

    // toast 断言走真实 useToast 单例（SETTINGS_TOAST_KEY 桥接到 useToast）
    const { toasts } = useToast()
    toasts.value = []

    const wrapper = mount(SettingsModal, {
      props: { open: true },
      attachTo: document.body,
      global: {
        provide: {
          [SETTINGS_TOAST_KEY as symbol]: { error: (m: string) => useToast().error(m), info: (m: string) => useToast().info(m), warning: (m: string) => useToast().warning(m) },
          // 不再 `as symbol` 强转：保留 InjectionKey 类型；契约门由 makeQuotaModuleStub 的
          // QuotaConfigureModule 返回标注承担（契约漏成员即编译错）。
          [QUOTA_CONFIGURE_FACTORY_KEY]: () => makeQuotaModuleStub(),
        },
      },
    })
    await flushPromises()

    // 切到 skill 菜单（SettingsResourcePage 在 skill 菜单下渲染）
    const skillBtn = document.body.querySelector('[data-testid="settings-nav-skill"]')
    expect(skillBtn).toBeTruthy()
    skillBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    const resourcePage = wrapper.findComponent(SettingsResourcePage)
    expect(resourcePage.exists()).toBe(true)
    const dirs: SkillDirConfig[] = [{ path: '/x', enabled: true, scope: 'global' }]
    resourcePage.vm.$emit('update-dirs', dirs)
    await flushPromises()

    // 断言：error toast 已产生（非静默吞）
    expect(toasts.value.some((t) => t.type === 'error')).toBe(true)
    expect(toasts.value.some((t) => t.message.includes('network down'))).toBe(true)
  })
})

describe('SettingsModal 路径保存失败回弹（RD-4#1：失败强制回弹 UI + LoadPaths 常驻错误态）', () => {
  /**
   * 权威值源说明：dirs 域无 getter RPC（协议仅 set + 成功后广播），store 的 *Dirs 镜像只被
   * runtime 成功落盘后的广播写入，故镜像恒为「最近落盘值」。失败回弹 = LoadPaths 从该镜像
   * 重新拉取（saveError 通道驱动），行为级断言即「勾选态回弹 + 常驻红字」。
   */
  function mountModalWithFailingSkillDirs(): ReturnType<typeof mount> {
    provideMockPlatform()
    provideSettingsTransport(makeSettingsTransportStub({ setSkillDirs: () => Promise.reject(new Error('disk full')) }))
    return mount(SettingsModal, {
      props: { open: true },
      attachTo: document.body,
      global: {
        provide: {
          [SETTINGS_TOAST_KEY as symbol]: { error: (m: string) => useToast().error(m), info: (m: string) => useToast().info(m), warning: (m: string) => useToast().warning(m) },
          [QUOTA_CONFIGURE_FACTORY_KEY]: () => makeQuotaModuleStub(),
        },
      },
    })
  }

  it('skill 页勾选目录保存失败 → toast + 常驻红字 + 勾选态回弹至最近落盘值', async () => {
    // store 镜像预置最近落盘值（enabled:false——广播镜像即磁盘态）
    const persisted: SkillDirConfig[] = [{ path: '/persisted/skills', enabled: false, scope: 'global' }]
    getSettingsStore().skillDirs.value = persisted

    const { toasts } = useToast()
    toasts.value = []

    mountModalWithFailingSkillDirs()
    await flushPromises()

    // 切到 skill 菜单（SettingsResourcePage + LoadPaths 在该菜单下渲染）
    const skillBtn = document.body.querySelector('[data-testid="settings-nav-skill"]')
    expect(skillBtn).toBeTruthy()
    skillBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    // 用户勾选目录（LoadPaths 乐观编辑 → emit → 持久化 RPC reject）
    const checkbox = document.body.querySelector<HTMLElement>('[data-testid="dir-row"] button[role="checkbox"]')
    expect(checkbox).not.toBeNull()
    expect(checkbox!.getAttribute('data-state')).toBe('unchecked')
    checkbox!.click()
    await flushPromises()

    // 失败显形（三层）：error toast + 常驻红字 + 勾选态回弹（最近落盘值 enabled:false）
    expect(toasts.value.some((t) => t.type === 'error' && t.message.includes('disk full'))).toBe(true)
    expect(document.body.querySelector('[data-testid="load-paths-save-error"]')).not.toBeNull()
    expect(checkbox!.getAttribute('data-state')).toBe('unchecked')
  })
})


/** 注入一个含模型的渠道 provider（引导卡 routeGuideVisible 判据 = 渠道有模型）。
 *  调用时点须在 mount+flush 之后：open watch immediate 的 refreshProviders 会以
 *  mock 空列表覆盖预置 providers。模型路由分区的两个 describe 共用。 */
function seedProvider(): ProviderInfo {
  const provider: ProviderInfo = {
    id: 'zhipu' as ProviderInfo['id'], // ProviderId branded string
    name: 'zhipu',
    kind: 'catalog',
    apiKeySet: true,
    status: 'connected',
    models: [{ id: 'glm-5-3', name: 'GLM-5.3 Flash' }],
  }
  getSettingsStore().setProviders([provider])
  return provider
}

describe('SettingsModal 模型路由分区接线（provider-aggregation D10 两屏 / U2 一致性修复）', () => {
  it('分区已登记：settings-nav-model-route 渲染；首访点击切换后 ModelRoutePage 挂载且不重拉（provider 分区已首拉缓存）', async () => {
    provideMockPlatform()
    provideSettingsTransport(makeSettingsTransportStub())

    const wrapper = mountOpenModalWithSpyToasts()
    await flushPromises()
    seedProvider()
    await flushPromises()

    // 分区登记（lib/content-slots SETTINGS_SECTION_SPECS）→ nav 项渲染
    const navBtn = document.body.querySelector('[data-testid="settings-nav-model-route"]')
    expect(navBtn).not.toBeNull()

    // 缺省分区 = provider：路由引用呈现（U5 补呈现 · spec §6.3/§6.4）需要 routeView，
    // provider 分区首访已触发拉取（拉取时机跟随需要该数据的分区首访，不再「开弹层不预拉」）
    expect(configApi.getRouteView).toHaveBeenCalled()
    const callsAtOpen = vi.mocked(configApi.getRouteView).mock.calls.length

    // 首访点击 → activeView 切换 → 编排缓存单点命中（ensureRouteView fetchStarted 守卫），
    // 不产生第二次拉取；视图到位后 ModelRoutePage 挂载
    navBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(vi.mocked(configApi.getRouteView).mock.calls.length).toBe(callsAtOpen)
    const page = wrapper.findComponent(ModelRoutePage)
    expect(page.exists()).toBe(true)
  })

  it('ProviderPage 引导卡「打开模型路由」→ 切模型路由分区渲染路由页（跳转生效，spec §6.5）', async () => {
    provideMockPlatform()
    provideSettingsTransport(makeSettingsTransportStub())

    const wrapper = mountOpenModalWithSpyToasts()
    await flushPromises()
    seedProvider()
    await flushPromises()

    // 引导卡可见（渠道有模型）→ 点「打开模型路由」
    const guideBtn = document.body.querySelector<HTMLElement>('[data-testid="provider-open-route-btn"]')
    expect(guideBtn).not.toBeNull()
    guideBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    // 跳转生效：nav 高亮 model-route + 路由页挂载（openRoutePage 守卫正常路径命中，跳转不被吞）
    expect(document.body.querySelector('[data-testid="settings-nav-model-route"]')?.getAttribute('aria-current')).toBe('page')
    expect(wrapper.findComponent(ModelRoutePage).exists()).toBe(true)
  })
})

describe('SettingsModal 模型路由分区首拉与删除链路（provider-aggregation U10/U11/U9 删除侧残留修复）', () => {
  /** 本 describe 直开 model-route（深链/首拉语义），各用例独立统计 getRouteView 调用。 */
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** 单路由卡视图 fixture（成员渠道与 seedProvider 一致；scoped=false = 未参与选择，
   *  测试环境 store 白名单为空——scoped 卡会被 buildRoutePageCards 派生丢弃落空态）。 */
  function oneRouteView(): { cards: AggregationRouteCard[]; orphanRefs: string[] } {
    return {
      cards: [{
        route: {
          id: 'r1',
          name: 'R1',
          modelId: 'r1',
          enabled: true,
          mode: 'simple',
          members: [{ id: 'a', providerId: 'zhipu', modelId: 'glm-5-3', type: 'none' }],
          specials: [],
        },
        scoped: false,
        scopedIndex: -1,
        memberIssues: [],
      }],
      orphanRefs: [],
    }
  }

  it('深链直开 model-route：挂载即首访拉取（U10 watch immediate），无需 nav 点击', async () => {
    provideMockPlatform()
    provideSettingsTransport(makeSettingsTransportStub())

    const wrapper = mountOpenModalWithSpyToasts('model-route')
    await flushPromises()
    seedProvider()
    await flushPromises()

    // immediate 缺失时 activeMenu 初值无变化沿 → 拉取被跳过 = 内容纯空白（U10 回归锚）
    expect(configApi.getRouteView).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(ModelRoutePage).exists()).toBe(true)
  })

  it('首拉进行中：model-route 分区呈加载占位（U11），内容分支不挂载', async () => {
    provideMockPlatform()
    provideSettingsTransport(makeSettingsTransportStub())
    vi.mocked(configApi.getRouteView).mockImplementationOnce(() => new Promise(() => {}))

    const wrapper = mountOpenModalWithSpyToasts('model-route')
    await flushPromises()

    expect(document.body.querySelector('[data-testid="model-route-loading"]')).not.toBeNull()
    expect(wrapper.findComponent(ModelRoutePage).exists()).toBe(false)
  })

  it('首拉失败：加载失败占位 + 重试入口（U11），重试成功后内容挂载', async () => {
    provideMockPlatform()
    provideSettingsTransport(makeSettingsTransportStub())
    vi.mocked(configApi.getRouteView)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(oneRouteView())

    const wrapper = mountOpenModalWithSpyToasts('model-route')
    await flushPromises()

    expect(document.body.querySelector('[data-testid="model-route-load-failed"]')).not.toBeNull()
    expect(wrapper.findComponent(ModelRoutePage).exists()).toBe(false)
    const retry = document.body.querySelector<HTMLElement>('[data-testid="model-route-retry"]')
    expect(retry).not.toBeNull()
    // 重试 = 重新 ensureRouteView（失败复位守卫后放行）
    retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.findComponent(ModelRoutePage).exists()).toBe(true)
    expect(configApi.getRouteView).toHaveBeenCalledTimes(2)
  })

  it('卡头删除 → 确认弹层确认 → deleteRoute 端口被消费 + 主动拉取收敛（U9 删除侧链路）', async () => {
    provideMockPlatform()
    provideSettingsTransport(makeSettingsTransportStub())
    vi.mocked(configApi.getRouteView).mockResolvedValue(oneRouteView())

    const wrapper = mountOpenModalWithSpyToasts('model-route')
    await flushPromises()
    seedProvider()
    await flushPromises()
    expect(wrapper.findComponent(ModelRoutePage).exists()).toBe(true)

    const deleteBtn = document.body.querySelector<HTMLElement>('[data-testid="route-delete-btn"]')
    expect(deleteBtn).not.toBeNull()
    deleteBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    // 确认弹层（zh locale 实文案「删除」）→ 确认
    const confirmBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === '删除')
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()
    expect(configApi.deleteRoute).toHaveBeenCalledWith('r1')
    // 删除成功后的主动拉取收敛（不依赖广播时序；视图刷新承载卡移除）
    expect(configApi.getRouteView).toHaveBeenCalledTimes(2)
  })
})
