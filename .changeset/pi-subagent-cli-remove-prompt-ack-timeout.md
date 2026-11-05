---
"@zhushanwen/pi-subagent-cli": minor
---

pi 引擎 CLI 的提示投递确认退役 30 秒超时通道：确认结果类型 `PromptAckKind` 不再含 `timeout` 态，`DEFAULT_PROMPT_ACK_TIMEOUT_MS` / `PROMPT_ACK_TIMEOUT_ENV`（`TAIJI_SUBAGENT_PROMPT_ACK_TIMEOUT_MS`）与 `resolvePromptAckTimeoutMs` 导出移除；引擎侧 grace/超时参数随协议同步收紧。
