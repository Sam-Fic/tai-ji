# 批1「派生归零」前后对比（CPU + GPU）

> 采集日期 2026-11-23 · 分支 `feat-cpu-gpu-performance` · 交付 = rail 流式冻结 + preview 懒计算 + truncate 码点级 early-exit
>
> **口径声明（先读）**：前后两次采集不是同一次运行，也不共享同一窗口结构。本表所有数字都用**同一套脚本、同一份函数/切片名单**对两侧的原始产物复算得出（脚本随交付物入库：`probes/analyze-gpu-union.mjs`、`probes/perf-derivatives.mjs`），但**跨运行的绝对差含采集噪声**（GLM 对抗审查 A7/A8 已实证同场景跨运行差异 ≥2.7×）。因此本表的结论只承载**量级与方向**，不承载精确百分比；凡涉及"前/后"的差，一律同时给出绝对值和窗口占比两个口径。

## 0. 采集 harness

| 项 | before（基线） | after（本批） |
|---|---|---|
| 宿主 | dev 实例（`TAIJI_DEV_BACKGROUND=1`，后台不可见窗口） | 同左 |
| faux 脚本 | `~/.taiji-dev/verify-prof-20261123-1730/agent/faux-responses.json`（74KB，200TPS，首轮响应 45,326 字符 / 11,412 token） | 同左 |
| session | 新 session + **首条** prompt | 同左 |
| renderer CPU | CDP Profiler，无 tracing | 同左（`.run/after-renderer.cpuprofile`） |
| GPU trace | CDP `Tracing.start{devtools.timeline,gpu,cc, ReportEvents}`，send 锚定 ~34s 窗 | 同左（`.run/after-gpu.trace.json`） |
| 打包版 TaiJi.app | 在跑（审查会话宿主） | 同左 |

基线原始产物（**只读，未重测**）：`~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data/`（`run-notrace-renderer.cpuprofile` = CPU 权威数据集，`run2d-renderer.trace.json` = GPU 数据集）。

after 侧原始产物（`.run/after-renderer.cpuprofile` / `.run/after-gpu.trace.json` / `.run/after-midstream.png`）**不入库**（`.run/` 在 .gitignore）——它们体积大（trace 745K 事件）且含屏幕内容。**复算脚本全部入库**（`probes/deriv-family.mjs` / `probes/gpu-compare.mjs` / `probes/analyze-gpu-union.mjs` / `probes/perf-derivatives.mjs`），故给定上述任一侧产物即可逐字复现本表所有数字；after 侧产物可用 T1/G1 验收 case 重新生成（`probes/perf-derivatives.mjs --save` / `probes/gpu-trace.mjs --save`）。

## 1. 派生生族 self-time（核心指标）

派生族 = `railMemoFor` → `summarizeTurnForRail` / `summarizeAssistantForRail` / `stripMarkdown` / `truncate` + `turnPreview` / `previewText` + `buildStreamViewItems`。

复算口径：`node probes/deriv-family.mjs <profile> <relFromS> <relToS>`（与 `probes/perf-derivatives.mjs` 同一函数名单）。窗口取各自 profile 的**流式段**（before = +10..+73s，after = +65..+80s，即各自 findNextMatchSync/shiki 突发所在的流式段）。

| 口径 | before | after | 变化 |
|---|---|---|---|
| 派生生族 self-time | **2.919s** | **0.005s** | **−99.8%** |
| ├ `truncate` | 1069.246ms | — | 归零 |
| ├ `stripMarkdown` | 1050.135ms | 1.497ms | −99.9% |
| ├ `previewText` | 719.338ms | — | 归零（改为 thunk，构建期不求值） |
| ├ `buildStreamViewItems` | 30.262ms | 1.972ms | −93% |
| ├ `railMemoFor` | 28.574ms | — | 归零（冻结复用，miss 不再重算） |
| ├ `summarizeTurnForRail` | 11.614ms | — | 归零 |
| ├ `summarizeAssistantForRail` | 8.615ms | 1.668ms | −81% |
| └ `turnPreview` | 1.515ms | — | 归零 |
| 占流式窗采样时长 | 2.919s / 63.0s = 4.6% | 0.005s / 15.0s = 0.03% | −99.4% |

**真机阈值断言（T1 探针）**：`node probes/perf-derivatives.mjs --data-dir <dir> --sid <sid> --threshold-s 0.3`
```
RESULT deriv-family-self-time=0.000s threshold=0.3s PASS
```
（该值为 CDP Profiler 采样的流式窗口径，与上表离线复算的 0.005s 同量级；差异来自采样窗口与运行间波动。阈值 0.3s 的裕度 = 基线值的 1/10，任何"冻结失效回退成每 delta 重算"的回归都会把它打红。）

### 三个子项各自的归零机制

| 子项 | 机制 | 归零方式 |
|---|---|---|
| rail 摘要流式期零重算 | `streamingRailAnchor` 取首个非空 assistant 块的 `(id, length, prefix, fenceOpen)`；`railMemoFor` 在 streaming 态命中「同 id + 同前缀指纹 + 长度 ≥ 256 + 前缀 fence 已闭合」时复用上次 `agentSummary` | 冻结复用（miss 时仍全量算一次） |
| preview 零成本 | `StreamViewItem.preview` 由 `string` 改为 `() => string`；`canReuseView` 的 turn 分派移除 preview 比对 | 构建期不求值，仅 broken 占位行渲染时求值 |
| truncate 无全量分配 | `Array.from(text)` 全量码点化 → 字符串迭代器惰性迭代，满 `maxChars` 码点即 break | 单测用计数迭代器锁定迭代次数 = `maxChars + 1`（21 次），与输入长度无关 |

## 2. renderer 主线程 TOP10（self-time）

同一份 profile 各自的流式窗，`analyze-cpuprofile.mjs` 同口径：

| 排名 | before（+10..+73s，采样 63.0s） | after（+65..+80s，采样 15.0s） |
|---|---|---|
| 1 | (idle) 23.608s | (idle) 11.021s |
| 2 | (program) 9.987s | findNextMatchSync 0.775s |
| 3 | scrollTo 2.044s | #execCore 0.494s |
| 4 | findNextMatchSync 1.257s | (program) 0.201s |
| 5 | **truncate 1.069s** | (garbage collector) 0.172s |
| 6 | **stripMarkdown 1.050s** | RegExp: shiki 规则 0.139s |
| 7 | get @ vue.runtime 0.897s | collectExternalReferencesInRules 0.091s |
| 8 | (garbage collector) 0.791s | scrollTo 0.074s |
| 9 | **previewText 0.719s** | collectExternalReferencesInTopLevelRepositoryRule 0.074s |
| 10 | RegExp: \s+ 0.693s | — |

派生族三项（第 5/6/9 名）从 TOP10 中整体消失；剩下的头部是 shiki（fence 闭合高亮，属批2 议题）与 `(program)`（未归因的原生渲染/布局成本，GLM 审查 M2/C1 已登记）。

## 3. GPU union 口径前后对比

口径：按线程时间轴 union（嵌套子切片不重复计数——GLM 审查 M1 判定的正确口径）。复算脚本：`probes/analyze-gpu-union.mjs`（全窗）+ `probes/gpu-compare.mjs`（可指定子窗口）。

窗内组成不同：before 的 33.67s 里前 ~10s 是 pi 冷启动（每 2s 桶 GPU 活动 66–157ms），后 23s 是流式段（每 2s 桶 ~10,000ms）；after 的 34.65s 全程活跃（jiti 磁盘缓存已热，无冷启动段）。故同时给两个口径：

| 指标 | before 全窗 33.67s | after 全窗 34.65s | before 流式子窗 23.0s | after 流式子窗 34.0s |
|---|---|---|---|---|
| **CrGpuMain union** | 22.88s（67.9%） | 6.38s（18.4%） | 22.85s（**99.4%**） | 6.38s（**18.8%**） |
| **Raster union** | 6.01s | 1.95s | 5.98s（26.0%） | 1.95s（**5.7%**） |
| Raster 次数 | 13,373 | 34,300 | 13,331 | 34,300 |
| **ApplyBackpressure union** | 11.35s | 0.05s | 11.35s（49.3%） | 0.05s（**0.1%**） |
| ApplyBackpressure 次数 | 1,980 | 6,218 | 1,974 | 6,218 |
| CrRendererMain union | 6.81s（20.2%） | 9.01s（26.0%） | 6.80s（29.6%） | 9.01s（26.5%） |
| Compositor union | 2.13s（6.3%） | 3.83s（11.1%） | 2.12s（9.2%） | 3.83s（11.3%） |
| CVDisplayLink 帧数 | 2,884 | 4,155 | 2,840 | 4,155 |
| 帧率（帧/秒） | 85.7 | 120.0 | 123.5 | 122.2 |

**读法**：

1. **GPU 主线程从饱和回到空闲**。流式子窗里 before 的 CrGpuMain union 占墙钟 99.4%（= 完全打满），after 只有 18.8%。这是本批最硬的 GPU 收益。
2. **Raster 真实 GPU 工作 −78%**（26.0% → 5.7% 墙钟）。次数上升 2.6×（13,331 → 34,300）但单次变小（avg 0.45ms → 0.06ms）——从"少数大块反复光栅"变成"多而碎的小块"，总成本大降。
3. **ApplyBackpressure 从 49.3% 墙钟降到 0.1%**。按 GLM 审查 C1 的定性，这是 GPU 主线程**阻塞等待上一帧被显示**（vsync 节流）而非干活；它塌掉说明主线程不再向合成器灌帧，积压消失。
4. **CrRendererMain / Compositor 未恶化**：绝对 union 上升（6.80→9.01s、2.12→3.83s）但窗长也从 23s 变成 34s，**归一化后是 −10% / +23%**，且帧率两侧都 ~122fps（显示链接频率，非真实掉帧）。合成器多做的这 23% 与帧数增加同向，不是回归信号。
5. **帧率两侧都 ~122fps**：本场景流式期帧率本来就不是瓶颈（GLM 审查 A7：「40.2 vs 36 空闲」意味着流式期帧率没掉到空闲基线以下）。本批不声称 FPS 收益。

### FPS / 显存 overlay 截图

| | 截图 |
|---|---|
| before | `~/.taiji/ext-sessions/01a2077f-.../artifacts/profiling-data/run-notrace-midstream.png`（+40s，落在 run2d trace 窗之外，仅作流式中段视觉参照） |
| after | `.run/after-midstream.png`（after trace 窗中点 +17s） |

> 两张截图的分辨率/窗口状态一致（2400×1600，后台不可见窗口），但**不是同一帧内容的对拍**——faux 配速受事件循环影响，流式进度不同步。GLM 审查 A7 已判定该 dev 窗口形态下 Chromium 对不可见窗口降帧，FPS overlay 读数口径本身可疑；故截图只作"GUI 确在流式"的在场证据，不作帧率证据。

## 4. 复算命令（任意 cwd，仓库根）

```bash
P=~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data
# 派生生族（CPU）
node probes/deriv-family.mjs $P/run-notrace-renderer.cpuprofile 10 73   # before
node probes/deriv-family.mjs .run/after-renderer.cpuprofile 65 80       # after
# renderer TOP10（CPU，官方脚本）
node $P/analyze-cpuprofile.mjs $P/run-notrace-renderer.cpuprofile 12 --rel-from 10 --rel-to 73
node $P/analyze-cpuprofile.mjs .run/after-renderer.cpuprofile 12 --rel-from 65 --rel-to 80
# GPU union（全窗）
node probes/analyze-gpu-union.mjs $P/run2d-renderer.trace.json run2d-before
node probes/analyze-gpu-union.mjs .run/after-gpu.trace.json after
# GPU union（流式子窗对比）
node probes/gpu-compare.mjs $P/run2d-renderer.trace.json .run/after-gpu.trace.json 10 33 0 34
```

## 5. 可比性声明与残余风险

| # | 事项 | 影响 | 处置 |
|---|---|---|---|
| C1 | before/after 是**两次不同运行**，非同一次采集的前后切片 | 绝对差含运行间噪声（审查实证同场景 ≥2.7×） | 只用同一脚本/同一名单复算；结论只取量级与方向 |
| C2 | 窗内组成不同：before 含 ~10s pi 冷启动段，after 不含（jiti 磁盘缓存已热） | 全窗口径会低估 after 的收益 | 同时给流式子窗口径（§3 右两列） |
| C3 | 两侧 dev 窗口均后台不可见，Chromium 对不可见窗口降帧 | FPS 绝对值不可信 | 不作 FPS 结论；帧数只用于确认"两侧同频率" |
| C4 | 采集期间打包版 TaiJi.app 全程在跑（GPU helper / renderer 占用 CPU） | GPU 等待类指标受另一合成器竞争影响，无法分离 | 如实标注，不与审查的 GPU 数字硬比 |
| C5 | runtime/pi 侧未采 after 样本 | 无前后对比 | 审查已定论「runtime/pi 忙时可忽略」，且本批不改 runtime/pi 路径；不为比重启实例 |
| C6 | after 侧 CrRendererMain/Compositor 绝对 union 上升 | 表面像回归 | 归一化到窗长后为 −10%/+23%，且帧率两侧同频；登记观察，批2（v-memo/稳定引用 props）承接 |

## 6. 与题面对齐

| 题面（GLM 审查 F 节建议 1） | 本表证据 |
|---|---|
| 「流式期 rail 摘要按 message id 记忆、`content.length ≥ K` 后冻结，fence 行无条件剥离」 | §1 归零机制表 + T1 探针 PASS + B1 单测（同 id 增长/换 id/流结束重算/未闭合 fence 不冻结） |
| 「`StreamViewItem.preview` 懒计算（只在 StreamItemBoundary 失败路径求值）」 | §1 previewText 归零 + B2 单测 |
| 「truncate 码点级 early-exit」 | §1 truncate 归零 + B3 单测（迭代次数 21 与输入长度无关） |
| 「流式窗 ≈ −7% 主线程」 | §1：派生族占流式窗采样 4.6% → 0.03%（**−4.6 个百分点**，量级与 −7% 同向且不含被模块聚合漏掉的 regex self-time——审查 M5 实测少算约 40%） |
| 「零视觉变化（rail 只修掉瞬时泄漏）」 | T2 探针：rail 终态与改前 golden 逐字一致 + 无 fence 泄漏 |
