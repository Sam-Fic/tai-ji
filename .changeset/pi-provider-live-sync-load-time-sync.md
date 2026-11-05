---
"@zhushanwen/pi-provider-live-sync": minor
---

模型快照的运行中 2 秒轮询热同步退役，改为会话加载（session_start）时一次性零网络刷新：会话开着修改 provider 配置在下次会话加载时生效；目录缓存对账随 session_start 执行（`CatalogOverlayBridge` 移除 `watcher` 字段、`createOverlayCacheWatcher` 导出删除），并新增 models.json 缺失时跳过刷新的护栏（避免把一次坏写放大成自定义 provider 真正丢失）。
