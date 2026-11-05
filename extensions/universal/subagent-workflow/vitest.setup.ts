// vitest.setup.ts
//
// 测试宿主装配（F-R6）。

import os from "node:os";
import path from "node:path";

import { configureCore } from "../../../packages/subagent-core/src/core/host-services.ts";

// F-R6 测试宿主装配：subagent-core 的 logger facade 经 host-services 配置态解析，
// 未 configureCore 时 warn/error 落 NULL_HOST 缺省 console（`[subagents]` 前缀裸打
// stderr——如 delivery-port 的 delivery bucket 日志）。多包连跑高负载下，这些
// console 输出经 vitest worker RPC（onUserConsoleLog）与 worker teardown 竞态会
// 随机触发 EnvironmentTeardownError（coverage-gate.py 已登记的已知竞态形态）。
// 此处统一装配 no-op log host：测试不依赖产品日志的 console 出口（日志断言范围
// 一律 mock logger），消除 stderr 噪音与竞态载荷。setupFiles 每测试文件模块
// 加载前运行，模块 slot 逐文件重置，无跨文件泄漏。
configureCore({
  dataRoot: () => path.join(os.tmpdir(), "subagent-workflow-tests"),
  log: () => {},
});
