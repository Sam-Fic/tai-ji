# 验收 case 清单 · 批4「TTFT（首 token 延迟）」

> 验收唯一仲裁 = 本清单实机 case 全绿。真机形态 = dev 实例（`TAIJI_DEV_BACKGROUND=1`，faux 200TPS 脚本，数据目录 `~/.taiji-dev/verify-prof-20261123-1730`）+ CDP/WS 探针；禁单测 runner 冒充实机。探针前置（探针不负责起实例）：dev 实例已按 verify-taiji 技能启动（faux 脚本已 seed），session 由探针自建。
> 预期列 `;` 分隔：`exit:N` / `contains:子串` / `not-contains:子串`。关联列 = `trunk` 或枝名（与设计文档树形拆分一致）。阈值类判断（walk vs warm 差异量级）进对比表分析，不进 gate 断言——gate 断言「测量有效 + 结果在场」。

## case 总表

| 编号 | 场景 | 命令 | 预期 | 关联 |
|---|---|---|---|---|
| T1 | TTFT walk 模式（trunk 机制 case）：pi 热会话 + prompt 同时刻并发 file.tree + file.search（复刻 GUI 挂载时的两个全树 ignore 匹配请求）——证伪/证实「walk 阻塞首 token」 | node scripts/perf-probes/perf-ttft.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --mode walk --runs 2 | exit:0;contains:RESULT mode=walk;contains:gitignore-compiles=2 | trunk |
| T5 | TTFT warm 模式（转发地板）：pi 热、无文件请求 | node scripts/perf-probes/perf-ttft.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --mode warm --runs 2 | exit:0;contains:RESULT mode=warm;contains:gitignore-compiles= | B-prompt-path |
| T6 | TTFT fresh 模式（真实用户流）：新建 session → GUI 切换（挂载触发 file.tree/file.search）→ 立即 prompt（含 pi 冷启动段） | node scripts/perf-probes/perf-ttft.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --mode fresh --runs 1 | exit:0;contains:RESULT mode=fresh | B-cold-start |
| T2 | 全树 walk 匹配成本对比（worktree cwd，真实 .gitignore 82 规则）+ 两算法等价前置门 | npx tsx scripts/perf-probes/perf-ignore-match.mjs | exit:0;contains:equivalence OK;contains:RESULT old-ms=;not-contains:基准无效 | B-prompt-path |
| T3 | pi 冷启动 dev vs packaged bundle 对照（根因定位证据） | node scripts/perf-probes/perf-pi-coldstart.mjs --runs 3 | exit:0;contains:RESULT dev-cold-ms=;contains:ratio-cold= | B-cold-start |
| T4 | 真机文件树 ignored 标记不回归（快路径语义等价性的宿主侧确认）+ 编译行数对账 | node scripts/perf-probes/tree-flags-probe.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 | exit:0;contains:tree-flags-ok=true;contains:mismatches=0 | B-prompt-path |

> 等价性 oracle 与覆盖度自检（合成语料 × 真实 .gitignore 全交叉 + 76/82 覆盖度）属单测层，由 testCommand（`packages/runtime` vitest，B4 套件 4 例）承载，不进实机 case 表——实机侧等价性由 T4（宿主 ignored 标记对账）+ T2 探针前置门（两算法 6961 路径零分歧）双确认。
>
> T1 的 walk 模式断言 gitignore-compiles=2：探针在 prompt 前发 file.tree + file.search 两请求触发的两次编译（GUI 不介入探针自建 session 的挂载；该对账数字进对比表分析，gate 只验 RESULT 在场与退出码）。三模式各自独立成 case（T1 walk = trunk 机制 case；T5 warm = 地板；T6 fresh = 真实用户流）——链式单命令超 gate 单 case 900s 超时（spawnSync 杀 sh 后 node 孙进程孤儿挂住输出管道），故拆分。

## 不可机验项登记

| 项 | 理由 | 承载 |
|---|---|---|
| 三包 test+typecheck 全绿（含 runtime） | 非真机探针可判定项 | trunk/leaf gate 的 testCommand + typecheckCommand |
| 冷启动「不可优化」结论的 DX 理由链 | 属设计裁决（extension-resolver [HISTORICAL] 决策记录），非运行时可测行为 | 设计文档「冷启动结论」节 + 对比表登记 |
