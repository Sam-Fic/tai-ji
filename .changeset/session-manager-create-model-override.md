---
"@zhushanwen/pi-session-manager": minor
"@zhushanwen/extension-protocol": minor
---

`create_managed_session` 新增可选 `model` 参数（`"provider/modelId"`，additive）：创建子会话时指定生效模型——工具参数经协议 `SessionManagerCreateParams.modelOverride` 由 runtime handler 透传创建链（`override > preset > 全局默认`）；不传仍用 settings.json 全局默认（新建路径无父会话模型继承）。协议层同步补字段与类型范围检查（非 string 走 error envelope，不静默流入 sessionService）。
