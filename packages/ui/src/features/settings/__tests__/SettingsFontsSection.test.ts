import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import SettingsFontsSection from '../SettingsFontsSection.vue'

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

function mountSection(overrides: Record<string, unknown> = {}) {
  wrapper = mount(SettingsFontsSection, {
    attachTo: document.body,
    props: {
      entries: [
        { family: 'Maple Mono', source: 'system' },
        { family: 'Menlo', source: 'system' },
        { family: 'Custom (导入)', source: 'file' },
      ],
      library: [{ family: 'Custom (导入)', path: '/fonts/custom.ttf', addedAt: 100 }],
      loading: false,
      busy: false,
      replayState: 'done',
      replayFailures: {},
      importSelection: null,
      ...overrides,
    },
  })
  return wrapper
}

describe('SettingsFontsSection 调用契约', () => {
  it('导入确认预填文件名，用户修改后按修改值 emit', async () => {
    const view = mountSection({
      importSelection: { path: '/fonts/Maple Mono.ttf', suggestedFamily: 'Maple Mono' },
    })
    const input = view.find('[data-testid="settings-font-import-name"]')
    expect((input.element as HTMLInputElement).value).toBe('Maple Mono')
    await input.setValue('User Confirmed')
    await view.find('[data-testid="settings-font-import-confirm"]').trigger('click')
    expect(view.emitted('confirm-import')).toEqual([[{
      path: '/fonts/Maple Mono.ttf',
      family: 'User Confirmed',
    }]])
  })

  it('重放中只显示 restoring，不落失败态；done 后才显示内存失败原因', async () => {
    const view = mountSection({
      replayState: 'replaying',
      replayFailures: { 'Custom (导入)': '源文件已不存在' },
    })
    expect(view.text()).toContain('settings.fonts.restoring')
    expect(view.text()).not.toContain('settings.fonts.restoreFailed')
    await view.setProps({ replayState: 'done' })
    expect(view.text()).toContain('settings.fonts.restoreFailed')
    expect(view.text()).toContain('源文件已不存在')
  })

  it('三行下拉可搜索并 emit 独立 slot/family', async () => {
    const view = mountSection()
    await view.find('[data-testid="settings-font-mono-trigger"]').trigger('click')
    await flushPromises()
    const search = document.body.querySelector<HTMLInputElement>('[data-testid="settings-font-search"]')
    expect(search).toBeTruthy()
    search!.value = 'maple'
    search!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    const options = [...document.body.querySelectorAll('[data-testid^="settings-font-mono-option-"]')]
    expect(options.map((node) => node.getAttribute('data-testid'))).toEqual(['settings-font-mono-option-Maple Mono'])
    ;(options[0] as HTMLElement).click()
    await flushPromises()
    expect(view.emitted('select')).toEqual([[{ slot: 'mono', family: 'Maple Mono' }]])
  })
})
