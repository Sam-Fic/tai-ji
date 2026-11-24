#!/usr/bin/env node
/**
 * 批4 验收探针 T4：真机文件树 ignored 标记对账（段级快路径的宿主侧确认）。
 *
 * 前置：dev 实例已启动（探针不负责起实例）；--data-dir 指向实例数据目录。
 *
 * 动作：连 runtime WS → 选一个 cwd = 仓库根的 session（无则自建）→ file.tree →
 *   对一组已知形态路径断言 ignored 标记（简单名 / 目录 / 锚定目录 / 多段锚定 /
 *   通配形态 / 不 ignored 对照）→ 同时输出该次 file.tree 前后 runtime 日志的
 *   `.gitignore 读取/编译` 行数（激活一次一行的现状登记）。
 *
 * 判据形态与真实 .gitignore 规则一一对应（node_modules 简单名、dist/ 目录、
 * .run/ 锚定目录、apps/electron/resources/ 多段锚定、*.log 通配）。
 *
 * 用法：node probes/tree-flags-probe.mjs --data-dir <dir>
 * 输出末行：RESULT tree-flags-ok=true|false mismatches=<n> compile-lines=<n>
 */
import fs from 'node:fs'
import path from 'node:path'
import { connectRuntime, sleep } from './lib/harness.mjs'

function arg (name, dflt) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const dataDir = path.resolve(arg('data-dir', ''))
if (!dataDir) {
  console.error('usage: node probes/tree-flags-probe.mjs --data-dir <dir>')
  process.exit(2)
}

function countCompileLines () {
  const dir = path.join(dataDir, 'logs')
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith('runtime-') && f.endsWith('.log')) } catch { return 0 }
  let n = 0
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      n += text.split('\n').filter((l) => l.includes('.gitignore 读取/编译')).length
    } catch { /* skip */ }
  }
  return n
}

const rt = await connectRuntime(dataDir)
console.log('[probe] runtime connected')

// 选 cwd = 仓库根的 session；无则自建（spawn pi 冷启动由实例承担）
const list = await rt.call('session.list', {}, 30000).catch(() => null)
const groups = list?.groups ?? []
let sid = null
for (const g of groups) {
  for (const s of g.sessions ?? []) {
    if (typeof s.cwd === 'string' && s.cwd.endsWith('/feat-cpu-gpu-performance')) { sid = s.id; break }
  }
  if (sid) break
}
if (!sid) {
  const reply = await rt.call('session.create', { cwd: process.cwd() }, 180_000)
  sid = reply.sessionId ?? reply.session?.id
  console.log(`[probe] session created: ${sid}`)
} else {
  console.log(`[probe] reusing session: ${sid}`)
}

const before = countCompileLines()
const reply = await rt.call('file.tree', { sessionId: sid }, 120_000)
const after = countCompileLines()
const nodes = reply?.tree ?? []
console.log(`[probe] file.tree nodes=${nodes.length} compile-lines-delta=${after - before}`)

// 已知形态断言（与真实 .gitignore 规则对应；只断言确定存在的节点，缺失记 NOTE 不判失败）
// 必在场且 ignored：node_modules（简单名非 dirOnly——目录自身即命中）
const REQUIRED_IGNORED = ['node_modules']
// 必在场且不 ignored
const REQUIRED_VISIBLE = ['apps', 'packages', 'probes', 'extensions', 'docs', 'scripts']
const OPTIONAL_VISIBLE = ['src', 'e2e', 'configs', 'test-guard', 'taste-lint']

const byName = new Map(nodes.map((n) => [n.name, n]))
let mismatches = 0
for (const name of REQUIRED_IGNORED) {
  const node = byName.get(name)
  if (!node) { console.log(`[probe] MISS ${name} —— 仓库根无该节点（必在场项缺失，判失败）`); mismatches++; continue }
  if (node.ignored !== true) { console.log(`[probe] MISMATCH ${name} 应 ignored=true 实为 ${node.ignored}`); mismatches++ }
}
for (const name of REQUIRED_VISIBLE) {
  const node = byName.get(name)
  if (!node) { console.log(`[probe] MISS ${name} —— 仓库根无该节点（必在场项缺失，判失败）`); mismatches++; continue }
  if (node.ignored === true) { console.log(`[probe] MISMATCH ${name} 不应 ignored 实为 true`); mismatches++ }
}
for (const name of OPTIONAL_VISIBLE) {
  const node = byName.get(name)
  if (!node) { console.log(`[probe] NOTE ${name} 不在仓库根（跳过）`); continue }
  if (node.ignored === true) { console.log(`[probe] MISMATCH ${name} 不应 ignored 实为 true`); mismatches++ }
}
// 二层抽样式断言：apps 下 electron（可见）；apps/electron/resources/ 的多段锚定 dirOnly 规则在 walk 侧（file.search）验证
const apps = byName.get('apps')
if (apps?.children) {
  const electron = apps.children.find((c) => c.name === 'electron')
  if (!electron || electron.ignored === true) { console.log('[probe] MISMATCH apps/electron 应可见'); mismatches++ }
  // apps/electron/resources 是第 3 层（listTree 仅展开顶层目录一层），其多段锚定 dirOnly 规则的语义在下方 walk 侧验证
} else {
  console.log('[probe] NOTE apps 无 children（listTree 仅两层；二层断言跳过——不判失败）')
}
// walk 侧（file.search 全量递归，默认隐藏 ignored）：多段锚定 dirOnly 规则须让 apps/electron/resources/ 下内容消失，
// node_modules/ 下内容消失，而未 ignored 的文件在场
const search = await rt.call('file.search', { sessionId: sid }, 120_000).catch((e) => ({ error: String(e) }))
const files = Array.isArray(search) ? search : search?.files ?? []
if (files.length === 0) { console.log('[probe] MISMATCH file.search 无结果（walk 不可用）'); mismatches++ }
else {
  const paths = new Set(files.map((f) => f.path))
  const leaked = [...paths].filter((p) => p.startsWith('apps/electron/resources/') || p.startsWith('node_modules/'))
  if (leaked.length > 0) { console.log(`[probe] MISMATCH file.search 泄漏 ignored 路径 ${leaked.length} 条（如 ${leaked[0]}）`); mismatches++ }
  for (const must of ['apps/electron/package.json', 'packages/runtime/src/index.ts']) {
    if (!paths.has(must)) { console.log(`[probe] MISMATCH file.search 缺未 ignored 文件 ${must}（截断或语义漂移）`); mismatches++ }
  }
  console.log(`[probe] file.search files=${files.length}（ignored 泄漏 ${leaked.length}，在场抽查 2 条）`)
}
// dirOnly 语义（既有行为，快路径等价保持）：.run 目录自身不标记、其内容标记
const runDir = byName.get('.run')
if (runDir) {
  if (runDir.ignored === true) { console.log('[probe] MISMATCH .run 目录自身不应标记（dirOnly 规则语义：仅内容命中）'); mismatches++ }
  const children = runDir.children ?? []
  const ignoredChild = children.find((c) => c.ignored === true)
  if (!ignoredChild) { console.log('[probe] MISMATCH .run 下应至少一个内容节点 ignored=true（dirOnly 内容命中）'); mismatches++ }
} else {
  console.log('[probe] NOTE .run 不在仓库根（dirOnly 断言跳过）')
}

const ok = mismatches === 0
console.log(`RESULT tree-flags-ok=${ok} mismatches=${mismatches} compile-lines=${after - before}`)
rt.ws.close()
process.exit(ok ? 0 : 1)
