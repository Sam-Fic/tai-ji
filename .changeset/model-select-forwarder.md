---
"@zhushanwen/pi-host-internals": minor
---

新增模型切换转发：pi 的 `model_select` 事件不经 RPC 转发，扩展现将「切换成功」写入一条隐藏 custom message（`taiji:model-select`，display:false，不触发新回合），供 runtime 分诊后广播 modelSwitch 帧；模型未实际变化时不写入。
