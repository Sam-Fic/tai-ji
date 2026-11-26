# 对抗式审查：taiji 对话流 CPU/GPU 实测报告（perf-measured-report.md）及其 20 项优化方案

> 审查日期 2026-11-23 · 只读审查（未改任何仓库代码）· 审查对象 = 报告 + `profiling-data/` 原始数据 + `/tmp/taiji-prof/` 未归档原始数据 + 分支 `feat-cpu-gpu-performance` 源码
> 复算脚本（零依赖，Node 22）：`/tmp/review-scratch/{timeline,window-top,node-parents,inclusive,under,trace-main}.mjs`；报告自带脚本 `analyze-cpuprofile.mjs` / `analyze-trace.mjs` 原样重跑。所有「实测」数字均可由这两组脚本从同一 .cpuprofile / trace.json 复现。

---

## 0. 总判定（先读这段）

1. **报告的方向性结论「后端空闲、瓶颈在 renderer 主线程 + 每.delta 派生/重渲染链」成立**，runtime / pi 的「~95% 空闲」数字复算无误；CPU 榜多数 self-time 数字能对上。
2. **但报告的三个「最尖锐」结论都有硬伤**：
   - **「GPU 合成管线 71s/65s 饱和」不成立**——GPU trace 实际墙钟跨度只有 **33.67s**（不是 120s/65s），且 #1「ApplyBackpressure + GL = 22.67s」是把嵌套子切片（GL 在 ApplyBackpressure 内）加在父切片上、再把父切片（11.35s，整段嵌在 Present 内）当成「积压」；backpressure p50 = 16.0ms ≡ 恰好一个 vsync，是 **GPU 主线程在等显示**（限速等待），不是在干活。GPU 主线程真实工作 ≈ 10.9s / 33.67s ≈ 32%。
   - **「renderer 主线程 ~39%」是三个口径混合后的产物**：39% = (idle 与 (program) 都剔除) ÷ 含 15s 空闲的 82.7s 全窗。(program) 13.1s（15.9%）报告全文未解释一个字；只看流式窗（+10..+73s，63s）JS 占用 = **45%**，非空闲 = **62%**；同场景另一次运行（run2d）流式后半段 **idle = 0%**（主线程打满 40+ 秒）。真实瓶颈比报告写的重，且 (program) 这块最大的「未知项」没有被归因。
   - **「每-delta Vue 重渲染 10.5s（12.7%）是 #1、v-memo 是 P0」是误归因**：UserBubble + TurnSummary + TurnMeta 三个组件 render 的 **inclusive** 时间合计 2.6s（流式窗 4.1%），而 MessageStream 自身 render 的 5.7s 里 **≈4.5s 是 O(n²) 字符串派生**（`railMemoFor` → `summarizeAssistantForRail` 与 `turnPreview` → `previewText`，含被模块聚合漏掉的 regex self-time）——报告把它们记成 2.37s + 0.80s，实际 ≈ 4.5s（7.2%），且这块 **dev/prod 同量级**，Vue patch 在 prod 会缩水——**prod 排名第一位大概率是这块 O(n²) 派生而不是 Vue patch**。
3. **20 项方案里，至少 4 项按报告写法是无效或反向的**：CPU-1.3「微任务合帧」是被 2026-09-25 删掉的 delta-coalescer 的复活（当时实测 242 delta 批大小恒 1、merged=0，报告在同一段引用了这个事实却没意识到它否定了自己的方案）；CPU-7「EdgeFade 常量提取」对症的成本是 `scrollTop` 读取引发的**强制同步布局**（2.5ms/次），字符串拼接是纳秒级；CPU-8.1「.gitignore 按 mtime 缓存」**推翻了一条在册裁决**（缓存治理 U1 1-2 明确删除了该缓存）；CPU-6.2「DOMPurify 快速通道」的判据（输入零 HTML 标签）对 markdown-it 的输出永远不成立，且上限收益 <1%。
4. **测量本身有未披露的混杂**：全部运行期间打包版 TaiJi.app 一直在跑（审查时其 GPU helper 64% CPU / renderer 44%，uptime 23h 覆盖所有采集）；dev 实例 `showInactive` 后台窗口（「空闲 36fps」基线就可疑）；三进程数据来自 **4 次相隔 2 小时的不同运行**；流式实际时长 48–85s 不等（faux 的 setTimeout 配速受事件循环影响），「65s 窗」并非固定；`Performance.getMetrics` 采样因未 `Performance.enable` 全部为空、`top` 采样的 pid 是死 pid（全程 0.0%）；A.2 对照数据集 `run2c-renderer.cpuprofile` 与其他 7 个原始文件**没有归档**（只在 `/tmp`）。
5. **报告漏掉了数据里最大的两个用户可感知项**：① pi 冷启动 **20+ 秒 CPU 满载**（jiti 4.7s + statSync 4.1s + `NodeError` 0.7s（jiti 的模块解析失败类错误对象构造，疑似 ENOENT 风暴）…，日志 `restore elapsed=20443ms`）被当「启动期」切掉；② 流式中段 fence 闭合瞬间 **1.2–3.3s 主线程冻结**（shiki 同步高亮，发生在全文 60% 处而非报告说的「回答完成瞬间」）。

---

## A. 方法论审查

### A1. 采集窗口是否覆盖了宣称的场景？——覆盖了，但窗口结构与报告描述不符

对权威数据集 `run-notrace-renderer.cpuprofile`（82.70s）做逐 5s 直方图（`timeline.mjs`）：

| profile 相对时间 | idle | (program) | JS busy | 关键函数 | 判读 |
|---|---|---|---|---|---|
| +0..10s | 71–100% | 27%（首 1.3s 为 Profiler.start 的大 delta） | 0 | — | 空闲（session restore / 等待） |
| +10..50s（阶段 A） | 55–68% | 8–12% | 24–34% | truncate/stripMarkdown/previewText 从 0 **线性**增长到 ~0.09/5s；scrollTo ~0.2/5s；sync ≈ 0.0001/s；DOMPurify.sanitize ≈ 0 | **流式前 ~60%**：fence 未闭合，代码块只是一行 `typescript` 占位，**DOM 很小**；成本主要是对全文的 O(n) 派生 + 跟底 scrollTo |
| +50..55s | 21% | 4% | 74% | findNextMatchSync 1.16s（shiki） | **fence 闭合 → 600 行代码块一次性高亮 + 物化** |
| +55..80s（阶段 B） | **0–1%** | **19–41%** | 57–80% | truncate/stripMarkdown/previewText **跳到 ~0.2/5s 且持平**；sync 0.08–0.28/5s；DOMPurify 出现 | **流式后 40%**：DOM 变大（高亮代码块进前缀缓存），(program) 翻 3 倍 |
| +80..82.7s | 100% | 0 | 0 | — | 流结束 |

证据链：session 文件 `~/.taiji-dev/verify-prof-20261123-1730/agent/sessions/--Users-...--/2026-11-23T10-29-08-645Z_01a207f3-….jsonl`：user 18:30:18.198 → assistant 定稿 18:31:23.259（45,326 字符，输出 11,412 token）⇒ 流式 ≈ +10s..+73s（**53s，不是 65s**）；faux 的切块是 4–12 字符/块 + `setTimeout` 配速（`pi-ai/dist/providers/faux.js:151-162, 207-213`），实际速率受事件循环影响——四次运行流式时长分别 ≈ 53s（notrace）/ 74s+（run2d）/ 48s（run2e）/ 155s+（run2c），**「65s 窗」不是可复现常数**，所有「每 65s」归一化都失真。

截图 `run-notrace-midstream.png`（+40s）印证：视口里只有一段重复段落 + 一个 `typescript` 流式占位；**滚动条在轨道中段**（thumb 占 css y 200–528，轨道 36–678），占位之下有空白——贴底跟随**并不处于收敛态**（与日志 18:31:25 `[pin-bottom-guard] 贴底态跟随未收敛：gap=29.5px > 阈值 4px` 一致）。滚动相关测量（scrollTo / sync / FPS）代表的不是「用户盯着底部看」的典型态。

**结论**：finalize（这里 = fence 闭合）与流式主体都在窗口内 ✓；但报告把两个性质完全不同的阶段（小 DOM + O(n²) 派生 vs 大 DOM + 强制布局/原生渲染）平均进一个 82.7s 分母，丢掉了全部结构信息。

### A2. dev 模式采集推 prod 结论是否恰当？——排名不可迁移，量级更不可

- **dev-only 成本**（prod 归零或大幅缩水）：vue-i18n 的 `performance.mark/measure`（0.93s）+ vue-i18n 模块 dev 路径（1.62s）；Vue dev 构建（`validateProps` 0.13s、`resolveTransitionProps`、`hasOwn`、devtools 钩子、未压缩字节码）；Vite client 对 **164 条 `ResizeObserver loop completed with undelivered notifications`** 的 WS 转发（`?@client:531`）；i18n 的 `friendlyJSONstringify`。
- **dev/prod 同量级**：summarize-turn/previewText 的 regex 与 `Array.from`（≈4.5s）、shiki（2.5s）、DOMPurify/markdown-it、原生 `scrollTo`/`scrollTop` 强制布局、(program)。
- 因此 prod 的排名大概率变为：**O(n²) 派生 #1 > 强制布局族 #2 > Vue patch #3**。报告把「v-memo」排 P0 第一位、把 summarize-turn 排第三，是 dev 火焰图的产物。CPU-5 自己承认 i18n 是 dev-only，却没有把同一逻辑推到「Vue 10.5s」上。

### A3. 「tracing 放大 5 倍」是否被 A.1 vs A.2 支持？——方向对，数字错一个数量级

| 口径 | A.1 notrace | A.2 run2c | 倍数 |
|---|---|---|---|
| mark + measure self 合计 | 0.628 + 0.303 = **0.93s** / 53s 流 | 58.63 + 5.26 = **63.9s** / ~155s 流 | **≈ 69×**（同一 fixture、同 delta 数） |
| 占非空闲样本份额 | 0.93 / 45.6 = 2.0% | 63.9 / 153.6 = **41.6%** | ≈ 21× |
| 占全窗份额 | 1.1% | 38.6% | ≈ 34× |

「5 倍」无法从 A.1/A.2 推出。另外 A.2 的窗口是 165.8s（流被拉长到 ~155s），且 **非 mark/measure 的纯 JS 也膨胀 ~2×**（stripMarkdown 1.14→2.47s、truncate 1.23→2.31s、previewText 0.80→1.89s——同样 5,600 次 delta 调用）——说明 tracing 扭曲的是整条管线而不只是 i18n 插桩；「CPU 火焰图不能与 tracing 同开」的纪律正确，但原因写得片面。A.2 数据集本身未归档（见 A9）。

### A4. pi 的流式窗切片（+53s）是否合理？——边界基本对，但切片尾部不干净、且隐藏了最大的 pi 成本

`timeline.mjs` 对 pi profile：+0..22s **95–100% busy**（jiti 4.74s / statSync 4.05s / stat 1.85s / parse 1.12s / readFileUtf8 0.84s / NodeError 0.72s / Script 0.52s = 扩展加载 + 解析风暴），+25..50s idle，+50..93s 流式（busy 1–4%），+95s `reallyExit` 0.52s。切片 +53s ✓ 落在流式内；但：① 切片含退出（reallyExit 0.62s 被算进「流式窗」1.47%）；② pi 在 +95.5s 被 stdin EOF 杀死，而流式到 ≈ +100s 才结束（renderer 侧 +58s 定稿，run2e 窗起点 = pi +42.6s）——**切掉了约 5s 流尾与 message_end/flush**，对「pi 空闲」结论无碍，但不是报告写的「42.52s 流式专属成本」。
③ **报告把 22 秒的 pi 冷启动 CPU 风暴整段当「启动期」丢弃**。dev-instance 日志 `[session-lifecycle] restore … elapsed=20443ms`、`restore-timing attach … switchSession=20209ms` 证明它直接落在用户首 token 路径上。这是数据里最大的单一用户可感知延迟，报告只字未提（prod 的 jiti 缓存行为需要另测，但 dev 的 23 个扩展 jiti 加载 + ENOENT 解析风暴就是 renderer 等待的原因）。

### A5. runtime 窗口是否干净？——不干净，且 CPU-8 的「事件型」定性错误

runtime profile 时间线：+10..15s 一个 **32% busy 的突发**（ruleMatchesPath 0.50 + readdir 0.37 + writev 0.13 + parseJsonl 0.05 = 全部 `.gitignore`/目录扫描成本），之后 +15..55s 仅 ~3%（writev 0.03–0.05/5s），+50..55s `spawn` 0.33s（pi 重生，与流式无关）。dev-instance4.log 显示 `send: type=prompt` 后紧跟 `.gitignore 读取/编译`，前两次 prompt 各触发 **两条**（行 279–280、352/356，同一文件重复编译），75s 窗内共 13 次——是 **prompt 路径触发的文件树 ignore 匹配**（同步 CPU ~0.9s 阻塞 runtime 事件循环 = 首 token 转发被顶后 ~0.9s），不是「文件变更/会话扫描」的偶发事件。报告的「事件型、与流式主链路无关」定性错误；它不在流式主链路上，但在 **TTFT 关键路径** 上。runtime 94.4% idle ✓。

### A6. GPU trace 覆盖范围——只有 33.67s，且是流式最轻的前 24 秒

`trace-main.mjs`：`run2d-renderer.trace.json` ts 跨度 **184315.85 → 184349.53 = 33.67s**（profile +0.44s..+34.1s）；run2e trace 27.56s；只有 run2c trace（1.8M 事件）是完整的 179.95s。报告写的「120.49s traced」是 `analyze-trace.mjs` 把**所有线程所有嵌套切片的 dur 求和**，不是墙钟。原因大概率是 `Tracing.start` 未指定 recordMode（默认 record-until-full，缓冲满即停）且脚本不处理 `Tracing.dataLossOccured`/`bufferUsage`。后果：

- GPU 榜的「65s 流式窗」分母错 2×；
- trace **没有覆盖** fence 闭合、shiki、阶段 B（大 DOM、idle=0%）——GPU 侧最重的部分没被采到；
- FPS 截图（+40s）落在 trace 窗之外。

### A7. 测量偏差：多实例 / 打包版并存 / 后台窗口

- 审查时 `ps`：`/Applications/TaiJi.app` 主进程 pid 29719 uptime 22h55m（覆盖 17:09–18:31 全部采集），GPU helper 64.2% CPU、renderer 44.3% CPU（本审查会话就跑在里面）。GPU trace 里的 `ApplyBackpressure`/`Present` 等待与 FPS 都受同一台机器上另一个 Electron 合成器 + WindowServer 竞争影响，**无法分离**。
- dev 实例 `TAIJI_DEV_BACKGROUND=1`（showInactive，不抢焦点）——窗口大概率被遮挡；Chromium 对 occluded 窗口会降帧，报告自己的「空闲 36fps」基线在 60Hz 屏上就是不正常的，说明 FPS overlay 的读数口径本身可疑。「40.2 vs 36 空闲」其实意味着**流式期帧率没有掉到空闲基线以下**，与报告「GPU 第二瓶颈」的叙事相反。
- `/tmp/taiji-prof/` 有 90 个 `CPU.*.cpuprofile`：`NODE_OPTIONS=--cpu-prof` 作用到了 vite / tsx 壳 / runtime / 准备脚本等全部 Node 子进程（含给渲染端供货的 vite dev server），有额外采样开销；dev-instance4/5.log 还显示 run2e 期间 `Debugger listening` 遍布各子进程（`--inspect` 曾被加进 NODE_OPTIONS，报告自己的复现指南已注明它会让 vite/rolldown 微任务死循环）；仓库根目录还遗留一个未跟踪的 `CPU.20261123.170400.22929.0.001.cpuprofile`（应删除）。
- `dev-instance5/6.log` 两次 SIGKILL 失败启动、`[pi-respawn] … pi process died unexpectedly`、`restore-timing switchSession=20209ms`：实例编排本身在测量期就不稳。

### A8. 跨进程「合计 TOP 10」实际是 4 次运行的拼盘

按各 profile 的 `startTime`（单调时钟，同 boot 原点）：run2c（renderer+tracing）17:38–17:45 → run2d（trace）17:45–17:48 → run2e（runtime + pi + renderer）17:48–17:53 → run-notrace（renderer 权威）18:30–18:31。三进程榜把相隔 ~40 分钟到 2 小时的样本当同一次测量；renderer 侧 run2d/run2e 的 profile（`/tmp/taiji-prof/run2d-renderer.cpuprofile`、`run2e-renderer.cpuprofile`）存在却未报告——它们的 shiki 突发是 3.15s / 3.26s，notrace 是 1.16s，说明**同场景跨运行差异本身就 ≥2.7×**，报告的 2.54s 是单次抽样。

### A9. 归档完整性与脚本缺陷

- §6 声称「全部证据已固化」，实际缺失：`run2c-renderer.cpuprofile`（A.2 数据源，3.6MB）、`run2d/run2e-renderer.cpuprofile`、`cpu-samples2.jsonl`、全部 `dev-instance*.log`、`run2e-renderer.trace.json`——只在 `/tmp`（会被回收）。
- `cdp-profile.mjs`：未调用 `Performance.enable` → `Performance.getMetrics` 返回空（`run-notrace-renderer-metrics.json` 全是 `metrics: {}`，这本是交叉验证主线程占用（TaskDuration/LayoutDuration）的最佳数据）；`WATCH_PIDS` 默认 `27580,28608,27561`，notrace 运行实际监视的是 pid 80082 且全程 0.0%（死 pid 或非 renderer）；`Overlay.setShowPaintRects` 参数错误；Tracing 无 recordMode / 无 dataLoss 处理；`analyze-trace.mjs` 的「total traced」口径错误。
- `faux-responses2.json`（18:49）与实际播种的 `~/.taiji-dev/verify-prof-20261123-1730/agent/faux-responses.json`（17:19）md5 不同（内容相等、字节差 43）——归档的是测量后被重新序列化的版本。

---

## B. 数字抽查（§2，≥6 项）

官方脚本 `node analyze-cpuprofile.mjs <file> N` 重跑 + 自写 inclusive/leaf 复算：

| 报告数字 | 复算 | 判定 |
|---|---|---|
| Vue 10.5s（12.7%） | 模块 self 10.495s ✓ | 数字对，**归因错**：这是 vue.runtime 全部 self（含响应式/scheduler/transition/dev 校验），不是「每-delta patch」；组件 render inclusive：UserBubble 1.26s、TurnSummary 1.14s、TurnMeta 0.19s、Turn 0.62s、TextRow 0.24s、MarkdownRenderer 0.36s；`componentUpdateFn` inclusive 17.36s（27.6% 流式窗）里 **5.7s 是 MessageStream 自己的 render，其中 ≈4.5s 是 O(n²) 字符串派生** |
| scrollTo 2.21s | 2.211s ✓ | 数字对，**归因错**：调用链 `scrollTo ← z@virtua_vue.js:391 ← a ← Z ← oe ← (root)`（virtua rAF flush 内的原生 scrollTo），virtua_vue 模块 self 仅 0.377s——2.2s 是**原生滚动触发的强制布局**，不是「virtua 内部 offset 查算 + 估算收敛」 |
| shiki 2.54s | findNextMatchSync 1.257 + #execCore 0.561 + shiki_core 0.722 = 2.54 ✓；但模块合计 shiki_engine_javascript 2.239 + shiki_core 0.722 = **2.96s** | 少算 0.42s；且是单次抽样（run2d 3.15s / run2e 3.26s） |
| i18n 1.62s | vue-i18n 模块 1.617 ✓；另 mark 0.628 + measure 0.303 在 `(none)` | 表头写「含 mark/measure 插桩」但数字不含，实际 2.55s |
| summarize-turn 2.37s | truncate 1.227 + stripMarkdown 1.138 = 2.365 ✓；但 stripMarkdown 的 regex self 在 `(none)`：`^\s*([-*_])\1{2,}\s*$` 0.199、`` `([^`]+)` `` 0.168、`^[-*+]\s+` 0.141、`^\d+\.\s+` 0.085、链接两条 0.146… ≈ +0.9s → **≈3.3s** | 报告 §4 自己写 3.2s，§2 写 2.37s——**同一报告两个口径** |
| previewText 0.80s | 0.800 ✓；但其 `RegExp: \s+`（0.781s，与 stripMarkdown 末行共用）在 `(none)` | 实际 ≈1.4–1.6s |
| EdgeFade.sync 0.86s / 339 次 | 0.860 ✓，339 hits → **2.5ms/次** | 字符串拼接不可能 2.5ms；0.701s 集中在 +55..80s（阶段 B），阶段 A 几乎为 0 |
| runtime 0.5s / 0.85s | writev 0.386 + publish 0.028 + handleMessage 0.025 + parseJsonl 0.05 ≈ 0.5 ✓；ruleMatchesPath 0.503 + allPrefixes 0.077 + readdir 0.258+0.111 + file-service 0.179 ≈ 1.1s | ✓；但 0.85/1.1s 是 +10..15s **单次突发** |
| pi 0.28s | runAgentLoop 0.150 + createContext 0.043 + emit 0.030 + serializeJsonLine 0.037 + streamWithDeltas … ≈ 0.28 ✓ | ✓；切片含 reallyExit 0.62s；漏掉 +0..22s 启动风暴 |
| backpressure 22.67s | ApplyBackpressure 11.35s，其内嵌 `::GL` 11.32s；两者整段嵌在 Present（12.01s）内 | **双重计数 + 语义反了**（等待 ≠ 积压工作） |
| Present 12.02s | 12.01s / 658 次（+10..34s）= 27.4 次/s，avg 18.26ms，p50 16.93ms，p95 47.3ms | 与 #1 是同一段 12s |
| raster 12.1s（含嵌套 15.7s） | Raster 类切片全在 CrGpuMain（OOP-R 在 GPU 主线程）：sum 15.56s，**union 5.88s** | 实 5.9s；「11451 次」✓ |
| 帧率 40.2 / 31.2 / 36 | 截图 40.2 ✓；trace 内 Present 27.4/s、BeginMainFrame 15.6/s、`ws.onmessage` FunctionCall 47.5/s、FireAnimationFrame 44/s（**每帧 3 个 FireAnimationFrame**，367 帧中 337 帧如此） | 几套帧率口径互不一致，未解释 |
| GPU 总账「≈71s 饱和」 | GPU 主线程顶层切片 union 22.88s / 33.67s = 68%；其中 Present（等待为主）12.0s → 真实工作 ≈ **10.85s（32%）** | 不成立 |

---

## C. 归因审查

### C1. GPU slice → 功能归因

- **ApplyBackpressure ≠ 「帧生产快于显示的积压」**：`CALayerTreeCoordinator::ApplyBackpressure::GL` 是 GPU 主线程阻塞等待上一帧被显示（p50 16.0ms = 一个 vsync）。它出现说明 GPU 在**等显示**，是 vsync 节流的正常形态；把它记为「饱和运行」是把 sleep 记成 work。真正的 GPU 主线程工作（raster 5.9s + 命令缓冲/绘制 ≈ 5s）占窗 32%。
- **Present 12.02s 与 #1 是同一 12 秒**（660 次 Present ↔ 660 次 ApplyBackpressure::GL，一一嵌套）——榜上 #1/#2 重复计分。
- **「raster = 文本增量失效 + 代码块 + blur backdrop」无证据**：trace 只覆盖 fence 闭合前（占位期，DOM 很小），代码块根本没物化；`Layerize` 0.83s 是整个窗的全部层化成本，无法从中分出 blur。GPU-6/7 对 EdgeFade 的 GPU 归因在本次数据里**不可证**。
- **「(idle)/(program)」**：报告对 (program) 13.1s 零解释。它在 V8 profile 里是 `(root)` 的直接子节点（`node-parents.mjs`：distinct chains = 1），即 **采样时栈上没有任何 JS 帧、VM 状态又不是 IDLE/GC** 的样本——在 renderer 主线程上对应「非 JS 的原生工作 / 嵌入器调 V8 API」；它随阶段 B（大 DOM）从 10% 跳到 34–41%，与原生渲染/布局工作量同步变化，而 trace 侧 `devtools.timeline` 只能解释主线程 6.81s/33.67s（20%），说明 **V8 CPU profile 既看不到 Blink 布局/绘制（在 (idle) 或 (program) 里），trace 的 timeline 类别也没开全**——两套工具都没覆盖主线程原生渲染这一大块。(program) 应在报告中显式登记为「未归因的 16%（阶段 B 34–41%）」而不是从占用率里抹掉。

### C2. UserBubble 每 delta 重渲染的根因——诊断正确，但量级与解法都有更优

- 机制核实 ✓：`Turn.vue:50-56` 把 `:turn="turn"` 整对象传给 `UserBubble`；`message.text_delta` → `updateStreamingAssistant`（`registry.ts:209-225`）每 delta 产生新 assistant 对象 → `commitMessages` 新数组 → `toRenderItemsIncremental` 重建末位 turn（新引用）→ MessageStream 重渲 → Turn 重渲 → UserBubble 因 `turn` 引用变化重渲。`v-memo` 只挂在 `traceUnits` 的 v-for 上（`Turn.vue:208-212`）。
- 但 **`turn.user` 的引用是稳定的**：`message-turns.ts:673/942` `user: g.user`——D-4 增量缓存按成员引用复用，重建的 turn 对象里 `user` 是同一个 Message 对象。UserBubble 实际只读 `turn.user`（content/id/timestamp）+ `turn.index` 兜底 + `turnStableId(turn)`（有 user 时恒 = user.id）。**把 prop 改成 `:user="turn.user"`（+ sessionId/canEdit/isSessionEditable 三个标量）即可让 `shouldUpdateComponent` 直接跳过整个组件更新**（连 render 都不跑），不需要 v-memo 的 deps 簿记。同理 TurnSummary 只需要 `lastAssistant.id` + `turn.isStreaming` + `turn.index`（复制正文可在点击时按 id 取）。TurnMeta 的 render 本来就被 `elapsed` 每 tick 驱动，0.19s，不值得 memo。
- 量级：UserBubble inclusive 1.26s / 63s = **2.0%**（dev，含 i18n dev 插桩），不是「12.7% 的主体」。

### C3. summarize-turn / previewText 的真实调用链（报告写成了「rail 摘要 + 预览摘要」）

- `truncate ← summarizeAssistantForRail ← railMemoFor@rail-turn-memo.ts:12 ← lastTurnProjectionUnchanged@useMessageStreamRail.ts:77 ← computed ← MessageStream render`。`railMemoFor` 是 **WeakMap< MessageTurn >**，流式 turn 每 delta 新引用 → 每 delta miss → 全文 19 遍 regex + `Array.from` 全文——而它的目的只是判断「rail 可见派生视图变没变」以避免 TurnRail 重渲。rail 摘要 = 前 20 个码点，**在流开始 1–2 秒后就永远不再变化**，却每 delta 重算一次 O(n)。
- `previewText ← turnPreview ← buildStreamViewItems ← MessageStream render`：`turnPreview` 先试 `previewText(turn.user?.content)`，但 live 态 user content 是 `Segment[]`（非 string）→ 返回 '' → **回落到 assistant 全文**（45K 字符 `\s+` 全文替换）。而 `preview` 字段的唯一消费点是 `StreamItemBoundary`（`MessageStream.vue:121`）的 **broken/failed 占位行**（`stream-view-items.ts` 头注释原话：「preview 唯一消费点是 broken/failed 占位行，正常渲染零消费」）——**每 delta 为一个从不显示的占位符付 O(n)**。`canReuseView` 只救了历史项，救不了流式项。

### C4. shiki 2.5s 发生在哪一刻——fence 闭合，不是 complete

调用链：`findNextMatchSync … codeToHtml ← highlightShikiSync@markdown.ts:202 ← md.renderer.rules.fence@markdown.ts:251 ← renderMarkdown@markdown.ts:590 ← (root)`；时间线：+50..55s（全文 60% 处，fixture 第 5–605 行的 fence 闭合时 `advancePrefixCache` 把 600 行代码块纳入稳定前缀并同步高亮），+73s（complete）处**没有**任何 shiki。报告 CPU-2 的「消息 complete 帧同步跑、集中在回答完成瞬间」机制描述错误——这是 **流式中途的 1.2–3.3s 冻结**（用户正盯着文字流），比完成瞬间的卡顿更糟。

### C5. EdgeFade.sync / scrollTo 的 self-time 是强制布局

- `EdgeFade.vue:45-53`：`scroller.scrollTop` 读（scroll 事件回调里，此刻 DOM 刚被 delta 改脏）→ 强制同步布局；`scrollTop` getter 在 profile 里没有独立帧，成本并入 `sync` self → 2.5ms/次。`sync` 的父节点是 `(root)`（事件监听器），阶段 B 0.70s、阶段 A ≈ 0。
- `scrollTo` 同理（原生滚动前强制布局）。两项合计 ≈ 2.5–2.7s ≈ 流式窗 4%，是 **layout thrash** 问题，不是 virtua 算术或字符串拼接问题。164 条 `ResizeObserver loop` 错误/run 是同一病灶的另一个症状（RO 回调内改布局 → 再触发布局 → RO 循环）。

### C6. 非对话流常驻项（composer/侧栏/rail）在流式期的占比——可忽略

inclusive：Sidebar 0.002s、SessionList 0.001s、ActivityStrip 0.002s、PanelHeader ≈0、SessionItemDisplay 0.002s、TurnRail 0.061s。ADR-0049 的分区隔离让它们不吃 delta，报告没提，但这是好消息，应登记为「已验证非问题」。

### C7. MarkdownRenderer 的 content watch 是否已组件级 memo——是

`useMarkdownStreaming.ts`：`watch(() => props.content, scheduleRender)` → rAF trailing + latest-wins 串行 + D-5 前缀缓存。markdown 渲染这块（真正贵的）**已经按帧合帧**，报告 CPU-1.3 想在 store 层再做一次「合帧」是对已完成工作的重复。

---

## D. 优化方案审查（§3，20 项）

### D0. 一览表

| 项 | 报告定性 | 审查判定 | 一句话理由 |
|---|---|---|---|
| CPU-1.1/1.2 UserBubble/TurnMeta/TurnSummary v-memo | P0 低风险 | **改方案**：deps 不全会出陈旧 UI（见 D2）；用稳定引用 props 替代 | 收益 2%（dev）；deps 漏 edit 态/copy 反馈/revoke 置灰/locale/density |
| CPU-1.3 store 微任务合帧 | P1 需等价性测试 | **删除**：同宏任务批大小恒 1（commit 4d5ad2270 实测删除的正是这个机制） | 无物可合；跨宏任务合帧 = 动 store 真相时序，需 barrier 排空 |
| CPU-2 shiki 分帧 + 可视区优先 | P1 | **改方案**：目标改为 fence 闭合时刻；单块无法「分帧」除非按行 yield；更优 = Worker 高亮 | 机制时刻写错；virtua 虚拟化粒度是 turn 不是行 |
| CPU-3 截断前置 / 早退 / 分桶缓存 | P0 | **部分采纳**：早退 + 码点级 early-exit ✓；「先截 200 再剥」有反例（见 D1）；分桶缓存多余 | rail 20 字符的前缀依赖只在 fence/link/emphasis 跨切点时破 |
| CPU-4 高度增量预测 / align:'end' 快路径 | P1 风险中 | **删除**：对症成本是原生强制布局；`scrollHeight - clientHeight` 同样强制布局；virtua 是登记的单一 scrollTop owner | virtua self 仅 0.38s |
| CPU-5 i18n 不优化 | 不动作 | ✓ 同意；但要把「dev 扭曲」推广到整个 Vue 榜 | — |
| CPU-6.1 tail 稳定行二分 | P2 | **降级**：阶段 A tail 是占位（DOMPurify ≈0），阶段 B DOMPurify 全部 0.5s | 上限 <1% |
| CPU-6.2 DOMPurify 快速通道 | 需安全评审 | **拒绝**（见 D5） | 判据不可满足 / 收益 <1% / 违反「整串 DOM 往返唯一净化点」契约 |
| CPU-7.1 mask 串常量提取 | P1 极低风险 | ✓ 等价（常量确认），**收益 ≈ 0** | self 是强制布局 |
| CPU-7.2 / GPU-6.1 / GPU-10.1 「流式期自动降档/短路」 | P1 | **谨慎**：引入「session 有 streaming turn」全局模式耦合 + 流起止的视觉跳变 | 先有干净的 GPU 测量再谈 |
| CPU-8.1 .gitignore mtime 缓存 | P2 低风险 | **拒绝**：推翻在册裁决（`file-service.ts:503-507` 缓存治理 U1 1-2）；成本是 prompt 路径一次性 0.9s 同步块 | 更优：不在 prompt 路径做全树 ignore 匹配 / 至少去重每次 prompt 的两次编译 |
| CPU-8.2 readdir 短缓存 | P2 | 同上，时间窗缓存 = 时间平抑红线候选 | — |
| CPU-9 previewText 先截后压 | P0 极低风险 | **改方案**：懒计算（占位行才需要）→ 零成本、零语义变化 | 先截后压可行但没必要 |
| CPU-10 runtime 转发链 | 不优化 | ✓ | — |
| GPU-1/2/4/5/9 「随合帧联动」 | P0/P1 | **前提不成立**（GPU 未饱和、合帧无效）；GPU-2 的 opacity:0 层排查可做 | — |
| GPU-3 缩小 tail 失效区 | P1 | 随 CPU-6.1 降级 | — |
| GPU-6.2/6.3 blur 改静态/减层 | 需设计走查 | 视觉决策，数据不支持现在动 | — |
| GPU-7 mask 下沉到 40px 覆盖层 | P1 | 视觉/结构改动，数据不支持（trace 没采到大 DOM 阶段） | — |
| GPU-8 followThink 改 rAF | P1 | **改方案**：rAF 回调在布局前运行，读 scrollHeight 仍强制布局；零强制的位置是 RO 回调（布局后） | 本场景 thinking 仅 318 字符 ≈ 40 delta，此项**未被测量** |
| GPU-10.2/10.3 text-sweep 改 transform / tick 对齐 rAF | P2 | 合理但未测量 | — |

### D1. 「截断前置」的语义正确性（CPU-3 / CPU-9）

**stripMarkdown 的 19 条规则里哪些是「局部」的**：标题/引用/列表/hr 的 `^…` 多行锚、单行内强调、`\s+` 压平——前 20 个码点的输出只依赖有界前缀 ✓。**非局部的**：① ```` /```[\s\S]*?```/ ````（开 fence 一直吃到下一个闭 fence）；② `` `([^`]+)` ``（孤立反引号与之后任意位置的反引号配对）；③ 链接 `\[([^\]]*)\]\([^)]*\)`（`[^\]]*` 可跨行）；④ 跨切点的 `**…**`。

**反例（先 `truncate(raw, 200)` 再 strip ≠ 先 strip 再 truncate）**：
1. **代码块开头的消息**：```` ```ts\nexport function foo() {\n …600 行… ``` ````。现状终态 rail = `export function foo() {…`（闭合后 ```` /```[^\n]*\n?/ ```` 删掉 fence 行）；截断前置后切点落在块内、无闭合 → 外层规则不命中 → rail = ```` ```ts export function foo… ```` **永久**带反引号。现状在 fence 未闭合的流式期本来也显示 ```` ```ts export… ````（瞬时瑕疵），截断前置把它变成永久。
2. 长链接文本 `[很×150](https://…)`：切点在 `[]` 内 → 链接规则不命中 → rail 显示 `[很很很…`。
3. 跨切点的 `**……**` / `` `…… ` ``：星号/反引号泄漏到标签。
4. **代理对**：`text.slice(0, 200)` 是 UTF-16 切分，可能切在代理对中间 → 末尾孤立代理。对 rail（MAX=20 < 200）无害（最终 20 码点截断把它丢掉）；但 CPU-9 的**第二次** `slice(0, PREVIEW_MAX_CHARS)` 同样是 UTF-16 切分 → 预览末尾可能输出 `�`。这是**现状代码已有的缺陷**（`flat.slice(0, 120)`），不是回归，但改造时应顺手改成码点迭代。
5. `previewText` 先切后压：前 2N 字符若含大量空白（代码缩进/表格对齐/连续空行），压平后 < N → 预览比现状短。对「占位诊断行」确实不敏感 ✓——但更好的结论是「它根本不该每 delta 算」。

**「truncate UTF-16 长度早退」**：`text.length <= maxChars ⇒ 码点数 ≤ maxChars` 成立（UTF-16 长度 ≥ 码点数），逻辑正确；但热路径里 text 永远 ≫ 20，**早退永不命中**。真正有效的是「只迭代到 maxChars 个码点」（`for (const ch of text) { …; if (++n >= maxChars) break }`，V8 字符串迭代器惰性，O(maxChars)），替代 `Array.from(text)` 的全量分配。

**更优解（零语义风险或语义可声明）**：
- rail：`railMemoFor` 对**流式 turn**按 `(assistant.id)` 记忆「上次摘要 + 计算时的 content 长度」，当 `content.length ≥ K`（如 256）且 id 相同 → 直接复用（事件驱动、纯数据判据、无时间量）；同时把 fence 行改为**无条件剥离**（顺手修掉现状流式期 ```` ```ts ```` 泄漏）。这样 rail 的成本从 O(n)/delta 降到 0，且终态标签与现状一致（只要前 K 字符内 fence 已闭合；不闭合时与现状流式期一致）。
- preview：`StreamViewItem.preview` 改为惰性（传 `() => string` 或让 `StreamItemBoundary` 在失败路径按 `item.turn` 现算）→ 每 delta **零成本、零语义变化**。

### D2. v-memo deps 是否充分——不充分，会出三类可见 bug

`UserBubble.vue` 模板在 render 期读取的响应式量：`isEditingThisUser`（根分支 v-if）、`isRevokeDisabled`（= `chatViewDeps.isActive(sessionId)`，**流开始/结束翻转**）、`copied`、`isVidView`（sessionId）、`density`、`t()`（locale）、`canEdit`、`isSessionEditable`、`turn.user`。报告的 `[turn.user?.id, canEdit, isSessionEditable]` 漏掉前六项：
- 点「编辑」→ `editingUserId` 置位 → render 跑、memo 命中 → **编辑态永远不出现**；
- 点「复制」→ 无对勾反馈；
- 流开始 → 撤回按钮**不置灰**（`onRevokeClick` 的 computed 守卫仍生效，只是视觉与 tooltip 陈旧）。
- locale / density 切换 → 旧文案旧类串。

`TurnSummary` 同款问题：`speakDisabled = turn.isStreaming`、`speakStateOf(msg.id)`、`isHandingOff`、`copied`、`summaryText`——`unitMemoDeps` 的六个 deps 一个都不覆盖。**用稳定引用 props（C2 方案）不存在这类簿记**。

### D3. delta 微任务合帧——无效，且跨宏任务版本有正确性风险

- 报告同段写「delta-coalescer 已删（真机 242 delta 批大小恒 1）」——这正是 `4d5ad2270`（2026-09-25）删除它的理由：**每条 WS 消息是独立宏任务，微任务在 delta 之间排空，合帧窗永远不开（merged=0）**。`useChat.ts:856` 注释保留着这条结论。按报告写法 `queueMicrotask` 收集「同宏任务内到达的多个 delta」= 收集 1 个。Vue 本身已按宏任务批处理响应式更新。
- 若升级为 rAF 对齐的跨宏任务合帧（唯一真能减少 commit 次数的形态）：store 是真相源（ADR-0122 ③），会引入 ① **barrier 排空义务**：`message_end`/`tool_execution_start`/`complete`/`abort` 等非 delta 事件必须先排空缓冲再处理，否则 `updateStreamingAssistant` 的 `isLastAssistantStreaming` 守卫和 D-010 sealed 守卫（「finalizeSession 后晚到 delta 幂等丢弃」）会把缓冲的 delta **静默丢弃**；② 同步读者（sidebar 标题派生、user-delivery 回执、subagent seq buffer、copy）读到滞后一帧的状态；③ `apply-entry-equivalence` 只比终态，不会抓到 ①②。
- 更保守的替代：**不动 store**。贵的部分（markdown）已在 MarkdownRenderer rAF 合帧；剩余每 delta 成本用 D1/D2 的「有界派生 + 稳定引用 props」消除。

### D4. EdgeFade 常量提取——等价性成立，收益 ≈ 0

`FADE_BAND_HEIGHT=40`、`MASK_STOP_SOFT=0.325`、`MASK_STOP_FIRM=0.65` 都是模块级 `const`（`EdgeFade.vue:40-43`），mask 串确实是 `active` 的纯函数，`active = scrollTop > 4 && !reducedTransparency` ✓。提升为两个常量完全等价——但 0.86s 不是字符串，是 `scroller.scrollTop` 的强制布局。真正的修法：**不在 scroll 回调里读几何量**——用 `IntersectionObserver` 盯一个贴顶哨兵元素（或 RO）翻转 `on`，mask 串按 `on` 切换常量；`on.value` 已经只在翻转时触发重渲。

### D5. DOMPurify 快速通道——安全边界说不通

- 净化输入是 **markdown-it 的输出**（`html:true`），纯文本段也至少是 `<p>…</p>`——「零 HTML 标记输入」在 markdown-it 输出上**永不成立**；若改定义为「源文本不含 `<`」，则逻辑上成立（用户 HTML 只能经 `<` 进入；实体解码后再转义），但：
  1. 跳过 `DOMPurify.sanitize` 就跳过了 `afterSanitizeAttributes` hook（`markdown-sanitize.ts`：`target=_blank`+`rel=noopener` 补齐、img 相对 src 重写）——必须在 markdown-it 规则层复刻，等于把安全/行为契约挪到第二处；
  2. 违反 `markdown-sanitize.ts` 头注释登记的「用户段整串 DOM 往返 = 唯一净化点（mXSS 防御）」契约与 AGENTS.md「禁止向用户白名单放宽」纪律的精神（虽然技术上不是放宽白名单）；
  3. **收益上限**：DOMPurify 模块 0.48s + parseFromString 0.08 + createHTML 0.02 ≈ 0.6s / 63s ≈ **0.9%**，且阶段 A 为 0。
- 判定：**过度设计**，P2 也不该排。

### D6. shiki 分帧、滚动预测、blur 降档——风险与更优

- **shiki**：单块 600 行在一次 `codeToHtml` 内按行 tokenize，分「块」分帧对单块无效；按行 yield 需要改 shiki 调用方式（`codeToTokensBase` 不暴露增量接口）。更优：**Web Worker 高亮**（shiki 支持在 worker 运行；结果 HTML 回填；CSP 需放行 worker，WASM 已在 CSP 内），主线程零成本、与块大小无关；「可视区优先」在 virtua（turn 粒度）下没有意义，属过度设计。
- **滚动预测**：见 C5/D0。`scrollHeight - clientHeight` 读与 `scrollTo` 一样强制布局；高度预测还会与 virtua 的实测收敛互相打架。应保持 virtua 单 owner，把跟底的读/写挪到 RO 回调（布局后、绘制前，零强制），并**先修 pin-bottom gap=29.5px 的不收敛**（它既是正确性问题也是额外滚动工作的来源）。
- **blur 降档 / mask 下沉**：视觉决策。本次 GPU 数据没有采到大 DOM 阶段（A6），无法证明 blur 是 raster 的大头；「session 有 streaming turn 时自动启用 reduced-transparency 路径」会把一个**全局模式开关联到 session 状态**（split mode 多实例时语义不清）并在流起止引入视觉跳变。建议：先按 F 节复测清单拿到干净 GPU 数据，再决定。

### D7. 过度设计 / 无效项清单

CPU-1.3（无效）、CPU-4.1/4.2（对症错误）、CPU-6.2（<1%、契约冲突）、CPU-7.1（≈0 收益，可顺手做但别记成 P1）、CPU-8.1/8.2（推翻裁决 + 时间窗缓存）、CPU-3.3 分桶缓存（前缀有界后多余）、CPU-2.2 可视区优先（粒度不匹配）、GPU-1/2/4/5/9（前提不成立）、GPU-6.1/7.2/10.1 三处「流式自动降档」开关（模式耦合）。

### D8. 报告遗漏的更高杠杆项（按收益/风险）

1. **O(n²) 派生的两个零风险修法**（D1）：preview 懒计算 + rail 前缀有界 → 流式窗 ≈ **−7%** 主线程，dev/prod 同收益，无视觉变化（rail 仅修掉流式期 ```` ``` ```` 泄漏）。
2. **稳定引用 props 取代 v-memo**（C2/D2）：Turn → UserBubble/TurnSummary 传 `turn.user`/`lastAssistant.id` + 标量 → 组件更新整体跳过；无 deps 簿记、无陈旧态风险。
3. **pi 冷启动 20s CPU 风暴**（A4③）：数据里最大的用户可感知延迟，报告未列。排查方向：jiti 转译缓存是否命中、`NodeError` 0.72s（解析失败类错误对象，疑似 ENOENT 风暴）的来源、23 个扩展的 stat 风暴、prod 是否同样。
4. **fence 闭合冻结 1.2–3.3s**（C4/D6）：Worker 高亮。
5. **强制布局纪律**（C5）：EdgeFade 改 IntersectionObserver；跟底读写进 RO 回调；修 RO 循环（164 条/运行）；合计 ≈ −4%。
6. **prompt 路径的 runtime 0.9s 同步块**（A5）：不在 prompt 关键路径做全树 ignore 匹配，至少每次 prompt 两次编译去重 → TTFT。
7. **贴底跟随不收敛（gap 29.5px）**：正确性 bug，顺带减少滚动工作。
8. **测量基建修复**（A6–A9）：recordContinuously + dataLoss 处理；`Performance.enable`；正确 pid；完整归档；清理仓库根的 cpuprofile。

---

## E. 结论分级

### E1. must-fix（报告/方案本身必须先改，否则会误导实施）

| # | 发现 | 证据指针 |
|---|---|---|
| M1 | GPU「71s/65s 饱和」不成立：trace 墙钟 33.67s；ApplyBackpressure::GL 嵌在 ApplyBackpressure 内、后者整段嵌在 Present 内（660↔660）；backpressure p50 16.0ms = vsync 等待；GPU 主线程真实工作 ≈10.9s/33.67s | `trace-main.mjs` 输出；A6/B 表 |
| M2 | 「主线程 39%」口径：剔除 (program) 13.1s（15.9%，全文未解释）+ 用 82.7s 全窗稀释；流式窗 JS 45% / 非空闲 62%；阶段 B idle 0%（run2d 自 +40s 起连续 44s） | `timeline.mjs` notrace/run2d；`analyze-cpuprofile.mjs --rel-from 10 --rel-to 73` |
| M3 | CPU-1.3 微任务合帧 = 已删除 delta-coalescer 的复活，批大小恒 1 无物可合 | commit `4d5ad2270`；`useChat.ts:856` |
| M4 | CPU-7 / CPU-4 归因错：sync 2.5ms/次 = `scrollTop` 强制布局（父节点 (root)，getter 无独立帧）；scrollTo 2.2s 是原生滚动强制布局，virtua self 仅 0.38s | `EdgeFade.vue:47`；`node-parents.mjs scrollTo` 链 |
| M5 | CPU-3/CPU-9 少算 ≈40%（regex self 在 (none)）且调用链错位：实际 ≈4.5s（7.2%）全在 MessageStream render 内，经 `railMemoFor`（WeakMap 每 delta miss）与 `turnPreview`（Segment[] 回落 assistant 全文，产物从不显示） | `node-parents.mjs truncate`；`under.mjs MessageStream`；`stream-view-items.ts` 头注释；`MessageStream.vue:121` |
| M6 | CPU-2 机制时刻错：shiki 突发在 fence 闭合（+50..55s，全文 60%），complete（+73s）处为零 | `findNextMatchSync` 完整链 → `renderMarkdown@markdown.ts:590`；timeline |
| M7 | CPU-8.1 推翻在册裁决（.gitignore mtime 缓存已被「缓存治理 U1 1-2」删除）；成本实为 prompt 路径一次性 ~0.9s 同步块（首 token 路径），每次 prompt 重复编译两次 | `file-service.ts:503-507`；dev-instance4/7.log 行 279-280 |
| M8 | 测量混杂未披露：打包版 TaiJi.app 全程并存（GPU helper 64%/renderer 44%）；后台窗口；4 次运行拼盘（17:38/17:45/17:48/18:30）；流式 48–85s 不等；「5×」实为 ≈69×/流；run2c 等 7 个原始文件未归档；metrics 采样全空、top 采样死 pid | A3/A7/A8/A9 |
| M9 | v-memo deps 不全：漏 edit 态 / copy 反馈 / revoke 置灰（isActive 流起止翻转）/ vid / density / locale → 三类可见陈旧 UI | `UserBubble.vue` 模板读取清单（D2） |
| M10 | 同一报告两套口径：summarize-turn 2.37s（§2）vs 3.2s（§4）；i18n 1.62s 不含 mark/measure；shiki 2.54s 不含模块余量 0.42s | B 表 |

### E2. should-fix

| # | 发现 | 证据指针 |
|---|---|---|
| S1 | CPU-6.2 DOMPurify 快速通道应拒绝：判据对 md 输出不成立、跳过 hook、上限 0.9% | D5 |
| S2 | GPU-8 followThink 改 rAF 不消除强制布局（rAF 在布局前）；零强制的位置是 RO 回调；且本场景 thinking 仅 318 字符，此项未被测量 | `useProcessAggregate.ts:150-163` |
| S3 | GPU-6/7（EdgeFade blur/mask）在本次数据里不可证（trace 未覆盖大 DOM 阶段）；三处「流式自动降档」开关引入全局模式耦合与视觉跳变 | A6、D6 |
| S4 | fixture 形态极端：单个 600 行 fence 占全文 60% 字符 + 180 连续 bullet；缺「多小代码块 / 工具调用 / 重 thinking」形态；reasoning 模型的 thinking 跟底路径完全未测 | `faux-responses2.json` 结构（fence 行 5–605） |
| S5 | 164 条 `ResizeObserver loop` 错误/运行 = 布局抖动信号，未登记 | dev-instance7.log |
| S6 | pi 冷启动 20s CPU 风暴未入榜（restore elapsed=20443ms） | pi profile +0..22s；dev-instance7.log |
| S7 | 脚本修复：`Tracing.start` 加 `recordMode: "recordContinuously"` + 监听 `Tracing.dataLossOccured`；`Performance.enable`；`WATCH_PIDS` 动态解析；`analyze-trace.mjs` 用墙钟跨度与按线程 union；归档 `/tmp/taiji-prof` 全部文件；删除仓库根遗留 cpuprofile | A9 |
| S8 | 「先截 200 再剥」的反例必须用单测锁定（代码块开头消息 / 长链接 / 跨切点强调 / 代理对），或改为「前缀有界 + fence 行无条件剥离」 | D1 |
| S9 | CPU-8 的更优解：prompt 路径不触发全树 ignore 匹配（或异步化），而非缓存 | A5 |

### E3. nice-to-have

- N1 EdgeFade mask 串常量提取（等价、≈0 收益，顺手做）。
- N2 TurnSummary 的 `aiCopyKey = ai-${turn.index}` 用 index（M5 stable-key 已声明 index 不稳），改用 id。
- N3 `summarizeAssistantForRail` 流式期 ```` ```lang ```` 泄漏到 rail 标签（现状瑕疵，D1 方案顺手修）。
- N4 trace 里每 BeginMainFrame 有 3 个 FireAnimationFrame（3 个 frame view 各跑 rAF），值得查一下是否有 iframe/webview 在跑自己的 rAF 循环。
- N5 GPU-2 的「opacity:0 的 EdgeFade 层是否仍持合成层」可用 `chrome://tracing` 的 cc 层树直接看，成本很低。

---

## F. 更合理的优化建议 TOP 5（与报告方案冲突处已说明理由与权衡）

1. **把 O(n²) 派生改成零成本，而不是「先截后剥」**：`StreamViewItem.preview` 懒计算（只在 StreamItemBoundary 失败路径求值）；rail 摘要对流式 turn 按 message id 记忆、`content.length ≥ K` 后冻结，fence 行无条件剥离。流式窗 **≈ −7%** 主线程，dev/prod 同收益，零视觉变化（rail 只修掉瞬时泄漏）。与报告的权衡：放弃了「每 delta 重算 rail」这个本来就没有可观察收益的行为。
2. **稳定引用 props 取代 v-memo**：`Turn.vue` 向 UserBubble 传 `:user="turn.user"`（D-4 已保证稳定）+ 三个标量；TurnSummary 传 `lastAssistant.id`/`isStreaming`/`index`。`shouldUpdateComponent` 直接跳过更新——比 v-memo 更彻底（连 render 都不跑）且没有 deps 漏项的陈旧态风险（编辑态/复制反馈/撤回置灰/locale 全部天然正确）。收益：dev 下 UserBubble+TurnSummary 的 2.4s → ~0；prod 下按比例缩水但仍为正。
3. **fence 闭合的高亮移出主线程（Worker）**：这是流式中途 1.2–3.3s 的硬冻结（本次三测 1.16/3.15/3.26s），比「完成瞬间卡顿」更伤；分帧 tokenize 对单块无效、可视区优先粒度不匹配，Worker 是唯一与块大小无关的解。权衡：shiki 在 worker 的加载/内存与 CSP 放行需一次性评估。
4. **强制布局纪律 + 修跟底不收敛**：EdgeFade 的 `on` 改 IntersectionObserver 哨兵（scroll 回调零几何读）；跟底的 scrollTo/测量移入 RO 回调（布局后、绘制前）；修 `pin-bottom-guard gap=29.5px`；顺带消除 164 条/运行的 RO 循环。流式窗 **≈ −4%**，且是 dev/prod 同量级的原生成本。与报告的权衡：不做「高度增量预测」（会与 virtua 收敛互斗，且不解决强制布局）。
5. **把 pi 冷启动 20s 和 prompt 路径 0.9s 同步块纳入优化清单，并重做测量**：数据里用户最先感受到的是「发出消息后 20 秒才开始出字」，不是 40fps。重测清单：prod 构建（至少 `--mode production` 的 vite build 产物）；窗口前台可见、无其他 Electron 并存；同一运行内采齐三进程；Tracing `recordContinuously` + 跨越 fence 闭合与 complete；`Performance.enable` 后用 TaskDuration/LayoutDuration 交叉验证 (program)；补「多小代码块 + 工具调用 + 重 thinking」fixture。与报告的权衡：在拿到干净 GPU 数据之前，不动 EdgeFade blur/mask 的视觉（GPU-6/7）。

---

## 附录：复算命令（任意 cwd）

```bash
P=~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data
node $P/analyze-cpuprofile.mjs $P/run-notrace-renderer.cpuprofile 60                       # §2 CPU 复核
node $P/analyze-cpuprofile.mjs $P/run-notrace-renderer.cpuprofile 12 --rel-from 10 --rel-to 73  # 流式窗口径
node /tmp/review-scratch/timeline.mjs $P/run-notrace-renderer.cpuprofile 5 truncate stripMarkdown previewText scrollTo findNextMatchSync sync   # 两阶段结构
node /tmp/review-scratch/window-top.mjs $P/run-notrace-renderer.cpuprofile 12 48 56 76 40  # 阶段 A vs B 逐函数对比
node /tmp/review-scratch/inclusive.mjs $P/run-notrace-renderer.cpuprofile '_sfc_render|componentUpdateFn|flushJobs' 30 10 73   # 组件 render inclusive
node /tmp/review-scratch/under.mjs $P/run-notrace-renderer.cpuprofile '_sfc_render @ .*MessageStream' 16 10 73               # MessageStream render 的 leaf 分解
node /tmp/review-scratch/node-parents.mjs $P/run-notrace-renderer.cpuprofile truncate 8 10 73                                # railMemoFor 调用链
node /tmp/review-scratch/trace-main.mjs /tmp/taiji-prof/run2d-renderer.trace.json /tmp/taiji-prof/run2d-renderer.cpuprofile     # trace 线程/跨度
node /tmp/review-scratch/timeline.mjs $P/CPU.20261123.175042.55232.0.001.cpuprofile 5 runAgentLoop jiti statSync reallyExit   # pi 启动风暴
node /tmp/review-scratch/timeline.mjs $P/run2e-runtime.cpuprofile 5 ruleMatchesPath readdir spawn writev                           # runtime 突发位置
```
