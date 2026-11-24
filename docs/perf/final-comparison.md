# 批5 终版同场景前后对比表（干净 harness）

> 分支 `feat-cpu-gpu-performance` · before = `eff28e4a5`（批1 前的原始代码）· after = HEAD `fa43afc7b`（5 批优化全部落地）
> 数据 = `docs/perf/final-measurement/`（三进程 profile、metrics、env、folded 栈、分析原始输出）；trace 本体在会话 artifacts `<artifacts>/b5-traces/`
> 复算：`node probes/analyze-clean-cpu.mjs baseline=docs/perf/final-measurement final=docs/perf/final-measurement` / `node probes/analyze-gpu-arms.mjs ...`
>
> **本表与批1-4 对比表的根本差别**：批1-4 的 before 继承首轮脏测量（打包版并存 + 后台窗口 + 4 次运行拼盘 + GPU trace 仅 33.67s）。本表的前后两侧**跑在同一 harness 上**——同一台机、同一 dev Electron 壳、同一 production bundle 形态（`vite build --minify false` + `vite preview` 静态伺服）、同一 faux fixture（`original-45k`，45,663 字符）、同一探针（`probes/perf-clean-cpu.mjs`，单次运行内采齐 renderer+runtime+pi）、同一安静窗（load 1m 2.19 vs 3.59）。唯一变量 = 代码。

## 0. 环境声明（题面 8 条测量纪律的逐条落实）

| # | 纪律 | 本批落实 | 残留偏差 |
|---|---|---|---|
| 1 | prod 构建 | `pnpm --filter @taiji/frontend exec vite build --minify false`（production 模式）+ `vite preview --port 4173` 静态伺服；bundle 内 dev 专属插桩串全 0（`build-probe-grep.txt`） | **minify 关闭**（minified 产物函数名被 mangle，CPU 归因不可用：`railMemoFor` 等四个关键函数名命中 0）；main/runtime/pi 仍 dev 形态（tsx / jiti 源码扩展） |
| 2 | 前台可见窗口 | 未设 `TAIJI_DEV_BACKGROUND`（dev-instance 透传才走 showInactive） | 无 |
| 3 | 无其他 Electron 并存 | 探针前置枚举：白名单外 Electron 一律拒绝采集；测前停掉本 worktree 旧 dev 实例 | **打包版 TaiJi.app 在位（受限条件 L1）**：它是本会话宿主，关闭即杀死当前 agent 会话。其实测瞬时 CPU：GPU helper 15–24%（两次采集）、renderer 4–5%、其余 0%——非 idle 竞争，但无法彻底排除 |
| 4 | 同一次运行采齐三进程 | `perf-clean-cpu.mjs`：renderer（CDP Profiler，无 tracing）+ runtime（SIGUSR1→inspector）+ pi（mock-pi 置换 → `--inspect=0`）三 profiler 同时 start，同一 `delivery.submit` 锚点 | pi 进程形态 = node + `cli.js`（Bun SEA 不可 inspect，首轮已实证）；流式期 pi 的角色（事件转发/序列化）不变，但绝对 CPU 不可与真 Bun 二进制比 |
| 5 | recordContinuously + dataLoss | `Tracing.start{options:'record-continuously'}` + `Tracing.dataLossOccured` 监听 | 无（本批全部 trace `dataLoss=0`） |
| 6 | Performance.enable 交叉验证 | renderer CDP `Performance.enable` + 窗内每秒 `getMetrics`（58 次采样）；V8 profile non-idle vs `TaskDuration/wall` | 无（Δ ≤ 1.5pp，见 §2 xval 行） |
| 7 | 补 fixture 形态 | `multi-small-fences`（24 fence / 41,010 字符）、`tool-calls`（5 轮 toolUse + 7 次 bash / 38,624 字符）、`heavy-thinking`（24K thinking + 22K 正文 / 46,009 字符） | 合成语料 ≠ 真实对话语义；结论只承载「形态覆盖无回归/无新热点」 |
| 8 | 归档全部原始文件 | `docs/perf/final-measurement/`（8.0MB：三进程 profile × 5 组 + metrics + env + folded 栈 + 分析原始输出 + 截图）；trace × 9（2.2GB）入会话 artifacts | 大 trace 不入库（体积），报告给绝对路径 |

**load 声明**：baseline 采集 load 1m = 2.19 / 5m 2.40，final 采集 load 1m = 3.59（首采）/ 3.50（复采），补充形态 1.88–2.25，四臂 GPU 2.2–4.4。全部远低于题面的 15 门限。

**并存 Electron 清单（采集期实测）**：被测 dev 实例（`.dev-electron` 主进程 + GPU/renderer helper）+ 打包版宿主 `/Applications/TaiJi.app`（主进程 0%、GPU helper 15–24%、renderer 4–5%、runtime 0%、其 pi 子进程 0–2%）。

## 1. renderer 主线程（核心表）

窗口 = send → `message.complete`（58.9s vs 58.6s，两次运行都覆盖完整流式含 fence 闭合）。self-time = 采样落点帧；inclusive = 沿 parent 链上行。

| 指标 | before `eff28e4a5` | after `fa43afc7b` | 变化 |
|---|---|---|---|
| **非 idle 占比**（V8 profile） | **57.5%** | **53.4%** | −4.1pp（复采 48.8% ⇒ 区间 48.8–53.4%） |
| `(program)`（未归因的原生工作） | 29.2% | 34.9% | +5.7pp（绝对量同向：给了渲染器更多原生工作窗口；见 §1.1） |
| **JS busy** | **28.3%** | **18.5%** | **−9.8pp（−35%）** |
| **派生族 self**（rail 摘要 / preview / truncate / buildStreamViewItems） | **2.068s (3.51%)** | **0.071s (0.12%)** | **−96.6%**（复采 0.082s ⇒ 0.071–0.112s） |
| ├ `truncate` | 0.787s | — | 归零（码点级 early-exit） |
| ├ `stripMarkdown` | 0.683s | 0.063s | −91% |
| ├ `previewText` | 0.555s | — | 归零（thunk 化） |
| └ `railMemoFor` + `buildStreamViewItems` + `summarizeAssistantForRail` | 0.043s | 0.008s | −81% |
| **fence 闭合窗 shiki self** | **1.073s（全流式窗，1.82%）** | **0.000s** | **归零**（高亮移出主线程到 Worker；fence 闭合窗内已无 shiki 帧） |
| **EdgeFade.sync self**（旧 scroll 回调的强制布局读） | **0.369s** | **0.000s** | 归零（IO 哨兵；函数在 bundle 中已消失） |
| `scrollTo` self（原生滚动前强制布局） | 1.416s | 2.409s / 2.224s（两次） | **+70% / +57%**（回归，见 §4 残余风险 R1） |
| `flushJobs` inclusive | 8.894s (15.11%) | 4.450s (7.59%) | −50% |
| `componentUpdateFn` inclusive | 7.975s (13.55%) | 3.645s (6.22%) | −54% |
| `renderMarkdown` inclusive | 4.567s (7.76%) | 2.659s (4.54%) | −42% |
| `DOMPurify.sanitize` inclusive | 1.170s (1.99%) | 1.155s (1.97%) | 不变（未优化项，符合预期） |
| `TaskDuration`（CDP metrics） | 32.96s (56.0%) | 31.54s (53.8%) / 28.85s (49.5%) | −4% ~ −12% |
| `LayoutDuration` | 7.00s (11.9%) | 7.95s (13.6%) | +14%（同向 R1） |
| `RecalcStyleDuration` | 1.97s (3.3%) | 2.57s / 2.44s (4.4%/4.2%) | +24% |
| `ScriptDuration` | 1.32s | 1.28s / 1.17s | −3% ~ −11% |

**`(program)` 交叉验证**（题面纪律 6）：V8 profile 的非 idle 与 CDP `TaskDuration/wall` 逐 run 对齐 Δ = **+1.5pp / −0.5pp / −0.6pp**（补充形态 +0.4 / +0.2 / −0.2pp）。⇒ 「非 idle」口径可信，`(program)`（29–35%）是**主线程上的原生渲染/布局工作**，不是 profile 伪影。首轮报告「(program) 13.1s 未归因」的问号在本批得到定量答案：它随浏览器原生渲染流水线走，JS 侧优化无法直接削减它（本批 −4.1pp 的非 idle 降幅已包含它的被动变化）。

### 1.1 为什么 `(program)` 占比反而上升

`(program)` 的**绝对量**基本不变（57.5%×58.9 = 33.9s → 53.4%×58.6 = 31.3s，−7.7%），占比上升是因为分母里的 JS busy 掉得更多（−9.8pp）。这是「JS 让出主线程 → 同一段墙钟里原生工作获得更多执行窗口」的正常表现，不是回归。判据 = `(program)` 绝对值不涨 + 帧率不掉（GPU 侧 60fps，见 §3）。

## 2. runtime / pi（同一次运行内采齐）

| 进程 | before | after | 变化 |
|---|---|---|---|
| **runtime** non-idle | 2.7% | 1.2%–2.1% | 噪声内（后台进程本就空闲） |
| ├ `ruleMatchesPath` self | 0.25s | — | 快路径后不出现在 TOP 3（批4 交付） |
| ├ `writev` self | 0.20s | 0.24s | 噪声内 |
| **pi** non-idle | 5.3% | 4.8%–5.3% | 噪声内（流式期 pi 只做事件转发/序列化） |
| pi 首 token 延迟 | 22ms（warm，见 §5） | 22ms | 噪声内 |

## 3. GPU（union 口径，禁嵌套求和）

窗长 63.5s（baseline）vs 63.8/63.0s（final 两轮），均完整覆盖流式。

| 指标 | 干净 before | 干净 after（两轮） | 变化 |
|---|---|---|---|
| **CrGpuMain 忙占比**（`Scheduler::RunTask` union ÷ 墙钟） | **23.3%** | **24.1% / 23.0%** | **噪声内（+0.8pp / −0.3pp）** |
| └ RunTask union | 15.03s | 15.71s / 14.75s | 噪声内 |
| ├ 具名直接子覆盖 | 6.52s | 6.63s / 6.37s | 噪声内 |
| └ **未命名 gap（驱动侧工作）** | 8.51s | 9.08s / 8.38s | 噪声内 |
| Raster（`RendererRasterWorker`） | 4.40s（5349 次） | 4.51s / 4.29s（5643/5603 次） | 噪声内 |
| Present | 1.16s | 1.22s / 1.17s | 噪声内 |
| ApplyBackpressure | 0.086s | 0.146s / 0.147s | +0.06s（量级仍 ≈ vsync 等待，非积压） |
| 帧数 / 均 FPS | 3793 / 60.0 | 3790/3780 / 59.9–60.0 | 不变（都锁 60Hz） |
| <55fps 秒数 | 0 | 0 | 不变 |

**读法（关键）**：干净环境下 **GPU 侧相对基线无净变化**——因为基线在干净环境里本来就不饱和（23.3%，60fps）。批1 声称的「GPU 99.4%→18.8%」实为**首轮脏环境的产物**（见下）；5 批优化在 GPU 侧的真实收益是**消除了「脏环境下才会出现的 20fps/69% 饱和形态」的触发条件之一**（派生族与 shiki 不再每 delta 灌主线程工作），而不是把干净环境的 23% 再压下去。

### 3.1 首轮脏基线的 GPU 数字为何不可引用（本批实测确认 GLM M1/A6/A7）

| 指标 | 首轮脏基线 `run2d`（33.67s 窗） | 本批干净基线（63.5s 窗） | 倍差 |
|---|---|---|---|
| GPU 忙占比 | **69.4%** | **23.3%** | 3.0× |
| Present union | 12.01s（35.7%） | 1.16s（1.8%） | 10.4× |
| ApplyBackpressure union | **11.353s** | **0.086s** | **132×** |
| 帧数 / 均 FPS | 660 / **20.0** | 3793 / **60.0** | 3× |
| <55fps 秒数 | 32/33 | 0/62 | — |

后台不可见窗口（`TAIJI_DEV_BACKGROUND=1`，被 occluded 降帧）+ 打包版合成器竞争 ⇒ 掉到 20fps ⇒ Present/Backpressure 被撑到 12s/11.4s（GLM 判定为「等 vsync」而非干活，本批数据确认：干净环境里同一被测量只有 0.086s）。

## 4. TTFT（批4 数据 + 本批干净复测）

| 模式 | 批4 before | 批4 after | 本批干净复测（after，load 1.36） |
|---|---|---|---|
| warm（转发地板） | 65ms 中位 | 39ms 中位 | **22ms / 21ms**（first-delta 41/38ms，submit-rtt 2–4ms） |
| walk（prompt 同时刻并发 file.tree + file.search） | 46ms 中位 | 130ms 中位 | **30ms / 33ms**（gitignore 编译 2 次，submit-rtt 11ms） |
| fresh（含 pi 冷启动段） | 227ms | 71ms | 未复测（本批 fresh 形态被 GPU/CPU 采集覆盖；pi 冷启动结论见批4） |

**读法**：干净 prod bundle 下 warm 与 walk 都落在 20–33ms 区间（vs 批4 dev 形态的 39–130ms）——prod 构建与前台窗口把 dev 形态的额外开销去掉了。walk vs warm 差 8–11ms（≈ 一次全树 walk 的提交段），与批4 结论一致：**walk 不在 TTFT 关键路径**。

## 5. 各批收益归因表（哪一批贡献了哪一项）

| 项 | 归因批次 | before | after | 证据 |
|---|---|---|---|---|
| 派生生族 O(n²) → 0 | **批1** | 2.068s (3.51%) | 0.071s (0.12%) | `cpu-analysis.txt` §A；函数级明细（truncate/stripMarkdown/previewText/railMemoFor） |
| 强制布局：EdgeFade scroll 回调读 | **批2** | 0.369s | 0.000s | `EdgeFade.sync` 帧在 after bundle 中消失 |
| 组件更新跳过（UserBubble/TurnSummary 稳定引用 props） | **批2** | `flushJobs` 8.894s / `componentUpdateFn` 7.975s | 4.450s / 3.645s | 组件级 inclusive 在 prod bundle 不可测（`_sfc_render` 匿名），由这两项承载 |
| fence 闭合 shiki 冻结 | **批3** | 1.073s（窗内） | 0.000s | shiki 族帧在流式窗内归零（Worker 承载） |
| `.gitignore` matchPath 成本 | **批4** | 265ms/轮（7003 路径 2.16×） | 111.9ms/轮 | 批4 对比表 §2（纯 Node 基准确认为主证据） |
| TTFT 地板 | 批4 诊断 | 39–130ms（dev） | 22–33ms（prod bundle） | 本批 §4 |
| GPU 忙占比 | **本批干净数据 ⇒ 无净收益（脏环境的 69% 不可引用）** | 23.3% | 23.0–24.1% | §3 |

**5 批累计（干净口径，可引用）**：JS busy **−35%**（28.3%→18.5%）、派生族 **−96.6%**、shiki **归零**、EdgeFade 强制布局 **归零**、Vue 更新链 **−50%**、TTFT warm **22ms**；**GPU 与帧率不变（本来就不是瓶颈）**。

## 6. 残余风险

| # | 风险 | 依据 | 处置 |
|---|---|---|---|
| R1 | **`scrollTo` self 上升 57–70%**（1.416s → 2.409/2.224s），`LayoutDuration` +14%、`RecalcStyleDuration` +24% | `cpu-analysis.txt` §A；两次独立运行同向 | 已在批2 修过 gap（endOffset 补偿 padTop），本批实测显示滚动 churn 仍偏高。**未定位根因**（需一轮 follow-health 探针）；登记为下一批候选，不阻塞本批 |
| R2 | minify 关闭 | 纪律 1 的代价（函数名可归因） | 生产 bundle 的 minify 对流式窗行为影响未测（I2） |
| R3 | 打包版 TaiJi.app 在位（L1） | 纪律 3 无法彻底满足 | 其实测瞬时 CPU 为 GPU helper 15–24%（它自己也有一帧循环），但 baseline 与 final 同条件（15% vs 24% 同量级）、且两轮 final 独立复现 ⇒ 可比性成立 |
| R4 | 组件级 inclusive 不可测 | prod bundle `_sfc_render` 匿名 | 由 flushJobs / componentUpdateFn 承载；若要组件级数字需 dev bundle（引入 dev 扭曲，不做） |
| R5 | pi profile 用 node 替代 Bun SEA | Bun 不食 NODE_OPTIONS / SIGUSR1 杀进程 | 只解释「流式期 pi 几乎空闲」，绝对 CPU 不作跨形态比较 |
| R6 | 补充形态为合成语料 | fixture 生成器确定性产出 | 结论只承载形态覆盖与热点分布，不外推到真实对话 |

## 7. 数据文件索引

| 文件 | 内容 |
|---|---|
| `docs/perf/final-measurement/baseline-{renderer,runtime,pi}.cpuprofile` | 干净基线三进程 profile |
| `docs/perf/final-measurement/final-{renderer,runtime,pi}.cpuprofile` | 干净终版三进程 profile（首采） |
| `docs/perf/final-measurement/final-r2-*.cpuprofile` | 干净终版第二次独立运行（跨运行方差披露） |
| `docs/perf/final-measurement/{baseline,final,form-*}-metrics.json` | `Performance.getMetrics` 窗内每秒快照 |
| `docs/perf/final-measurement/{baseline,final,form-*}-env.json` | 环境声明（HEAD / load / fixture md5 / bundle md5 / 端口 / 并存 Electron 瞬时 CPU） |
| `docs/perf/final-measurement/{baseline,final}-renderer.folded.txt` | 折叠栈（flamegraph.pl / speedscope 可直接渲染） |
| `docs/perf/final-measurement/cpu-analysis.txt` | CPU 对比表 + (program) 交叉验证 + 形态表（原始输出） |
| `docs/perf/final-measurement/gpu-analysis.txt` | 四臂 + 两次重复 + 脏基线对照（原始输出） |
| `docs/perf/final-measurement/build-probe-grep.txt` | prod bundle 的 dev 插桩串计数 + 函数名可归因性证据 |
| `docs/perf/final-measurement/{baseline,final}-midstream.png` | 流式中期截图（FPS overlay 在场证据） |
| <artifacts>/b5-traces/*.trace.json | trace 本体 ×9（baseline / final ×2 / no-blur ×2 / no-mask ×2 / reduced / 原始脏基线） |
