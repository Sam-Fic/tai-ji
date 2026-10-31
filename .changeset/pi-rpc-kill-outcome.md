---
"@zhushanwen/pi-rpc": minor
---

杀链完成判别改为三值：`killPiProcess` 返回新导出的 `KillOutcome`（already-dead / signal-delivered），发信号失败（进程仍活）改为 reject 新导出的 `KillSignalError`（携带 pid/reason/errno 诊断字段），不再吞错后按成功 resolve——杀失败不再折叠成假成功（下游 pending 永挂、收割计数虚高）。
