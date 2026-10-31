/**
 * 执行域共享契约出口（@taiji/shared/execution）。
 *
 * 为什么单独子路径而非并进 @taiji/shared 主 barrel：执行域契约是跨 runtime / pi 扩展 /
 * renderer / 移动壳的整组协议（类型 + 少量纯函数 + 数据清单），单独出口让消费方按需
 * 引入、避免主 barrel 把整组契约（尤其条目类型基线清单）带进每个打包产物；与
 * @taiji/shared/session-store-paths、@taiji/shared/plugin-* 的既有子路径形态一致。
 *
 * 契约级入口：
 * - events.ts    事件外层字段 + 21 个事件类型及 payload
 * - snapshot.ts  快照外层五字段 + run/member/step 视图
 * - result.ts    结果工件十字段
 * - notice.ts    通知六字段 + 单状态机 + 派生通知缓存
 * - commands.ts  执行 API 11 命令 / 回执 / 错误 / 控制通道帧
 * - identity.ts  stepKey 生成规则 + Run/Member/Attempt 身份与 resume 契约
 * - budgets.ts   两级预算与日志分段常量单源（环境变量可覆盖）
 * - alerts.ts    失联宽限结构化告警（观测告警，不判死）
 * - scheduler.ts scheduler 小域任务契约（G10：小域任务视图 + v2 快照判形与字段映射 +
 *                JSONL 历史条目源 schema 与映射（U6 存量导入双源）+ SI8 task.fired
 *                到期事实语义）
 * - main-session-entry-baseline.json  S2 diff 白名单唯一载体（工具运行时直读）
 */

export * from './ids'
export * from './status'
export * from './events'
export * from './snapshot'
export * from './result'
export * from './notice'
export * from './commands'
export * from './collect-results'
export * from './identity'
export * from './budgets'
export * from './alerts'
export * from './scheduler'
