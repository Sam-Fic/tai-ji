---
"@zhushanwen/pi-subagent-workflow": minor
---

subagent start 工具移除 `idleTimeoutMs` 参数（空闲计时器退役）；workflow run / resume / control 的 `time` 预算不再有硬上界 fail-fast 校验（超 `MAX_TIMER_DELAY_MS` 即拒绝的入口检查移除），对应参数描述同步更新。
