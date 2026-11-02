---
"@zhushanwen/extension-protocol": minor
---

破坏性变更：scheduler 任务存储从「会话 JSONL 事件条目 + 重放折叠」改为独立 JSON 快照任务库。桶出口删除 `replayFoldEntries` / `TASK_ENTRY_TYPE` / `SchedulerEntryOp` / `TaskSnapshot` 族导出；新增 `./scheduler-store` 子出口（`readSchedulerStore` / `schedulerStoreFilePath`，node:fs 依赖不进桶出口）。任务快照按 sessionId 分片存放于 `getAgentDir()/scheduler/` 下，原子替换写；`--no-session` 模式任务照常持久化。
