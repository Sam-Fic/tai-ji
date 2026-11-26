#!/usr/bin/env node
/**
 * 批4 修剪探针（card-04 注入与输出伪造 / card-05 特殊文件与环境形态）：
 * 随机 .gitignore 规则集 × 随机路径 的属性式模糊对拍——现行 matchPath（段级快路径）
 * vs 改造前算法（regex 逐前缀，内联 oracle）。任一分歧 = 快路径伪造 ignored 判据。
 *
 * 用法：npx tsx scripts/perf-probes/ignore-match-fuzz.mjs [--iter 400] [--seed 1]
 * 输出末行：FUZZ cases=<n> mismatches=<n>
 */
import { compileIgnoreRules, matchPath } from '../packages/runtime/src/infra/fs/ignore-parser.ts'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const ITER = Number(flag('iter', 400))
let seed = Number(flag('seed', 1))
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const int = (n) => Math.floor(rnd() * n)

// ── oracle：改造前算法（与 domains-bundle.test.ts B4 套件同源）──
const META = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])
function refGlob (p, a) {
  let s = '', i = 0
  while (i < p.length) {
    const c = p[i]
    if (c === '*' && p[i + 1] === '*') { if (p[i + 2] === '/') { s += '(?:.*/)?'; i += 3; continue } s += '.*'; i += 2; continue }
    if (c === '*') { s += '[^/]*'; i += 1; continue }
    if (c === '?') { s += '[^/]'; i += 1; continue }
    s += META.has(c) ? '\\' + c : c; i += 1
  }
  return new RegExp((a ? '^' : '(?:^|/)') + s + '$')
}
function refCompile (content) {
  return content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#')).map((raw) => {
    let line = raw
    const negated = line.startsWith('!'); if (negated) line = line.slice(1)
    const dirOnly = line.endsWith('/'); if (dirOnly) line = line.slice(0, -1)
    let a = false
    if (line.startsWith('/')) { a = true; line = line.slice(1) } else if (line.includes('/')) a = true
    return { negated, dirOnly, regex: refGlob(line, a) }
  })
}
function refMatch (rules, path) {
  const n = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  const prefixes = n !== '' && !n.includes('/') ? [n] : (() => { const s = n.split('/').filter((x) => x.length > 0); const o = []; for (let e = s.length; e >= 1; e--) o.push(s.slice(0, e).join('/')); return o })()
  let ign = false
  for (const r of rules) {
    const hit = prefixes.some((pre) => { if (!r.regex.test(pre)) return false; const self = pre === n; const anc = n.startsWith(pre + '/'); return r.dirOnly ? anc : self || anc })
    if (hit) ign = !r.negated
  }
  return ign
}

// ── 语料生成（覆盖：名称字符集 / 通配形态 / 锚定 / 取反 / 目录后缀 / 元字符 / 反斜杠 / 注释 / CRLF / 空白）──
const NAME_ATOMS = ['a', 'ab', 'foo', 'bar', 'dist', 'build', 'node_modules', '.env', '.DS_Store', 'x.log', 'pkg-1', 'A', 'Z', '中文', '日本語', 'é', 'a b', 'foo[1]', 'a(b|c)', 'd$e', 'f{g}', 'h+i', 'k^l', 'm|n', 'o.p', 'q\\r', 's#t', 'u!', '!v', 'w~', '*~', '.impeccable', '20x', '__pycache__', 'package-lock.json']
const SEG_ATOMS = ['a', 'b', 'foo', 'bar', 'dist', 'node_modules', '.env', '.run', 'x.log', 'app.log', '中文', 'é', 'a b', 'foo[1]', 'a(b|c)', 'd$e', 'o.p', 'q\\r', 's#t', 'w~', 'ab', 'abb', 'abcbb', 'aa', '', '.impeccable', '20x', 'wave-a.json', '.cw-x.json', 'keep.log', 'index.ts']
function genRule () {
  const r = rnd()
  let core = pick(NAME_ATOMS)
  if (r < 0.15) core = `**/${core}`
  else if (r < 0.3) core = `/**/${core}`
  else if (r < 0.45) core = `/${core}`
  else if (r < 0.55) core = `${pick(NAME_ATOMS)}/${core}`
  else if (r < 0.65) core = `${core}/*`
  else if (r < 0.72) core = `${core}/**`
  else if (r < 0.8) core = `*${core}`
  else if (r < 0.88) core = `${core}*`
  else if (r < 0.94) core = `${core.replace(/^/, '')}?x`
  if (rnd() < 0.3) core += '/'
  if (rnd() < 0.2) core = '!' + core
  return core
}
function genContent () {
  const n = 1 + int(8)
  const lines = []
  for (let i = 0; i < n; i++) {
    const r = rnd()
    if (r < 0.05) lines.push('# comment ' + pick(NAME_ATOMS))
    else if (r < 0.1) lines.push('')
    else if (r < 0.13) lines.push('  ' + genRule() + '  ')
    else if (r < 0.16) lines.push(genRule() + '\r')
    else lines.push(genRule())
  }
  return lines.join('\n')
}
function genPath () {
  const r = rnd()
  if (r < 0.02) return ''
  if (r < 0.04) return '/'
  if (r < 0.06) return pick(SEG_ATOMS)
  const depth = 1 + int(6)
  const parts = []
  for (let i = 0; i < depth; i++) parts.push(pick(SEG_ATOMS))
  let p = parts.join('/')
  if (rnd() < 0.08) p = '/' + p
  if (rnd() < 0.08) p = p + '/'
  if (rnd() < 0.05) p = p.replace(/\//g, '\\')
  return p
}

let cases = 0, mismatches = 0
const samples = []
for (let it = 0; it < ITER; it++) {
  const content = genContent()
  let m, ref
  try { m = compileIgnoreRules(content); ref = refCompile(content) } catch {
    // 两边编译行为不一致（一边抛一边不抛）也算分歧：分别试
    let e1 = null, e2 = null
    try { compileIgnoreRules(content) } catch (e) { e1 = String(e) }
    try { refCompile(content) } catch (e) { e2 = String(e) }
    if ((e1 === null) !== (e2 === null)) { mismatches++; samples.push({ content, kind: 'compile-divergence', e1, e2 }) }
    continue
  }
  const paths = Array.from({ length: 40 }, genPath)
  for (const p of paths) {
    cases++
    let a, b
    try { a = matchPath(m, p) } catch (e) { a = 'THROW:' + e.message }
    try { b = refMatch(ref, p) } catch (e) { b = 'THROW:' + e.message }
    if (a !== b) { mismatches++; if (samples.length < 10) samples.push({ content, path: p, fast: a, ref: b }) }
  }
}
for (const s of samples) console.log('MISMATCH', JSON.stringify(s))
console.log(`FUZZ cases=${cases} mismatches=${mismatches} seed=${flag('seed', 1)}`)
process.exit(mismatches === 0 ? 0 : 1)
