# API 文档（交付物自身的对外接口）

交付物 = `@zhushanwen/pi-provider-aggregation` 扩展的 D6 修订（重试透传 + 终局 failover）。
本次修订**不新增**任何命令 / 工具 / 配置键 / 存储域——对外接口面零扩张，只改路由求值语义。
下文按表面类别登记现状与本次改动。

## 命令

不适用：本扩展不注册 slash 命令（路由经 pi 虚拟模型 `aggregation/<路由id>` 选择即生效，
无命令面）。既有命令面归 taiji 设置页（runtime 侧），不在本包。

## 工具

不适用：本扩展不注册 agent 工具（纯路由扩展，无 registerTool 调用点）。

## 配置

- `providers.json` 顶层 `routes` 域（权威 schema = `@zhushanwen/extension-protocol` 的
  `AggregationRoutesFile`）：`{version, routes:[{id,name,modelId,enabled,mode,members,specials}]}`。
  **本次零改动**——键集、校验、路径公式（`<agentDir>/config/providers.json`）均不变
  （case D1 以实装 `parseAggregationRoutesSection` 对探针配置断言）。
- pi 既有设置 `settings.retry.maxRetries` / `settings.retry.enabled`（缺省 3 / true）：
  本扩展**只读**，作为 failover 触发口径的尺（readMaxRetries：`enabled=false → 0`，
  否则 `maxRetries ?? 3`）。无新增配置项，无热重载机制（每轮求值同步读，settings 变更
  下一轮求值生效——与路由配置 mtime 重读同型）。
- 读取路径仍只有两个：routes 配置（mtime 门重读）与 quota-cache.json（mtime 门 + 新鲜度
  过滤）——本次不新增第三个读取点。

## 存储

- 落盘面 = pi session branch 的 `pi.virtual-model-state` 自定义条目
  （`{provider:"aggregation", modelId:<路由id>, state:{burnt:string[]}}`，burnt = 已烧端点
  memberRef 有序集，插入序 = burn 序）。写入条件（pi 契约）：route 返回值 `state !== undefined`
  且 `!== request.state`（引用比较）才 append——实现侧 burnt 集合无变化时返回 `undefined`，
  不产生重复条目。
- 原子性 / 损坏行为：条目写路径归 pi（appendCustomEntry）；本扩展只负责**读侧防御**——
  `parseFailoverState` 对坏形状（非对象 / 缺 burnt / 非数组 / 元素非串）一律返回空集并保序，
  不抛异常（可靠性项：手改 / fork 的 session 不炸路由）。
- 格式演进取向（v1 首版声明）：`{burnt: string[]}`。后续如加字段（如每端点烧次时间戳——
  时间字段受 ADR-0190 约束不会加），旧 session 缺字段按空集解析（软避让退回配置序，
  单轮代价），不写迁移、不重建；坏形状同空集契约。链内失败计数（failures）**不落盘**——
  闭包内存，生命周期 = 活跃重试链。
- 不落盘面：无自有数据目录、无 sidecar 文件（taiji session 树无本扩展域）。

## 挂点

- `pi.registerVirtualModel`（工厂期 + session_start 对账 + 求值前重读三个注册时点，既有机制）：
  注册态本次不变。
- `route(request, ctx)` 回调（每请求一次）：本次修订的核心挂点。职责边界：
  - `reason=retry && failed`（物理端点失败）：**纯透传**——bumpChainFailure + 原样返回该端点，
    不复查路由条件、不写 router state；
  - 其余（user / continuation）：终局观察（messages 尾扫描物理结局）→ 条件求值（硬闸）→
    burnt 软避让（重排不删候选）→ 全 burnt 轮换重探；burnt 变化才写 state；
  - 全部失败路径 throw 结构化错误（AX5，闭包统一出口）——删除了 retryOnly 分支
    （「上一端点失败且无其他可用端点」文案），无候选错误的落选原因词表收窄为
    时间窗外 / 额度低于阈值两项。
- 降级行为：配置损坏 / 不可读保持上一有效注册（既有）；坏形状 router state 按空集
  （软避让失效 = 退回配置序，单轮代价）；direct 求值（压缩摘要）不传 state → burnt
  不生效（已登记显式不做 + 重审触发）。
