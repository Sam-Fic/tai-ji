---
"@zhushanwen/pi-todo": patch
---

todo 事件处理器（before_agent_start / agent_end）不再自行捕获异常降级为 debug 日志，错误统一上抛由 pi ExtensionRunner 逐 handler 兜底进入诊断链（带扩展路径与堆栈），问题可见性提升；处理成功路径行为不变。
