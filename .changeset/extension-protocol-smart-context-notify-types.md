---
"@zhushanwen/extension-protocol": minor
---

新增 smart-context 通知通道词表导出 `SMART_CONTEXT_NOTICE_CUSTOM_TYPE` / `COMPACTION_ENTRY_APPENDED_SOURCE` / `parseCompactionPersistSignal` 与 `CompactionPersistSignal` 类型，后台压缩落盘信号的 customType 与 details 判据收敛为写侧扩展与读侧 runtime 同引的单源。
