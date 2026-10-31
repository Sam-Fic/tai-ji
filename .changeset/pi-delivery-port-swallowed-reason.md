---
"@zhushanwen/pi-delivery-port": minor
---

`DeliveryDeliverResult` 的 swallowed 分支 reason 收窄为仅 `already-seen`，删除 `duplicate-content` 成员——port 半区不存在内容级判重，幂等判定由显式 id 去重承担。
