/**
 * mermaid 字体跟随 E2E —— 真机断言（font-system u-verify，RL11）。
 *
 * 为什么落真机而非单测：
 * - mermaid 在 mock DOM（happy-dom / jsdom）里 `render()` 会静默返回空串（不抛错），
 *   拿不到 SVG 就无从断言；
 * - 断言内容是 **SVG 内标签的 computed `font-family` 与内联 style 残留**，只有真实浏览器
 *   渲染才有这些事实。
 *
 * 三条断言缺一不可（设计 §4.2 RL11）：
 * - (a) 取样点：mermaid 11.16 默认 `htmlLabels: true`（`getEffectiveHtmlLabels` = `?? true`，
 *       本仓未显式设置），flowchart 标签落在 `foreignObject > div > span` 而**不是** `<text>`。
 * - (b) 区分「继承」与「重渲」：fontFamily 的 bake 落点 = SVG <style> 块的 `:root --mermaid-font-family`
 *       CSS 规则（mermaid dist `createCssStyles`）——本仓 `mermaid.render(id, source)` 两参调用（无
 *       container），mermaid core 走 else 分支、**不向任何元素注入内联 style 属性**，「检查 SVG 内联
 *       style」不可采。(b) 读 SVG <style> 元素文本：旧家族集合从槽位写入前的基线 --font-mono
 *       计算值派生（首渲 bake 的实际来源；不从 <style> 文本采——其内含 mermaid 主题静态
 *       默认字体规则，重渲后依然在场，采到会假红），重渲后新 <style> 不得残留旧家族、
 *       且必须含新家族。两条断言的红路径均经真机验证（终态同步 F2-6）：(a) 首渲后全阻断
 *       重渲时变红（span computed font 不走页面继承）；(b) 对合成「未重渲」态变红并点名旧家族。
 * - (c) 禁止人工触发：切字体后不切主题、不发新消息，直接断言。若靠「切主题触发重渲」，
 *       G12（字体变化自动重渲）坏了也测不出来。
 *
 * 数据流：composer 发哨兵词 'md-mermaid' → mock runSendStream 回 mermaid 代码块
 * （packages/core/src/transport/mock/run-send-stream.ts 的 MERMAID_REPLY）
 * → MarkdownRenderer 交给 MermaidRenderer 渲染出 .md-mermaid__inline svg。
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE npx playwright test e2e/font-custom-mermaid.spec.ts --project=electron
 *
 * 触发条件（R2 登记，e2e-map = E2E-FONTS-02）：改 packages/ui/src/features/chat/{mermaid.ts,
 * MermaidRenderer.vue}、字体槽位写入链（packages/renderer/src/style.css 槽位名 /
 * packages/ui/src/features/settings/apply-system-to-dom.ts）或 mock 哨兵词数据源
 * （packages/core/src/transport/mock/run-send-stream.ts 的 md-mermaid 判定 / MERMAID_REPLY）时
 * 跑本 spec——scope 数组已与头注释对齐（终态同步 F1-34）。
 */
import { test, expect } from './fixtures/launch-app'
import type { Page } from '@playwright/test'

/**
 * 在渲染树里取 mermaid 文本节点、SVG <style> 块文本与当前等宽栈：优先 foreignObject（htmlLabels 默认 true 的形态）。
 * styleText 是 (b) 重渲证据的采样面（fontFamily bake 唯一落点，两参 render 不产内联 style 属性）；
 * stack 在槽位写入前采样 = 首渲 bake 的实际来源（resolveMermaidFontFamily 的读点）。
 */
const SAMPLE_NODE_JS = `(() => {
  const root = document.querySelector('.md-mermaid-wrap')
  if (!root) return null
  const node =
    root.querySelector('foreignObject span') ||
    root.querySelector('foreignObject div') ||
    root.querySelector('text')
  if (!node) return null
  return {
    font: getComputedStyle(node).fontFamily,
    styleText: root.querySelector('svg style')?.textContent || '',
    stack: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
  }
})()`

/**
 * 激活 s3 空 session 并发哨兵词——沿用 e2e/markdown-table-layout.spec.ts 的成熟模式
 * （直接点目标 session，不切 segmented tab：icon-only 模式下其 accessible name 被
 * 计数徽标文本抢占，时序脆弱）。
 */
async function activateSession(page: Page): Promise<void> {
  // 5b13f3f59（基线内）起默认项目组缺省收起（localStorage 记忆）——会话行不进 DOM 时先展开组
  if (!(await page.getByText('API 性能优化').first().isVisible().catch(() => false))) {
    await page.getByTestId('default-project-head').click().catch(() => {});
    await expect(page.getByText('API 性能优化').first()).toBeVisible({ timeout: 10_000 });
  }

  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  const input = page.getByRole('textbox')
  await input.click()
  await input.pressSequentially(text)
  await input.press('Enter')
}

test.describe('mermaid 字体跟随（font-system RL11）', () => {
  test('字体变化后图表文字跟随，且 SVG 内不残留旧家族名', async ({ page }) => {
    await activateSession(page)
    await sendPrompt(page, 'md-mermaid')

    // 等 mermaid 渲染出 svg（首载 ~3MB，给足时间窗；用轮询而非固定 sleep）
    const svgReady = await page
      .waitForFunction(() => document.querySelector('.md-mermaid-wrap svg') !== null, undefined, {
        timeout: 30000,
      })
      .then(() => true)
      .catch(() => false)
    expect(svgReady, 'mermaid 未渲染出 SVG（哨兵词未触发或渲染失败）').toBe(true)

    const baseline = (await page.evaluate(SAMPLE_NODE_JS)) as {
      font: string
      styleText: string
      stack: string
    } | null
    expect(baseline, '未采到 mermaid 文本节点（渲染形态与预期不符）').not.toBeNull()

    // (c) 切字体：只写槽位，不切主题、不发新消息
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--font-mono-ui', "'PingFang SC'")
    })

    // (a) 断言文字跟随（等待重渲完成）
    const followed = await page
      .waitForFunction(
        (prevFont: string) => {
          const root = document.querySelector('.md-mermaid-wrap')
          if (!root) return false
          const node =
            root.querySelector('foreignObject span') ??
            root.querySelector('foreignObject div') ??
            root.querySelector('text')
          if (!node) return false
          const now = getComputedStyle(node as Element).fontFamily
          return now !== prevFont && now.includes('PingFang SC')
        },
        baseline!.font,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false)

    expect(
      followed,
      `字体变化后 mermaid 文本未跟随（基线：${baseline!.font}）——` +
        'G12 失效：initialize 门槛未含字体、或 MermaidRenderer 未监听到槽位变化',
    ).toBe(true)

    // (b) 复检（重渲证据）：fontFamily bake 落点 = SVG <style> 块的 :root --mermaid-font-family 规则
    // （两参 mermaid.render 无 container → mermaid core else 分支不产任何内联 style 属性）。
    // 旧家族集合从基线（槽位写入前）的 --font-mono 计算值派生——即首渲 bake 的实际来源；
    // 不从 <style> 文本采旧家族：其内含 mermaid 主题静态默认规则（trebuchet ms 等），
    // 重渲后依然在场，采到会假红。重渲后新 <style> 不得残留旧家族、且必须含新家族。
    // （红路径已真机验证：未重渲态下 stale 命中 JetBrains Mono、IBM Plex Mono——终态同步 F2-6）
    const after = (await page.evaluate(SAMPLE_NODE_JS)) as {
      font: string
      styleText: string
      stack: string
    } | null
    expect(after).not.toBeNull()
    const oldMonoFamilies = [
      ...new Set([...baseline!.stack.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])),
    ]
    expect(
      oldMonoFamilies.length,
      '未从基线 --font-mono 计算值采到家族名（栈形态变化？）',
    ).toBeGreaterThan(0)
    const stale = oldMonoFamilies.filter((family) => after!.styleText.includes(family))
    expect(
      stale,
      `SVG <style> 块仍残留旧等宽家族 ${stale.join('、')}——文字跟随来自 CSS 继承而非重渲，G12 未真正生效`,
    ).toEqual([])
    expect(
      after!.styleText.includes("'PingFang SC'"),
      'SVG <style> 块未含新家族——重渲未发生（bake 落点或 initialize 门槛变化？）',
    ).toBe(true)

    // 清理
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('--font-mono-ui')
    })
  })
})
