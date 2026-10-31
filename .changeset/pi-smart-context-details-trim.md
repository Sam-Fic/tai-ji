---
"@zhushanwen/pi-smart-context": minor
---

compact_context 工具 details 删除 launched / fellBack 两个字段（压缩结果以注入消息与 summary 字段为准）；窗口告警的压缩触发线改读 pi 包导出的 `DEFAULT_COMPACTION_SETTINGS.reserveTokens`（当前值不变，pi 升级调整默认值时自动跟随）。
