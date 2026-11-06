/**
 * ProviderPage 渲染测试（W9 + W4 + R4 手风琴就地编辑）。
 *
 * 覆盖：
 *  - 首屏冒烟：providers=[] → 渲染「添加供应商」按钮 + 空状态。
 *  - R4：点击添加 → 不弹 Dialog，列表底部新建合成行并展开（provider-expand-body 渲染）。
 *  - R4：点击供应商名称 → 行内展开就地编辑体（无 Dialog teleport）。
 *  - U5（W4）：默认模型标记从 settingsStore.defaultModel 派生。
 *
 * mock 策略：
 *  - vi.mock('@/api') 替换 config 门面。
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=settings npx vitest run src/__tests__/settings/ProviderPage.test.ts（本文件登记在 domain-map.json settings 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { BuiltinProviderTemplate, ProviderInfo } from '@taiji/shared'
import { getSettingsStore, provideSettingsTransport, provideSettingsStore, createSettingsStore } from '@taiji/core'
// '@/api' mock 工厂解引用的 helper import 必须先于触发工厂执行的组件 import 求值
// （vi.hoisted 同族 TDZ 坑，settings-modal-smoke.test.ts 先例）。
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'
import { apiProjectMock } from '../helpers/api-facade-mock'
import { authEventCbs } from '../helpers/oauth-auth-events-mock'

const configMock = vi.hoisted(() => ({
  onProviders: vi.fn(() => () => {}),
  // 门面签名 { providers, scopedModels }（settings-lifecycle 解构消费）；裸数组解构得 undefined
  listProviders: vi.fn(async () => ({ providers: [], scopedModels: undefined })),
  setProvider: vi.fn(async () => ({})),
  deleteProvider: vi.fn(async () => {}),
  // wave4 C1/IF3：toggle 持久化走 toggleProviderEnabled（写 enabledModels 白名单），删除按 kind 走 removeProviderByKind
  toggleProviderEnabled: vi.fn(async () => {}),
  removeProviderByKind: vi.fn(async () => {}),
  testProvider: vi.fn(async () => ({ ok: true })),
  discoverModels: vi.fn(async () => ({ success: true, models: [] })),
  setDefaultModel: vi.fn(async () => {}),
  setScopedModels: vi.fn(async () => [] as string[]),
  // P2：ProviderPage 默认 pill + 默认修复 toast（缺则 TypeError 崩 mount）
  onDefaultsWithSource: vi.fn(() => () => {}),
  // wave-quick-setup-c/wave-list-badge：OAuth + env 检测（useProviderOAuth onMounted 订阅）
  checkEnvVars: vi.fn(async () => ({})),
  oauthLogin: vi.fn(async () => ({ started: false, error: 'mock' })),
  oauthCancel: vi.fn(async () => ({ cancelled: false })),
  hasOAuth: vi.fn(async () => false),
  listBuiltinProviders: vi.fn(async () => []),
  // ProviderPage onMounted 按需刷新远程模型目录（缺则 unhandled rejection）
  refreshProviderCatalogs: vi.fn(async () => ({ refreshed: [], failed: [] })),
}))

// wave-oauth：useProviderOAuth onMounted 订阅 4 个 auth.* 事件（缺则 TypeError 崩 mount）。
// vi.hoisted 工厂不能引用 import 绑定（TDZ），auth 订阅捕获集单源在 helper——顶层装配
// 后并入门面 config 域（同 use-provider-oauth.test.ts 先例）。
const authCbs = authEventCbs()
const configWithAuth = { ...configMock, ...authCbs }

vi.mock('@/api', () => ({ project: apiProjectMock(),
  config: configWithAuth,
  default: { config: configWithAuth },
}))

import ProviderPage from '@/components/settings/provider/ProviderPage.vue'

let wrapper: ReturnType<typeof mount> | null = null

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200_000, input: ['text', 'image'] },
      { id: 'claude-opus-4', name: 'Claude Opus 4', contextWindow: 200_000, input: ['text', 'image'] },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000, input: ['text', 'image'] },
    ],
  },
]

beforeEach(() => {
  setActivePinia(createPinia())
  provideSettingsStore(createSettingsStore())
  configMock.setProvider.mockClear()
  configMock.deleteProvider.mockClear()
  configMock.toggleProviderEnabled.mockClear()
  configMock.removeProviderByKind.mockClear()
  configMock.setDefaultModel.mockClear()
  // [C3] config 门面调用经 SettingsTransport seam 桩注入（同名直映；含 auth 订阅捕获集）
  provideSettingsTransport(makeSettingsTransportStub(configWithAuth))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ProviderPage 首屏冒烟', () => {
  it('providers=[] → 渲染「添加供应商」按钮 + 空状态文案', async () => {
    wrapper = mount(ProviderPage, { props: { providers: [] } })
    await flushPromises()
    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加供应商'))
    expect(addBtn).toBeTruthy()
    expect(wrapper.text()).toContain('还没有供应商')
    // 并列的「从其他 Agent 导入」入口仍在
    expect(wrapper.find('[data-testid="import-providers-menu"]').exists()).toBe(true)
  })
})

describe('ProviderPage R4 手风琴就地编辑（取代 ProviderEditModal）', () => {
  it('点击「添加供应商」→ 菜单选「自定义」→ 列表底部新建合成行并展开就地编辑体', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()

    // 初始无展开体
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(false)

    // F2：入口聚合为「+ 添加供应商 ▾」菜单，先点 trigger 打开菜单，再点「自定义」条目
    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加供应商'))!
    await addBtn.trigger('click')
    await flushPromises()
    const customItem = document.body.querySelector<HTMLElement>('[data-testid="add-menu-custom"]')
    expect(customItem).toBeTruthy()
    customItem!.click()
    await flushPromises()

    // 合成行渲染 + 展开体渲染（就地编辑，非 Dialog teleport）
    const expandBody = wrapper.find('[data-testid="provider-expand-body"]')
    expect(expandBody.exists()).toBe(true)
    // 名称 input 存在（ProviderEditBody 首字段）
    expect(wrapper.find('[data-testid="provider-edit-name"]').exists()).toBe(true)
    // body 里不应出现 Dialog（无 [role="dialog"]）
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('点击供应商名称 → 行内展开就地编辑体（凭据字段可见，不弹 Dialog）', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    // 初始无展开
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(false)

    const name = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await name.trigger('click')
    await flushPromises()

    // 展开体渲染
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(true)
    // 凭据字段（名称 input）可见
    expect(wrapper.find('[data-testid="provider-edit-name"]').exists()).toBe(true)
    // 无 Dialog teleport
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('再次点击已展开供应商名称 → 收起展开体', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    const name = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await name.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(true)

    // 再次点击收起
    await name.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(false)
  })
})

describe('ProviderPage 默认模型从 settingsStore.defaultModel 派生（U5）', () => {
  it('U5: store.defaultModel 归属 provider → 行头显示「默认供应商」pill', async () => {
    getSettingsStore().defaultModel.value = 'anthropic/claude-sonnet-4'
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    // anthropic 行头显示默认 pill（行头常驻，不需展开）
    expect(wrapper.text()).toContain('默认供应商')
  })

  it('U5b: 改 store.defaultModel 到 openai → 默认 pill 跟随切换到 openai 行', async () => {
    getSettingsStore().defaultModel.value = 'anthropic/claude-sonnet-4'
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()
    // 默认 pill 出现在 anthropic 行
    const cards = wrapper.findAll('[data-testid="provider-card"]')
    expect(cards[0]!.text()).toContain('默认供应商')

    // 切默认到 openai/gpt-4o
    getSettingsStore().defaultModel.value = 'openai/gpt-4o'
    await wrapper.vm.$nextTick()
    await flushPromises()

    const cardsAfter = wrapper.findAll('[data-testid="provider-card"]')
    expect(cardsAfter[0]!.text()).not.toContain('默认供应商')
    expect(cardsAfter[1]!.text()).toContain('默认供应商')
  })
})

/**
 * W1 robustness pass：
 *  - U1（D4）：toggle enabled 失败时 actionError 经常驻 inline error 区域可见。
 *  - D14：删除 defaultModel 归属 provider 时前端兜底清空 defaultModel。
 */
describe('ProviderPage W1 robustness', () => {
  it('U1: toggle enabled 失败 → 常驻 inline error 区域可见并含错误文案', async () => {
    configMock.toggleProviderEnabled.mockRejectedValueOnce(new Error('网络错误'))
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-action-error"]').exists()).toBe(false)

    const sw = wrapper.findAll('[role="switch"]')[0]
    await sw.trigger('click')
    await flushPromises()

    const err = wrapper.find('[data-testid="provider-action-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('网络错误')
  })

  it('D14: 删除 defaultModel 归属 provider → 前端清空 defaultModel', async () => {
    const store = getSettingsStore()
    store.defaultModel.value = 'anthropic/claude-sonnet-4'
    configMock.removeProviderByKind.mockResolvedValueOnce(undefined)
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    const trashBtns = wrapper.findAll('button[title="删除供应商"]')
    await trashBtns[0]!.trigger('click')
    await flushPromises()

    const confirmBtn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('确认删除')) as HTMLButtonElement | undefined
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()

    expect(configMock.removeProviderByKind).toHaveBeenCalledWith('anthropic', 'custom')
    expect(store.defaultModel.value).toBe('')
  })
})

describe('ProviderPage 认证徽章（wave-list-badge TC3）', () => {
  it('env_var → $ENV 徽章（info 色）；oauth → OAuth（warn 色）', async () => {
    const badgeProviders: ProviderInfo[] = [
      { id: 'a', name: 'A', apiKeySet: true, status: 'connected', authMethod: 'env_var', enabled: true, models: [] },
      { id: 'b', name: 'B', apiKeySet: false, status: 'connected', authMethod: 'oauth', enabled: true, models: [] },
    ]
    wrapper = mount(ProviderPage, {
      props: { providers: badgeProviders },
      attachTo: document.body,
    })
    await flushPromises()

    const badges = document.body.querySelectorAll('[data-testid="provider-auth-badge"]')
    expect(badges.length).toBe(2)
    // renderer vitest.setup 的 t 是真实翻译实例（返回翻译值），断言真实文案
    expect(badges[0]!.textContent).toBe('$ENV')
    expect(badges[1]!.textContent).toBe('OAuth')
    // env info 色 / oauth warn 色
    expect(badges[0]!.className).toContain('bg-info-soft')
    expect(badges[1]!.className).toContain('bg-warn-soft')
  })

  it('api_key 已设置 → API Key（中性色）；无凭据 → API Key（未设置）', async () => {
    const badgeProviders: ProviderInfo[] = [
      { id: 'a', name: 'A', apiKeySet: true, status: 'connected', authMethod: 'api_key', enabled: true, models: [] },
      { id: 'b', name: 'B', apiKeySet: false, status: 'not_configured', enabled: true, models: [] },
    ]
    wrapper = mount(ProviderPage, {
      props: { providers: badgeProviders },
      attachTo: document.body,
    })
    await flushPromises()

    const badges = document.body.querySelectorAll('[data-testid="provider-auth-badge"]')
    expect(badges[0]!.textContent).toBe('API Key')
    expect(badges[1]!.textContent).toBe('API Key（未设置）')
    // 中性色
    expect(badges[0]!.className).toContain('bg-surface-hover')
  })
})

/** oauth 能力的内置模板（B-1 QuickSetup OAuth 登录链路 fixture） */
const OAUTH_TEMPLATE: BuiltinProviderTemplate = {
  id: 'anthropic',
  name: 'Anthropic',
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  authMode: 'both',
  envVars: ['ANTHROPIC_API_KEY'],
  oauthSupported: true,
  modelCount: 3,
  models: [],
}

/** body 内 portal 元素点击（reka Portal teleport 到 body，Vue @click 原生冒泡生效） */
function clickBody(selector: string): void {
  const el = document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`body 元素未找到: ${selector}`)
  el.click()
}

describe('ProviderPage QuickSetup OAuth 登录链路（B-1）', () => {
  it('选 oauth 模板 → QuickSetup 登录 → config.oauthLogin 启动 flow + OAuthDialog 打开 pending 态', async () => {
    configMock.listBuiltinProviders.mockResolvedValueOnce([OAUTH_TEMPLATE])
    configMock.oauthLogin.mockResolvedValueOnce({ started: true })
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()

    // 入口：添加供应商 → 从内置模板 → 选 anthropic（portal 内容经 document.body 查询）
    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加供应商'))!
    await addBtn.trigger('click')
    await flushPromises()
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    clickBody('[data-testid="provider-template-anthropic"]')
    await flushPromises()

    // QuickSetup 打开（anthropic 元信息可见）
    const quickSetup = document.body.querySelector('[data-testid="provider-quick-setup"]')
    expect(quickSetup).toBeTruthy()
    expect(quickSetup!.textContent).toContain('Anthropic')

    // 切 OAuth 凭据选项 → 登录按钮出现 → 点击（onQuickSetupOAuthLogin → startQuickSetupOauth）
    clickBody('[data-testid="auth-option-oauth"]')
    await flushPromises()
    const loginBtn = document.body.querySelector<HTMLElement>('[data-testid="oauth-login-button"]')
    expect(loginBtn).toBeTruthy()
    loginBtn!.click()
    await flushPromises()

    // 共享 oauth 状态机启动 flow（provider id = 模板 id）
    expect(configMock.oauthLogin).toHaveBeenCalledTimes(1)
    expect(configMock.oauthLogin).toHaveBeenCalledWith('anthropic')
    // OAuthDialog 打开 pending 态（portal 到 body；与 QuickSetup 共用同一状态机实例）
    expect(document.body.querySelector('[data-testid="oauth-dialog"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="oauth-pending"]')).toBeTruthy()
  })
})

/**
 * 模型路由接入页改造（provider-aggregation U5a，验收 A27 增量段：接入页渲染单测）。
 *
 * 覆盖（每条至少一个用户可见 DOM 断言）：
 *  - kind=aggregation 排除渲染（D4 ①(a)）：渠道管理列表不渲染路由聚合条目、计数不含。
 *  - 聚合条目独存 → 空状态可见（过滤后列表为空即空状态）。
 *  - ScopedModelSection 白名单区退役（D10）：白名单卡零 DOM（负面断言锁定退役）。
 *  - 下一步引导卡（外部 spec §6.5）：有渠道有模型时显示、点击上抛 open-route-page、
 *    无模型时隐藏。
 */
describe('ProviderPage 接入页改造（provider-aggregation U5a）', () => {
  /** 注入条目形态 fixture（D4：kind=aggregation、无凭据无 baseUrl、models = 路由条目） */
  const AGGREGATION_ENTRY: ProviderInfo = {
    id: 'aggregation',
    name: '模型路由',
    kind: 'aggregation',
    apiKeySet: false,
    status: 'connected',
    models: [{ id: 'glm-flash-route', name: 'GLM Flash（路由）' }],
  }

  it('kind 排除: providers 含聚合条目 → 渠道列表只渲染物理渠道行、计数徽标不含聚合条目', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [...PROVIDERS, AGGREGATION_ENTRY] },
      attachTo: document.body,
    })
    await flushPromises()

    // 只渲染 2 个物理渠道行（聚合条目被排除）
    const cards = wrapper.findAll('[data-testid="provider-card"]')
    expect(cards.length).toBe(2)
    // 聚合条目名不出现（行交互——凭据编辑/测试连接/启停——对无凭据无 baseUrl 条目全部错位）
    expect(wrapper.text()).not.toContain('GLM Flash（路由）')
    // 列表计数徽标 = 过滤后数量（渠道管理列表语义，非全量 providers）
    expect(wrapper.find('[data-testid="provider-list-header"]').text()).toBeTruthy()
    const badge = wrapper.findAll('section span').find((s) => s.text() === '2')
    expect(badge).toBeTruthy()
  })

  it('kind 排除: 全部条目均为聚合 → 空状态可见（过滤后列表为空即空状态）', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [AGGREGATION_ENTRY] },
      attachTo: document.body,
    })
    await flushPromises()

    expect(wrapper.findAll('[data-testid="provider-card"]').length).toBe(0)
    expect(wrapper.text()).toContain('还没有供应商')
    // 聚合条目不渲染为渠道行
    expect(wrapper.text()).not.toContain('GLM Flash（路由）')
  })

  it('白名单区退役: scoped-model-section 零 DOM 且页面无「模型白名单」文案（D10 UI 退役锁定）', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="scoped-model-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scoped-add-btn"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('模型白名单')
  })

  it('引导卡: 有渠道有模型 → 引导卡与「打开模型路由」按钮可见，点击上抛 open-route-page', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    const guide = wrapper.find('[data-testid="provider-route-guide"]')
    expect(guide.exists()).toBe(true)
    const btn = guide.find('[data-testid="provider-open-route-btn"]')
    expect(btn.exists()).toBe(true)
    // 引导文案带模型数（connectedModelCount = 2 + 1）
    expect(guide.text()).toContain('3 个模型已接入')
    await btn.trigger('click')
    expect(wrapper.emitted('open-route-page')).toHaveLength(1)
  })

  it('引导卡: 渠道均无模型 → 引导卡隐藏（空状态同理隐藏）', async () => {
    const noModelProviders: ProviderInfo[] = [
      { id: 'empty-a', name: 'A', apiKeySet: false, status: 'not_configured', enabled: true, models: [] },
    ]
    wrapper = mount(ProviderPage, {
      props: { providers: noModelProviders },
      attachTo: document.body,
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-route-guide"]').exists()).toBe(false)
    // 渠道行仍渲染（接入职责不受引导卡条件影响）
    expect(wrapper.findAll('[data-testid="provider-card"]').length).toBe(1)
  })
})
