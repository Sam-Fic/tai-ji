/**
 * ResizeObserver 触发归因探针（dev-only，一次性诊断工具）。
 *
 * 背景（问题登记：docs/todo/resize-observer-loop-noise.md）：prod console 每约 60s 出现
 * 一条聚合上报「ResizeObserver loop completed with undelivered notifications xN」——原始
 * 告警由浏览器在帧边界派发、无堆栈，无法归因到具体观察者；已知候选观察点散布在业务
 * composable 与 virtua 库内部，逐点改源码覆盖不到库内部实例。本探针包装全局
 * ResizeObserver 构造器，按「注册点（构造调用栈）」聚合统计每个观察点的回调触发次数，
 * 每 60s 窗输出 top 10，用来回答「哪个 RO 实例高频触发」。
 *
 * **dev-only 契约**：入口 `import.meta.env.DEV` 提前 return——prod 构建时 Vite 把
 * `import.meta.env.DEV` define 替换为 false，函数体经死代码消除整体移除，prod 零执行、
 * 零包装、零开销；调用点（main.ts）随函数体清空一并被 tree-shake。本模块不改任何既有
 * 逻辑：error-reporter 的 RO 聚合分支（isRoLoopNoiseHit / flushRoLoopNoiseAggregate）
 * 保持原样，观察点业务代码零改动。
 *
 * **为什么在构造时取 stack（而非回调执行时）**：RO 回调由浏览器在 rendering steps 的
 * 帧边界以全新调用栈派发，回调执行栈的栈顶是浏览器内部帧、注册点调用链已丢失；`new
 * ResizeObserver(...)` 的构造调用栈顶即注册点——virtua 等库内部 `new ResizeObserver`
 * 与业务代码自有点同规则覆盖（库实例一视同仁，这正是包装全局构造器而非逐点改源码的
 * 原因）。
 *
 * **输出通道 = console.debug（不走 error-reporter 环形缓冲）**：探针输出是诊断信息、
 * 不是错误；error-reporter 的环形缓冲 + 落盘通道（renderer-error-<date>.log）契约是
 * 错误取证，混入诊断统计会污染错误通道且 source 枚举无可承载类型。console.debug 在
 * devtools Console 即时可读，与一次性归因用途匹配，且零接线、零风险。
 *
 * **统计口径 = 按注册点聚合**：同一注册点可能创建多个实例（每次组件 mount 一个），
 * 逐实例输出 top N 会被同一点的多实例占满；按注册点聚合输出「窗口内回调次数 + 窗口内
 * 新建实例数」，直接指向触发源。
 */
const PROBE_LOG_PREFIX = '[ro-probe]'

/** 聚合窗时长（毫秒）：与 error-reporter 的 RO 聚合窗同时长（RO_LOOP_AGGREGATE_WINDOW_MS），便于两个输出对照。 */
const PROBE_WINDOW_MS = 60_000

/** 聚合窗时长（秒）：输出文案显示用（上一常量的秒制值，改窗长时两处同改）。 */
const PROBE_WINDOW_S = 60

/** 每窗输出的高频注册点条数。 */
const PROBE_TOP_N = 10

/**
 * 探针自身帧识别串：stack 帧 URL 含该串的帧属探针自身（构造器帧 + `new` 调用帧），
 * 解析注册点时跳过。必须带 `/` 前缀与 `:` 后缀的精确形态——单用文件名子串会把同
 * 前缀的测试文件（`resize-observer-probe.test.ts`）注册点帧误判为自身帧（实测踩中）。
 * dev 下为源文件名；prod 下探针整体被裁剪，无 prod 形态。源文件改名时同步改本常量。
 */
const PROBE_FILE_MARK = '/resize-observer-probe.ts:'

/**
 * stack 帧定位串：形如 `at <loc>:<line>:<col>` 或 `at fn (<loc>:<line>:<col>)`。
 * loc 覆盖三种实机形态：Node/vitest 绝对路径（`/path/file.ts`）、ESM（`file:///path`）、
 * Chromium dev（`http://localhost:<port>/src/...` 或预构建 chunk）。
 * 捕获组 1 = 干净的 `loc:line:col`（不含包裹括号，括号留给行尾边界组）。
 */
const STACK_FRAME_RE = /(?:\(|\s)(\S*\/\S*?:\d+:\d+)(?:\)|\s|$)/

/** 单注册点统计（窗内计数，flush 后清零）。 */
type RoSiteStat = {
  /** 窗口内该注册点的 RO 回调触发总次数。 */
  calls: number
  /** 窗口内该注册点创建的 RO 实例数。 */
  instances: number
  /** 注册点定位串（文件:行:列），解析失败为兜底串。 */
  site: string
}

/**
 * 注册点统计表（key = site）；模块级，跨实例共享。
 * taste:allow-no-data-owner — dev-only 诊断计数缓存（非 GUI 数据源），例外登记见
 * docs/architecture/data-source-registry.md §4 ㉒；随探针退役一并删除。
 */
const siteStats = new Map<string, RoSiteStat>()

/** 安装幂等标记（HMR 重复执行安装函数时不重复包装）。 */
let installed = false

/**
 * 安装探针。main.ts 在 createApp 后、mount 前调用（早于任何组件创建——组件里的
 * `new ResizeObserver` 才走得到包装后的全局构造器）。dev-only：prod 下入口即 return。
 */
export function installResizeObserverProbe(): void {
  // dev-only 裁剪点：prod 构建 define 替换 + 死代码消除后函数体整体移除（零执行零开销）
  if (!import.meta.env.DEV) return
  if (installed) return
  // 无 RO 的环境（happy-dom 等非浏览器宿主 / SSR）不装，保持环境原状
  if (typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') return
  installed = true

  const OriginalResizeObserver = window.ResizeObserver

  class InstrumentedResizeObserver extends OriginalResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      // 注册点取构造调用栈：首帧（本构造器）与 `new` 调用帧均含探针文件名，跳过；
      // 第一个非探针帧即 `new ResizeObserver(...)` 的调用点（业务点或库内部点）
      const site = parseRegistrationSite(new Error().stack)
      const stat = siteStats.get(site) ?? { calls: 0, instances: 0, site }
      stat.instances += 1
      siteStats.set(site, stat)
      super((entries, observer) => {
        stat.calls += 1
        // 透传语义与未包装完全一致：entries / observer 原样交付，回调抛错行为不变
        // （错误照常走 window-onerror → error-reporter，不吞不错）
        callback(entries, observer)
      })
    }
  }

  window.ResizeObserver = InstrumentedResizeObserver
  // observe / unobserve / disconnect / takeRecords 继承自原构造器，行为不变；
  // extends 原类同时保证 `instanceof ResizeObserver` 检查不破

  console.debug(
    `${PROBE_LOG_PREFIX} installed (dev-only): per-registration-site callback counters, ` +
      `${PROBE_WINDOW_S}s window, top ${PROBE_TOP_N} by callback count`,
  )
  setInterval(flushProbeWindow, PROBE_WINDOW_MS)
}

/** 解析构造 stack 的注册点定位串；解析失败返回兜底串（不抛错——探针零抛错契约）。 */
function parseRegistrationSite(stack: string | undefined): string {
  if (stack === undefined) return '(no stack)'
  for (const line of stack.split('\n')) {
    const match = STACK_FRAME_RE.exec(line)
    if (!match) continue
    const frame = match[1]
    if (frame.includes(PROBE_FILE_MARK)) continue // 探针自身帧
    return frame
  }
  return '(unresolved registration site)'
}

/** 窗尾输出 top N 注册点（按回调次数降序，一行一条）并原地清零窗内计数；空窗不输出。 */
function flushProbeWindow(): void {
  // 只输出窗内有回调的注册点（calls>0）；零调用条目留在表内但不出声（空窗不输出语义）。
  const active = [...siteStats.values()].filter((s) => s.calls > 0)
  if (active.length === 0) return
  const top = active.sort((a, b) => b.calls - a.calls).slice(0, PROBE_TOP_N)
  for (const [index, stat] of top.entries()) {
    console.debug(
      `${PROBE_LOG_PREFIX} ${PROBE_WINDOW_S}s window #${index + 1}: ` +
        `${stat.calls} callbacks, ${stat.instances} instance(s), from ${stat.site}`,
    )
  }
  // 原地清零（保留对象身份，禁 clear()）：包装回调闭包持有 stat 对象引用——clear() 会把
  // 长生命周期实例（virtua 等）的后续计数甩进脱离 Map 的孤立对象，第二窗起这些注册点
  // 永久零上报且无告警（dev-merge round1 must-fix）。instances 同步归零 = 「窗口内新建
  // 实例数」口径逐窗重算。
  for (const stat of siteStats.values()) {
    stat.calls = 0
    stat.instances = 0
  }
}
