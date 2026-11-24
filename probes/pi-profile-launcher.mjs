#!/usr/bin/env node
/**
 * mock-pi 置换位 · 批5「干净重测」（profile 专用，行为等价透传）。
 *
 * 为什么需要它：pi 是 Bun 编译 SEA（apps/electron/resources/pi/pi-darwin-x64，Mach-O x86_64），
 * 不食 NODE_OPTIONS、SIGUSR1 直接杀死它（首轮已实证，见 docs/perf/perf-measured-report.md:20-21）——
 * 无法对它做窗口化 CDP Profiler。本 launcher 被 runtime 当 pi 二进制 exec，把同一份 pi CLI
 * （node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js）在 node 下以 `--inspect=0`
 * 拉起，使探针能对其采窗口化 CPU profile。
 *
 * inspector 端口用 **0（内核分配空闲端口）** 而不是固定端口：runtime 会把 pi 进程留住（session
 * 存活期），固定端口在第二次采集时会被上一次的 pi 占住 → 探针只能拒绝采集。实际端口从子进程
 * stderr 的 `Debugger listening on ws://…` 行解析，写入 **端口文件**（env PI_PROFILE_INSPECT_FILE，
 * 缺省 `/tmp/b5-pi-inspect.json`），探针读该文件连接。
 *
 * 行为契约（与首轮 mock-pi 规范一致 + 批5 收窄）：
 *   - argv 原样透传（runtime 给的 `--mode rpc --approve --extension …` 全部保留）；
 *   - stdin/stdout/stderr 全双向 pipe（runtime 的 JSONL 协议只旁听 stderr，不改一个字节；
 *     探针命中的那行 `Debugger listening` 会按原样继续转发）；
 *   - **不设任何关 stdin 定时器**（pi 生命周期归 runtime；禁时间机制）；
 *   - 收到 TERM/INT 转发给子进程并随之退出（防孤儿 pi）。
 *
 * 位置契约：本文件被安装到 <repo>/apps/electron/resources/pi/pi-<plat>-<arch>（find-pi-executable.ts
 * dev 分支的解析点）。repo root 经「向上找首个含 node_modules/@earendil-works 的祖先」推导，
 * 因此原地（probes/）与安装位两处都能跑——层级计数写死曾在安装位算错一级。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** repo root：从本文件位置向上找第一个含 node_modules/@earendil-works 的祖先。 */
function findRepoRoot (from) {
  let dir = path.resolve(from)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules', '@earendil-works'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
const REPO_ROOT = findRepoRoot(HERE)
const PORT_FILE = process.env['PI_PROFILE_INSPECT_FILE'] ?? '/tmp/b5-pi-inspect.json'
const INSPECT_HOST = process.env['PI_PROFILE_INSPECT_HOST'] ?? '127.0.0.1'

if (!REPO_ROOT) {
  process.stderr.write(`[pi-profile-launcher] cannot locate repo root from ${HERE} (no node_modules/@earendil-works ancestor)\n`)
  process.exit(127)
}
const CLI = path.join(REPO_ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')
if (!fs.existsSync(CLI)) {
  process.stderr.write(`[pi-profile-launcher] pi CLI not found at ${CLI} (repo root derived: ${REPO_ROOT})\n`)
  process.exit(127)
}
process.stderr.write(`[pi-profile-launcher] exec node --inspect=0 ${CLI} (argv: ${process.argv.slice(2).join(' ')})\n`)

const child = spawn(process.execPath, [`--inspect=0`, CLI, ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'pipe']
})

process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)

// stderr：旁听 `Debugger listening on ws://<host>:<port>/<uuid>` 并把端口写进端口文件，
// 随后原样转发（runtime 的 pi 日志 tee 依赖 stderr 完整）。
let parsed = false
let carry = ''
child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8')
  if (!parsed) {
    carry += text
    const m = /Debugger listening on ws:\/\/([^\s:]+):(\d+)\//.exec(carry)
    if (m) {
      parsed = true
      const port = Number(m[2])
      try {
        fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true })
        fs.writeFileSync(PORT_FILE, JSON.stringify({ port, host: INSPECT_HOST, pid: child.pid, ts: Date.now() }))
      } catch (e) {
        process.stderr.write(`[pi-profile-launcher] cannot write inspect port file ${PORT_FILE}: ${e.message}\n`)
      }
      process.stderr.write(`[pi-profile-launcher] inspector on ${INSPECT_HOST}:${port} (pid ${child.pid}, port file ${PORT_FILE})\n`)
    } else if (carry.length > 8192) {
      carry = carry.slice(-4096)
    }
  }
  process.stderr.write(chunk)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { child.kill(sig) } catch { /* 子进程已退出 */ }
  })
}

child.on('exit', (code, signal) => {
  try { fs.rmSync(PORT_FILE, { force: true }) } catch { /* 清理失败不阻塞退出 */ }
  process.exit(code ?? (signal ? 1 : 0))
})
child.on('error', (err) => {
  process.stderr.write(`[pi-profile-launcher] child spawn failed: ${err.message}\n`)
  process.exit(126)
})
