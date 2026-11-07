#!/usr/bin/env node
/**
 * dev 启动期冒烟门禁（W1 dev-smoke-gate）。
 *
 * 目标：堵 MOCK 层 E2E 盲区——dev 启动期崩溃（CSS 变量引用错 / Tailwind 类名错 /
 * import 路径错 / style.css 语法错 / Vue template compile 错）。这些崩溃在「只跑
 * MOCK 层 E2E」时不会被触发（MOCK 层依赖 build 产物，绕过 vite dev serve），
 * 也不被现有 vitest 单测覆盖（单测不挂载完整 AppShell）。
 *
 * 机制：VITE_MOCK=true spawn vite dev server（只起 vite，不起 electron）→ 双环回
 * （127.0.0.1/[::1]）轮询 ready 并取可达地址 → chromium launch（ready 后启动——
 * chrome 生存窗口最短化；缺浏览器早失败 exit 3）→ newPage + goto 同一地址 →
 * 双通道抓错误 → 断言关键挂载点 → try/finally cleanup。
 *
 * 双通道错误捕获（任一非空即 fail）：
 *   (A) vite 子进程输出（stdout+stderr）逐行正则匹配编译期错误 pattern
 *       （[vite] Internal Server Error / Module not found / Build failed /
 *        [vue/compiler] / SyntaxError / Pre-transform error / Failed to resolve import）
 *   (B) page.on('console') type=error（经 ignorePatterns 过滤已知噪声）+
 *       page.on('pageerror') 未捕获异常（无白名单，确定性失败）
 *
 * exit code：
 *   0 = ok（零 error + 挂载点全存在）
 *   1 = 有 error（console/pageerror/编译 pattern 非空 或 挂载点缺失 或 goto 失败）
 *   2 = dev server 提前退出（spawn 的进程死亡，非 ready 超时——ready 轮询无超时上限，
 *       时间机制删除裁决）
 *   3 = chromium launch 失败（二进制缺失，提示 npx playwright install chromium）
 *       或 newPage 失败
 *
 * 用法：
 *   node scripts/dev-smoke.mjs [--port 1420]
 *   pnpm dev:smoke   （根 package.json 暴露的便捷入口）
 *
 * 本脚本自管理完整生命周期（spawn → poll → launch → newPage/goto → assert → cleanup），
 * 不依赖外部已启动的 dev server。VITE_MOCK 经 spawn 子进程 env 注入，不污染调用方 shell。
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

// ---------------------------------------------------------------------------
// 默认值（与 parent slice IF1/DM1 契约一致）
// ---------------------------------------------------------------------------
const DEFAULT_DEV_CMD = 'pnpm --filter @taiji/frontend run dev'
const DEFAULT_PORT = 1420
const DEFAULT_MOUNT_SELECTORS = ['#app', '.app-shell']

// vite 输出命中即视为编译期错误（ERR4）。同时扫 stdout + stderr——vite logger
// 默认把 [vite] Internal Server Error / Pre-transform error 打 stdout，纯 stderr
// 监听会漏报。
const VITE_COMPILE_PATTERNS = [
  /\[vite\]\s+Internal Server Error/i,
  /Module not found/i,
  /Build failed/i,
  /\[vue\/compiler\]/i,
  /\bSyntaxError\b/,
  /Pre-transform error/i,
  /Failed to resolve import/i,
]

// 已知运行时噪声白名单（TASK-BASELINE 跑干净基线后确定，仅过滤 console type=error，
// 不影响 pageerror）。VITE_MOCK=true 下 renderer 自洽，预期接近空。
const DEFAULT_IGNORE_PATTERNS = [
  // 基线跑出噪声后在此回填，例如残留的 electronAPI 访问警告：
  // /electronAPI/,
]

// 轮询间隔
const POLL_INTERVAL_MS = 500

// 页面阶段有界化（Gate A attempt2 分诊：无界 await 遇 chromium 间歇死亡 → 挂死到被
// harness 外杀记 exit -1，连续两轮 ≈28 分钟）——挂死收敛为有界失败（exit 3/1 带诊断）。
// 测试门禁脚本的错误有界化；ready 轮询保持无界（时间机制删除裁决：vite 起不来的显式
// 失败路径 = child 退出探测，与时间无关）
const LAUNCH_TIMEOUT_MS = 90000
const PAGE_TIMEOUT_MS = 60000
const CLEANUP_TIMEOUT_MS = 15000
const KILL_GRACE_MS = 15000

/**
 * await 加界：promise 未在 ms 内落定 → 抛出（调用方按各自失败路径处置）。
 * 原始 promise 不取消（playwright 资源经 finally 的 browser.close/killProcess 释放）。
 */
async function withTimeout(promise, ms, label) {
  let timer
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 未在 ${ms}ms 内完成（页面阶段有界化）`)), ms)
  })
  try {
    return await Promise.race([promise, bound])
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// SmokeOptions / SmokeResult（JSDoc 形式，.mjs 无 TS；契约见 parent slice DM1/DM2）
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SmokeOptions
 * @property {string} [devCmd]        启动 dev server 的命令（shell 字符串）
 * @property {number} [port]          vite dev server 端口（默认 1420，strictPort）
 * @property {string[]} [mountSelectors] 必须可见的关键 DOM 挂载点 selector
 * @property {RegExp[]} [ignorePatterns] 已知运行时噪声白名单（仅过滤 console error）
 */

/**
 * @typedef {Object} SmokeResult
 * @property {boolean} ok
 * @property {string[]} stderrErrors   vite 输出命中编译 pattern 的行
 * @property {string[]} consoleErrors  console type=error（过滤白名单后）
 * @property {string[]} pageErrors     pageerror 未捕获异常（无白名单）
 * @property {string[]} missingMounts  未在限时内可见的 selector
 * @property {number} readyMs          dev server ready 耗时 ms
 * @property {0|1|2|3} exitCode        退出码
 * @property {string} [detail]         失败时的诊断信息（如 ready 超时附 stderr 尾部）
 */

// ---------------------------------------------------------------------------
// 核心实现
// ---------------------------------------------------------------------------

/**
 * 解析 options 默认值并推导 url（纯函数；主流程只做编排）。
 * @param {SmokeOptions} options
 */
function resolveSmokeOptions(options) {
  const port = options.port ?? DEFAULT_PORT
  return {
    devCmd: options.devCmd ?? DEFAULT_DEV_CMD,
    url: `http://localhost:${port}`,
    mountSelectors: options.mountSelectors ?? DEFAULT_MOUNT_SELECTORS,
    ignorePatterns: options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
  }
}

/**
 * 单个 chunk 的行级收集：保留全部非空行进 outputLines（超时诊断取尾部），
 * 命中 vite 编译 pattern 的行进 stderrErrors。
 */
function collectChunkLines(text, { outputLines, stderrErrors }) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    outputLines.push(line)
    if (VITE_COMPILE_PATTERNS.some((p) => p.test(trimmed))) {
      stderrErrors.push(trimmed)
    }
  }
}

/**
 * spawn dev server（VITE_MOCK 经子进程 env 注入）并挂 stdout/stderr 双流收集 +
 * spawn error 监听。返回 ChildProcess。
 * @param {string} devCmd
 * @param {{ outputLines: string[], stderrErrors: string[] }} sinks
 */
function spawnDevServer(devCmd, sinks) {
  const child = spawn(devCmd, {
    shell: true,
    env: { ...process.env, VITE_MOCK: 'true' },
    cwd: process.cwd(),
  })
  const onChunk = (chunk) => collectChunkLines(chunk.toString(), sinks)
  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)
  child.on('error', (err) => {
    // spawn 本身失败（如命令不存在）
    sinks.stderrErrors.push(`[dev-smoke] spawn error: ${err.message}`)
  })
  return child
}

/**
 * child 提前退出 → exit 2 结果（detail 附 vite 输出尾部诊断）。
 */
function makeChildExitedResult({ child, sinks, consoleErrors, pageErrors, missingMounts }) {
  const tail = sinks.outputLines.slice(-50).join('\n')
  const reason = `spawn 的 dev server 提前退出（exitCode=${child.exitCode} signalCode=${child.signalCode}）—— 常见原因：${DEFAULT_PORT} 端口被占（vite strictPort 退出）/ 命令错 / 依赖未装`
  return makeResult({
    exitCode: 2,
    stderrErrors: sinks.stderrErrors,
    consoleErrors,
    pageErrors,
    missingMounts,
    readyMs: 0,
    detail: `DEV_SERVER_CHILD_EXITED: ${reason}。vite 输出尾部:\n${tail}`,
  })
}

/**
 * 注册 page 双通道错误监听：console type=error（经 ignorePatterns 过滤已知噪声）+
 * pageerror 未捕获异常（无白名单，确定性失败）。
 */
function attachPageErrorListeners(page, { consoleErrors, pageErrors, ignorePatterns }) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      if (!ignorePatterns.some((p) => p.test(text))) {
        consoleErrors.push(text)
      }
    }
  })
  page.on('pageerror', (err) => {
    pageErrors.push(err.stack ? `${err.name}: ${err.message}\n${err.stack}` : String(err))
  })
}

/**
 * 逐个断言挂载点可见（waitForSelector 限时的 selector 记入 missingMounts，不中断后续）。
 * waitForSelector 是 Playwright 断言超时（测试框架语义，非产品等待机制）。
 */
async function assertMountsVisible(page, mountSelectors, mountTimeout, missingMounts) {
  for (const sel of mountSelectors) {
    try {
      await page.waitForSelector(sel, { state: 'visible', timeout: mountTimeout })
    } catch {
      missingMounts.push(sel)
    }
  }
}

/**
 * 运行 dev 冒烟门禁。
 * @param {SmokeOptions} [options]
 * @returns {Promise<SmokeResult>}
 */
export async function runSmoke(options = {}) {
  const { devCmd, url, mountSelectors, ignorePatterns } =
    resolveSmokeOptions(options)

  /** @type {string[]} */
  const stderrErrors = []
  /** @type {string[]} */
  const consoleErrors = []
  /** @type {string[]} */
  const pageErrors = []
  /** @type {string[]} */
  const missingMounts = []
  // 保留全部 vite 输出行，超时诊断时取尾部
  const outputLines = []
  const sinks = { outputLines, stderrErrors }

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  /** @type {import('@playwright/test').Browser | null} */
  let browser = null

  try {
    // ---- (1) spawn dev server（VITE_MOCK 经子进程 env 注入）----
    child = spawnDevServer(devCmd, sinks)

    // ---- (2) 轮询 dev server ready（ECONNREFUSED 继续轮询；child 退出立即判失败，
    //      避免连到 1420 上可能已存在的别的 dev 实例导致假结果）----
    //      2026-11-07 修：vite listen('localhost') 在 node verbatim DNS 下可能只绑
    //      IPv6 环回（::1），对 127.0.0.1/localhost 的连接被拒 → 轮询永不 ready 且
    //      child 活着 → 无限挂（undici 对 localhost 的 DNS 结果按序缓存钉在 127.0.0.1）。
    //      轮询改为双环回族各试一次，判定可达 family 后用同一显式地址供 chromium goto。
    const ready = await resolveReachableUrl(url, child)
    if (!ready.ok) {
      return makeChildExitedResult({ child, sinks, consoleErrors, pageErrors, missingMounts })
    }
    const readyMs = ready.ms
    const gotoUrl = ready.reachableUrl

    // ---- (3) chromium 启动（ready 后——chrome 生存窗口最短化。失败 exit 3）----
    //      2026-11-07 二修（Gate A attempt2 分诊）：chromium 对 vite 冷启动期间先行启动
    //      会在分钟级空窗内被环境杀死，后续 newPage 对死连接的 await 无界挂死（连续两轮
    //      ≈28 分钟形态）。launch/newPage/goto 全链有界化：挂死收敛为有界失败（exit 3/1
    //      带诊断），不再依赖 harness 外杀。测试门禁脚本的错误有界化，非产品时间机制。
    //      2026-11-07 三修（attempt3 分诊）：launch 超时路径泄漏防护——原始 launch promise
    //      未取消，超时后它 resolve 出的 Browser 无 close 调用点（孤儿 chromium 进程通道），
    //      此处接住延迟 resolve 立即补 close。
    let launchPromise
    try {
      launchPromise = chromium.launch()
      browser = await withTimeout(launchPromise, LAUNCH_TIMEOUT_MS, 'chromium launch')
      process.stderr.write('[dev-smoke] chromium 已启动\n')
    } catch (e) {
      if (launchPromise) {
        launchPromise.then((b) => b.close().catch(() => {}), () => {})
      }
      return makeResult({
        exitCode: 3,
        stderrErrors,
        consoleErrors,
        pageErrors,
        missingMounts,
        readyMs,
        detail: `CHROMIUM_LAUNCH_FAILED: ${e.message}\n提示: npx playwright install chromium`,
      })
    }

    // ---- (4) 注册 page 监听 + goto ----
    process.stderr.write('[dev-smoke] newPage …\n')
    let page
    try {
      page = await withTimeout(browser.newPage(), PAGE_TIMEOUT_MS, 'browser.newPage')
    } catch (e) {
      return makeResult({
        exitCode: 3,
        stderrErrors,
        consoleErrors,
        pageErrors,
        missingMounts,
        readyMs,
        detail: `NEW_PAGE_FAILED: ${e.message}`,
      })
    }
    process.stderr.write('[dev-smoke] newPage 完成\n')
    attachPageErrorListeners(page, { consoleErrors, pageErrors, ignorePatterns })

    try {
      await page.goto(gotoUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS })
    } catch (e) {
      return makeResult({
        exitCode: 1,
        stderrErrors,
        consoleErrors,
        pageErrors,
        missingMounts,
        readyMs,
        detail: `PAGE_GOTO_FAILED: ${e.message}`,
      })
    }
    process.stderr.write('[dev-smoke] goto 完成\n')

    // ---- (5) 断言挂载点可见（挂载断言限时 = 测试框架语义）----
    await assertMountsVisible(page, mountSelectors, 5000, missingMounts)

    // ---- 判定 ----
    const ok =
      stderrErrors.length === 0 &&
      consoleErrors.length === 0 &&
      pageErrors.length === 0 &&
      missingMounts.length === 0
    return makeResult({
      exitCode: ok ? 0 : 1,
      stderrErrors,
      consoleErrors,
      pageErrors,
      missingMounts,
      readyMs,
    })
  } finally {
    // ---- cleanup：任意退出路径都释放 browser + dev 子进程 ----
    //      2026-11-07 三修（attempt3 分诊）：清理链原为无界 await（close/killProcess 均
    //      可能挂死），是 Gate A 连续三轮挂点右移的终站（ready 轮询 → newPage → 清理链），
    //      有界化为 15s，超时继续走完收尾（close 挂死放弃等待；SIGTERM 宽限内未退
    //      SIGKILL 强杀）——测试门禁清理的资源释放有界化，非产品时间机制。
    if (browser) {
      await withTimeout(browser.close(), CLEANUP_TIMEOUT_MS, 'browser.close').catch(() => {})
    }
    await killProcess(child)
  }
}

/**
 * 轮询 url 直到双环回族之一返回响应（200/3xx/4xx 均算 ready，仅连接拒绝算未 ready）。
 * 若传入的 child 在轮询期间退出，立即判定失败（spawn 的 server 没活着，
 * 避免连到端口上可能已存在的别的 server）。无超时上限（时间机制删除裁决）。
 * 返回 reachableUrl = 判定可达的显式环回地址（127.0.0.1 或 [::1]），后续 chromium
 * goto 必须用同一地址——localhost 经 DNS 序解析，vite 可能只绑其中一个族。
 * @returns {Promise<{ok: true, ms: number, reachableUrl: string} | {ok: false, reason: 'child-exited'}>}
 */
async function resolveReachableUrl(url, child) {
  const parsed = new URL(url)
  const candidates = [
    new URL('/', `http://127.0.0.1:${parsed.port}${parsed.pathname === '/' ? '' : parsed.pathname}`).href,
    new URL('/', `http://[::1]:${parsed.port}${parsed.pathname === '/' ? '' : parsed.pathname}`).href,
  ]
  const start = Date.now()
  let round = 0
  for (;;) {
    if (child && child.exitCode !== null) {
      return { ok: false, reason: 'child-exited' }
    }
    round += 1
    // 每轮进度诊断（Gate A 教训：ready 前零输出，挂死期无从归因）
    if (round % 10 === 1) {
      process.stderr.write(`[dev-smoke] ready 轮询第 ${round} 轮（${Math.round((Date.now() - start) / 1000)}s）：试 ${candidates.join(' , ')}\n`)
    }
    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate, { method: 'GET' })
        if (res.status < 500) {
          process.stderr.write(`[dev-smoke] ready 经 ${candidate}（${Math.round((Date.now() - start) / 1000)}s，${res.status}）\n`)
          return { ok: true, ms: Date.now() - start, reachableUrl: candidate }
        }
      } catch {
        // ECONNREFUSED / socket hang up → 还没 ready（或该族不可达），继续
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * 发 SIGTERM 等子进程退出（宽限 15s 有界），未退 SIGKILL 强杀收尾。已退出则 no-op。
 * 2026-11-07 三修（attempt3 分诊）：原「无宽限上限」使清理链成为 Gate A 挂点右移的
 * 终站（exit 事件等待无界）——对象是自己 spawn 的子进程（PID 在手），强杀属测试门禁
 * 资源释放收尾，非产品时间机制。
 */
async function killProcess(child) {
  if (!child) return
  if (child.exitCode !== null || child.signalCode) return
  const exitPromise = new Promise((resolve) => {
    child.once('exit', () => resolve(true))
  })
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  try {
    await withTimeout(exitPromise, KILL_GRACE_MS, 'child exit after SIGTERM')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // 进程已自行退出，忽略
    }
    await Promise.race([exitPromise, sleep(KILL_GRACE_MS)])
  }
}

/**
 * @param {Object} p
 * @returns {SmokeResult}
 */
function makeResult({ exitCode, stderrErrors, consoleErrors, pageErrors, missingMounts, readyMs, detail }) {
  return {
    ok: exitCode === 0,
    exitCode,
    stderrErrors,
    consoleErrors,
    pageErrors,
    missingMounts,
    readyMs,
    ...(detail ? { detail } : {}),
  }
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  /** @type {SmokeOptions} */
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--port' && next) {
      opts.port = Number(next)
      i++
    } else if (a === '-h' || a === '--help') {
      printHelp()
      process.exit(0)
    }
  }
  return opts
}

function printHelp() {
  console.log(`dev-smoke — dev 启动期冒烟门禁

用法:
  node scripts/dev-smoke.mjs [options]
  pnpm dev:smoke

选项:
  --port <n>             vite dev server 端口（默认 1420）
  -h, --help             显示帮助

退出码:
  0  ok
  1  有 error（编译/console/pageerror/挂载点缺失 或 goto 失败）
  2  dev server 提前退出
  3  chromium launch 失败 或 newPage 失败`)
}

function printSummary(result) {
  const okMark = result.ok ? '✓' : '✗'
  console.log(`\n${'='.repeat(60)}`)
  console.log(`${okMark} dev-smoke 结果: exitCode=${result.exitCode} ok=${result.ok}`)
  console.log(`  ready: ${result.readyMs}ms`)
  console.log(`  stderrErrors(vite编译): ${result.stderrErrors.length}`)
  console.log(`  consoleErrors(过滤后): ${result.consoleErrors.length}`)
  console.log(`  pageErrors(未捕获): ${result.pageErrors.length}`)
  console.log(`  missingMounts: ${result.missingMounts.length} ${result.missingMounts.length ? JSON.stringify(result.missingMounts) : ''}`)
  if (result.detail) {
    console.log(`  detail:\n${result.detail}`)
  }
  if (result.stderrErrors.length) {
    console.log(`  --- stderrErrors ---`)
    for (const e of result.stderrErrors) console.log(`  ${e}`)
  }
  if (result.consoleErrors.length) {
    console.log(`  --- consoleErrors ---`)
    for (const e of result.consoleErrors) console.log(`  ${e}`)
  }
  if (result.pageErrors.length) {
    console.log(`  --- pageErrors ---`)
    for (const e of result.pageErrors) console.log(`  ${e}`)
  }
  console.log(`${'='.repeat(60)}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const result = await runSmoke(opts)
  printSummary(result)
  process.exit(result.exitCode)
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  main()
}
