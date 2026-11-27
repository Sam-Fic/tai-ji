# 内置通用编排 Workflow

7 个开箱即用的通用 subagent 编排 workflow，覆盖日常常见的多 agent 协作模式。每个脚本用 `agent()`/`parallel()` 自包含实现，`workflow run <name>` 直接执行，无需额外定义子 workflow。其中 `batch.js` 是 `subagent_batch` 批量 tool 的固定执行体（纯收集、无归约节点），与 `fan-out.js` 共用同一收集内核 `_shared/batch-collect.cjs`。

## 文件清单

| workflow | 模式 | 必需参数 | 适用场景 |
|----------|------|----------|----------|
| `chain.js` | analyze → transform → synthesize 顺序链 | `task` | 多阶段处理：先分析、再变换、最后综合 |
| `parallel.js` | 多视角并行分析 → 聚合汇总 | `target`（可选 `perspectives`） | 多维度评估同一目标（安全/性能/可维护性等） |
| `scatter-gather.js` | scatter 拆分 → parallel 处理 → gather 合并 | `task` | 大任务先拆成子任务再并行处理 |
| `map-reduce.js` | parallel map → reduce 归约 | `items`/`itemsJson` + `operation` | 对已知数组批量变换后归约成单一结果 |
| `review-fix-loop.js` | 多批串行（批内并行 review → aggregate → fix → 重审） | `targetType` + `target`（可选 `batch1..batchN`） | 代码/文档审查并修复直到 clean；前置检查先行（fallow 等） |
| `fan-out.js` | N 个独立任务并行派发 + 全量收集，可选 aggregate 归约 | `tasks` 成员对象数组（可选 `aggregate`） | N 条自包含任务一次派发，需要一份归约结论时开 aggregate |
| `batch.js` | N 个独立任务并行派发 + 全量收集（**无归约节点**） | `tasks` 成员对象数组 | `subagent_batch` 批量 tool 的执行体；结果原样全量带回，归约由主 agent 自行完成 |

> ⚠️ **review-fix-loop 是唯一带写操作的内置 workflow**（fix 阶段修改文件，`autoCommit=true` 才 commit）。其他 6 个均为只读分析。

## 用法

### chain — 顺序多步处理

```
workflow run chain --args task="把这段需求文档拆成技术任务：..."
```

三段 agent 调用：分析任务 → 基于分析产出方案 → 综合方案输出结论。每步用 `schema` 拿结构化输出，上一步输出拼进下一步 prompt。

### parallel — 并行多视角分析

```
workflow run parallel --args target="src/auth/login.ts"
workflow run parallel --args target="..." --args 'perspectives=["security","readability"]'
```

`perspectives` 默认 `["security","performance","maintainability"]`。每个视角一个并行 agent，各自返回评分+发现的问题，最后纯代码拼接各视角的 findings。`outcome.aggregate` 是各视角 findings 的拼接字符串（格式：`[perspective] finding1; finding2`，换行连接）——需要结构化的 per-perspective 评分/发现请读 `outcome.per_perspective`，`aggregate` 按纯文本消费。

### scatter-gather — 分发-收集

```
workflow run scatter-gather --args task="重构认证模块，涉及 session/jwt/oauth 三块"
```

三段：第一个 agent 把大任务拆成 2-4 个可并行子任务 → `parallel()` 并行处理每个子任务 → gather 阶段用 `agent()` 把各子任务结果合并成最终结论（LLM 合并，非纯代码拼接）。

### map-reduce — 映射-归约

```
workflow run map-reduce --args 'items=["file1.ts","file2.ts","file3.ts"]' --args operation="审查代码风格"
workflow run map-reduce --args itemsJson=/path/to/items.json --args operation="..."
```

`items` 直接传 JSON 数组，或 `itemsJson` 传 JSON 文件路径（二选一）。`parallel()` 对每个 item 并行执行 `operation` → reduce 阶段用 `agent()` 把各 item 的 map 结果归约成单一结论（LLM 归约，非纯代码拼接）。

### review-fix-loop — 多批审查-修复循环

```
workflow run review-fix-loop --args targetType=git-diff target=main \
  --args fallowScan=true --args batch1=/path/to/reviewer.md --args autoCommit=true
workflow run review-fix-loop --args targetType=file target=/path/to/doc.md \
  --args batch1=/path/to/doc-reviewer.md
```

- `targetType` 枚举：`git-diff`（target=base ref）/ `file`（target=路径）/ `dir`（target=目录）/ `text`（target=自由描述）
- `batch1..batchN`：批串行，批内并行 review → aggregate → fix → 重审直到 clean；批次用于前置依赖（如 `fallow-scan` 静态分析先行，后续审查才有意义）
- 批内某 agent 无 must-fix 后后续轮跳过（`skipCleanAgents` 默认 true + `recheckAfterFix` 默认 false）：clean agent 下轮跳过不重派；显式传 `recheckAfterFix=true` 启用强回归模式——fix 后重派全批，clean agent 走限定 prompt（只审 modifiedFiles ∪ 自检关联点，不诱导全量重扫）
- agent 项仅支持 .md 文件绝对路径（如 `batch1=/path/to/reviewer.md`，`~/` 前缀可展开；内置角色取 <available_subagents> 注入的 <location> 路径，名字只是展示标签，裸名会被拒）；`fallow-scan` 静态分析不走 agent 项——由独立参数 `fallowScan=true` 前置插入首批（不占 batchN）；**内置 `doc-reviewer`**（文档场景推荐：`targetType=file/dir` + `batch1=<doc-reviewer.md 的注入路径>`，四遍审查方法论：事实锚点核实/逻辑断言验证/落地清单完备性/边界与迁移；不写文件，报告经 schema 返回由 workflow 落盘）
- `fixAgent`（可选）：fix 阶段加载指定 agent（.md 绝对路径，值语义同 batchN 的 agent 项）；代码场景可在该 agent.md 内写 verify 命令（typecheck/test 实测）当轮拦截编译类回归。⚠️ agent.md 内写的 verify 命令**必须确认能在目标项目可运行**（target 的包管理器/目录结构未知），否则命令失败会误报 fix 状态
- `maxFixAttempts`（可选，默认 2）：needs-redesign 阈值。问题经 maxFixAttempts 次修复仍未收敛（regressed）→ 终止该批，terminated="needs-redesign"（结构性问题需人工介入，非继续补丁能解决）
- `convergeNewIssues`（可选，默认 1）+ `convergeRounds`（可选，默认 2）：新发现率收敛阈值。连续 convergeRounds 轮新发现问题 ≤ convergeNewIssues **且**无 open/regressed 活跃条目 → terminated="converged"（推进下一批）。收敛不等于问题全清——需同时满足无活跃条目才终止
- ⚠️ **fix 阶段会修改文件；`autoCommit` 默认 false（不 commit）**，需要提交时显式 `autoCommit=true`

### batch — 批量派发（纯收集，`subagent_batch` 工具的执行体）

```
workflow run batch --args 'tasks=[{"task":"统计 src 下 ts 文件数","agent":"/path/counting-agent.md"},{"task":"统计 src 下 md 文件数"}]'
```

`tasks` 每个元素 = 一个成员对象：`task` 必填（完整自包含、可直接派发的任务描述），可选 `agent`（成员级执行者 .md 绝对路径）/ `model` / `thinkingLevel`（成员级覆盖）。全部任务并行执行，结果一次性收齐：

- 任一成员失败不阻断其余成员：部分失败收尾 `status=partial`（失败条目带 `taskIndex`/`error`），只重派失败 `taskIndex` 对应的成员即可，勿全批重跑
- 成员可选 `deliverables`（产物契约，机器可验证谓词）：`[{kind:"file", path, minBytes}]` 要求产物文件真实落盘（size ≥ minBytes，缺省 1 = 存在且非空）/ `[{kind:"structured_output"}]` 要求成员结构化产出有效。全不满足 → 该成员 failed（`agent.no_deliverable`）；部分满足 → 不算失败，缺项记 `outcome.partialMembers`（`[{taskIndex, missing[]}]`）与该成员条目 `observations`；不传 = 不做交付校验
- **无归约节点**：结果原样全量返回（`outcome.results`），需要一份结论请自行归约（或改用 `fan-out` 的 `aggregate`）
- 每个成员输出 `summary`（数百字内，通知内联展示）+ 可选 `fullReportPath`（完整产物落盘路径）；结果总量超预算时按序截断并置 `truncated` 标记（`taskIndex`/`status`/路径/`observations` 恒完整）

经 `subagent_batch` 工具调用时，工具层会自动把运行级 `agent` 填进未指定的成员，`model`/`thinkingLevel` 留空给 `$MODEL`/`$THINKING_LEVEL` 继承。

## 编排 API

这些 workflow 内部使用的编排函数（`agent()` / `parallel()` / `pipeline()`）由 worker 线程注入，完整 API 参考见 workflow-script-format SKILL.md——该文档位于 pi 侧 subagent-workflow extension 内（`extensions/universal/subagent-workflow/skills/workflow-script-format/SKILL.md`，相对 pi extension 包根解析），**不是本包资产**，本包内无对应路径。

## 相关文档

- workflow-script-format SKILL.md（位于 pi 侧 subagent-workflow extension，`extensions/universal/subagent-workflow/skills/workflow-script-format/`，非本包资产）— workflow script 完整 API（agent/parallel/pipeline 签名、$ARGS/$BUDGET、lint 规则）
- `docs/extensions/adr/pi-ext-030-subagents-workflow-merge.md`（位于 workspace 仓根，非本包内路径）— 合并决策（决策 3 分层配额）
- `docs/extensions/adr/pi-ext-032-builtin-orchestration-workflows.md`（位于 workspace 仓根，非本包内路径）— 内置通用编排 workflow 的定位决策
