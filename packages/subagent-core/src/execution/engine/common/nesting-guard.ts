// src/execution/engine/common/nesting-guard.ts
//
// 嵌套上下文类型的 re-export shim：实现体单源 @zhushanwen/subagent-engine-sdk
//（自本文件逐字等价移入 SDK，s4-reuse 簇 2）。core 内消费方（subagent-service 与
// service 层聚合）消费 ExecutionNestingContext（类，值形态 per-Service 实例化）与
// ExecutionNestingState 类型（身份归属域：parentRecordId / depth 派发身份），import
// 路径保持不变。
//
// 原 assertNotNestedSpawn / NestedSpawnRejectedError（检测到统一标记即拒绝递归派发）
// 已随禁嵌套派发删除——从未接线（零生产调用方），防线 = 被派发子进程经扩展精简
// 装配无派发工具。buildNestedSpawnEnv / NESTED_SPAWN_ENV 的消费方在 SDK 与
// zcode-subagent-cli，core 不经本 shim 转发。

export { ExecutionNestingContext } from "@zhushanwen/subagent-engine-sdk";
export type { ExecutionNestingState } from "@zhushanwen/subagent-engine-sdk";
