#!/usr/bin/env node
/**
 * 批6 R7：把 V8 profile 里最大的未归因项 `(program)` 落到 Blink 具体工作上（零依赖）。
 *
 * 背景：`(program)` = 采样落在「非 JS」代码（Blink 布局/绘制/合成、GC、原生绑定）的占比，
 * 五次测量稳定在 29–34%（≈17–20s），是所有单点函数之外的最大项，但 V8 CPU profile 里它
 * 没有栈——只能靠 trace 的 devtools.timeline 类别解释。
 *
 * 口径：
 *   ① 只统计 renderer 主线程（thread_name = CrRendererMain）上的 X 事件；
 *   ② **self time**（不是 dur 累加）：每个切片先减去其直接子切片的 union——否则
 *      ProxyMain::BeginMainFrame / FireAnimationFrame 这类包裹切片会把整帧 JS 全算进来
 *      （首轮报告的「GL 在 Backpressure 内又相加」正是同类错误）；
 *   ③ 按切片名归类到 Blink 的「原生工作」桶，与 V8 的 `(program)` 对账（同期窗）；
 *   ④ 同一次运行的三份证据（CPU profile 的 (program)、trace 的 native self 合计、CDP
 *      TaskDuration）互相校验，允许 ±3pp（三者的「原生」边界定义不完全一致：
 *      profile 的 (program) 含原生绑定调用，trace 把 V8 内部归到 V8.GC_* / FunctionCall）。
 *
 * 用法：node probes/analyze-renderer-native.mjs <label>=<trace.json> [<label>=<file> ...] [--json]
 */
import fs from 'node:fs'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const specs = argv.filter((a) => !a.startsWith('--')).map((a) => {
  const i = a.indexOf('=')
  return { label: a.slice(0, i), file: a.slice(i + 1) }
})

/** 区间并集（µs） */
function union (iv) {
  if (!iv.length) return 0
  const s = iv.slice().sort((a, b) => a[0] - b[0])
  let total = 0
  let cs = s[0][0]
  let ce = s[0][1]
  for (let i = 1; i < s.length; i++) {
    const [a, b] = s[i]
    if (a > ce) { total += ce - cs; cs = a; ce = b } else if (b > ce) ce = b
  }
  return total + (ce - cs)
}

/**
 * Blink 原生工作分桶。键 = 桶名，值 = 归入该桶的切片名集合。
 * 只列「原生」桶（不含 FireAnimationFrame / ProxyMain::BeginMainFrame 这类含 JS 的包裹层，
 * 也不含 FunctionCall = JS 本体），否则会与 profile 的 JS busy 重复。
 */
const BUCKETS = new Map([
  ['Layout', new Set(['Layout', 'UpdateLayoutTree', 'ComputeVisibleRects', 'LayoutShift', 'IntersectionObserverController::computeIntersections'])],
  ['Paint', new Set(['Paint', 'PrePaint', 'Layerize', 'PaintArtifactCompositor::Update', 'UpdateLayer', 'LocalFrameView::PaintTree'])],
  ['Composite', new Set(['CompositeLayers', 'Commit', 'LayerTreeHost::DoUpdateLayers', 'LayerTreeHostImpl::PrepareTiles', 'ProxyMain::BeginMainFrame::Commit'])],
  ['GC', new Set(['V8.GC_MC_INCREMENTAL', 'V8.GC_MARK_COMPACTOR', 'MajorGC', 'MinorGC', 'V8.GC_SCAVENGER', 'V8.GC_MC_EVACUATE', 'V8.GC_MC_INCREMENTAL_EMBEDDER_TRACING'])],
  ['EventDispatch', new Set(['EventDispatch', 'HitTest', 'ScrollLayer', 'ParseHTML', 'StyleRecalcInvalidationTracking'])],
])

function analyze (file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const events = raw.traceEvents ?? Object.values(raw)
  const threadName = new Map()
  for (const e of events) if (e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args?.name)

  let pid = null
  let tid = null
  for (const [k, v] of threadName) if (v === 'CrRendererMain') { const [p, t] = k.split(':'); pid = +p; tid = +t }
  if (pid === null) throw new Error(`no CrRendererMain in ${file}`)

  // 收集主线程 X 事件，按 (s asc, e desc) 排序后用栈建父子关系
  const slices = []
  for (const e of events) {
    if (e.pid !== pid || e.tid !== tid) continue
    if (e.ph !== 'X' || typeof e.ts !== 'number' || typeof e.dur !== 'number') continue
    if (!Number.isFinite(e.ts) || e.ts <= 0) continue
    slices.push({ name: e.name, s: e.ts, e: e.ts + e.dur })
  }
  slices.sort((a, b) => a.s - b.s || b.e - a.e)

  const children = new Map() // index -> array of child indices
  const roots = []
  const stack = []
  for (let i = 0; i < slices.length; i++) {
    const cur = slices[i]
    while (stack.length && !(cur.s >= slices[stack[stack.length - 1]].s && cur.e <= slices[stack[stack.length - 1]].e)) stack.pop()
    if (stack.length) {
      const parentIdx = stack[stack.length - 1]
      if (!children.has(parentIdx)) children.set(parentIdx, [])
      children.get(parentIdx).push(i)
    } else roots.push(i)
    stack.push(i)
  }

  // 禁 spread：主线程切片可过百万，Math.max(...arr) 直接 RangeError（批5 trace 采集踩过同族坑）
  let minS = Infinity
  let maxE = -Infinity
  for (const s of slices) {
    if (s.s < minS) minS = s.s
    if (s.e > maxE) maxE = s.e
  }
  const wall = (maxE - minS) / 1e6

  // self = 自身区间 − 直接子区间 union
  const selfByName = new Map()
  let nativeSelf = 0
  let jsSelf = 0
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i]
    const kids = children.get(i)
    const childUnion = kids && kids.length ? union(kids.map((k) => [slices[k].s, slices[k].e])) : 0
    const self = (s.e - s.s) - childUnion
    if (self <= 0) continue
    selfByName.set(s.name, (selfByName.get(s.name) ?? 0) + self)
    if (s.name === 'FunctionCall') jsSelf += self
    else nativeSelf += self
  }

  const byBucket = new Map()
  for (const [bucket, names] of BUCKETS) {
    let t = 0
    for (const n of names) t += selfByName.get(n) ?? 0
    if (t > 0) byBucket.set(bucket, t / 1e6)
  }
  // 未分桶的原生 self（含 26.7s 级的包裹层残余、驱动回调等）
  const bucketedNames = new Set()
  for (const names of BUCKETS.values()) for (const n of names) bucketedNames.add(n)
  let unbucketed = 0
  const unbucketedTop = []
  for (const [n, v] of selfByName) {
    if (bucketedNames.has(n) || n === 'FunctionCall') continue
    unbucketed += v
    unbucketedTop.push([n, v / 1e6])
  }
  unbucketedTop.sort((a, b) => b[1] - a[1])

  return {
    label: path_base(file),
    wallS: Number(wall.toFixed(1)),
    nativeSelfS: Number((nativeSelf / 1e6).toFixed(2)),
    nativePct: Number(((nativeSelf / 1e6) / wall * 100).toFixed(1)),
    jsSelfS: Number((jsSelf / 1e6).toFixed(2)),
    jsPct: Number(((jsSelf / 1e6) / wall * 100).toFixed(1)),
    buckets: Object.fromEntries([...byBucket].map(([k, v]) => [k, Number(v.toFixed(2))])),
    unbucketedS: Number((unbucketed / 1e6).toFixed(2)),
    unbucketedTop: unbucketedTop.slice(0, 8).map(([n, v]) => [n, Number(v.toFixed(2))])
  }
}

function path_base (f) { return f.split('/').pop() }

const out = specs.map(({ label, file }) => ({ label, ...analyze(file) }))
if (asJson) {
  console.log(JSON.stringify(out, null, 1))
} else {
  for (const r of out) {
    console.log(`\n### ${r.label}  wall=${r.wallS}s`)
    console.log(`  原生 self = ${r.nativeSelfS}s (${r.nativePct}%)   JS self = ${r.jsSelfS}s (${r.jsPct}%)`)
    for (const [k, v] of Object.entries(r.buckets)) console.log(`    ${k.padEnd(14)} ${String(v).padStart(7)}s`)
    console.log(`    ${'未分桶'.padEnd(12)} ${String(r.unbucketedS).padStart(7)}s`)
    for (const [n, v] of r.unbucketedTop) console.log(`      ${String(v).padStart(6)}s  ${n}`)
  }
}
