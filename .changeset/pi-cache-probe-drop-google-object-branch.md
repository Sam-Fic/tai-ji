---
"@zhushanwen/pi-cache-probe": patch
---

导出函数 `extractSystem` 删除恒不命中的 Google 对象形态 `systemInstruction` 提取分支（pi-ai 1.0.0 实装对该字段恒传 string，对象形态仅手工伪造输入可达）：实装流量下 spFull 哨兵值行为不变（Google 口径仍为 no-system），提取口径按 README 已知限制收窄为三口径。
