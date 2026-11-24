#!/usr/bin/env node
/**
 * AC-H12 真机探针：过程卡窗口 12 行上限。
 *
 * 装配（真宿主）：开发实例 = Vite dev server + 真 Electron 窗口 + 真 runtime + 真 pi 子进程 +
 * faux 演员（凭证无关假 LLM）；faux 脚本造一个 14 步命令的长回合，让过程段溢出 12 行。
 * 驱动：会话经 runtime WS 建（原生目录对话框不可自动化，TEST-STRATEGY 约定以 WS 直连触发
 * 等效业务动作），界面经 CDP 连接真实窗口操作（点侧栏会话项挂载面板、点卡头展开窗口）。
 * 断言：过程卡 ≤ 316px、窗口 ≤ 288px（12 × 24px）、窗口内行数 > 12（内容被裁剪）。
 *
 * 成功打印 OK-H12 并以 0 退出；失败打印诊断并以 1 退出（数据目录保留，路径打在最后一行）。
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const requireFromRepo = createRequire(path.join(REPO, 'package.json'))
const { chromium } = requireFromRepo('playwright')
const WebSocket = requireFromRepo('ws')

const RUN_ID = `tp-h12-${Date.now()}`
const DATA_DIR = path.join(os.homedir(), '.taiji-dev', RUN_ID)
const SAMPLE_PROJECT = path.join(REPO, 'e2e', 'fixtures', 'sample-project')
const LABEL = `tp-h12-${Date.now()}`
const CARD_MAX_PX = 316 // 卡头 24 + 窗口 288 + 上下内边距 4
const WINDOW_MAX_PX = 288 // 12 行 × 24px
const TOLERANCE_PX = 2
const EXPECTED_ROWS = 15 // 1 组头 + 14 条命令

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readOr = (file) => {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

/** runtime 日志里「resolved N extensions」信号 = 扩展装载就绪（session.create 过早会拿到畸形会话） */
async function waitForExtensionsReady(dataDir, timeoutMs = 120_000) {
  const logsDir = path.join(dataDir, 'logs')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let files = []
    try {
      files = fs.readdirSync(logsDir).filter((f) => f.startsWith('runtime-'))
    } catch {
      // 目录未建属正常启动慢路径
    }
    let text = ''
    for (const f of files) text += readOr(path.join(logsDir, f))
    const matches = [...text.matchAll(/resolved (\d+) extensions from \d+ sources/g)]
    if (matches.length > 0 && parseInt(matches[matches.length - 1][1], 10) >= 8) return true
    await sleep(1000)
  }
  return false
}

async function waitForRuntime(dataDir, timeoutMs = 120_000) {
  const portFile = path.join(dataDir, 'runtime.port')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const raw = readOr(portFile).trim()
    const port = parseInt(raw, 10)
    if (port > 0) return port
    await sleep(300)
  }
  throw new Error(`runtime.port 未出现（${portFile}）——runtime 启动失败`)
}

async function waitForCdpPage(cdpPort, vitePort, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      const pages = await res.json()
      const hit = pages.find((p) => typeof p.url === 'string' && p.url.includes(`:${vitePort}`))
      if (hit) return
    } catch {
      // 端口未起 / 窗口未建属启动慢路径
    }
    await sleep(500)
  }
  throw new Error(`CDP ${cdpPort} 上未出现含 vite:${vitePort} 的页面——实例未就绪`)
}

/** WS auth 握手（首条消息 {type:'auth', payload:{token}}；token 文件由 main 写） */
async function openAuthedWs(port, dataDir, timeoutMs = 30_000) {
  const tokenFile = path.join(dataDir, 'runtime-token')
  const deadline = Date.now() + timeoutMs
  let token = ''
  while (Date.now() < deadline) {
    token = readOr(tokenFile).trim()
    if (token) break
    await sleep(300)
  }
  if (!token) throw new Error(`runtime-token 未出现（${tokenFile}）`)
  const ws = await new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('WS auth 握手超时')), timeoutMs)
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString())
      if (m.type === 'auth.result') {
        clearTimeout(to)
        if (m.payload?.ok === true) resolve()
        else reject(new Error(`WS auth 失败：${m.payload?.reason ?? 'unknown'}`))
      }
    })
    ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
  })
  return ws
}

function wsRoundTrip(ws, msg, replyId, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`WS 回执 ${replyId} 超时`)), timeoutMs)
    const onMessage = (data) => {
      const m = JSON.parse(data.toString())
      if (m.id === replyId) {
        clearTimeout(to)
        ws.off('message', onMessage)
        resolve(m)
      }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify(msg))
  })
}

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // 进程组已退出属正常收尾
  }
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  // 1. faux 预置：一个 assistant 轮里 14 条 bash 调用 + 收尾文本 → 过程段 1 组 14 行，溢出 12 行
  const responses = [
    {
      thinking: '跑一长串命令来验证过程卡窗口的行数上限。',
      toolCalls: Array.from({ length: 14 }, (_, i) => ({ name: 'bash', args: { command: `echo tp-step-${i + 1}` } })),
      stopReason: 'toolUse',
    },
    { text: '14 步跑完，过程卡窗口应被 12 行上限裁剪。', stopReason: 'stop' },
  ]
  const resFile = path.join(os.tmpdir(), `${RUN_ID}-responses.json`)
  fs.writeFileSync(resFile, JSON.stringify(responses))
  execFileSync('node', [path.join(REPO, '.agents/skills/verify-taiji/scripts/seed-faux.mjs'), REPO, DATA_DIR, resFile], {
    encoding: 'utf8',
  })

  // 2. 端口派生（--print 不启动实例）
  const banner = execFileSync('node', [path.join(REPO, 'apps/electron/scripts/dev-instance.mjs'), '--print'], {
    encoding: 'utf8',
    env: { ...process.env, TAIJI_DEV_BACKGROUND: '1' },
  })
  const vitePort = Number((banner.match(/Vite:[^\n]*?:(\d+)/) || [])[1])
  const cdpPort = Number((banner.match(/CDP:[^\n]*?:(\d+)/) || [])[1])
  if (!(vitePort > 0) || !(cdpPort > 0)) throw new Error(`端口派生失败：\n${banner}`)

  // 3. 启动开发实例（后台、不抢焦点；faux 脚本经 env 透传到 pi 子进程）
  const child = spawn('node', [path.join(REPO, 'apps/electron/scripts/dev-instance.mjs'), '--data-dir', DATA_DIR], {
    env: {
      ...process.env,
      TAIJI_DEV_BACKGROUND: '1',
      TAIJI_FAUX_SCRIPT: path.join(DATA_DIR, 'agent/faux-responses.json'),
      TAIJI_FAUX_TPS: '20',
      // faux provider 扩展：与 e2e 真进程层同一装配点（e2e/fixtures/launch-app-real.ts 的 TAIJI_EXTENSION_PATHS）
      TAIJI_EXTENSION_PATHS: path.join(REPO, 'e2e', 'fixtures', 'faux-provider-ext'),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let instanceLog = ''
  child.stdout.on('data', (d) => (instanceLog += d))
  child.stderr.on('data', (d) => (instanceLog += d))
  child.unref()

  let browser = null
  let uiPage = null
  try {
    const runtimePort = await waitForRuntime(DATA_DIR)
    const extReady = await waitForExtensionsReady(DATA_DIR)
    if (!extReady) console.log('[probe] 扩展装载信号未在限时内出现，继续（session.create 可能仍可用）')
    await waitForCdpPage(cdpPort, vitePort)

    // 4. 建会话（WS 直连触发等效业务动作）
    const ws = await openAuthedWs(runtimePort, DATA_DIR)
    let sessionId = ''
    try {
      const createReply = await wsRoundTrip(ws, { type: 'session.create', id: 'h12-create', payload: { cwd: SAMPLE_PROJECT, label: LABEL } }, 'h12-create')
      sessionId = createReply.payload?.session?.id
      if (!sessionId) throw new Error(`session.create 回执无 session.id：${JSON.stringify(createReply).slice(0, 300)}`)

      // 5. CDP 连真实窗口：点侧栏会话项 → composer 出现（面板挂载、订阅建立）
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
      const ctx = browser.contexts()[0]
      const page = ctx.pages().find((p) => p.url().includes(`:${vitePort}`)) ?? ctx.pages()[0]
      uiPage = page
      await page.waitForLoadState('domcontentloaded')
      await page.getByText(/连接中/).waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
      await page.getByRole('button', { name: /^会话/ }).click({ timeout: 10_000 }).catch(() => {})
      // 会话挂在「默认项目」组下，组默认收起：先展开当前项目的组头（.pgh-main 是组头按钮）
      // 默认项目（未归类收件箱）用 DefaultProjectHead 头行，会话在展开后才平铺出来；
      // 命名项目组用 .pgh-main 组头。两条都试：先找默认项目头，找不到再退回命名组头。
      const defaultHead = page.locator('[data-testid="default-project-anchor"]').first()
      const groupHead = page.locator('[data-testid="project-group"] .pgh-main').first()
      const head = (await defaultHead.count()) > 0 ? defaultHead : groupHead
      await head.waitFor({ state: 'visible', timeout: 20_000 })
      if ((await head.getAttribute('aria-expanded')) === 'false') await head.click()
      const item = page.locator('.session-item').filter({ hasText: LABEL }).first()
      await item.waitFor({ state: 'visible', timeout: 30_000 })
      await item.click()
      await page.getByTestId('composer-box').waitFor({ state: 'visible', timeout: 30_000 })

      // 6. 发消息（WS）；界面已挂载该会话，广播帧进入同一 DOM
      await wsRoundTrip(ws, { type: 'message.send', id: 'h12-send', payload: { sessionId, content: '跑一遍这条长命令链，然后收尾。' } }, 'h12-send')

      // 7. 等回合落成：回合折叠（默认）= 只留末位正文，过程卡不挂载；
      //    先点轮头展开回合，过程卡才出现（已工作 = 流式结束）
      const turnMeta = page.locator('[data-testid^="turn-meta-"]').first()
      await turnMeta.waitFor({ state: 'visible', timeout: 60_000 })
      const settledDeadline = Date.now() + 90_000
      while (Date.now() < settledDeadline) {
        const text = (await turnMeta.textContent()) ?? ''
        if (text.includes('已工作')) break
        await sleep(500)
      }
      if (!((await turnMeta.textContent()) ?? '').includes('已工作')) throw new Error('回合未在限时内落成（轮头仍显示工作中）')
      await turnMeta.click()

      const card = page.locator('[data-testid="process-aggregate"]').first()
      await card.waitFor({ state: 'visible', timeout: 30_000 })

      const tape = page.locator('[data-testid="agg-tape"]').first()
      if ((await tape.count()) === 0) await card.locator('[data-testid="agg-summary-row"]').click()
      await tape.waitFor({ state: 'visible', timeout: 15_000 })

      const dims = await page.evaluate(() => {
        const cardEl = document.querySelector('[data-testid="process-aggregate"]')
        const scroll = document.querySelector('[data-testid="agg-tape-scroll"]')
        // 行数口径：组头行 + 工具成员行 + 思考行（thinking 行根无专有 testid，用其内部锚点反查行）
        const rows = document.querySelectorAll('[data-testid="agg-tool-row"], [data-testid="agg-group-head"], [data-testid="thinking-duration"]')
        return {
          card: Math.round(cardEl.getBoundingClientRect().height),
          window: Math.round(scroll.getBoundingClientRect().height),
          windowClient: scroll.clientHeight,
          windowScroll: scroll.scrollHeight,
          rows: rows.length,
        }
      })
      console.log(`[probe] 量得：${JSON.stringify(dims)}`)

      const problems = []
      if (dims.card > CARD_MAX_PX + TOLERANCE_PX) problems.push(`卡片高度 ${dims.card}px > ${CARD_MAX_PX}px`)
      if (dims.window > WINDOW_MAX_PX + TOLERANCE_PX) problems.push(`窗口高度 ${dims.window}px > ${WINDOW_MAX_PX}px`)
      if (dims.rows < EXPECTED_ROWS) problems.push(`窗口内行数 ${dims.rows} < ${EXPECTED_ROWS}（长回合未造出 12 行以上的内容）`)
      if (dims.windowScroll <= dims.windowClient) problems.push('窗口内容未溢出（12 行上限没有被行使）')
      if (problems.length > 0) throw new Error(problems.join('；'))

      const shot = path.join(DATA_DIR, 'h12-card.png')
      await card.screenshot({ path: shot })
      console.log(`OK-H12 卡片 ${dims.card}px / 窗口 ${dims.window}px / 行 ${dims.rows}（泪滴图：${shot}）`)
    } finally {
      ws.close()
    }
  } catch (err) {
    console.error(`[probe] 失败：${err instanceof Error ? err.message : String(err)}`)
    console.error(`[probe] 实例日志尾部：\n${instanceLog.slice(-3000)}`)
    const logs = path.join(DATA_DIR, 'logs')
    for (const f of fs.readdirSync(logs).slice(-3)) console.error(`[probe] ${f} 尾部：\n${readOr(path.join(logs, f)).slice(-2000)}`)
    if (uiPage) {
      try {
        await uiPage.screenshot({ path: path.join(DATA_DIR, 'failure-ui.png') })
        fs.writeFileSync(path.join(DATA_DIR, 'failure-dom.txt'), await uiPage.evaluate(() => document.body.innerText.slice(0, 4000)))
        const counts = await uiPage.evaluate(() => ({
          sessionItems: document.querySelectorAll('.session-item').length,
          projectGroups: Array.from(document.querySelectorAll('[data-testid="project-group"]')).map((g) => ({
            current: g.getAttribute('data-current'),
            main: g.querySelectorAll('.pgh-main').length,
            text: g.textContent?.slice(0, 40),
          })),
          buttons: Array.from(document.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '').filter((t) => t.length > 0).slice(0, 30),
        }))
        fs.writeFileSync(path.join(DATA_DIR, 'failure-ui.json'), JSON.stringify(counts, null, 2))
      } catch (e) {
        console.error(`[probe] 界面取证失败：${String(e)}`)
      }
    }
    console.error(`[probe] 数据目录保留：${DATA_DIR}`)
    process.exitCode = 1
  } finally {
    try {
      if (browser) await browser.close()
    } catch {
      // 连接已断开属正常收尾
    }
    killGroup(child.pid)
    await sleep(500)
    if (process.exitCode !== 1) fs.rmSync(DATA_DIR, { recursive: true, force: true })
  }
}

await main()
