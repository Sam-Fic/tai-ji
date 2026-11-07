---
name: provider-aggregation-ext-config
description: "使用或排查 @zhushanwen/pi-provider-aggregation（模型路由 / 聚合模型）时加载。说明路由配置的磁盘位置与 schema（<agentDir>/config/providers.json 顶层 routes 键，权威 schema 在 @taiji/shared aggregation 域）、配置生效机制（工厂期注册 / session_start 对账 / 求值前 mtime 重读，无定时器无文件 watcher）、故障契约（配置损坏保持旧注册继续路由、额度未知 fail-open、停用/删除显式失败）、额度数据来源（quota-cache.json）与配置示例。触发词：provider-aggregation、模型路由、聚合模型、模型聚合、providers.json、routes 配置、路由不生效、路由不切换、切换模型失败、时间窗、额度阈值、quota、特殊日期、aggregation/<路由id>、aggregation-ext-config。"
---

# provider-aggregation 配置与排障指南

> @zhushanwen/pi-provider-aggregation：pi 进程内的模型路由扩展。把 providers.json 顶层
> routes 域派生为 pi 虚拟模型注册（每条路由 = 模型选择器里的一个可选模型，对外模型 id =
> `aggregation/<路由id>`），每个请求发起前按端点条件（时间窗 / 额度阈值 / 重试排除）选出
> 本次实际发往的物理模型。本扩展**只读**配置；写侧唯一入口是 taiji runtime 的
> provider-extras-store（设置页路由 UI 的保存链）。

## 配置文件位置（排障必读）

路由配置 = `<agentDir>/config/providers.json` 顶层 `routes` 键：

- `<agentDir>` = pi 的 `getAgentDir()`（`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；
  taiji 托管形态指向 `<数据目录>/agent`）。
- providers.json 是 taiji 的扩展域配置文件（pi 引擎零消费该文件）；顶层其余键
  （providers / scopedModels 等）与路由无关，本扩展只读 `routes` 键。
- 写侧唯一 = runtime provider-extras-store（tmp+rename 原子写）；正常入口是 taiji 设置页
  路由 UI，手编文件合法但须符合下述 schema。
- 额度缓存 = `<数据目录>/quota-cache.json`（agentDir 的**上一级**目录），由 runtime
  QuotaCache 写、本扩展只读；文件不存在（如独立 pi 用户）= 额度未知（fail-open，见故障契约）。

## routes schema（权威源 = @taiji/shared aggregation 域）

schema 唯一定义点在 `@zhushanwen/extension-protocol/aggregation`（`packages/extension-protocol/src/aggregation.ts`
的 `AggregationRoutesFile` / `parseAggregationRoutesSection`）；下文是消费侧摘要，冲突时以
该模块为准。

顶层形态：

```json
{ "routes": { "version": 1, "routes": [] } }
```

- `routes` 键缺失 = 合法空域（无路由环境的常态，不报错、零注册）。
- `version` 恒为 1；形态损坏（非对象 / version 非 1 / routes 非数组 / 任一条目字段非法）
  = 整体判损坏，不做部分接受（无「坏条目静默过滤」）。

路由条目（AggregationRoute）字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | ≤64 字符 kebab-case（小写字母/数字开头结尾）；是模型切换（`aggregation/<id>`）与会话还原的对齐键，重命名 = 删除重建 |
| `name` | string | 显示名（模型选择器与路由卡呈现），非空 |
| `modelId` | string | 对外暴露的模型 id（编辑器当前恒与 id 同值生成） |
| `enabled` | boolean | false = 选择器不出现、请求显式失败「已停用」 |
| `mode` | `"simple"` \| `"advanced"` | simple = 依次兜底取第一个端点、不判条件；advanced = 按条件分流 |
| `members` | array | 端点有序数组，至少 1 条；按序取第一个条件全满足者 |
| `specials` | array | 特殊日期覆盖（可为空数组） |

端点条目（AggregationMember）字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 端点条目 id（路由内唯一，编辑器行对齐键） |
| `providerId` / `modelId` | string | 端点物理渠道（非空，须为有效模型目录中的 provider/模型）；引用已不存在者 = 悬空端点（落选 + 设置页标记提示） |
| `type` | `"none"` \| `"window"` \| `"quota"` \| `"combo"` | 条件类型（advanced 模式参与求值；window/quota/levels 字段可留驻不随 type 删除——切换模式不丢条件） |
| `window` | boolean[7][48] | 时间窗表：行 0-6 = 周一..周日，列 0-47 = 当日每 30 分钟一格；true = 该格可路由；按墙钟本地时区落格判断；字段缺省 = 无约束（判满足） |
| `quota` | `{ "thresholdPercent": 0-100 }` | 整数；端点剩余百分比（100 − 缓存已用）≥ 阈值判可用；100 = 恒耗尽判据（剩余须满格，真实账号恒不满足） |
| `levels` | `Record<string, string\|null>` | 端点 thinking 档位声明：key 存在且 value≠null = 支持该档（off/minimal/low/medium/high/xhigh/max）；缺省 = 档位未知（路由不声明档位，映射不干预） |

特殊日期（AggregationSpecialDate）：`id` + `date`（`YYYY-MM-DD` 本地日期）+ `mode`：

- `"exclude"`：该日全天判窗外。
- `"include"`：该日仅 `[from, to)` 判窗内（`HH:mm` 24 小时制、同日内 from < to），
  区间外回落周表判定。
- 同一日期多条覆盖取第一条匹配；特殊日期优先于周表。

## 配置生效机制（无定时器、无文件 watcher）

配置变更不是即时推送，读取按 mtime 门在三个时点发生（变化才重读磁盘）：

1. **扩展加载（工厂期）**：同步读配置并注册虚拟模型——早于 `--model` 参数解析，spawn
   直接指定路由可用。
2. **session_start 对账**：全量重读——配置中新增的路由在此补注册（**运行中新建的路由
   不热注册**，重开会话生效）；同时为全部条目补齐 contextWindow 元数据（端点最小值）。
3. **每次路由求值前**：mtime 检查重读，只处理已注册 id——同 id 编辑（改端点/条件/启停）
   对运行中会话的**下一请求**生效。

手编保存「内容未变的重复保存」也会更新 mtime 并触发一次重读；重读注册幂等（同 id =
替换），无错误行为。

## 故障契约（排查「路由报错 / 不切换」先对照这张表）

| 场景 | 行为 |
|------|------|
| providers.json 损坏 / 不可读（JSON 非法、schema 非法、权限、stat 故障） | **保持上一有效注册继续路由**，warn 留痕；恢复 = 修复文件后 mtime 变化自动重读，或重开会话 |
| 路由 `enabled=false` | 保持注册，请求显式失败「已停用」（提示去设置页处理） |
| 路由条目被删除 | 保持注册，请求显式失败「已删除」；同 id 重建后自动恢复（无需更换模型） |
| advanced 模式全部端点条件不满足 | 显式失败，错误逐端点列明落选原因（时间窗外 / 额度低于阈值 / 上一失败端点本轮排除）+ 恢复指引 |
| 额度数据缺失 / 过期 / quota-cache.json 缺失或损坏 | **fail-open**：额度条件按满足处理（未知不判死），真耗尽由自动重试换端点纠正 |
| 端点引用的 provider/模型不在当前模型目录 | 该端点本次落选（设置页有悬空标记提示）；全部不可解析时显式失败并列明引用 |

额度新鲜度：缓存条目距上次成功取数超过 10 分钟，或任一计费窗口的重置点已过，即判过期
（按未知 fail-open 处理）。判定与 runtime 刷新编排共用同一纯函数（@taiji/shared
aggregation 域），两侧不各自另写时间比较。

## 配置示例

`<agentDir>/config/providers.json`（与既有顶层键并存，这里只展示 routes 键；window 表是
严格 7 行 × 48 列布尔矩阵，手编易错，建议经设置页路由编辑器生成）：

```json
{
  "routes": {
    "version": 1,
    "routes": [
      {
        "id": "daily-driver",
        "name": "日常主力",
        "modelId": "daily-driver",
        "enabled": true,
        "mode": "advanced",
        "members": [
          {
            "id": "ep-primary",
            "providerId": "provider-a",
            "modelId": "model-a-main",
            "type": "quota",
            "quota": { "thresholdPercent": 20 }
          },
          {
            "id": "ep-standby",
            "providerId": "provider-b",
            "modelId": "model-b-large",
            "type": "combo",
            "window": "<7x48 布尔矩阵，此处省略——建议经设置页编辑器生成>",
            "quota": { "thresholdPercent": 10 },
            "levels": { "high": "high", "max": null }
          }
        ],
        "specials": [
          { "id": "sp-holiday", "date": "2026-05-01", "mode": "exclude" },
          {
            "id": "sp-night",
            "date": "2026-05-02",
            "mode": "include",
            "from": "22:00",
            "to": "23:30"
          }
        ]
      }
    ]
  }
}
```

simple 模式最小形态：`members` 只留一个 `"type": "none"` 端点、`specials` 留空数组。
`providerId`/`modelId` 须引用当前模型目录中真实存在的渠道（与设置页供应商/模型列表一致）。

## 日志与排障

日志走 `@zhushanwen/pi-extension-logger`（前缀 `[provider-aggregation]`）：

- **warn / error 行** → session JSONL 的 `provider-aggregation:log` custom entry
  （持久化、不进 LLM 上下文，重开会话可 grep）+ `TAIJI_AGENT_DEBUG=1` /
  `TAIJI_AGENT_EXT_LOG=1` 时落 `<agentDir>/logs/provider-aggregation-YYYY-MM-DD.log`。
- 常见 warn 文案：
  - `routes config corrupt/unreadable — keeping last valid registrations (<原因>)`：
    providers.json 损坏或不可读，已保持旧注册（按原因修文件后自动恢复）。
  - `quota cache read failed / is not valid JSON / is missing the providers object —
    quota snapshots treated as unknown`：额度快照缺失，全部端点的额度条件按满足处理。

排障顺序建议：先 `cat <agentDir>/config/providers.json` 核对 routes 段 schema
（version=1、字段类型、window 表 7×48）→ 再看 session JSONL 的
`provider-aggregation:log` 条目有无损坏/不可读 warn → 端点落选原因已逐条写在路由错误
消息里，无需猜测。

## 相关

- 行为总览：本包 `README.md`（注册派生规则、求值语义摘要）。
- schema 与校验唯一权威：`packages/extension-protocol/src/aggregation.ts`（@zhushanwen/extension-protocol/aggregation 子出口）。
- 求值行为契约矩阵：`docs/design/provider-aggregation-route-matrix.md`。
