---
"@zhushanwen/extension-protocol": minor
---

模型切换信号词表成为公共导出：新增 `MODEL_SELECT_CUSTOM_TYPE`（值 `taiji:model-select`），作为模型切换 custom message 的 customType 单源——写侧为 `@zhushanwen/pi-host-internals` 的 `model_select` 转发，读侧为 runtime event-interpreter 分诊。
