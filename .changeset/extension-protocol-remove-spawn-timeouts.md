---
"@zhushanwen/extension-protocol": minor
---

后台任务进程探测（ps / pgrep）的 5 秒超时保护退役：spawnSync 同步等待自然返回，失败照旧按不可达处理；卡死的外部命令会阻塞调用方（含进程退出收殓路径），不再按超时保守跳过。
