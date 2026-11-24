#!/usr/bin/env node
/**
 * 批5 干净 CPU 采集探针：**单次运行内**采齐 renderer + runtime + pi 三进程 profile。
 *
 * 针对 GLM 对抗审查 A7/A8/M8/S7 的修复：
 *   - 三进程来自同一次运行、同一 send 锚点（首轮是 4 次运行拼盘）；
 *   - renderer = production 模式 bundle（探针不管构建，只校验 bundle 在场与形态）；
 *   - runtime 经 SIGUSR1 激活 inspector（零 env 污染；首轮的 NODE_OPTIONS=--cpu-prof 会
 *     连带插桩全部 Node 子进程）；
 *   - pi 经 mock-pi 置换（Bun SEA 不可 inspect，首轮已实证）——窗口化 CDP Profiler，
 *     无 stdin EOF 定时器；
 *   - renderer 同开 Performance.enable，窗内每秒 getMetrics 快照（交叉验证 (program)）；
 *   - 环境声明落盘（load / 端口归属 / 并存 Electron 分类 / 打包版瞬时 CPU / HEAD / md5）。
 *
 * 拒绝纪律（本探针的第一公民）：
 *   - load 1m > 15                        → exit 3（安静窗才采，题面纪律）
 *   - HEAD 与 --expect-head 不符           → exit 3（防 checkout 舞蹈后测错代码）
 *   - 并存 Electron 超出白名单             → exit 3（白名单 = 被测 dev 实例 + 打包版宿主 L1）
 *   - inspector 端口被占 / 目标不出现       → exit 3
 *   - 流式未在显式预算内完成 / 窗内无活动   → exit 3（绝不空数据 PASS）
 *   - pi 二进制三核对恢复失败               → exit 4（响亮的失败，不静默留置换位）
 *
 * 用法：node probes/perf-clean-cpu.mjs --data-dir <dir> --cdp-port <p>
 *         [--fixture <json>] [--tag <t>] [--model <provider/id>] [--window-ms <n>]
 *         [--expect-head <sha>] [--save-dir <dir>] [--runtime-inspect-port 9229]
 *         [--pi-inspect-port 9231] [--prompt <text>] [--verify-pi-only]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  parseFlags, sleep, connectRuntime, connectRendererCdp,
  waitForSessionComplete, windowStats, readLoadAvg, instantCpuOf,
  connectNodeInspector, startProfiler, stopProfiler, ensureGuiOnSessionViaLabel
} from './lib/harness.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const flags = parseFlags()
const arg = (n, d) => flags[n] ?? d

const dataDir = path.resolve(arg('data-dir', ''))
const cdpPort = Number(arg('cdp-port', '9478'))
const fixture = arg('fixture', '')
const tag = arg('tag', 'run')
const modelOverride = arg('model', '')
const windowMs = Number(arg('window-ms', '120000'))
const expectHead = arg('expect-head', '')
const saveDir = arg('save-dir', '')
const runtimeInspectPort = Number(arg('runtime-inspect-port', '9229'))
// pi inspector 端口由内核分配（--inspect=0）：launcher 把实际端口写进端口文件，探针读它。
// 固定端口不可用——runtime 会把 pi 留住（session 存活期），第二次采集会撞上一次的 pi。
const piInspectFile = arg('pi-inspect-file', '/tmp/b5-pi-inspect.json')
const prompt = arg('text', '请给出性能优化实施方案')
// 期望的 message.complete 条数。**口径**：message.complete 是 per-turn（整条 agent 循环
// 走完一次），不是 per-assistant-message——工具轮 fixture 的 5 轮 toolUse + 1 轮收尾仍只产
// 1 条 message.complete（实测：6 条 complete 的预期会让探针白等满预算并采到整段空闲）。
// 多轮的工具轮数由 session JSONL 事后对账（见 final-summary 的形态节），探针只守终态。
const expectCompletes = Number(arg('expect-completes', '1'))

if (!dataDir) {
  console.error('usage: node probes/perf-clean-cpu.mjs --data-dir <dir> --cdp-port <p> [--fixture <json>] [--tag <t>] [--window-ms <n>] [--expect-head <sha>] [--save-dir <dir>]')
  process.exit(2)
}

const PI_BIN = path.join(REPO_ROOT, 'apps', 'electron', 'resources', 'pi', `pi-${process.platform}-${process.arch}`)
const PI_BAK = `${PI_BIN}.b5-bak`
const LAUNCHER = path.join(REPO_ROOT, 'probes', 'pi-profile-launcher.mjs')
const RENDERER_DIST = path.join(REPO_ROOT, 'apps', 'electron', 'renderer', 'dist')

const md5 = (file) => {
  const buf = fs.readFileSync(file)
  return crypto.createHash('md5').update(buf).digest('hex')
}

// ── pi 置换位三核对（P1 case；也在探针首尾各跑一次）──────────────────────────
function verifyPiRestore () {
  const bakExists = fs.existsSync(PI_BAK)
  const binExists = fs.existsSync(PI_BIN)
  let macho = false
  if (binExists) {
    const r = spawnSync('file', ['-b', PI_BIN], { encoding: 'utf8', timeout: 10000 })
    macho = /Mach-O/.test(r.stdout ?? '')
  }
  const ok = !bakExists && binExists && macho
  console.log(`RESULT pi-restore ok=${ok} md5-match=${binExists ? md5(PI_BIN) : 'n/a'} backup-present=${bakExists} macho=${macho}`)
  return ok
}

if (flags['verify-pi-only']) {
  process.exit(verifyPiRestore() ? 0 : 4)
}

// ── 前置校验 ────────────────────────────────────────────────────────────────
const load = readLoadAvg()
if (!load || load.m1 > 15) {
  console.error(`[clean-cpu] 拒绝采集：load 1m=${load?.m1 ?? 'unknown'} > 15（安静窗才采；等外部测试跑完再跑本探针）`)
  process.exit(3)
}

if (expectHead) {
  const head = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  if (head !== expectHead) {
    console.error(`[clean-cpu] HEAD 不符：当前 ${head}，期望 ${expectHead}——工作区被 checkout 舞蹈留在错误 commit，拒绝采集`)
    process.exit(3)
  }
  console.log(`[clean-cpu] HEAD 断言通过：${head}`)
}

if (!fs.existsSync(RENDERER_DIST) || !fs.existsSync(path.join(RENDERER_DIST, 'index.html'))) {
  console.error(`[clean-cpu] 拒绝采集：renderer bundle 不在场（${RENDERER_DIST}）——先构建 production 模式产物（见 docs/tp-api-batch5.md）`)
  process.exit(3)
}
// 并存 Electron 分类：白名单 = 被测 dev 实例（.dev-electron）+ 打包版宿主（/Applications/TaiJi.app，L1）
const psAll = execSync('ps -eo pid,command', { encoding: 'utf8' })
const electronProcs = psAll.split('\n')
  .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
  .filter((m) => m && /Electron|TaiJi\.app|dev-electron/.test(m[2]))
  .map((m) => ({ pid: Number(m[1]), cmd: m[2] }))
// 白名单三形态：dev 二进制（.dev-electron/Taiji.app）、dev 启动器脚本（dev-electron.mjs）、
// 打包版宿主（/Applications/TaiJi.app，受限条件 L1）。其余任何 Electron/TaiJi 进程一律拒绝。
const isOwnDevInstance = (cmd) => cmd.includes('.dev-electron') || cmd.includes('dev-electron.mjs')
const foreign = electronProcs.filter((p) => !isOwnDevInstance(p.cmd) && !p.cmd.includes('/Applications/TaiJi.app'))
if (foreign.length > 0) {
  console.error(`[clean-cpu] 拒绝采集：发现白名单外 Electron 并存 ${foreign.length} 个（首轮混杂根因 M8）：\n` +
    foreign.map((p) => `  ${p.pid} ${p.cmd.slice(0, 140)}`).join('\n'))
  process.exit(3)
}
const packagedCpu = instantCpuOf(electronProcs.filter((p) => p.cmd.includes('/Applications/TaiJi.app')).map((p) => p.pid))
console.log(`[clean-cpu] 环境声明：Electron 进程 ${electronProcs.length} 个（dev 实例 + 打包版宿主 L1）；打包版瞬时 CPU：` +
  packagedCpu.map((p) => `${p.pid}=${p.cpuPct}%`).join(' ') || 'n/a')

const runtimePort = Number(fs.readFileSync(path.join(dataDir, 'runtime.port'), 'utf8').trim())
const rt = await connectRuntime(dataDir)
const cdp = await connectRendererCdp(cdpPort)
console.log(`[clean-cpu] connected runtime(port ${runtimePort}) + renderer CDP(port ${cdpPort}); load ${load.m1}/${load.m5}/${load.m15}`)

const listenOwners = (port) => spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 10000 }).stdout.trim()

// runtime 真身：端口占用者中 argv 含 runtime 入口者（tsx 父壳 ≠ 真身，首轮教训）
// 只看 LISTEN 者——本探针自己的 WS 客户端连接也会占该端口的 ESTABLISHED 记录，
// 裸 `lsof -ti :port` 会把自己的 pid 一并列出（曾在 CDP 归属校验里误判成「连错实例」）。
const portOwners = listenOwners(runtimePort).split('\n').filter(Boolean)
let runtimePid = 0
for (const pid of portOwners) {
  const cmd = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8', timeout: 10000 }).stdout.trim()
  if (cmd.includes('runtime/src/index.ts')) { runtimePid = Number(pid); console.log(`[clean-cpu] runtime pid=${runtimePid} (${cmd.slice(0, 120)})`); break }
}
if (!runtimePid) {
  console.error(`[clean-cpu] 拒绝采集：未在端口 ${runtimePort} 占用者中识别到 runtime 真身（pid 列表 ${portOwners.join(',')}）`)
  process.exit(3)
}

// inspector 端口占用检查（放在 runtime 身份识别之后）：
// runtime inspector 一经 SIGUSR1 激活会**常驻监听**直到进程退出——重复运行时该端口的占用者
// 就是同一个 runtime 本身，属正常形态（复用既有 inspector），不是「被外人占用」。
for (const port of [runtimeInspectPort]) {
  const owners = listenOwners(port).split('\n').filter(Boolean)
  if (owners.length === 0) continue
  const allowed = port === runtimeInspectPort && owners.length === 1 && Number(owners[0]) === runtimePid
  if (!allowed) {
    console.error(`[clean-cpu] 拒绝采集：inspector 端口 ${port} 被占用（pid ${owners.join(',')}）——换端口或先释放`)
    process.exit(3)
  }
  console.log(`[clean-cpu] inspector 端口 ${port} 已由 runtime 自身监听（上次运行激活的 inspector），复用`)
}

// CDP 归属校验（防连错实例）
const cdpListenPid = listenOwners(cdpPort).split('\n').filter(Boolean)[0] ?? ''
const cdpOwnerCmd = spawnSync('ps', ['-o', 'command=', '-p', cdpListenPid], { encoding: 'utf8', timeout: 10000 }).stdout.trim()
if (!cdpOwnerCmd.includes('.dev-electron')) {
  console.error(`[clean-cpu] 拒绝采集：CDP 端口 ${cdpPort} 归属不是本 worktree dev 实例（${cdpOwnerCmd.slice(0, 140)}）`)
  process.exit(3)
}

// fixture 落盘（pi 进程启动时读 TAIJI_FAUX_SCRIPT，必须在 session.create 之前）
let fixtureMd5 = ''
if (fixture) {
  const src = path.resolve(fixture)
  const dst = path.join(dataDir, 'agent', 'faux-responses.json')
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  fixtureMd5 = md5(dst)
  console.log(`[clean-cpu] fixture -> ${dst} (md5 ${fixtureMd5.slice(0, 12)}, ${fs.statSync(dst).size} bytes)`)
}

// 陈旧端口文件清理（上一次运行的 pi inspector 端口已随进程消失）
try { fs.rmSync(piInspectFile, { force: true }) } catch { /* 无文件即无需清理 */ }

// ── pi 置换 ─────────────────────────────────────────────────────────────────
if (fs.existsSync(PI_BAK)) {
  console.error(`[clean-cpu] 拒绝采集：置换备份 ${PI_BAK} 在场——上一次运行未恢复，先跑 --verify-pi-only 核对并手工恢复`)
  process.exit(3)
}
const piMd5Before = md5(PI_BIN)
fs.renameSync(PI_BIN, PI_BAK)
fs.copyFileSync(LAUNCHER, PI_BIN)
fs.chmodSync(PI_BIN, 0o755)
console.log(`[clean-cpu] pi 置换完成（原二进制 md5 ${piMd5Before.slice(0, 12)} → launcher）`)

let runtimeClient = null
let piClient = null
let sendWall = 0
let profilerStarts = {}
let metricsSamples = []
let metricsTimer = null
let sid = ''

try {
  // ① session（fixture 已落盘；pi 进程在此时被 runtime spawn，置换位生效）
  // label 必须**每次唯一**：GUI 在场校验按 panel-session-label 文本匹配，同名会话（上一次
  // 同 tag 的残留在侧栏里）会导致点错行 → 采到空闲 renderer（实测：nonIdle 掉到 1.3%）。
  const label = `b5-${tag}-${Date.now().toString(36)}`
  const created = await rt.call('session.create', { cwd: REPO_ROOT, ...(modelOverride ? { modelOverride } : {}), label }, 120000)
  sid = created.session?.id ?? ''
  if (!sid) throw new Error(`session.create 未返回 session id：${JSON.stringify(created).slice(0, 300)}`)
  console.log(`[clean-cpu] session ${sid} label=${label} (model ${created.session?.modelId ?? 'default'})`)

  // GUI 在场校验：三级事实判据（见 harness.ensureGuiOnSessionViaLabel 头注——本仓当前版本
  // 会话行无 data-session-id，面板锚点是 panel-session-label 文本）
  if (!(await ensureGuiOnSessionViaLabel(cdp, sid, label))) {
    throw new Error('GUI 未切到目标 session（拒绝采集：否则窗内是空闲 renderer，测量无效）')
  }

  // ② runtime inspector（SIGUSR1 → 默认 9229）
  process.kill(runtimePid, 'SIGUSR1')
  runtimeClient = await connectNodeInspector(runtimeInspectPort, 'runtime/src/index.ts')
  if (!runtimeClient) {
    throw new Error(`runtime inspector 未在 ${runtimeInspectPort} 出现（SIGUSR1 激活失败或端口不可用）`)
  }
  console.log(`[clean-cpu] runtime inspector ready (${runtimeClient.target.url})`)

  // ③ pi inspector（launcher 以 --inspect 起子进程）
  // pi inspector 端口来自 launcher 写的端口文件（内核分配）：等文件出现（异步 spawn）
  let piInsp = null
  for (let i = 0; i < 120; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(piInspectFile, 'utf8'))
      if (j?.port) { piInsp = j; break }
    } catch { /* 文件尚未写出 */ }
    await sleep(500)
  }
  if (!piInsp) throw new Error(`pi inspector 端口文件未出现：${piInspectFile}（mock-pi 置换 launcher 未按预期拉起？）`)
  console.log(`[clean-cpu] pi inspector port from ${piInspectFile}: ${piInsp.host}:${piInsp.port} (pid ${piInsp.pid})`)
  piClient = await connectNodeInspector(piInsp.port, 'cli.js', { timeoutMs: 60000 })
  if (!piClient) {
    throw new Error(`pi inspector 未在 ${piInsp.host}:${piInsp.port} 出现（launcher 报的端口不可连）`)
  }
  console.log(`[clean-cpu] pi inspector ready (${piClient.target.url})`)

  // ④ 三进程 profiler 同时启动（renderer 无 tracing）
  await cdp.send('Performance.enable')
  profilerStarts.renderer = await startProfiler(cdp)
  profilerStarts.runtime = await startProfiler(runtimeClient)
  profilerStarts.pi = await startProfiler(piClient)
  metricsTimer = setInterval(async () => {
    try {
      const m = await cdp.send('Performance.getMetrics')
      metricsSamples.push({ t: Date.now(), metrics: m.metrics })
    } catch { /* 采样失败不阻断采集 */ }
  }, 1000)
  console.log('[clean-cpu] three profilers started, sending prompt...')

  // 必须先 session.subscribe，否则收不到该 session 的 message.* 广播帧（此前靠
  // waitForSessionComplete 内部的 subscribe 隐式完成；改成游标扫 rt.events 后必须显式订阅）。
  await rt.call('session.subscribe', { sessionId: sid }, 30000)
  const clientUuid = crypto.randomUUID()
  await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
  sendWall = Date.now()
  console.log('[clean-cpu] prompt submitted, streaming window running...')

  // ⑤ 事件驱动收尾（禁固定窗；超时 = 调用方显式预算）
  // 用**游标**扫 rt.events 而不是反复调 waitForSessionComplete：后者每次进入都把 scanned
  // 重置为当前长度，两次调用之间到达的 complete 会被静默跳过（实测多轮 fixture 只数到 1/6，
  // 随后空等到 300s 预算到顶还误判「有测量」）。
  let completes = 0
  let done = null
  let cursor = rt.events.length
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    let progressed = false
    for (; cursor < rt.events.length; cursor++) {
      const f = rt.events[cursor]
      if (f.payload?.sessionId !== undefined && f.payload.sessionId !== sid) continue
      if (f.type === 'message.complete') { completes++; done = f; progressed = true }
      else if (f.type === 'message.error' || f.type === 'message.stream_error' || f.type === 'session.exited') { done = f; progressed = true }
    }
    if (done && (done.type !== 'message.complete' || completes >= expectCompletes)) break
    if (!progressed) await sleep(100)
  }
  clearInterval(metricsTimer)
  console.log(`[clean-cpu] message.complete count=${completes}/${expectCompletes}`)
  if (!done || completes < expectCompletes) {
    // 必须 throw（不用 process.exit）：exit 会跳过 finally 里的 pi 置换位恢复
    throw new Error(`流式未在 ${windowMs}ms 预算内完成（message.complete ${completes}/${expectCompletes}）——拒绝判定`)
  }
  console.log(`[clean-cpu] turn complete (${done.type}) after ${((Date.now() - sendWall) / 1000).toFixed(1)}s`)

  // ⑥ 停三个 profiler
  const rendererProfile = await stopProfiler(cdp)
  const runtimeProfile = await stopProfiler(runtimeClient)
  const piProfile = await stopProfiler(piClient)
  console.log(`[clean-cpu] profiles: renderer ${rendererProfile.samples.length} / runtime ${runtimeProfile.samples.length} / pi ${piProfile.samples.length} samples`)

  // ⑦ 有效性断言
  const relFrom = (sendWall - profilerStarts.renderer) / 1000
  const relTo = relFrom + (Date.now() - sendWall) / 1000
  const stats = windowStats(rendererProfile, relFrom, relTo)
  const sampledOk = stats.sampledS >= (relTo - relFrom) * 0.5
  const activeOk = stats.nonIdleRatio >= 0.02
  if (!sampledOk || !activeOk) {
    throw new Error(`测量无效：renderer sampled=${stats.sampledS.toFixed(1)}s（需 ≥${((relTo - relFrom) * 0.5).toFixed(1)}s）nonIdle=${(stats.nonIdleRatio * 100).toFixed(1)}%（需 ≥2%）`)
  }
  const runtimeWin = windowStats(runtimeProfile, (sendWall - profilerStarts.runtime) / 1000, (sendWall - profilerStarts.runtime) / 1000 + (Date.now() - sendWall) / 1000)
  const piWin = windowStats(piProfile, (sendWall - profilerStarts.pi) / 1000, (sendWall - profilerStarts.pi) / 1000 + (Date.now() - sendWall) / 1000)
  if (runtimeWin.sampledS <= 0 || piWin.sampledS <= 0) {
    throw new Error(`测量无效：runtime/pi 窗内无采样（${runtimeWin.sampledS.toFixed(2)}s / ${piWin.sampledS.toFixed(2)}s）`)
  }
  console.log(`[clean-cpu] valid: renderer sampled=${stats.sampledS.toFixed(1)}s nonIdle=${(stats.nonIdleRatio * 100).toFixed(1)}% | runtime nonIdle=${(runtimeWin.nonIdleRatio * 100).toFixed(1)}% | pi nonIdle=${(piWin.nonIdleRatio * 100).toFixed(1)}%`)

  // ⑧ 归档
  if (saveDir) {
    fs.mkdirSync(saveDir, { recursive: true })
    const dump = (name, p) => {
      const f = path.join(saveDir, `${tag}-${name}.cpuprofile`)
      fs.writeFileSync(f, JSON.stringify(p))
      return f
    }
    dump('renderer', rendererProfile)
    dump('runtime', runtimeProfile)
    dump('pi', piProfile)
    fs.writeFileSync(path.join(saveDir, `${tag}-metrics.json`), JSON.stringify({
      window: { relFromS: relFrom, relToS: relTo },
      samples: metricsSamples.map((s) => ({
        t: s.t,
        TaskDuration: s.metrics.find((m) => m.name === 'TaskDuration')?.value ?? null,
        ScriptDuration: s.metrics.find((m) => m.name === 'ScriptDuration')?.value ?? null,
        LayoutDuration: s.metrics.find((m) => m.name === 'LayoutDuration')?.value ?? null,
        RecalcStyleDuration: s.metrics.find((m) => m.name === 'RecalcStyleDuration')?.value ?? null,
        JSHeapUsedSize: s.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? null
      }))
    }, null, 1))
    const head = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    fs.writeFileSync(path.join(saveDir, `${tag}-env.json`), JSON.stringify({
      head, tag, fixture: fixture ? { path: fixture, md5: fixtureMd5 } : null,
      rendererBundle: { dir: RENDERER_DIST, indexMd5: md5(path.join(RENDERER_DIST, 'index.html')) },
      load, ports: { runtimePort, cdpPort, runtimeInspectPort, piInspectPort: piInsp?.port ?? null },
      pids: { runtimePid, sid },
      packagedApp: packagedCpu,
      electronProcCount: electronProcs.length,
      wall: { submitAt: sendWall, completeAt: Date.now(), streamS: (Date.now() - sendWall) / 1000 },
      rendererWindow: { relFromS: relFrom, relToS: relTo, sampledS: stats.sampledS, nonIdleRatio: stats.nonIdleRatio }
    }, null, 1))
    console.log(`[clean-cpu] archived -> ${saveDir}/${tag}-{renderer,runtime,pi}.cpuprofile + metrics/env json`)
  }

  console.log(`RESULT clean-cpu tag=${tag} profiles=3 completes=${completes}/${expectCompletes} renderer-sampled=${stats.sampledS.toFixed(1)}s renderer-nonidle=${(stats.nonIdleRatio * 100).toFixed(1)}% runtime-samples=${runtimeProfile.samples.length} pi-samples=${piProfile.samples.length} turn-count=1 load-1m=${load.m1}`)
} catch (err) {
  console.error(`[clean-cpu] 采集失败：${err.message}`)
  process.exitCode = 3
} finally {
  if (metricsTimer) clearInterval(metricsTimer)
  try { cdp.close() } catch {}
  try { runtimeClient?.close() } catch {}
  try { piClient?.close() } catch {}
  try { rt.ws.close() } catch {}
  // pi 二进制三核对恢复（无论成败）
  try {
    if (fs.existsSync(PI_BAK)) {
      fs.rmSync(PI_BIN, { force: true })
      fs.renameSync(PI_BAK, PI_BIN)
    }
  } catch (e) {
    console.error(`[clean-cpu] pi 恢复失败：${e.message}——手工执行 mv ${PI_BAK} ${PI_BIN}`)
    process.exit(4)
  }
  if (fs.existsSync(PI_BIN) && !fs.existsSync(PI_BAK)) {
    const after = md5(PI_BIN)
    if (after !== piMd5Before) {
      console.error(`[clean-cpu] pi md5 不符：恢复后 ${after.slice(0, 12)} ≠ 原 ${piMd5Before.slice(0, 12)}`)
      process.exit(4)
    }
    console.log(`[clean-cpu] pi 三核对恢复完成（md5 ${after.slice(0, 12)}）`)
  }
}
