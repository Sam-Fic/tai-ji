# 实机验收 case

每条 case 必须在真实宿主/真实进程上执行；命令不得是单测 runner 或 mock 形态（root gate 拒绝）。
预期判据用分号分隔：`exit:0`（缺省）、`contains:子串`、`not-contains:子串`。
关联列 = `trunk` 或枝名（与设计文档树形拆分一致）。

| 编号 | 场景 | 命令 | 预期 | 关联 |
|---|---|---|---|---|
| T1 | 流式窗派生族成本归零（真机：dev 实例 + faux 72KB 长流式 + CDP 无 tracing 采集） | SID=$(node scripts/perf-probes/vp/vp.mjs session.create --data-dir ~/.taiji-dev/verify-prof-20261123-1730) && SID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['observations']['sessionId'])" "$SID") && node scripts/perf-probes/vp/vp.mjs session.switch --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --sid "$SID" >/dev/null && sleep 3 && node scripts/perf-probes/perf-derivatives.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --sid "$SID" --threshold-s 0.3 | exit:0;contains:RESULT deriv-family-self-time=;contains:measurement valid:;contains:PASS | trunk |
| T2 | rail 终态视觉不变（改造前后同 fixture 截图 + rail 节点文本对拍） | SID=$(node scripts/perf-probes/vp/vp.mjs session.create --data-dir ~/.taiji-dev/verify-prof-20261123-1730) && SID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['observations']['sessionId'])" "$SID") && node scripts/perf-probes/vp/vp.mjs session.switch --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --sid "$SID" >/dev/null && sleep 3 && node scripts/perf-probes/vp/vp.mjs chat.send --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --sid "$SID" --text 请给出性能优化实施方案 >/dev/null && node scripts/perf-probes/vp/vp.mjs chat.wait --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --sid "$SID" --timeout 120 >/dev/null && node scripts/perf-probes/rail-visual-diff.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --sid "$SID" | exit:0;contains:rail nodes extracted:;contains:rail-identical:true;not-contains:```ts | trunk |
| B1 | rail 冻结状态机单测（同 id 增长/换 id/流结束重算/未闭合 fence 不冻结） | pnpm --filter @taiji/ui test -- rail-freeze | exit:0 | B1 |
| B2 | preview 懒计算单测（broken 路径求值等于旧即时值 + 正常路径零调用） | pnpm --filter @taiji/frontend test -- preview-lazy | exit:0 | B2 |
| B3 | truncate/fence 剥离单测（边界 + 闭/不闭/嵌套对拍） | pnpm --filter @taiji/core test -- summarize-rail | exit:0 | B3 |
| B4 | B-harden：纯空白首块不成为冻结锚点 + 冻结槽切 session reset（ui rail-freeze） | pnpm --filter @taiji/ui test -- rail-freeze | exit:0 | B-harden |
| B5 | B-harden：preview thunk 抛错降级（renderer preview-lazy） | pnpm --filter @taiji/frontend test -- preview-lazy | exit:0 | B-harden |
| B6 | B-harden：summarizeAssistantForRailWithSource 来源对齐语义（core summarize-rail） | pnpm --filter @taiji/core test -- summarize-rail | exit:0 | B-harden |
| T3 | 类型与存量回归（三包） | pnpm --filter @taiji/core typecheck && pnpm --filter @taiji/ui typecheck && pnpm --filter @taiji/frontend typecheck | exit:0 | trunk |
| G1 | GPU trace 采集 + union 分析（真机：dev 实例 + faux 200TPS 流式 + CDP Tracing devtools.timeline,gpu,cc ~34s 窗，与基线 run2d 同 harness；含窗口中点 FPS overlay 截图） | SID=$(node scripts/perf-probes/vp/vp.mjs session.create --data-dir ~/.taiji-dev/verify-prof-20261123-1730) && SID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['observations']['sessionId'])" "$SID") && node scripts/perf-probes/vp/vp.mjs session.switch --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --sid "$SID" >/dev/null && sleep 3 && node scripts/perf-probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --sid "$SID" --save .run/after-gpu.trace.json --shot .run/after-fps.png >/dev/null && node scripts/perf-probes/analyze-gpu-union.mjs .run/after-gpu.trace.json GPU-TRACE | exit:0;contains:GPU-TRACE;contains:wall-span=;contains:events= | B-gpu |

接口核实表（fact-check.md）的每一行至少被一条 case 覆盖：railMemoFor→T1/B1/B4；summarize*→T2/B1/B3/B6；truncate→B3；stripMarkdown→B1/B3；previewText/turnPreview→B2；StreamViewItem preview→T1/B2/B5；canReuseView→T1/B2；StreamItemBoundary→B2/B5；runtime WS 协议→T1；CDP Profiler→T1。

命令形态要求：T1/T2 驱动真实宿主二进制（dev 实例 + faux LLM provider，零 token）；探针脚本随交付物入库（scripts/perf-probes/）。探针前置：按 verify-taiji 技能起实例并建 session（sid 入参）；启动前确认无其他 Electron 高负载实例并存（承审查 M8）。
