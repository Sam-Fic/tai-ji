---
"@zhushanwen/pi-extension-logger": minor
---

扩展日志 warn/error 的 60 秒固定窗口限流退役：重复日志不再被抑制、也不再折叠成「[+N suppressed]」聚合摘要，全部直接写入会话日志（测试辅助导出 `clearRateLimiterState` 一并移除）。
