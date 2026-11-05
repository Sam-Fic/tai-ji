---
"@zhushanwen/extension-protocol": minor
"@zhushanwen/pi-subagent-workflow": minor
---

托盘面板行升级为富行：`@zhushanwen/extension-protocol` 的 tree item 新增可选字段 `subLabel`（主名下方副文本）、`statusLabel`（状态文字覆盖，如「已中断（可续跑）」）与 `actions`（行尾内联操作按钮，与 action-bar 条目同形；三个字段均为可选，不认识它们的旧宿主按字段忽略、退回旧行为）。`@zhushanwen/pi-subagent-workflow` 的托盘 widget 随之迁移：slug 与失败分类从行名拼接迁入 `subLabel` 副文本，取消/重试/中止/续跑按钮收进行尾 `actions` 槽，进行中计数为 0 时不再推送角标（修复红色「0」角标常驻）。
