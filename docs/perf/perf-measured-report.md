# taiji 对话流 CPU/GPU 占用实测报告（火焰图版）

> 分支 `feat-cpu-gpu-performance` · 2026-11-23 · 本文替代此前「代码推断版」结论——**推断 TOP 5 多项被证伪或重排**，以本报告实测数据为准。
> 场景：一个 session 的 assistant 消息正在流式吐字（faux LLM 驱动 72KB 长 markdown 回复，含 120 函数代码块 + 180 项无空行 bullet 列表 + 长段落，200 TPS，65 秒流式窗口，零 token）。

---

## 0. 实测方法与数据来源（全部可复现）

| 进程 | 采集方法 | 数据文件 |
|---|---|---|
| renderer（Chromium 主线程） | CDP `Profiler.start/stop`（`--remote-debugging-port=9478`），**无 tracing**（排除插桩放大） | `run-notrace-renderer.cpuprofile`（41187 samples / 82.7s 窗口） |
| renderer GPU/合成 | CDP `Tracing`（devtools.timeline+gpu+cc，15.3 万事件）+ FPS overlay 截图 + `chrome://gpu` 状态 | `run2d-renderer.trace.json`、`run2c/run2d/run-notrace-midstream.png` |
| runtime（Node/tsx） | inspector CDP `Profiler`（75s 窗口）+ `--cpu-prof` 全生命周期兜底 | `run2e-runtime.cpuprofile`（48189 samples / 75.35s） |
| pi 子进程（Bun 编译二进制） | mock-pi 规范置换为 node launcher（`--cpu-prof`，stdin EOF 优雅退出触发落盘） | `CPU.20261123.175042.55232.0.001.cpuprofile`（60608 samples / 95.5s，切出 42.5s 流式窗） |
| 瞬时 CPU | `top -l 1` 采样器（因进程生命周期问题仅部分命中，以 profile 为主） | `cpu-samples2.jsonl` |

**关键方法学教训**（写进复现指南）：
1. `Tracing` 开着采 CPU profile 会把 `performance.mark/measure` 类调用放大 ~5 倍且采样间隔变细——**CPU 火焰图绝不能与 tracing 同开**；
2. Bun 编译的 pi 不食 `NODE_OPTIONS`（SEA/Bun 形态），SIGUSR1 会直接杀死它——pi 的 profile 必须走「置换位 + node 包装器 + stdin EOF 优雅退出」；
3. runtime 经 tsx 启动时 `--cpu-prof` 的落盘时机不可靠（tsx 父壳提前退出会丢 profile），**inspector CDP Profiler 才是确定性手段**。

---

> **[REVISED 2026-11-23 深夜]** 本文经 GLM（route-2）对抗审查（完整报告：[adversarial-review-glm.md](adversarial-review-glm.md)），**三个最尖锐的结论被证伪**：
> ① 「GPU 71s/65s 饱和」不成立（trace 墙钟仅 33.67s、双重计数、backpressure 实为 vsync 等待，GPU 主线程真实工作约 32%）；
> ② 「主线程 39%」是口径产物（剔除未解释的 (program) 15.9% + 全窗稀释；流式窗 JS 45% / 非空闲 62%，且存在两阶段结构）；
> ③ 「Vue 重渲染 #1 / v-memo P0」是误归因（MessageStream render 内约 4.5s / 7.2% 是 O(n²) 字符串派生，prod 排名第一大概率是它）。
> **现行结论以 §1.2 修订版为准；§2 榜单数字保留原始抽样但须按 M10 口径修正阅读；§3 方案的处置以 §3.3 修订版路线图为准。**

## 1. 全局结论（先读这段）

1. **前端是唯一有持续负载的进程**：流式期 renderer 主线程 ~39% 占用（无 tracing 口径），帧率 40.2fps（tracing 开时掉到 31.2，空闲 36）。
2. **后端两个进程实测各 ~95% 空闲**：runtime 94.4% idle（整个消息转发链路 handleMessage→translate→publish→ws.send 合计 ~0.1s/75s ≈ 0.13% 单核）；pi 流式窗 94.4% idle（agent loop + 22 扩展 emit + stdout 序列化合计 ~0.28s/42.5s ≈ 0.7% 单核）。**此前推断的后端 TOP 1/2（扩展风扇出、tee+parse+stringify）方向真实但量级微不足道。**
3. **GPU/合成管线是第二瓶颈**：65s 流式窗内 GPU 侧 raster 12.5s + Present 12.0s + CALayer backpressure 22.7s + command buffer 17.6s ≈ **71s 饱和运行**；GPU 显存 18.4MB→48.9MB。
4. **最大可优化项在 renderer 的「每-delta 重渲染链」与「turn trace 派生」**，合计约占主线程 12%；其次是 shiki finalize（一次性 3%）与 GPU 合成（跨进程）。

---

## 1.2 修订版结论（对抗审查后，优先读这里）

1. **方向成立**：runtime / pi 实测约 94-95% 空闲（复算无误）；瓶颈在 renderer 主线程。
2. **GPU 不饱和**：trace 实际墙钟 33.67s（且只覆盖流式最轻的前 24s，未采到 fence 闭合与大 DOM 阶段）；ApplyBackpressure（11.35s）与 Present（12.01s）是同一段 12s 的嵌套（660 对 660 一一对应），backpressure p50=16ms 是等一个 vsync 的**限速等待**；GPU 主线程真实工作约 10.9s / 33.67s 约等于 **32%**。「GPU 第二瓶颈」叙事**推翻**。
3. **主线程占用口径**：流式窗（+10..73s，53s）JS 占用 **45%**、非空闲 **62%**；(program) 13.1s（15.9%）是未归因的原生工作（阶段 B 涨到 34-41%），必须显式登记而非抹掉。流式分两阶段：**阶段 A**（fence 未闭合，DOM 小）成本 = O(n²) 派生 + 跟底滚动；**阶段 B**（fence 闭合后，DOM 大）= 派生持平 + 强制布局 + 原生渲染，run2d 中 idle 连续 44s 为 0。
4. **真正的 #1 是 O(n²) 派生，不是 Vue patch**：MessageStream render inclusive 5.7s 中约 4.5s（流式窗 7.2%）是 `railMemoFor`（WeakMap 按 turn 引用，流式 turn 每 delta miss，于是全文 19 条 regex）+ `turnPreview`（user content 是 Segment[]，于是回落 45K assistant 全文；产物 preview 只供 broken 占位行、**从不显示**）。**dev/prod 同量级**，prod 排名第一大概率是它。Vue patch 10.5s 是 dev 构建全量 self，含大量 prod 会缩水的部分。
5. **两个被漏掉的用户可感知项**：① **pi 冷启动 20s CPU 风暴**（jiti 4.7s + statSync 4.1s + NodeError 0.7s，restore elapsed=20443ms，落在首 token 路径）；② **fence 闭合瞬间 1.2-3.3s 主线程冻结**（shiki 同步高亮，在全文 60% 处而非「回答完成瞬间」）。
6. **测量混杂**（结论须带此限制）：打包版 TaiJi.app 全程并存；dev 后台窗口；三进程数据是 4 次不同运行拼盘；流式时长 48-155s 不等；tracing 同开使 mark/measure 放大约 **69 倍每流**（非 5 倍）且整条管线都膨胀约 2 倍。
7. **修订后的优化优先级**：O(n²) 派生归零（约 -7%）> 稳定引用 props（跳过组件更新）> 强制布局纪律（约 -4%）> fence 闭合 Worker 化（消 1.2-3.3s 冻结）> TTFT（pi 冷启动 + prompt 0.9s 同步块）> 据干净 GPU 数据再谈 EdgeFade 视觉。

## 2. 实测 TOP 10——CPU 与 GPU 分开两张榜

> CPU 榜口径：self-time / 进程窗口（renderer 82.7s、runtime 75.35s、pi 42.5s 流式窗），跨进程按绝对秒数排序。GPU 榜口径：GPU/合成进程 trace 活动 / 65s 流式窗，按功能归因（trace flow 类事件与嵌套 slice 有重叠，已归并）。

### 2.1 CPU TOP 10（三个进程合计）

| # | 功能 | 进程 | 实测 self-time | 占比 | 性质 |
|---|------|------|---------------|------|------|
| 1 | **每-delta Vue 重渲染/patch 机制**（createVNode/setFullProps/updateProps/componentUpdate + 响应式 get/set + setStyle） | renderer | **10.5s** | 12.7% | 持续（每 delta） |
| 2 | **shiki fence finalize**（complete 帧同步高亮 120 函数代码块） | renderer | **2.54s** | 3.1% | 一次性 |
| 3 | **Turn/Trace 派生**（summarize-turn 的 stripMarkdown + truncate） | renderer | **2.37s** | 2.9% | 持续（每 delta） |
| 4 | **virtua 跟随滚动**（scrollToIndex + 高度估算收敛） | renderer | **2.21s** | 2.7% | 持续（每 delta） |
| 5 | **vue-i18n t() 链**（resolveMessageFormat + mark/measure 插桩） | renderer | **1.62s** | 2.0% | 持续（dev-only，prod 归零） |
| 6 | **DOMPurify + markdown-it 增量渲染** | renderer | **~1.0s** | 1.2% | 持续（每帧） |
| 7 | **EdgeFade.sync**（13-stop mask 重算） | renderer | **0.86s** | 1.0% | 持续（每滚动/尺寸变） |
| 8 | **runtime .gitignore/file-service 解析**（ruleMatchesPath + readdir） | runtime | **0.85s** | 1.1% | 事件型 |
| 9 | **previewText**（stream-view-items 摘要预览） | renderer | **0.80s** | 1.0% | 持续（每 delta） |
| 10 | **runtime 消息转发链路**（tee + JSON.parse/stringify + publish + ws.send/writev） | runtime | **0.50s** | 0.6% | 持续（每 token） |

荣誉提名：**pi agent loop + 22 扩展 emit + stdout 序列化 ≈ 0.28s/42.5s（0.7%）**——后端两个进程实测各 ~95% 空闲。

### 2.2 GPU TOP 10（按功能归因）

| # | 功能 | GPU 侧实测证据（65s 流式窗） | 性质 |
|---|------|---------------------------|------|
| 1 | **CALayer 合成积压**（帧生产快于显示，提交层树等 VSync/GPU） | ApplyBackpressure + GL = **22.67s** | 持续（每帧） |
| 2 | **帧呈现**（每帧 present 到 macOS CALayer） | ImageTransportSurfaceOverlayMac::Present = **12.02s** | 持续（每帧） |
| 3 | **流式文本增量失效的光栅化**（11451 次 raster：尾部文本块 + 代码块 + blur backdrop） | RendererRasterWorker 5.89 + DoRaster 2.50 + DoEndRaster 2.41 + DoBegin 0.75 + 修正 flush 0.52 ≈ **12.1s**（含嵌套 15.7s） | 持续（每 delta） |
| 4 | **Command buffer 提交链**（渲染进程→GPU 进程命令往返） | ExecuteDeferredRequest 6.0 + Flush 5.88 + OnAsyncFlush 5.87 + PutChanged 5.85 ≈ **23.6s**（flow 重叠，净增 6-18s） | 持续（每帧） |
| 5 | **cc 合成器帧生产** | BeginMainFrame 5.29 + ScheduledActionDraw 1.23 + MainFrame.Draw 1.23 + PrepareToDraw/ReadyToCommit/UpdateDrawProperties 1.03 ≈ **8.8s** | 持续（每帧） |
| 6 | **EdgeFade 四层 backdrop-blur**（每帧对 backdrop readback + 高斯卷积，流式期 backdrop 每帧变） | Layerize 0.83s + 模糊区域计入 #3 的 raster | 持续（每帧） |
| 7 | **EdgeFade mask-image**（13-stop 渐变作用于整个滚动容器，抑制快速滚动路径） | 计入 #1/#5 的合成路径劣化 | 持续（滚离顶即生效） |
| 8 | **主线程 Layout/Paint 级联**（转成 GPU raster 量） | UpdateLayoutTree 0.71 + Layout 0.64 + PrePaint 0.48 + Paint 0.49 = **2.32s** | 持续（每 delta） |
| 9 | **rAF 帧驱动链**（每 delta 的渲染回调产出帧） | FireAnimationFrame **2.19s** | 持续（每 delta） |
| 10 | **动画族 + 帧预算结果**（text-sweep 扫光 / ld-arc 呼吸弧持续 invalidation；合成层显存） | 帧率 **40.2fps**（tracing 开 31.2 / 空闲 36）；GPU 显存 **18.4→48.9MB（+166%）** | 持续 |

**GPU 总账**：65s 流式窗内 GPU/合成进程活动 ≈ 71s（多队列并行，非单线程 109%），即合成/光栅管线整体饱和；显存 +166%。

---

## 3. 逐项优化方案（CPU TOP 10 + GPU TOP 10，共 20 项）

> **审查处置（GLM，必读）**：本节方案写于审查前。审查判定——**删除**：CPU-1.3（微任务合帧 = 已删 delta-coalescer 复活，commit 4d5ad2270，同宏任务批大小恒 1）、CPU-4（高度预测/快路径，对症错误：scrollTo 是原生滚动强制布局，virtua self 仅 0.38s）、CPU-6.2（DOMPurify 快速通道，判据不可满足 + 收益 <1% + 契约冲突）、CPU-8.1/8.2（.gitignore 缓存，推翻在册裁决「缓存治理 U1 1-2」，file-service.ts:503-507）；**改方案**：CPU-1.1/1.2（v-memo deps 不全会出陈旧 UI，改稳定引用 props）、CPU-2（时刻错：是 fence 闭合而非 complete，改 Worker）、CPU-3/CPU-9（改「懒计算 + 前缀有界冻结」而非先截后剥）、GPU-8（rAF 回调在布局前运行，不消除强制布局，改 RO 回调）；**降级**：CPU-6.1、CPU-7.1（约 0 收益）。**有效实施批次见 §3.3 修订版路线图。**

### 3.1 CPU TOP 10 逐项方案

#### CPU-1 每-delta Vue 重渲染/patch 机制（10.5s，12.7%）——【P0，收益最大】
- **机制**：ws.onmessage → store effect → `commitMessages`（新数组+末位 assistant 新对象）→ MessageStream/Turn/UserBubble 全链换引用重渲染；delta-coalescer 已删（真机 242 delta 批大小恒 1），无任何合帧。v-memo 只 gate 了 TextRow 单元，**UserBubble 收整个 `turn` 对象作 prop**（流式 turn 每 delta 重建 → 静态用户气泡每 delta 重渲染+t() 全跑）。
- **方案**：
  1. **UserBubble 加 `v-memo="[turn.user?.id, canEdit, isSessionEditable]"`**（UserBubble.vue，用户内容流式期不变，memo 全命中→子树 patch 归零）；
  2. **TurnMeta/TurnSummary 同款 v-memo**（deps=单元 deps 已有 unitMemoDeps，扩展到这两个组件）；
  3. **store effect 入口微任务合帧**：`useChat.ts` 的 message.text_delta effect 内按 `queueMicrotask` 收集同宏任务内到达的多个 delta，合并为一次 commitMessages——不改变事件顺序契约（同一微任务内顺序不变），只消除「同帧多 delta 多次重建」；需补 live≡reload 等价性测试（apply-entry-equivalence 同款）；
  4. 上述 3 完成后 Vue patch 成本随重渲染次数同比下降。
- **预期**：renderer 主线程 39% → ~22%；40fps → 55+。**风险低**（1/2 是纯增量 gate；3 需等价性测试）。

#### CPU-2 shiki fence finalize（2.54s，3.1%，一次性）——【P1】
- **机制**：消息 complete 帧同步跑 shiki `codeToHtml`（120 函数代码块 ≈ 2.5s 主线程阻塞），集中在用户感知最强的「回答完成」瞬间。流式期已有 streaming-fence 占位（不跑 shiki）。
- **方案**：
  1. finalize 改**分帧 tokenize**：按代码块拆分，每帧处理一块（`requestAnimationFrame` 链或 `requestIdleCallback`），2.5s 摊到 ~10 帧；
  2. 单块 >300 行时**可视区优先**（virtua 窗口内先高亮，其余 idle 补）；
  3. mermaid 已异步，保持现状。
- **预期**：完成瞬间卡顿归零（总 CPU 不变，可感知度归零）。**风险低**。

#### CPU-3 Turn/Trace 派生（summarize-turn 2.37s，2.9%）——【P0，与 CPU-1 联动】
- **机制**（实测源码级确认的反模式）：`summarizeAssistantForRail` 对流式 turn 的**整条 72KB assistant 文本**跑 `stripMarkdown`（19 个全文正则）再 `truncate(…, 20)`；`truncate` 内部 `Array.from(text)` 全量码点化后才判长——**先全量后截断**，单 delta O(n)，整条消息 O(n²)。`summarizeTurnForRail` 同款（user 侧短，危害小）。
- **方案**：
  1. **截断前置**：调用侧改 `truncate(stripMarkdown(truncate(raw, 200)), MAX_CHARS)`——或更彻底：stripMarkdown 内部对超过 200 字符的输入先截后剥（20 字符的 rail 摘要对边界差异不敏感，需补单测锁定几种边界形态）；
  2. **truncate 早退**：`if (text.length <= maxChars) return text`（UTF-16 长度 ≥ 码点数，可直接放行）；长输入只迭代到 maxChars 个码点即停（early exit），杜绝 `Array.from` 全量分配；
  3. **按消息 id+长度分桶缓存**（rail 节点摘要只依赖首条 assistant 文本）。
- **预期**：2.37s → <0.1s（O(n²)→O(1)/delta）。**风险低**（纯函数，单测可全覆盖）。

#### CPU-4 virtua 跟随滚动（scrollTo 2.21s，2.7%，891 次）——【P1】
- **机制**：贴底态每 delta「文本总长 watch → 双 rAF → scrollToIndex(align:'end')」，virtua 内部 offset 查算 + 200px 估算高度与实测反复收敛。
- **方案**：
  1. **高度增量预测**：流式增长期用「本帧内容高度增量 Δh 累加」修正 spacer，替代每 delta 全量 scrollToIndex 重算；
  2. align:'end' 走 `scrollTop = scrollHeight - clientHeight` 快路径（跳过 item 索引查算）；
  3. 与 CPU-1 合帧后触发次数本身减半。
- **预期**：2.21s → ~0.8s。**风险中**（virtua 内部 API 依赖，需回归滚动位置准确性测试）。

#### CPU-5 vue-i18n t() 链（1.62s，2.0%）——【dev-only，prod 无需动作】
- **机制**：dev 构建 `NODE_ENV!=='production'` 分支在每个 t() 调用时打 `performance.mark/measure`（vue-devtools timeline 支持，源码级验证）；tracing 同开时被放大到 38%。**prod 构建该分支被 DCE 删除，成本归零**；ICU 编译本身有 compileCache（59 次 miss）。
- **方案**：**不优化**（prod 无此成本）。附带真实问题——静态组件每 delta 重渲染导致 t() 全量重跑——已归入 CPU-1 的 v-memo 方案，修完自然下降。
- **结论**：不可优化/不必优化；仅登记「dev 模式 profiling 时该插桩会严重扭曲火焰图」的方法学教训。

#### CPU-6 DOMPurify + markdown-it 增量渲染（~1.0s，1.2%）——【P2，保持观察】
- **机制**：tail 段 markdown-it parse + DOMPurify DOM 往返 + innerHTML 替换。前缀缓存 + rAF 节流 + streaming-fence 三道防线已实装；连续块结构（无空行长列表）下边界冻结→tail 增大，本实测未失控（~1s）。
- **方案**：
  1. 长连续块结构下把 tail 段按「稳定行/不稳定行」二分（已稳定的前缀行走缓存路径），缩小 parse+sanitize 范围；
  2. DOMPurify 对「纯文本无 HTML 标签」的 tail 段走快速通道（跳过 DOM 往返，字符串转义即可）——需安全评审（当前两级白名单是安全模型核心，快速通道只允许零 HTML 标记输入）。
- **预期**：1.0s → ~0.5s。**风险中**（安全模型相关，须 CR 级评审）。

#### CPU-7 EdgeFade.sync（0.86s，1.0%，339 次）——【P1】
- **机制**：每次滚动/尺寸变化重算 13-stop mask 渐变串（字符串拼接 + style 写入），`scrollTop > 4` 即生效。
- **方案**：
  1. **渐变串常量提取**：mask 串只依赖 active 布尔（FADE_BAND_HEIGHT/MASK_STOP 全是常量）——**提为两个模块级常量**，sync 只做布尔切换（消除全部字符串构造）；
  2. 贴底流式期（用户正看最新内容、顶部无内容可渐焦）直接短路。
- **预期**：0.86s → ~0.05s。**风险极低**（纯等价重构）。

#### CPU-8 runtime .gitignore/file-service 解析（0.85s，1.1%）——【P2】
- **机制**：`ruleMatchesPath` + `allPrefixes` 逐行匹配 + readdir，事件型（文件变更/会话扫描）触发，单次同步 IO 在主线程。
- **方案**：
  1. .gitignore 编译结果按（路径 + mtimeMs + size）缓存（`sessionMetaCache` 同款范式可复用）；
  2. readdir 结果按目录 mtime 短缓存；
  3. 与流式主链路无关，仅削事件触发时的卡顿帧。
- **预期**：事件型卡顿帧减少。**风险低**。

#### CPU-9 previewText（0.80s，1.0%，414 次）——【P0，与 CPU-3 同族】
- **机制**（实测源码级确认）：`previewText` 对整条文本 `replace(/\s+/g,' ')` **全量压平空白后才截断**——流式 turn 每 delta 对 72KB 全文跑正则，O(n²)。逐项复用缓存（canReuseView）只挡住了历史 turn，挡不住流式 turn 本身。
- **方案**：**先截后压**——`text.slice(0, PREVIEW_MAX_CHARS * 2).replace(/\s+/g,' ').trim().slice(0, PREVIEW_MAX_CHARS)`（预览串的边界差异对占位行无感知；补单测锁定）。
- **预期**：0.80s → <0.05s。**风险极低**。

#### CPU-10 runtime 消息转发链路（0.50s，0.6%）——【不优化】
- **机制**：tee 逐行写盘（架构约定 #4 的卡死诊断保真，刻意设计）+ JSON.parse/stringify + publish + ws.send，实测 0.5s/75s。
- **结论**：**不可优化/无需优化**——为 0.6% 的单核占用改链路（或动 tee 保真）收益为零、风险为诊断能力受损，属过度设计。登记为「已测量，无需动作」。

### 3.2 GPU TOP 10 逐项方案

> GPU 项与 CPU 项强联动：GPU 负载的根因几乎全是「每 delta 产帧 + 失效区域大」。以下每项标注联动的 CPU 项。

#### GPU-1 CALayer 合成积压（ApplyBackpressure 22.67s）——【P0，联动 CPU-1/4】
- **方案**：降帧产率是唯一根解——CPU-1 合帧（同微任务多 delta 一次渲染）+ CPU-4 滚动节流落地后，帧生产从「每 delta」降为「每帧至多一次且可跳过」，积压自然消退。无需 GPU 侧专门改动。
- **预期**：22.67s → <10s。

#### GPU-2 帧呈现（Present 12.02s）——【随 GPU-1 联动】
- **方案**：同上（产帧少了 present 自然少）；另确认窗口未处于不必要的合成（如 opacity:0 的 EdgeFade 层在贴顶态仍持合成层——排查 Chromium 是否释放，未释放则显式 `visibility:hidden` 或条件渲染）。
- **预期**：12.02s → ~7s。

#### GPU-3 流式文本增量光栅化（raster 12.1s，11451 次）——【P1，联动 CPU-6】
- **方案**：缩小失效区域——CPU-6 的 tail 段二分稳定行之后，innerHTML 替换范围从「整个 tail」缩到「不稳定行子树」，raster 区域随之缩小；代码块在流式期是占位（streaming-fence），无大面积 raster。
- **预期**：raster 次数与面积下降 30-50%。

#### GPU-4 Command buffer 提交链（~23.6s flow）——【随 GPU-1 联动】
- **方案**：无独立手段——提交量与帧数线性相关，随产帧下降而下降。

#### GPU-5 cc 合成器帧生产（8.8s）——【随 GPU-1 联动】
- **方案**：同上。

#### GPU-6 EdgeFade 四层 backdrop-blur——【P1，GPU 侧最大单项可优化】
- **机制**：backdrop-blur = 每帧对 backdrop 做 readback + 高斯卷积；流式期其背后消息内容每帧变，模糊结果每帧失效重算；4 层（1/2/4/8px）叠加在滚动内容上。
- **方案**：
  1. **流式进行中自动降档**：把已有的 `prefers-reduced-transparency` 降档路径扩展到「本 session 有 streaming turn」时自动启用（贴底阅读场景 blur 本就不可感知）；
  2. **blur 改静态近似**：4 层 backdrop-blur + sink 渐变改为一张预渲染的渐变遮罩（视觉近似度需设计走查）；
  3. 中期可只保留 1 层 blur。
- **预期**：每帧卷积量降 75-100%；GPU 显存与 raster 压力显著下降。**风险中**（视觉变更需 DESIGN.md 走查）。

#### GPU-7 EdgeFade mask-image（13-stop 全滚动容器）——【P1】
- **方案**：mask 只覆盖顶部 40px 渐变带却作用于**整个滚动容器**——把 mask 从 scroller 下沉到一个 40px 高的绝对定位覆盖层（或改用覆盖层 + 渐变背景色替代 mask），避免大子树合成路径抑制。与 CPU-7 的常量提取同批做。
- **预期**：合成路径恢复快速滚动优化。**风险中**（滚动边缘视觉需回归）。

#### GPU-8 主线程 Layout/Paint 级联（2.32s）——【P1，联动 CPU-3/9】
- **方案**：thinking 窗跟底 `watch(thinkingContent) → nextTick(followThink)` 的读 scrollHeight/写 scrollTop 是**强制同步布局**（每 thinking delta 一次）——改为 rAF 内批量读写；CPU-3/9 的 O(n²) 修掉后布局范围同步缩小。
- **预期**：强制布局次数降一个量级。

#### GPU-9 rAF 帧驱动链（FireAnimationFrame 2.19s）——【随 CPU-1 联动】
- **方案**：MarkdownRenderer 已有 rAF trailing 节流；把同一节拍扩展到 Turn/TurnSummary 的 watch 链（同一 rAF 内完成「数据提交→派生→渲染」），避免一 delta 内多轮 rAF 回调。
- **预期**：每 delta 帧回调次数 2-3 → 1。

#### GPU-10 动画族 + 帧预算/显存——【P2】
- **机制**：text-sweep（background-clip:text + background-position 动画）与 .ld-arc（stroke-dasharray）**不走 GPU 合成、主线程逐帧重绘**；running 工具 100ms tick 重渲染。
- **方案**：
  1. 流式进行中（session 有 streaming turn）暂停扫光/呼吸弧（与 GPU-6 的降档同一开关）；
  2. text-sweep 改 transform 类动画（可合成）或降级为静态渐变；
  3. useLiveToolDuration 的 100ms tick 与渲染帧对齐（rAF 驱动）。
- **预期**：主线程重绘面积下降；帧率上限解除。**风险低-中**。

### 3.3 修订版路线图（据审查重划，对应实施批次）

| 批次 | 内容（审查建议编号） | 预期 | 状态 |
|------|---------------------|------|------|
| **批1 派生归零** | F1：rail 摘要按 message id 记忆 + content.length 超过 K 后冻结 + fence 行无条件剥离；StreamViewItem.preview 懒计算（仅 broken 占位行求值）；truncate 码点级 early-exit | 流式窗约 -7%，dev/prod 同收益，零视觉变化（顺手修 rail 流式期 fence 标记泄漏） | 待实施 |
| **批2 契约层更新跳过 + 强制布局纪律** | F2：Turn.vue 向 UserBubble 传 user 引用加标量、向 TurnSummary 传 lastAssistant.id/isStreaming/index（shouldUpdateComponent 直接跳过）；F4：EdgeFade 的 on 改 IntersectionObserver 哨兵、跟底读写进 RO 回调、修 pin-bottom gap=29.5px 不收敛、消 164 条 RO 循环；N1 mask 常量、N2 aiCopyKey 用 id | 组件更新跳过 + 约 -4%，dev/prod 同量级 | 待实施 |
| **批3 fence 闭合 Worker 化** | F3：shiki 移入 Web Worker（CSP 放行 + worker 加载一次性评估），消流式中途 1.2-3.3s 硬冻结 | 冻结归零，与块大小无关 | 待实施 |
| **批4 TTFT** | F5 前半：pi 冷启动 20s 风暴排查（jiti 缓存命中 / NodeError ENOENT 源 / 23 扩展 stat 风暴 / prod 对比）；prompt 路径全树 ignore 匹配去重或异步化（每次 prompt 编译两次） | 首 token 延迟 | 待实施 |
| **批5 干净重测 + GPU 决策** | F5 后半：prod 构建、前台窗口、无并存 Electron、单次运行采齐三进程、Tracing recordContinuously 跨 fence 闭合与 complete、Performance.enable 交叉验证 program、补 fixture 形态（多小代码块 / 工具调用 / 重 thinking）；**拿到干净 GPU 数据前不动 EdgeFade blur/mask 视觉** | 据新数据决定 GPU-6/7 | 待实施 |
| **不动作** | CPU-5（dev-only）、CPU-10（negligible）、pi 扩展 emit（上游包）、GPU-1/2/4/5/9（GPU 未饱和，前提不成立） | — | — |

## 4. 推断版 TOP 5 ↔ 实测对照（证伪登记）

| 推断版排名 | 项 | 实测结论 |
|---|---|---|
| 前台 #1 Markdown 增量链 O(n²) | DOMPurify 0.58s + markdown-it ~0.4s + scan ≈ **1s/82.7s（1.2%）** | **大幅证伪**：前缀缓存 + rAF 节流 + streaming-fence 占位三道防线有效；fallback-full 触发时也未失控（本次测试结构下） |
| 前台 #2 Turn/Trace 派生 | **证实**（3.2s，3.9%）但机制是 summarize-turn 字符串而非 DOM |
| 前台 #3 EdgeFade | **部分证实**：CPU 0.86s 小，但它是 GPU 合成压力的重要来源 |
| 前台 #4 动画族 | ld-arc/text-sweep 未进 TOP（单元素重绘，量级小） |
| 前台 #5 finalize+滚动 | **证实**（shiki 2.5s + scrollTo 2.2s） |
| 后台 #1 pi 扩展风扇出 | **证伪为 negligible**（0.07s/42.5s） |
| 后台 #2 runtime 三重奏 | **证伪为 negligible**（0.5s/75s） |
| 后台 #3 大帧序列化 | 未触发（无图片/工具结果大帧）；频率低不改变持续型排名 |
| 后台 #4 subagent 放大 | 未触发（无 subagent）——**条件性热点，并发 subagent 场景需单独验证** |
| 后台 #5 pi stdout Promise 链 | 证伪（serializeJsonLine 0.037s） |
| （推断未列） | **每-delta 重渲染链（Vue+pinia+ws）** | **实测第 1 名**（16%）——推断版完全遗漏 |
| （推断未列） | **GPU 合成饱和** | **实测第 2 名**——推断版只怀疑了 EdgeFade 一个点 |

---

## 5. 复现指南（含踩坑，macOS）

```bash
# 0) worktree 准备（本 worktree 曾无 node_modules）
CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install
ln -sfn <主worktree>/node_modules/electron/dist node_modules/electron/dist
cp <主worktree>/apps/electron/resources/pi/{pi-darwin-x64,package.json,photon_rs_bg.wasm} apps/electron/resources/pi/
cp -R <主worktree>/apps/electron/resources/pi/{assets,theme,export-html} apps/electron/resources/pi/

# 1) faux 长流式脚本 + seed（72KB markdown，200 TPS ≈ 65s 窗口）
node .agents/skills/verify-taiji/scripts/seed-faux.mjs <repo> ~/.taiji-dev/verify-prof-X <responses.json> --force

# 2) 启动（后台不抢焦点；NODE_OPTIONS 仅 --cpu-prof，勿加 --inspect=0——vite/rolldown 会微任务死循环）
TAIJI_DEV_BACKGROUND=1 TAIJI_FAUX_SCRIPT=... TAIJI_EXTENSION_PATHS=<repo>/e2e/fixtures/faux-provider-ext \
TAIJI_FAUX_TPS=200 NODE_OPTIONS="--cpu-prof --cpu-prof-dir=/tmp/taiji-prof" \
node apps/electron/scripts/dev-instance.mjs --data-dir ~/.taiji-dev/verify-prof-X

# 3) renderer：CDP Profiler（**勿同时开 Tracing**）
node cdp-profile.mjs 9478 /tmp/taiji-prof/run 80000     # 内含 FPS overlay + 中期截图

# 4) runtime：发现 inspector 端口后 CDP Profiler（tsx 父壳 PID ≠ runtime 真身，按 argv 识别）
node discover-inspectors.mjs | grep runtime/src/index.ts
node node-profile.mjs <port> /tmp/taiji-prof/runtime.cpuprofile 75000

# 5) pi：mock-pi 置换位换 node launcher（--cpu-prof + 95s 后关 stdin 触发优雅退出落盘），用后三核对恢复
# 6) GPU：Tracing 单独采（devtools.timeline,gpu,cc）+ FPS overlay 截图 + chrome://gpu
#    （powermetrics 需 sudo，本机不可用；GPU 显存/帧率经 overlay 截图获取）
```

**采集纪律**：先杀净上一实例全部进程（vite/electron/runtime/tsx/pi 都会在 SIGTERM 级联后幸存，端口被占会让 runtime 静默换端口 → renderer 连错 → 「runtime 不可用」）。

---

## 6. 数据文件

**全部证据已固化在本会话 artifacts 目录**（`/tmp` 会被系统回收，勿依赖）：

| 文件 | 内容 |
|------|------|
| `perf-measured-report.md` | 本文（实测 TOP 10 ×2 + 20 项优化方案 + 附录 A 火焰图原始数据 + 附录 B 脚本） |
| `perf-analysis-final.md` | 代码推断版（已被本文证伪多处，仅作对照，文首有 SUPERSEDED 标记） |
| `profiling-data/run-notrace-renderer.cpuprofile` | renderer 权威数据集（无 tracing） |
| `profiling-data/run2c-renderer.cpuprofile` | renderer tracing 同开对照（仅方法学反面教材） |
| `profiling-data/run2e-runtime.cpuprofile` | runtime 窗口化 profile |
| `profiling-data/CPU.20261123.175042.55232.0.001.cpuprofile` | pi 子进程 profile（含启动期，流式窗需 +53s 切片） |
| `profiling-data/run2d-renderer.trace.json` | GPU trace（15.3 万事件，30MB） |
| `profiling-data/run2c/run-notrace-midstream.png` | 流式中期截图（FPS/GPU raster/显存 overlay 证据） |
| `profiling-data/*.mjs` + `faux-responses2.json` | 附录 B 全部采集/分析脚本 + faux 压力脚本 |

---

## 附录 A：火焰图原始分析数据（逐进程完整 TOP + 模块聚合 + 调用链）

> 数据由附录 B 的脚本对 .cpuprofile 直接聚合产出，非手工转录。窗口口径见各表头。

### A.1 Renderer 主线程（权威数据集：无 tracing，82.70s 窗口覆盖 65s 流式 + finalize）

```
file: ~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data/run-notrace-renderer.cpuprofile
samples: 41187, totalSampled: 82.70s
startTime: 1970-01-03T03:55:32.782Z, endTime: 1970-01-03T03:56:55.487Z

=== SELF-TIME TOP 30 (window 82.70s) ===
37.123s 44.89% hits=21235  (idle) @ (none):0
13.115s 15.86% hits=5203  (program) @ (none):0
2.211s 2.67% hits=891  scrollTo @ (none):0
1.257s 1.52% hits=636  findNextMatchSync @ node_modules/.vite/deps/shiki_engine_javascript.js?v=81b93bf5:31
1.227s 1.48% hits=556  truncate @ src/domain/chat/summarize-turn.ts:46
1.138s 1.38% hits=518  stripMarkdown @ src/domain/chat/summarize-turn.ts:23
1.004s 1.21% hits=453  get @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:996
0.925s 1.12% hits=267  (garbage collector) @ (none):0
0.860s 1.04% hits=339  sync @ src/components/ui/edge-fade/EdgeFade.vue:44
0.800s 0.97% hits=414  previewText @ src/components/panel/message-stream/stream-view-items.ts:5
0.781s 0.94% hits=356  RegExp: \s+ @ (none):0
0.628s 0.76% hits=308  mark @ (none):0
0.561s 0.68% hits=325  #execCore @ node_modules/.vite/deps/shiki_engine_javascript.js?v=81b93bf5:2930
0.558s 0.68% hits=272  createVNodeWithArgsTransform @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:6426
0.448s 0.54% hits=200  setFullProps @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:4971
0.368s 0.44% hits=163  set @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:1028
0.362s 0.44% hits=145  renderComponentRoot @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:4733
0.347s 0.42% hits=148  setStyle @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:7581
0.333s 0.40% hits=157  updateProps @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:4928
0.303s 0.37% hits=112  measure @ (none):0
0.292s 0.35% hits=126  wrappedAction @ node_modules/.vite/deps/pinia.js?v=81b93bf5:4747
0.261s 0.32% hits=127  ws.onmessage @ src/transport/ws-client.ts:345
0.252s 0.30% hits=106  createMessageContext @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:2338
0.241s 0.29% hits=121  translate @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:2391
0.231s 0.28% hits=121  processElement @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:5376
0.224s 0.27% hits=118  componentUpdateFn @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:5576
0.220s 0.27% hits=112  friendlyJSONstringify @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:56
0.199s 0.24% hits=106  RegExp: ^\s*([-*_])\1{2,}\s*$ @ (none):0
0.196s 0.24% hits=97  isDirty @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:531
0.181s 0.22% hits=73  resolveMessageFormat @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:2448

=== MODULE AGGREGATE (self) ===
59.133s 71.50%  (none)
10.495s 12.69%  node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5
2.388s 2.89%  src/domain/chat/summarize-turn.ts
2.239s 2.71%  node_modules/.vite/deps/shiki_engine_javascript.js?v=81b93bf5
1.617s 1.96%  node_modules/.vite/deps/vue-i18n.js?v=81b93bf5
0.860s 1.04%  src/components/ui/edge-fade/EdgeFade.vue
0.841s 1.02%  src/components/panel/message-stream/stream-view-items.ts
0.722s 0.87%  node_modules/.vite/deps/shiki_core.js?v=81b93bf5
0.584s 0.71%  node_modules/.vite/deps/dompurify.js?v=81b93bf5
0.377s 0.46%  node_modules/.vite/deps/virtua_vue.js?v=81b93bf5
0.353s 0.43%  node_modules/.vite/deps/pinia.js?v=81b93bf5
0.287s 0.35%  node_modules/.vite/deps/markdown-it.js?v=81b93bf5
0.270s 0.33%  src/transport/ws-client.ts
0.253s 0.31%  src/features/chat/markdown-incremental.ts
0.252s 0.30%  src/components/panel/MessageStream.vue
```

### A.2 Renderer 主线程（tracing 同开对照，165.83s——注意 mark/measure 插桩被放大约 5 倍、采样间隔变细，仅证伪'CPU 与 tracing 不可同开'用）

```
file: /tmp/taiji-prof/run2c-renderer.cpuprofile
samples: 224253, totalSampled: 165.83s
startTime: 1970-01-03T03:05:16.747Z, endTime: 1970-01-03T03:08:02.582Z

=== SELF-TIME TOP 12 (window 165.83s) ===
58.630s 35.35% hits=121987  mark @ (none):0
44.683s 26.94% hits=15581  (program) @ (none):0
12.237s 7.38% hits=7786  (idle) @ (none):0
5.257s 3.17% hits=61227  measure @ (none):0
3.465s 2.09% hits=784  findNextMatchSync @ node_modules/.vite/deps/shiki_engine_javascript.js?v=81b93bf5:31
2.471s 1.49% hits=592  stripMarkdown @ src/domain/chat/summarize-turn.ts:23
2.367s 1.43% hits=383  #execCore @ node_modules/.vite/deps/shiki_engine_javascript.js?v=81b93bf5:2930
2.311s 1.39% hits=694  truncate @ src/domain/chat/summarize-turn.ts:46
1.888s 1.14% hits=534  previewText @ src/components/panel/message-stream/stream-view-items.ts:5
1.475s 0.89% hits=627  createHTML @ (none):0
1.152s 0.69% hits=384  RegExp: \s+ @ (none):0
1.087s 0.66% hits=285  (garbage collector) @ (none):0

=== MODULE AGGREGATE (self) ===
134.316s 80.99%  (none)
9.766s 5.89%  node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5
7.181s 4.33%  node_modules/.vite/deps/shiki_engine_javascript.js?v=81b93bf5
4.801s 2.90%  src/domain/chat/summarize-turn.ts
1.972s 1.19%  src/components/panel/message-stream/stream-view-items.ts
1.760s 1.06%  node_modules/.vite/deps/shiki_core.js?v=81b93bf5
1.177s 0.71%  node_modules/.vite/deps/dompurify.js?v=81b93bf5
0.841s 0.51%  src/components/ui/edge-fade/EdgeFade.vue
0.710s 0.43%  node_modules/.vite/deps/markdown-it.js?v=81b93bf5
0.466s 0.28%  node_modules/.vite/deps/virtua_vue.js?v=81b93bf5
0.382s 0.23%  src/features/chat/composables/useProcessAggregate.ts
0.298s 0.18%  src/components/panel/MessageStream.vue
0.288s 0.17%  src/transport/ws-client.ts
0.198s 0.12%  src/lib/file-basename.ts
0.181s 0.11%  src/features/chat/TextRow.vue
```

### A.3 Runtime 主进程（75.35s 窗口）

```
file: ~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data/run2e-runtime.cpuprofile
samples: 48189, totalSampled: 75.35s
startTime: 1970-01-03T03:16:51.050Z, endTime: 1970-01-03T03:18:06.400Z

=== SELF-TIME TOP 20 (window 75.35s) ===
71.161s 94.44% hits=46153  (idle) @ (none):0
0.784s 1.04% hits=218  (program) @ (none):0
0.503s 0.67% hits=196  ruleMatchesPath @ src/infra/fs/ignore-parser.ts:1
0.393s 0.52% hits=167  (garbage collector) @ (none):0
0.386s 0.51% hits=201  writev @ (none):0
0.331s 0.44% hits=220  spawn @ (none):0
0.258s 0.34% hits=83  readdir @ (none):0
0.179s 0.24% hits=95  (anonymous) @ src/services/file-service.ts:1
0.159s 0.21% hits=118  (anonymous) @ src/infra/pi/rpc-client.ts:1
0.111s 0.15% hits=19  readdir @ node:internal/fs/promises:945
0.110s 0.15% hits=82  writeBuffer @ (none):0
0.077s 0.10% hits=27  allPrefixes @ src/infra/fs/ignore-parser.ts:1
0.051s 0.07% hits=16  parseJsonl @ src/utils/jsonl.ts:1
0.050s 0.07% hits=40  nextTick @ node:internal/process/task_queues:111
0.048s 0.06% hits=31  Socket.read @ node:net:781
0.035s 0.05% hits=29  writevGeneric @ node:internal/stream_base_commons:121
0.029s 0.04% hits=22  (anonymous) @ src/frame.ts:1
0.028s 0.04% hits=23  publish @ src/services/message-bus/message-bus.ts:1
0.025s 0.03% hits=17  handleMessage @ src/infra/pi/rpc-client.ts:1
0.023s 0.03% hits=3  readTailBytes @ src/utils/jsonl.ts:1

=== MODULE AGGREGATE (self) ===
73.523s 97.58%  (none)
0.604s 0.80%  src/infra/fs/ignore-parser.ts
0.530s 0.70%  node
0.197s 0.26%  src/services/file-service.ts
0.184s 0.24%  src/infra/pi/rpc-client.ts
0.074s 0.10%  src/utils/jsonl.ts
0.055s 0.07%  src/infra/pi/event-adapter.ts
0.043s 0.06%  src/services/message-bus/message-bus.ts
0.029s 0.04%  src/frame.ts
0.018s 0.02%  src/transport/message-broker.ts
0.016s 0.02%  node_modules/ws/lib/sender.js
0.016s 0.02%  src/services/session/session-delivery-registry.ts
0.010s 0.01%  src/infra/logger.ts
0.010s 0.01%  src/infra/fs-executor.ts
0.005s 0.01%  src/index.ts
```

### A.4 pi 子进程全窗口（95.52s，含启动期）

```
file: ~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data/CPU.20261123.175042.55232.0.001.cpuprofile
samples: 60608, totalSampled: 95.52s
startTime: 1970-01-03T03:16:08.456Z, endTime: 1970-01-03T03:17:43.977Z

=== SELF-TIME TOP 15 (window 95.52s) ===
70.263s 73.56% hits=45834  (idle) @ (none):0
4.744s 4.97% hits=2913  (anonymous) @ dist/jiti.cjs:1
4.054s 4.24% hits=2319  statSync @ node:fs:1745
1.851s 1.94% hits=1045  stat @ (none):0
1.123s 1.18% hits=601  parse @ (none):0
0.841s 0.88% hits=500  readFileUtf8 @ (none):0
0.716s 0.75% hits=438  NodeError @ dist/jiti.cjs:1
0.632s 0.66% hits=316  (garbage collector) @ (none):0
0.624s 0.65% hits=245  reallyExit @ (none):0
0.522s 0.55% hits=318  Script @ node:vm:85
0.390s 0.41% hits=268  (program) @ (none):0
0.370s 0.39% hits=242  lstat @ (none):0
0.357s 0.37% hits=235  readFileSync @ node:fs:433
0.317s 0.33% hits=187  URL @ node:internal/url:802
0.284s 0.30% hits=187  fileURLToPath @ node:internal/url:1600

=== MODULE AGGREGATE (self) ===
76.869s 80.48%  (none)
8.546s 8.95%  node
7.361s 7.71%  dist/jiti.cjs
1.020s 1.07%  dist/bundle/chunks/chunk-33XOIQ5N.js
0.257s 0.27%  src/execution/engine/engine-inspect-package.ts
0.237s 0.25%  dist/bundle/chunks/chunk-2KTBZM5G.js
0.112s 0.12%  dist/bundle/chunks/chunk-LTXEMVMA.js
0.110s 0.12%  dist/bundle/chunks/chunk-4L3WN2XY.js
0.106s 0.11%  dist/bundle/chunks/chunk-7JGR3GZN.js
0.089s 0.09%  dist/bundle/cli-runtime.js
0.073s 0.08%  src/index.ts
0.040s 0.04%  dist/bundle/chunks/chunk-A3JYRWB6.js
0.039s 0.04%  dist/bundle/chunks/chunk-IBCPYVFK.js
0.038s 0.04%  src/execution/engine/engine-discovery-roots.ts
0.034s 0.04%  dist/parse/parser.js
```

### A.5 pi 子进程流式窗切片（+53s 起，42.52s——剔除启动期 jiti 扩展加载与 fs 遍历后的流式专属成本）

```
file: ~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data/CPU.20261123.175042.55232.0.001.cpuprofile
samples: 60608, totalSampled: 95.52s
startTime: 1970-01-03T03:16:08.456Z, endTime: 1970-01-03T03:17:43.977Z
relative window: +53s → +ends
window: 1970-01-03T03:17:01.456Z → end (samples 33795..60608)

=== SELF-TIME TOP 18 (window 42.52s) ===
40.132s 94.39% hits=25537  (idle) @ (none):0
0.624s 1.47% hits=245  reallyExit @ (none):0
0.335s 0.79% hits=227  (program) @ (none):0
0.293s 0.69% hits=158  (garbage collector) @ (none):0
0.150s 0.35% hits=3  runAgentLoop @ dist/bundle/chunks/chunk-33XOIQ5N.js:540
0.060s 0.14% hits=40  writeUtf8String @ (none):0
0.044s 0.10% hits=11  toToolDeclaration @ dist/bundle/chunks/chunk-7JGR3GZN.js:11
0.043s 0.10% hits=32  createContext @ dist/bundle/chunks/chunk-33XOIQ5N.js:513
0.037s 0.09% hits=29  processTimers @ node:internal/timers:506
0.037s 0.09% hits=27  serializeJsonLine @ dist/bundle/chunks/chunk-33XOIQ5N.js:1074
0.034s 0.08% hits=26  nextTick @ node:internal/process/task_queues:111
0.033s 0.08% hits=24  listOnTimeout @ node:internal/timers:526
0.030s 0.07% hits=19  emit @ dist/bundle/chunks/chunk-33XOIQ5N.js:513
0.028s 0.07% hits=9  emitBeforeScript @ node:internal/async_hooks:517
0.020s 0.05% hits=15  onwrite @ node:internal/streams/writable:615
0.019s 0.05% hits=8  processPromiseRejections @ node:internal/process/promises:439
0.019s 0.05% hits=14  streamAssistantResponse @ dist/bundle/chunks/chunk-33XOIQ5N.js:540
0.017s 0.04% hits=12  streamWithDeltas @ dist/bundle/chunks/chunk-33XOIQ5N.js:470

=== MODULE AGGREGATE (self) ===
41.472s 97.54%  (none)
0.512s 1.20%  dist/bundle/chunks/chunk-33XOIQ5N.js
0.416s 0.98%  node
0.052s 0.12%  dist/bundle/chunks/chunk-7JGR3GZN.js
0.040s 0.09%  dist/bundle/chunks/chunk-A3JYRWB6.js
0.005s 0.01%  src/trace.ts
0.004s 0.01%  src/execution/subagent-service.ts
0.004s 0.01%  src/injectors/engine-awareness.ts
0.003s 0.01%  src/workflow-events.ts
0.002s 0.01%  src/index.ts
0.002s 0.01%  src/delivery-port.ts
0.002s 0.00%  dist/jiti.cjs
0.002s 0.00%  dist/bundle/chunks/chunk-DRQDKNXA.js
0.001s 0.00%  src/delivery.ts
0.001s 0.00%  src/execution/service/session-baselines.ts
```

### A.6 关键调用链证据（find-callers.mjs 输出）

**(a) tracing 同开时 renderer TOP1 'mark' 的归属链**（mark/measure = window.performance API，vue-i18n dev 插桩）：

```

=== target node 2714 self=23.10s fn=mark @ :-1
  <- mark @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:31
    <- resolveMessageFormat @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:2447
      <- translate @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:2390
        <- wrapWithDeps @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:3058
          <- t @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:3090
            <- _sfc_render @ src/features/chat/UserBubble.vue:340
              <- renderComponentRoot @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:4732
                <- componentUpdateFn @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:5575

=== target node 3450 self=9.02s fn=mark @ :-1
  <- mark @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:31
    <- resolveMessageFormat @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:2447
      <- translate @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:2390
        <- wrapWithDeps @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:3058
          <- t @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:3090
            <- _sfc_render @ src/features/chat/TurnSummary.vue:139
              <- renderComponentRoot @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:4732
                <- componentUpdateFn @ node_modules/.vite/deps/vue.runtime.esm-bundler-De8g_T86.js?v=81b93bf5:5575

=== target node 2978 self=7.64s fn=mark @ :-1
```

**(b) tracing 同开时 'measure' 的归属链**：

```

=== target node 3462 self=0.86s fn=measure @ :-1
  <- measure @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:34
    <- evaluateMessage @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:2554
      <- translate @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:2390
        <- wrapWithDeps @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:3058
          <- t @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:3090

=== target node 3452 self=0.83s fn=measure @ :-1
  <- measure @ node_modules/.vite/deps/vue-i18n.js?v=81b93bf5:34
```

### A.7 GPU trace 聚合（run2d，152532 事件 / 120.49s traced / 65s 流式窗）

```
events: 152532, total traced: 120.49s
GPUTask: 0 次, 合计 0.00s
Raster(gpu): 11451 次, 合计 15.71s

=== TOP 30 slice (dur) ===
22.869s  gpu,toplevel.flow::Scheduler::RunTask
12.015s  gpu::ImageTransportSurfaceOverlayMac::Present
11.353s  gpu::CALayerTreeCoordinator::ApplyBackpressure
11.321s  gpu::CALayerTreeCoordinator::ApplyBackpressure::GL
6.000s  gpu::GpuChannel::ExecuteDeferredRequest
5.885s  gpu::RendererRasterWorker
5.876s  gpu,toplevel.flow::CommandBuffer::Flush
5.871s  gpu::CommandBufferStub::OnAsyncFlush
5.848s  gpu::CommandBufferService:PutChanged
5.289s  cc,benchmark::ProxyMain::BeginMainFrame
2.497s  gpu::RasterDecoderImpl::DoRasterCHROMIUM
2.474s  gpu::RasterDecoderImpl::DoRasterCHROMIUM::Deserializing
2.414s  gpu::RasterDecoderImpl::DoEndRasterCHROMIUM
2.191s  devtools.timeline::FireAnimationFrame
1.322s  devtools.timeline::FunctionCall
1.233s  cc::ProxyImpl::ScheduledActionDraw
1.229s  cc,benchmark::MainFrame.Draw
1.015s  gpu::RasterDecoderImpl::DoEndRasterCHROMIUM::Flush
0.826s  devtools.timeline::Layerize
0.748s  gpu::RasterDecoderImpl::DoBeginRasterCHROMIUM
0.729s  devtools.timeline,disabled-by-default-v8.gc::V8.GC_MC_BACKGROUND_MARKING
0.707s  blink,devtools.timeline::UpdateLayoutTree
0.636s  devtools.timeline::Layout
0.523s  gpu::RasterDecoderImpl::FlushToWorkAroundMacCrashes
0.494s  devtools.timeline::Paint
0.479s  devtools.timeline::PrePaint
0.474s  gpu::CommitPresentedFrameToCA
0.379s  cc::LayerTreeHostImpl::PrepareToDraw
0.340s  cc,benchmark::ProxyImpl::ReadyToCommit
0.312s  cc,benchmark::LayerTreeImpl::UpdateDrawProperties
```

### A.8 源码级反模式证据（CPU-3 / CPU-9 的'先全量后截断'）

```ts
// packages/core/src/domain/chat/summarize-turn.ts（CPU-3）
export function summarizeAssistantForRail(turn: MessageTurn): string {
  for (const m of turn.assistants) {
    const text = normalizeContent(m.content).trim()
    if (text) {
      return truncate(stripMarkdown(text), MAX_CHARS)   // ← stripMarkdown 对整条 72KB 跑 19 个全文正则
    }
  }
  ...
}
export function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text)                        // ← 全量码点化后才判长（72KB → 72K 码点数组/delta）
  if (chars.length <= maxChars) return text
  return chars.slice(0, Math.max(0, maxChars - ELLIPSIS.length)).join('') + ELLIPSIS
}

// packages/renderer/src/components/panel/message-stream/stream-view-items.ts（CPU-9）
function previewText(text: unknown): string {
  const flat = text.replace(/\s+/g, ' ').trim()        // ← 全文压平空白
  return flat.length > PREVIEW_MAX_CHARS ? `${flat.slice(0, PREVIEW_MAX_CHARS)}…` : flat  // ← 之后才截断
}
```

### A.9 UserBubble 重渲染根因（CPU-1）

```ts
// packages/ui/src/features/chat/UserBubble.vue:226——收整个 turn 对象作 prop
defineProps<{ turn: MessageTurn; sessionId: string; canEdit?: boolean; isSessionEditable?: boolean }>()
// 流式 turn 每 delta 被 commitMessages 重建（新对象）→ 默认按引用比对 → 整个 UserBubble 每 delta 重渲染
// 而 v-memo 逐单元 gate 只覆盖了 TextRow，未覆盖 UserBubble / TurnMeta / TurnSummary
```

---

## 附录 B：采集脚本（零依赖 Node ≥22，可从任意 cwd 运行）

| 脚本 | 用途 |
------|------|
| `cdp-profile.mjs` | renderer CDP 采集：Profiler + Tracing(gpu/cc) + FPS overlay + 中期截图 + metrics 快照（`TRACE_ENABLED=0` 关 tracing） |
| `node-profile.mjs` | 任意 Node inspector 端口的窗口化 CPU profile（先打印目标进程 pid+argv 做身份确认） |
| `discover-inspectors.mjs` | 枚举本机 inspector 端口并按 argv 识别进程 |
| `analyze-cpuprofile.mjs` | .cpuprofile 聚合：self-time TOP N + 模块聚合 + 时间窗切片（`--rel-from/--rel-to` 相对秒） |
| `find-callers.mjs` | 指定函数名的自底向上调用链（归因内建函数用） |
| `analyze-trace.mjs` | trace.json 的 GPU/raster/slice 时长聚合 |
| `cpu-sampler.mjs` | top -l 1 瞬时 CPU 采样（注意 top 输出格式随 macOS 版本变化） |
| `faux-responses2.json` | faux 长流式压力脚本（72KB markdown：120 函数代码块 + 180 项无空行列表 + 长段落） |

pi 侧 launcher（mock-pi 规范置换，已三核对恢复，代码留档）：

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process'
const CLI = '<repo>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
const child = spawn(process.execPath, ['--cpu-prof', '--cpu-prof-dir=<abs>', CLI, ...process.argv.slice(2)], { stdio: ['pipe', 'inherit', 'inherit'] })
process.stdin.pipe(child.stdin)
setTimeout(() => { try { child.stdin.end() } catch {} }, 95_000)  // 关 stdin → pi EOF 优雅退出 → V8 flush profile
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
```
