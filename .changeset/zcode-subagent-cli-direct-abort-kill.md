---
"@zhushanwen/zcode-subagent-cli": minor
---

zcode 引擎的中止链路退役 grace 等待窗与 stop 超时：abort 直落杀链收割共享进程（不再等宽限窗内终态），连接 shutdown 与 session/stop 请求不再接受超时/宽限参数，相关常量表（`constants.ts` 的 grace/timeout 项）移除。
