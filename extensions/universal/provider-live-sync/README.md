# @zhushanwen/pi-provider-live-sync

让 pi 进程在**会话加载时**看到 provider / 模型 / 凭据的最新配置（重开会话即生效）。

## 解决的问题

pi 的可用模型集合在**进程启动时**冻结：`set_model` 从内存快照 `getAvailableSnapshot()` 解析，
而 pi 自身没有文件 watcher、也没有 refresh RPC。于是「设置页新增 provider/模型/凭据 →
切换到新模型」会失败并报 `Model not found`（缺凭据与缺模型是同一句文案）。

## 机制

- **session_start 时**执行一次 `ctx.modelRegistry.refresh({ allowNetwork: false })`：
  pi 的 `ModelRuntime.refresh()` 首行重读磁盘配置（`<agentDir>/models.json` 与
  `<agentDir>/auth.json`，`getAgentDir()` 解析、尊重 `PI_CODING_AGENT_DIR`）并重组 provider，
  `allowNetwork:false` 保证**零网络请求**（本地恢复相位，凭据解析/入网前返回）；
- **models.json 缺失（ENOENT）时跳过刷新**：refresh 会以「无 override 的空配置」重建可用
  集合，配置源缺失窗口内刷新会把坏写放大成自定义 provider 的真正丢失；catalog-only 安装
  （models.json 从未存在）spawn 快照本就无自定义 provider，跳过无损失；
- 刷新后读 `ctx.modelRegistry.getError()`：非空即原样落 ERROR 日志（模型配置被引擎拒绝的
  唯一有效判据——该退化形态下 `refresh().errors` 为空）；
- taiji 托管环境另有**目录投喂（catalog overlay）**职责：模型目录缓存
  `<数据目录>/provider-catalog-overlay.json`，工厂期经 `pi.registerProvider` 注入
  「内置基线 ⊕ 缓存条目」并集，session_start 刷新前先对当前 fresh 且尚未注册的 provider 做一次**注册对账**
  （补 `registerProvider`——工厂期因过期 / 缺失 / 损坏未注入的 provider 没有刷新钩子，单靠刷新
  重建不了注入），再触发同一次零网络刷新——上游目录新模型在会话加载后可见。条目三态：
  **fresh** 注入 / **expired·never-seen** 不注入（已注入的撤销、回落 pi 内置基线）/
  **损坏·不可读** 不注入新 provider、已注入的保留，文件修复后下一次 session_start 对账重建注入。
  原生 pi 用户（无 `TAIJI_AGENT_DATA_DIR`）整条不挂（pass-through）。

## 语义要点（易误解处）

| 情形 | 行为 |
|------|------|
| `models.json` **不存在**（ENOENT，catalog-only 安装的常态） | 跳过刷新（防空配置重建护栏；spawn 快照本就无自定义 provider，无损失） |
| `models.json` 读失败（权限等非 ENOENT） | 按存在处理，刷新照常（刷新无害） |
| 刷新抛错 | 记 ERROR 日志，不阻断会话启动；下次 session_start 重试 |
| 目录缓存条目 **fresh** | 注入「内置基线 ⊕ 缓存条目」并集；session_start 刷新生效（工厂期未注册的 provider 由注册对账补注册） |
| 目录缓存条目 **expired / never-seen**（过期、从未见过、缓存缺失） | 不注入；已注入的经 `refreshModels` 钩子撤销、回落 pi 内置基线 |
| 目录缓存**损坏 / 不可读** | 不注入新 provider，已注入的保留当前注入；修复或删除文件（下次目录刷新重写）后下一次 session_start 自动对账重建注入 |

## 安装

作为 taiji 内置扩展随应用打包（`mandatory-extensions.json` 中 tier=infrastructure）。
独立 pi 用户亦可安装：`pi install @zhushanwen/pi-provider-live-sync`。

## 排障

- 日志前缀 `[provider-live-sync]`：`session start → refreshing model snapshot` 表示会话加载时
  已执行零网络刷新；`models.json absent — refresh skipped` 表示配置源缺失、刷新被护栏跳过
  （引擎保留 spawn 期快照）；`model config rejected by the engine: ...` 表示 pi 拒绝了配置
  （原文含字段路径，来源不限——两配置文件与目录投喂注入集都可能被拒）。
- 目录投喂侧：`catalog cache corrupt/unreadable ..., overlay injection skipped` = 工厂期或对账拍
  缓存损坏/不可读、不注入新 provider（修复或删除该文件后下一次 session_start 自动对账重建注入）；
  `catalog cache unreadable during refresh ... keeping the current injection` = 运行期保留注入、
  文件恢复可读后自愈；`catalog overlay model skipped` / `registerProvider failed` = 目录数据
  不完整或 pi 结构校验失败，等下次设置页目录刷新或按日志里的缓存路径修数据源（缓存重写后
  自动重试注册）。
