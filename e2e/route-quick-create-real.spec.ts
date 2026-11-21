/**
 * 模型路由快速创建 —— 真实进程层 e2e（E2E-REAL-ROUTE-01）。
 *
 * 验证链路（UI 全程真实 Playwright 操作，无 mock）：
 * - 设置弹层 → 导航 model-route → RouteQuickCreatePanel 快速创建
 *   - simple：渠道展开 → 模型行「建简单路由」→ 新卡 route-card → RouteUnsavedBar 保存
 *   - advanced：筛选 'faux' → 勾选 ≥2 模型 → 「创建高级路由」→ 新卡含 route-card-pending-split → 保存
 * - 保存落 providers.json routes 域（provider-aggregation 扩展消费）后，
 *   经 WS session.create（modelOverride = aggregation/<routeId>）+ message.send，
 *   断言 pi 经聚合路由虚拟模型收到 faux 回复文本（真实 spawn → faux LLM 演员闭环）。
 *
 * 协议事实（读代码确认）：
 * - 设置入口 = sidebar-settings（Sidebar.vue）；导航项 testid = settings-nav-<key>
 *   （SettingsModal.vue，key SSOT = content-slots.ts 'model-route'）
 * - RouteQuickCreatePanel 默认展开（open=ref(true)）；渠道行 route-quick-provider-row、
 *   多选钮 route-quick-pick-<providerId>-<modelId>、简单/高级创建钮 testid 同名
 * - RouteUnsavedBar：data-testid="route-unsaved-bar"（v-show=dirty）+ unsaved-save
 * - RouteCard：data-testid="route-card" + :data-route-id="card.route.id"
 * - 聚合模型引用 = `<AGGREGATION_PROVIDER_ID>/<routeId>` = aggregation/<routeId>
 *   （shared re-export @zhushanwen/extension-protocol aggregation）
 * - assistant 回复事件 = message.text_delta（payload.delta）/ message.complete（payload.content）
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  launchRealApp,
  waitForRuntime,
  wsRoundTrip,
  openListenWs,
  waitForExtensionsReady,
} from './fixtures/launch-app-real'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')

/** faux 响应队列：每个 test 只发一次 prompt，消费步骤 1 文本 */
const FAUX_RESPONSES = [{ text: 'ok-from-route' }]

function writeDiag(name: string, data: Record<string, unknown>): void {
  fs.writeFileSync(`/tmp/${name}`, JSON.stringify(data, null, 2))
  console.log(`[diag] ${name} → /tmp/${name}`)
}

/** WS 创建 session（参考 ask-user-real 同款：先等 extension resolver 就绪） */
async function createSession(
  port: number,
  dataDir: string,
  label: string,
  modelOverride?: string,
): Promise<string> {
  const resolved = await waitForExtensionsReady(dataDir)
  if (resolved === 0) console.log('[warn] extensions not ready within timeout, continue anyway')
  const id = `route-real-create-${Date.now()}`
  const reply = await wsRoundTrip(port, {
    type: 'session.create',
    id,
    payload: { cwd: SAMPLE_PROJECT, label, ...(modelOverride ? { modelOverride } : {}) },
  }, id, 120_000)
  expect(reply.type, `session.create reply (${JSON.stringify(reply.payload?.slice?.(0, 200) ?? '')})`).toBe('session.created')
  return (reply.payload!.session as { id: string }).id
}

/** UI：打开设置弹层 → 进入模型路由页，返回 page（等待 quick-create 面板可见） */
async function openModelRoutePage(page: import('@playwright/test').Page): Promise<void> {
  // 启动竞态防护（ask-user-real 同款）：连接 banner 隐藏后再操作 UI
  const connBanner = page.getByText(/连接中/)
  await connBanner.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
  await page.getByTestId('sidebar-settings').click({ timeout: 15_000 })
  await page.getByTestId('settings-nav-model-route').click({ timeout: 15_000 })
  await expect(page.getByTestId('model-route-page')).toBeVisible({ timeout: 30_000 })
  // 快速创建面板挂载 = 路由视图就绪（model-route-pending/loading 均已消退）
  await expect(page.getByTestId('route-quick-create')).toBeVisible({ timeout: 30_000 })
}

/** 在 quick-create 面板展开 faux 渠道（面板默认展开；渠道行点击展开） */
async function expandFauxProvider(page: import('@playwright/test').Page): Promise<void> {
  const row = page
    .getByTestId('route-quick-provider-row')
    .filter({ hasText: 'faux' })
    .first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
  // 展开后模型行出现（faux 渠道 4 模型）
  await expect(
    page.locator('[data-testid="route-quick-model-row"][data-model-id="faux-1"]').first(),
  ).toBeVisible({ timeout: 10_000 })
}

/** 保存草稿并等保存完成（dirty 条隐藏 + 新卡仍在） */
async function saveRoutes(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('unsaved-save').click({ timeout: 10_000 })
  await expect(page.getByTestId('route-unsaved-bar')).toBeHidden({ timeout: 30_000 })
}

/** 读取新路由 id（当前唯一 route-card 的 data-route-id） */
async function readRouteId(page: import('@playwright/test').Page): Promise<string> {
  const card = page.getByTestId('route-card').first()
  await expect(card).toBeVisible({ timeout: 10_000 })
  const routeId = await card.getAttribute('data-route-id')
  expect(routeId, 'route-card 应带 data-route-id').toBeTruthy()
  return routeId!
}

/** 用 aggregation/<routeId> 覆盖建新会话，发 prompt，等 faux 回复文本 */
async function chatViaRoute(port: number, dataDir: string, routeId: string, label: string): Promise<void> {
  const modelRef = `aggregation/${routeId}`
  const sessionId = await createSession(port, dataDir, label, modelRef)
  // 先订阅再发（broadcast 时序竞争防护）
  const { ws: listenWs, events } = await openListenWs(port, sessionId)
  try {
    const sendId = `route-send-${Date.now()}`
    const sendReply = await wsRoundTrip(port, {
      type: 'message.send',
      id: sendId,
      payload: { sessionId, content: 'hi' },
    }, sendId)
    expect(sendReply.type).toBe('message.status')
    expect(sendReply.payload?.status).toBe('sent')

    // 等 assistant 回复（text_delta 增量或 complete 终态 content）
    const deadline = Date.now() + 90_000
    let got = ''
    while (Date.now() < deadline) {
      for (const e of events) {
        if (e.type === 'message.text_delta' && typeof e.payload?.delta === 'string') got += e.payload.delta
        if (e.type === 'message.complete' && typeof e.payload?.content === 'string' && !got) got = e.payload.content
      }
      if (got.includes('ok-from-route')) break
      const failed = events.find((e) => e.type === 'message.complete' && e.payload?.stopReason === 'error')
      if (failed) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!got.includes('ok-from-route')) {
      writeDiag('route-chat-diag.json', {
        modelRef,
        got,
        eventTypes: [...new Set(events.map((e) => e.type))],
        completeEvents: events.filter((e) => e.type === 'message.complete').map((e) => e.payload),
      })
    }
    expect(got, `聚合路由 ${modelRef} 应收到 faux 回复 ok-from-route（实收: "${got}"）`).toContain('ok-from-route')
  } finally {
    listenWs.close()
  }
}

// ── simple route ────────────────────────────────────────────────────────

test('simple route: 快速创建简单路由 → 保存 → aggregation/<id> 会话收到 faux 回复', async () => {
  test.setTimeout(180_000)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-real-route-'))
  const { page, cleanup } = await launchRealApp({ dataDir, faux: { responses: FAUX_RESPONSES } })
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)

    // 首个会话（占位让 app 进入正常工作态；快速路由操作在设置页完成）
    await createSession(port, dataDir, 'route-simple')

    await openModelRoutePage(page)
    await expandFauxProvider(page)

    const before = await page.getByTestId('route-card').count()
    await page.getByTestId('route-quick-create-simple').first().click()
    await expect(page.getByTestId('route-card')).toHaveCount(before + 1, { timeout: 10_000 })

    await saveRoutes(page)
    // 保存后视图刷新（草稿重置），新卡仍在
    await expect(page.getByTestId('route-card')).toHaveCount(before + 1, { timeout: 30_000 })
    const routeId = await readRouteId(page)

    // 关闭设置弹层（非必须，但保持窗口态干净）
    await page.getByTestId('settings-close-btn').click().catch(() => {})

    await chatViaRoute(port, dataDir, routeId, 'route-simple-chat')
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

// ── advanced route ──────────────────────────────────────────────────────

test('advanced route: 筛选勾选双模型 → 高级路由卡（pending-split）→ 保存 → 会话回复', async () => {
  test.setTimeout(180_000)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-real-route-'))
  const { page, cleanup } = await launchRealApp({ dataDir, faux: { responses: FAUX_RESPONSES } })
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)

    await createSession(port, dataDir, 'route-advanced')

    await openModelRoutePage(page)

    // 筛选 'faux' → 展开（筛选态下渠道组仍需展开才见模型行）
    await page.getByTestId('route-quick-filter').fill('faux')
    await expandFauxProvider(page)

    // 依次勾选 faux-1 与 faux-1-b（≥2 解禁高级创建）
    await page.getByTestId('route-quick-pick-faux-faux-1').click()
    await page.getByTestId('route-quick-pick-faux-faux-1-b').click()

    const before = await page.getByTestId('route-card').count()
    await page.getByTestId('route-quick-create-advanced').click()
    await expect(page.getByTestId('route-card')).toHaveCount(before + 1, { timeout: 10_000 })
    // 高级路由卡：待拆分端点提示在场
    await expect(page.getByTestId('route-card-pending-split').first()).toBeVisible({ timeout: 10_000 })

    await saveRoutes(page)
    await expect(page.getByTestId('route-card')).toHaveCount(before + 1, { timeout: 30_000 })
    const routeId = await readRouteId(page)

    await page.getByTestId('settings-close-btn').click().catch(() => {})

    await chatViaRoute(port, dataDir, routeId, 'route-advanced-chat')
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
