---
"@zhushanwen/pi-session-manager": minor
---

`create_managed_session` 新增可选 `model` 参数（`"provider/modelId"`，additive）：创建子会话时可指定生效模型并透传 runtime `modelOverride`；不传仍用 settings.json 全局默认（新建路径无父会话模型继承）。
