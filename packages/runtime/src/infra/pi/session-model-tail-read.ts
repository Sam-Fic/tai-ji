/**
 * session JSONL 的 model_change 尾条目提取器（subagent-model-switch §7.2「实际执行
 * 事实权威」审计口径的读取单点——pi 唯一显式 setModel 写点落盘 entry 的最近值派生）。
 *
 * 落点自 session-file-utils 拆出（2026-10-07 dmg-r1-5：services 层手写 JSONL 尾读
 * 收敛 infra，同批 session-file-utils max-lines 预算无余量，一文件一概念先例同
 * residue-cleanup 族）；扫描骨架复用 session-file-utils 的 scanJsonlFromTail（infra
 * 内部单向依赖，消费方 services 侧经 check_services_infra_import BASELINE_MODULES
 * 登记）。读者归类 = census §6 N16（照实族）。
 */
import { statSync } from 'node:fs'
import { forEachReversedLineChunk } from '../../utils/history-reverse-read.js'
import { scanJsonlFromTail } from './session-file-utils.js'

/**
 * 单 entry 的显式 model_change 提取（解析落点）。与 session-file-utils 的
 * modelEntryValueOf 的语义分界：只认 pi 唯一显式 setModel 写点落盘的 `model_change`
 * entry（provider / modelId 顶级平铺字段），assistant message 携带的模型不属「最近
 * 一次显式热切换」语义；字段非法（非 string / 空串）→ null（视为不携带切换信息，
 * 扫描继续向前）。
 */
function modelChangeEntryValueOf(entry: Record<string, unknown>): { provider: string; modelId: string } | null {
  if (entry.type !== 'model_change') return null
  if (typeof entry.provider !== 'string' || entry.provider === '') return null
  if (typeof entry.modelId !== 'string' || entry.modelId === '') return null
  return { provider: entry.provider, modelId: entry.modelId }
}

/**
 * 反向读 session JSONL 提取最近一次显式热切换的模型（`model_change` 尾条目）。
 *
 * 取数 = scanJsonlFromTail 骨架 + `{ activePath: true }` 活跃路径裁剪（与
 * extractLatestModelFromJsonl 同款）：分支文件下物理尾逆读会命中被撤子树的 model_change
 * （被撤回合的显示残留），先裁剪再逆扫与 pi 恢复语义对齐；oversize 段不裁（骨架注释口径）。
 * 未命中（文件不存在——pi 首次 flush 前延迟写入 / 扫描窗内无合法条目）按无值返回
 * undefined；错误对等（INVAR-tail-7）不抛。
 *
 * 与 extractLatestModelFromJsonl 的语义分界：那边是「最近生效模型绑定」（model_change 与
 * assistant message 都算，附 thinkingLevel，侧栏扫描第七读）；本函数只认显式 model_change、
 * 拆分返回 { provider, modelId }（shared SubagentRecentEffectiveModel 同构形状，成员详情消费）。
 */
export function extractLatestModelChangeFromJsonl(filePath: string): { provider: string; modelId: string } | undefined {
  const found: Array<{ provider: string; modelId: string }> = []
  scanJsonlFromTail(filePath, (entry) => {
    const value = modelChangeEntryValueOf(entry)
    if (value === null) return false
    found.push(value)
    return true
  }, { activePath: true })
  return found.length > 0 ? found[0] : undefined
}

/** 窗口模型基线的进程内缓存上限（每个会话的每个窗口起点一条；LRU 淘汰最旧）。 */
const BASELINE_CACHE_MAX = 16
const baselineCache = new Map<string, { provider: string; modelId: string } | undefined>()

/**
 * 找「某个位置之前、活跃路径上最近一条 model_change」——历史按窗口读取时的模型基线。
 *
 * 为什么需要：对话流历史默认按窗口读（最近 N 个回合 + 字节预算）。窗口不含文件头时，
 * 文件头那条初始 model_change 不在窗口里；窗口内第一条 model_change 之前没有更早记录，
 * reducer 会把它记成基线而不出切换行——同一个会话实时下是出行的。
 *
 * 怎么找：fromParentId 是窗口第一条 entry 的真实父亲，从它沿 parentId 回溯的链就是窗口
 * 起点之前的活跃路径，链上最近一条 model_change 就是窗口起点处的生效模型。被撤子树里的
 * model_change 不在链上，不会被误当成基线。读 [0, endOffset) 一遍建 id → 父节点映射
 * （逐行解析：pi 写的记录 id 在行首附近、扩展写的 custom 记录 id 在行尾，且父链会经过
 * custom 记录，按位置匹配字段不可靠），再在内存里回溯。
 *
 * 什么时候调用：窗口里有 model_change 且窗口不含文件头。没有切换记录的窗口不需要基线，
 * 不要调用（省掉这次读）。代价：前缀有多大就读多少、逐行解析（10MB 量级约百毫秒，同步）；
 * 文件不变且窗口起点不变时命中缓存不重算。
 *
 * endOffset 缺省 = 文件末尾。父链总是指向更早的 entry，窗口之后的内容不影响结果；
 * 调用方有窗口起点偏移时传入可少读一段。文件不存在 / 链上没有 model_change → undefined，不抛。
 */
export function findModelChangeBaselineBefore(
  filePath: string,
  fromParentId: string | null | undefined,
  endOffset?: number,
): { provider: string; modelId: string } | undefined {
  if (typeof fromParentId !== 'string' || fromParentId === '') return undefined
  let size: number
  let mtimeMs: number
  try {
    const stat = statSync(filePath)
    size = stat.size
    mtimeMs = stat.mtimeMs
  } catch {
    return undefined
  }
  const cacheKey = `${filePath}\u0000${size}\u0000${mtimeMs}\u0000${endOffset ?? ''}\u0000${fromParentId}`
  if (baselineCache.has(cacheKey)) {
    const hit = baselineCache.get(cacheKey)
    baselineCache.delete(cacheKey)
    baselineCache.set(cacheKey, hit)
    return hit
  }
  const parentOf = new Map<string, string | null>()
  const changes = new Map<string, { provider: string; modelId: string }>()
  forEachReversedLineChunk(filePath, { endOffset }, (chunk) => {
    for (const line of chunk.lines) {
      if (line === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof parsed !== 'object' || parsed === null) continue
      const entry = parsed as Record<string, unknown>
      if (typeof entry.id !== 'string') continue
      parentOf.set(entry.id, typeof entry.parentId === 'string' ? entry.parentId : null)
      const value = modelChangeEntryValueOf(entry)
      if (value !== null) changes.set(entry.id, value)
    }
  })
  let result: { provider: string; modelId: string } | undefined
  const seen = new Set<string>()
  let cursor: string | null | undefined = fromParentId
  while (typeof cursor === 'string' && !seen.has(cursor)) {
    seen.add(cursor)
    const change = changes.get(cursor)
    if (change !== undefined) {
      result = change
      break
    }
    // 父节点不在已读范围（文件损坏 / 链上的行畸形）→ undefined，链终止
    cursor = parentOf.get(cursor)
  }
  if (baselineCache.size >= BASELINE_CACHE_MAX) {
    const oldest = baselineCache.keys().next().value
    if (oldest !== undefined) baselineCache.delete(oldest)
  }
  baselineCache.set(cacheKey, result)
  return result
}
