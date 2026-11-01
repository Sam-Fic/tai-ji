/**
 * scheduler 任务库分片清点——session 删除级联的 scheduler 半边（data-source-registry.md
 * #88「清理路径」字段的实装）。
 *
 * 背景（scheduler-redesign 方案 B，2026-10-30 裁决）：任务库与会话事实分离，任务集快照
 * 落 `<agentDir>/scheduler/<root>/<segments>/<sessionId>.json`（键 = owner sessionId），
 * 该树是 pi agent 数据目录，**不在 session 存储树内**——session-content-cascade 的整树
 * 软删（`<root>/<sid>/`）够不到它，删主会话后分片（含任务定义与执行 history）留盘成孤儿。
 * 本模块把分片纳入删除链：路径推导经 `@zhushanwen/extension-protocol/scheduler-store`
 * 子出口的 `schedulerStoreFilePath`（与扩展写方 / 面板读方同源单实现），删点经依赖注入
 * 挂到级联末段（级联模块自身不持 fs 删除调用，验收③源码断言的边界）。
 *
 * 只删键 = 被删 sessionId 的分片：`--no-session` 归一固定分片 `no-session` 由多个
 * `pi --no-session` 进程共写（C-data-09 豁免条目），无属主、不可按单会话回收，不在
 * 本清点射程内。sessionId 非路径安全（`schedulerStoreFilePath` fail-fast 域外）时无
 * 分片可定位，按 skipped 留痕——不猜路径、不删共享分片。
 *
 * 失败语义：删除失败上抛，由级联按 best-effort 收敛为 warn + failures（残留分片仅占盘，
 * 不阻断删除主链——树与本体已删，重试删除即补清分片）。
 */

import { unlinkSync } from 'node:fs'

import { schedulerStoreFilePath } from '../../utils/protocol-scheduler-store.js'

/**
 * 删被删会话的 scheduler 任务库分片。
 *
 * @param agentDir pi agent 数据目录（= 扩展侧 getAgentDir()，两侧分片路径一致的前提）
 * @param cwd      owner session 工作目录（分片路径的 workspace 隔离键）
 * @param sessionId 被删主会话 id（分片键）
 * @returns `purged` 分片已删 / `absent` 无分片（从未建任务或已被外部清理，正常路径）
 *          / `skipped` sessionId 非路径安全，无分片可定位
 * @throws 删除失败（EACCES 等）——调用方降级为 warn + failures
 */
export function purgeSchedulerShard(agentDir: string, cwd: string, sessionId: string): 'purged' | 'absent' | 'skipped' {
  let shardPath: string
  try {
    shardPath = schedulerStoreFilePath(agentDir, cwd, sessionId)
  } catch {
    // 路径安全判据的权威在 store.ts 的 fail-fast（本函数不复制第二份正则——复制即漂移：
    // 一侧放宽/收紧而另一侧不变时，会出现「猜路径删错文件」或「该删的没删」）。
    // 非路径安全 id 对应的分片（若有）是共写的 no-session 固定分片，不可按单会话回收。
    return 'skipped'
  }
  try {
    unlinkSync(shardPath)
    return 'purged'
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return 'absent'
    throw err
  }
}
