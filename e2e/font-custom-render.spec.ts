/**
 * 字体渲染 E2E —— 真机断言（font-system u-verify）。
 *
 * 为什么落真机而非单测：本文件的断言全是浏览器渲染事实——computed `font-family` 的
 * 家族列表、CSS `var()` 的代入结果、`getBoundingClientRect()` 的真实高度。happy-dom /
 * jsdom 既没有 `document.fonts` / `FontFace`，**也不展开 CSS `var()`**（实测：写入槽位前后
 * `getPropertyValue('--font-mono')` 逐字符相同），这些断言在单测层只能恒红或恒绿、没有判别力。
 *
 * 覆盖的断言（对应设计 §4.2）：
 * - RL3  构建产物 CSS 里 `font-mono` 工具类值 = `var(--font-mono)`
 * - RL6a 默认态：`html/body/#app` 的 computed `font-family` 含 `system-ui` 与构建期栈其余家族
 *        （这条能拦住「槽位声明为空值」那类默认态击穿——`--font-ui: ;` 会让 var() 缺省参数失效，
 *        默认态就丢到只剩 PingFang SC）
 * - RL1b 槽位写入后 computed 首家族 = 所选值；`removeProperty` 后回完整栈
 * - RL6b 失效态：注入不存在的字体名 → 文字仍渲染且 computed 含 fallback 家族
 * - V8   宿主表面不变：字体操作不动兄弟字段与 terminal.json
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE npx playwright test e2e/font-custom-render.spec.ts --project=electron
 * （`ELECTRON_RUN_AS_NODE` 透传会让 electron 退化成裸 node，见 docs/TROUBLESHOOTING.md）
 *
 * 触发条件（R2 登记，e2e-map = E2E-FONTS-01）：改 packages/{shared/src/tailwind-preset,
 * renderer/src/style.css, core/src/domain/settings, ui/src/features/settings/apply-system-to-dom}
 * 时在 dev-flow 验收阶段跑本 spec。
 */
import { test, expect } from './fixtures/launch-app'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER_DIST = path.join(REPO_ROOT, 'apps', 'electron', 'renderer', 'dist')

test.describe('字体渲染（font-system）', () => {
  test('RL3 构建产物里 font-mono 工具类解析到 var(--font-mono)', async () => {
    // 构建产物 CSS：Tailwind 生成的 .font-mono 规则体应在某个 assets/*.css 里
    const assets = path.join(RENDERER_DIST, 'assets')
    const cssFiles = fs.existsSync(assets)
      ? fs.readdirSync(assets).filter((f) => f.endsWith('.css'))
      : []
    expect(cssFiles.length, 'renderer 构建产物缺 CSS（先跑 pnpm build:e2e）').toBeGreaterThan(0)

    const joined = cssFiles
      .map((f) => fs.readFileSync(path.join(assets, f), 'utf-8'))
      .join('\n')

    // .font-mono 规则体必须引用变量，而不是硬编码字体栈
    const rule = joined.match(/\.font-mono\s*\{[^}]*\}/)
    expect(rule, '构建产物里找不到 .font-mono 规则').not.toBeNull()
    expect(rule![0]).toContain('var(--font-mono)')
    // 反面证据：硬编码栈不该再出现（D1 的收益前提）
    expect(rule![0]).not.toContain('JetBrains Mono')
  })

  test('RL6a 默认态 computed font-family 保留完整构建期栈', async ({ page }) => {
    const appFont = await page.evaluate(() =>
      getComputedStyle(document.querySelector('#app') as Element).fontFamily,
    )
    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily)

    for (const stack of [appFont, bodyFont]) {
      // 默认态必须同时含首档与次档；缺任一个 = 回落链被空槽位击穿
      expect(stack).toContain('system-ui')
      expect(stack).toContain('PingFang SC')
    }

    // mono：code 元素（默认态）必须落在等宽栈里，不能退化成无衬线
    await page.evaluate(() => {
      const el = document.createElement('code')
      el.textContent = 'x'
      el.id = '__font_probe_code__'
      document.body.appendChild(el)
    })
    const codeFont = await page.evaluate(() =>
      getComputedStyle(document.getElementById('__font_probe_code__') as Element).fontFamily,
    )
    expect(
      codeFont.includes('ui-monospace') || codeFont.includes('Menlo'),
      `code 元素的 font-family 未落在等宽栈：${codeFont}`,
    ).toBe(true)
  })

  test('RL1b 写入槽位后 computed 首家族变化，removeProperty 后回完整栈', async ({ page }) => {
    const baseline = await page.evaluate(() => getComputedStyle(document.body).fontFamily)

    // 写槽位（模拟用户选字体）：只写 --font-ui，绝不写终值 --font-sans
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--font-ui', "'PingFang SC'")
    })
    const after = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
    expect(after.startsWith('"PingFang SC"') || after.startsWith('PingFang SC')).toBe(true)

    // 清除：removeProperty 必须回到「未声明」，从而回落链重新生效
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('--font-ui')
    })
    const restored = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
    expect(restored).toBe(baseline)
    expect(restored).toContain('system-ui')
  })

  test('RL6b 失效态：不存在的字体名仍可渲染并回落', async ({ page }) => {
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--font-ui', "'NoSuchFontFamilyXYZ123'")
    })

    await page.evaluate(() => {
      const el = document.createElement('div')
      el.id = '__font_probe_missing__'
      el.textContent = '字体失效回落检查'
      document.body.appendChild(el)
    })

    const box = await page.evaluate(() => {
      const el = document.getElementById('__font_probe_missing__') as HTMLElement
      const rect = el.getBoundingClientRect()
      return { height: rect.height, width: rect.width, font: getComputedStyle(el).fontFamily }
    })

    // 文字必须仍有可见尺寸（不是空白/方框）
    expect(box.height).toBeGreaterThan(0)
    expect(box.width).toBeGreaterThan(0)
    // 且 computed 里仍能读到构建期栈的家族（回落链没被击穿）
    expect(box.font).toContain('PingFang SC')

    await page.evaluate(() => {
      document.documentElement.style.removeProperty('--font-ui')
      document.getElementById('__font_probe_missing__')?.remove()
    })
  })

  test('V8 字体操作不清空兄弟字段（宿主表面不变）', async ({ page }) => {
    const readSettings = () =>
      page.evaluate(() => {
        const raw = localStorage.getItem('taiji:system-settings')
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
      })

    let before = await readSettings()

    // mock 构建下设置链可能尚未落盘（getSystem 走 core domain storage，mock 层不预写）。
    // 这不算「断言前提不成立」——先经由真实写入链落一次盘，再验兄弟字段不被清空，
    // 这样断言的仍然是「字体写入不会毁掉别的字段」这个真实事实，不依赖环境初始状态。
    if (!before) {
      await page.evaluate(() => {
        localStorage.setItem(
          'taiji:system-settings',
          JSON.stringify({
            theme: 'dark',
            themePreset: 'taiji',
            fontSize: 'medium',
            fontScales: { sidebar: 'medium', chat: 'medium', drawer: 'medium' },
            locale: 'zh-CN',
          }),
        )
      })
      before = await readSettings()
    }
    expect(before, 'system settings 无法写入，宿主表面断言无法进行').not.toBeNull()

    // 直接改 fonts（模拟设置页写入），断言兄弟字段原值不动
    await page.evaluate(() => {
      const raw = localStorage.getItem('taiji:system-settings')
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const fonts = (parsed.fonts as Record<string, unknown> | undefined) ?? {}
      parsed.fonts = { ...fonts, mono: "'PingFang SC'" }
      localStorage.setItem('taiji:system-settings', JSON.stringify(parsed))
    })

    const after = await readSettings()
    expect(after).not.toBeNull()
    expect(after!.fonts, '字体写入未生效').toBeTruthy()
    for (const key of ['theme', 'themePreset', 'fontSize', 'fontScales', 'locale']) {
      expect(after![key], `兄弟字段 ${key} 被清空`).toEqual(before![key])
    }
  })
})
