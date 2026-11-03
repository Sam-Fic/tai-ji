// 任务契约与记账 helper 单源于 @zhushanwen/extension-protocol（任务库与会话事实分离，
// 2026-10-30 裁决）：扩展与 taiji 面板插件同源消费。本文件保持既有 import 路径不变
// （re-export），仅保留扩展侧私有物（工具参数）。

export {
  appendExecutionRecord,
  HISTORY_LIMIT,
} from '@zhushanwen/extension-protocol'
export type {
  ExecutionRecord,
  ScheduleSpec,
  ScheduledTask,
  TaskKind,
  TaskStatus,
} from '@zhushanwen/extension-protocol'

// 本地保留范围（工具参数）签名引用的类型——re-export 不引入作用域，需显式 import
import type { TaskKind } from '@zhushanwen/extension-protocol'

// ── 添加选项 ──

export interface AddOptions {
  name?: string
  kind?: TaskKind
  expires?: string
  /** 任务执行模型（scoped model id，provider/model）；缺省 = 跟随会话当前模型 */
  model?: string
}
