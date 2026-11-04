/**
 * 托盘入口链 REAL E2E —— 真实 runtime + pi 子进程 + faux LLM 演员（L2.5，零 token）。
 *
 * 承载 tray-panel-interact 设计 §3.4 M2（入口复活）的入口链断言。设计原文把落点写在
 * `e2e/workflow-viz-overlay.spec.ts` 与 `e2e/workflow-sidebar-sync.spec.ts`（mock 层），
 * 动笔前核实发现**该链路在 mock 层结构性不可达**（四条证据链 + 仓内先例，见下），入口链
 * 断言随主 agent 裁决（选项②+③）整体迁到本真实进程层 spec；两个 mock spec 收窄后零
 * 可跑用例，随本迁移删除（对账登记 = docs/testing/e2e-map.json E2E-MOCK-01 / E2E-REAL-01）。
 *
 * ── mock 层不可达的证据链（2026-11-02 逐条读源码核实）──
 * ① mock 推帧只走 session 通道：`packages/core/src/transport/mock/index.ts` 的
 *   `pushSession` 仅调 `events.dispatchSession(sessionId, msg)`
 *   （`packages/core/src/transport/api/events.ts:72`——只投 sessionHandlers）；
 * ② 托盘 widget 区的数据源 ViewHostStore 经 ExtensionHost bridge 的
 *   `createWsPluginMessageSource` 订阅 `onGlobal` / `onCrossSession`
 *   （`packages/ui/src/extension-host/shell-adapters.ts:60-84`），带 sid 的
 *   `extension:widgetGui` 由 route-inbound 的 crossSession 分支投递
 *   （`events.ts:140` 的 `dispatchCrossSession` 只被 route-inbound 调用）——mock 不进
 *   route-inbound，故该帧永远到不了 ViewHostStore；
 * ③ mock 的 `getPluginUiSnapshot` 恒返 `{ headerActions: [], views: [] }`
 *   （mock/index.ts:2021-2024，无插件运行时）——拉路径同样零条目；
 * ④ 仓内先例：`e2e/gui-components.spec.ts` 头注已独立登记同 blocker，并把 widgetGui
 *   消费端断言迁到 `e2e/tasks-drawer-real.spec.ts` R2。
 * 修复点（出本 spec 领地，登记为 blocker）= mock 的 pushSession 增补 route-inbound 同款
 * crossSession 分发路径 + getPluginUiSnapshot 返回 widget 视图快照；修复后 mock 层入口链
 * 断言可回迁。
 *
 * ── 覆盖范围（对应原 mock spec 的用例，逐条核对依赖后迁入）──
 * - RE1（原 workflow-sidebar-sync T1 行集 + T3 入口归宿）：托盘 workflow widget 区分桶
 *   挂载（徽标/呼吸点/面板 head 计数/tab-bar 段标签/list-tree 行集同行 label 对账）+
 *   点行经容器导航执行器打开浮层并定位该 run（header scriptName 对账）+ ESC 关闭后
 *   composer 恢复。
 * - RE2（D11/RL8 新建断言——设计 §4.2 RL8：D11 为新行为、现状无既有断言，落点随入口链
 *   迁入本 spec；设计 §3.3 D11）：导航后面板收起联动——pin 态
 *   托盘面板在「容器从关到开」边沿让位（面板 DOM 摘除 + pin 清除）；反向边沿（关浮层）不
 *   动作，面板不被 watch 复活。
 * - RE3（原 workflow-sidebar-sync T2 挂载回归）：切到无 workflow 数据的 session → widget
 *   条目整体摘除（归零不虚亮）；切回 → 恢复（分区读，非残留）。
 * 原 workflow-viz-overlay.spec.ts 的 OV1-OV10（overlay 内部行为，依赖 mock 冻结演员表
 * `packages/core/src/transport/mock/workflow-data.ts` 的 11 个 run）在 mock 层入口消失后
 * 无承载位：真实层无同构冻结演员表，overlay 内部行为的确定性半边由组件测试
 * `packages/renderer/src/components/panel/workflow-viz/overlay/__tests__/workflow-viz-overlay-bundle.test.ts`
 * 承担；跨进程集成半边的恢复条件 = 上方 mock 层修复点落地（登记为 blocker）。
 *
 * 数据来源 = 真实 subagent-workflow 扩展：faux 主对话首轮 toolCall 调 `workflow_run` 工具
 * 起跑探针脚本（e2e/fixtures/skill-reload-real-helpers.ts 的 writeUserWorkflowScripts +
 * mainDispatchSteps），子 agent 长流式响应把 run 钉在在途态跨过全部断言窗口。
 *
 * 运行（真实进程层，空载串行，一条命令一个 spec）：
 *   npx playwright test e2e/tray-entry-real.spec.ts
 */
import { test, expect, type Page, type Locator } from '@playwright/test'
import {
  launchRealApp,
  waitForRuntime,
  wsRoundTrip,
  openListenWs,
  waitForExtensionsReady,
} from './fixtures/launch-app-real'
import fs from 'node:fs'
import {
  FAUX_TPS,
  SUB_MODEL_A,
  makeTempDir,
  makeSurvivalProbeSource,
  mainDispatchSteps,
  survivorSteps,
  writeUserWorkflowScripts,
} from './fixtures/skill-reload-real-helpers'

/** 探针脚本名（fixture 侧字面，行 label 与 overlay header 的身份对账源） */
const PROBE_NAME = 'tray-entry-probe'
const SESSION_LABEL = 'tray-entry-probe'
/** 无 workflow 数据的会话标签（RE3 挂载回归的对照 session） */
const EMPTY_LABEL = 'tray-entry-empty'

/** 子 agent 流式文本长度（chars）：拉长在途窗口，覆盖「起跑 → 点行 → 浮层断言」全程 */
const PROBE_STREAM_CHARS = 2400

function probeStreamText(): string {
  const unit = 'tray entry probe stream line. '
  return unit.repeat(Math.ceil(PROBE_STREAM_CHARS / unit.length))
}

/** 协议 widget 区条目按钮（data-widget-key 区分；workflow 件已迁插件推 widget 树） */
function widgetButton(page: Page, viewId: 'subagent' | 'workflow'): Locator {
  return page.locator(`[data-testid="tray-widget-button"][data-widget-key="${viewId}"]`)
}

/** 打开某 widget 条目的面板（点击 = pin，不等 hover 延时，确定性优于 hover 时序） */
async function openWidgetPanel(page: Page, viewId: 'subagent' | 'workflow'): Promise<Locator> {
  await widgetButton(page, viewId).click()
  const panel = page.locator(`[data-testid="tray-panel"][data-panel-key="widget:${viewId}"]`)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  return panel
}

/** 面板内的 list-tree 行集：行声明 action.hostAction 后渲染为原生 button（行按钮 testid
 *  = gui-list-tree-action-<i>，ListTree 渲染契约）；composer-tray-protocol M3 富行迁移后
 *  行内操作（中止/续跑）挂行 actions 槽内嵌渲染——不匹配行按钮 testid 前缀，不混计入行数
 *  （旧口径 locator('button') 会把行内按钮计入行数）。 */
function workflowRows(panel: Locator): Locator {
  return panel.getByTestId('gui-list-tree').locator('[data-testid^="gui-list-tree-action-"]')
}

async function selectSessionInSidebar(page: Page, label: string): Promise<void> {
  const connBanner = page.getByText(/连接中/)
  await connBanner.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
  const item = page.locator('.session-item').filter({ hasText: label }).first()
  await expect(item).toBeVisible({ timeout: 30_000 })
  await item.click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 30_000 })
}

/**
 * 起跑探针 workflow：建 session → 侧栏激活 → 先 listen 再发 prompt（broadcast 时序竞争），
 * faux 主对话首轮 toolCall 调 `workflow_run` 工具起跑探针脚本。
 * 返回 session 的 cwd 临时目录（调用方 finally 负责清理——mkdtemp 自建自删红线）。
 */
async function startProbeRun(page: Page, port: number, probePath: string): Promise<{
  sessionId: string
  projectDir: string
  closeListen: () => void
}> {
  const projectDir = makeTempDir('taiji-tray-entry-proj-')
  const createReply = await wsRoundTrip(
    port,
    {
      type: 'session.create',
      id: 'tray-entry-create',
      payload: { cwd: projectDir, label: SESSION_LABEL },
    },
    'tray-entry-create',
  )
  expect(createReply.type).toBe('session.created')
  const session = createReply.payload.session as { id: string }
  await selectSessionInSidebar(page, SESSION_LABEL)
  const { ws } = await openListenWs(port, session.id)
  await wsRoundTrip(
    port,
    {
      type: 'message.send',
      id: 'tray-entry-send',
      payload: { sessionId: session.id, content: '运行托盘入口探针脚本。' },
    },
    'tray-entry-send',
    30_000,
  )
  return { sessionId: session.id, projectDir, closeListen: () => ws.close() }
}

/** 等托盘 workflow widget 条目进入 running 态（呼吸点在场 = 有进行中 run，归零不虚亮） */
async function waitForWorkflowWidgetRunning(page: Page): Promise<void> {
  await expect(
    widgetButton(page, 'workflow').getByTestId('tray-widget-pulse'),
    'workflow run 起跑后托盘 workflow widget 应亮 running 态（呼吸点在场）',
  ).toBeVisible({ timeout: 90_000 })
}

/**
 * 等宿主 workflow store 可读到该 session 的 run（容器导航可打开性的数据事实前置）。
 *
 * 为什么必须等：容器导航执行器对 overlay 内置内容 workflow 有可打开性门
 * （§6.15：`openableWithoutData=false` 且当前无数据 → 点击无动作 + 一行 warning）。
 * 数据判据 = 壳层 `hasData` 读 `useWorkflowStore().getRecordsBySession(focusedSid)`，
 * 而该 store 由 `session.workflowUpdate` 信号触发 `session.getWorkflows` RPC 填充——
 * 托盘 widget 的呼吸点来自扩展进程内存投影（widgetGui 推送），**先于** store 落库可达。
 * 故「widget 亮 running」不等于「行可点」；此处按同一读源（getWorkflows RPC）轮询到
 * 记录在场再点行，与 `hasData` 判据同源，非盲等。
 */
async function waitForWorkflowRecords(port: number, sessionId: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const reply = await wsRoundTrip(
      port,
      { type: 'session.getWorkflows', id: 'tray-entry-wf-list', payload: { sessionId } },
      'tray-entry-wf-list',
    )
    const runs = (reply.payload?.workflows ?? []) as unknown[]
    if (runs.length > 0) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`workflow store 60s 内未可读到 run（sessionId=${sessionId}）——行点击的可打开性门无法通过`)
}

/**
 * 收尾：关 app + 清理临时 dataDir 与 session cwd 临时目录
 * （PLAYWRIGHT_DEBUG_KEEP_DATA=1 时保留现场排查）。
 */
async function cleanupRealApp(
  cleanup: () => Promise<void>,
  dataDir: string,
  ...projectDirs: string[]
): Promise<void> {
  await cleanup()
  if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) {
    for (const dir of [dataDir, ...projectDirs]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  } else {
    console.log('[cleanup] dataDir 保留:', dataDir, projectDirs.join(' '))
  }
}

/**
 * 装配一个起跑了探针 workflow 的真实 app（三用例共用：dataDir → 脚本 → faux 脚本 → launch）。
 * 返回 page / port / dataDir / run 句柄 / cleanup。
 */
async function launchWithProbeRun(): Promise<{
  page: Page
  port: number
  dataDir: string
  run: Awaited<ReturnType<typeof startProbeRun>>
  cleanup: () => Promise<void>
}> {
  const dataDir = makeTempDir('taiji-tray-entry-')
  const [probePath] = writeUserWorkflowScripts(dataDir, [
    { name: PROBE_NAME, source: makeSurvivalProbeSource(PROBE_NAME, SUB_MODEL_A, 'tray entry probe') },
  ])
  const { page, cleanup } = await launchRealApp({
    dataDir,
    faux: {
      responses: {
        'faux/faux-1': mainDispatchSteps([probePath], 'workflow 已在后台启动。'),
        ...survivorSteps(SUB_MODEL_A, probeStreamText()),
      },
      tps: FAUX_TPS,
    },
  })
  await expect(page).toHaveTitle(/太极/)
  const port = await waitForRuntime(dataDir, 30_000)
  expect(port).toBeGreaterThan(0)
  await waitForExtensionsReady(dataDir)
  const run = await startProbeRun(page, port, probePath)
  return { page, port, dataDir, run, cleanup }
}

// ── RE1: 托盘 widget 分桶挂载 + 行点击 → 浮层定位该 run ──────────────────

test('RE1: 托盘 workflow 行点击 → 浮层打开且定位该 run（T1 行集 + T3 入口归宿）', async () => {
  test.setTimeout(240_000)
  const { page, port, run, cleanup, dataDir } = await launchWithProbeRun()
  try {
    await waitForWorkflowWidgetRunning(page)
    await waitForWorkflowRecords(port, run.sessionId)

    // ── T1 行集：widget 区分桶挂载，徽标/呼吸点/面板 head 计数同源（同一份 meta 推送）──
    await expect(widgetButton(page, 'workflow').getByTestId('tray-widget-badge')).toHaveText('1')

    const panel = await openWidgetPanel(page, 'workflow')
    // head 标题随 UI 语言（tray-panel-interact §3.3 D9：扩展产文案 + readUiLocale）——
    // 真机默认 zh-CN（renderer 首启推送 ui-preferences.json），故期望中文文案
    await expect(panel.getByTestId('tray-widget-panel-title')).toHaveText('工作流')
    await expect(panel.getByTestId('tray-widget-panel-label')).toHaveText('1')

    // 桶计数：协议 tab-bar 段标签（tabs 与 sections 等长同源——分桶事实在同一份推送数据内）
    await expect(panel.getByTestId('gui-tab-bar')).toContainText('进行中 1')
    await expect(panel.getByTestId('gui-tab-bar')).toContainText('已结束 0')

    // 进行中桶（首段 tabs[0].active=true）：1 行，行 label 承载 scriptName（rowLabelOf）
    await expect(workflowRows(panel)).toHaveCount(1)
    await expect(workflowRows(panel).first()).toContainText(PROBE_NAME)

    // ── T3 入口归宿：点行经容器导航执行器（hostAction → sink → openOverlayContent
    //    → bindWorkflowOverlayOpener 注入桥）打开浮层并定位该 run ──
    await workflowRows(panel).first().click()
    const overlay = page.getByTestId('wfvz-overlay')
    await expect(overlay).toBeVisible({ timeout: 15_000 })
    await expect(overlay.getByTestId('wfvz-overlay-header')).toContainText(PROBE_NAME)
    await expect(overlay.getByTestId('wfvz-overlay-run-pill')).toBeVisible()

    // 临时浮层不变量：ESC 关闭后 overlay 消失、composer 恢复可用（临时层不替换 Panel）
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
    // drawer 恢复半边（原 workflow-sidebar-sync T3 尾段语义，偏差表 #7「断言本体未丢」承接）：
    // ESC 后 drawer-toggle 仍可正常打开 drawer——Panel 状态未被临时层改变
    await page.getByTestId('drawer-toggle').click()
    await expect(page.getByTestId('drawer-area')).toBeVisible({ timeout: 5_000 })
  } finally {
    run.closeListen()
    await cleanupRealApp(cleanup, dataDir, run.projectDir)
  }
})

// ── RE2: D11 导航后面板收起联动（RL8）──────────────────────────────────

test('RE2: 导航后面板收起联动（D11/RL8）——容器从关到开的边沿 → 面板收起且 pin 清除', async () => {
  test.setTimeout(240_000)
  const { page, port, run, cleanup, dataDir } = await launchWithProbeRun()
  try {
    await waitForWorkflowWidgetRunning(page)
    await waitForWorkflowRecords(port, run.sessionId)

    // pin 托盘 workflow widget 面板（点击 = pin，不等 hover 延时）
    const panel = await openWidgetPanel(page, 'workflow')
    await expect(panel).toHaveAttribute('data-pinned', 'true')
    await expect(widgetButton(page, 'workflow')).toHaveAttribute('aria-pressed', 'true')

    // 点行进容器导航 → 浮层打开（容器开合态「从关到开」边沿）
    await workflowRows(panel).first().click()
    const overlay = page.getByTestId('wfvz-overlay')
    await expect(overlay).toBeVisible({ timeout: 15_000 })

    // D11 收起联动：面板让位 = DOM 层不存在（非 opacity:0 空壳）+ pin 清除
    await expect(
      page.locator('[data-testid="tray-panel"][data-panel-key="widget:workflow"]'),
    ).toHaveCount(0)
    await expect(widgetButton(page, 'workflow')).toHaveAttribute('aria-pressed', 'false')

    // 反向边沿不动作：关浮层是「从开到关」，watch 只动「关→开」边沿——面板不得被复活
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await expect(
      page.locator('[data-testid="tray-panel"][data-panel-key="widget:workflow"]'),
    ).toHaveCount(0)
    await expect(widgetButton(page, 'workflow')).toHaveAttribute('aria-pressed', 'false')
  } finally {
    run.closeListen()
    await cleanupRealApp(cleanup, dataDir, run.projectDir)
  }
})

// ── RE3: 无 workflow 数据会话的托盘挂载回归（T2 场景本体）────────────────

test('RE3: 切到无 workflow 数据的 session → widget 条目摘除，切回恢复（T2 挂载回归）', async () => {
  test.setTimeout(240_000)
  const { page, port, run, cleanup, dataDir } = await launchWithProbeRun()
  // 对照 session 的 cwd 临时目录（建 session 可能失败，声明在 try 外供 finally 兜底清理）
  let emptyProjectDir: string | null = null
  try {
    await waitForWorkflowWidgetRunning(page)
    await waitForWorkflowRecords(port, run.sessionId)
    await expect(widgetButton(page, 'workflow')).toBeVisible()

    // 建一个不起 workflow 的会话（判据同原 T2：无 workflow 记录 → 条目整体摘除）
    emptyProjectDir = makeTempDir('taiji-tray-entry-empty-proj-')
    const emptyReply = await wsRoundTrip(
      port,
      {
        type: 'session.create',
        id: 'tray-entry-empty-create',
        payload: { cwd: emptyProjectDir, label: EMPTY_LABEL },
      },
      'tray-entry-empty-create',
    )
    expect(emptyReply.type).toBe('session.created')
    await selectSessionInSidebar(page, EMPTY_LABEL)
    await expect(
      widgetButton(page, 'workflow'),
      '无 workflow 数据的 session：条目整体摘除（归零不虚亮——DOM 层不存在，非空壳）',
    ).toHaveCount(0, { timeout: 15_000 })

    // 切回 → 恢复（读分区，非残留）
    await selectSessionInSidebar(page, SESSION_LABEL)
    await expect(widgetButton(page, 'workflow')).toBeVisible({ timeout: 15_000 })
  } finally {
    run.closeListen()
    await cleanupRealApp(cleanup, dataDir, run.projectDir, ...(emptyProjectDir ? [emptyProjectDir] : []))
  }
})
