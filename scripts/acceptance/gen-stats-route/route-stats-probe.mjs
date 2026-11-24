#!/usr/bin/env node
/**
 * route-stats-probe.mjs — composer 生成指标「模型路由（aggregation 虚拟模型）」实机验收探针
 *
 * 真进程层（case 集 T1 路由 live 帧出数 / B1 多成员窗口并集 / B2 物理直连零回归 /
 * B3 未命中成员仍入窗口——登记于 docs/testing/e2e-map.json E2E-GENSTATS-01；pi 行为
 * 语义锚 PS-100/PS-101，docs/pi-semantics.json）：
 * 每条 case 独立 mkdtemp 数据目录 + 独立真 runtime 子进程（tsx 直起）+ 真 pi 子进程 +
 * faux LLM 演员（凭证无关零 token），走真实 WS 协议断言 `session.stats_update` 帧、
 * `session.getGenStats` reply 与磁盘采样文件。
 *
 * 数据目录红线：每次自建 `mkdtemp`，收尾自删；绝不触碰 `~/.taiji` / `~/.taiji-dev`。
 * 期望值计算不复制公式：直接 import gen-stats-store 的聚合/路径纯函数（本探针经 tsx 运行）。
 *
 * 用法：
 *   node_modules/.bin/tsx scripts/acceptance/gen-stats-route/route-stats-probe.mjs --case t1
 *   （--case b1 | b2 | b3；缺省 t1）
 *
 * 输出末行：`VERDICT <case> PASS` / `VERDICT <case> FAIL`（exit 0 / 1）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import {
  aggregateCacheRatio,
  aggregateSpeedDistribution,
  aggregateTtftDistribution,
  cacheRatioFilePath,
  localDayKey,
  readDayRecords,
  speedFilePath,
  ttftFilePath,
  writeDayRecords,
} from '../../../packages/runtime/src/services/session/gen-stats-store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')

const argCase = (() => {
  const i = process.argv.indexOf('--case')
  const value = i >= 0 ? process.argv[i + 1] : undefined
  return value ?? 't1'
})()

/** case 定义：路由配置 + 会话模型 + 预置样本（预置在 runtime 启动前落盘，模拟历史样本） */
const CASES = {
  t1: {
    // 单成员路由：live 帧 current 非 null + 帧 model = 虚拟 key + 磁盘仍只落物理文件
    modelOverride: 'aggregation/route-a',
    routes: [route('route-a', [['faux', 'faux-1']])],
    preset: [],
  },
  b1: {
    // 两成员路由：预置两成员各自的当日样本 → 窗口聚合 = 并集分位/加权（≠ 命中成员单文件）
    modelOverride: 'aggregation/route-dual',
    routes: [route('route-dual', [['faux', 'faux-1'], ['faux', 'faux-1-b']])],
    preset: [
      { family: 'speed', provider: 'faux', model: 'faux-1', entries: [[10, 10_000]] }, // 1 t/s
      { family: 'speed', provider: 'faux', model: 'faux-1-b', entries: [[900, 3_000]] }, // 300 t/s
      { family: 'cache', provider: 'faux', model: 'faux-1', entries: [[0, 1_000]] }, // 0%
      { family: 'cache', provider: 'faux', model: 'faux-1-b', entries: [[900, 1_000]] }, // 90%
      { family: 'ttft', provider: 'faux', model: 'faux-1', entries: [[5]] },
      { family: 'ttft', provider: 'faux', model: 'faux-1-b', entries: [[1200]] },
    ],
  },
  b2: {
    // 物理模型直连（不经路由）：零回归基线
    modelOverride: 'faux/faux-1',
    routes: [route('route-a', [['faux', 'faux-1']])],
    preset: [],
  },
  b3: {
    // 多成员路由只命中一个端点：current 来自命中成员，窗口聚合仍覆盖未命中成员
    modelOverride: 'aggregation/route-dual',
    routes: [route('route-dual', [['faux', 'faux-1'], ['faux', 'faux-1-b']])],
    preset: [
      { family: 'speed', provider: 'faux', model: 'faux-1-b', entries: [[600, 2_000]] }, // 300 t/s
      { family: 'cache', provider: 'faux', model: 'faux-1-b', entries: [[800, 1_000]] }, // 80%
      { family: 'ttft', provider: 'faux', model: 'faux-1-b', entries: [[1500]] },
    ],
  },
}

const spec = CASES[argCase]
if (spec === undefined) {
  console.error(`未知 case: ${argCase}（支持 ${Object.keys(CASES).join(' / ')}）`)
  process.exit(2)
}

/** 路由 fixture（只填本探针消费字段） */
function route(id, members) {
  return {
    id,
    name: id,
    modelId: id,
    enabled: true,
    mode: 'simple',
    members: members.map(([providerId, modelId], index) => ({
      id: `m${index}`,
      providerId,
      modelId,
      type: 'none',
    })),
    specials: [],
  }
}

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    failures.push(label)
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'gs-acceptance-'))
// 本探针进程内的 store 纯函数（路径/聚合）读同一 dataDir
process.env.TAIJI_AGENT_DATA_DIR = dataDir

const agentDir = join(dataDir, 'agent')
mkdirSync(join(agentDir, 'config'), { recursive: true })
writeFileSync(
  join(agentDir, 'settings.json'),
  JSON.stringify({
    defaultProvider: 'faux',
    defaultModel: 'faux-1',
    enabledModels: ['faux/faux-1', 'faux/faux-1-b', 'faux/faux-1-reasoning', ...spec.routes.map((r) => `aggregation/${r.id}`)],
    retry: { enabled: false },
  }),
)
writeFileSync(
  join(agentDir, 'models.json'),
  JSON.stringify({
    providers: {
      faux: {
        name: 'faux',
        api: 'faux',
        apiKey: 'x',
        models: [
          { id: 'faux-1', name: 'Faux 1', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384 },
          { id: 'faux-1-b', name: 'Faux 1 B', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384 },
        ],
      },
    },
  }),
)
writeFileSync(
  join(agentDir, 'config', 'providers.json'),
  JSON.stringify({ version: 1, providers: {}, routes: { version: 1, routes: spec.routes } }),
)

const fauxScript = join(agentDir, 'faux-responses.json')
writeFileSync(fauxScript, JSON.stringify([{ text: 'hello world '.repeat(20) }, { text: 'second '.repeat(20) }]))

const today = localDayKey()
for (const item of spec.preset) {
  const filePath =
    item.family === 'speed'
      ? speedFilePath(item.provider, item.model)
      : item.family === 'cache'
        ? cacheRatioFilePath(item.provider, item.model)
        : ttftFilePath(item.provider, item.model)
  writeDayRecords(filePath, { [today]: item.entries })
}

const port = 3500 + Math.floor(Math.random() * 400)
const child = spawn(
  process.execPath,
  [
    join(REPO, 'node_modules/tsx/dist/cli.mjs'),
    'packages/runtime/src/index.ts',
    '--port',
    String(port),
    '--project-root',
    join(REPO, 'apps/electron'),
  ],
  {
    cwd: REPO,
    env: {
      ...process.env,
      TAIJI_AGENT_DATA_DIR: dataDir,
      TAIJI_RUNTIME_TOKEN: 'probe-token',
      TAIJI_FAUX_SCRIPT: fauxScript,
      TAIJI_FAUX_TPS: '25',
      TAIJI_EXTENSION_PATHS: join(REPO, 'e2e/fixtures/faux-provider-ext'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)

let runtimeLog = ''
child.stdout.on('data', (d) => {
  runtimeLog += String(d)
})
child.stderr.on('data', (d) => {
  runtimeLog += String(d)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      await new Promise((res, rej) => {
        ws.once('open', res)
        ws.once('error', rej)
      })
      return ws
    } catch {
      await sleep(300)
    }
  }
  throw new Error(`WS 连接超时（port ${port}）`)
}

async function waitFor(predicate, ms) {
  const step = 250
  for (let waited = 0; waited < ms; waited += step) {
    const hit = predicate()
    if (hit !== undefined && hit !== false) return hit
    await sleep(step)
  }
  return undefined
}

/** 归档清理：无论成败都杀子进程 + 删临时数据目录 */
function cleanup() {
  try {
    child.kill('SIGTERM')
  } catch {
    /* 已退出 */
  }
}

try {
  console.log(`[case ${argCase}] dataDir=${dataDir} modelOverride=${spec.modelOverride}`)
  const ws = await connect()
  const frames = []
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(String(raw)))
    } catch {
      /* 非 JSON 帧忽略 */
    }
  })

  ws.send(JSON.stringify({ type: 'auth', payload: { token: 'probe-token' } }))
  const auth = await waitFor(() => frames.find((f) => f.type === 'auth.result'), 15_000)
  if (auth === undefined) throw new Error('auth.result 未到达')

  ws.send(
    JSON.stringify({
      type: 'session.create',
      id: 'c1',
      payload: { cwd: join(REPO, 'e2e/fixtures/sample-project'), label: `gs-${argCase}`, modelOverride: spec.modelOverride },
    }),
  )
  const created = await waitFor(() => frames.find((f) => f.id === 'c1'), 180_000)
  if (created === undefined) throw new Error('session.create 无 reply')
  const sid = created.payload?.session?.id
  if (sid === undefined) throw new Error(`session.create reply 无 session.id: ${JSON.stringify(created.payload).slice(0, 300)}`)

  ws.send(JSON.stringify({ type: 'session.subscribe', id: 's1', payload: { sessionId: sid } }))
  await sleep(800)
  ws.send(JSON.stringify({ type: 'message.send', id: 'm1', payload: { sessionId: sid, text: 'hi' } }))
  const sent = await waitFor(
    () => frames.find((f) => f.id === 'm1') ?? frames.find((f) => f.type === 'message.complete'),
    180_000,
  )
  if (sent === undefined) throw new Error('message.send / message.complete 未到达')

  // live 帧：等采样广播（每个 turn 数帧，最多等 20s 收集）
  const liveFrames = await waitFor(
    () => {
      const hits = frames.filter((f) => f.type === 'session.stats_update')
      return hits.length > 0 ? hits : undefined
    },
    20_000,
  )
  const liveStats = liveFrames ?? []

  ws.send(JSON.stringify({ type: 'session.getGenStats', id: 'g1', payload: { sessionId: sid } }))
  const genReply = await waitFor(() => frames.find((f) => f.id === 'g1'), 30_000)
  if (genReply === undefined) throw new Error('session.getGenStats 无 reply')
  const frame = genReply.payload

  ws.send(JSON.stringify({ type: 'session.getState', id: 'st1', payload: { sessionId: sid } }))
  const stateReply = await waitFor(() => frames.find((f) => f.id === 'st1'), 30_000)

  console.log(`  会话 sid=${sid} getState.modelId=${stateReply?.payload?.modelId}`)
  console.log(`  live stats 帧数=${liveStats.length}`)

  /** 期望值：按 case 的「聚合口径」从磁盘读取并集（B1/B3 = 路由全体成员；T1/B2 = 单模型） */
  const aggregateMembers =
    spec.modelOverride.startsWith('aggregation/')
      ? spec.routes.find((r) => `aggregation/${r.id}` === spec.modelOverride).members.map((m) => [m.providerId, m.modelId])
      : [spec.modelOverride.split('/')]

  const readDay = (filePath, tupleLen) => readDayRecords(filePath, tupleLen)[today] ?? []
  const unionSpeed = aggregateMembers.flatMap(([p, m]) => readDay(speedFilePath(p, m), 2))
  const unionCache = aggregateMembers.flatMap(([p, m]) => readDay(cacheRatioFilePath(p, m), 2))
  const unionTtft = aggregateMembers.flatMap(([p, m]) => readDay(ttftFilePath(p, m), 1))
  const expected = {
    speed: aggregateSpeedDistribution(unionSpeed),
    cache: aggregateCacheRatio(unionCache),
    ttft: aggregateTtftDistribution(unionTtft),
  }
  const distEq = (a, b) =>
    a.avg === b.avg && a.p50 === b.p50 && a.p99 === b.p99 && a.max === b.max && a.min === b.min

  // ── 通用断言（所有 case 共有：current 非 null + 窗口 = 磁盘并集口径 + 帧 model 归属）
  console.log('  -- live 帧（session.stats_update）')
  const lastLive = liveStats.at(-1)?.payload
  check('live 帧 ≥1 条', liveStats.length > 0, liveStats.length === 0 ? '修复前基线形态（路由会话 0 帧）' : '')
  if (lastLive !== undefined) {
    check('live 帧 speed.current 非 null', lastLive.speed?.current !== null && lastLive.speed?.current !== undefined)
    check('live 帧 ttft.current 非 null', lastLive.ttft?.current !== null && lastLive.ttft?.current !== undefined)
  }

  console.log('  -- getGenStats reply')
  check('speed.current 非 null', frame.speed?.current !== null && frame.speed?.current !== undefined, JSON.stringify(frame.speed?.current))
  check('ttft.current 非 null', frame.ttft?.current !== null && frame.ttft?.current !== undefined, JSON.stringify(frame.ttft?.current))
  check(
    'cacheRatio.current 非 null',
    frame.cacheRatio?.current !== null && frame.cacheRatio?.current !== undefined,
    JSON.stringify(frame.cacheRatio?.current),
  )
  check('speed.day = 并集分布', distEq(frame.speed.day, expected.speed), `实际 ${JSON.stringify(frame.speed.day)} 期望 ${JSON.stringify(expected.speed)}`)
  check(
    'cacheRatio.day = 并集加权',
    frame.cacheRatio?.day === expected.cache,
    `实际 ${JSON.stringify(frame.cacheRatio?.day)} 期望 ${JSON.stringify(expected.cache)}`,
  )
  check('ttft.day = 并集分布', distEq(frame.ttft.day, expected.ttft), `实际 ${JSON.stringify(frame.ttft.day)} 期望 ${JSON.stringify(expected.ttft)}`)
  check('帧 model = 会话权威模型', frame.model === spec.modelOverride, `实际 ${frame.model} 期望 ${spec.modelOverride}`)

  // ── case 专属断言
  if (argCase === 't1') {
    console.log('  -- t1：磁盘零格式变更')
    const speedDir = join(dataDir, 'gen-stats', 'speed')
    const names = readdirSync(speedDir)
    check('不出现 aggregation__*.json', !names.some((n) => n.startsWith('aggregation__')), names.join(','))
    check('物理模型文件在位', names.some((n) => n.startsWith('faux__faux-1-')), names.join(','))
  }

  if (argCase === 'b1') {
    console.log('  -- b1：并集与「仅命中成员」可区分')
    const hitOnly = aggregateSpeedDistribution(readDay(speedFilePath('faux', 'faux-1'), 2))
    check(
      '并集 ≠ 命中成员单文件（证明真的做了并集）',
      !distEq(expected.speed, hitOnly),
      `并集 ${JSON.stringify(expected.speed)} vs 单文件 ${JSON.stringify(hitOnly)}`,
    )
  }

  if (argCase === 'b3') {
    console.log('  -- b3：未命中成员的样本仍在窗口内')
    const missSpeed = readDay(speedFilePath('faux', 'faux-1-b'), 2)
    check('未命中成员有历史样本', missSpeed.length > 0)
    check(
      'speed.day.max ≥ 未命中成员样本速度（并集未收窄）',
      (frame.speed?.day?.max ?? -1) >= 300,
      `实际 max=${JSON.stringify(frame.speed?.day?.max)}`,
    )
  }

  ws.close()
} catch (err) {
  console.log(`  ✗ 探针执行异常: ${err instanceof Error ? err.message : String(err)}`)
  failures.push('probe-error')
  const hints = runtimeLog
    .split('\n')
    .filter((line) => /error|not found|pi binary|stats/i.test(line))
    .slice(-10)
  if (hints.length > 0) console.log(`  runtime 日志提示:\n${hints.join('\n')}`)
} finally {
  cleanup()
  await sleep(500)
  if (process.env.KEEP_GS_PROBE_DATA !== '1') {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      /* 清理失败不影响判定 */
    }
  }
}

if (failures.length === 0) {
  console.log(`VERDICT ${argCase} PASS`)
  process.exit(0)
}
console.log(`VERDICT ${argCase} FAIL (${failures.length} 项)`)
process.exit(1)
