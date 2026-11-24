/**
 * shared/ignore-parser.ts — .gitignore 规则编译 + 路径匹配纯函数（⑤code-arch §3，#1 D-013）
 *
 * 纯函数范式（D-013：仿 git-status-parser 豁免，不包 port）。放 shared 非 infra——纯函数无 IO/无外部依赖。
 * FileService 经 IFileExecutor.readFile 读 .gitignore 内容（IO 走 port），再调本纯函数匹配（计算走 shared）。
 *
 * 双模式（D-020）：matchPath 纯函数本身不变。FileService 编排层分双模式——
 *   默认隐藏（matchPath=true 的节点移除）/ 显示模式（保留 + 标 ignored=true）。
 *
 * 接线层级：[叶子] 纯函数。
 * 不变式：无 node:fs import（AC-1.3 grep 验证）；无外部依赖；不 import any（用具体类型）。
 */

/**
 * ignore 规则匹配器（编译后的中间表示）。
 * 不暴露内部结构，外部只通过 matchPath 使用。
 */
export interface IgnoreMatcher {
  /** 内部规则集（实现细节，外部不访问） */
  readonly rules: IgnoreRule[]
}

/**
 * [B4] 无「跨斜杠通配」规则的段级快路径判据（matchPath 据此跳过 regex.test）。
 *
 * 覆盖三类形态（其余形态——多星号、星号两侧含 /、`**` 跨目录、`?` 通配——恒为
 * null 走 regex 路径）：
 * - 字面量（star=false）：prefix === suffix === 完整字面量，段判据 = 整段相等；
 * - 单星号（star=true）：原始 pattern = prefix + '*' + suffix（`*` 恰一个，且两侧
 *   均不含 '/'），段判据 = 段以 prefix 开头、以 suffix 结尾、长度 ≥ 两者之和
 *   （`[^/]*` 可匹配空串，故长度下限不可省）；
 * - 前置双星加斜杠的字面量（double-star-slash 前缀，含前置斜杠形态）：git 语义 ≡
 *   非锚定字面量（gitignore 文档明示：该前缀与其后的字面量等价），故记
 *   star=false + anchored=false。
 *
 * anchored 为「有效锚定」（快路径语义），与 IgnoreRule.anchored（regex 形态）可能
 * 不同——前置斜杠加双星斜杠形态的 regex 是锚定形态，但其中「点星加斜杠」可选组
 * 已可吸收任意目录前缀，段判据按非锚定处理（等价性由 oracle 测试锁定）。
 */
export interface IgnoreFastPath {
  /** 星号左侧字面（star=false 时 = 完整字面量） */
  readonly prefix: string
  /** 星号右侧字面（star=false 时 = 完整字面量） */
  readonly suffix: string
  /** 是否单星号形态（false = 整段相等） */
  readonly star: boolean
  /** 有效锚定：true = 仅首段可命中；false = 任意段 */
  readonly anchored: boolean
}

/** 单条 ignore 规则（.gitignore 语法子集） */
export interface IgnoreRule {
  /** 原始 pattern */
  readonly pattern: string
  /** 是否取反（! 前缀） */
  readonly negated: boolean
  /** 是否仅匹配目录（/ 后缀） */
  readonly dirOnly: boolean
  /** 是否锚定到根（含 / 或 * 通配） */
  readonly anchored: boolean
  /** 编译后的正则 */
  readonly regex: RegExp
  /**
   * [B4] 段级快路径判据；null = 走 regex 逐前缀路径。非 null 时 matchPath 用
   * fastRuleMatches（字符串/段比较）替代 regex.test——逐字节等价（oracle 测试：
   * domains-bundle.test.ts「literal fast path equivalence」套件，语料含仓库真实
   * .gitignore × 真实路径采样）。含反斜杠的 pattern 不进快路径（保守走 regex）。
   */
  readonly fast: IgnoreFastPath | null
}

/**
 * 编译 .gitignore 内容为匹配器（纯函数，不读文件）。
 *
 * 支持的 .gitignore 语法子集（D-013）：
 * - 空行/注释（#）→ 跳过
 * - ! 取反
 * - / 末尾 → 仅目录
 * - / 开头或含 / → 锚定到根
 * - * 单层通配、** 多层通配
 * - 普通名字 → 匹配任意层级
 *
 * @param content .gitignore 文件内容
 * @returns 匹配器（content 为空 → 空 matcher，matchPath 永远返回 false）
 */
export function compileIgnoreRules(content: string): IgnoreMatcher {
  const rules: IgnoreRule[] = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => compileRule(line))
  return { rules }
}

/**
 * 编译单条规则为 IgnoreRule。
 * 规范化：去掉两端空白；处理 ! 取反前缀；处理末尾 / 目录标志；处理锚定。
 */
function compileRule(rawLine: string): IgnoreRule {
  let line = rawLine
  // 1. 取反标志（! 前缀）
  const negated = line.startsWith('!')
  if (negated) {
    line = line.slice(1)
  }
  // 2. 目录后缀（末尾 /）→ 仅匹配目录
  const dirOnly = line.endsWith('/')
  if (dirOnly) {
    line = line.slice(0, -1)
  }
  // 3. 锚定判定：
  //    - 开头 / → 锚定根，去掉前导 /
  //    - 内部含 /（非末尾）→ 锚定根（相对根路径）
  let anchored = false
  if (line.startsWith('/')) {
    anchored = true
    line = line.slice(1)
  } else if (line.includes('/')) {
    anchored = true
  }
  // 4. 编译为正则
  const regex = globToRegex(line, anchored)
  // [B4] 段级快路径判据（matchPath 用 fastRuleMatches 替代 regex.test，语义逐字节
  // 等价——oracle 测试锁定）。仅覆盖「无跨斜杠通配」的三类形态：
  //   ① 字面量（无 * / ?）：段判据 = 整段相等；
  //   ② 单星号（恰一个 *，两侧不含 / 与 ?）：段判据 = startsWith(prefix) && endsWith(suffix)
  //      && 长度 ≥ 两者之和（`[^/]*` 可空）；
  //   ③ `**/字面量` / `/**/字面量`（rest 不再含 * ? /）：git 语义 ≡ 非锚定字面量。
  // 其余形态（多星号 / 星号两侧含 / / `**` 跨目录 / `?` / 空串 / 含反斜杠）恒 null。
  const fast = computeFastPath(line, anchored)
  return { pattern: rawLine, negated, dirOnly, anchored, regex, fast }
}

/**
 * [B4] 计算段级快路径判据（null = 不可快路径化，走 regex 逐前缀路径）。
 * 判据推导（与 globToRegex 产出的 regex 逐前缀求值等价）：
 * - 字面量 L（无通配）：regex 为 `^L$` / `(?:^|/)L$`（元字符已转义 ⇒ 纯字面匹配）；
 *   前缀 X 命中 ⇔ X === L 或 X 以 '/'+L 结尾 ⇔ L 是 path 的某个段（锚定时 regex 的
 *   `^` 要求 X 无 '/' 之外的约束不成立——X === L 本身可含 '/'，故锚定判据用整串
 *   前缀比较 path === L || path.startsWith(L + '/')，见 fastRuleMatches）。
 * - 单星号 P1*P2（无 '/' 无 '?'）：regex 段形态 `P1[^/]*P2`，`[^/]*` 不跨斜杠 ⇒
 *   只需段级 startsWith/endsWith；锚定时 X 必须整体无 '/' ⇒ 仅首段可命中。
 * - 前置双星加斜杠的 L：regex = 可选「任意目录前缀」组 + 转义后 L（前置斜杠形态的
 *   行首锚被该可选组吸收）⇒ X === L 或 X 以 '/'+L 结尾 ⇒ 与非锚定字面量同。
 */
function computeFastPath(line: string, anchored: boolean): IgnoreFastPath | null {
  if (line.length === 0 || line.includes('?') || line.includes('\\')) return null
  const starCount = line.split('*').length - 1
  if (starCount === 0) {
    return { prefix: line, suffix: line, star: false, anchored }
  }
  if (starCount === 1 && !line.includes('/')) {
    const starAt = line.indexOf('*')
    return {
      prefix: line.slice(0, starAt),
      suffix: line.slice(starAt + 1),
      star: true,
      anchored,
    }
  }
  // `**/L` 或 `/**/L`（compileRule 已剥前导 '/'，故此处 line 以 `**/` 开头）；
  // rest 含 '/' 时（如 `**/foo/bar`）regex 是「末两段」匹配而非单段相等，不快路径化。
  if (line.startsWith('**/')) {
    const rest = line.slice(3)
    if (rest.length > 0 && !/[*?/]/.test(rest)) {
      return { prefix: rest, suffix: rest, star: false, anchored: false }
    }
  }
  return null
}

/** 正则元字符集合（表驱动）：命中则转义输出，未命中原样拼接——与原逐 case 转义逐字节等价。 */
const REGEX_META_CHARS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])

/**
 * 将 gitignore glob pattern 转为 RegExp。
 *
 * @param pattern 已去除取反前缀/目录后缀/锚定前导斜杠的 pattern
 * @param anchored 是否锚定到根（true → 从根开始匹配；false → 匹配任意路径段开始）
 *
 * 转义规则（伪代码，注意勿在块注释中出现块注释的结束序列）：
 * - 双星号加斜杠 → (.*  斜杠)?（零或多层目录前缀）
 * - 斜杠加双星号 → ( 斜杠 .*)?$（末尾多层）
 * - 双星号 → .*（跨目录）
 * - 单星号 → [^ 斜杠]*（单层，不跨分隔符）
 * - 问号 → [^ 斜杠]（单字符）
 * - 其余正则元字符转义（REGEX_META_CHARS 表驱动）
 */
function globToRegex(pattern: string, anchored: boolean): RegExp {
  // glob 多字符 token 的字符长度（用于游标偏移与推进）
  const DOUBLE_STAR_LEN = 2 // '**' 双星通配占 2 字符
  const DOUBLE_STAR_SLASH_LEN = 3 // '**/' 双星加斜杠占 3 字符
  // 逐字符构建正则源（避免 replace 链顺序问题：** 必须在 * 之前处理）
  let regexSrc = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    // ** 匹配（跨目录）
    if (ch === '*' && pattern[i + 1] === '*') {
      // **/ → 匹配零或多个目录前缀（含末尾 /）
      if (pattern[i + DOUBLE_STAR_LEN] === '/') {
        regexSrc += '(?:.*/)?'
        i += DOUBLE_STAR_SLASH_LEN
        continue
      }
      // /** 末尾 → 整段剩余
      regexSrc += '.*'
      i += DOUBLE_STAR_LEN
      continue
    }
    switch (ch) {
      case '*':
        regexSrc += '[^/]*'
        break
      case '?':
        regexSrc += '[^/]'
        break
      default:
        // 正则元字符转义（'*'/'?' 已在上方分支与 '**' 拦截中处理，不会落入此处）
        regexSrc += REGEX_META_CHARS.has(ch) ? '\\' + ch : ch
    }
    i += 1
  }
  // 锚定：anchored → 从根（^pattern），非锚定 → 匹配任意路径段开始（^|.*/）
  // 用 (?:^|/) 作为前缀，使非锚定规则能匹配 'node_modules/pkg' 中的 'node_modules' 段。
  const prefix = anchored ? '^' : '(?:^|/)'
  const suffix = '$'
  return new RegExp(prefix + regexSrc + suffix)
}

/**
 * 判断路径是否被 ignore 规则匹配（纯函数）。
 *
 * @param matcher 编译后的匹配器
 * @param path 待检测路径（相对路径，不含前导斜杠，如 'src/index.ts'）
 * @returns 最后一条匹配规则是正向（非取反）→ true（被忽略）
 *
 * 语义对齐 git：多条规则按顺序求值，最后匹配的规则决定结果（取反覆盖正向）。
 *
 * 匹配策略（gitignore 核心语义）：
 * - 对路径的所有祖先前缀（含自身）逐一测试规则。
 *   例：'a/b/c' → 测试 'a/b/c'、'a/b'、'a'。
 * - 某规则匹配某祖先前缀 X：
 *   - 非 dirOnly 规则：X == 路径（文件/目录自身命中）或 X 是路径的严格前缀（目录命中，其下所有内容被忽略）→ 匹配。
 *   - dirOnly 规则：仅当 X 是路径的严格前缀（X 是目录，路径在其下），或 X == 路径且路径以分隔符结尾（目录自身）。
 *   （gitignore: `foo` 匹配文件或目录；`foo/` 仅匹配目录及其内容。）
 *
 * [B4] 双通道求值：可快路径化的规则（fast !== null，字面量 / 单星号无斜杠 /
 * 前置双星加斜杠字面量 三形态）走 fastRuleMatches（段级字符串比较），其余走原 regex 逐前缀
 * 路径（ruleMatchesPath）。两通道对同一 (rule, path) 的结果逐字节等价（oracle 测试：
 * domains-bundle.test.ts「literal fast path equivalence」套件）；规则扫描序与
 * last-match-wins 不受通道选择影响。
 */
export function matchPath(matcher: IgnoreMatcher, path: string): boolean {
  // 规范化路径：去前导斜杠、去末尾分隔符
  const normalized = normalizePath(path)
  // 段数组（空段过滤，与 allPrefixes 内部口径一致）；短路径（≤1 段）时即前缀数组本身，
  // 省一次 split/join（D7-2 直通语义：无 '/' 路径只有自身一个前缀）。
  // 空串（W24 审查 A-2）：segments = [] → prefixes = [] → 恒 false，保持旧语义。
  const segments = normalized === '' ? [] : normalized.split('/').filter((s) => s.length > 0)
  const prefixes = segments.length <= 1 ? segments : prefixesOf(segments)
  // [B4] coverage 预计算（每调用一次）：前缀 X_k = 段 0..k 的 join（折叠空段，与 allPrefixes
  // 同口径），对**原始归一化路径**判 isSelf / isAncestorDir——与 regex 路径的 ruleMatchesPath
  // 判据逐字节一致。路径含连续斜杠（'a//b'）时折叠前缀与原串错位，coverage 为 false，
  // 这是改造前既有行为，快路径必须保持（修剪模糊探针抓到的漂移点）。
  const needsCoverage = matcher.rules.some((r) => r.fast !== null)
  const cov = needsCoverage ? coverageOf(segments, normalized) : EMPTY_COVERAGE
  let ignored = false
  for (const rule of matcher.rules) {
    // 任一祖先前缀命中该规则 → 该规则对整条路径生效
    const hit = rule.fast !== null
      ? fastRuleMatches(rule.fast, rule.dirOnly, normalized, segments, cov)
      : prefixes.some((prefix) => ruleMatchesPath(rule, prefix, normalized))
    if (hit) {
      ignored = !rule.negated
    }
  }
  return ignored
}

/** coverage 表：cov.self[k] / cov.ancestor[k] 为前缀「段 0..k」是否覆盖 path（isSelf / isAncestorDir）。 */
interface Coverage {
  readonly self: boolean[]
  readonly ancestor: boolean[]
}
const EMPTY_COVERAGE: Coverage = { self: [], ancestor: [] }

function coverageOf(segments: string[], path: string): Coverage {
  const self: boolean[] = []
  const ancestor: boolean[] = []
  let prefix = ''
  for (let k = 0; k < segments.length; k += 1) {
    prefix = k === 0 ? segments[0]! : prefix + '/' + segments[k]!
    // 免拼接判据：path === prefix ⟔ 等长且 startsWith；path.startsWith(prefix + '/') ⟔ startsWith 且下一字符为 '/'
    const starts = path.startsWith(prefix)
    self.push(starts && path.length === prefix.length)
    ancestor.push(starts && path.length > prefix.length && path.charCodeAt(prefix.length) === 47 /* '/' */)
  }
  return { self, ancestor }
}

/**
 * [B4] 段级快路径匹配——与 regex 逐前缀求值逐字节等价（oracle 测试 + 修剪模糊探针锁定）：
 * - 非锚定字面量（regex `(?:^|/)L$`）：前缀 X_k 命中 ⇔ X_k 的末段 === L；coverage 用预计算表
 *   （isSelf / isAncestorDir 对原始路径判，保留连续斜杠怪癖）。
 * - 非锚定单星号（regex `(?:^|/)P1[^/]*P2$`）：末段 startsWith(P1) && endsWith(P2) && 长度 ≥ 两者之和。
 * - 锚定字面量（regex `^L$`，L 可含 '/'）：X === L；coverage = path === L 或 path 以 L+'/' 开头。
 * - 锚定单星号（regex `^P1[^/]*P2$`，P1/P2 无 '/'）：命中的 X 必须整体无 '/' ⇒ X = 首段；
 *   coverage 对原始路径判。
 * - 前置双星加斜杠形态（fast.anchored=false 的字面量）：regex 行首锚被「任意目录前缀」
 *   可选组吸收 ⇒ 与非锚定字面量同（gitignore 文档同结论）。
 * dirOnly 仅认严格祖先（self 不命中）；归一化后路径恒不含反斜杠，含反斜杠的 pattern 不进快路径。
 */
function fastRuleMatches(fast: IgnoreFastPath, dirOnly: boolean, path: string, segments: string[], cov: Coverage): boolean {
  if (fast.anchored) {
    if (!fast.star) {
      // 锚定字面量（可含 '/'）：^L$ 只命中 X === L
      if (path === fast.prefix) return !dirOnly // isSelf；dirOnly 不匹配目录自身名
      return path.startsWith(fast.prefix + '/') // isAncestorDir
    }
    // 锚定单星号：命中的前缀 X 必须整体无 '/' ⇒ X = 首段
    if (segments.length === 0 || !segMatchesStar(fast, segments[0]!)) return false
    if (cov.ancestor[0]) return true // isAncestorDir（对原始路径判，保留连续斜杠怪癖）
    return cov.self[0] && !dirOnly // isSelf；dirOnly 不匹配目录自身名
  }
  // 非锚定：任一前缀 X_k 末段命中且覆盖 path；dirOnly 仅认严格祖先
  for (let k = 0; k < segments.length; k += 1) {
    if (!(dirOnly ? cov.ancestor[k] : cov.self[k] || cov.ancestor[k])) continue
    if (fast.star ? segMatchesStar(fast, segments[k]!) : segments[k] === fast.prefix) return true
  }
  return false
}

/** 单星号段判据：段以 prefix 开头、以 suffix 结尾、长度 ≥ 两者之和（`[^/]*` 可匹配空串）。 */
function segMatchesStar(fast: IgnoreFastPath, seg: string): boolean {
  return seg.length >= fast.prefix.length + fast.suffix.length
    && seg.startsWith(fast.prefix)
    && seg.endsWith(fast.suffix)
}

/**
 * 判断单条规则是否对「prefix 命中 → 整条 path 被忽略」成立。
 *
 * @param rule 规则
 * @param prefix 当前测试的祖先前缀（path 的前缀之一）
 * @param path 完整路径（规范化后）
 *
 * 规则：
 * - regex 必须匹配 prefix（锚定/非锚定由 regex 内的 prefix 处理）。
 * - 非 dirOnly：prefix == path（命中自身）或 prefix 是 path 的目录前缀（prefix + '/' 是 path 前缀）→ 命中。
 * - dirOnly：仅当 prefix 是 path 的目录前缀（prefix + '/' 是 path 前缀）→ 命中（目录内容）。
 *   prefix == path 时不命中（dirOnly 不匹配同名文件，build/ 不匹配名为 build 的文件）。
 */
function ruleMatchesPath(rule: IgnoreRule, prefix: string, path: string): boolean {
  if (!rule.regex.test(prefix)) return false
  // prefix 命中 regex 后，判断 prefix 是否覆盖 path：
  // - prefix == path：规则命中路径自身（文件/目录）
  // - prefix 是 path 的祖先目录：prefix 下所有内容被忽略
  const isSelf = prefix === path
  const isAncestorDir = path.startsWith(prefix + '/')
  if (rule.dirOnly) {
    // 目录规则：仅匹配目录（祖先目录覆盖），不匹配同名文件（isSelf 不算）
    return isAncestorDir
  }
  return isSelf || isAncestorDir
}

/**
 * 规范化路径：去前导/末尾斜杠与多余分隔符，统一为正斜杠。
 */
function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/')
  p = p.replace(/^\/+/, '').replace(/\/+$/, '')
  return p
}

/**
 * 生成路径的所有祖先前缀（含自身），从深到浅。
 * 例：['a','b','c'] → ['a/b/c', 'a/b', 'a']；['x'] → ['x']。
 * 入参为已过滤空段的段数组（与 matchPath 的 segments 同口径，避免重复 split）。
 */
function prefixesOf(segments: string[]): string[] {
  const result: string[] = []
  for (let end = segments.length; end >= 1; end -= 1) {
    result.push(segments.slice(0, end).join('/'))
  }
  return result
}

/**
 * 生成路径的所有祖先前缀（含自身），从深到浅。
 * 例：'a/b/c' → ['a/b/c', 'a/b', 'a']；'x' → ['x']。
 */
function allPrefixes(path: string): string[] {
  const segments = path.split('/').filter((s) => s.length > 0)
  return prefixesOf(segments)
}
