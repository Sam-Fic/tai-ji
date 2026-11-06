import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { FONT_READ_REASON_NOT_FOUND, FONT_READ_REASON_UNREADABLE } from '@taiji/shared'
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

  it('重放中只显示 restoring；done 后区分源文件缺失与不可读', async () => {
    const view = mountSection({
      replayState: 'replaying',
      replayFailures: { 'Custom (导入)': '源文件已不存在' },
    })
    expect(view.text()).toContain('settings.fonts.restoring')
    expect(view.text()).not.toContain('settings.fonts.sourceMissing')
    await view.setProps({ replayState: 'done' })
    expect(view.text()).toContain('settings.fonts.sourceMissing')
    await view.setProps({
      replayFailures: { 'Custom (导入)': '无法读取字体文件，可能已损坏' },
    })
    expect(view.text()).toContain('settings.fonts.sourceUnreadable')
  })

  it('重放失败文案按共享 reason 常量映射 locale（F1-18：与 main 侧同源，防字面量漂移）', async () => {
    // main REASON_* 已上移 @taiji/shared（FONT_READ_REASON_*）；statusFor 的比对必须
    // 消费同一常量——若有人改回字面量或改常量值，此用例随 shared 单源立即红。
    expect(FONT_READ_REASON_NOT_FOUND).toBe('源文件已不存在')
    expect(FONT_READ_REASON_UNREADABLE).toBe('无法读取字体文件，可能已损坏')
    const view = mountSection({
      replayFailures: { 'Custom (导入)': FONT_READ_REASON_NOT_FOUND },
    })
    expect(view.text()).toContain('settings.fonts.sourceMissing')
    await view.setProps({ replayFailures: { 'Custom (导入)': FONT_READ_REASON_UNREADABLE } })
    expect(view.text()).toContain('settings.fonts.sourceUnreadable')
  })

  it('当前值不在来源层列表 → 触发器加「未找到」标注；重放中与命中值不加（D9/V4）', async () => {
    // 失效值：标注挂在值旁，存储值不改（不 emit 任何选择事件）
    const view = mountSection({ monoFamily: 'Ghost Font' })
    const trigger = view.find('[data-testid="settings-font-mono-trigger"]')
    expect(trigger.text()).toContain('Ghost Font')
    expect(trigger.text()).toContain('settings.fonts.slotValueMissing')
    expect(view.emitted('select')).toBeUndefined()

    // 重放中抑制标注：导入字体尚未注册进 entries，成员资格会假阴性（防启动闪告警）
    const replaying = mountSection({ monoFamily: 'Ghost Font', replayState: 'replaying' })
    expect(replaying.find('[data-testid="settings-font-mono-trigger"]').text())
      .not.toContain('settings.fonts.slotValueMissing')

    // 命中值（精确 + 大小写变体，CSS 匹配大小写不敏感）不加标注
    const normal = mountSection({ monoFamily: 'Maple Mono' })
    expect(normal.find('[data-testid="settings-font-mono-trigger"]').text())
      .not.toContain('settings.fonts.slotValueMissing')
    const variant = mountSection({ monoFamily: 'maple mono' })
    expect(variant.find('[data-testid="settings-font-mono-trigger"]').text())
      .not.toContain('settings.fonts.slotValueMissing')
  })

  it('安装指引含三平台入口、重启语义与非 CN 版中文字形说明', () => {
    const view = mountSection()
    for (const platform of ['macos', 'windows', 'linux']) {
      expect(view.find(`[data-testid="settings-font-install-${platform}"]`).exists()).toBe(true)
    }
    expect(view.text()).toContain('settings.fonts.installRestart')
    expect(view.text()).toContain('settings.fonts.installCjk')
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
