/**
 * 真机性能探针共享 harness（零依赖：只用 Node ≥22 全局 WebSocket / fetch / crypto，
 * 不引入任何 npm 包——探针随验收流程在裸 Node 下运行）。
 *
 * 能力单源：runtime WS 连接 / renderer CDP 连接 / GUI 在场校验 / 流式窗 CPU profile 采集
 *          / cpuprofile 双口径聚合（inclusive 沿 parent 链上行 + self-time 帧聚合）。
 *          connection/校验/拒绝纪律逐字照搬 probes/perf-derivatives.mjs（该文件是参照实装，
 *          本 harness 是它的共享化，不得在此发明新协议）。
 *
 * 拒绝纪律（全探针共用，防「没测到东西」也 PASS）：
 *   - GUI 不在目标 session            → exit 3（DOM 事实判据，非时间推测）
 *   - 窗内采样不足或无渲染活动        → exit 3（测量无效，不产出 PASS/FAIL）
 *   - 流式未在显式 timeout 内完成     → exit 3（超时值是用户显式传入参数，非探针自设墙钟；
 *                                        且超时只弃测，绝不杀任何进程）
 *   - PASS/FAIL 只在测量有效后判定    → exit 0/1
 */
import fs from 'node:fs'
import path from 'node:path'

export function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** CLI 旗标解析（--k v / --k true 两态；值以 -- 开头视为无值开关）。 */
export function parseFlags (argv = process.argv.slice(2)) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) out[k] = true
    else { out[k] = v; i++ }
  }
  return out
}

/** 去掉 /g 旗标：正则在本文件内被反复 .test，带 g 会因 lastIndex 产生状态性漏匹配。 */
function stateless (regex) {
  return regex.global ? new RegExp(regex.source, regex.flags.replace(/g/g, '')) : regex
}

// ── runtime WS 协议（照搬 perf-derivatives.mjs connectRuntime）────────────────
export async function connectRuntime (dataDir) {
  const runtimePort = Number(fs.readFileSync(path.join(dataDir, 'runtime.port'), 'utf8').trim())
  const token = fs.readFileSync(path.join(dataDir, 'runtime-token'), 'utf8').trim()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${runtimePort}`)
    let seq = 0
    const pending = new Map()
    const events = []
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(ev.data)
      if (frame.type === 'auth.result') return
      if (frame.id !== undefined && pending.has(frame.id)) {
        const p = pending.get(frame.id)
        pending.delete(frame.id)
        if (frame.type === 'error') p.reject(new Error(JSON.stringify(frame.payload)))
        else p.resolve(frame.payload)
        return
      }
      events.push(frame)
    })
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
      setTimeout(() => resolve({
        call (type, payload, timeoutMs = 60000) {
          return new Promise((res, rej) => {
            const id = `probe-${++seq}`
            pending.set(id, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id, type, payload }))
            setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`rpc ${type} timeout`)) } }, timeoutMs)
          })
        },
        events,
        ws,
      }), 300)
    })
    ws.addEventListener('error', () => reject(new Error('runtime ws error')))
    setTimeout(() => reject(new Error('runtime ws open timeout')), 10000)
  })
}

// ── renderer CDP（照搬 perf-derivatives.mjs connectRendererProfiler）──────────
export async function connectRendererCdp (cdpPort) {
  return new Promise((resolve, reject) => {
    fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      .then((r) => r.json())
      .then((list) => {
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (!page) throw new Error('no renderer target')
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        let seq = 0
        const pending = new Map()
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(ev.data)
          if (msg.id !== undefined && pending.has(msg.id)) {
            const p = pending.get(msg.id)
            pending.delete(msg.id)
            if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
            else p.resolve(msg.result)
          }
        })
        ws.addEventListener('open', () => resolve({
          send (method, params = {}) {
            return new Promise((res, rej) => {
              const id = ++seq
              pending.set(id, { resolve: res, reject: rej })
              ws.send(JSON.stringify({ id, method, params }))
            })
          },
          close: () => ws.close(),
        }))
        ws.addEventListener('error', () => reject(new Error('cdp ws error')))
      })
      .catch(reject)
  })
}

// ── GUI 在场校验（照搬 perf-derivatives.mjs GUI 校验段）───────────────────────
// session.switch RPC 只广播激活信号，renderer 未必真切过去（实测：RPC 成功而
// [data-session-id] 仍指旧 session）。若 GUI 不在目标 session，目标 session 的流式不渲染
// 进任何可见窗 ⇒ 族成本 0 ⇒ 与「优化生效」产出同一行 RESULT PASS。
// 判据 = DOM 事实，不靠时间推测。
export async function ensureGuiOnSession (cdp, sid) {
  const guiSid = () => cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('[data-session-id]')?.getAttribute('data-session-id') || ''`,
    returnByValue: true,
  }).then((r) => String(r.result?.value ?? ''))
  // 轮询而非单次断言：session.switch 的 renderer 生效 + 首帧渲染是异步的，冷启动 GUI
  // 甚至可能还没挂出 [data-session-id]（单次断言拿到空串会误判）。
  await cdp.send('Runtime.enable')
  let active = ''
  for (let i = 0; i < 40; i++) {
    active = await guiSid()
    if (active === sid) break
    await sleep(500)
  }
  // RPC 切换未生效 ⇒ 点侧栏最新项（acceptance case 刚建/刚激活的目标 session 即最新项）。
  // 侧栏项文本是「项目名 + 时间」不含 sid，按 sid 匹配恒失败，故不能按 sid 找项。
  if (active !== sid) {
    console.log(`[probe] RPC 切换未生效（当前 ${active || '<空>'}），改走侧栏点击`)
    await cdp.send('Runtime.evaluate', {
      expression: `(() => { const items = [...document.querySelectorAll('.session-item')]; if (items[0]) items[0].click(); return items.length })()`,
      returnByValue: true,
    })
    for (let i = 0; i < 40; i++) {
      active = await guiSid()
      if (active === sid) break
      await sleep(500)
    }
  }
  if (active !== sid) {
    console.error(`[probe] GUI 未切到目标 session ${sid}（当前 ${active || '<空>'}）——拒绝采集（否则真空 PASS）`)
    process.exit(3)
  }
  console.log(`[probe] GUI on target session: ${active}`)
}

// ── cpuprofile 索引与窗内样本迭代（inclusive / self-time / 有效性三口径共用）───
function buildIndex (profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  return { byId, parent }
}

/** 帧标签：`<fn> @ <url 末段>:<line+1>`（末段去 file:// 前缀与 ?query，dev 下 Vite 带查询串）。 */
function frameLabel (cf) {
  const file = (cf.url || '').replace('file://', '').split('/').slice(-1)[0].split('?')[0]
  return `${cf.functionName || '(anonymous)'} @ ${file}:${cf.lineNumber + 1}`
}

/** 窗内样本生成器：时间轴 = timeDeltas 累加（µs→s，相对 profile 起点），半开区间 [from, to)。 */
function * windowSamples (profile, relFromS, relToS) {
  const { byId } = buildIndex(profile)
  const from = relFromS ?? 0
  const to = relToS ?? Infinity
  let acc = 0
  for (let i = 0; i < profile.samples.length; i++) {
    const deltaUs = profile.timeDeltas[i]
    const sec = acc / 1e6
    acc += deltaUs
    if (sec < from || sec >= to) continue
    yield { node: byId.get(profile.samples[i]), deltaUs }
  }
}

function toSeconds (usMap) {
  const out = new Map()
  for (const [k, us] of usMap) out.set(k, us / 1e6)
  return out
}

/**
 * inclusive（total）time：沿 parent 链上行，累加 timeDeltas。算法逐字同
 * profiling-data/inclusive.mjs，入参改为 profile 对象 + 相对秒窗 + 正则；返回
 * Map<label, seconds>（已按正则过滤）。
 *
 * 去重粒度 = 「样本 × 匹配标签」：同一帧在一栈内递归只计一次（Set 去重），但一栈内出现多个
 * **不同** 匹配帧时（如 UserBubble.vue 的 _sfc_render 与栈内另一个 UserBubble.vue 帧），
 * 该样本的 delta 对每个不同标签各计一次——这是 inclusive.mjs 的既定语义（组件多实例/多帧
 * 同栈时按帧分别计），前后对比两侧同口径，不影响可比性。
 */
export function inclusiveByLabel (profile, relFromS, relToS, regex) {
  const re = stateless(regex)
  const { byId, parent } = buildIndex(profile)
  const us = new Map()
  for (const { node: start, deltaUs } of windowSamples(profile, relFromS, relToS)) {
    if (!start) continue
    const seen = new Set()
    let cur = start.id
    while (cur !== undefined) {
      const n = byId.get(cur)
      if (!n) break
      const l = frameLabel(n.callFrame)
      if (re.test(l)) seen.add(l)
      cur = parent.get(cur)
    }
    for (const l of seen) us.set(l, (us.get(l) ?? 0) + deltaUs)
  }
  return toSeconds(us)
}

/**
 * self-time：样本落点帧自身耗时（同 perf-derivatives.mjs analyze 的聚合口径），按正则过滤。
 * 返回 Map<label, seconds>（已按正则过滤）。
 */
export function selfTimeByLabel (profile, relFromS, relToS, regex) {
  const re = stateless(regex)
  const us = new Map()
  for (const { node, deltaUs } of windowSamples(profile, relFromS, relToS)) {
    if (!node) continue
    const l = frameLabel(node.callFrame)
    if (!re.test(l)) continue
    us.set(l, (us.get(l) ?? 0) + deltaUs)
  }
  return toSeconds(us)
}

/** 窗内采样总量与空闲占比（测量有效性判据，同 perf-derivatives 双断言口径）。 */
export function windowStats (profile, relFromS, relToS) {
  let totalUs = 0
  let idleUs = 0
  for (const { node, deltaUs } of windowSamples(profile, relFromS, relToS)) {
    totalUs += deltaUs
    if (node && (node.callFrame.functionName || '') === '(idle)') idleUs += deltaUs
  }
  return {
    sampledS: totalUs / 1e6,
    nonIdleRatio: totalUs > 0 ? 1 - idleUs / totalUs : 0,
  }
}

/**
 * 流式窗 CPU profile 采集：runtime WS + renderer CDP → Profiler.start → delivery.submit
 * → GUI 在场校验 → 窗口等待 → Profiler.stop。返回 { profile, relFromS, relToS, sampledS, nonIdleRatio }。
 * relFrom = (sendWall - profilerStartWall)/1000，relTo = relFrom + windowMs/1000（流式窗自发送时刻起算）。
 * 测量无效（采样不足 / 无渲染活动）→ exit 3（绝不空数据 PASS）。
 */
export async function captureStreamingProfile ({ dataDir, sid, cdpPort, prompt, windowMs, savePath }) {
  const rt = await connectRuntime(dataDir)
  const cdp = await connectRendererCdp(cdpPort)
  console.log('[probe] connected runtime + renderer CDP')

  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.start')
  const profilerStartWall = Date.now()
  console.log('[probe] profiler started, sending prompt...')

  const clientUuid = crypto.randomUUID()
  await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
  const sendWall = Date.now()
  console.log('[probe] prompt submitted, streaming window running...')

  await ensureGuiOnSession(cdp, sid)
  await sleep(windowMs)

  const stopped = await cdp.send('Profiler.stop')
  const profile = stopped.profile
  cdp.close()
  rt.ws.close()
  console.log(`[probe] profile captured: ${profile.samples.length} samples, ${(profile.timeDeltas.reduce((a, b) => a + b, 0) / 1e6).toFixed(1)}s sampled`)

  const relFromS = (sendWall - profilerStartWall) / 1000
  const relToS = relFromS + windowMs / 1000
  console.log(`[probe] streaming window ${relFromS.toFixed(1)}s..${relToS.toFixed(1)}s`)

  // 测量有效性断言：只有上界阈值时，「窗内什么都没发生」与「优化生效」同为 0.000s PASS。
  // 判据取两组事实：① 采样量足够（profile 真的在记录）；② 窗内确有渲染活动（非 idle 样本
  // 占比下限）——流式期主线程不可能全 idle。
  const { sampledS, nonIdleRatio } = windowStats(profile, relFromS, relToS)
  const sampledOk = sampledS >= (windowMs / 1000) * 0.5
  const activeOk = nonIdleRatio >= 0.02
  if (!sampledOk || !activeOk) {
    console.error(`[probe] 测量无效：sampled=${sampledS.toFixed(1)}s（需 ≥${(windowMs / 2000).toFixed(1)}s）nonIdle=${(nonIdleRatio * 100).toFixed(1)}%（需 ≥2%）——窗内无流式活动，拒绝判定`)
    process.exit(3)
  }
  console.log(`[probe] measurement valid: sampled=${sampledS.toFixed(1)}s nonIdle=${(nonIdleRatio * 100).toFixed(1)}%`)

  if (savePath) {
    fs.mkdirSync(path.dirname(savePath), { recursive: true })
    fs.writeFileSync(savePath, JSON.stringify(profile))
    console.log(`[probe] profile saved -> ${savePath}`)
  }
  return { profile, relFromS, relToS, sampledS, nonIdleRatio }
}

/**
 * 等本 session 的 message.complete（runtime events 累加数组 + 轮询增量，不占一条监听链）。
 * timeoutMs = 用户显式传入的等待预算；到期返回 null（调用方按测量无效 exit 3），
 * 探针不做任何杀进程/判死动作（挂死收终归用户）。
 */
export async function waitForSessionComplete (rt, sid, timeoutMs) {
  // 必须先 session.subscribe 才会收到该 session 的广播帧（message.complete）；未订阅则 rt.events
  // 收不到终态 → 轮询超时（vp chat.wait 同此：subscribe 后 waitTurnEnd）。
  try { await rt.call('session.subscribe', { sessionId: sid }, 30000) } catch { /* 订阅失败仍尝试轮询，下方超时收终 */ }
  const deadline = Date.now() + timeoutMs
  // 只认订阅后到达的帧，防匹配订阅前的陈旧 complete。
  let scanned = rt.events.length
  const endTypes = new Set(['message.complete', 'message.error', 'message.stream_error', 'session.exited'])
  while (Date.now() < deadline) {
    for (let i = scanned; i < rt.events.length; i++) {
      const f = rt.events[i]
      if (endTypes.has(f.type) && f.payload?.sessionId === sid) return f
    }
    scanned = rt.events.length
    await sleep(100)
  }
  return null
}

/** 数 <dataDir>/logs/<prefix>*.log 中命中 regex 的行数（文件/目录不存在按 0）。 */
export function countLogLines (dataDir, prefix, regex) {
  const re = stateless(regex)
  const dir = path.join(dataDir, 'logs')
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.log'))
  } catch {
    return 0
  }
  let n = 0
  for (const f of files) {
    let text = ''
    try { text = fs.readFileSync(path.join(dir, f), 'utf8') } catch { continue }
    for (const line of text.split('\n')) if (re.test(line)) n++
  }
  return n
}
