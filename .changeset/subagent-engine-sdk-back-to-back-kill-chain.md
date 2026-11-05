---
"@zhushanwen/subagent-engine-sdk": minor
---

引擎杀链从「SIGTERM → 优雅窗等待 → SIGKILL 升级」改为 SIGTERM+SIGKILL 背靠背直发：`killChain` 改为同步返回，`KillChainOptions.graceMs` / `PidChainOptions.graceMs` / `DEFAULT_KILL_GRACE_MS` / `DEFAULT_NATIVE_INTERRUPT_GRACE_MS` 与宿主超时合成终态（`HOST_TIMEOUT_ABORT_REASON` / `synthesizeTimeoutOutcome` / `engineTimeoutDetail`）移除，引擎进程探测不再设超时。
