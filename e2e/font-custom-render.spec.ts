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
 * - RL13 渲染侧（AX1 L4）：真 IPC 读真实字体文件 + FontFace 注册（importFont 去对话框的
 *        同款原语链）后，导入 face 不占用系统名字符串——选回系统名渲染宽度回基准、
 *        选导入名宽度不同（face 真生效）；小写系统名渲染同一族（CSS 匹配大小写
 *        不敏感，F1-19 归一口径的真机复演）
 * - RL7  重启重放：seed fontLibrary → reload → 等 replayState==='done' 代理信号
 *        （document.fonts 含重放 family）——有效项重新注册；失败项降级标注
 *        （库行「源文件已不存在」）+ 槽位失效值标注（「未找到，已回落到系统默认」，V4）
 * - V8   宿主表面不变：经生产链驱动字体提交（设置页下拉 → emit → store.setSystem）
 *        + reload，对照四表面（localStorage 兄弟字段 / terminal.json 文件 /
 *        document.fonts.size / 会话状态）——不再自证式写读 localStorage
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
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER_DIST = path.join(REPO_ROOT, 'apps', 'electron', 'renderer', 'dist')

/** 建临时 fixture 目录（测试自建自删，禁碰真实数据目录）。 */
function makeTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `taiji-font-e2e-${label}-`))
}

/** 真实字体文件（@fontsource-variable/noto-sans-sc，devDependency 在场即存在）；woff2 过 main 三关。
 *  注意：fontsource 分片子集不含基础拉丁字形——只用于「注册重放」类断言（RL7），不能用于宽度对比。 */
function realFontFile(dir: string): string {
  const source = path.join(
    REPO_ROOT, 'node_modules', '@fontsource-variable', 'noto-sans-sc', 'files', 'noto-sans-sc-100-wght-normal.woff2',
  )
  const target = path.join(dir, 'probe-font.woff2')
  fs.copyFileSync(source, target)
  return target
}

/** latin 全覆盖的真实系统字体文件（macOS 全系预装；与 Menlo 度量可区分，用于宽度对比）。 */
function systemFontFile(dir: string): string {
  const source = '/System/Library/Fonts/Supplemental/Arial.ttf'
  if (!fs.existsSync(source)) {
    throw new Error(`找不到系统字体 ${source}——本 spec 的宽度对比依赖一份 latin 全覆盖的真实字体文件`)
  }
  const target = path.join(dir, 'probe-font.ttf')
  fs.copyFileSync(source, target)
  return target
}

/**
 * 激活 fixture session + 打开设置 → 外观（sidebar-settings 直达 appearance 分区），
 * 等字体卡片可交互。会话先行激活：V8 的「会话状态」表面断言需要同一会话在场。
 */
async function openAppearanceFonts(page: import('@playwright/test').Page): Promise<void> {
  // 5b13f3f59（基线内）起默认项目组缺省收起（localStorage 记忆）——会话行不进 DOM 时先展开组
  if (!(await page.getByText('API 性能优化').first().isVisible().catch(() => false))) {
    await page.getByTestId('default-project-head').click().catch(() => {});
    await expect(page.getByText('API 性能优化').first()).toBeVisible({ timeout: 15_000 });
  }

  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 15_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('sidebar-settings').click()
  await expect(page.getByTestId('settings-font-import')).toBeVisible({ timeout: 15_000 })
}

/**
 * 经生产链选一个字体：点开槽位下拉 → 点首个选项。
 * 走 SettingsFontsSection emit → SettingsModal onSystemUpdate → store.setSystem 真实提交链
 * （terminal 行走 AppearancePage → config.setTerminal 同生产链）。返回所选家族名；
 * 等待触发器文案更新（= 写入落盘 + store 回流完成的代理信号，非固定 sleep）。
 */
async function selectFirstFontOption(
  page: import('@playwright/test').Page,
  slot: 'ui' | 'mono' | 'terminal',
): Promise<string> {
  await page.getByTestId(`settings-font-${slot}-trigger`).click()
  const options = page.locator(`[data-testid^="settings-font-${slot}-option-"]`)
  const first = options.first()
  try {
    await first.waitFor({ state: 'visible', timeout: 15_000 })
  } catch {
    throw new Error(`字体下拉无可选选项（slot=${slot}）——queryLocalFonts 返回空？本 spec 依赖真机系统字体清单`)
  }
  const testid = (await first.getAttribute('data-testid'))!
  const family = testid.slice(`settings-font-${slot}-option-`.length)
  await first.click()
  await expect(page.getByTestId(`settings-font-${slot}-trigger`)).toContainText(family, { timeout: 15_000 })
  return family
}

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
    // 且 computed 里仍能读到回落链解析结果（回落链没被击穿）：链尾 sans-serif 按机器
    // 已装字体解析——macOS 常见 PingFang SC；装了 Noto Sans CJK 的机器在 Noto 即解析
    // （环境健壮化：原断言硬编码 PingFang SC 在装 Noto 的机器必红）
    expect(
      ['PingFang SC', 'Noto Sans CJK SC', 'sans-serif'].some((f) => box.font.includes(f)),
    ).toBe(true)

    await page.evaluate(() => {
      document.documentElement.style.removeProperty('--font-ui')
      document.getElementById('__font_probe_missing__')?.remove()
    })
  })

  test('RL13 渲染侧：导入 face 不占系统名字符串，系统字体仍可选回（AX1 L4）', async ({ page }) => {
    const dir = makeTmpDir('rl13')
    try {
      // 真机导入的等价驱动登记：FileFontSource.importFont = pickFile（原生对话框，无法自动化）
      // → font:read-bytes（真 IPC + main 三关校验）→ new FontFace → document.fonts.add。
      // 除对话框外同一条生产原语链，此处直驱同款原语——不是 mock 注入。
      const fontPath = systemFontFile(dir)
      const IMPORTED = 'RL13 Imported Face'
      const registered = await page.evaluate(async ({ p, fam }) => {
        const api = (window as unknown as {
          electronAPI?: { readFontBytes?: (path: string) => Promise<{ ok: boolean; reason?: string; bytes?: Uint8Array }> }
        }).electronAPI
        if (!api?.readFontBytes) return { ok: false as const, reason: 'preload 未暴露 readFontBytes' }
        const res = await api.readFontBytes(p)
        if (!res.ok) return { ok: false as const, reason: res.reason ?? 'unknown' }
        const face = new FontFace(fam, res.bytes!)
        document.fonts.add(face)
        await face.load()
        return { ok: true as const }
      }, { p: fontPath, fam: IMPORTED })
      expect(registered, `真 IPC 读真实字体文件失败：${'reason' in registered ? registered.reason : ''}`).toEqual({ ok: true })

      const setSlot = (value: string | null) =>
        page.evaluate((v) => {
          if (v === null) document.documentElement.style.removeProperty('--font-mono-ui')
          else document.documentElement.style.setProperty('--font-mono-ui', v)
        }, value)
      const probe = () =>
        page.evaluate(() => {
          let el = document.getElementById('__rl13_probe__') as HTMLElement | null
          if (!el) {
            el = document.createElement('div')
            el.id = '__rl13_probe__'
            el.style.fontFamily = 'var(--font-mono)'
            el.style.position = 'absolute'
            el.textContent = 'mmmmmmmmmmiiiiiiiiiiWWWWWWWWWW'
            document.body.appendChild(el)
          }
          return { width: el.getBoundingClientRect().width, font: getComputedStyle(el).fontFamily }
        })

      const SYSTEM = 'Menlo'
      await setSlot(`'${SYSTEM}'`)
      const systemProbe = await probe()
      expect(systemProbe.font.toLowerCase()).toContain('menlo')

      // 选导入名：导入 face 真生效（computed 含导入名，宽度偏离系统基准）
      await setSlot(`'${IMPORTED}'`)
      await expect
        .poll(async () => (await probe()).font.toLowerCase().includes(IMPORTED.toLowerCase()), { timeout: 10_000 })
        .toBe(true)
      const importedWidth = (await probe()).width
      expect(importedWidth).not.toBe(systemProbe.width)

      // AX1 渲染层：切回系统原名 → 宽度回到系统基准（导入 face 不占用系统名字符串）
      await setSlot(`'${SYSTEM}'`)
      await expect.poll(async () => (await probe()).width, { timeout: 10_000 }).toBe(systemProbe.width)

      // F1-19 归一口径真机复演：小写系统名 → CSS 匹配大小写不敏感 → 同族同宽度
      // （这正是 resolveImportedFamily 占名判定必须 lowercase 归一的依据）
      await setSlot(`'${SYSTEM.toLowerCase()}'`)
      await expect.poll(async () => (await probe()).width, { timeout: 10_000 }).toBe(systemProbe.width)

      await setSlot(null)
      await page.evaluate((fam) => {
        for (const face of [...document.fonts]) {
          if (face.family === fam) document.fonts.delete(face)
        }
        document.getElementById('__rl13_probe__')?.remove()
      }, IMPORTED)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test('RL7 重启重放：fontLibrary 重启后重新注册，失败项降级 + 槽位失效值标注（V4/V5）', async ({ page }) => {
    const dir = makeTmpDir('rl7')
    try {
      const validFont = realFontFile(dir)
      const ghostPath = path.join(dir, 'ghost.ttf') // 永不创建 → ENOENT → reason=源文件已不存在

      const VALID = 'RL7 Replay Font'
      const MISSING = 'RL7 Missing Font'
      const V4_GHOST = 'V4NoSuchSystemFontProbe'

      // seed = 重启重放的给定条件：fontLibrary 是既有持久化值，经生产 boot 链读取；
      // fonts.mono 指向系统清单中不存在的家族构成 V4 失效值场景（存储值不被清空）。
      await page.evaluate(({ key, payload }) => {
        localStorage.setItem(key, JSON.stringify(payload))
      }, {
        key: 'taiji:system-settings',
        payload: {
          theme: 'dark',
          themePreset: 'taiji',
          fontSize: 'medium',
          fontScales: { sidebar: 'medium', chat: 'medium', drawer: 'medium' },
          locale: 'zh-CN',
          fonts: { mono: V4_GHOST },
          fontLibrary: [
            { family: MISSING, path: ghostPath, addedAt: 200 },
            { family: VALID, path: validFont, addedAt: 100 },
          ],
        },
      })

      await page.reload()

      // 设计 RL7/U8 的等待条件 = replayState==='done' 的代理信号：重放成功项注册进 document.fonts
      const registeredOk = await page
        .waitForFunction(
          (fam) => [...document.fonts].some((face) => face.family === fam),
          VALID,
          { timeout: 20_000 },
        )
        .then(() => true)
        .catch(() => false)
      expect(registeredOk, '重放未把 fontLibrary 有效项注册进 document.fonts——RL7 红灯（replayState 未 done 或 font:read-bytes 链断裂）').toBe(true)
      const families = await page.evaluate(() => [...document.fonts].map((face) => face.family))
      expect(families, '重放失败项不得注册进 document.fonts').not.toContain(MISSING)

      // 存储值不被清空（V4 通过标准：重装字体后自动恢复的前提）
      const stored = await page.evaluate(() => {
        const raw = localStorage.getItem('taiji:system-settings')
        return raw ? (JSON.parse(raw) as { fonts?: { mono?: string } }) : null
      })
      expect(stored?.fonts?.mono).toBe(V4_GHOST)

      // 失败项降级标注（库行）+ 槽位失效值标注（V4：未找到，已回落到系统默认）真机目验
      await page.getByTestId('sidebar-settings').click()
      await expect(page.getByTestId('settings-font-import')).toBeVisible({ timeout: 15_000 })
      const missingRow = page.getByTestId('settings-font-library-0') // addedAt 倒序 → 失败项在首行
      await expect(missingRow).toContainText(MISSING)
      await expect(missingRow).toContainText('（源文件已不存在）')
      const validRow = page.getByTestId('settings-font-library-1')
      await expect(validRow).toContainText(VALID)
      await expect(validRow).not.toContainText('（源文件已不存在）')
      await expect(validRow).not.toContainText('（无法读取，可能已损坏）')
      await expect(page.getByTestId('settings-font-mono-trigger'))
        .toContainText(`${V4_GHOST}（未找到，已回落到系统默认）`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test('V8 宿主表面不变：生产链驱动字体提交 + reload，四表面逐一对照', async ({ page }) => {
    // 表面 2 基线：terminal.json 文件（mock 链下 config.setTerminal 不落盘，真文件缺席 = 期望态）
    const dataDir = process.env.TAIJI_AGENT_DATA_DIR
    test.skip(
      !dataDir,
      'V8 断言真实进程落盘（terminal.json）；mock 层 launch-app 不注入 TAIJI_AGENT_DATA_DIR——本用例归 E2E-REAL 通道执行（资产归属修正，非缺陷）',
    )
    expect(dataDir, 'launch-app 未注入隔离数据目录').toBeTruthy()
    const terminalJsonPath = path.join(dataDir!, 'terminal.json')
    const readTerminalJson = (): string | null =>
      fs.existsSync(terminalJsonPath) ? fs.readFileSync(terminalJsonPath, 'utf-8') : null
    const terminalBefore = readTerminalJson()

    // 表面 4 基线：会话状态（mock fixture session 在场 + composer 可用）
    await openAppearanceFonts(page)

    // 表面 1 观测口（mock 层边界登记）：VITE_MOCK 构建的 platform.storage 是内存 KV
    //（createInMemoryStorage，仅 boot 时从 localStorage 播种一次），生产写入不落 localStorage——
    // 存储表面的真值观测口 = store 回流（外观页兄弟控件签名）；localStorage 恒空本身也是断言面
    //（字体写入不得绕过 PlatformPort 直写 localStorage）。磁盘级 KV 兄弟字段不变式由
    // RL16(a) L1（updateSystem 对真 KVStorage）与 RL7（seed localStorage 经生产 boot 读回）承接。
    const siblingSignature = () =>
      page.evaluate(() => ({
        themePressed: document.querySelector('[data-testid="appearance-mode-dark"]')?.getAttribute('aria-pressed'),
        fontSizePressed: document.querySelector('[data-testid="appearance-fs-global-medium"]')?.getAttribute('aria-pressed'),
        sidebarScale: document.querySelector('[data-testid="appearance-fs-sidebar-trigger"]')?.textContent?.trim(),
        terminalFontSize: (document.querySelector('[data-testid="appearance-terminal-font-size-input"]') as HTMLInputElement | null)?.value,
        localSettingsRaw: localStorage.getItem('taiji:system-settings'),
        fontsSize: document.fonts.size,
      }))
    const SIBLING_KEYS = ['themePressed', 'fontSizePressed', 'sidebarScale', 'terminalFontSize'] as const
    const baseline = { terminal: terminalBefore, ...(await siblingSignature()) }

    // 生产链三连写（不再自证式 localStorage setItem）：
    // ui/mono 行 → SettingsFontsSection emit → SettingsModal onSystemUpdate → store.setSystem（内存 KV）；
    // terminal 行 → AppearancePage → config.setTerminal。每步以触发器文案回流为完成信号。
    await selectFirstFontOption(page, 'ui')
    await selectFirstFontOption(page, 'mono')
    await selectFirstFontOption(page, 'terminal')

    const afterWrite = { terminal: readTerminalJson(), ...(await siblingSignature()) }
    for (const key of SIBLING_KEYS) {
      expect(afterWrite[key], `兄弟字段签名 ${key} 被字体提交清空/改写`).toBe(baseline[key])
    }
    expect(afterWrite.localSettingsRaw, '字体写入不得绕过 PlatformPort 直写 localStorage').toBe(baseline.localSettingsRaw)
    expect(afterWrite.fontsSize).toBe(baseline.fontsSize)
    expect(afterWrite.terminal).toBe(baseline.terminal)

    // reload 后对照四表面（内存 KV 复位到默认态 = 基线同源默认，签名应不变）
    await page.reload()
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 20_000 })
    // 5b13f3f59（基线内）起默认项目组缺省收起（localStorage 记忆）——会话行不进 DOM 时先展开组
    if (!(await page.getByText('API 性能优化').first().isVisible().catch(() => false))) {
      await page.getByTestId('default-project-head').click().catch(() => {});
      await expect(page.getByText('API 性能优化').first()).toBeVisible({ timeout: 15_000 });
    }

    await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('sidebar-settings').click()
    await expect(page.getByTestId('settings-font-import')).toBeVisible({ timeout: 15_000 })
    const afterReload = { terminal: readTerminalJson(), ...(await siblingSignature()) }
    for (const key of SIBLING_KEYS) {
      expect(afterReload[key], `兄弟字段签名 ${key} 被 reload 前后的字体操作链清空/改写`).toBe(baseline[key])
    }
    expect(afterReload.localSettingsRaw).toBe(baseline.localSettingsRaw)
    expect(afterReload.fontsSize).toBe(baseline.fontsSize)
    expect(afterReload.terminal).toBe(baseline.terminal)
  })
})
