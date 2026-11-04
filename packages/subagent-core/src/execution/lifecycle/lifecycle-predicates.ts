// src/execution/lifecycle/lifecycle-predicates.ts
//
// 执行状态派生谓词。
//
// [U2 两态迁移] 永久会话模型状态机 = running | idle（终态概念删除）；本文件谓词
// 的「两态（running/closed）」语境自 v4 B-1 演化而来——「对话模式等待续聊」与
// 「正在执行」曾同为 status="running" 靠派生谓词区分；U2 后「等待续聊」的权威
// 词汇 = idle（markSettled 收尾）。活进程判据读 core 侧 spawnedChildren 状态镜像
//（engine/host/spawned-children.ts，活进程句柄是否存在），不新增状态记账。
//
// 两种 running 子态（v4 B-1）：
//   - 等待续聊：轮完成后进程已回收 → U4 翻边后轮终真实写 idle（isResumable 即
//     idle 派生，[U5/D4]），续聊走 deliverMessage 冷路径 resume（续写原 session
//     文件）。notify 检查（notify-host.ts）的放行谓词 = 旧终态遗留（idle ∧ closedReason
//     有值，U2 桥接判据）/ idle（收尾写入 journal 记录提示/轮次通知载荷）或 isResumable（idle）。
//   - 正在执行：isResumable=false（running 直读为假）。

// [W6 拆依赖] 活进程句柄读点改经 core 侧 spawnedChildren 状态镜像公共部分
// （engine/host/spawned-children.ts），不再深路径 import inproc pi 引擎目录 内部——
// 行为不变（镜像 ∪ inproc 权威 map 并读，见该文件头注释的过渡桥语义）。
import { hasLiveProcessHandleCore } from "../engine/host/spawned-children.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";

/**
 * 活进程句柄是否存在（isResumable 子判据）。
 *
 * [W6] 改读 core 侧状态镜像（engine/host/spawned-children.ts 的 hasLiveProcessHandleCore：
 * 镜像项存在且未 killed = 有活进程句柄；迁移期内建 pi 的 inproc 权威 map 并读兜底）。
 * 轮末进程随 agent_settled 回收 / 被 kill 后镜像项置死或移除 = 无活进程
 * （等待续聊态 / 跨重启重建同理）。
 */
export function hasLiveProcessHandle(recordId: string): boolean {
  return hasLiveProcessHandleCore(recordId);
}

/**
 * 可续聊态（[two-state-convergence U5/D4] idle 派生——「idle 即 resumable」的
 * 单一权威实现）。
 *
 * [U5 判据迁移] 旧判据「running 且无活进程句柄」依赖 U4 已退役的轮终桥接形态
 * （轮终现已真实写 idle）；新判据 = status 直读。notify-host 放行子句中
 * 本谓词被 `status !== 'idle'` 前置子句短路吸收（冗余但无害）。
 *
 * [v4 A-6] 签名泛化为 Pick<"id"|"status">：ExecutionRecord（活态）与 SubagentRecord
 * （list 快照）均结构兼容。
 */
export function isResumable(record: Pick<ExecutionRecord, "id" | "status">): boolean {
  return record.status === "idle";
}
