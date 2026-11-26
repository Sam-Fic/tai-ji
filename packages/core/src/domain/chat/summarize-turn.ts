/**
 * TurnRail 节点摘要纯函数（chat 域 SSOT，w6 从 renderer/composables/logic/summarizeTurn.ts 迁入）。
 *
 * 用途：rail 节点只显示一行短文本（用户输入的开头），
 * 因此需把 user message 的结构化 content 归一化 + 剥 markdown + 截断。
 *
 * 依赖：normalizeContent（shared）+ MessageTurn/countThinking/countToolCalls（同目录 message-turns）。
 */
import { normalizeContent } from '@taiji/shared'
import type { MessageTurn } from './message-turns'
import { countThinking, countToolCalls } from './message-turns'

/** rail 节点摘要最大字符数（中文算 1，超出加省略号）。 */
const MAX_CHARS = 20
/** 截断后缀（单字符省略号，比 '...' 视觉更轻，符合 rail 节点紧凑排版）。 */
const ELLIPSIS = '…'

/**
 * rail 流式冻结常量（B1 派生归零）：
 * - FREEZE_K：assistant 文本长度阈值——append-only 语义下达到后前 K 字符不再变化；
 * - FREEZE_PREFIX：同 id 的前缀指纹长度（防御 id 复用/内容被换的极端形态）。
 */
export const RAIL_FREEZE_K = 256
export const RAIL_FREEZE_PREFIX = 64

/** 从 MessageTurn 提取 rail 节点摘要文本。 */
export function summarizeTurnForRail(turn: MessageTurn): string {
  if (!turn.user) return ''
  const raw = normalizeContent(turn.user.content)
  const cleaned = stripMarkdown(raw)
  return truncate(cleaned, MAX_CHARS)
}

/** 剥离常见 markdown 标记，保留纯文本语义。 */
export function stripMarkdown(text: string): string {
  let s = text
  // fence 行无条件剥离（行级，不依赖配对）：旧实现 /```[\s\S]*?```/ 依赖闭 fence，
  // 流式期未闭合时 fence 标记会泄漏进 rail 摘要；闭合块的终态输出与本替换一致
  // （旧实现在闭合后同样是删 fence 行、保留代码内容）。
  s = s.replace(/^[ \t]*```[^\n]*$/gm, '')
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
  s = s.replace(/___([^_]+)___/g, '$1')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  s = s.replace(/^#{1,6}\s+/gm, '')
  s = s.replace(/^>\s?/gm, '')
  s = s.replace(/^[-*+]\s+\[[ xX]\]\s+/gm, '')
  s = s.replace(/^[-*+]\s+/gm, '')
  s = s.replace(/^\d+\.\s+/gm, '')
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/** 截断到 maxChars 个 Unicode 码点（中文/emoji 均算 1），超长加省略号。
 *  码点级 early-exit：旧实现 Array.from(text) 全量码点化（长文本 O(n) 分配），
 *  本实现最多迭代 maxChars+1 个码点即判定（O(maxChars)），输出逐字等价。 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text // UTF-16 长度 ≥ 码点数 ⇒ 未超
  const keep = Math.max(0, maxChars - ELLIPSIS.length)
  const collected: string[] = []
  let n = 0
  for (const ch of text) {
    n++
    if (collected.length <= keep) collected.push(ch)
    if (n > maxChars) break // 已超 maxChars 个码点 ⇒ 确定要截断
  }
  // 代理对压缩场景：码点总数 ≤ maxChars（UTF-16 长度虚高）⇒ 原样返回（对齐旧实现）
  if (n <= maxChars) return text
  return collected.slice(0, keep).join('') + ELLIPSIS
}

/**
 * 流式冻结锚点（B1）：首个非空 assistant 文本块的 (id, 长度, 前缀指纹)。
 * O(块数 + K) 成本——不物化全文 normalizeContent（那是 O(n) 的正钱），长度阈值只用块级累加。
 *
 * 对齐契约（B-harden）：本函数的块级规则（首块有非空 text）与 summarizeAssistantForRail 的
 * 规范化规则（normalizeContent 后 trim 非空）并非同一判据——纯空白首块会被本函数选中、却被
 * 摘要函数跳过。故锚点只作「候选」；冻结复用另需 summarizeAssistantForRailWithSource 的
 * sourceId 与锚点 id 相等（见 railMemoFor），排除该类错绑，不需要在此复制 trim 语义
 * （那会对长文本引入 O(n) 分配，正是本批要消除的成本）。
 *
 * 历史注记：曾有一个 `fenceOpen`（前 K 字符内 ``` 计数奇）字段兼作「等 fence 闭合再冻结」的
 * 守卫。已删除——append-only 下前 K 字符永恒不变 ⇒ 该值是常量，首条代码块落在前 K 内的响应
 * （coding 主场景最常见长响应形态）会**整个 turn 永不冻结**；且同批已把 stripMarkdown 改为
 * fence 行级无条件剥离，未闭合 fence 标记结构性不可能进摘要，守卫的目的已由其自身满足。
 */
export function streamingRailAnchor(turn: MessageTurn): { id: string; length: number; prefix: string } | null {
  for (const m of turn.assistants) {
    const c = m.content
    let text: string | null = null
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof (b as { text?: unknown }).text === 'string' && ((b as { text: string }).text).length > 0) {
          text = (b as { text: string }).text
          break
        }
      }
    }
    if (text === null || text.length === 0) continue
    return { id: m.id, length: text.length, prefix: text.slice(0, RAIL_FREEZE_PREFIX) }
  }
  return null
}

/** 分隔符（fallback 计数拼接用，与 Turn.vue badge「N thoughts · M tools」同构）。 */
const COUNT_SEP = ' · '

/**
 * rail 摘要是否已「触顶」——纯文本前 MAX_CHARS 个码点已超出显示预算（带省略号后缀）。
 *
 * 存在理由（B-harden 加固）：冻结门槛 `anchor.length >= RAIL_FREEZE_K` 作用在**原始文本**长度上，
 * 而摘要稳定性取决于 **stripMarkdown 之后**的前 20 码点。前 256 字符若是可被剥空/压掉的引导
 * 内容（纯空白、hr 行、空链接 `[](u)`）时，冻结会把「尚未成形」的空/短摘要钉住整个流式窗
 * （实测：`'[](u)'×70` → 流式期标签恒空，终态才出现正文）。要求触顶即把该形态退回每 delta
 * 重算（= 旧行为）；对正常长回复（19 码点 + 省略号）零影响。
 */
export function isRailSummarySettled(summary: string): boolean {
  return summary.endsWith(ELLIPSIS)
}

/**
 * summarizeAssistantForRail 的带来源形态：摘要 + 产出它的 assistant message id。
 *
 * 存在理由（B-harden）：rail 流式冻结的复用判据必须锚在「摘要确实由哪个 message 产出」上。
 * 选取规则（normalizeContent 后 trim 非空）与 streamingRailAnchor 的块级规则（首块有文本）
 * 并非同一判据——首块为纯空白时锚点指向它、摘要却来自后续块（或 fallback 计数）。若只按
 * 锚点 id 复用，会把别块的摘要（或随 thinking/toolCalls 增长的过期 fallback）冻结住。
 * 带出 sourceId 后，冻结槽记录 (sourceId, prefix)，复用要求锚点 id === sourceId，
 * 结构上排除该类错绑；对正常形态（首块即摘要来源）零额外成本。
 */
export function summarizeAssistantForRailWithSource(turn: MessageTurn): { text: string; sourceId: string | null } {
  for (const m of turn.assistants) {
    const text = normalizeContent(m.content).trim()
    if (text) {
      return { text: truncate(stripMarkdown(text), MAX_CHARS), sourceId: m.id }
    }
  }
  const thoughts = countThinking(turn)
  const tools = countToolCalls(turn)
  const parts: string[] = []
  if (thoughts > 0) parts.push(`${thoughts} thoughts`)
  if (tools > 0) parts.push(`${tools} tools`)
  // fallback 无单一来源 message（跨全部 assistants 计数）⇒ sourceId null，永不可被冻结复用
  return { text: parts.join(COUNT_SEP), sourceId: null }
}

/** 从 turn.assistants 派生 agent 行的一行摘要（rail 节点第二行）。 */
export function summarizeAssistantForRail(turn: MessageTurn): string {
  return summarizeAssistantForRailWithSource(turn).text
}
