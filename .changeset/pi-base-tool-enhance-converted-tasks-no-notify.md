---
"@zhushanwen/pi-base-tool-enhance": minor
---

前台命令静默转后台后不再自动推送完成通知（2 秒 pid 轮询守望退役）：转后台任务的标记行、bash 工具描述与用户提示改为引导用 bash_output 主动轮询进度，任务终态由 bash_kill / 后台超时 / 会话重启收殓路径落定。
