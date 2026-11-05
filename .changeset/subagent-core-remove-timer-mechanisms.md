---
"@zhushanwen/subagent-core": minor
---

记录级时间机制退役：空闲计时器（`armIdleTimer` / `DEFAULT_IDLE_TIMEOUT_MS` 等）、armed-receipt 超时（`ARMED_RECEIPT_TIMEOUT_MS` / `TAIJI_SUBAGENT_ARMED_RECEIPT_TIMEOUT_MS`）、取消结算宽限窗（`CANCEL_SETTLE_GRACE_WINDOW_MS`）、控制通道连接超时常量与时间预算工具（`scheduleTimeBudget` / `assertSafeTimerDelay` / `assertEntryTimeBudget` / `maxTurnsToWatchdogMs` 等）全部移除；记录轮次新增 `markRecordRoundActive` 标记。
