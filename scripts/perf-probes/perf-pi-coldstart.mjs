#!/usr/bin/env node
/**
 * 批4 诊断探针 D1：pi 冷启动成本对比（dev 源码扩展集 vs packaged bundle 扩展集）。
 *
 * 问题（GLM 审查 A4③/S6）：pi profile +0..22s 95-100% busy
 * （jiti 4.74s + statSync 4.05s + stat 1.85s + parse 1.12s + readFileUtf8 0.84s
 *  + NodeError 0.72s + Script 0.52s），实例日志 restore elapsed=20443ms。
 *
 * 假设：dev 模式 runtime 传 --extension <repo 源码目录>（TS 源，pi 经 jiti 加载，
 * 每个扩展带 TS workspace 依赖图）；packaged 模式传 --extension <staged bundle>
 * （esbuild 自包含 index.js，单文件无依赖图）。两者冷启动成本应有量级差。
 *
 * 方法：直接 spawn pi-darwin-x64 --mode rpc（不经 Electron/runtime），
 *   - spawn → 发 get_state RPC → 收到响应的墙钟 = 冷启动就绪时延（含扩展加载）
 *   - 再发一次 get_state = 热路径对照
 *   - 进程退出后读 rusage（user+sys CPU 秒）= 冷启动 CPU 成本
 * 用法：node scripts/perf-probes/perf-pi-coldstart.mjs [--repo <repo>] [--runs 3]
 * 输出末行：RESULT dev-cold-ms=<n> dev-cpu-s=<n> pkg-cold-ms=<n> pkg-cpu-s=<n>
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
function flag (name, dflt) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const repo = path.resolve(flag('repo', process.cwd()))
const runs = Number(flag('runs', '3'))

const PI_BIN = path.join(repo, 'apps/electron/resources/pi/pi-darwin-x64')
if (!fs.existsSync(PI_BIN)) {
  console.error(`pi 二进制不存在: ${PI_BIN}`)
  process.exit(2)
}

/** dev 源码扩展集（对齐 dev-instance 启动日志的 --extension 形态）。
 *  过滤口径对齐 runtime：只保留 mandatory-extensions.json SSOT 集合
 *  （runtime scanBundledExtensions dev 分支同款过滤，pi-cache-probe 等非 mandatory 排除）。 */
function devExtensionPaths () {
  const exts = []
  const srcRoot = path.join(repo, 'extensions')
  const mandatory = JSON.parse(fs.readFileSync(path.join(repo, 'packages/shared/src/mandatory-extensions.json'), 'utf8'))
  const mandatoryNames = new Set((mandatory.extensions ?? mandatory).map((e) => e.name))
  for (const group of fs.readdirSync(srcRoot)) {
    if (group === 'shared') continue
    const groupDir = path.join(srcRoot, group)
    if (!fs.statSync(groupDir).isDirectory()) continue
    for (const pkg of fs.readdirSync(groupDir)) {
      const pkgDir = path.join(groupDir, pkg)
      if (!fs.statSync(pkgDir).isDirectory()) continue
      const pj = path.join(pkgDir, 'package.json')
      if (!fs.existsSync(pj)) continue
      const parsed = JSON.parse(fs.readFileSync(pj, 'utf8'))
      if (mandatoryNames.has(parsed.name)) exts.push(pkgDir)
    }
  }
  // dev-instance 另传 faux-provider-ext（验收 fixture，需 TAIJI_FAUX_SCRIPT env）——
  // 冷启动对比不涉及模型 provider，两侧均不带，保对称（22 vs 22）。
  return exts.sort()
}

/** packaged bundle 扩展集（staged，esbuild 自包含 index.js）。
 *  过滤口径对齐 runtime extension-resolver.isValidPiExtension：
 *  package.json 含 pi manifest / keywords 含 pi-package / peerDeps 含 pi-coding-agent ——
 *  _shared 等非扩展目录据此排除（runtime 生产路径同款过滤）。 */
function packagedExtensionPaths () {
  const dir = path.join(repo, 'apps/electron/resources/extensions/@zhushanwen')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .map((p) => path.join(dir, p))
    .filter((p) => {
      try { if (!fs.statSync(p).isDirectory()) return false } catch { return false }
      const pj = path.join(p, 'package.json')
      if (!fs.existsSync(pj)) return false
      try {
        const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'))
        if (pkg.pi) return true
        if (pkg.keywords?.includes('pi-package')) return true
        return Object.keys(pkg.peerDependencies ?? {}).some((d) => /pi-coding-agent|pi-agent-core/.test(d))
      } catch { return false }
    })
    .sort()
}

/** 进程累计 CPU 秒（ps -o time，macOS 形态 mm:ss.cc 或 [dd-]hh:mm:ss）——进程活着时采样 */
function cpuSecondsOf (pid) {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'time='], { encoding: 'utf8' })
  const t = (r.stdout ?? '').trim()
  if (!t) return null
  const parts = t.split(':').map(Number)
  if (parts.some((n) => Number.isNaN(n))) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2] // hh:mm:ss(.cc 被 Number 截断)
  if (parts.length === 2) return parts[0] * 60 + parts[1] // mm:ss(.cc)
  return null
}

const BUILTIN = ['--extension', 'builtin:codemode', '--extension', 'builtin:mcp', '--extension', 'builtin:tool-search']

function spawnPi (extensionPaths) {
  const args = ['--mode', 'rpc', '--no-extensions', '--approve', ...BUILTIN,
    ...extensionPaths.flatMap((p) => ['--extension', p])]
  const child = spawn(PI_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: repo })
  return { child, args }
}

/** spawn → get_state 首次响应的墙钟；并返回第二次（热）响应墙钟 + 累计 CPU */
function measureOnce (extensionPaths) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const { child } = spawnPi(extensionPaths)
    let buf = ''
    let firstMs = null
    let secondMs = null
    let sent = 0
    let cpuS = null
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      reject(new Error('pi 冷启动测量超时（120s）'))
    }, 120_000)
    child.stdout.on('data', (d) => {
      buf += d.toString()
      // rpc 响应 = 带 id 的 JSON 行
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === undefined) continue
        if (firstMs === null) {
          firstMs = Date.now() - t0
          // 热路径：立刻再发一次
          sent = 2
          child.stdin.write(`${JSON.stringify({ id: 2, type: 'get_state' })}\n`)
        } else if (msg.id === 2 && secondMs === null) {
          secondMs = Date.now() - t0
          // 进程仍活着：先采 CPU 再优雅退出（resourceUsage() 在本机 Node 不可用）
          try { cpuS = cpuSecondsOf(child.pid) } catch {}
          clearTimeout(timer)
          // 关 stdin 让 pi 优雅退出，读 rusage
          try { child.stdin.end() } catch {}
        }
      }
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (firstMs === null) return reject(new Error(`pi 未在退出前响应 get_state（code=${code} signal=${signal}）`))
      resolve({ firstMs, secondMs, cpuS })
    })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.stderr.on('data', () => {}) // 吞掉 stderr（Debugger listening 等）
  })
}

async function measureSet (label, paths) {
  const results = []
  for (let i = 0; i < runs; i++) {
    const r = await measureOnce(paths)
    results.push(r)
    console.log(`[${label}] run${i + 1}: cold-get_state=${r.firstMs}ms warm-get_state=${r.secondMs}ms cpu=${r.cpuS?.toFixed(2)}s`)
  }
  const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)]
  return {
    label,
    count: paths.length,
    coldMs: med(results.map((r) => r.firstMs)),
    warmMs: med(results.map((r) => r.secondMs)),
    cpuS: med(results.map((r) => r.cpuS ?? 0)),
    raw: results,
  }
}

const devPaths = devExtensionPaths()
const pkgPaths = packagedExtensionPaths()
console.log(`[probe] dev 源码扩展 ${devPaths.length} 个 / packaged bundle 扩展 ${pkgPaths.length} 个`)

// 顺序跑（避免双 pi 冷启动互相争 CPU 扭曲对比）：先 dev 后 pkg，各 runs 次取中位数
const dev = await measureSet('dev', devPaths)
const pkg = await measureSet('pkg', pkgPaths)

console.log('\n=== pi 冷启动对比（spawn → get_state 首响墙钟，中位数）===')
console.log(`dev  源码扩展（${dev.count} 个，TS 经 jiti）: cold=${dev.coldMs}ms warm=${dev.warmMs}ms cpu=${dev.cpuS.toFixed(2)}s`)
console.log(`pkg  bundle 扩展（${pkg.count} 个，自包含 JS）: cold=${pkg.coldMs}ms warm=${pkg.warmMs}ms cpu=${pkg.cpuS.toFixed(2)}s`)
console.log(`倍率: cold ${(dev.coldMs / pkg.coldMs).toFixed(2)}x  cpu ${(dev.cpuS / pkg.cpuS).toFixed(2)}x`)
console.log(`RESULT dev-cold-ms=${dev.coldMs} dev-cpu-s=${dev.cpuS.toFixed(2)} pkg-cold-ms=${pkg.coldMs} pkg-cpu-s=${pkg.cpuS.toFixed(2)} ratio-cold=${(dev.coldMs / pkg.coldMs).toFixed(2)}`)
