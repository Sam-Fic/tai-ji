---
"@zhushanwen/pi-subagent-workflow": minor
---

孤儿 run 对账的存活引用集与 jsonl-run-store 的发现通道只解析 v2 注册条目，v1 全量快照与旧 workflow-state-link 指针条目按不存在处理（2026-10-30 裁决：无 v1/link 存量数据）。
