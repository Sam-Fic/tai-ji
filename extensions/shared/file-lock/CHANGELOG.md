# @zhushanwen/pi-file-lock

## 0.5.0

### Minor Changes

- ada38ebfc: 同步文件锁退役重试与 stale 自动夺取：锁冲突（ELOCKED）不再 busy-wait 重试而是立即抛错，错误文案给出恢复指引（确认无进程写入后手动删除锁目录再重试）；崩溃残留锁不再 30 秒后被自动接管。`withFileLockSync` 不再接受选项参数，`DEFAULT_STALE_MS` / `DEFAULT_RETRY_DELAY_MS` / `DEFAULT_RETRY_BUDGET_MS` / `SyncFileLockOptions` / `setFileLockLogger` 导出移除，对 `@zhushanwen/pi-extension-logger` 的依赖一并移除。

## 0.4.1

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
