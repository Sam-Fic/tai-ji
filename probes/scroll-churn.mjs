#!/usr/bin/env node
/**
 * 批6 R1 探针：scrollTo 的「次数 / 重复度 / 单次成本」现场归因。
 *
 * 背景：批5 干净测量发现 `scrollTo`（原生 DOM scrollTo，profile 里 url 为空 ⇒ 归到 (program)
 * 之外的 native fn）self-time 从 1.414s 涨到 2.293/2.221s（+57~62%）。批5 只能给到
 * 「两次运行同向、根因未定位」。本探针把它拆成三个可分辨的量：
 *   ① 调用次数（vs 批5 的采样占比——采样数不等于调用数）；
 *   ② **重复写比例**：目标位置已经等于当前 scrollTop（<0.5px）仍调用 scrollTo = 纯浪费，
 *      而且这种写会让 Blink 走进 scroll 更新路径（ScrollTree::SetScrollOffset 计数）。
 *      判据是「写前读 scrollTop 与写后等价」——读的是同一个既有值，不构成额外强制布局
 *      （scrollTo 自身本来就要读几何）；
 *   ③ 单次成本（performance.now 包裹）：区分「调用变多」与「单次变贵」。
 *
 * 纪律：
 *   - 只在真机上量（dev 实例 + faux 长流式），不做离线推断；
 *   - 注入用 CDP Runtime.evaluate 打在 Element.prototype 上（virtua 与业务代码都是 call-time
 *     查找 prototype 方法，注入后立即生效）；
 *   - 收尾事件驱动（message.complete），不设墙钟判死；超时预算由调用方显式传。
 *   - 本探针不判死实例、不写数据目录以外的路径。
 *
 * 用法：node probes/scroll-churn.mjs --data-dir <dir> --sid <sid> [--cdp-port 9488] [--timeout 180000]
 *       [--skip-noop]                  ← A/B 实验臂：在注入层跳过「已到底 ∧ 目标≥底」的写
 *                                       （几何等价，仅在滚动位置已是目标时省掉调用），
 *                                        用来直接测「省掉 no-op 写」到底能省多少 profile 归因
 *       [--profile <out.cpuprofile>]   ← 同运行并存 V8 profile：用于**对账**「插桩测得的单次
 *       成本之和」与「profile 的 scrollTo self time」——两者差一个量级时，说明 profile 的
 *       native frame 归因不等于该函数的实际执行时长（采样归因 vs 墙钟计时），不能直接当
 *       「优化收益」引用。
 * 注意（实测得出的口径纪律）：**本探针的插桩本身会改变被测成本**——每次写前读 scrollTop
 * 是一次强制布局，把「scroll 写入触发的 pending 样式/布局 flush」从 scrollTo 帧挪到了 getter 帧
 * （实测同运行 profile：scrollTo self 0.24s + `get scrollTop` 6.6s，而未插桩的归档 profile 里
 * 全部落在 scrollTo 2.3s）。因此本探针的用途是**归因**（次数 / 目标 vs 底 / 重复度），
 * 不是直接引用「省了多少秒」——收益必须用未插桩的干净 harness 复测。
 *
 * 输出：人读分布 + 末行 RESULT scroll-churn calls=<n> noop=<n> noopPct=<x> p50=<ms> p95=<ms>
 */
import fs from 'node:fs'
import { connectRuntime, connectRendererCdp, ensureGuiOnSession, waitForSessionComplete, parseFlags, sleep, selfTimeByLabel, countLogLines } from './lib/harness.mjs'

const flags = parseFlags()
const dataDir = flags['data-dir']
const sid = flags.sid
const cdpPort = Number(flags['cdp-port'] ?? 9488)
const timeoutMs = Number(flags.timeout ?? 200000)
const prompt = flags.text ?? '请给出性能优化实施方案'
const label = flags.label ?? ''

if (!dataDir || !sid) {
  console.error('usage: node probes/scroll-churn.mjs --data-dir <dir> --sid <sid> [--cdp-port 9488] [--timeout 180000]')
  process.exit(2)
}

/** 注入脚本：包 Element.prototype.scrollTo / scrollBy / scrollTop setter，记录每次写入。 */
const INJECT = `(() => {
  const VERSION = 2
  // 重跑支持：先还原上一版注入（保留原始方法引用在 __scrollChurnOrig），再重装。
  // 不做版本「已存在就跳过」——实测踩到：第二次运行沿用第一版包装器，el 字段全 undefined，
  // 元素归因整列失真，而页面看起来一切正常（静默错数据的典型形态）。
  if (window.__scrollChurnOrig) {
    for (const [name, fn] of Object.entries(window.__scrollChurnOrig.methods)) Element.prototype[name] = fn
    const d0 = window.__scrollChurnOrig.scrollTopDesc
    if (d0) Object.defineProperty(Element.prototype, 'scrollTop', d0)
  }
  const rec = window.__scrollChurn = { calls: [], t0: performance.now(), version: VERSION, stacks: [] }
  // 调用方归因：只对前 N 次抓 stack（Error 构造有成本，全量抓会污染被测对象本身）
  const STACK_N = 500
  const orig = window.__scrollChurnOrig = { methods: {}, scrollTopDesc: null }
  // 元素身份：区分「真滚动容器」与「不可滚动元素上的空调用」（后者 100% 浪费）
  const elId = (el) => {
    const cls = String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.')
    const tid = el.getAttribute && el.getAttribute('data-testid')
    return (el.tagName || '?').toLowerCase() + (tid ? '#' + tid : '') + (cls ? '.' + cls : '')
  }
  const wrap = (proto, name) => {
    const original = proto[name]
    if (typeof original !== 'function') return
    orig.methods[name] = original
    proto[name] = function (...args) {
      const before = this.scrollTop
      const beforeL = this.scrollLeft
      const t = performance.now()
      let target = null
      const a0 = args[0]
      if (a0 && typeof a0 === 'object') target = (a0.top === undefined ? before : a0.top)
      else if (typeof a0 === 'number') target = a0
      const r = original.apply(this, args)
      const after = this.scrollTop
      const dur = performance.now() - t
      if (rec.stacks.length < STACK_N) {
        rec.stacks.push({ t0: t - rec.t0, stack: String(new Error().stack).split('\\n').slice(2, 12).map(f => f.trim()) })
      }
      rec.calls.push({
        t0: t - rec.t0,
        // 写前就已在该位置（且写后仍在） = no-op 重复写
        noop: Math.abs(after - before) < 0.5 && target !== null && Math.abs(target - before) < 0.5,
        clamped: target !== null && Math.abs(after - target) > 0.5,
        dur,
        before, after, target,
        max: this.scrollHeight - this.clientHeight,
        sh: this.scrollHeight,
        el: elId(this),
      })
      return r
    }
  }
  wrap(Element.prototype, 'scrollTo')
  wrap(Element.prototype, 'scrollBy')
  // A/B 实验臂：几何等价的「已到底就跳过」守卫（只在写前位置 == 目标可达上界时省调用）。
  // 判据用 DOM 几何（scrollHeight-clientHeight-scrollTop ≤1），与生产实现（virtua 的
  // scrollSize+endOffset-scrollOffset-viewportSize）互为独立表述——两臂结果一致才能说明
  // 生产判据的几何基础成立。
  if (window.__churnSkipNoop) {
    const orig2 = Element.prototype.scrollTo
    Element.prototype.scrollTo = function (...args) {
      const a0 = args[0]
      let top = null
      if (a0 && typeof a0 === 'object') top = a0.top === undefined ? null : a0.top
      else if (typeof a0 === 'number') top = a0
      if (top !== null) {
        const max = this.scrollHeight - this.clientHeight
        const domFree = max - this.scrollTop
        if (max > 0 && top >= max - 0.5 && domFree <= 1) {
          window.__churnSkipped = (window.__churnSkipped || 0) + 1
          return undefined // 几何等价：已在底且目标是底或更远
        }
      }
      return orig2.apply(this, args)
    }
    window.__scrollChurnOrig.methods.scrollTo = Element.prototype.scrollTo
  }
  const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  if (d && d.set) {
    orig.scrollTopDesc = d
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get: d.get,
      set (v) {
        const before = d.get.call(this)
        const t = performance.now()
        d.set.call(this, v)
        const after = d.get.call(this)
        rec.calls.push({
          t0: t - rec.t0,
          noop: Math.abs(after - before) < 0.5,
          clamped: Math.abs(after - v) > 0.5,
          dur: performance.now() - t,
          before, after, target: v,
          max: this.scrollHeight - this.clientHeight,
          el: elId(this),
        })
      },
    })
  }
  return 'ok'
})()`

function quantile (arr, q) {
  if (!arr.length) return 0
  const s = arr.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}

const rt = await connectRuntime(dataDir)
const cdp = await connectRendererCdp(cdpPort)
await ensureGuiOnSession(cdp, sid)

if (flags['skip-noop']) {
  await cdp.send('Runtime.evaluate', { expression: 'window.__churnSkipNoop = true' })
  console.log('[churn] SKIP-NOOP arm: 注入层已启用「已到底且目标≥底则跳过」')
}
let injected = await cdp.send('Runtime.evaluate', { expression: INJECT, returnByValue: true })
if (injected.result?.value === 'stale') {
  console.log('[churn] 页面里是旧版注入，重载页面后重注入')
  await cdp.send('Page.enable')
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(4000)
  // 重载后 GUI 回到上一次的 session：必须重新点侧栏切到目标（ensureGuiOnSession 的 RPC
  // 通路在刚重载的空态下不生效，实测报「RPC 切换未生效（当前 <空>）」）
  const { ensureGuiOnSessionViaLabel } = await import('./lib/harness.mjs')
  if (!(await ensureGuiOnSessionViaLabel(cdp, sid, flags.label))) {
    console.error('[churn] 重载后未能切回目标 session——请用 --label 传入该 session 的 label')
    process.exit(3)
  }
  injected = await cdp.send('Runtime.evaluate', { expression: INJECT, returnByValue: true })
}
console.log(`[churn] inject: ${injected.result?.value}`)

// 可选：同运行 V8 profile（对账插桩计时与采样归因）
let profStopped = null
if (flags.profile) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.start')
}
const t0 = Date.now()
const clientUuid = crypto.randomUUID()
await rt.call('delivery.submit', { sessionId: sid, content: prompt, clientUuid }, 30000)
console.log('[churn] prompt submitted, waiting for stream start…')
// 等流式真正开始（首个 assistant 内容），避免把「空窗」当成 0 调用
await sleep(3000)
await waitForSessionComplete(rt, sid, timeoutMs)
await sleep(1500) // 让 pin-bottom-guard 的收敛窗跑完（固定业务窗，非判死）

if (flags.profile) {
  const st = await cdp.send('Profiler.stop')
  profStopped = st.profile
  fs.writeFileSync(flags.profile, JSON.stringify(profStopped))
  console.log(`[churn] profile saved -> ${flags.profile} (${profStopped.samples.length} samples)`)
}
const got = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    const r = window.__scrollChurn
    if (!r) return null
    const c = r.calls
    const noop = c.filter(x => x.noop).length
    const clamped = c.filter(x => x.clamped).length
    const durs = c.map(x => x.dur)
    const bucket = {}
    for (const x of c) { const k = Math.floor(x.t0 / 5000) * 5; bucket[k] = (bucket[k] || 0) + 1 }
    // 「按 (目标, scrollHeight) 去重可省掉多少」：连续两次写入目标相同且内容高度未变 ⇒
    // 第二次是纯恒等写（几何上可证无效果，与是否 noop 判定无关）
    let skippable = 0
    for (let i = 1; i < c.length; i++) {
      const p = c[i - 1]
      if (c[i].noop && c[i].sh === p.sh) skippable++
    }
    // 目标 vs max：before==max 的调用里，virtua 算出的 target 是否也 ≥ max（若是，写入必被
    // 浏览器 clamp 成 no-op ⇒ 结构性可省）
    let atMaxAndTargetAtOrBeyond = 0, atMaxAndTargetBelow = 0
    for (const x of c) {
      if (!(x.max > 0 && Math.abs(x.before - x.max) < 1)) continue
      if (x.target === null) continue
      if (x.target >= x.max - 0.5) atMaxAndTargetAtOrBeyond++
      else atMaxAndTargetBelow++
    }
    // target 与 max 的差：验证 virtua 的 'end' 目标是否恰好 == 元素 max（决定「已到底」守卫
    // 能否用 virtua 暴露的 scrollSize/viewportSize 等价表达，而完全不必读 DOM 几何）
    const deltas = c.filter(x => x.max > 0 && x.target !== null).map(x => x.target - x.max)
    deltas.sort((a, b) => a - b)
    const dq = (p) => deltas.length ? +deltas[Math.floor(deltas.length * p)].toFixed(2) : null
    const targetDelta = { p05: dq(0.05), p50: dq(0.5), p95: dq(0.95), min: dq(0), max: dq(0.999) }
    // 同几何重复：与上一次调用相比 (target, scrollHeight, viewport, count) 全同
    let sameGeomRepeat = 0
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1], b = c[i]
      if (a.target !== null && b.target !== null && Math.abs(a.target - b.target) < 0.5 && a.sh === b.sh) sameGeomRepeat++
    }
    // 已到底判定：写前 scrollTop 已在 max（1px 容差）——最保守的「跳过条件」候选
    let atBottom = 0, noopAtBottom = 0
    for (const x of c) {
      if (x.max > 0 && Math.abs(x.before - x.max) < 1) { atBottom++; if (x.noop) noopAtBottom++ }
    }
    return {
      total: c.length, noop, clamped, skippable, atBottom, noopAtBottom,
      atMaxAndTargetAtOrBeyond, atMaxAndTargetBelow, sameGeomRepeat, targetDelta,
      durSum: durs.reduce((a, b) => a + b, 0),
      p50: 0, p95: 0, max: Math.max(0, ...durs),
      bucket,
      spanS: (performance.now() - r.t0) / 1000,
      sample: c.slice(0, 6),
    }
  })()`,
  returnByValue: true,
})
const s = got.result?.value
if (!s) {
  console.error('[churn] 注入未生效（window.__scrollChurn 缺失）——页面可能已重载')
  process.exit(3)
}

// p50/p95 在页面里算（避免把 4 万条数组传回）
const q = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    const d = window.__scrollChurn.calls.map(x => x.dur).sort((a,b)=>a-b)
    const at = (p) => d[Math.min(d.length - 1, Math.floor(d.length * p))] ?? 0
    return { p50: at(0.5), p95: at(0.95), n: d.length }
  })()`,
  returnByValue: true,
})

const p = q.result?.value ?? { p50: 0, p95: 0 }
const noopPct = s.total ? (s.noop / s.total) * 100 : 0
console.log('\n=== scroll-churn ===')
console.log(`span=${s.spanS.toFixed(1)}s calls=${s.total} (${(s.total / s.spanS).toFixed(1)}/s)`)
console.log(`no-op=${s.noop} (${noopPct.toFixed(1)}%)  clamped=${s.clamped}  skippable(noop∧scrollHeight未变)=${s.skippable}`)
console.log(`写前已在底(before==max)=${s.atBottom} (${(s.atBottom / s.total * 100).toFixed(1)}%) 其中 no-op=${s.noopAtBottom}`)
console.log(`  其中 target>=max(必被 clamp 成 no-op)=${s.atMaxAndTargetAtOrBeyond}  target<max(会被 virtua 上修)=${s.atMaxAndTargetBelow}`)
console.log(`同几何重复写(target 与 scrollHeight 均未变)=${s.sameGeomRepeat}`)
console.log(`target - max 分布:`, JSON.stringify(s.targetDelta))
console.log(`per-call: p50=${p.p50.toFixed(3)}ms p95=${p.p95.toFixed(3)}ms max=${s.max.toFixed(2)}ms sum=${s.durSum.toFixed(0)}ms`)
const bottom = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    const els = [...document.querySelectorAll('div')].filter(e => e.scrollHeight > e.clientHeight + 1)
    const main = document.getElementById('message-stream') || els.sort((a,b)=>b.scrollHeight-a.scrollHeight)[0]
    if (!main) return null
    return { domFree: main.scrollHeight - main.clientHeight - main.scrollTop,
             scrollTop: main.scrollTop, max: main.scrollHeight - main.clientHeight,
             scrollHeight: main.scrollHeight, clientHeight: main.clientHeight }
  })()`,
  returnByValue: true,
})
console.log('end-of-stream bottom:', JSON.stringify(bottom.result?.value))
const gapWarn = countLogLines(dataDir, 'renderer-console', /pin-bottom-guard.*gap=/)
console.log(`pin-bottom-guard gap warnings (cumulative in renderer-console): ${gapWarn}`)
const perEl = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    const m = {}
    for (const c of window.__scrollChurn.calls) {
      const k = c.el + (c.max > 0 ? ' [scrollable]' : ' [no-overflow]')
      if (!m[k]) m[k] = { n: 0, noop: 0 }
      m[k].n++; if (c.noop) m[k].noop++
    }
    return m
  })()`,
  returnByValue: true,
})
const perSid = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    let noopScrollable = 0, scrollable = 0, noopNon = 0, nonScroll = 0
    for (const c of window.__scrollChurn.calls) {
      if (c.max > 0) { scrollable++; if (c.noop) noopScrollable++ } else { nonScroll++; if (c.noop) noopNon++ }
    }
    return { scrollable, noopScrollable, nonScroll, noopNon }
  })()`,
  returnByValue: true,
})
const stacks = await cdp.send('Runtime.evaluate', {
  expression: `JSON.stringify((window.__scrollChurn.stacks || []).map(s => s.stack))`,
  returnByValue: true,
})
const stackList = JSON.parse(stacks.result?.value ?? '[]')
// 归因：跳过 virtua 内部帧（vendor 里 z/a/Z/oe 的 scrollToIndex 包装层），取首个非 vendor 帧
const sigOf = (frames) => {
  for (const f of frames) {
    if (/vendor-/.test(f)) continue
    return f.replace(/:\d+:\d+\)?$/, '').replace(/^at /, '')
  }
  return frames[0] ?? '?'
}
const sigCount = new Map()
for (const frames of stackList) {
  const k = sigOf(frames)
  sigCount.set(k, (sigCount.get(k) || 0) + 1)
}
console.log(`caller attribution (first ${stackList.length} calls, first non-virtua frame):`)
for (const [k, v] of [...sigCount].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log('  ', String(v).padStart(4), k)
if (stackList[0]) console.log('  sample frames:', stackList[0].join(' | ').slice(0, 400))
console.log('per-element:', JSON.stringify(perEl.result?.value, null, 1))
console.log('split:', JSON.stringify(perSid.result?.value))
console.log('per-5s buckets:', JSON.stringify(s.bucket))
console.log('first calls:', JSON.stringify(s.sample))
const sp = perSid.result?.value ?? { scrollable: 0, noopScrollable: 0 }
// 对账：profile 里 scrollTo 的 self time vs 插桩的 dur 之和
if (profStopped) {
  const all = selfTimeByLabel(profStopped, 0, (profStopped.endTime - profStopped.startTime) / 1e6, /^scrollTo$/)
  let profScroll = 0
  for (const [, v] of all) profScroll += v
  console.log(`[reconcile] profile scrollTo self=${profScroll.toFixed(3)}s  vs  instrumented dur sum=${(s.durSum / 1000).toFixed(3)}s  (ratio ${(profScroll / Math.max(0.001, s.durSum / 1000)).toFixed(1)}x)`)
}
const skipped = await cdp.send('Runtime.evaluate', { expression: 'String(window.__churnSkipped || 0)', returnByValue: true })
if (Number(skipped.result?.value) > 0) console.log(`[skip-noop] 跳过 ${skipped.result.value} 次几何等价写`)
console.log(`RESULT scroll-churn calls=${s.total} skipped=${skipped.result?.value ?? 0} noop=${s.noop} noopPct=${noopPct.toFixed(1)} atMaxTargetBeyond=${s.atMaxAndTargetAtOrBeyond} atMaxTargetBelow=${s.atMaxAndTargetBelow} sameGeom=${s.sameGeomRepeat} scrollable=${sp.scrollable} noopScrollable=${sp.noopScrollable} nonScroll=${sp.nonScroll} p50=${p.p50.toFixed(3)} p95=${p.p95.toFixed(3)} jsSum=${s.durSum.toFixed(0)}ms`)
rt.ws.close()
cdp.close()
process.exit(0)
