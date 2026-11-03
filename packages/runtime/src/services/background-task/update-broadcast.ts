/**
 * backgroundTask:updated 广播组装（background-task-sidebar D3，u-runtime-rpc①）：
 * 自 session-service.ts 行为保持抽取（max-lines 门禁，先例 crash-forensics-hooks.ts）——
 * Facade 组装点保留一行接线（onTasksChanged 闭包传 backgroundTasks/messageBus，
 * session-service.ts assembleSubmodules），日志标签随迁保持。
 *
 * onTasksChanged（mtime 轮询 / 自写自检触发）时重读该 session registry 全量 → messageBus
 * session 级 publish（Server→Client 冒号 camelCase，对齐 backgroundTask:updated 命名规则；
 * stream 类入 ring，晚订阅 renderer 由 snapshot 重放兜底）。bus 未注入时 no-op（nullable
 * 注入语义与域内其余 publish 点一致）。entry 形状为 extension-protocol 契约，shared 侧
 * 逐字段镜像（u-proto D9，结构兼容直赋）。
 * registry 读失败（listTasks 上抛）→ warn + 跳过本轮广播（拉取是真相通道，广播只做
 * 提示）：本函数跑在 mtime 轮询的 setInterval 回调内，上抛会炸 runtime 进程；下一次
 * mtime 变化自动重试广播，renderer 主动拉取路径由 RPC 中央 catch 回显式 error envelope。
 */
import type { ServerMessage } from '@taiji/shared'
import type { IMessageBus } from '../message-bus/message-bus.js'
import type { BackgroundTaskService } from './background-task-service.js'

export function publishBackgroundTasksUpdate(
  backgroundTasks: BackgroundTaskService,
  messageBus: IMessageBus | null | undefined,
  sessionId: string,
): void {
  try {
    const { entries, corrupted } = backgroundTasks.listTasks(sessionId)
    const msg: ServerMessage = {
      type: 'backgroundTask:updated',
      payload: { sessionId, tasks: entries, corrupted },
    }
    messageBus?.publish(sessionId, msg)
  } catch (e) {
    // 降级策略（best-effort）：跑在 mtime 轮询的 setInterval 回调内，上抛会炸 runtime
    // 进程——warn 后跳过本轮广播（拉取是真相通道，广播只做提示），下一次 mtime 变化
    // 自动重试（renderer 主动拉取由 RPC 中央 catch 回显式 error envelope）。
    console.warn('[session-service] backgroundTask update broadcast skipped (registry read failed), sid=', sessionId, e instanceof Error ? e.message : e)
  }
}
