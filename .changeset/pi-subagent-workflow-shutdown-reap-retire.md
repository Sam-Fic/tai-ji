---
"@zhushanwen/pi-subagent-workflow": minor
---

退役进程级 shutdown 收割兜底（SIGTERM / SIGINT / beforeExit 时调 `markAllSpawnedChildrenDead` 的镜像记账 no-op，及测试钩子导出 `_resetProcessShutdownGuardForTest`）：子进程真实回收链（stdin-EOF 自灭 + dispose）不变，session_shutdown 优雅链照常执行。
