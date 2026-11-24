---
"@zhushanwen/subagent-core": minor
"@zhushanwen/pi-subagent-workflow": minor
---

subagent_batch 工具切换专用执行体模板 `batch`：批量派发不再走通用 `fan-out` 模板，改为专用的「N 个独立任务并行派发 + 全量收集」模板——**去掉 aggregate 归约节点**，成员结果原样全量返回（`outcome.results`），归约由主 agent 自行完成（批量契约 = 把事实收齐，不替主 agent 下结论）。收集内核（成员对象校验 / 派发 / allSettled 降级 / deliverables 产物契约谓词 / 通知体积保序截断 / partial 收尾）收敛为 `workflows/_shared/batch-collect.cjs` 单实现，`batch` 与 `fan-out` 两模板共用，通用 `fan-out` 模板的可选 `aggregate` 归约段保留供直跑场景按需使用。
