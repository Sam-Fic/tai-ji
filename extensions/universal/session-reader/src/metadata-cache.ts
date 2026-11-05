/**
 * [u11 标题元数据缓存]（design 2026-09-10 §6.6；目录指纹失效）。
 *
 * 从 tool-handler.ts max-lines 拆分轮机械提取（result-action.ts 先例同型，零行为
 * 变更）：把注入的 metadataProvider 包上目录指纹缓存——文件名集合 + 各文件
 * size/mtime 快照双通道失效，检出目录内文件追加产生的标题更新。
 *
 * 零 pi 依赖（类型来自发现层契约），可完全单测。
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionMetadataEntry, SessionMetadataProvider } from './discovery/find.js'

/**
 * 目录指纹 = `.jsonl` 文件名集合 + 各文件 size/mtime 快照（与 pi listSessionsFromDir
 * 的平铺 .jsonl 扫描同口径，非 .jsonl 条目不影响 provider 输出、不入指纹）。
 *
 * 文件级快照是检出「目录内已有文件追加」的唯一通道：POSIX 目录 mtime 只随目录项
 * 增删/改名变化，文件内容追加不触发；而标题恰随追加更新——pi 侧 name 取文件内
 * 最新 session_info 条目（appendSessionInfo 运行期随时追加改名）、firstMessage 取
 * 首条 user message（文件创建后才追加），均为 session-manager.ts buildSessionInfo
 * 实读行为，故仅比对目录 mtime 会漏掉全部追加型标题更新（branch-review r1 G3）。
 */
type DirFingerprint = ReadonlyMap<string, { readonly size: number; readonly mtimeMs: number }>

/**
 * 标题缓存（SessionMetadataEntry[] keyed by 目录字面路径）。进程内唯一实例，
 * 仅缓存标题元数据（session_info name / firstMessage，低频变更）——根扫描统计
 * 不再有缓存（doctor 缓存机已删除，ext-simplify-04 U3），与根扫描无共享状态。
 * 条目的 fingerprint = 目录指纹；目录不可读为 null（存在性翻转即失效）。
 */
const metadataCache = new Map<
  string,
  { entries: SessionMetadataEntry[]; fingerprint: DirFingerprint | null }
>()
// §7.5 豁免（development-guide.md「纯性能缓存豁免」）：纯性能缓存，jiti 双路径加载
// 分裂成两份仅多一次 miss 重扫，无正确性影响，不升级 globalThis 单例。

/**
 * 采目录指纹；目录不可读返回 null（与缓存条目的 null 比对 = 存在性未翻转）。
 * readdir 与逐文件 stat 之间的竞态（文件消失）以 {-1,-1} 占位——下次指纹要么
 * stat 成功（值不等 → 失效重扫）要么键已从集合消失（键集不等 → 失效），无假命中面。
 */
async function statDirFingerprint(dir: string): Promise<DirFingerprint | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    // 目录不存在是常态输入（候选根降级形态），非异常——void 同 roots.ts 容错
    void err
    return null
  }
  const files = new Map<string, { size: number; mtimeMs: number }>()
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    try {
      const s = await stat(join(dir, name))
      files.set(name, { size: s.size, mtimeMs: s.mtimeMs })
    } catch {
      files.set(name, { size: -1, mtimeMs: -1 })
    }
  }
  return files
}

/** 指纹相等 = 键集相同且各文件 size/mtime 逐一相等（null 仅与 null 相等）。 */
function fingerprintsEqual(a: DirFingerprint | null, b: DirFingerprint | null): boolean {
  if (a === null || b === null) return a === b
  if (a.size !== b.size) return false
  for (const [name, s] of a) {
    const t = b.get(name)
    if (t === undefined || t.size !== s.size || t.mtimeMs !== s.mtimeMs) return false
  }
  return true
}

/**
 * 把注入的 metadataProvider 包上指纹缓存（get 失效判定 + set 快照）。
 *
 * 失效通道 = 目录指纹（文件名集合检出增删/改名，各文件 size/mtime 快照检出
 * 目录内文件追加，见 DirFingerprint）。只缓存成功结果——provider 抛错原样上抛，
 * 由发现层单目录 try/catch 记空继续（guard），且瞬态失败不污染缓存（下个查询即
 * 重试）。find 的多次 findSessions 调用（u10 分组探测 main/subagent 两路）与连续
 * keyword 查询都经此处去重，listAll 在指纹未变期间至多一次/目录。
 */
export function withMetadataCache(provider: SessionMetadataProvider): SessionMetadataProvider {
  return async (dir) => {
    const hit = metadataCache.get(dir)
    if (hit !== undefined) {
      const fingerprint = await statDirFingerprint(dir)
      if (fingerprintsEqual(fingerprint, hit.fingerprint)) return hit.entries
      metadataCache.delete(dir)
    }
    const entries = await provider(dir)
    metadataCache.set(dir, {
      entries,
      fingerprint: await statDirFingerprint(dir),
    })
    return entries
  }
}
