#!/usr/bin/env node
/**
 * 批5 GPU 三臂分析：从 trace.json 复算 GPU 裁决需要的口径（零依赖）。
 *
 * 口径纪律（GLM 对抗审查 M1 的共同教训，逐条落实）：
 *   ① **禁嵌套求和**：所有时长按「线程时间轴 union」计（同一线程上重叠区间只算一次），
 *      不做 slice dur 的全量累加（首轮把 GL 算在 ApplyBackpressure 内又两者相加，虚高 2×）；
 *   ② 主指标 = `CrGpuMain`（GPU 主线程）上 `Scheduler::RunTask` 的 union ÷ 墙钟跨度
 *      = **GPU 主线程忙占比**（与 slice 名无关，不受嵌套/命名词表漂移影响）；
 *   ③ 辅助指标 = 该线程的直接子切片覆盖（嵌套包含过滤后）+ **未命名 gap**
 *      （RunTask 减去直接子覆盖 = 无具名子切片的 GPU 工作时间；Intel/Metal 上大量驱动侧
 *      合成工作无 trace 名字，backdrop-filter 的开销就落在这里）；
 *   ④ Raster 单独看 `RendererRasterWorker`（OOP-R 在 GPU 进程内）——用它排除
 *      「blur 成本在 raster worker 里」这一假设；
 *   ⑤ 帧率看 `CommitPresentedFrameToCA`（每呈现一帧一次）逐秒计数，用来判断
 *      GPU 开销是否转化为掉帧（用户可感知）；
 *
 * 用法：node scripts/perf-probes/analyze-gpu-arms.mjs <label>=<trace.json> [<label>=<file> ...]
 * 输出：机器可读的 JSON（--json）+ 人读表格
 */
import fs from 'node:fs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const specs = argv.filter((a) => !a.startsWith('--')).map((a) => {
  const i = a.indexOf('=')
  return { label: a.slice(0, i), file: a.slice(i + 1) }
})

function unionSeconds (iv) {
  if (iv.length === 0) return 0
  iv.sort((a, b) => a[0] - b[0])
  let total = 0
  let cs = iv[0][0]
  let ce = iv[0][1]
  for (const [s, e] of iv.slice(1)) {
    if (s > ce) { total += ce - cs; cs = s; ce = e } else if (e > ce) ce = e
  }
  return (total + ce - cs) / 1e6
}

/** thread_name 事件 → pid:tid → 线程名。 */
function buildThreadNameMap (events) {
  const threadName = new Map()
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args.name)
  return threadName
}

/** 收集全部 X 切片：按线程分组，同时求 trace 墙钟窗（坏点丢弃）。 */
function collectPerThreadSlices (events) {
  let minTs = Infinity
  let maxTs = 0
  const perThread = new Map()
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.ts !== 'number' || typeof e.dur !== 'number') continue
    if (!Number.isFinite(e.ts) || e.ts <= 0 || e.ts > 1e15) continue
    if (e.ts < minTs) minTs = e.ts
    const end = e.ts + e.dur
    if (end > maxTs) maxTs = end
    const key = `${e.pid}:${e.tid}`
    if (!perThread.has(key)) perThread.set(key, [])
    perThread.get(key).push({ name: e.name, s: e.ts, e: end })
  }
  return { perThread, minTs, wallS: (maxTs - minTs) / 1e6 }
}

/** RunTask 直接子切片（完全落在某 RunTask 内、不被另一候选严格包含）按名归组 + 覆盖区间。 */
function directChildrenOfRunTasks (gpuSlices, runTasks) {
  const perName = new Map()
  const coveredIv = []
  for (const rt of runTasks) {
    const cand = gpuSlices
      .filter((x) => x !== rt && x.name !== 'Scheduler::RunTask' && x.s >= rt.s - 1 && x.e <= rt.e + 1)
      .sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s))
    const tops = []
    for (const c of cand) {
      if (tops.some((t) => c.s >= t.s && c.e <= t.e && (c.e - c.s) < (t.e - t.s))) continue
      tops.push(c)
    }
    for (const t of tops) {
      if (!perName.has(t.name)) perName.set(t.name, [])
      perName.get(t.name).push([t.s, t.e])
      coveredIv.push([t.s, t.e])
    }
  }
  const named = [...perName].map(([name, iv]) => ({ name, union: unionSeconds(iv) })).sort((a, b) => b.union - a.union)
  return { named, covered: unionSeconds(coveredIv) }
}

/** 线程级（含嵌套）union：raster 这类切片嵌在 RunTask 更深层，直接子口径会得 0（误导）。 */
function threadLevelNamedUnion (gpuSlices) {
  const threadNamed = new Map()
  for (const x of gpuSlices) {
    if (!threadNamed.has(x.name)) threadNamed.set(x.name, [])
    threadNamed.get(x.name).push([x.s, x.e])
  }
  return { threadNamed, threadUnionOf: (n) => unionSeconds(threadNamed.get(n) ?? []) }
}

/** 逐秒 GPU 忙占比（去掉首尾 1s 的 trace 起停边界）。 */
function perSecondBusy (runTasks, minTs, wallS) {
  const nSec = Math.ceil(wallS)
  const busyPerSec = new Array(nSec).fill(0)
  for (const rt of runTasks) {
    let i = Math.max(0, Math.floor((rt.s - minTs) / 1e6))
    while (i < nSec && minTs + i * 1e6 < rt.e) {
      const a = Math.max(rt.s, minTs + i * 1e6)
      const b = Math.min(rt.e, minTs + (i + 1) * 1e6)
      if (b > a) busyPerSec[i] += (b - a) / 1e6
      i++
    }
  }
  const interior = busyPerSec.slice(1, Math.max(2, nSec - 1))
  return interior.reduce((a, b) => a + b, 0) / interior.length
}

/** 逐秒呈现帧数（CommitPresentedFrameToCA，去首尾边界）。 */
function perSecondFps (gpuSlices, minTs, wallS) {
  const nSec = Math.ceil(wallS)
  const presents = gpuSlices.filter((x) => x.name === 'CommitPresentedFrameToCA').map((x) => x.s)
  const fpsPerSec = new Array(nSec).fill(0)
  for (const ts of presents) { const i = Math.floor((ts - minTs) / 1e6); if (i >= 0 && i < nSec) fpsPerSec[i]++ }
  return { presents, fpsInterior: fpsPerSec.slice(1, Math.max(2, nSec - 1)) }
}

function analyze (file) {
  const events = JSON.parse(fs.readFileSync(file, 'utf8'))
  const threadName = buildThreadNameMap(events)
  const { perThread, minTs, wallS } = collectPerThreadSlices(events)

  const threadUnion = new Map()
  for (const [k, slices] of perThread) threadUnion.set(threadName.get(k) ?? `?${k}`, unionSeconds(slices.map((x) => [x.s, x.e])))

  const gpuKey = [...perThread.keys()].find((k) => threadName.get(k) === 'CrGpuMain')
  const gpuSlices = gpuKey ? perThread.get(gpuKey) : []
  const runTasks = gpuSlices.filter((x) => x.name === 'Scheduler::RunTask')
  const runTaskUnion = unionSeconds(runTasks.map((x) => [x.s, x.e]))

  const { named, covered } = directChildrenOfRunTasks(gpuSlices, runTasks)
  const { threadNamed, threadUnionOf } = threadLevelNamedUnion(gpuSlices)

  const meanBusy = perSecondBusy(runTasks, minTs, wallS)
  const { presents, fpsInterior } = perSecondFps(gpuSlices, minTs, wallS)

  return {
    file,
    wallS,
    threads: Object.fromEntries([...threadUnion].sort((a, b) => b[1] - a[1]).slice(0, 8)),
    gpuBusyPct: meanBusy * 100,
    gpuRunTaskS: runTaskUnion,
    gpuNamedCoveredS: covered,
    gpuUnnamedGapS: runTaskUnion - covered,
    rasterS: threadUnionOf('RendererRasterWorker'),
    rasterN: (threadNamed.get('RendererRasterWorker') ?? []).length,
    endRasterS: threadUnionOf('RasterDecoderImpl::DoEndRasterCHROMIUM'),
    presentS: unionSeconds(threadNamed.get('ImageTransportSurfaceOverlayMac::Present') ?? []),
    backpressureS: threadUnionOf('CALayerTreeCoordinator::ApplyBackpressure'),
    namedTop: named.slice(0, 8),
    framesPresented: presents.length,
    fpsMean: fpsInterior.reduce((a, b) => a + b, 0) / fpsInterior.length,
    fpsMin: Math.min(...fpsInterior),
    fpsBelow55: fpsInterior.filter((f) => f < 55).length
  }
}

const rows = specs.map(({ label, file }) => ({ label, ...analyze(file) }))

if (json) {
  console.log(JSON.stringify(rows, null, 1))
} else {
  console.log('label           wall    GPU忙%   RunTask  namedCov  GAP(未命名)  Raster(n)     endRaster  Present  Backpressure  帧数  均FPS minFPS <55fps秒')
  for (const r of rows) {
    console.log(`${r.label.padEnd(15)} ${r.wallS.toFixed(1)}s  ${r.gpuBusyPct.toFixed(1).padStart(6)}%  ${r.gpuRunTaskS.toFixed(2).padStart(6)}s  ${r.gpuNamedCoveredS.toFixed(2).padStart(6)}s  ${r.gpuUnnamedGapS.toFixed(2).padStart(7)}s  ${r.rasterS.toFixed(2)}s(${String(r.rasterN).padStart(6)})  ${r.endRasterS.toFixed(2)}s    ${r.presentS.toFixed(2)}s  ${r.backpressureS.toFixed(3)}s      ${String(r.framesPresented).padStart(5)}  ${r.fpsMean.toFixed(1)}  ${String(r.fpsMin).padStart(4)}  ${String(r.fpsBelow55).padStart(4)}`)
  }
  console.log('\nnamed direct children (top 6 per arm):')
  for (const r of rows) {
    console.log(`  ${r.label}: ${r.namedTop.slice(0, 6).map((x) => `${x.name}=${x.union.toFixed(2)}s`).join('  ')}`)
  }
}
