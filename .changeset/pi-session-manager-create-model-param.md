---
"@zhushanwen/pi-session-manager": minor
---

`create_managed_session` 新增可选 `model` 参数（`"provider/modelId"`）：创建前按可用模型目录全等校验（大小写敏感，未命中即报错并列出可用模型，不创建会话），通过后由 runtime 以 `--model` 生效；缺省行为不变（全局默认模型）。
