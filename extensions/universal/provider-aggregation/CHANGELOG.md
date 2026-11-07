# @zhushanwen/pi-provider-aggregation

## 0.2.1

### Patch Changes

- f050b6853: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.29.0 → @zhushanwen/extension-protocol@0.30.0)

## 0.2.0

### Minor Changes

- 20e2d850c: 新增模型聚合路由扩展（新包）：在 providers.json 顶层 routes 域把一个虚拟模型配置为多个供应商端点，pi 每次请求发起前按时间窗 / 额度 / 重试排除规则选出实际发往的物理模型；配置改动无需重启，下一请求即生效。
