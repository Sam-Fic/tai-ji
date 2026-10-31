---
"@zhushanwen/pi-session-reader": minor
---

锚扫描适配会话解析 fail-fast 契约：含非法 message role 的会话文件在锚查找与归因扫描中整体跳过（不再按行局部解析出部分结果），新增导出 `readParsedEntriesBestEffort` 供候选容错读复用；显式报错的主读链行为不变。
