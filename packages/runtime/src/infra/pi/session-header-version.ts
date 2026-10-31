/**
 * pi 会话 header 格式版本防御（startup 设计 §7.2「pi 格式版本防御」，终态同步修复 G3）。
 *
 * 为什么存在：过渡期仍读 pi 会话文件的路径（扫描器 / U4 纯读两级解析等，消费方经
 * session-file-utils parseSessionHeader 单点）在 pi 升级把 header version 抬到 taiji
 * 解析器未验证的形态时，原先的降级是静默的——排障无从下手。本模块按设计条款给出
 * 显式告警计数：高于已知最高版本 → console.warn（按版本去重，防扫描热路径多文件
 * 刷屏）+ 累计计数（导出只读快照）；header 本身仍由调用方宽松解析（字段守卫缺失即
 * 不设），不因版本未知产出 null。
 *
 * 从 session-file-utils.ts 拆出（max-lines 预算，先例 session-residue-cleanup.ts）：
 * 版本防御是独立概念，无 JSONL 解析依赖。
 *
 * pi 侧行为锚（ADR-0063 I4；机器登记 docs/pi-semantics.json PS-92，pi 升级经 C-proc-08
 * 版本门禁强制重验；pi@1.0.0 dist/core/session-manager.js 实装实测）：写侧恒写 3——
 * CURRENT_SESSION_VERSION = 3（:11），newSession 首建 / createBranchedSession branch 换文件 /
 * forkFrom fork 换 cwd 三处 header 构造统一引用该常量；读侧历史文件兼容——加载期
 * migrateToCurrentVersion 把 v1/v2 级联迁移到 3（迁移发生即 _rewriteFile），纯读
 * loadEntriesFromFile 无版本校验直读。~/.pi 会话目录抽样与源码锚一致（现行文件 3、
 * 历史文件 1）。
 */

/** 已认识的 pi 会话 header 最高格式版本。高于此值 = 未来 pi 升级产物，字段语义未经验证。 */
export const MAX_KNOWN_SESSION_HEADER_VERSION = 3

/** 未知 header 版本的累计计数（版本号 → 出现次数；诊断与测试断言消费）。 */
const unknownHeaderVersionCounts = new Map<number, number>()

/** 已告警过的未知版本号（同版本只出声一次；计数不受去重影响）。 */
const warnedHeaderVersions = new Set<number>()

/** 未知版本告警计数的只读快照（消费方：测试断言 / 排障探针）。 */
export function getSessionHeaderUnknownVersionCounts(): ReadonlyMap<number, number> {
  return new Map(unknownHeaderVersionCounts)
}

/** 测试隔离用：清空未知版本计数与告警去重集（先例 _resetSidecarWarnDedupForTest）。 */
export function _resetSessionHeaderVersionWarnForTest(): void {
  unknownHeaderVersionCounts.clear()
  warnedHeaderVersions.clear()
}

/** 未知版本计数 + 首遇告警（parseSessionHeader 内部消费）。 */
export function countUnknownSessionHeaderVersion(version: number, filePath: string): void {
  unknownHeaderVersionCounts.set(version, (unknownHeaderVersionCounts.get(version) ?? 0) + 1)
  if (warnedHeaderVersions.has(version)) return
  warnedHeaderVersions.add(version)
  console.warn(
    `[session-header-version] unknown pi session format version ${version} (> known max ${MAX_KNOWN_SESSION_HEADER_VERSION}), first seen: ${filePath} — header fields parsed leniently, entries from a newer pi may be misread; counts via getSessionHeaderUnknownVersionCounts()`,
  )
}
