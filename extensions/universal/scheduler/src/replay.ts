// 折叠器单源于 @zhushanwen/extension-protocol（U2 折叠器下沉）。包内实现零 pi 依赖
// （logger 以 ReplayFoldOptions.warn 注入），本文件是扩展侧薄 wrapper：注入共享 logger
// 保持单条损坏跳过的日志行为，并保持既有 import 路径与二参签名不变（backend.ts 零
// 改动）。流级错误（迭代器抛错）经本 wrapper 原样上抛——降级决策在 session_start 装配
// 点（index.ts catch 显式降级），不在折叠器内折叠成空 Map。

import {
  replayFoldEntries as replayFoldEntriesShared,
  type ScheduledTask,
  type SchedulerEntryLike,
} from '@zhushanwen/extension-protocol'
import { getLogger } from '@zhushanwen/pi-extension-logger'

const logger = getLogger('scheduler')

export function replayFoldEntries(
  entries: Iterable<SchedulerEntryLike>,
  currentSessionFile: string | undefined,
): Map<string, ScheduledTask> {
  return replayFoldEntriesShared(entries, currentSessionFile, {
    warn: (message, context) => logger.warn(message, context),
  })
}

export type { SchedulerEntryLike } from '@zhushanwen/extension-protocol'
