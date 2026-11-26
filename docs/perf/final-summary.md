# taiji 对话流性能优化 · 5 批累计汇总报告

> 分支 `feat-cpu-gpu-performance` · 原始基线 `eff28e4a5`（11-22，`origin/main` 同点）→ HEAD `fa43afc7b`（批5 末）
> 上游链条：首轮实测（[perf-measured-report.md](perf-measured-report.md)）→ GLM 对抗审查（[adversarial-review-glm.md](adversarial-review-glm.md)）→ 5 批优化 → 本批**干净重测 + GPU 据实裁决**
> 逐项数字见 [final-comparison.md](final-comparison.md)（本表的表格版）；GPU 裁决见 [gpu-decision.md](gpu-decision.md)；各批过程表见 [batch1](batch1-comparison.md)–[batch4](batch4-comparison.md)-comparison.md

## 0. 一页结论

| 问题 | 首轮判定 | 干净重测结论 |
|---|---|---|
| 瓶颈在哪 | 「每-delta Vue 重渲染 #1 + GPU 饱和 #2」 | **JS 侧派生/高亮/更新链**（已消除 96%+）；**GPU 从来不是瓶颈**（干净环境 23% 忙、60fps，首轮 69%/20fps 是测量环境产物） |
| 优化收益 | 「主线程 39%→…」 | **JS busy −28%（28.3%→20.5%，复采 −41%）、派生族 −97.1%、shiki 归零、EdgeFade 强制布局归零、Vue 更新链 −55%、TTFT 22ms** |
| GPU 视觉项要不要动 | 「等干净数据」 | **blur：动（条件降档，26% GPU 工作量过判据但不掉帧⇒下一批带触发条件实施）；mask：不动（测不出代价）** |
| 数据可引用性 | 混杂未披露 | **同 harness 双测量**（before/after 同机同壳同 bundle 形态同 fixture 同探针；load 2.19 vs 3.59；dataLoss 全 0；`(program)` 经 CDP metrics 交叉验证 Δ≤1.5pp） |

## 1. 5 批做了什么

| 批 | 主题 | 交付 | 交付依据 |
|---|---|---|---|
| 批1 | **派生归零** | rail 摘要流式冻结（`streamingRailAnchor`）+ preview 改 thunk（构建期不求值）+ `truncate` 码点级 early-exit | GLM A2/D8.1/M5：O(n²) 派生 ≈4.5s，rail/preview 每 delta 重算是 dev/prod 同量级的真瓶颈 |
| 批2 | **契约层更新跳过 + 强制布局纪律** | `Turn.vue` → UserBubble/TurnSummary 改稳定引用 props（`shouldUpdateComponent` 整体跳过）+ EdgeFade 贴顶哨兵 IntersectionObserver（scroll 回调零几何读）+ 跟底 endOffset 补偿 padTop | GLM C2/D2（v-memo deps 不全 → 换稳定引用）/ C5（`sync` 2.5ms/次 = `scrollTop` 强制布局）/ D8.4 |
| 批3 | **fence 闭合高亮移出主线程** | shiki Web Worker 化 + 两壳 CSP `worker-src 'self'` + 失败降级回同步高亮 + 流式期 streaming-fence 占位 | GLM C4（突发在 fence 闭合、complete 处为零）/ D6（分帧对单块无效，Worker 是唯一与块大小无关的解） |
| 批4 | **TTFT（首 token 延迟）** | `.gitignore` matchPath 段级快路径（2.1–2.5×，oracle + 属性模糊双锁）+ pi 冷启动根因定位（dev jiti 1769 模块 vs bundle 59 模块，登记不可优化）+ 「walk 阻塞首 token」实测证伪 | GLM A4③/A5/S6/S9/F5 |
| 批5 | **干净重测 + GPU 据实决策** | 三进程同运行采集探针 + recordContinuously GPU trace + 四臂 A/B + 三种补充 fixture + 终版对比表 + 汇总报告 | GLM A6–A9/S3/S4/S7/M8（首轮测量混杂 + GPU 数据不可引用） |

## 2. 累计收益（对首轮原始基线，干净口径）

### 2.1 CPU（renderer 主线程，58.9s vs 58.6s 流式窗）

| 项 | 首轮脏基线 | 干净基线 | 干净终版 | 首轮→终版 |
|---|---|---|---|---|
| JS busy | 46.7%（+10..73s 窗） | 28.3% | **20.5%** | **−56%** |
| 派生族 self | 2.919s（4.6% 窗） | 2.068s（3.51%） | **0.059s（0.10%）** | **−98.0%** |
| fence 窗 shiki | 2.330s（46.6% 于 5s 窗） | 1.073s（1.82% 流式窗） | **0.000s** | **归零** |
| EdgeFade.sync | 0.546s | 0.369s | **0.000s** | **归零** |
| Vue 更新链（`flushJobs`） | 19.05s（30% 窗） | 8.894s（15.11%） | **4.027s（6.81%）** | **−79%** |
| `renderMarkdown` | 5.53s | 4.567s | **2.653s** | **−52%** |
| `(program)` 未归因 | 13.1s / 15.9% | 29.2% | 34.9% | 绝对量 −7.7%，占比随 JS 下降被动上升（§final-comparison 1.1） |
| 非 idle | 62.5% | 57.5% | **48.8–54.8%** | **−8~14pp** |

> 首轮列是**脏 harness**（dev bundle + 后台窗口 + 打包版并存 + tracing 混用），只作溯源；可引用的因果链是「干净基线 vs 干净终版」两列。

### 2.2 GPU（union 口径，禁嵌套求和）

| 项 | 首轮脏基线（33.67s） | 干净基线（63.5s） | 干净终版（63.8/63.0s） |
|---|---|---|---|
| CrGpuMain 忙占比 | **69.4%** | **23.3%** | **24.1% / 23.0%** |
| Present union | 12.01s | 1.16s | 1.22s / 1.17s |
| ApplyBackpressure | **11.353s** | **0.086s** | 0.146s / 0.147s |
| Raster | 5.88s | 4.40s | 4.51s / 4.29s |
| 均 FPS / <55fps 秒 | **20.0 / 32 秒** | **60.0 / 0** | 59.9–60.0 / 0 |

**核心更正**：批1 的「GPU 99.4%→18.8%」不可引用——99.4% 来自**后台被降帧的 20fps 形态**。干净环境下 GPU 侧**无净收益**；5 批在 GPU 侧的真实价值 = 移除了「脏环境下才触发的饱和形态」的灌帧来源之一（每 delta 的派生/高亮/更新全部消失），但基线本就不饱和。

### 2.3 TTFT

| 模式 | 首轮 | 批4（dev） | 批5 干净（prod bundle，load 1.36） |
|---|---|---|---|
| warm | 未单列 | 39ms 中位 | **22ms / 21ms** |
| walk | 「~0.9s 阻塞」 | 130ms 中位 | **30ms / 33ms**（编译 2 次） |
| fresh | 未单列 | 71ms | 未复测（pi 冷启动结论见 §5） |

## 3. 各批收益归因

| 收益 | 贡献批次 | 量化 |
|---|---|---|
| 派生族归零 | 批1 | 2.068s → 0.059s（−97.1%），JS busy 里约 3.4pp |
| 组件更新跳过 | 批2 | flushJobs −55%、componentUpdateFn −61%（prod bundle 无法测组件级 inclusive，见 R4） |
| 强制布局（EdgeFade） | 批2 | 0.369s → 0（`sync` 帧在 bundle 中消失） |
| shiki 冻结消除 | 批3 | 1.073s → 0，且 fence 闭合窗内零 shiki 帧 |
| matchPath CPU | 批4 | 265→112ms/轮（2.16–2.33×，7003 路径） |
| 测量基建纠错 | 批5 | GPU 侧首轮结论全部作废重立；cross-validation 建立 |

## 4. 补充 fixture 形态覆盖（题面纪律 7）

三种形态各测一轮（HEAD 代码、同 harness、同 prod bundle、自建 session、事件驱动收尾）：

| 形态 | fixture | 字符 | 墙钟 | 非 idle | 派生族 | shiki | scrollTo | flushJobs | compUpdateFn | Layout |
|---|---|---|---|---|---|---|---|---|---|---|
| 多小代码块（24 fence） | `multi-small-fences.json` | 41,010 | 52.6s | 41.9% | 0.055s | **0** | **2.653s (5.06%)** | 4.931s | 4.089s | 2.92s |
| 工具调用（5 轮 toolUse / 7 bash） | `tool-calls.json` | 38,624 | 51.0s | 40.7% | 0.061s | **0** | 0.842s | 3.997s | 3.204s | **5.54s** |
| 重 thinking（24K 思考） | `heavy-thinking.json` | 46,009 | 58.9s | 51.3% | 0.071s | **0** | 0.916s | 5.302s | 4.569s | **11.01s** |

**三条结论**：

1. **无回归、无新热点**：三种形态的派生族（0.055–0.071s）与 shiki（全 0）与主形态（original-45k 的 0.059s / 0）同量级 —— 批1/批3 的收益不是「单形态特化」的产物。
2. **多小代码块把成本转移到滚动**：`scrollTo` 2.653s / 5.06%（主形态 3.81–4.87%）——24 个 fence 让内容高度变化更频繁，跟底滚动 churn 上升。这是 R1（scrollTo 上升）的同族信号，**下一批的明确目标**。
3. **重 thinking 把成本转移到布局**：`LayoutDuration` 11.01s（主形态 7.11–7.98s）、非 idle 51.3% —— thinking 块的跟底滚动 + 高度重算（GPU-8 曾登记「thinking 跟底路径完全未测」，本批首次给出量化：在重 thinking 形态下它是最贵的单项原生工作）。
4. **工具调用形态的布局成本居中**（5.54s）：多轮 turn 边界与工具卡的插入/折叠带来换行与高度变化，但比 thinking 轻。

## 5. 残余风险与未决项

> **批6 已全部闭环**：R1–R9 逐项调查/修复/定量的完整证据链见 [residual-risks-closure.md](residual-risks-closure.md)。下表为快照（状态以批6 为准）。

| # | 项 | 批6 结果 |
|---|---|---|
| R1 | `scrollTo` self 上升 | **已修复**：85.7% 是恒等写（写前已在底 ∧ 目标≥底）；`useVirtuaFollow` 守卫跳过 → DOM 写 3283→568（−83%）、scrollTo 归因 2.242→0.322s（−86%）、窗内 Task −4.1s、非 idle 54.3→46.6%；跟随正确性实测无损（流中贴底 + 结束 gap 0）。根因澄清：批5 的「+57~62%」主体是强制布局的归因漂移（插桩对账实证），非写次数变化 |
| R2 | minify 关闭偏差 | **已定量**：主 chunk 解析编译差 6ms（一次性、加载期）；流式窗内 parse/compile 0.378s/59.1s（0.64%，懒 chunk） |
| R3 | 打包版并存（L1） | 维持 + 量化界（并存 helper 瞬时 39–48% 单核；A/B 双臂同条件） |
| R4 | 组件级 inclusive 不可测 | **已推翻**：`__name` 行号映射归因（`analyze-component-attribution.mjs`）；实测组件渲染层 inclusive 仅 1.42s（2.4% 窗），组件渲染非热点 |
| R5 | pi profile 用 node 代理 | **升级为真实证据**：macOS `sample` 直接采真实 Bun SEA；流式窗 pi CPU 5.56s/65.8s（8.4%，含冷启动段），流中主体为 `kevent` 等待 |
| R6 | 合成语料 | **已定量**：fence/heading/list 刻意超加权 ×4~×45 ⇒ per-char 成本是真实流量上界；tool-calls 形态行密度 ×10.8 偏差登记 |
| R7 | `(program)` 34% 未归因 | **已归因**：= 每帧原生 Layout（10.1–11.5s）+ Paint（6.6–7.5s）+ GC/EventDispatch；JS 侧强制布局仅 0.3s——内容增长的固有原生渲染，接受 |
| R8 | pi 冷启动 dev | 维持裁决（不可优化）；新证据：新会话 pi 冷启动 ~5.5s CPU + 流式近零 |
| R9 | 分支未推送 / 独立 clone | 维持登记（外部动作归用户裁决） |

批6 后本报告口径更新：`scrollTo` 0.322s、非 idle 46.6%、JS busy 14.9%（派生族 0.084s、shiki 0、EdgeFade.sync 0 不变）——见 closure §1.3。

## 6. 火焰图与数据索引

### 6.1 火焰图（折叠栈已生成，可直接渲染）

| 侧 | 折叠栈 | 渲染方式 |
|---|---|---|
| 基线 | `docs/perf/final-measurement/baseline-renderer.folded.txt`（1982 栈） | `flamegraph.pl baseline-renderer.folded.txt > baseline.svg`；或 speedscope 导入；或 DevTools Performance 直接加载同名 `.cpuprofile` |
| 终版 | `docs/perf/final-measurement/final-renderer.folded.txt`（965 栈） | 同上 |
| 生成器 | `node scripts/perf-probes/cpuprofile-to-folded.mjs <profile> [--from s] [--to s]` | — |

**栈数对比本身是一条结论**：1982 → 965 条不同栈（−51%）——热路径的形状从「每 delta 走一遍完整派生+渲染链」收敛成更窄的少量路径。

### 6.2 原始数据

| 类别 | 路径 | 说明 |
|---|---|---|
| 三进程 profile（baseline / final / final-r2 / 三形态） | renderer 侧 6 件：`docs/perf/final-measurement/*-renderer.cpuprofile`（入库，无绝对路径，DevTools 可直接加载）；pi/runtime 侧 12 件：归档出库（branch-review dmg-r1-2：内嵌 worktree 绝对路径，rule-22① 不入库） | pi/runtime 本体落会话 artifacts `<sessionsRoot>/<sessionId>/artifacts/final-measurement-raw/`，去向与 md5/bytes 对账见同目录 `raw-artifacts-manifest.json`（会话扫描通配解析，与下行 GPU trace 同模式） |
| CDP metrics 快照 | `docs/perf/final-measurement/*-metrics.json` | 每秒一次，`Performance.enable` 后采集 |
| 环境声明 | `docs/perf/final-measurement/*-env.json` | HEAD / load / fixture md5 / bundle index md5 / 端口 / 并存 Electron 瞬时 CPU / 窗长 |
| 分析原始输出 | cpu-analysis.txt（归档，同上清单）；gpu-analysis.txt 在库：`docs/perf/final-measurement/gpu-analysis.txt` | 本报告与 final-comparison 的所有数字的机器输出；check-final-reports 经清单定位 cpu-analysis.txt 并 md5 对账 |
| 构建证据 | `docs/perf/final-measurement/build-probe-grep.txt` | dev 插桩串计数 + 函数名可归因性 |
| 截图 | `docs/perf/final-measurement/{baseline,final}-midstream.png` | 流式中期（FPS overlay 在场） |
| **GPU trace 本体 ×9** | `<sessionsRoot>/<sessionId>/artifacts/b5-traces/*.trace.json`（2.2GB） | baseline-gpu / final-gpu / r2-full / r2-no-blur / r2-no-mask / arm-no-blur / arm-no-mask / arm-reduced |
| **trace 清单（同源凭据）** | `docs/perf/final-measurement/gpu-trace-manifest.json` | 每个分析 label ↔ trace 文件名的 md5 对账；`check-clean-artifacts.mjs` 在 trace 可达时当场复算比对（防止 gate 重跑覆盖 trace 后「归档分析 ↔ trace 本体」悄悄漂移——本批实测踩到过一次） |
| 首轮原始数据（只读） | `~/.taiji/ext-sessions/01a2077f-.../artifacts/profiling-data/`（44MB） | 首轮权威两件 + 复算脚本 |
| 复算脚本 | `scripts/perf-probes/`（测量工具族，登记见 [docs/testing/perf-probes.md](../testing/perf-probes.md)）：analyze-clean-cpu / analyze-gpu-arms / analyze-gpu-union / cpuprofile-to-folded / perf-clean-cpu / gpu-trace | 全部入库、零依赖 |

## 7. 复算命令

```bash
# CPU 对比表（含 (program) 交叉验证）：任意 cwd、仓库根（renderer profile + env + metrics 均在库）
node scripts/perf-probes/analyze-clean-cpu.mjs baseline=docs/perf/final-measurement final=docs/perf/final-measurement
node scripts/perf-probes/analyze-clean-cpu.mjs form-fences=docs/perf/final-measurement form-tools=docs/perf/final-measurement form-thinking=docs/perf/final-measurement

# GPU union 分析（把 artifacts 里的 trace 拷回来即可）
node scripts/perf-probes/analyze-gpu-arms.mjs clean-baseline=/tmp/b5/baseline-gpu.trace.json final-r1=/tmp/b5/final-gpu.trace.json \
  noblur-r1=/tmp/b5/arm-no-blur.trace.json nomask-r1=/tmp/b5/arm-no-mask.trace.json reduced-r1=/tmp/b5/arm-reduced.trace.json

# 火焰图
node scripts/perf-probes/cpuprofile-to-folded.mjs docs/perf/final-measurement/final-renderer.cpuprofile > /tmp/final.folded

# 重采（需实例；见 docs/tp-api-batch5.md 的启动命令）。原始采集物不入库，产出落 .run（*.cpuprofile 已 gitignore）
node scripts/perf-probes/perf-clean-cpu.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 \
  --fixture scripts/perf-probes/fixtures/original-45k.json --tag final --window-ms 200000 --save-dir .run/final-measurement-raw
```
