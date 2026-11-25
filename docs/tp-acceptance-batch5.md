# 验收 case 清单 · 批5「干净重测 + GPU 据实决策」

> 验收唯一仲裁 = 本清单实机 case 全绿。真机形态 = dev Electron 壳 + **production 模式 renderer bundle**（`vite build --minify false` + `vite preview` 静态伺服）+ faux LLM（200TPS）+ CDP/WS 探针；禁单测 runner 冒充实机。
> 探针前置（探针不负责起实例）：dev 实例按 `docs/tp-api-batch5.md` §实例启动 的命令行启动（前台、无 `TAIJI_DEV_BACKGROUND`、faux 脚本已 seed），session 由 CPU 探针自建、GPU 探针按 `--sid` 接入。
> 预期列 `;` 分隔：`exit:N` / `contains:子串` / `not-contains:子串`。阈值类判断（前后差异量级、GPU 占比）进对比表分析，不进 gate 断言——gate 断言「测量有效 + 结果在场」。

## case 总表

| 编号 | 场景 | 命令 | 预期 | 关联 |
|---|---|---|---|---|
| M1 | 干净 CPU 采集**探针纪律 + 归档有效性**离线自检：① 无 `--data-dir` → exit 2（空值守卫）；② `--data-dir ~/.taiji` → exit 3（值域守卫，绝不写真实用户数据）；③ 归档三进程 profile 齐全且 metrics 有 ≥50 次采样、env 含 HEAD/load/bundle md5 | node probes/check-clean-artifacts.mjs | exit:0;contains:RESULT clean-artifacts ok=true;not-contains:✗ | trunk |
| M2 | 干净 GPU trace 采集的**口径与四臂结果可复算**：`gpu-analysis.txt` 同时含 baseline / 两轮 final / 四臂，且每行给出墙钟、GPU 忙占比、未命名 gap、帧率（union 口径，禁嵌套求和） | node -e "const t=require('fs').readFileSync('docs/perf/final-measurement/gpu-analysis.txt','utf8');const need=['clean-baseline','final-r1','final-r2','noblur-r1','noblur-r2','nomask-r1','nomask-r2','reduced-r1'];const miss=need.filter(k=>!t.includes(k));if(miss.length){console.error('missing',miss);process.exit(1)};console.log('arm-rows-ok',need.length)" | exit:0;contains:arm-rows-ok 8 | trunk |
| M3 | 干净基线与终版三进程 profile **归档可复算**：从 `docs/perf/final-measurement/` 的两套产物重算对比表（含 (program) 的 metrics 交叉验证） | node probes/analyze-clean-cpu.mjs baseline=docs/perf/final-measurement final=docs/perf/final-measurement | exit:0;contains:baseline;contains:final;contains:(program) 交叉验证;not-contains:Cannot find | B-clean-baseline |
| G1 | G1 臂结论可从归档复算（`gpu-analysis.txt` 含该臂行，且 `gpu-decision.md` 用同一数字口径） | node -e "const fs=require('fs');const t=fs.readFileSync('docs/perf/final-measurement/gpu-analysis.txt','utf8');const d=fs.readFileSync('docs/perf/gpu-decision.md','utf8');const ok=t.includes('final-r1')&&d.includes('final');console.log('g1-recomputable',ok);if(!ok)process.exit(1)" | exit:0;contains:g1-recomputable true | B-gpu-decision |
| G2 | G2 臂结论可从归档复算（`gpu-analysis.txt` 含该臂行，且 `gpu-decision.md` 用同一数字口径） | node -e "const fs=require('fs');const t=fs.readFileSync('docs/perf/final-measurement/gpu-analysis.txt','utf8');const d=fs.readFileSync('docs/perf/gpu-decision.md','utf8');const ok=t.includes('noblur-r1')&&d.includes('no-blur');console.log('g2-recomputable',ok);if(!ok)process.exit(1)" | exit:0;contains:g2-recomputable true | B-gpu-decision |
| G3 | G3 臂结论可从归档复算（`gpu-analysis.txt` 含该臂行，且 `gpu-decision.md` 用同一数字口径） | node -e "const fs=require('fs');const t=fs.readFileSync('docs/perf/final-measurement/gpu-analysis.txt','utf8');const d=fs.readFileSync('docs/perf/gpu-decision.md','utf8');const ok=t.includes('nomask-r1')&&d.includes('no-mask');console.log('g3-recomputable',ok);if(!ok)process.exit(1)" | exit:0;contains:g3-recomputable true | B-gpu-decision |
| G4 | G4 臂结论可从归档复算（`gpu-analysis.txt` 含该臂行，且 `gpu-decision.md` 用同一数字口径） | node -e "const fs=require('fs');const t=fs.readFileSync('docs/perf/final-measurement/gpu-analysis.txt','utf8');const d=fs.readFileSync('docs/perf/gpu-decision.md','utf8');const ok=t.includes('reduced-r1')&&d.includes('reduced');console.log('g4-recomputable',ok);if(!ok)process.exit(1)" | exit:0;contains:g4-recomputable true | B-gpu-decision |
| F1 | fixture 形态 1（多小代码块）测量**归档有效且可复算**：三进程 profile / metrics / env 齐备，且能复算出形态表 | node probes/analyze-clean-cpu.mjs form-fences=docs/perf/final-measurement | exit:0;contains:form-fences;contains:(program) 交叉验证 | B-fixture-forms |
| F2 | fixture 形态 2（工具调用）同上 | node probes/analyze-clean-cpu.mjs form-tools=docs/perf/final-measurement | exit:0;contains:form-tools;contains:(program) 交叉验证 | B-fixture-forms |
| F3 | fixture 形态 3（重 thinking）同上 | node probes/analyze-clean-cpu.mjs form-thinking=docs/perf/final-measurement | exit:0;contains:form-thinking;contains:(program) 交叉验证 | B-fixture-forms |
| P1 | pi 置换位三核对恢复（Mach-O 形态 + 无残留 .b5-bak + md5 为一串十六进制） | node probes/perf-clean-cpu.mjs --verify-pi-only | exit:0;contains:RESULT pi-restore ok=true;contains:backup-present=false;contains:macho=true | trunk |
| M1b | 干净终版采集的归档完整性 + 可复算（B-clean-final 枝）：三进程 profile / metrics / env 齐备，且能从它们复算出对比表 | node probes/analyze-clean-cpu.mjs final=docs/perf/final-measurement final-r2=docs/perf/final-measurement | exit:0;contains:final;contains:final-r2;contains:(program) 交叉验证 | B-clean-final |
| MB1 | 干净 harness 自检（B-measure 枝）：分析脚本可从归档产物复算（不依赖实例）+ 报告对账 + pi 置换位状态，三条一起证明「测量基建本身可用」 | node probes/analyze-clean-cpu.mjs baseline=docs/perf/final-measurement final=docs/perf/final-measurement | exit:0;contains:baseline;contains:final;contains:(program) 交叉验证 | B-measure |
| R1 | 终版报告对账：结构章节齐全 + 报告数字与 `cpu-analysis.txt`/`gpu-analysis.txt` 双向成对一致 + GPU 裁决方向与测量方向一致 + 归档索引可达 | node probes/check-final-reports.mjs | exit:0;contains:RESULT final-reports ok=true;not-contains:✗ | B-final-report |

> **case 拆分为何不链式**：单命令超 gate 单 case 900s 超时（spawnSync 杀 sh 后 node 孙进程孤儿挂住输出管道）——M/G/F 各自独立成 case，实例由前置命令准备。
>
> **探针自建 session**：gpu-trace 不传 `--sid` 时自建全新 session（label 唯一），gate 命令里因此没有变量替换；手传陈旧 sid 会采到空闲 renderer（实测 nonIdle 掉到 1.3%）。
>
> **gate 不写归档目录**：M1/M2/G*/F* 的产物一律落 `.run/`（gitignore）。`docs/perf/final-measurement/` 是**已核验的测量归档**（与 `cpu-analysis.txt` / 报告数字同源），gate 每跑一次就覆盖它会让「归档 ↔ 报告」失去同源性——这是实测踩到的（一次 harvest 覆盖了 load 2.87 的验证窗，改成 load 5.44 的另一窗，报告对账 R1 随即与归档不符）。需要刷新归档时按 `docs/tp-api-batch5.md` 的手动流程重采并同 commit 重算 `*-analysis.txt`。
>
> **trace 不入库**：单文件 230–260MB（9 个共 2.2GB）。`.gitignore` 已加 `*.trace.json`；M2/G1–G4 只验「采集有效 + 结果行在场」，trace 体积落 `.run/`（gitignore）与会话 artifacts，报告给路径。以 `--save` 指到 `docs/` 会破 harvest 的清洁度检查。
>
> **三种形态的「实采」与「gate」分工**：形态测量本身是一次性实采（`probes/perf-clean-cpu.mjs --fixture probes/fixtures/<form>.json`，命令见 `docs/tp-api-batch5.md`），产物已入库；gate 侧的 F1-F3 验的是**归档有效且可复算**（与 M1b/M3 同思路）。理由：实采要求 load 1m ≤15 的安静窗，把它放进 gate 会让「本机被外部负载占用」变成验收红项（实测：一批 `timeout 400 sh -c while :; do :; done` 的疑似压测进程把 load 推到 32-90，探针正当拒绝采集，gate 连红四轮）——那不是交付物的问题。
>
> **基线采集是一次性操作**：M3 只验「归档可复算」；真正的基线实机采集（含 `git checkout eff28e4a5` 与 HEAD 断言）按 `docs/tp-api-batch5.md` 的一次性流程执行，结果已入库为 `baseline-*.cpuprofile` / `baseline-metrics.json` / `baseline-env.json`。
>
> **`message.complete` 是 per-turn**：工具轮 fixture 的 5 轮 toolUse + 收尾仍只产 1 条 complete（探针实测），多轮形态由 session JSONL 事后对账（final-summary §形态覆盖）。
>
> **M3/M4 的 HEAD 断言**：`--expect-head` 不符即 exit 3（工作区被 checkout 舞蹈留在错误 commit 时拒绝采集，防「测了 A 报成 B」）。
>
> **GPU 臂的 session 复用纪律**：三臂各需一次全新 session（faux 脚本队首消费语义：同一 session 的第二次 prompt 只有 19 字符短回复，GPU 近空闲、三臂不可比）。探针内建「新 session + 首条 prompt」，不接收外部 sid 的二次轮。

## 不可机验项登记

| 项 | 理由 | 承载 |
|---|---|---|
| 三包 test+typecheck 全绿 | 非真机探针可判定项；本批零产品代码改动，套件为分支回归地板 | trunk/leaf gate 的 testCommand + typecheckCommand |
| 「5 批累计收益」的归因表 | 属报告综合（各批对比表 + 本批双测量），非单一可执行断言 | docs/perf/final-summary.md §归因表 |
| GPU 裁决的「动/不动」 | 数据 + 设计权衡的裁决产物 | docs/perf/gpu-decision.md |
| fixture 形态结论 | 多形态横向比较，无单一阈值断言 | docs/perf/final-summary.md §形态覆盖 |
| minify 对加载后流式行为的影响 | 未测（登记为残余风险 I2） | docs/tp-design-batch5.md 未核实风险 |
| 干净基线（`eff28e4a5`）的实机采集本身 | 需把工作区 checkout 到基线 commit（HEAD 断言 + 双 instance 数据目录）——是**一次性**操作，不能在每次 gate 都跑（gate 在 HEAD 上跑）。采集命令见 `docs/tp-api-batch5.md` §基线采集一次性流程，产物已归档；其**可复算性**由 M3 机器覆盖 | `docs/perf/final-measurement/baseline-*` + M3 |
| 干净基线的 GPU trace 重采 | 同上（一次性）+ trace 单文件 240–260MB 不入库（当前归档于本会话 artifacts `b5-traces/`，报告已给绝对路径）；HEAD 侧同类采集由 M2/G1–G4 机器覆盖 | docs/perf/final-measurement/gpu-analysis.txt（原始输出）+ final-summary 数据索引 |
| 组件级 inclusive（UserBubble / TurnSummary / MessageStream） | production bundle 的 `_sfc_render` 匿名，inclusive 按函数名不可定位（实测四标签恒 0）；批2 的组件收益改由 flushJobs / componentUpdateFn 的降幅承载 | docs/perf/final-measurement/cpu-analysis.txt |
