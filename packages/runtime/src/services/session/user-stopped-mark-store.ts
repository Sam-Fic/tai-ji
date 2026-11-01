/**
 * userStopped 标记宿主（独立模块——session-service.ts max-lines 拆分，pi-stall-detection U2 期间
 * 随分型消费接口扩容超出单文件上限；搬移自 session-service.ts，行为零变化）。
 *
 * userStopped 标记宿主（session-dead-structural-fixes D4）：sessionId 键控的模块级独立 Map。
 * 数据源登记 = 主表 #30（docs/architecture/data-source-registry.md，2026-09-10 u3b 补登）。
 *
 * 为什么是模块级、为什么独立于 ManagedSession：forceQuit 尾步 removeSessionEntry 会删
 * sessions Map 条目、销毁 session 对象，而标记必须存活到后续 restore（用户点开 dead session
 * 时 restoreSession 读它决定是否 restore-abort）——挂在 session 对象 / 实例字段上都会随条目
 * 删除消亡。清理路径全列：显式投递（gate.consumeForExplicitDelivery）/ delete（lifecycle.delete
 * 显式调 gate.disposeForDelete）/ shutdown（gate.disposeAll）/ 判死分型自动恢复消费
 *（consumeUserStoppedMarkOfSource，pi-stall-detection U2 显式例外，types.ts 契约登记）/
 * 进程退出（内存态整体消亡，天然清理）；removeSessionEntry 刻意不清（forceQuit 尾步经过
 * 它，标记须存活到后续 restore——见 session-entry-removal.ts 汇聚点注释；原 D4 收敛环
 * 清理已随 ADR-0122 时间窗删除移除）。
 *
 * 子模块（dispatcher/lifecycle/interpreter 挂点）不直接 import 本模块（模块依赖单向性：
 * session-service Facade 值导入全部子模块，反向 import 成环），统一经 event-interpreter.ts 的
 * userStoppedGate 门面存取——session-service 构造器经 gate.configure 注入下方 store 实现与
 * abort 能力。
 */
// @data-owner #30（data-source-registry.md）：跨 ManagedSession 生命周期存活的用户停止
// 意图标记（模块级 Map 是存在理由而非偶发形态，D4）；写方唯一 = userStoppedMarkStore。
import type { ForceQuitSource, UserStoppedMarkStore } from './types.js'

const userStoppedMarks = new Map<string, { source: ForceQuitSource; markedAt: number }>()

/** 宿主 Map 的存取实现（gate.configure 注入 + 测试直断言用）。 */
export const userStoppedMarkStore: UserStoppedMarkStore = {
  markUserStopped(sessionId: string, source: ForceQuitSource): void {
    userStoppedMarks.set(sessionId, { source, markedAt: Date.now() })
    console.warn(`[session-service] userStopped mark set (sessionId=${sessionId}, source=${source})`)
  },
  hasUserStoppedMark(sessionId: string): boolean {
    return userStoppedMarks.has(sessionId)
  },
  getUserStoppedSource(sessionId: string): ForceQuitSource | undefined {
    return userStoppedMarks.get(sessionId)?.source
  },
  consumeUserStoppedMarkOfSource(sessionId: string, allowed: readonly ForceQuitSource[]): boolean {
    const mark = userStoppedMarks.get(sessionId)
    if (!mark || !allowed.includes(mark.source)) return false
    userStoppedMarks.delete(sessionId)
    console.warn(`[session-service] userStopped mark consumed by source (sessionId=${sessionId}, source=${mark.source})`)
    return true
  },
  clearUserStoppedMark(sessionId: string): void {
    userStoppedMarks.delete(sessionId)
  },
  clearAllUserStoppedMarks(): void {
    userStoppedMarks.clear()
  },
}
