# 设计文档：provider-aggregation 重试语义修订（D6 → 方案 B）

> 树形交付任务文档。题面 = `/tmp/provider-aggregation-retry-failover-handoff.md`（provider-aggregation
> 重试语义修订交接文档，用户裁决 2026-11-24 取方案 B）。行为契约正文同步落在
> `docs/design/provider-aggregation-route-matrix.md`（docs-sync 枝交付），本文只承载树形拆分与验收指针。

## 背景与目标

provider-aggregation 扩展把 pi 的虚拟模型（`aggregation/<路由id>`）按路由条件落到物理端点。原 D6
「重试排除」在 pi 自动重试时把刚失败的端点临时排除后重新求值：单端点路由排除后候选集为空，闭包
throw「上一端点失败且无其他可用端点」——该二手错误掩盖真实上游故障（524 origin timeout），且不命中
pi 原生可重试词表，重试链死在 attempt 1/3（生产实证：session 01a202a5，route-3 持续 25h 失败）。
本交付按用户裁决把重试语义改为方案 B：**retry 透传 + 预算用尽后 failover**。受众 = 走模型路由的
pi 会话用户；现在做因为故障形态已被实机日志锤实且修复面（9 文件）已与原会话逐字节重建待合入。

| 编号 | 目标 | 题面原句（逐字） | 限定词落点 | case/落点 |
|---|---|---|---|---|
| G1 | retry 求值透传上一失败端点：原样返回、不换端点、不复查条件 | "先按照 pi 的重试规则重试当前真实模型"；"重试归属在途请求：透传，不换端点、不复查条件——与直连模型行为对齐" | 机制：闭包层 retry 分支（reason=retry && failed ∈ 配置 → bumpChainFailure + 原样返回） | T1,T7 |
| G2 | failover 触发口径 = pi 重试预算用尽；fail-fast 类不触发 | "如果超过 pi 的重试次数，则 failover 到候选模型"；"failover 的触发口径 = pi 的重试预算被用尽（fail-fast 类错误不触发，见方案 B 分界）" | 机制：终局观察 + 链内计数 ≥ maxRetries 才 burnt；账户类 pi 不重试 → 计数保持 0 → 不 burnt | T2,T3,T5,T8 |
| G3 | 零新配置项，规则固定 | "无新配置项，规则固定" | 机制：routes schema 键集不变；预算读 pi 既有 settings.retry | T1,T2,D1 |
| G4 | 预算用尽那轮呈现真实上游错误全文（消除掩盖性二手错误） | "用户看到的二手错误替换了真实的 524（连 ray_id、上游域名都没有）"；"重试死在 attempt 1/3，剩余预算作废" | 机制：删 retryOnly 硬闸与中文文案；透传后终局错误即端点错误全文 | T1,T7 |
| G5 | burnt 跨轮次偏好：router state 持久化 / 全 burnt 轮换重探 / 成功康复清除 / 单端点 ≡ 直连 | "恢复者不被饿死；单端点时退化为原样重探"；"清 F 的 burnt + 计数（端点康复，重新成为首选）"；"烧掉预算的那一轮呈现真实上游错误全文（修复的核心收益），下一轮起走候选端点" | 机制：burnt 走 router state；rotateOldestBurnt；成功结局（stop/toolUse/length）清 mark | T2,T4,T6 |
| G6 | 链中配置变更与路由自身失败不丢 burn（幂等重导） | "连续多轮路由失败后仍可凭更早的物理结局幂等重导（burn 不因选择层抛错而丢，不需闭包镜像）" | 机制：findLastPhysicalOutcome 跳过虚拟模型消息，观察从会话事实重算 | T6 |

## 验收是什么

本次验收重点 = **真实宿主行为**（非单测顶替）：全部 case 驱动本机 pi 二进制（--mode rpc）装载
真实扩展源码，端点 = 本机 HTTP 故障注入服务器（524 / insufficient_quota / 恢复 剧本），断言
pi 的重试事件族、上游请求序列、会话落盘与 router state。验收判据 = `docs/tree-plant/acceptance.md`
的实机 case 全绿。

## 树形拆分

主干文件清单：
- extensions/universal/provider-aggregation/src/router.ts
- extensions/universal/provider-aggregation/src/index.ts
- extensions/universal/provider-aggregation/src/__tests__/
- docs/tree-plant/probes/

| 枝名 | 目标 | 依赖 | 风险级 | 文件 | case |
|---|---|---|---|---|---|
| failover-edges | failover 边界行为实机覆盖：fail-fast 不换端点 / 全 burnt 轮换+康复清除 / 预算实读 / 幂等重导 / 重试停用即时 failover / 修剪修复三案（切换不误烧、稳态不重复落盘、链中改指向计数不漏记） | trunk | 高 | docs/tree-plant/probes/t3-failfast.mjs, docs/tree-plant/probes/t4-rotation-clear.mjs, docs/tree-plant/probes/t5-budget-from-settings.mjs, docs/tree-plant/probes/t6-rederive.mjs, docs/tree-plant/probes/t8-retry-disabled-failover.mjs, docs/tree-plant/probes/t9-model-switch-no-misburn.mjs, docs/tree-plant/probes/t10-steady-state-no-duplicate-state.mjs, docs/tree-plant/probes/t11-midchain-repoint-accounting.mjs, docs/tree-plant/probes/lib/harness.mjs | T3,T4,T5,T6,T8,T9,T10,T11 |
| docs-sync | 行为契约文档与技能文档同步（route-matrix.md 总则 5 + 新章 / domain-model.md / SKILL.md）+ changeset + 静态对账 case | trunk | 中 | docs/design/provider-aggregation-route-matrix.md, docs/domain-model.md, extensions/universal/provider-aggregation/skills/provider-aggregation-ext-config/SKILL.md, .changeset/, docs/tree-plant/probes/d1-doc-sync.mjs | D1 |

顺序依据：契约新面（retry 透传/failover 主干路径）与高风险枝（failover 边界）先行；文档同步枝
不动运行时行为，置后。异常、兜底、边界类目标（坏 state 防御、幂等重导、中止不清 mark）归长叶
单测层，不单独立枝。

## 非功能设计

| 项 | 类别 | 不做会怎样 | 预计多久出问题 |
|---|---|---|---|
| 持久化 router state 防御解析（parseFailoverState：坏形状 → 空集、保序、不抛） | 可靠性 | session jsonl 可被手工编辑 / 跨版本 fork，坏形状 state 直达求值会抛异常炸掉整条路由（会话卡死） | 事件驱动：手改 / fork 即发（无固定时长） |
| burn 决策幂等重导（跳过虚拟模型消息向前找物理结局） | 可靠性 | 连续多轮路由失败（无候选 throw）后 burn 丢失 → 故障端点恢复首选，用户再打一次故障端点 | 事件驱动：单端点路由无候选连续失败即发 |
| 链内失败计数退役（计数生命周期 = 活跃重试链） | 可靠性 | 旧计数被观察跳过（模型切走切回/端点移出配置）后孤立 → 后续账户类 fail-fast 误判「预算用尽」→ 误 burn + 向候选漂移（账户错误被掩盖——修剪实证 P1，T9 锁定） | 事件驱动：切模型/改配置后遇账户类错误即发 |
| 真实错误呈现（不造二手错误） | 业务安全 | 二手中文错误替换真实 524：用户无法排障、retry 链被杀死（已实证：session 01a202a5，route-3 持续 25h 失败） | 已实证发生（本次修复根因） |
| 零时间机制合规（无定时器 / 无墙钟 / 无轮询 / 无退避自旋） | 业务安全（ADR-0190 合规） | 违反时间阈值判死禁令，pre-commit / CI 机器检查拦截 | 即时（引入即被拦） |
| 降级统一出口（路由失败全部走闭包 throw 结构化错误，AX5 既有形态） | 可靠性 | 多入口各自 try/catch → 降级方向与日志形态漂移；本修订不新增错误入口（删一个） | 三个月（新增失败路径时） |
| router state 存储格式演进（`{burnt: string[]}`，v1 首版） | 可靠性 | 无声明则未来加字段时旧 session 解析行为未定义（抛异常或静默丢偏好） | 三个月内（首次扩展 state 字段时）——处置：不迁移；旧形状缺字段 → 空集（软避让退回配置序，单轮代价），坏形状同契约（见 api.md 存储节） |

### 显式不做

| 项 | 理由 | 题面提及 | 重审触发 |
|---|---|---|---|
| 修复 opendesign 上游端点本身的故障（route-3 当前仍故障态） | 本交付只改重试 / failover 语义与错误呈现，上游 524 是端点事实不是路由 bug | 否 | 上游恢复或更换端点供应商时 |
| retry-rules 基线 generic-5xx 补 524 | 透传后终端错误是真实 524，pi 原生词表已含 524、重试不受影响；该条只影响 taiji 设置页分类展示与收尾失败分类（题面遗留事项 1，注明"独立小改"） | 否 | taiji 分类展示与 pi 原生词表分化误判时 / 设置页失败分类投诉 |
| direct 求值（压缩摘要）的 burnt 感知 | pi 契约 direct 不传 state（virtual-models.d.ts:53-54,65-67）——burnt 不从 state 生效；实装观察仍从 messages 重导（压缩摘要避开刚烧端点，方向优于原登记成本，2026-11-24 修剪 P5 核实后按实景登记）；闭包计数被 direct 观察改写（退役/清）与主链同语义 | 否 | pi 为 direct 求值透传 router state（virtual-models.d.ts:54 改约）时重裁——届时 burnt 从 state 生效、重导退为兜底 |
| 链内失败计数跨进程重启保持 | 计数是闭包内存（生命周期 = 活跃重试链）；resume 后旧终局错误按 fail-fast 重导一次、再烧一轮预算才 burnt | 否 | resume 后 failover 延迟一轮形成用户可感知投诉时 |
| TUI / 设置页侧新增交互（burnt 可视化等） | 题面要求规则固定、无新配置项——不引入任何 UI 面 | 否（题面"无新配置项"反向约束） | 用户要求可视化 burnt 状态时 |
| extensions lint 的 stale-ctx 普查缺口登记 | 存量问题（provider-aggregation 未登记进 stale-ctx-audit.md §3），非本次引入；阻断 `pnpm extensions:lint`，本次用包级 eslint 绕过验证 | 否（题面遗留事项 3） | 下次跑全量 extensions:lint 前 |
