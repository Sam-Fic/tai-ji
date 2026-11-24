# 验收 case 清单 · 批5「干净重测 + GPU 据实决策」

> 验收唯一仲裁 = 本清单实机 case 全绿。真机形态 = dev Electron 壳 + **production 模式 renderer bundle**（`vite build --minify false` + `vite preview` 静态伺服）+ faux LLM（200TPS）+ CDP/WS 探针；禁单测 runner 冒充实机。
> 探针前置（探针不负责起实例）：dev 实例按 `docs/tp-api-batch5.md` §实例启动 的命令行启动（前台、无 `TAIJI_DEV_BACKGROUND`、faux 脚本已 seed），session 由 CPU 探针自建、GPU 探针按 `--sid` 接入。
> 预期列 `;` 分隔：`exit:N` / `contains:子串` / `not-contains:子串`。阈值类判断（前后差异量级、GPU 占比）进对比表分析，不进 gate 断言——gate 断言「测量有效 + 结果在场」。

## case 总表

| 编号 | 场景 | 命令 | 预期 | 关联 |
|---|---|---|---|---|
| M1 | 干净 CPU 采集（HEAD 代码）：单次运行内 renderer+runtime+pi 三进程 profile + Performance metrics + 环境声明（load / 端口归属 / 打包版瞬时 CPU） | node probes/perf-clean-cpu.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --fixture probes/fixtures/original-45k.json --tag final --save-dir docs/perf/final-measurement | exit:0;contains:RESULT clean-cpu tag=final;contains:profiles=3;contains:renderer-nonidle=;not-contains:测量无效 | trunk |
| M2 | 干净 GPU trace（HEAD 代码）：recordContinuously + dataLoss 监听 + 事件驱动窗长（覆盖 fence 闭合与 complete）+ 自建 session | node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --arm full --window-ms 160000 --shot docs/perf/final-measurement/final-midstream.png | exit:0;contains:RESULT gpu-trace arm=full;contains:wall-span=;contains:dataLoss=0;contains:completed=true;not-contains:采集无效 | trunk |
| M3 | 干净基线与终版三进程 profile **归档可复算**：从 `docs/perf/final-measurement/` 的两套产物重算对比表（含 (program) 的 metrics 交叉验证） | node probes/analyze-clean-cpu.mjs baseline=docs/perf/final-measurement final=docs/perf/final-measurement | exit:0;contains:baseline;contains:final;contains:(program) 交叉验证;not-contains:Cannot find | B-clean-baseline |
| G1 | GPU 四臂之 full（HEAD，EdgeFade 全效果）：blur / mask 对照的基准臂 | node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --arm full --window-ms 160000 | exit:0;contains:arm=full;contains:dataLoss=0;contains:completed=true | B-gpu-decision |
| G2 | GPU 四臂之 no-blur（注入 CSS 摘除四层 backdrop-filter，mask 与沉色层保留） | node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --arm no-blur --window-ms 160000 | exit:0;contains:arm=no-blur;contains:dataLoss=0;contains:injected=backdrop-filter | B-gpu-decision |
| G3 | GPU 四臂之 no-mask（注入 CSS 摘除滚动容器 mask-image，blur 与沉色层保留） | node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --arm no-mask --window-ms 160000 | exit:0;contains:arm=no-mask;contains:dataLoss=0;contains:injected=mask-image | B-gpu-decision |
| G4 | GPU 四臂之 reduced（CDP 模拟 prefers-reduced-transparency:reduce，走组件内建降级：遮罩隐藏 + 容器 mask 摘除） | node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --arm reduced --window-ms 160000 | exit:0;contains:arm=reduced;contains:dataLoss=0;contains:prefers-reduced-transparency | B-gpu-decision |
| F1 | fixture 形态 1：多小代码块（24 fence，41K 字符） | node probes/perf-clean-cpu.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --fixture probes/fixtures/multi-small-fences.json --tag form-fences --window-ms 200000 | exit:0;contains:RESULT clean-cpu tag=form-fences;contains:profiles=3;contains:completes=1/1 | B-fixture-forms |
| F2 | fixture 形态 2：工具调用（5 轮 toolUse + 7 次 bash + 收尾，38K 字符） | node probes/perf-clean-cpu.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --fixture probes/fixtures/tool-calls.json --tag form-tools --window-ms 200000 | exit:0;contains:RESULT clean-cpu tag=form-tools;contains:profiles=3;contains:completes=1/1 | B-fixture-forms |
| F3 | fixture 形态 3：重 thinking（24K 思考 + 22K 正文，模型 faux/faux-1-reasoning） | node probes/perf-clean-cpu.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --fixture probes/fixtures/heavy-thinking.json --tag form-thinking --model faux/faux-1-reasoning --window-ms 200000 | exit:0;contains:RESULT clean-cpu tag=form-thinking;contains:profiles=3;contains:completes=1/1 | B-fixture-forms |
| P1 | pi 置换位三核对恢复（Mach-O 形态 + 无残留 .b5-bak + md5 为一串十六进制） | node probes/perf-clean-cpu.mjs --verify-pi-only | exit:0;contains:RESULT pi-restore ok=true;contains:backup-present=false;contains:macho=true | trunk |
| MB1 | 干净 harness 自检（B-measure 枝）：分析脚本可从归档产物复算（不依赖实例）+ 报告对账 + pi 置换位状态，三条一起证明「测量基建本身可用」 | node probes/analyze-clean-cpu.mjs baseline=docs/perf/final-measurement final=docs/perf/final-measurement | exit:0;contains:baseline;contains:final;contains:(program) 交叉验证 | B-measure |
| R1 | 终版报告对账：结构章节齐全 + 报告数字与 `cpu-analysis.txt`/`gpu-analysis.txt` 双向成对一致 + GPU 裁决方向与测量方向一致 + 归档索引可达 | node probes/check-final-reports.mjs | exit:0;contains:RESULT final-reports ok=true;not-contains:✗ | B-final-report |

> **case 拆分为何不链式**：单命令超 gate 单 case 900s 超时（spawnSync 杀 sh 后 node 孙进程孤儿挂住输出管道）——M/G/F 各自独立成 case，实例由前置命令准备。
>
> **探针自建 session**：gpu-trace 不传 `--sid` 时自建全新 session（label 唯一），gate 命令里因此没有变量替换；手传陈旧 sid 会采到空闲 renderer（实测 nonIdle 掉到 1.3%）。
>
> **trace 不入库**：单文件 230–260MB（9 个共 2.2GB）。`.gitignore` 已加 `*.trace.json`；M2/G1–G4 只验「采集有效 + 结果行在场」，trace 体积落 `.run/`（gitignore）与会话 artifacts，报告给路径。以 `--save` 指到 `docs/` 会破 harvest 的清洁度检查。
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
