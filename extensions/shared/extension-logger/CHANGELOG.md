# @zhushanwen/pi-extension-logger

## 0.7.0

### Minor Changes

- ada38ebfc: 扩展日志 warn/error 的 60 秒固定窗口限流退役：重复日志不再被抑制、也不再折叠成「[+N suppressed]」聚合摘要，全部直接写入会话日志（测试辅助导出 `clearRateLimiterState` 一并移除）。

## 0.6.2

### Patch Changes

- 802af968f: (no changeset body; patch version bump)

## 0.6.1

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
