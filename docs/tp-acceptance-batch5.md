# 验收 case 清单 · 批5「干净重测 + GPU 据实决策」

> 验收唯一仲裁 = 本清单实机 case 全绿。真机形态 = dev Electron 壳 + **production 模式 renderer bundle**（`vite build --minify false` + `vite preview` 静态伺服）+ faux LLM（200TPS）+ CDP/WS 探针；禁单测 runner 冒充实机。
> 探针前置（探针不负责起实例）：dev 实例按 `docs/tp-api-batch5.md` §实例启动 的命令行启动（前台、无 `TAIJI_DEV_BACKGROUND`、faux 脚本已 seed），session 由 CPU 探针自建、GPU 探针按 `--sid` 接入。
> 预期列 `;` 分隔：`exit:N` / `contains:子串` / `not-contains:子串`。阈值类判断（前后差异量级、GPU 占比）进对比表分析，不进 gate 断言——gate 断言「测量有效 + 结果在场」。

## case 总表

| 编号 | 场景 | 命令 | 预期 | 关联 |
|---|---|---|---|---|
| M1 | 干净 CPU 采集（HEAD 代码）：单次运行内 renderer+runtime+pi 三进程 profile + Performance metrics + 环境声明（load / 端口归属 / 打包版瞬时 CPU） | node probes/perf-clean-cpu.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --fixture probes/fixtures/original-45k.json --tag final --save-dir docs/perf/final-measurement | exit:0;contains:RESULT clean-cpu tag=final;contains:profiles=3;contains:renderer-nonidle=;not-contains:测量无效 | trunk |
| M2 | 干净 GPU trace（HEAD 代码）：recordContinuously + dataLoss 监听 + 事件驱动窗长（覆盖 fence 闭合与 complete）+ 中期截图 | node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --sid <sid> --arm full --window-ms 110000 --save docs/perf/final-measurement/final-gpu.trace.json --shot docs/perf/final-measurement/final-midstream.png | exit:0;contains:RESULT gpu-trace arm=full;contains:wall-span=;contains:dataLoss=0;not-contains:采集无效 | trunk |
| M3 | 干净 CPU 采集（原始代码 `eff28e4a5`）：同 harness 同 fixture，探针内建 HEAD 断言 | node probes/perf-clean-cpu.mjs --data-dir ~/.taiji-dev/verify-b5-baseline --cdp-port 9488 --fixture probes/fixtures/original-45k.json --tag baseline --expect-head eff28e4a5 --save-dir docs/perf/final-measurement | exit:0;contains:RESULT clean-cpu tag=baseline;contains:profiles=3;not-contains:HEAD 不符 | B-clean-baseline |
| M4 | 干净 GPU trace（原始代码 `eff28e4a5`） | node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-baseline --cdp-port 9488 --sid <sid> --arm full --window-ms 110000 --save docs/perf/final-measurement/baseline-gpu.trace.json --shot docs/perf/final-measurement/baseline-midstream.png | exit:0;contains:RESULT gpu-trace arm=full;contains:dataLoss=0 | B-clean-baseline |
| G1 | GPU 三臂之 full（HEAD，EdgeFade 全效果） | node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --sid <sid> --arm full --window-ms 110000 --save docs/perf/final-measurement/gpu-arm-full.trace.json | exit:0;contains:arm=full;contains:dataLoss=0 | B-gpu-decision |
| G2 | GPU 三臂之 no-blur（注入 CSS 摘除四层 backdrop-blur，mask 与沉色层保留） | node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --sid <sid> --arm no-blur --window-ms 110000 --save docs/perf/final-measurement/gpu-arm-noblur.trace.json | exit:0;contains:arm=no-blur;contains:dataLoss=0;contains:injected=backdrop-filter | B-gpu-decision |
| G3 | GPU 三臂之 reduced（CDP 模拟 prefers-reduced-transparency:reduce，走组件内建降级：遮罩隐藏 + 容器 mask 摘除） | node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --sid <sid> --arm reduced --window-ms 110000 --save docs/perf/final-measurement/gpu-arm-reduced.trace.json | exit:0;contains:arm=reduced;contains:dataLoss=0;contains:emulated-media=prefers-reduced-transparency | B-gpu-decision |
| F1 | fixture 形态 1：多小代码块（24 fence，41K 字符） | node probes/perf-clean-cpu.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --fixture probes/fixtures/multi-small-fences.json --tag form-fences --window-ms 90000 | exit:0;contains:RESULT clean-cpu tag=form-fences;contains:profiles=3 | B-fixture-forms |
| F2 | fixture 形态 2：工具调用（7 次 bash + 5 轮文本，41K 字符） | node probes/perf-clean-cpu.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --fixture probes/fixtures/tool-calls.json --tag form-tools --window-ms 120000 | exit:0;contains:RESULT clean-cpu tag=form-tools;contains:profiles=3;contains:turn-count= | B-fixture-forms |
| F3 | fixture 形态 3：重 thinking（24K 思考 + 22K 正文，模型 faux/faux-1-reasoning） | node probes/perf-clean-cpu.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --fixture probes/fixtures/heavy-thinking.json --tag form-thinking --model faux/faux-1-reasoning --window-ms 90000 | exit:0;contains:RESULT clean-cpu tag=form-thinking;contains:profiles=3;contains:thinking-chars= | B-fixture-forms |
| P1 | pi 置换位三核对恢复（md5 + 形态 + 无残留 .b5-bak） | node probes/perf-clean-cpu.mjs --verify-pi-only | exit:0;contains:RESULT pi-restore ok=true;contains:md5-match=true;not-contains:ok=false | trunk |

> **case 拆分为何不链式**：单命令超 gate 单 case 900s 超时（spawnSync 杀 sh 后 node 孙进程孤儿挂住输出管道）——M/G/F 各自独立成 case，实例与 session 由前置命令准备。
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
