# 批2「契约层更新跳过 + 强制布局纪律」前后对比（CPU + GPU）

> 采集分支 `feat-cpu-gpu-performance` · 交付 = Turn.vue 稳定引用 props（UserBubble/TurnSummary shouldUpdateComponent 跳过）+ EdgeFade IO 哨兵（消 scrollTop 强制布局读）+ 跟底 endOffset 补偿 padTop（修 gap=29.5px 记账误差）+ 业务侧 RO 回调几何读清理；N1 mask 常量 / N2 aiCopyKey 用 id 为等价顺手。
>
> **口径声明（先读，照批1）**：前后两次采集不是同一次运行，也不共享同一窗口结构。本表所有数字都用**同一套脚本、同一份函数/切片名单**对两侧的原始产物复算得出（脚本随交付物入库：`probes/perf-component-render.mjs`、`probes/perf-forced-layout.mjs`、`probes/analyze-gpu-union.mjs`），但**跨运行的绝对差含采集噪声**（GLM 审查实证同场景跨运行差异 ≥2.7×）。因此结论只承载**量级与方向**，不承载精确百分比；凡涉及"前/后"的差，一律同时给出绝对值和窗口占比两个口径。

## 0. 采集 harness

| 项 | before（基线） | after（本批） |
|---|---|---|
| 宿主 | dev 实例（`TAIJI_DEV_BACKGROUND=1`，后台不可见窗口） | 同左 |
| faux 脚本 | `~/.taiji-dev/verify-prof-20261123-1730/agent/faux-responses.json`（200TPS，首轮响应 45,326 字符 / 11,412 token） | 同左 |
| session | 新 session + 首条 prompt | 同左 |
| renderer CPU | CDP Profiler，无 tracing | 同左（T1/T2/T5 探针 `--save`） |
| GPU trace | CDP `Tracing.start{devtools.timeline,gpu,cc}` ~34s 窗 | 同左（gpu-trace.mjs） |
| 打包版 TaiJi.app | 在跑（审查会话宿主） | 同左 |

基线原始产物（**只读，未重测**）：`~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data/run-notrace-renderer.cpuprofile`（CPU 权威，流式窗 +10..+73s）、`run2d-renderer.trace.json`（GPU）。

**基线数字口径**：下列 before 列由 `probes/lib/harness.mjs` 的 `inclusiveByLabel` / `selfTimeByLabel` 对基线 cpuprofile 在 **+10..+73s 流式窗（63.0s 采样，nonIdle 62.5%）** 离线复算得出（与批1 `analyze-cpuprofile.mjs` 同源窗口）。after 列由同名探针对 after profile 在各自 send-relative 流式窗复算。

## 1. 组件 render inclusive（核心指标：稳定引用 props → shouldUpdateComponent 跳过）

探针 `probes/perf-component-render.mjs`。inclusive = 沿 parent 链上行、每样本对匹配 label 去重、累加 timeDeltas（= 该组件渲染子树总耗时）。

| 组件 | before（+10..73s，63.0s 窗） | after（send-relative 流式窗） | 变化 |
|---|---|---|---|
| UserBubble | 1.362s | `<after>` | 预期 →≈0（流式期 user 引用稳定，props 全稳定 → 整组件更新跳过） |
| TurnSummary | 1.166s | `<after>` | 预期 →≈0（lastAssistant.id + isStreaming 稳定 → 跳过） |
| Turn | 0.885s | `<after>` | 编排器仍每 delta 重渲（turn 引用变），承载派生；不承诺归零 |
| MarkdownRenderer | 0.522s | `<after>` | 已有 rAF 合帧，非本批目标 |
| MessageStream | 7.185s | `<after>` | 含 O(n²) 派生（批1 已归零）+ patch；不承诺归零 |
| **UserBubble + TurnSummary（断言族）** | **2.528s（占窗 4.0%）** | `<after>` | 预期 ratio < 0.5（shouldUpdateComponent 整体跳过） |

## 2. 强制布局 self-time（核心指标：EdgeFade IO 哨兵 + 跟底 gap 修复）

探针 `probes/perf-forced-layout.mjs`。self-time ≈ 次数 × 单次成本；成本恒定下 self-time 下降 ∝ 强制布局次数下降。

| 函数 | before（+10..73s） | after | 变化 |
|---|---|---|---|
| EdgeFade.vue 任意帧 self | 0.546s | `<after>` | 预期 →≈0（scroll 回调不再读 scrollTop，IO 哨兵零几何读） |
| scrollTo self | 2.044s | `<after>` | 预期下降（gap 修复减少滚动 churn；原生滚动单次成本仍在） |
| **EdgeFade + scrollTo（断言族）** | **2.590s（占窗 4.1%）** | `<after>` | 预期 ratio < 0.8 |

## 3. renderer 主线程 TOP10（self-time）

同一份 profile 各自流式窗，`analyze-cpuprofile.mjs` 同口径。before 列照批1（基线权威数据集）：

| 排名 | before（+10..73s） | after |
|---|---|---|
| 1 | (idle) 23.608s | `<after>` |
| 2 | (program) 9.987s | `<after>` |
| 3 | scrollTo 2.044s | `<after>` |
| 4 | findNextMatchSync 1.257s | `<after>` |
| 5 | truncate 1.069s（批1 已归零） | `<after>` |
| … | 见 batch1-comparison.md §2 | `<after>` |

> 注：truncate/stripMarkdown/previewText 三项批1 已归零（rail 冻结 + preview 懒计算 + truncate early-exit），before 列为**批1 前**基线值；本批 after 复算应仍为归零态（不回退）。

## 4. GPU union 口径前后对比

口径：按线程时间轴 union（嵌套子切片不重复计数）。复算脚本 `probes/analyze-gpu-union.mjs`。before 列照批1（run2d trace，33.67s 墙钟，流式子窗 23.0s）：

| 指标 | before | after |
|---|---|---|
| CrGpuMain union | 22.88s（67.9% 全窗 / 99.4% 流式子窗） | `<after>` |
| Raster union | 6.01s（流式子窗 26.0%） | `<after>` |
| ApplyBackpressure union | 11.35s（流式子窗 49.3%） | `<after>` |
| 帧率 | ~122fps（显示链接频率） | `<after>` |

> 本批 GPU 收益不确定（GLM 审查 A6：trace 未采到大 DOM 阶段；GPU 未饱和，真实工作 ~32%）。组件跳过 + 强制布局削减减少产帧，理论上 ApplyBackpressure/raster 有下行空间，但**不承诺 GPU 收益**（拿干净 GPU 数据属批5）。

## 5. FPS / 显存 overlay 截图

| | 截图 |
|---|---|
| before | `~/.taiji/ext-sessions/01a2077f-.../artifacts/profiling-data/run-notrace-midstream.png` |
| after | `.run/after-midstream.png`（gpu-trace.mjs `--shot`） |

> 后台不可见窗口，Chromium 降帧，FPS 读数口径可疑（GLM A7）；截图仅作「GUI 确在流式」的在场证据，不作帧率证据。

## 6. 贴底收敛 + RO 循环（正确性指标）

探针 `probes/follow-health.mjs`（流式期 renderer 日志 delta）：

| 指标 | before（基线日志） | after（探针 delta） |
|---|---|---|
| pin-bottom-guard gap 警告 | 每次运行 32 条（gap=29.5/30px，非流式态持续） | `<after>`（预期 gap_warnings=0） |
| ResizeObserver loop 错误 | ~164 条/run（virtua 内部测量-写 spacer 反馈环，业务侧射程内已做尽） | `<after>`（预期不恶化；**不承诺归零**） |

gap 根因 = `--message-stream-pad-top`(30px) 流内 spacer 未被 virtua container-driver 目标公式计入（commit `4eb083942` 引入），修法 = `endOffset = tailHeight + headOffset`（headOffset = padTop spacer 实测高），浏览器 clamp 自收敛到 gap=0。

## 7. 可比性声明与残余风险

| # | 事项 | 影响 | 处置 |
|---|---|---|---|
| C1 | before/after 两次不同运行 | 绝对差含运行间噪声（≥2.7×） | 同一脚本/名单复算；只取量级与方向 |
| C2 | 窗内组成不同（before 含 pi 冷启动段） | 全窗口径低估 after 收益 | 同时给流式子窗口径 |
| C3 | 两侧后台不可见窗口降帧 | FPS 绝对值不可信 | 不作 FPS 结论 |
| C4 | 采集期间打包版 TaiJi.app + 外部测试运行并存 | GPU 等待类 / suite 计时受竞争影响 | 如实标注；suite 择安静窗口跑 |
| C5 | turn.user 稳定性限于流式 delta 路径 | store 整表克隆路径（store.ts:791-797）下 user 引用变 → 重渲（正确行为，非每 delta） | 不影响本批「跳过多 delta 重渲」目标 |
| C6 | after 侧 MessageStream/Turn inclusive 未必降 | O(n²) 派生归零后 patch 仍存 | 不承诺；仅断言 UserBubble+TurnSummary 下降 |
| C7 | RO loop 根因在 virtua 库内部 | 业务侧清理后告警量级可能不变 | docs/todo/resize-observer-loop-noise.md 登记；不承诺归零 |

## 8. 与题面对齐

| 题面（GLM 审查 F2/F4/N1/N2） | 本表证据 |
|---|---|
| F2 稳定引用 props 跳过组件更新 | §1 UserBubble+TurnSummary inclusive 下降 + T2 探针 PASS |
| F4 EdgeFade IO 哨兵消强制布局 | §2 EdgeFade self →≈0 + T5 探针 PASS |
| F4 修 gap=29.5px | §6 gap_warnings=0 + T4 探针 PASS |
| N1 mask 常量（等价，收益≈0，勿记收益） | §2/T6：mask 激活态 = 常量，不记 CPU 收益 |
| N2 aiCopyKey 用 id | §1/T2：随 props 改造移除 turn.index 依赖 |
