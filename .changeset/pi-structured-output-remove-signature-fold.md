---
"@zhushanwen/pi-structured-output": minor
---

structured_output 循环门控的连续失败熔断（3 次签名折叠判重后终止）与错误签名归一化退役：失败只记账不熔断杀子进程，失败循环的终止交由 steer 重试上限与 workflow 层 maxTurns 兜底；`normalizeErrorSignature` / `MAX_CONSECUTIVE_FAILURES` / `SIGNATURE_MAX_CHARS` 等相关导出移除。
