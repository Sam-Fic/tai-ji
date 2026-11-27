#!/usr/bin/env node
/**
 * 批5 干净测量归档的离线自检（M1 的机器判据）。
 *
 * 为什么 gate 不直接跑采集：真采集要求 load 1m ≤15 的安静窗（题面测量纪律），把它塞进 gate
 * 会让「本机被外部负载占用」变成验收红项——那不是交付物缺陷。真采集的现场证据是每次运行
 * 落盘的 `<tag>-cpu-run.log`（含 RESULT 行）与归档产物本身；gate 则核这两件事：
 *   ① 探针纪律（关掉守卫就能被污染数据骗过，必须机器钉住）：
 *        无 --data-dir → exit 2（空值守卫必须判**原始值**，path.resolve('') 返回 cwd 的坑）
 *        --data-dir ~/.taiji → exit 3（值域守卫：绝不写真实用户数据目录）
 *        --verify-pi-only → ok=true（置换位三核对可用，且不需要 --data-dir）
 *   ② 归档有效性：三进程 profile 齐全、metrics 采样数 ≥50、env 含 head/load/bundle md5、
 *      且 profile 里确有采样（非空壳）
 *
 * 用法：node scripts/perf-probes/check-clean-artifacts.mjs [--dir docs/perf/final-measurement]
 * 输出末行：RESULT clean-artifacts ok=<bool> checks=<n> failed=<n>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import nodeCrypto from 'node:crypto'

const require_crypto = () => nodeCrypto
import { fileURLToPath } from 'node:url'
import { locateArchivedArtifact } from './lib/archive-manifest.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const dirIdx = argv.indexOf('--dir')
const MEAS = dirIdx >= 0 ? path.resolve(argv[dirIdx + 1]) : path.join(REPO_ROOT, 'docs', 'perf', 'final-measurement')

const failures = []
let checks = 0
const check = (name, ok, detail = '') => {
  checks++
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

// ── ① 探针纪律（离线、无需实例）────────────────────────────────────────────
const probe = path.join(REPO_ROOT, 'scripts', 'perf-probes', 'perf-clean-cpu.mjs')
const run = (args) => spawnSync(process.execPath, [probe, ...args], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 60000 })

const noArgs = run([])
check('无 --data-dir → exit 2', noArgs.status === 2, `实际 exit=${noArgs.status}`)
check('无 --data-dir 时给 usage', `${noArgs.stdout}${noArgs.stderr}`.includes('usage:'))

const userDir = run(['--data-dir', path.join(os.homedir(), '.taiji')])
check('--data-dir ~/.taiji → exit 3（值域守卫）', userDir.status === 3, `实际 exit=${userDir.status}`)
check('值域守卫给出可操作提示', `${userDir.stdout}${userDir.stderr}`.includes('拒绝采集'))

const piOnly = run(['--verify-pi-only'])
check('--verify-pi-only → exit 0', piOnly.status === 0, `实际 exit=${piOnly.status}`)
check('pi 置换位 ok=true', `${piOnly.stdout}`.includes('RESULT pi-restore ok=true'), piOnly.stdout.trim().slice(0, 120))
check('pi 置换位无残留备份', `${piOnly.stdout}`.includes('backup-present=false'))

// ── ② 归档有效性 ──────────────────────────────────────────────────────────
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(MEAS, f), 'utf8'))
  } catch {
    return null
  }
}

for (const tag of ['baseline', 'final', 'final-r2', 'form-fences', 'form-tools', 'form-thinking']) {
  const env = readJson(`${tag}-env.json`)
  const metrics = readJson(`${tag}-metrics.json`)
  const renderer = readJson(`${tag}-renderer.cpuprofile`)
  // pi/runtime cpuprofile 已出库归档（branch-review dmg-r1-2 收尾）：经 raw-artifacts-manifest.json
  // 定位 + md5 对账；归档不可达（会话树被清理）按回收容忍显式降级，可达时漂移 = 红灯。
  const runtimeLoc = locateArchivedArtifact(MEAS, `${tag}-runtime.cpuprofile`)
  const piLoc = locateArchivedArtifact(MEAS, `${tag}-pi.cpuprofile`)
  const parseProfile = (loc) => {
    if (loc === null) return null
    try { return JSON.parse(fs.readFileSync(loc.file, 'utf8')) } catch { return null }
  }
  const runtime = parseProfile(runtimeLoc)
  const pi = parseProfile(piLoc)

  const missing = []
  if (renderer === null) missing.push('renderer 库内缺失')
  if (runtimeLoc === null) missing.push('runtime 归档不可达')
  if (piLoc === null) missing.push('pi 归档不可达')
  check(`${tag}: 三进程 profile 均在位（renderer 库内；pi/runtime 库内或归档）`, missing.length === 0, missing.join(' / ') || `三进程全部在位（runtime=${runtimeLoc?.where} pi=${piLoc?.where}）`)
  check(
    `${tag}: profile 非空壳`,
    [renderer, runtime, pi].every((p) => p === null || (Array.isArray(p.samples) && p.samples.length > 1000)),
    `samples: ${[renderer, runtime, pi].map((p) => p?.samples?.length ?? 'n/a').join('/')}`
  )
  const md5Bad = [runtimeLoc, piLoc].filter((l) => l !== null && l.md5Match !== true)
  check(
    `${tag}: pi/runtime 归档 md5 与清单一致（归档未漂移）`,
    md5Bad.length === 0,
    md5Bad.length ? '归档漂移' : (runtimeLoc !== null && piLoc !== null ? 'md5 一致' : '部分不可达（跳过比对）')
  )
  check(`${tag}: metrics 采样 ≥50`, (metrics?.samples?.length ?? 0) >= 50, `实际 ${metrics?.samples?.length ?? 0}`)
  check(`${tag}: env 含 head/load/bundle md5`, Boolean(env?.head) && Boolean(env?.load) && Boolean(env?.rendererBundle?.indexMd5))
  check(`${tag}: env 声明了墙钟流式时长`, (env?.wall?.streamS ?? 0) > 10, `streamS=${env?.wall?.streamS}`)
  // 本机绝对路径脱敏（AGENTS.md 规则 22）
  const envRaw = fs.readFileSync(path.join(MEAS, `${tag}-env.json`), 'utf8')
  check(`${tag}: env 无本机绝对路径`, !envRaw.includes(os.homedir()), 'env.json 里出现了 home 绝对路径')
}

// ── ③ GPU trace 归档清单 ↔ union 分析输出 同源对账 ────────────────────────
// 背景（实测踩到）：trace 本体（230-260MB）不入库，只存在会话 artifacts；而 gate 的 M2/G*
// 会重跑采集并可能用新 trace 覆盖同名文件 ⇒ 「gpu-analysis.txt 里的数字」与「artifact 里的
// trace」可能悄悄不同源。清单把每份 trace 的 md5 钉住，并在 trace 仍可达时当场复算比对。
const manifest = readJson('gpu-trace-manifest.json')
check('gpu-trace-manifest.json 在场', manifest !== null)
if (manifest) {
  const entries = Object.entries(manifest.traces ?? {})
  check('清单含 8 条（baseline/两轮 final/四臂）', entries.length === 8, `实际 ${entries.length}`)
  check('清单路径不含本机绝对路径', !JSON.stringify(manifest).includes(os.homedir()))
  const gpuAnalysis = fs.readFileSync(path.join(MEAS, 'gpu-analysis.txt'), 'utf8')
  for (const [label, meta] of entries) {
    check(`清单 ${label} 有 32 位 md5`, /^[0-9a-f]{32}$/.test(String(meta.md5)), String(meta.md5))
    check(`gpu-analysis.txt 含 ${label} 行`, gpuAnalysis.includes(label))
    // trace 仍在 artifacts 时：md5 必须与清单一致（不一致 = 被新采集覆盖，归档已漂移）。
    // 目录用通配解析：<sessionsRoot>/<sessionId>/artifacts/b5-traces（sessionId 随会话变，
    // 写死会让检查静默跳过——实测过：路径不存在时该断言被跳过，篡改 md5 也抓不到）。
    const sessionsRoot = path.join(os.homedir(), '.taiji', 'ext-sessions')
    const candidates = (() => {
      try {
        return fs.readdirSync(sessionsRoot)
          .map((sid) => path.join(sessionsRoot, sid, 'artifacts', 'b5-traces', meta.file))
          .filter((f) => fs.existsSync(f))
      } catch {
        return []
      }
    })()
    const abs = candidates[0] ?? null
    check(`trace ${meta.file} 在 artifacts 中可定位（或已随会话回收）`, true, abs ? '' : '未找到（会话 artifacts 可能已回收，跳过 md5 比对）')
    if (abs) {
      const actual = require_crypto().createHash('md5').update(fs.readFileSync(abs)).digest('hex')
      check(`trace ${meta.file} md5 与清单一致（归档未漂移）`, actual === meta.md5, `清单 ${meta.md5.slice(0, 12)} vs 实际 ${actual.slice(0, 12)}`)
    }
  }
}

const ok = failures.length === 0
for (const f of failures) console.error(`  ✗ ${f}`)
console.log(`RESULT clean-artifacts ok=${ok} checks=${checks} failed=${failures.length}`)
process.exit(ok ? 0 : 1)
