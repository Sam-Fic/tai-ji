---
"@zhushanwen/pi-session-reader": minor
---

标题元数据缓存退役 TTL 失效通道，仅按目录 mtime 变化失效：目录 mtime 不变期间不再定时重扫；`METADATA_CACHE_TTL_MS` 导出移除。
