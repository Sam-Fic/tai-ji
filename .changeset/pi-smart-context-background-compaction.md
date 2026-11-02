---
"@zhushanwen/pi-smart-context": patch
---

上下文压缩后台化：compact_context 工具触发立即返回成功回执，压缩生成期间对话不被拒绝、不被掐断（后台执行，完成后下一次请求自动切换到压缩后上下文）；新增 autoCompactThresholdRatio 配置（默认 0.9，相对模型窗口的自动触发线，smart-context-ext-config.json 可改）；落盘形态与原生压缩完全一致（可重载、可 fork）；完成/失败经通知通道播报。/compact 手动命令与溢出恢复压缩保持同步行为（设计例外，ADR-0182）。
