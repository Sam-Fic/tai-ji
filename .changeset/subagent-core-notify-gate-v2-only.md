---
"@zhushanwen/subagent-core": minor
---

通知投递门 `notifyGateAllowsDelivery` 收窄为单维判定（放弃轮标记命中阻断），删除第二参数与 `NotifyGateInbound` 导出类型（跨世代重复帧改由 notifyId 投递日志判重承接）；孤儿 run 对账的存活引用集只解析 v2 注册条目，v1 快照与 pre-W17 link 指针条目按不存在处理（已裁决无存量数据）。
