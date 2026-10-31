---
"@zhushanwen/state-machine": patch
---

`MachineCore` 删除无消费方的 `eventSet` / `rows` 导出字段（同一查询由 `rowIndex` / `legalEvents` 承担），构建与转移判定行为不变。
