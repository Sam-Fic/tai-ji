#!/usr/bin/env node
/**
 * 真机验收探针共用装配（chat-flow-v2 acceptance harness）：
 * 开发实例（Vite dev + 真 Electron + 真 runtime + 真 pi + faux 演员）启动、端口派生、
 * WS 建会话、CDP 挂载面板。各探针只写自己的断言。
 *
 * 复用 verify-taiji 的 seed-faux / dev-instance（AGENTS.md 指定的真机验收唯一入口）；
 * faux provider 扩展经 TAIJI_EXTENSION_PATHS 装载（与 e2e 真进程层同一装配点）。
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(process.cwd() + '/package.json')
const { chromium } = require('playwright')
const WebSocket = require('ws')

const SAMPLE_PROJECT = path.join(process.cwd(), 'e2e', 'fixtures', 'sample-project')
const REPO = process.cwd()

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readOr = (file) => {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

/** 一个 assistant 轮里 N 条 bash 调用 + 收尾文本（faux 脚本形状见 verify-taiji features/chat-stream.md） */
export function longChainSteps(n) {
  return [
    {
      thinking: '跑一长串命令来验证过程卡窗口的行数上限与滚动提示。',
      toolCalls: Array.from({ length: n }, (_, i) => ({ name: 'bash', args: { command: `echo tp-step-${i + 1}` } })),
      stopReason: 'toolUse',
    },
    { text: '跑完了。', stopReason: 'stop' },
  ]
}

/** 端口是否已被占用（本机回环两个地址族都探：vite 可能只监听其中一个） */
async function portInUse(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ port, host })
      socket.setTimeout(800)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('error', () => resolve(false))
    })
  return (await probe('127.0.0.1')) || (await probe('::1'))
}

/**
 * 开发实例的端口组（vite / CDP / runtime 端口段）按实例名哈希派生。探针必须用自己的实例名：
 * 同名实例会算出同一组端口，后启动的连不上自己的页面，却会接到先启动的那个实例的调试端口上操作它。
 * 逐个候选名试到一组三个端口位都空闲为止。
 */
async function pickInstanceName(runId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = attempt === 0 ? runId : `${runId}-${attempt}`
    const banner = execFileSync('node', [path.join(REPO, 'apps/electron/scripts/dev-instance.mjs'), '--print', '--name', name], {
      encoding: 'utf8',
      env: { ...process.env, TAIJI_DEV_BACKGROUND: '1' },
    })
    const vitePort = Number((banner.match(/Vite:[^\n]*?:(\d+)/) || [])[1])
    const cdpPort = Number((banner.match(/CDP:[^\n]*?:(\d+)/) || [])[1])
    const runtimePorts = [
      ...banner.matchAll(/runtime 端口段:\s*(\d+)-(\d+)/g),
    ].flatMap((m) => [Number(m[1]), Number(m[2])])
    if (!(vitePort > 0) || !(cdpPort > 0) || runtimePorts.length !== 2) throw new Error(`端口派生失败：\n${banner}`)
    const busy = []
    if (await portInUse(vitePort)) busy.push(`vite ${vitePort}`)
    if (await portInUse(cdpPort)) busy.push(`CDP ${cdpPort}`)
    for (let port = runtimePorts[0]; port <= runtimePorts[1]; port += 1) {
      if (await portInUse(port)) busy.push(`runtime ${port}`)
    }
    if (busy.length === 0) return { name, banner, vitePort, cdpPort }
    console.log(`[harness] 实例名 ${name} 的端口组已被占用（${busy.join('、')}），换名重试`)
  }
  throw new Error('连续 8 个候选实例名的端口组都被占用——请先关掉不用的开发实例再跑探针')
}

async function waitForExtensionsReady(dataDir, timeoutMs = 120_000) {
  const logsDir = path.join(dataDir, 'logs')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let text = ''
    try {
      for (const f of fs.readdirSync(logsDir).filter((f) => f.startsWith('runtime-'))) text += readOr(path.join(logsDir, f))
    } catch {
      // logs 目录未建属启动慢路径
    }
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
    const port = parseInt(readOr(portFile).trim(), 10)
    if (port > 0) return port
    await sleep(300)
  }
  throw new Error(`runtime.port 未出现（${portFile}）——runtime 启动失败`)
}

async function waitForCdpPage(cdpPort, vitePort, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      if (pages.some((p) => typeof p.url === 'string' && p.url.includes(`:${vitePort}`))) return
    } catch {
      // 端口未起 / 窗口未建属启动慢路径
    }
    await sleep(500)
  }
  throw new Error(`CDP ${cdpPort} 上未出现含 vite:${vitePort} 的页面——实例未就绪`)
}

export async function openAuthedWs(port, dataDir, timeoutMs = 30_000) {
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

export function wsRoundTrip(ws, msg, replyId, timeoutMs = 60_000) {
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

/**
 * 启动一个带 faux 装配的开发实例并建好会话。
 * @param steps faux 响应脚本（FauxStep 数组）
 * @param label 会话标签（侧栏显示名）
 * @returns 端口 / WS / 页面 / 清理函数；失败时抛错（调用方负责取证）
 */
export async function boot({ steps, label, tps = '20' }) {
  const runId = `tp-${Date.now()}`
  const dataDir = path.join(os.homedir(), '.taiji-dev', runId)
  fs.mkdirSync(dataDir, { recursive: true })
  const resFile = path.join(os.tmpdir(), `${runId}-responses.json`)
  fs.writeFileSync(resFile, JSON.stringify(steps))
  execFileSync('node', [path.join(REPO, '.agents/skills/verify-taiji/scripts/seed-faux.mjs'), REPO, dataDir, resFile], { encoding: 'utf8' })

  const { name: instanceName, vitePort, cdpPort } = await pickInstanceName(runId)

  const child = spawn(
    'node',
    [path.join(REPO, 'apps/electron/scripts/dev-instance.mjs'), '--name', instanceName, '--data-dir', dataDir],
    {
    env: {
      ...process.env,
      TAIJI_DEV_BACKGROUND: '1',
      TAIJI_FAUX_SCRIPT: path.join(dataDir, 'agent/faux-responses.json'),
      TAIJI_FAUX_TPS: tps,
      TAIJI_EXTENSION_PATHS: path.join(REPO, 'e2e', 'fixtures', 'faux-provider-ext'),
    },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let instanceLog = ''
  child.stdout.on('data', (d) => (instanceLog += d))
  child.stderr.on('data', (d) => (instanceLog += d))
  child.unref()

  // 调试连接与 WS 在 cleanup 里断开：不断开则事件循环被占着，探针进程结束后不退出
  let browserRef = null
  const cleanup = async () => {
    try {
      clearInterval(keepalive)
    } catch {
      // 无保活计时器（启动失败路径）
    }
    try {
      await browserRef?.close()
    } catch {
      // 调试连接已断开属正常收尾
    }
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // 进程组已退出属正常收尾
    }
    await sleep(500)
  }

  try {
    const runtimePort = await waitForRuntime(dataDir)
    const extReady = await waitForExtensionsReady(dataDir)
    if (!extReady) console.log('[harness] 扩展装载信号未在限时内出现，继续（session.create 可能仍可用）')
    await waitForCdpPage(cdpPort, vitePort)

    const ws = await openAuthedWs(runtimePort, dataDir)
    // 保活：runtime 45s 无消息断连（e2e fixture 同款处理）——探针的 WS 在长回合里长时间空闲
    const keepalive = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: 'config.get', id: `ka-${Date.now()}` }))
      } catch {
        // 连接已断开属正常收尾
      }
    }, 20_000)
    const createReply = await wsRoundTrip(ws, { type: 'session.create', id: `${runId}-create`, payload: { cwd: SAMPLE_PROJECT, label } }, `${runId}-create`)
    const sessionId = createReply.payload?.session?.id
    if (!sessionId) throw new Error(`session.create 回执无 session.id：${JSON.stringify(createReply).slice(0, 300)}`)

    const browser = browserRef = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
    const ctx = browser.contexts()[0]
    const page = ctx.pages().find((p) => p.url().includes(`:${vitePort}`)) ?? ctx.pages()[0]
    await page.waitForLoadState('domcontentloaded')
    await page.getByText(/连接中/).waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
    await page.getByRole('button', { name: /^会话/ }).click({ timeout: 10_000 }).catch(() => {})
    // 会话挂在默认项目头行下（未归类收件箱），头行默认收起：先展开
    const defaultHead = page.locator('[data-testid="default-project-anchor"]').first()
    if ((await defaultHead.count()) > 0) {
      await defaultHead.waitFor({ state: 'visible', timeout: 20_000 })
      if ((await defaultHead.getAttribute('aria-expanded')) === 'false') await defaultHead.click()
    }
    const item = page.locator('.session-item').filter({ hasText: label }).first()
    await item.waitFor({ state: 'visible', timeout: 30_000 })
    await item.click()
    await page.getByTestId('composer-box').waitFor({ state: 'visible', timeout: 30_000 })

    return { runId, dataDir, vitePort, cdpPort, ws, sessionId, page, browser, child, instanceLog, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}
