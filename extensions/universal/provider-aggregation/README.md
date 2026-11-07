# @zhushanwen/pi-provider-aggregation

模型路由扩展：把 providers.json 顶层 `routes` 域（taiji 路由配置唯一权威，pi 引擎零消费该文件）派生为 pi 虚拟模型注册，每个请求发起前按端点条件选出本次实际发往的物理模型。

## 行为

- **工厂期注册**：扩展工厂函数体内同步读配置并 `registerVirtualModel`（pi pending 队列在全部工厂返回后、`--model` 解析前统一 flush——spawn `--model` 指向路由条目可直接命中）。
- **session_start 对账**：重读配置，已注册 id 幂等替换、条目消失标记删除态、新增 id 补注册，并为全部条目补齐 contextWindow 元数据（端点最小值）。
- **route 求值前 mtime 检查重读**：只处理已注册 id——同 id 编辑对运行中会话下一请求生效；条目删除保持注册 + 闭包显式失败（不调 unregister，避免 pi 原始 `is not registered` 错误）；配置新增 id 不热注册（留给下次会话加载）。无定时器、无文件 watcher。
- **条件求值**（纯函数，`src/router.ts`）：端点按序取第一个条件全满足者；条件四型（无条件 / 时间窗 / 额度阈值 / 组合）；simple 模式跳过条件依次兜底；特殊日期覆盖周表；额度数据未知 fail-open；retry 请求排除上一失败端点（仅本次）。
- **thinking level**：路由声明端点档位并集；route 返回时所选档向上映射到命中端点的最近支持档。虚拟模型 contextWindow = 端点最小值。
- **故障契约**：停用 / 删除 / 无候选端点全部显式失败（错误列明端点与恢复指引），不静默回落；配置损坏保持上一有效注册继续路由。
- **登记**：tier=feature（opt-in，可禁用/预设过滤；子 agent 经 mandatory 清单自动继承）。

## 配置

文件：`<agentDir>/config/providers.json` 顶层 `routes` 键（`{ version: 1, routes: [...] }`）。schema 与校验 SSOT 在 `@taiji/shared` 的 aggregation 域（`AggregationRoutesFile`）；写侧唯一入口是 taiji runtime 的 provider-extras-store，本扩展只读。

## 开发

```bash
pnpm -C extensions/universal/provider-aggregation exec vitest run   # 测试
pnpm -C extensions/universal/provider-aggregation typecheck         # 类型检查
```
