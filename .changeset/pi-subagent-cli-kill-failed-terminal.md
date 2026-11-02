---
"@zhushanwen/pi-subagent-cli": minor
---

子进程杀链失败成为显式终态：`killAllActiveChildren` 改为异步并返回三分类记账 `DisposeReapTally`（killed / finished / leaked，leaked 带 pid 与失败原因），杀不死的进程对应 run 以新退出码 125 显式失败收尾（新增导出 `KILL_FAILED_EXIT_CODE` / `settleExitAsKillFailed` / `describeKillFailure`），不再以「已杀 N 个」的虚高计数掩盖进程泄漏。
