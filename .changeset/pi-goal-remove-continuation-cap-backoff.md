---
"@zhushanwen/pi-goal": minor
---

goal 自动续跑的时间/计数机制退役：continuation 连发封顶、无进展指数退避定时器、终态 2 轮自动清理与 session_shutdown 清理钩子全部移除——continuation 仅在 agent_end 时刻立即发送（空 turn 与 pending defer 轮不发，循环由此自然停止），终态 goal 保留到用户显式 /goal clear，`PI_GOAL_*` 系列环境变量失效，持久化状态中的熔断计数字段不再读取。
