#!/usr/bin/env node
/**
 * check-history-read-model —— 历史读取读模型防回流静态检查（L0，RL1）。
 *
 * 来源：turn-boundary-index 设计 §4.2 RL1（正常历史查看不再调用 get_entries，也不存在
 * 后台全量重建与跨进程通知）。跑绿门挂协议退役单元的 commit 门 + CI invariants。
 *
 * 检查三组（任一命中即 exit 1，逐条给出文件:行与恢复动作）：
 *
 * 1. 退役通知协议零回流：缓存就绪通知帧名与其跨包监听器名（两个模式串均在下方以
 *    拼接形态持有，防本脚本被仓库级零回流检索命中）在
 *    packages / apps / e2e / extensions / scripts / docs / AGENTS.md 范围（排除
 *    node_modules 与本脚本自身）零命中——协议类型、发布端、跨包消费与文档登记
 *    全链退役后不得回流。
 *
 * 2. runtime 生产代码旧链符号零回流：`HistoryRebuildCache` / `RebuildJob` /
 *    `pendingRebuilds` / `rebuildQueue` / `startPendingRebuild` 五符号在
 *    packages/runtime/src 生产文件（排除 __tests__ / *.test.ts）零命中；
 *    `history-rebuild-cache.ts` 文件本身必须不存在（已迁移为索引编排，路径回流即红）。
 *
 * 3. 正常历史读取编排不引用 pi get_entries：`services/session-history.ts` 与
 *    `services/session/history-reader.ts`（迁移后落位，不存在时跳过该文件——第 2 组
 *    的文件存在性检查兜住迁移未完成形态）不得出现 `.getEntries(` 调用。文件窗口
 *    转换链只读 JSONL；TraceSync / SessionRecords / 撤回定位 / 投递判重 / 插件读取 /
 *    压缩分界等独立 get_entries 消费链不在本检查范围（设计范围外，保持原状）。
 *
 * 用法：node scripts/check-history-read-model.mjs（仓库根为 cwd；exit 0 = 绿）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url))

const problems = []

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function scanFiles(files, patterns, label) {
  for (const file of files) {
    const rel = path.relative(ROOT, file)
    if (rel === SELF) continue
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (const [name, re] of patterns) {
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          problems.push(`${label}：${rel}:${i + 1} 命中 ${name}`)
          break // 同文件同 pattern 只记一次
        }
      }
    }
  }
}

// ── 组 1：退役通知协议零回流（代码 + 文档全链） ────────────────────────
// 通知帧名与监听器名在脚本内以拼接形态持有，防自匹配（本脚本也是 scan 范围的一员，
// 且仓库级零回流检索含 scripts/——字面量在脚本内出现会同时命中两类门）。
const RETIRED_EVENT = ['session.historyCache', 'Ready'].join('')
const RETIRED_LISTENER = ['onHistoryCache', 'Ready'].join('')
const CODE_DIRS = ['packages', 'apps', 'e2e', 'extensions', 'scripts']
const DOC_FILES = ['AGENTS.md']
const codeFiles = CODE_DIRS.flatMap((d) => walk(path.join(ROOT, d)))
const docFiles = DOC_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f))
scanFiles(
  [...codeFiles, ...docFiles],
  [
    [RETIRED_EVENT, new RegExp(RETIRED_EVENT.replace('.', '\\.'))],
    [RETIRED_LISTENER, new RegExp(RETIRED_LISTENER)],
  ],
  '组1 退役通知协议回流',
)

// ── 组 2：runtime 生产代码旧链符号零回流 ─────────────────────────────
const runtimeSrc = walk(path.join(ROOT, 'packages/runtime/src')).filter(
  (f) => f.endsWith('.ts') && !f.includes('__tests__') && !/\.test\.ts$/.test(f),
)
scanFiles(
  runtimeSrc,
  [
    ['HistoryRebuildCache', /\bHistoryRebuildCache\b/],
    ['RebuildJob', /\bRebuildJob\b/],
    ['pendingRebuilds', /\bpendingRebuilds\b/],
    ['rebuildQueue', /\brebuildQueue\b/],
    ['startPendingRebuild', /\bstartPendingRebuild\b/],
  ],
  '组2 旧链符号回流',
)
const retiredFile = path.join(ROOT, 'packages/runtime/src/services/session/history-rebuild-cache.ts')
if (fs.existsSync(retiredFile)) {
  problems.push('组2 旧链文件回流：packages/runtime/src/services/session/history-rebuild-cache.ts 仍存在（已迁移为索引编排 history-reader.ts）')
}

// ── 组 3：正常历史读取编排不引用 pi get_entries ───────────────────────
// 只拦 `.getEntries(` 调用形态：session-history.ts 内对 pi 行为的事实锚注释（不含点调用）不误伤。
const readerFiles = [
  'packages/runtime/src/services/session-history.ts',
  'packages/runtime/src/services/session/history-reader.ts',
]
scanFiles(
  readerFiles
    .map((rel) => path.join(ROOT, rel))
    .filter((f) => fs.existsSync(f)),
  [['.getEntries( 调用', /\.getEntries\(/]],
  '组3 历史读取编排引用 get_entries',
)

if (problems.length > 0) {
  process.stdout.write(`check-history-read-model: FAIL（${problems.length} 处回流）\n`)
  for (const p of problems) process.stdout.write(`  - ${p}\n`)
  process.stdout.write(
    '恢复动作：历史查看只允许 turn 边界索引窗口读取（design turn-boundary-index，ADR-0178/0180 已修订）；' +
      '全量消息缓存、后台重建与通知协议已整体退役，新增需求先修订设计再动代码。\n',
  )
  process.exit(1)
}
process.stdout.write('check-history-read-model: OK（通知协议 / 旧链符号 / 读取编排 get_entries 零回流）\n')
