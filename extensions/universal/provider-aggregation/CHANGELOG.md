# @zhushanwen/pi-provider-aggregation

## 0.2.3

### Patch Changes

- eed443751: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.31.0 → @zhushanwen/extension-protocol@0.32.0)

## 0.2.2

### Patch Changes

- 81bf59ceb: 模型路由重试语义修订（D6 → 方案 B）：自动重试时透传上一失败端点（不换端点、不复查条件，与直连模型同型），pi 的重试预算真正打到上游；预算用尽后该端点标记 burnt，下一轮请求 failover 到候选端点；账户类错误（401/配额等 pi 不重试的 fail-fast）保持主端点可见，不向候选漂移。修复单端点路由瞬态故障被「上一端点失败且无其他可用端点」掩盖真实上游错误并杀死重试链的问题。

- 81bf59ceb: 路由重试改为「原样重发到上次失败的端点」，让 pi 自身的重试预算真正到达上游端点；只有链内失败次数达到 pi 的 retry.maxRetries 后，才把该端点标记为 burnt 并软避让到下一个候选。账户/凭据类 fail-fast 错误保持主端点选中，避免账户问题被静默转移到备用端点。终局失败从对话历史回溯判定（跳过路由失败消息），连续路由失败也能幂等重推出正确结论。

## 0.2.1

### Patch Changes

- f050b6853: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.29.0 → @zhushanwen/extension-protocol@0.30.0)

## 0.2.0

### Minor Changes

- 20e2d850c: 新增模型聚合路由扩展（新包）：在 providers.json 顶层 routes 域把一个虚拟模型配置为多个供应商端点，pi 每次请求发起前按时间窗 / 额度 / 重试排除规则选出实际发往的物理模型；配置改动无需重启，下一请求即生效。
