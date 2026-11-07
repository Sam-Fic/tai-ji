// @vitest-environment happy-dom

/**
 * 模型选择器路由条目呈现（provider-aggregation U6/M1 单元增量：路由组 / 徽标 / 顺序 DOM 断言）。
 *
 * 断言（impl-plan A27 增量段，设计 §5.1 U6）：
 * 1. 路由组——聚合 provider 条目（ModelInfo.aggregation=true，u-foundation 契约字段）
 *    成组且组标题走 i18n 定稿键 `panel.modelSelect.routeGroupTitle`（zh「模型路由」；
 *    数据侧 providerName 是 runtime 固定中文，显示侧按 locale 出文案）；
 * 2. 徽标——路由组行尾「路由」徽标渲染在场（data-testid=model-picker-route-badge），
 *    物理模型行零徽标（GL2：路由条目与物理模型可区分）；
 * 3. 顺序——组序跟随 models 数组序（= scopedModels 序：runtime aggregateModelsWithScoped
 *    按白名单序输出，buildModelGroups 保留首现序），不重排不置顶；
 * 4. 零配置回归（V8 选择器半边）：无路由条目时无路由组、无徽标、无分组残留；
 * 5. 可选性——点选路由行上抛 select{modelId, provider:'aggregation'}（切换链按
 *    <聚合providerId>/<routeId> 复合串绑定，providerId 随组下行的归属单点对路由组同样成立）。
 *
 * 挂载策略：ModelSelectPopover 真实树不 mock（同 SubagentTab.model-popover.test.ts 模式
 * ——点击 trigger 后断言 teleport 到 body 的弹层 DOM）；数据层用真实 settings store
 * 单例直写 models。运行：
 *   cd packages/renderer && npx vitest run src/__tests__/panel/model-picker-aggregation.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { getSettingsStore } from '@taiji/core'
import type { ModelInfo, ProviderId } from '@taiji/shared'
import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue'
import { useModelPickerData } from '@/components/panel/model-picker-data'

// 物理模型两条（同 provider）+ 路由条目一条（聚合 provider——id/providerName 对齐 U3
// 注入形态：providerId = 保留 id、providerName = 固定中文、aggregation 标记由
// model-service 对 kind==='aggregation' 条目透传）
const ZHIPU_GLM: ModelInfo = { id: 'glm-5.3', name: 'GLM 5.3', providerId: 'zhipu' as ProviderId, providerName: 'Zhipu', enabled: true }
const ZHIPU_FLASH: ModelInfo = { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', providerId: 'zhipu' as ProviderId, providerName: 'Zhipu', enabled: true }
const ROUTE_GLM: ModelInfo = { id: 'glm-route', name: 'GLM 路由', providerId: 'aggregation' as ProviderId, providerName: '模型路由', aggregation: true, enabled: true }

let wrapper: VueWrapper | null = null

/** 真实树挂载（无 props —— 默认 trigger slot，switching 关闭） */
function mountPopover(): VueWrapper {
  wrapper = mount(ModelSelectPopover)
  return wrapper
}

/** 点击默认 trigger 打开弹层（PopoverContent teleport 到 body） */
async function openPopover(): Promise<void> {
  const w = mountPopover()
  await flushPromises()
  await w.find('button').trigger('click')
  await flushPromises()
}

/** body 弹层内的行 testid 序（组序/行序的 DOM 证据） */
function bodyRowTestIds(): string[] {
  return [...document.body.querySelectorAll('[data-testid^="model-picker-item-"]')]
    .map(el => el.getAttribute('data-testid') ?? '')
}

/** body 弹层内的分组标题序（列表容器每个直接子块的首个 div = 组头） */
function bodyGroupTitles(): string[] {
  const list = document.body.querySelector('[data-testid="model-picker-list"]')
  if (!list) return []
  return [...list.children]
    .map(block => block.querySelector('div')?.textContent?.trim() ?? '')
    .filter(title => title !== '')
}

beforeEach(() => {
  setActivePinia(createPinia())
  getSettingsStore().models.value = [ZHIPU_GLM, ZHIPU_FLASH, ROUTE_GLM]
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('选择器路由组数据形状（model-picker-data 分组标记）', () => {
  it('路由条目成组带 aggregation 标记、物理组不带——组序跟随 models 数组序（scopedModels 序）', () => {
    const { pickerGroups } = useModelPickerData()
    // 深等值同时锁定「标记在位」与「物理组零标记键」两侧形状
    expect(pickerGroups.value).toEqual([
      {
        provider: 'Zhipu',
        providerId: 'zhipu',
        models: [{ id: 'glm-5.3', name: 'GLM 5.3' }, { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }],
      },
      {
        provider: '模型路由',
        providerId: 'aggregation',
        aggregation: true,
        models: [{ id: 'glm-route', name: 'GLM 路由' }],
      },
    ])
  })

  it('路由条目排在白名单首位时路由组置首（顺序不重排——反向 fixture）', () => {
    getSettingsStore().models.value = [ROUTE_GLM, ZHIPU_GLM, ZHIPU_FLASH]
    const { pickerGroups } = useModelPickerData()
    expect(pickerGroups.value.map(g => g.providerId)).toEqual(['aggregation', 'zhipu'])
  })
})

describe('选择器路由组渲染（真实挂载 ModelSelectPopover）', () => {
  it('路由组标题走 i18n 定稿键 + 路由行尾徽标在场、物理行零徽标', async () => {
    await openPopover()

    // 组标题 = zh locale 的 routeGroupTitle（「模型路由」，非数据侧字段的机械回显断言——
    // fixture providerName 恰好同文，键生效由下一用例「标题序随组序」与零配置回归共同锚定）
    expect(bodyGroupTitles()).toEqual(['Zhipu', '模型路由'])

    // 徽标：仅路由行渲染，且文本 = zh locale routeBadge
    const routeRow = document.body.querySelector('[data-testid="model-picker-item-glm-route"]')
    expect(routeRow).not.toBeNull()
    const badge = routeRow?.querySelector('[data-testid="model-picker-route-badge"]')
    expect(badge).not.toBeNull()
    expect(badge?.textContent?.trim()).toBe('路由')

    // 物理行零徽标（GL2 可区分性）
    for (const physId of ['glm-5.3', 'glm-5.3-flash']) {
      const row = document.body.querySelector(`[data-testid="model-picker-item-${physId}"]`)
      expect(row?.querySelector('[data-testid="model-picker-route-badge"]')).toBeNull()
    }
  })

  it('行序跟随 models 数组序（DOM 行序证据；路由条目居首时徽标行同步置首）', async () => {
    await openPopover()
    expect(bodyRowTestIds()).toEqual([
      'model-picker-item-glm-5.3',
      'model-picker-item-glm-5.3-flash',
      'model-picker-item-glm-route',
    ])

    wrapper?.unmount()
    document.body.innerHTML = ''

    getSettingsStore().models.value = [ROUTE_GLM, ZHIPU_GLM, ZHIPU_FLASH]
    await openPopover()
    expect(bodyRowTestIds()).toEqual([
      'model-picker-item-glm-route',
      'model-picker-item-glm-5.3',
      'model-picker-item-glm-5.3-flash',
    ])
    expect(bodyGroupTitles()).toEqual(['模型路由', 'Zhipu'])
  })

  it('点选路由行上抛 select{modelId, provider:"aggregation"}——路由条目可绑定', async () => {
    const w = mountPopover()
    await flushPromises()
    await w.find('button').trigger('click')
    await flushPromises()

    const routeRow = document.body.querySelector('[data-testid="model-picker-item-glm-route"]')
    expect(routeRow).not.toBeNull()
    ;(routeRow as HTMLElement).click()
    await flushPromises()

    const emitted = w.emitted<[{ modelId: string; provider: string }]>('select')
    expect(emitted).toBeDefined()
    expect(emitted?.[0]?.[0]).toEqual({ modelId: 'glm-route', provider: 'aggregation' })
  })
})

describe('零配置回归（V8 选择器半边）', () => {
  it('无路由条目：无路由组标题、无徽标、无分组残留——物理模型呈现零变化', async () => {
    getSettingsStore().models.value = [ZHIPU_GLM, ZHIPU_FLASH]
    await openPopover()

    expect(bodyGroupTitles()).toEqual(['Zhipu'])
    expect(document.body.querySelectorAll('[data-testid="model-picker-route-badge"]').length).toBe(0)
    expect(bodyRowTestIds()).toEqual(['model-picker-item-glm-5.3', 'model-picker-item-glm-5.3-flash'])
  })
})
