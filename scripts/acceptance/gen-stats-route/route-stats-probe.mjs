#!/usr/bin/env node
/**
 * route-stats-probe — gen-stats × provider-aggregation（模型路由）实机验收探针。
 *
 * 用法：node scripts/acceptance/gen-stats-route/route-stats-probe.mjs --case <t1|b1|b2|b3>
 *
 * 真实进程层（零 token）：每个 case 自建 mkdtemp 数据目录（绝不触碰 ~/.taiji），spawn 真
 * runtime 子进程（tsx 直起，脱离 Electron main）+ 真 pi 子进程 + faux LLM 演员
 * （TAIJI_EXTENSION_PATHS 注入 e2e/fixtures/faux-provider-ext 壳），走真实 WS 协议
 * （auth → session.create → session.subscribe → message.send / session.getGenStats），
 * 断言 session.stats_update 帧与磁盘采样文件布局。串行执行，进程/目录退出前自清理。
 *
 * case 定义（acceptance.md 为唯一仲裁）：
 *   t1 路由会话（单成员）live 帧 current 三槽非 null + 帧 model = 虚拟 key + 磁盘零虚拟文件
 *   b1 路由窗口聚合并集：两成员各自预置当日样本 → getGenStats 窗口 = 并集分位/加权值
 *   b3 多成员只命中一端点：current 来自命中成员，窗口仍覆盖未命中成员（max 见证）
 *   b2 物理直连零回归：帧值/帧 model/磁盘文件布局与不经路由一致
 *
 * 退出码：0 = 该 case PASS（输出 VERDICT <case> PASS）；1 = FAIL（附差异明细）。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const AUX = path.join(REPO, 'e2e/fixtures')

// ── 断言工具 ────────────────────────────────────────────────────────────────────────

const failures = []
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`)
  else {
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    failures.push(label)
  }
}

// ── 数据目录种子（与旧会话证据探针同款；gen-stats 落盘布局复刻 store 公式）────────────────

/** safeModelFileName 同款公式（store:333）：raw 字符替换截断 64 + sha256 前 8 位 */
function safeModelFileName(provider, model) {
  const raw = `${provider}__${model}`
  const safeBase = raw.replace(/[/\\\s:]/g, '_').slice(0, 64)
  return `${safeBase}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`
}

function localDayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 预置某物理模型的当日样本（speed: [output, durationMs] / cache: [read, promptTotal] / ttft: [ms]） */
function seedDayFile(dataDir, family, provider, model, { speed, cache, ttft }) {
  const dir = path.join(dataDir, 'gen-stats', family)
  fs.mkdirSync(dir, { recursive: true })
  const day = localDayKey()
  const records = {}
  if (speed) records[day] = speed
  if (cache) records[day] = cache
  if (ttft) records[day] = ttft
  fs.writeFileSync(path.join(dir, `${safeModelFileName(provider, model)}.json`), JSON.stringify(records))
}

function listGenStatsFiles(dataDir, family) {
  const dir = path.join(dataDir, 'gen-stats', family)
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

// ── case 定义 ─────

/** 两成员路由（b1/b3 共用：并集口径的预置样本与路由定义逐字相同，提取单点防漂移） */
const ROUTE_B = { id: 'route-b', name: 'Route B', modelId: 'route-b', enabled: true, mode: 'simple', members: [{ id: 'm1', providerId: 'faux', modelId: 'faux-1', type: 'none' }, { id: 'm2', providerId: 'faux', modelId: 'faux-1-b', type: 'none' }], specials: [] }
const SEED_AB = [
  { provider: 'faux', model: 'faux-1', speed: [[100, 2000], [200, 2000]], cache: [[300, 900]], ttft: [[100]] },
  { provider: 'faux', model: 'faux-1-b', speed: [[300, 2000], [400, 2000]], cache: [[900, 900]], ttft: [[400]] },
]

const CASES = {
  // 路由会话（单成员）：live 帧 current 三槽非 null、帧 model = 虚拟 key、磁盘零虚拟文件
  t1: {
    routes: [{ id: 'route-a', name: 'Route A', modelId: 'route-a', enabled: true, mode: 'simple', members: [{ id: 'm1', providerId: 'faux', modelId: 'faux-1', type: 'none' }], specials: [] }],
    modelOverride: 'aggregation/route-a',
    prompt: true,
  },
  // 窗口聚合并集：两成员各自预置样本（不发 prompt，隔离 live 采样）→ getGenStats = 并集值
  b1: {
    routes: [ROUTE_B],
    modelOverride: 'aggregation/route-b',
    prompt: false,
    seed: SEED_AB,
  },
  // 多成员只命中一端点：预置两成员样本 + 发 prompt（路由命中其一）→ current 非 null，
  // 窗口仍覆盖未命中成员（day.max = 200 只有 faux-1-b 的种子能产出）
  b3: {
    routes: [ROUTE_B],
    modelOverride: 'aggregation/route-b',
    prompt: true,
    seed: SEED_AB,
  },
  // 物理直连零回归：不经路由 → current 非 null、帧 model = 物理 key、磁盘只该模型文件
  b2: {
    routes: [{ id: 'route-a', name: 'Route A', modelId: 'route-a', enabled: true, mode: 'simple', members: [{ id: 'm1', providerId: 'faux', modelId: 'faux-1', type: 'none' }], specials: [] }],
    modelOverride: 'faux/faux-1',
    prompt: true,
  },
}

// ── 期望值（并集口径，与 store 聚合公式同数学：逐样本 t/s 后取分布；cache 总量加权）─────────

/** 速度分布五量（复刻 summarizeDistribution：p50 偶数双中位均值 / p99 最近秩 / 全 round） */
function speedDistOf(samples) {
  const speeds = samples.map(([o, d]) => (o / d) * 1000).sort((a, b) => a - b)
  if (speeds.length === 0) return null
  const mid = Math.floor(speeds.length / 2)
  const median = speeds.length % 2 === 1 ? speeds[mid] : (speeds[mid - 1] + speeds[mid]) / 2
  const p99 = speeds[Math.max(0, Math.min(speeds.length - 1, Math.ceil(0.99 * speeds.length) - 1))]
  return {
    avg: Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length),
    p50: Math.round(median),
    p99: Math.round(p99),
    max: Math.round(speeds[speeds.length - 1]),
    min: Math.round(speeds[0]),
  }
}

function cacheRatioOf(records) {
  const read = records.reduce((a, r) => a + r[0], 0)
  const total = records.reduce((a, r) => a + r[1], 0)
  return total <= 0 ? null : Math.round((read / total) * 100)
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────────

const caseName = process.argv[2] === '--case' ? process.argv[3] : undefined
const spec = CASES[caseName]
if (!spec) {
  console.error(`用法: node route-stats-probe.mjs --case <${Object.keys(CASES).join('|')}>`)
  process.exit(2)
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-route-'))
const agentDir = path.join(dataDir, 'agent')
fs.mkdirSync(path.join(agentDir, 'config'), { recursive: true })
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
  defaultProvider: 'faux', defaultModel: 'faux-1',
  enabledModels: ['faux/faux-1', 'faux/faux-1-b'], retry: { enabled: false },
}))
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
  providers: {
    faux: {
      name: 'faux', api: 'faux', apiKey: 'x',
      models: [
        { id: 'faux-1', name: 'Faux 1', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384 },
        { id: 'faux-1-b', name: 'Faux 1 B', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384 },
      ],
    },
  },
}))
fs.writeFileSync(path.join(agentDir, 'config', 'providers.json'), JSON.stringify({
  version: 1, providers: {}, routes: { version: 1, routes: spec.routes },
}))
for (const s of spec.seed ?? []) seedDayFile(dataDir, 'speed', s.provider, s.model, { speed: s.speed })
for (const s of spec.seed ?? []) seedDayFile(dataDir, 'cache-ratio', s.provider, s.model, { cache: s.cache })
for (const s of spec.seed ?? []) seedDayFile(dataDir, 'ttft', s.provider, s.model, { ttft: s.ttft })

const script = path.join(agentDir, 'faux-responses.json')
fs.writeFileSync(script, JSON.stringify([{ text: 'hello '.repeat(40) }, { text: 'second '.repeat(40) }]))

const port = 3400 + Math.floor(Math.random() * 100)
const env = {
  ...process.env,
  TAIJI_AGENT_DATA_DIR: dataDir,
  TAIJI_RUNTIME_TOKEN: 'probe-token',
  TAIJI_FAUX_SCRIPT: script,
  TAIJI_FAUX_TPS: '25',
  TAIJI_EXTENSION_PATHS: path.join(AUX, 'faux-provider-ext'),
}
delete env.ELECTRON_RUN_AS_NODE
delete env.TAIJI_AGENT_PACKAGED // 对称 validate-runtime-bundle.sh：防宿主泄漏打包标记（data-governance N-1）
const child = spawn('node', [
  path.join(REPO, 'node_modules/tsx/dist/cli.mjs'),
  'packages/runtime/src/index.ts',
  '--port', String(port),
  '--project-root', path.join(REPO, 'apps/electron'),
], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', (d) => { log += d })
child.stderr.on('data', (d) => { log += d })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wsConnect() {
  for (let i = 0; i < 100; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
      return ws
    } catch { await sleep(300) }
  }
  throw new Error('ws connect timeout')
}

async function waitFrame(frames, pred, ms = 120000) {
  const step = 500
  for (let waited = 0; waited < ms; waited += step) {
    const hit = frames.find(pred)
    if (hit) return hit
    await sleep(step)
  }
  return null
}

let exitCode = 1
try {
  const ws = await wsConnect()
  const frames = []
  ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString())) })
  ws.send(JSON.stringify({ type: 'auth', payload: { token: 'probe-token' } }))
  await waitFrame(frames, (f) => f.type === 'auth.result', 15000)
  check('auth.ok', frames.find((f) => f.type === 'auth.result')?.payload?.ok === true)

  ws.send(JSON.stringify({
    type: 'session.create', id: 'c1',
    payload: { cwd: path.join(AUX, 'sample-project'), label: `gs-route-${caseName}`, modelOverride: spec.modelOverride },
  }))
  const created = await waitFrame(frames, (f) => f.id === 'c1', 120000)
  const sid = created?.payload?.session?.id
  check('session.created', typeof sid === 'string' && sid.length > 0, JSON.stringify(created?.payload ?? created?.type ?? 'NO REPLY').slice(0, 300))
  if (typeof sid !== 'string') throw new Error('no session id')

  ws.send(JSON.stringify({ type: 'session.subscribe', id: 'sub1', payload: { sessionId: sid } }))
  await sleep(1000)

  if (spec.prompt) {
    // 协议字段 = content（protocol.ts:1271 message.send SSOT）；误用 text 会被 handler 静默
    // 丢弃、字面量 "undefined" 成为真正 prompt——transcript 断言（下方）把该漂移变可见
    ws.send(JSON.stringify({ type: 'message.send', id: 'm1', payload: { sessionId: sid, content: 'hi' } }))
    await waitFrame(frames, (f) => f.id === 'm1' || f.type === 'message.complete', 90000)
    await sleep(4000)
    // transcript 断言：用户消息文本确为 'hi'（防协议字段漂移被 faux 演员掩盖——prune F2）
    // user message content = Segment[]（badge 载体）或 string——取 text 段拼平后比对
    ws.send(JSON.stringify({ type: 'session.history', id: 'h1', payload: { sessionId: sid } }))
    const hist = await waitFrame(frames, (f) => f.id === 'h1', 30000)
    const userTexts = (hist?.payload?.messages ?? [])
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string'
        ? m.content
        : m.content.filter((s) => s.type === 'text').map((s) => s.text).join('')))
    check(`${caseName}: transcript 用户消息 = 'hi'（message.send 契约字段 content 生效）`, userTexts.includes('hi'), JSON.stringify(userTexts).slice(0, 200))
  }

  const stats = frames.filter((f) => f.type === 'session.stats_update')
  const last = stats.at(-1)?.payload
  console.log(`CASE ${caseName}: live frames = ${stats.length}`)
  if (last) console.log('LIVE LAST:', JSON.stringify(last))

  if (caseName === 't1' || caseName === 'b3') {
    check(`${caseName}: live frame exists`, stats.length >= 1)
    if (last) {
      check(`${caseName}: frame.model = ${spec.modelOverride}`, last.model === spec.modelOverride, `got ${last.model}`)
      check(`${caseName}: speed.current non-null`, last.speed?.current != null, `got ${last.speed?.current}`)
      check(`${caseName}: cacheRatio.current non-null`, last.cacheRatio?.current != null, `got ${last.cacheRatio?.current}`)
      check(`${caseName}: ttft.current non-null`, last.ttft?.current != null, `got ${last.ttft?.current}`)
    }
  }
  if (caseName === 'b2') {
    check('b2: live frame exists', stats.length >= 1)
    if (last) {
      check('b2: frame.model = faux/faux-1', last.model === 'faux/faux-1', `got ${last.model}`)
      check('b2: speed.current non-null', last.speed?.current != null, `got ${last.speed?.current}`)
    }
    const speedFiles = listGenStatsFiles(dataDir, 'speed')
    check('b2: 磁盘 speed 目录只 1 个物理模型文件（无虚拟/无旁路文件）', speedFiles.length === 1, speedFiles.join(' | '))
    check('b2: 磁盘文件名为 faux__faux-1-*', speedFiles.length === 1 && speedFiles[0].startsWith('faux__faux-1-'), speedFiles.join(' | '))
  }

  ws.send(JSON.stringify({ type: 'session.getGenStats', id: 'g1', payload: { sessionId: sid } }))
  const g = await waitFrame(frames, (f) => f.id === 'g1', 30000)
  const snap = g?.payload
  console.log('GETGENSTATS:', JSON.stringify(snap))

  if (caseName === 't1') {
    check('t1: 快照帧 model = aggregation/route-a', snap?.model === 'aggregation/route-a', `got ${snap?.model}`)
    const speedFiles = listGenStatsFiles(dataDir, 'speed')
    const cacheFiles = listGenStatsFiles(dataDir, 'cache-ratio')
    check('t1: 磁盘 speed 目录零 aggregation__* 文件', speedFiles.every((f) => !f.startsWith('aggregation__')), speedFiles.join(' | '))
    check('t1: 磁盘 cache-ratio 目录零 aggregation__* 文件', cacheFiles.every((f) => !f.startsWith('aggregation__')), cacheFiles.join(' | '))
    check('t1: 磁盘 speed 目录落物理 faux__faux-1-* 文件', speedFiles.some((f) => f.startsWith('faux__faux-1-')), speedFiles.join(' | '))
  }

  if (caseName === 'b1') {
    // 并集口径：speed [50,100] ∪ [150,200] = [50,100,150,200]；cache (300+900)/(900+900)；ttft [100] ∪ [400]
    const expSpeed = speedDistOf([[100, 2000], [200, 2000], [300, 2000], [400, 2000]])
    check('b1: speed.day 五量 = 成员并集分布', JSON.stringify(snap?.speed?.day) === JSON.stringify(expSpeed), `got ${JSON.stringify(snap?.speed?.day)} want ${JSON.stringify(expSpeed)}`)
    check('b1: cacheRatio.day = 并集加权 67', snap?.cacheRatio?.day === 67, `got ${snap?.cacheRatio?.day}`)
    const expTtftP50 = Math.round((100 + 400) / 2)
    check(`b1: ttft.day.p50 = 并集中位 ${expTtftP50}`, snap?.ttft?.day?.p50 === expTtftP50, `got ${snap?.ttft?.day?.p50}`)
    check('b1: current 三槽为 null（本会话无样本，无回落纪律）', snap?.speed?.current == null && snap?.cacheRatio?.current == null && snap?.ttft?.current == null, JSON.stringify({ s: snap?.speed?.current, c: snap?.cacheRatio?.current, t: snap?.ttft?.current }))
  }

  if (caseName === 'b3') {
    // 未命中成员（faux-1-b，含 200 t/s / ttft 400ms 种子）必须仍进窗口：day.max 见证；
    // 单成员窗口（faux-1 only：≤100 + live≈25）max 至多 100，证并集生效。
    // 注意不断言 cacheRatio.day 下界：live 样本 cacheRead=0 且 promptTotal 巨大，加权值被
    // 稀释（2%）是真实口径而非缺陷——并集覆盖由 speed/ttft 的 max 双见证。
    check('b3: day.max = 200（未命中成员的种子在窗口内）', snap?.speed?.day?.max === 200, `got ${snap?.speed?.day?.max}`)
    check('b3: ttft.day.max = 400（未命中成员的 ttft 种子在窗口内）', snap?.ttft?.day?.max === 400, `got ${snap?.ttft?.day?.max}`)
    check('b3: day.min ≤ 50（命中成员低端种子在窗口内）', snap?.speed?.day?.min <= 50, `got ${snap?.speed?.day?.min}`)
    check('b3: cacheRatio.day 非 null（两成员 cache 记录均在并集内）', snap?.cacheRatio?.day != null, `got ${snap?.cacheRatio?.day}`)
  }

  exitCode = failures.length === 0 ? 0 : 1
} catch (err) {
  console.error('PROBE ERROR:', err instanceof Error ? err.message : String(err))
  exitCode = 1
} finally {
  console.log(`VERDICT ${caseName} ${exitCode === 0 ? 'PASS' : 'FAIL'}`)
  console.log('LOG HINTS:\n' + log.split('\n').filter((l) => /error|not found|route|stats/i.test(l)).slice(-10).join('\n'))
  child.kill('SIGTERM')
  await sleep(800)
  try { child.kill('SIGKILL') } catch { /* already dead */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* best effort */ }
  process.exit(exitCode)
}
