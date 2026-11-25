---
"@zhushanwen/extension-protocol": minor
---

`SessionManagerCreateParams` 新增可选 `model` 字段（`"provider/modelId"`，additive）：create action 可指定新会话的生效模型，类型范围检查同步扩展（非 string 走 error envelope）。
