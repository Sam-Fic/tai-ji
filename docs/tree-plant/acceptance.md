# 实机验收 case

每条 case 在真实宿主上执行：本机 pi 二进制（`--mode rpc`，版本 1.0.0）经 jiti 装载真实扩展源码
`extensions/universal/provider-aggregation/src/index.ts`；端点 = 探针自建的本机 HTTP 故障注入
服务器（openai-completions 协议，剧本 = 524 / insufficient_quota / 恢复）。断言源 = pi 的 RPC
事件流（auto_retry 事件族）、上游请求序列、会话 jsonl 落盘（含 pi.virtual-model-state 条目）。
探针共享基座 = `docs/tree-plant/probes/lib/harness.mjs`（随交付物入库）。单测归长叶阶段
（testCommand），不进本表。

| 编号 | 场景 | 命令 | 预期 | 关联 |
|---|---|---|---|---|
| T1 | retry 透传 + 真实错误呈现：单端点路由持续 524，重试全打同一端点，终局错误是上游 524 全文（非「上一端点失败且无其他可用端点」） | node docs/tree-plant/probes/t1-retry-passthrough.mjs | exit:0;contains:✓ T1 | trunk |
| T2 | failover 端到端 + state 持久化：双端点路由 fault-a 用尽预算后，下一轮 burnt 并切 fault-b，会话落 virtual-model-state | node docs/tree-plant/probes/t2-failover.mjs | exit:0;contains:✓ T2 | trunk |
| T7 | 透传不复查条件：额度条件链中翻到不满足，重试仍打原端点（旧实现此形态下第 2 次求值即抛路由错误） | node docs/tree-plant/probes/t7-passthrough-ignores-conditions.mjs | exit:0;contains:✓ T7 | trunk |
| T3 | fail-fast 不换端点：429 insufficient_quota（pi 不重试）→ 两轮都选主端点，候选零请求 | node docs/tree-plant/probes/t3-failfast.mjs | exit:0;contains:✓ T3 | failover-edges |
| T4 | 全 burnt 轮换重探 + 成功康复清 burn：单端点烧掉预算后仍原样重试，恢复即清 mark | node docs/tree-plant/probes/t4-rotation-clear.mjs | exit:0;contains:✓ T4 | failover-edges |
| T5 | 预算从 settings 实读：retry.maxRetries=1 → 只重试 1 次即 burnt failover（非硬编码 3） | node docs/tree-plant/probes/t5-budget-from-settings.mjs | exit:0;contains:✓ T5 | failover-edges |
| T6 | 路由自身失败后幂等重导：链中改配置造无候选 → 虚拟 error 入投影 → 恢复配置后跳过虚拟消息重导 burn 并 failover | node docs/tree-plant/probes/t6-rederive.mjs | exit:0;contains:✓ T6 | failover-edges |
| T8 | 重试停用即时 failover：retry.enabled=false → 预算读为 0 → 终局 error 即 burnt 换端点 | node docs/tree-plant/probes/t8-retry-disabled-failover.mjs | exit:0;contains:✓ T8 | failover-edges |
| T9 | 修剪 P1：模型切换 away-and-back 后账户类 fail-fast 不误烧（链内计数退役，零 state 条目） | node docs/tree-plant/probes/t9-model-switch-no-misburn.mjs | exit:0;contains:✓ T9 | failover-edges |
| T10 | 修剪 P3：单端点 burnt 稳态不重复落 state（轮换引用纪律，4 轮 1 条） | node docs/tree-plant/probes/t10-steady-state-no-duplicate-state.mjs | exit:0;contains:✓ T10 | failover-edges |
| T11 | 修剪 P2：链中端点被改指向——divert 的重试也计数，第二轮即 burnt failover | node docs/tree-plant/probes/t11-midchain-repoint-accounting.mjs | exit:0;contains:✓ T11 | failover-edges |
| D1 | 文档同步静态对账：route-matrix.md 新章 / domain-model.md / SKILL.md 旧措辞清零 + routes schema 零新键 | node docs/tree-plant/probes/d1-doc-sync.mjs | exit:0;contains:✓ D1 | docs-sync |

<!-- 命令形态：驱动真实宿主二进制（pi）与真实子进程；探针脚本随交付物入库。
     接口核实表（fact-check.md）每一行至少被一条 case 覆盖。 -->
