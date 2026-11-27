#!/usr/bin/env node
/**
 * check-animation-source-guards.mjs —— 动画源码静态守卫（12 条判据）。
 *
 * 拦什么（判据来源：plan 04 删除常驻装饰性动画 / plan 05 reduced-motion 兜底细化
 * + TaijiLogo 检查生效 / plan 06 pending 死类修复）：
 *   - 常驻装饰性动画零残留（pulse-dot / steer-breathe / wiggle）与死类 animate-bounce-small
 *   - pending / retrying / streaming / compacting / working / waiting 各状态 animation 字段形态
 *   - SegmentedTab 文字 tab 形态（无 badge / 无 count 数字 / 无 motion-reduce 动画类）
 *   - SessionItem running 态为静态 accent 空心环（2026-11 常驻动画退役）
 *   - composer-shell isActive 分支静态 ring（无动画装饰）
 *   - TaijiLogo 静态类 + inline 时长覆盖形态（Tailwind JIT 可生成），SVG 几何未变
 *   - style.css reduced-motion 块 !important 白名单 + @keyframes 定义存在
 *
 * 为什么是脚本而不是 vitest 用例：整套判据都是「读源码字符串断言」，不验证任何运行时
 * 行为，也不构造模块图；放测试套件里每个用例只为 per-file 装载付固定成本。判据与阈值
 * 逐条原样承接（原 `.test.ts` 的 12 条断言一一对应本文件的 12 条检查）。
 *
 * [HISTORICAL] 2026-11 性能裁决修订 5 条判据（原判据断言 animate-spin 常驻，与本批「常驻
 * 装饰动画退役」直接冲突）：plan06/TC1 pending 放宽到 pulse-strong 家族（量化版）；
 * plan06/TC3 + plan04/TC4/T5 的 working/compacting 从 animate-spin 改静态空串；
 * plan04/TC2 SessionItem running 从「保留 animate-spin」改为「静态空心环且禁 animate-spin」。
 * 实体实现证据 = 打包版 GPU helper 54-60% + renderer 85%（dev 消融全停掉到 1/6）。
 *
 * 用法：node scripts/check-animation-source-guards.mjs
 * 退出码：0 = 全部通过；1 = 命中违规；2 = 环境错误（被读文件缺失）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = join(ROOT, 'packages/renderer')

const read = (rel) => readFileSync(resolve(RENDERER, rel), 'utf-8')

const sessionStatus = read('src/composables/logic/sessionStatus.ts')
const tailwindConfig = read('tailwind.config.ts')
const styleCss = read('src/style.css')
const taijiLogo = read('src/components/icons/TaijiLogo.vue')
const segmentedTab = read('src/components/sidebar/SegmentedTab.vue')
// SessionItem 按职责块拆子组件（session-item/ 子目录），旋转 icon 实现物理在
// SessionItemDisplay.vue——断言对象聚合「主组件 + 子组件目录」，跟随实现位置。
const sessionItem = [
  read('src/components/sidebar/SessionItem.vue'),
  ...readdirSync(resolve(RENDERER, 'src/components/sidebar/session-item')).map((f) =>
    read(`src/components/sidebar/session-item/${f}`),
  ),
].join('\n')
const composerShell = read('src/composables/panel/composer-shell.ts')

const PULSE_ANIM = 'animate-[pulse-dot_1.8s_ease-in-out_infinite]'

/** 递归收集 src/components 下所有 .vue 文件（reduced-motion 局部检查扫描用） */
function collectVueFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectVueFiles(full, acc)
    else if (entry.endsWith('.vue')) acc.push(full)
  }
  return acc
}

const problems = []
/** 单条判据：cond=false 时记一条违规（带判据名与期望说明） */
let checksRun = 0
function check(id, cond, expectation) {
  checksRun++
  if (!cond) problems.push(`${id}：${expectation}`)
}

// ── plan 06 pending 死类修复 ────────────────────────────────────────────────
check(
  'plan06/TC1 pending 使用 animate-pulse-strong 家族',
  // [perf:animation] 2026-11 裁决修订：pending / retrying 从 animate-pulse-strong 改为
  // animate-pulse-strong-quantized（steps(4) 量化）——两者动画目标都是 <svg>（Chromium
  // 不合成 SVG transform），逐帧 opacity+scale 重绘；量化后重建频率降到 4 段而语义不变。
  // 判据放宽为「必须属于 pulse-strong 家族」（原逐字断言 animate-pulse-strong 已失效）。
  /animation: 'animate-pulse-strong[a-z-]*'/.test(sessionStatus)
    && sessionStatus.includes("pending: { icon: 'ArrowUpCircle', color: 'text-accent', animation: 'animate-pulse-strong-quantized' }"),
  "sessionStatus.ts 的 pending 应为 animate-pulse-strong-quantized（ArrowUpCircle / text-accent）",
)
check(
  'plan06/TC2 死类 animate-bounce-small 零残留',
  !sessionStatus.includes('animate-bounce-small'),
  'sessionStatus.ts 不得含 animate-bounce-small（死类已清理）',
)
check(
  'plan06/TC3 各状态 animation 字段形态（2026-11 性能裁决）',
  // [perf:animation] 裁决修订：working / compacting 为「后台任务生命周期（分钟-小时）」的
  // 常驻态，从 animate-spin 改静态（实测常驻动画是风扇根因，全停掉到 1/6）。streaming 是
  // 秒-分钟的真实流式且用户预期在转，保留 spin（现由 PanelHeader 的 HTML 包装层承担）。
  sessionStatus.includes("streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    && sessionStatus.includes("compacting: { icon: 'Hourglass', color: 'text-accent', animation: '' }")
    && sessionStatus.includes("working: { icon: 'Loader2', color: 'text-accent', animation: '' }")
    && sessionStatus.includes("retrying: { icon: 'Zap', color: 'text-warn', animation: 'animate-pulse-strong-quantized' }")
    && sessionStatus.includes("waiting: { icon: 'Wrench', color: 'text-warn', animation: '' }")
    && !tailwindConfig.includes('bounce-small')
    && !styleCss.includes('bounce-small'),
  'streaming 保留 animate-spin；working(Loader2)/compacting(Hourglass) 改静态空串且字形互异（常驻态降级 + 静态可区分，分支审查 arch-boundary M3）；retrying 量化；waiting 空串；config/style 不得新增 bounce-small',
)

// ── plan 05 reduced-motion 兜底 + TaijiLogo ────────────────────────────────
check(
  'plan05/TC1 logo spin 挂 HTML 包装层 + 合成层提升（2026-11 性能裁决：SVG transform 动画不被 Chromium 合成，挂 svg 本体每帧主线程重绘 idle CPU ~30%）',
  taijiLogo.includes(":class=\"spin ? 'animate-taiji-spin' : ''\"")
    && taijiLogo.includes(":style=\"spin ? { animationDuration: `${duration}s`, willChange: 'transform' } : undefined\"")
    && taijiLogo.includes('class="block shrink-0 motion-reduce:animate-none"')
    && tailwindConfig.includes("'taiji-spin': 'taiji-spin 8s linear infinite'"),
  'TaijiLogo 旋转动画须挂在 HTML 包装 div（非 svg 本体）+ willChange:transform；静态类 animate-taiji-spin + inline animationDuration 覆盖保留，config 注册 taiji-spin 简写保留',
)
check(
  'plan05/TC2 style.css reduced-motion 白名单保留',
  // [HISTORICAL] 2026-11 分支审查 arch-boundary M1：原断言对全文 includes，被同批新增的
  // [data-reduce-motion="on"] 块（逐字相同的声明）冒充——整段删掉 OS 媒体查询仍全绿。
  // 改为锚定 @media 块内部：先定位块头，截到下一个顶层 '}' 为止再逐条断言。
  (() => {
    const head = styleCss.indexOf('@media (prefers-reduced-motion: reduce)')
    if (head < 0) return false
    const tail = styleCss.indexOf('transition-duration: var(--duration-fast) !important;', head)
    if (tail < 0) return false
    const block = styleCss.slice(head, styleCss.indexOf('}', tail))
    return block.includes('transition-property: opacity, color, background-color, border-color, fill, stroke, box-shadow, filter !important')
      && block.includes('transition-duration: var(--duration-fast) !important')
      && block.includes('animation-duration: 0.01ms !important')
      && block.includes('animation-iteration-count: 1 !important')
      && block.includes('transition-duration: 0.01ms !important')
      && block.includes('transition-delay: 0ms !important')
  })(),
  'reduced-motion 块的 !important 过渡白名单与瞬切兜底须完整保留（锚定 @media 块内部，不受同批属性选择器块冒充）',
)
check(
  'plan05/TC5 应用内 [data-reduce-motion="on"] 块与 OS 媒体查询声明逐字同步',
  // [HISTORICAL] 2026-11 分支审查 arch-boundary S2：两条触发通道（OS 媒体查询 / 应用开关）
  // 各持一份同语义声明，CSS 无法 OR 合并，故用机器断言锁「两侧声明串逐字相等」——
  // 任何一侧单独改动（漏同步）即红。
  (() => {
    const media = styleCss.indexOf('@media (prefers-reduced-motion: reduce)')
    const attr = styleCss.indexOf('[data-reduce-motion="on"] *,')
    if (media < 0 || attr < 0) return false
    // 两块均以白名单声明收尾：块尾锚到该声明后的首个 '}'（不能锚首个 '\n}' ——属性块的
    // 内层规则 '}' 顶格，会在第一个规则后截断）
    const decls = (from) => {
      const tail = styleCss.indexOf('transition-duration: var(--duration-fast) !important;', from)
      const end = styleCss.indexOf('}', tail)
      return styleCss.slice(from, end)
        .split('\n').map((l) => l.trim()).filter((l) => /^[a-z-]+:/.test(l)).sort().join('\n')
    }
    const mediaBlock = decls(media)
    const attrBlock = decls(attr)
    return mediaBlock.length > 0 && mediaBlock === attrBlock
  })(),
  '应用内 reduce-motion 块的声明集必须与 OS 媒体查询块逐字相等（两通道单点维护）',
)
{
  const otherGuards = collectVueFiles(resolve(RENDERER, 'src/components'))
    .filter((f) => !f.endsWith('TaijiLogo.vue'))
    .filter((f) => readFileSync(f, 'utf-8').includes('motion-reduce:animate-none'))
  check(
    'plan05/TC3 spin 默认值 + SVG 几何 + 其他组件局部检查保留',
    taijiLogo.includes('spin: true')
      && taijiLogo.includes('duration: 8')
      && taijiLogo.includes('viewBox="0 0 1200 1200"')
      && taijiLogo.includes('d="M3655 9803 c-107 -15 -300 -61 -489 -118')
      && (taijiLogo.match(/<path d="/g) ?? []).length === 6
      && otherGuards.length > 0,
    'TaijiLogo 默认 spin=true / duration=8 / viewBox 与 6 条 path 不得变（注：侧栏 Brand 消费方传 spin=false——常驻旋转 2026-11 性能裁决退役）；其他组件须至少保留一处 motion-reduce:animate-none',
  )
}
check(
  'plan05/TC4 @keyframes taiji-spin 定义存在',
  styleCss.includes('@keyframes taiji-spin'),
  'style.css 须保留 @keyframes taiji-spin（animate-taiji-spin 引用有效）',
)

// ── plan 04 删除常驻装饰性动画 ──────────────────────────────────────────────
check(
  'plan04/TC1 SegmentedTab 文字 tab 形态',
  !segmentedTab.includes(PULSE_ANIM)
    && !segmentedTab.includes('motion-reduce:animate-none')
    && !segmentedTab.includes('absolute right-1 top-1 size-[7px] rounded-full bg-accent')
    && !segmentedTab.includes('v-if="tab.count > 0"')
    && segmentedTab.includes('{{ tab.label }}'),
  'SegmentedTab 须无 pulse-dot / motion-reduce 动画类 / badge / count 数字，label 直出',
)
check(
  'plan04/TC2 SessionItem running 态改静态空心环（2026-11 性能裁决）',
  // [perf:animation] 裁决修订：SessionItem 是全仓唯一「N 实例」常驻动画点（每个 working
  // session 一个环，多后台会话并存时线性增多），且持续整个任务生命周期。实测单 14px
  // spinner 即 9.3% GPU helper，故 spinning 档改静态 accent 空心环。
  // 判据锚定 spinning 分支行本身（2026-11 分支审查 arch-boundary S3a：原全文 includes
  // 由 hollow 分支即可满足，删掉整个 spinning 分支仍绿）：
  //   ① spinning 行存在且为静态 border-dashed 环（与 pending 的实线 hollow 可区分，M3）；
  //   ② spinning 行不得含 animate-spin / border-t-transparent（旋转环的静态残形）。
  (() => {
    const spinningLine = sessionItem.split('\n').find((l) => l.includes("iconKind === 'spinning'"))
    if (!spinningLine) return false
    return spinningLine.includes('rounded-full border-[1.5px] border-dashed border-accent')
      && !spinningLine.includes('animate-spin')
      && !spinningLine.includes('border-t-transparent')
      && !sessionItem.includes('animate-spin')
  })(),
  'SessionItem（含 session-item/ 子组件）的 running 档须为静态 accent 虚线环（锚定 spinning 分支行），且不得含 animate-spin（2026-11 常驻动画退役）',
)
check(
  'plan04/TC3 composer-shell isActive 静态 ring',
  !composerShell.includes('animate-steer-breathe')
    && composerShell.includes('border-[var(--accent)] shadow-[0_0_0_2px_var(--accent-ring)]'),
  'composer-shell isActive 分支须无动画装饰，保留 accent 边 + accent-ring 静态环',
)
check(
  'plan04/TC4 sessionStatus waiting 静态范式',
  sessionStatus.includes("waiting: { icon: 'Wrench', color: 'text-warn', animation: '' }")
    && !sessionStatus.includes('animate-wiggle'),
  "waiting 的 animation 须为空串且无 animate-wiggle",
)
check(
  'plan04/TC5 streaming 保留 spin（working/compacting 已降级） + pulse-dot keyframes 保留',
  // [perf:animation] 裁决修订：working / compacting 的 spin 已于 2026-11 退役（常驻态），
  // streaming 保留（真实流式秒-分钟）。pulse-dot keyframes 仍须保留（TrayNativePanel 等消费）。
  sessionStatus.includes("streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    && !sessionStatus.includes("working: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    && styleCss.includes('@keyframes pulse-dot'),
  'streaming 的 spin 与 @keyframes pulse-dot 须保留；working 不得再挂 animate-spin（2026-11 常驻动画退役）',
)

// ── [perf:animation] 2026-11 分支审查 business-logic 探针实测：translateZ(0) 与 animate-* 同元素
// = 旋转不动。机制：spin / loader-spin / rbi-spin 的 keyframes 只写 to（无显式 from），隐式
// from = 元素当前 transform；当前值为 translateZ(0) 时，插值 translateZ(0)→rotate(360deg)
// 两端同为单位矩阵，Chrome 计算样式恒 matrix(1,0,0,1,0,0)。实测「修复后 GPU 下降」有一部分
// 其实是转不动了（静默视觉回归）。正确形态 = 两层：外层 [transform:translateZ(0)] 提层，
// 内层 animate-*；或 keyframes 显式 from/to 均带 translateZ(0)（RunningBlockIcon 自包含原语）。
// 本守卫扫 renderer + ui 两包全部 .vue：同一 class 属性值（静态或 :class 字面量）内不得同时
// 出现 translateZ(0) 与 animate-<x>（含 animate-[...] 任意值形）。
{
  const UI = resolve(ROOT, 'packages/ui/src')
  const vueFiles = [
    ...collectVueFiles(resolve(RENDERER, 'src')),
    ...collectVueFiles(UI),
  ]
  const TZ = /translateZ\(0\)/
  const ANIM = /\banimate-(?:\[|[a-z])/
  // 取每个 class="..." / :class="..." / class='...' 属性值（单行内；多行 class 绑定另按
  // 「同一标签开区间」兜底：把 <tag ... > 之间拼成一行再判）
  const sameElementHits = []
  for (const f of vueFiles) {
    const src = readFileSync(f, 'utf-8')
    for (const m of src.matchAll(/<[a-zA-Z][^<>]*?>/gs)) {
      const tag = m[0].replace(/\s+/g, ' ')
      const classAttrs = [...tag.matchAll(/(?:^|\s):?class="([^"]*)"/g)].map((x) => x[1]).join(' ')
      if (TZ.test(classAttrs) && ANIM.test(classAttrs)) {
        const line = src.slice(0, m.index).split('\n').length
        sameElementHits.push(`${relative(ROOT, f)}:${line}  ${classAttrs.slice(0, 120)}`)
      }
    }
  }
  check(
    '[perf:animation] translateZ(0) 与 animate-* 不同元素（keyframes 隐式 from 冲突 → 旋转不动）',
    sameElementHits.length === 0,
    sameElementHits.length === 0
      ? '全仓 .vue 无同元素 translateZ(0)+animate-*（正确形态 = 外层提层 + 内层 animate，或 keyframes 显式 from/to 带 translateZ(0)）'
      : `同元素 translateZ(0)+animate-* ${sameElementHits.length} 处（旋转静默失效）：\n      ${sameElementHits.join('\n      ')}`,
  )
}

if (problems.length > 0) {
  console.error(`[check-animation-source-guards] 命中 ${problems.length} 条静态守卫违规：`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error('[FIX] 上述判据来自 plan 04/05/06 的显式裁决；改实现前先确认裁决是否仍然有效（改裁决须同步本脚本）')
  process.exit(1)
}

console.log(`[check-animation-source-guards] OK（${checksRun} 条判据全部通过）`)
