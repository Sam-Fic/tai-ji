---
"@zhushanwen/pi-base-tool-enhance": minor
---

后台任务登记文件读取失败（权限等）从静默按空表处理改为显式上抛：bash_output / bash_kill 会向模型报错，不再伪装成「无后台任务」；登记写回在读失败时停止，避免在空表视图上合并写回静默丢失全部既有条目。
