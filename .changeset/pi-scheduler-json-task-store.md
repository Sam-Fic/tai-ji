---
"@zhushanwen/pi-scheduler": minor
---

任务存储重写为独立 JSON 快照任务库（`<agentDir>/scheduler/` 下按会话分片，经 extension-protocol 的 scheduler-store 出口读写），不再挂靠会话 JSONL：旧会话内存量任务不迁移（已裁决无存量）；`--no-session` 模式任务照常持久化并跨重启恢复；任务创建确认从合成 assistant 应答轮改为 UI 通知与面板即时刷新，不再制造模型轮。
