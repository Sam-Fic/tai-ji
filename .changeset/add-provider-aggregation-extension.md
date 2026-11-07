---
"@zhushanwen/pi-provider-aggregation": minor
---

新增模型聚合路由扩展（新包）：在 providers.json 顶层 routes 域把一个虚拟模型配置为多个供应商端点，pi 每次请求发起前按时间窗 / 额度 / 重试排除规则选出实际发往的物理模型；配置改动无需重启，下一请求即生效。
