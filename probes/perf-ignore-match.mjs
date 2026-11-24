#!/usr/bin/env node
/**
 * 批4 诊断探针 D2：.gitignore 匹配 CPU 成本对比（字面量快路径 vs 改造前 regex 逐前缀）。
 *
 * 背景（GLM 审查 A5/S9）：runtime profile +10..15s 32% busy 突发中 ruleMatchesPath
 * 0.503s + allPrefixes 0.077s 为单块最大项；全树 walk（searchFilesInCwd，5000 文件截断）
 * 对每个 entry 调一次 matchPath（82 规则 × 路径前缀逐 regex.test）。本探针量化 B4
 * 优化（无通配规则走字面量比较）的 CPU 收益。
 *
 * 方法：同一 matcher（仓库真实 .gitignore 编译）+ 同一路径语料（仓库真实树采样，
 * 排除 node_modules/.git——walk 的 BUILTIN_IGNORE_DIRS 对它们不走 matchPath），
 * 分别用「改造前算法（regex 逐前缀，内联 oracle）」与「现行 matchPath」计时。
 * 语料规模默认全量（~数千条），可 --limit 截断；重复 --rounds 轮取中位数。
 *
 * 用法：node probes/perf-ignore-match.mjs [--repo <repo>] [--limit N] [--rounds 3]
 * 输出末行：RESULT old-ms=<n> new-ms=<n> speedup=<n>x calls=<n> per-call-old-us=<n> per-call-new-us=<n>
 */
import fs from 'node:fs'
import path from 'node:path'
import { compileIgnoreRules, matchPath } from '../packages/runtime/src/infra/fs/ignore-parser.ts'

const argv = process.argv.slice(2)
function flag (name, dflt) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const repo = path.resolve(flag('repo', process.cwd()))
const limit = Number(flag('limit', '0')) // 0 = 全量
const rounds = Number(flag('rounds', '3'))

// ── 改造前算法（regex 逐前缀 + coverage）——与 domains-bundle.test.ts B4 套件 oracle 同源 ──
const REF_META = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])
function refGlobToRegex (pattern, anchored) {
  let src = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { src += '(?:.*/)?'; i += 3; continue }
      src += '.*'; i += 2; continue
    }
    if (ch === '*') { src += '[^/]*'; i += 1; continue }
    if (ch === '?') { src += '[^/]'; i += 1; continue }
    src += REF_META.has(ch) ? '\\' + ch : ch
    i += 1
  }
  return new RegExp((anchored ? '^' : '(?:^|/)') + src + '$')
}
function refCompile (content) {
  return content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#')).map((raw) => {
    let line = raw
    const negated = line.startsWith('!')
    if (negated) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    let anchored = false
    if (line.startsWith('/')) { anchored = true; line = line.slice(1) } else if (line.includes('/')) anchored = true
    return { negated, dirOnly, regex: refGlobToRegex(line, anchored) }
  })
}
function refNormalize (p) { return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') }
function refAllPrefixes (p) {
  const segs = p.split('/').filter((s) => s.length > 0)
  const out = []
  for (let end = segs.length; end >= 1; end -= 1) out.push(segs.slice(0, end).join('/'))
  return out
}
function refMatchPath (rules, path) {
  const normalized = refNormalize(path)
  const prefixes = normalized !== '' && !normalized.includes('/') ? [normalized] : refAllPrefixes(normalized)
  let ignored = false
  for (const rule of rules) {
    const hit = prefixes.some((prefix) => {
      if (!rule.regex.test(prefix)) return false
      const isSelf = prefix === normalized
      const isAncestorDir = normalized.startsWith(prefix + '/')
      return rule.dirOnly ? isAncestorDir : isSelf || isAncestorDir
    })
    if (hit) ignored = !rule.negated
  }
  return ignored
}

// ── 路径语料：仓库真实树（排除 node_modules/.git，对齐 walk 的 BUILTIN_IGNORE_DIRS 口径）──
function collectPaths (root, maxDepth) {
  const out = []
  const walk = (abs, rel, depth) => {
    let entries
    try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      out.push(r)
      if (e.isDirectory() && depth < maxDepth) walk(path.join(abs, e.name), r, depth + 1)
    }
  }
  walk(root, '', 0)
  return out
}

const gitignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')
const matcher = compileIgnoreRules(gitignore)
const refRules = refCompile(gitignore)
const paths = collectPaths(repo, 8)
const corpus = limit > 0 ? paths.slice(0, limit) : paths
console.log(`[bench] repo=${repo}`)
console.log(`[bench] rules=${matcher.rules.length} (fast-path=${matcher.rules.filter((r) => r.fast !== null).length}, regex=${matcher.rules.filter((r) => r.fast === null).length})`)
console.log(`[bench] path corpus=${corpus.length}`)

// 正确性前置：两算法在同一语料上结果必须一致（不等即基准无效）
let mismatches = 0
for (const p of corpus) if (matchPath(matcher, p) !== refMatchPath(refRules, p)) mismatches++
if (mismatches > 0) {
  console.error(`[bench] 两算法结果不一致 ${mismatches}/${corpus.length}——基准无效，弃测`)
  process.exit(3)
}
console.log(`[bench] equivalence OK (${corpus.length} paths, 0 mismatch)`)

function timeIt (fn) {
  // 预热（JIT + 分支预测稳定）
  for (const p of corpus) fn(p)
  const t0 = process.hrtime.bigint()
  let acc = 0
  for (const p of corpus) { if (fn(p)) acc++ }
  const t1 = process.hrtime.bigint()
  return { ms: Number(t1 - t0) / 1e6, acc }
}

const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)]
const oldMs = []
const newMs = []
for (let i = 0; i < rounds; i++) {
  oldMs.push(timeIt((p) => refMatchPath(refRules, p)).ms)
  newMs.push(timeIt((p) => matchPath(matcher, p)).ms)
}
const oldMedian = med(oldMs)
const newMedian = med(newMs)
console.log(`\n=== matchPath CPU 成本（${corpus.length} 次调用/轮，${rounds} 轮中位数）===`)
console.log(`改造前 regex 逐前缀 : ${oldMedian.toFixed(1)}ms  (${(oldMedian * 1000 / corpus.length).toFixed(2)} µs/call)  rounds=[${oldMs.map((n) => n.toFixed(0)).join(', ')}]`)
console.log(`B4 字面量快路径    : ${newMedian.toFixed(1)}ms  (${(newMedian * 1000 / corpus.length).toFixed(2)} µs/call)  rounds=[${newMs.map((n) => n.toFixed(0)).join(', ')}]`)
console.log(`加速比: ${(oldMedian / newMedian).toFixed(2)}x   节省: ${(oldMedian - newMedian).toFixed(1)}ms/轮`)
console.log(`RESULT old-ms=${oldMedian.toFixed(1)} new-ms=${newMedian.toFixed(1)} speedup=${(oldMedian / newMedian).toFixed(2)} calls=${corpus.length} per-call-old-us=${(oldMedian * 1000 / corpus.length).toFixed(2)} per-call-new-us=${(newMedian * 1000 / corpus.length).toFixed(2)}`)
