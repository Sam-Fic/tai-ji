---
name: scheduler-ext-config
description: "使用或排查 @zhushanwen/pi-scheduler（定时任务调度）时加载。说明任务创建/管理方式（/schedule 命令与 schedule 工具）、调度格式（interval duration 与 cron）、数据存储机制（按 sessionId 分片的独立 JSON 快照任务库）、运行限制。触发词：配置定时任务、scheduler 配置、定时调度、cron 任务、interval 任务、scheduler 存储、scheduler 数据在哪、定时任务排查、scheduler-ext-config。"
---

# scheduler 使用与存储指南

> @zhushanwen/pi-scheduler：定时任务调度扩展。任务到期时向当前 session 注入一条 message（`deliverAs: 'steer'` + `triggerTurn: true`，steer 直投：busy 时插入当前 turn、idle 时开新 turn），唤醒 agent 处理。

**重要前提**：任务数据存在**独立的 JSON 快照任务库**（按 sessionId 分片，见下文「数据存储位置」），不在会话 JSONL 里——会话 JSONL 只承载到期注入的提醒消息与用户对话。排查「任务存哪 / 为什么 resume 后任务变了 / fork 后任务是否继承」都必须基于此模型理解。

## 如何创建/管理定时任务

两条入口，底层都走 `SchedulerService`（单一业务实现，无双轨）：

### 1. `/schedule` slash 命令（用户直接输入）

| 用法 | 作用 |
|------|------|
| `/schedule` | 打开创建表单（空草稿，默认循环 + 每天 09:00） |
| `/schedule <schedule> <prompt>` | 打开预填时间/提示词的创建表单（如 `/schedule 5m 'check build'`） |
| `/schedule list` | 列出全部任务（按 nextRunAt 排序） |
| `/schedule on <id>` / `/schedule off <id>` | 启用 / 禁用某任务 |
| `/schedule rm <id>` | 删除某任务 |
| `/schedule run <id>` | 立即触发一次某任务 |

- 一次性（once）与 cron 形态由表单内选择/填写，不再有 `once` / `cron` 关键字子命令。
- 命令 handler 异步打开表单后立即返回——填表时长不受命令通道超时约束。
- `on`/`off`/`rm`/`run` 的 `<id>` 支持命令补全（`getArgumentCompletions` 会列出 `id · name · schedule`）。
- `json`/`print` 模式无交互通道：带参直建，无参/失败抛错（stderr 可见）。

### 2. `schedule` / `schedule_control` 工具（AI 调用）

- **`schedule`**（创建）：参数 `prompt`（必填，到期注入的消息）、`schedule`（必填，duration 或 cron）、`kind`（`once`/`recurring`，默认 `recurring`）、`name`（可选，缺省从 prompt 自动截取前 30 字）、`expires`（可选，默认 7 天；传 `"never"` 关闭过期）、`model`（可选，scoped model id（`provider/model`），任务执行所用模型；缺省跟随会话当前模型）。
- **`schedule_control`**（管理）：`action` = `list`/`toggle`/`delete`/`run`，`id`（toggle/delete/run 必填），`enabled`（toggle 必填）。
- 两个工具的返回都是结构化 `{content: [{type:'text', text}], details}`；业务失败以异常抛出（pi 只对 execute throw 置 `isError:true`，错误 message 作为 toolResult content 返回），不通过返回值表达失败。

> 创建/管理操作不受 agent 运行状态约束；**到期 dispatch** 也不等待 agent idle（steer 直投，busy 时插入当前 turn），仅受速率限制/同任务 in-flight 检查约束（见「运行限制与 dispatch 行为」）。

### 3. 创建方式（触发反转）

- **模型侧 `schedule` tool**：**直接创建**（无确认表单、无 headless「未经确认」附注）。参数不完整时必须先经 ask-user / 对话澄清，禁止猜测频率后静默创建。
- **人侧 `/schedule` 命令**：打开创建表单（GUI 走统一表单协议 / TUI 走 `ScheduleCreateComponent`），用户在表单里自定模式/时间/模型/提示词；命令异步打开、立即返回。`json`/`print` 模式无交互通道：带参直建、无参或失败抛错。
- **会话生命周期**：表单挂起期间 `session_shutdown`（quit/reload/new/resume/fork）会 abort 交互（不创建）；taiji 内切换会话不触发，表单保留。

## 调度格式

`parseSchedule` 的分流规则：**输入不含空格 → duration（interval 模式）；含空格 → cron（cron 模式）**。

### interval（duration 字符串）

格式 `<数字><单位>`，单位不区分大小写、支持单复数：

| 单位 | 别名 | 毫秒 |
|------|------|------|
| `s` | `sec`/`second`/`seconds` | 1000 |
| `m` | `min`/`minute`/`minutes` | 60_000 |
| `h` | `hr`/`hour`/`hours` | 3_600_000 |
| `d` | `day`/`days` | 86_400_000 |

示例：`5m`、`2h`、`1d`、`30seconds`。正则 `/^(\d+)\s*(s|sec|...)$/i`（注意：含空格的输入在 parseSchedule 分流时一律走 cron 分支，duration 实际不允许空格，`5 m` 解析失败）。

### cron（cron 表达式）

- **5 字段**（分 时 日 月 周）：自动在最前面补秒字段 `0`，变成 6 字段。例 `*/10 * * * *` → `0 */10 * * * *`（每 10 分钟）。
- **6 字段**（秒 分 时 日 月 周）：原样使用。
- 其他字段数（<5 或 >6）视为无效。
- 底层用 `croner` 库（dependencies + 静态 import，解析器随包安装恒在盘；cron 解析失败即表达式无效，interval 不受影响）。
- 创建时即校验表达式有效性（算不出下次执行时间 → `INVALID_SCHEDULE`）；运行中表达式失效（极少见，如月份边界）→ 任务被停用并记 `lastError='cron expression invalid'`。

示例：`*/30 * * * *`（每 30 分）、`0 9 * * 1-5`（工作日早 9 点）、`0 0 * * *`（每天 0 点）。

## 数据存储位置（排查必读）

**任务库 = 按 sessionId 分片的独立 JSON 快照文件**（任务库与会话事实分离）：

```
<agentDir>/scheduler/<root>/<segments>/<sessionId>.json
```

- `<agentDir>` = pi 的 `getAgentDir()`（读 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`；taiji 数据目录隔离时指向隔离目录如 `~/.taiji/.../agent`）。
- `<root>`/`<segments>` = 创建任务时 cwd 的 workspace 隔离段（根盘符 sanitize + 路径段）。
- `<sessionId>` = pi `SessionManager.getSessionId()`（分片键）。
- 文件内容：`{schemaVersion: 2, sessionFile?, tasks: [...]}` 全量快照；每次任务集变化（创建/toggle/删除/dispatch 记账/过期清理）整体重写——写临时文件 + fsync + `rename` 原子替换，无半写形态。
- 恢复：`session_start` 时 `PiSchedulerBackend.loadTasks()` 一次 `JSON.parse` 重建任务集。文件不存在 = 空任务集（新 session / fork / 从未建任务，正常路径）。
- 损坏处理：读时解析失败 → 原文件改名 `.corrupt-<ts>` 留证 + 按空任务集继续（调度不中断，warn 留痕）。

### fork / resume 行为

- **resume**：同 sessionId → 同分片文件，任务直接恢复。
- **fork**：新 sessionId → 对应分片不存在 → 空任务集。在 session A 创建的任务 fork 出 B 后不进 B（不同文件天然不共享），任务归属创建它的 session。
- **树回退（撤回消息）**：不删除任务——任务库独立于会话树，需显式 `rm`。
- **`--no-session` 模式**：任务照常持久化（分片键归一为 `no-session`）。

### 排障口径

任务真实状态 = `cat` 分片 JSON 文件本身；写失败（磁盘满等）内存态照常推进 + warn + 下写点重试，进程崩溃时至多丢「自上次成功写之后的变化」。

### taiji 任务面板（scheduler-manager 插件）

面板直读同一分片文件（`sessions.get` 取 cwd → 推导路径 → 读取），刷新 = 写后主动拉取 + 10s 轮询 + 会话激活拉取；写操作仍经 `/schedule` 白名单子命令。


## 运行限制与 dispatch 行为

| 限制 | 值 | 含义 |
|------|-----|------|
| 每 session 任务数上限 | 50（`MAX_TASKS`） | 超出创建报错 `Task limit reached` |
| dispatch 速率 | 6 次/分钟（`RATE_LIMIT_PER_MINUTE`） | 滑动窗口计数，超出则当前 tick 跳过、下个 tick 重试 |
| tick 间隔 | 30 秒（`TICK_INTERVAL_MS`） | 每 30 秒检查一次到期任务 |
| 默认过期 | 7 天（`DEFAULT_EXPIRY_MS`） | 仅 recurring；`expires="never"` 关闭 |
| 历史记录 | 最近 20 条（`HISTORY_LIMIT`） | 每任务的执行历史 |

dispatch 行为（`dispatchTask`，scheduler-steer-direct-dispatch 直投模型）：

- **steer 直投（经投递端口）**：到期任务经投递端口 `port.deliver` 注入（幂等键 `${taskId}:${epoch}`，失败 forget），形态与直发 `sendMessage(..., {deliverAs: 'steer', triggerTurn: true})` 逐字一致——agent busy 时消息插入当前 turn（立即被模型看到）、idle 时开新 turn。不排队、不等 idle、不丢弃。端口缺席（装配异常窗口）降级直发 + warn。
- **受理即记账**：`sendMessage` 是 fire-and-forget（返回 void），await 立即通过，`nextRunAt` 调用即推进——无「入队未终态」窗口。
- **同任务 in-flight 检查**：该任务 dispatch 在途（如 `/schedule run` 与 tick dispatch 并发）时本 tick 跳过，防双投。
- **模型切换**（`task.model` 设定且 ≠ 会话当前模型）：dispatch 前 `setModel` 切到目标任务模型、记未决切换记录（纯内存），恢复锚点 = `agent_settled` 事件 + isIdle 事实查询双通道，恢复后切回原模型；切换失败降级——照常 dispatch（模型字段不阻塞核心调度）。
- dispatch 成功后：记账（`runCount++` / history / `lastStatus='success'`）+ recurring 推进 `nextRunAt` / once 删除任务，快照整体落盘一次；失败（投递端口拒收 / 直发抛错）记 `lastStatus='failed'` 落盘不 rethrow，下个 tick 重试（nextRunAt 未推进，重试轮取新幂等键）。
- 注入的消息：`{content: task.prompt, customType: 'pi-scheduler:dispatched', display: true}`，投递选项 `{deliverAs: 'steer', triggerTurn: true}`。

## 任务数据结构

`ScheduledTask`（内存态，`types.ts`）核心字段：

- `id`：8 位 hex，自动生成。
- `name`：可读名称（用户指定或从 prompt 自动截取前 30 字）。
- `prompt`：到期注入的 message 内容。
- `kind`：`once` | `recurring`。
- `schedule`：`{mode:'cron', cronExpression}` | `{mode:'interval', intervalMs}`。
- `model?`：任务执行模型（scoped model id，`provider/model`）；缺省跟随会话当前模型。
- `enabled`：是否启用。
- `createdAt` / `nextRunAt` / `expiresAt?`：时间戳（ms）。
- `runCount` / `lastRunAt?` / `lastStatus?`（`success`|`failed`）/ `lastError?`：执行统计。
- `history`：最近 20 条 `ExecutionRecord`（`{at, status}`）。
- `pending?`：运行时标记「到期待 dispatch」，快照写入口统一剥离（与 `enabled` 正交）。

快照文件里的任务即上述字段的全量（`pending` 被剥离）。

## 示例

打开创建表单（空草稿，表单里选每天 09:00）：

```
/schedule
```

打开预填表单（每 5 分钟检查构建状态）：

```
/schedule 5m 检查当前项目的构建状态，失败则报告原因
```

一次性提醒 / cron 任务：在 `/schedule` 表单里切换执行模式（一次性）或填自定义 cron（如 `*/30 * * * *`）。非交互模式（json/print）带参直建：

```
pi -p "/schedule 5m 'check build'"
```

列出并禁用某任务：

```
/schedule list
/schedule off abc12345
```

AI 通过工具创建（指定模型 + 永不过期；工具直建，无确认表单）：

```
schedule({ prompt: "...", schedule: "1h", kind: "recurring", model: "anthropic/claude-sonnet-4-5", expires: "never", name: "hourly-check" })
```

## 备注

- **croner 依赖**：cron 模式依赖 `croner`（dependencies，随包自动安装 + 静态 import，2026-09 0.6.0 起；此前为 optional peer，独立安装形态下 cron 任务会静默失败）。cron 解析失败（`INVALID_SCHEDULE`）= 表达式无效，不存在「解析器未安装」形态。
- **数据目录隔离**：任务库在 `getAgentDir()` 下的 `scheduler/` 子目录。taiji 通过 `TAIJI_AGENT_DATA_DIR` / `PI_CODING_AGENT_DIR` 隔离实例时，任务库落在隔离目录，与 `~/.pi/agent` 互不干扰。
- **快照可 cat 但勿手改**：任务由运行时命令产生与管理；快照文件是排障观测点，手改会在下一次运行时写点被覆盖。要「批量预置任务」只能在 session 内逐条创建。
- **无参 `/schedule`**：打开创建表单（不是提示语）。任务管理用 `list`/`on`/`off`/`rm`/`run` 子命令或 `schedule_control` 工具。
