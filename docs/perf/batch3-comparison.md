# 批3「fence 闭合高亮移出主线程（Web Worker）」前后对比（CPU）

> 采集分支 `feat-cpu-gpu-performance` · 交付 = fence 闭合的 shiki 高亮 Web Worker 化（主线程发「代码文本+语言」，worker 跑 codeToHtml 回填 HTML）+ 两壳 CSP 显式 `worker-src 'self'` + 失败降级（worker 不可用 → 主线程同步高亮，高亮不丢）+ 流式期 streaming-fence 占位保留。
> 依据 = [adversarial-review-glm.md](adversarial-review-glm.md) F 节建议 3 / C4 / D6 / M6（shiki 突发在 fence 闭合时刻、complete 处为零；分帧 tokenize 对单块无效、可视区优先粒度不匹配，Worker 是唯一与块大小无关的解）。
>
> **口径声明（先读，照批1/批2）**：前后两次采集不是同一次运行，也不共享同一窗口结构。本表所有数字都用**同一套脚本、同一份函数名单**对两侧的原始产物复算得出（脚本随交付物入库：`scripts/perf-probes/shiki-family.mjs`，与验收探针 `scripts/perf-probes/perf-shiki-worker.mjs` 同一 SHIKI_FAMILY_RE），但**跨运行的绝对差含采集噪声**（GLM 审查实证同场景跨运行差异 ≥2.7×）。因此结论只承载**量级与方向**，不承载精确百分比；凡涉及"前/后"的差，一律同时给出绝对值和窗口占比两个口径。

## 0. 采集 harness

| 项 | before（基线） | after（本批） |
|---|---|---|
| 宿主 | dev 实例（`TAIJI_DEV_BACKGROUND=1`，后台不可见窗口） | 同左（+ `--disable-backgrounding-occluded-windows`：被全遮挡时 Chromium 停发 rAF 会令流式渲染不落 DOM，验收探针 DOM 断言假红——dev-electron.mjs 的 `TAIJI_DEV_EXTRA_CHROMIUM_FLAGS` 逃生舱注入，见 harvest 报告） |
| faux 脚本 | `~/.taiji-dev/verify-prof-20261123-1730/agent/faux-responses.json`（200TPS，首轮响应 45,326 字符 / 11,412 token，第 5–605 行单个 ~600 行 ts fence） | 同左 |
| session | 新 session + 首条 prompt | 同左 |
| renderer CPU | CDP Profiler，无 tracing | 同左（T1 探针 `--save .run/b3-after-renderer.cpuprofile`） |
| 打包版 TaiJi.app | 在跑（审查会话宿主） | 在跑（采集期间重启过一次，窗口位置被人为挪开过——见 §5 C4） |

基线原始产物（**只读，未重测**）：`~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data/run-notrace-renderer.cpuprofile`（CPU 权威数据集，流式窗 +10..+73s；GLM 审查 C4 实证 fence 闭合突发出现在 +50..+55s、complete（+73s）处 shiki 为零）。

**基线数字口径**：before 列由 `scripts/perf-probes/shiki-family.mjs` 对基线 cpuprofile 离线复算（与批1 `analyze-cpuprofile.mjs` 同源窗口）。after 列由同一脚本对 T1 保存的 profile 在 send-relative 窗复算。

## 1. fence 闭合窗口主线程占用（核心指标：shiki 帧 self-time）

口径：`node scripts/perf-probes/shiki-family.mjs <profile> <relFromS> <relToS>`（SHIKI_FAMILY_RE 覆盖 findNextMatchSync / #execCore / codeToHtml / shiki_core / collectExternalReferences* 等全部高亮相关帧）。fence 闭合窗口 = 基线 profile 相对 +50..+55s（GLM 审查 C4 定位的突发区，send-relative ≈ +40..+45s）；after 侧取高亮回填前后各 5s（63.9..69.2s，T1 探针日志定位）。

| 口径 | before（+50..+55s，5.0s 窗） | after（63.9..69.2s，5.3s 窗） | 变化 |
|---|---|---|---|
| **shiki 族 self-time** | **2.330s** | **0.003s** | **−99.9%**（−2.327s） |
| ├ findNextMatchSync | 1.136s | —（无） | 归零 |
| ├ #execCore | 0.556s | —（无） | 归零 |
| └ 其余 100 帧（compile/toRegExp/scanNext/enter…） | 0.638s | 0.003s（仅客户端 postMessage 派发帧 `resolveFenceHighlights @ shiki-highlight-client.ts`） | 归零 |
| **占窗口比例** | **46.6%**（主线程近半时间被同步高亮占死——即用户可感知的 1.2–3.3s 硬冻结） | **0.06%** | 冻结消除 |

## 2. 整条流式窗前后

| 口径 | before（+10..+73s，63.0s 采样） | after（0..69.2s，69.2s 采样） | 变化 |
|---|---|---|---|
| shiki 族 self-time | **2.961s**（134 帧） | **0.017s**（10 帧） | **−99.4%**（−2.944s） |
| 占流式窗采样时长 | 2.961 / 63.0 = **4.7%** | 0.017 / 69.2 = **0.02%** | −4.7 个百分点 |
| after 侧 10 帧构成 | — | 0.003s 客户端派发 + 0.014s 主线程 grammar/theme 模块顶层求值（静态 import 的模块初始化，非高亮；codeToHtml 相关帧为零） | 高亮本体 100% 移出 |

> 注：after 侧残留的 0.017s 里没有一帧是 tokenize/codeToHtml——高亮计算全部发生在 worker 线程（CDP renderer profile 只含主线程，worker 成本不经此口径，见 §3）。主线程侧新增成本仅 = 每 fence 一次 postMessage 派发（微秒级）。

## 3. worker 侧成本登记（一次性 + 每 fence）

worker 线程的成本不进主线程 profile（§2 口径外），由 worker 侧 log 消息回传主线程 console、T1 探针采集登记：

| 成本项 | 实测值 | 说明 |
|---|---|---|
| worker 脚本加载 | 一次/页生命周期；dev = Vite 模块请求（worker chunk 与主 chunk 共享 shiki 模块图），打包 = file:// 同源 asset | 净增产物 = 一份自包含 worker chunk（**888K**，实测 `pnpm --filter @taiji/frontend build`：dist 9.1M → 10M，主 bundle 字节不变——主线程 shiki 副本留给降级路径，属既有存量） |
| shiki 引擎在 worker 内初始化 | **188–629ms**（多次采集；13 grammar + 2 theme + JS 正则引擎装配） | 一次/worker 生命周期；与主线程原初始化同量级，但移出主线程且不阻塞首屏（主线程副本改惰性：常规聊天路径不建 shiki 引擎） |
| 每 fence 高亮 job | **5.5–16.4s**（负载相关；同一 600 行 fence 在主线程的原同步成本 ≈ 2.3–2.5s） | worker 与主线程跑同一份 codeToHtml；wall-clock 变长是 CPU 争抢下 worker 线程调度优先级的结果（采集期 load 8–35），**主线程零占用**是本质收益。T1 日志实测：closure job + finalize job 各一次（同 fence 两次渲染各一次往返） |
| 内存常驻 | worker 持一份 shiki 引擎（grammar/theme JS 对象）；主线程副本惰性 | 不主动回收 worker（页生命周期复用；回收再建 = 重复 init 成本） |

## 4. 高亮正确性（T2：worker 产物 vs 主线程同源算法）

对拍判据 = 同一 fixture 代码块最终 HTML 归一化后逐字节一致（两侧均在真实浏览器内采集：worker 路径 vs `window.Worker` 打桩逼出的主线程降级路径；归一化含标签间空白折叠 + class 令牌排序 + HTML 实体解码）。

| 口径 | 结果 |
|---|---|
| 600 行 fence（27,010 字符）最终 HTML 对拍 | **identical=true（720 span 全同）**（T2 PASS） |
| 采集方法修正记录 | ① 早先 Node 侧重算期望值不可用——oniguruma-to-es 的 JS 引擎在 Node 22 与 Chromium 142 两个 V8 上对空串字面量 `""` 的 tokenize 不同（V8 版本 skew 假红）；② 引擎每实例**首次** codeToHtml 对 `""` 与后续调用不同（warmup 效应，两条路径同源、批3 前的主线程路径同样受影响，非本批引入）——故对拍前强制一次重渲染（切走再切回）取 warmup 后稳定产物。warmup 效应已登记进 prune findings 说明与 harvest 报告 |

## 5. 可比性声明与残余风险

| # | 事项 | 影响 | 处置 |
|---|---|---|---|
| C1 | before/after 是**两次不同运行** | 绝对差含运行间噪声（≥2.7×） | 同一脚本/名单复算；只取量级与方向 |
| C2 | 窗内组成不同（after 窗含刷新后 app 就绪段；基线含 pi 冷启动段） | 全窗口径低估 after 收益 | 同时给 fence 闭合子窗口径（§1） |
| C3 | 两侧 dev 窗口后台不可见，Chromium 对不可见窗口降帧 | FPS 绝对值不可信 | 不作 FPS 结论；after 侧加 `--disable-backgrounding-occluded-windows` 只为保 rAF 续跑（渲染可落 DOM），不影响 CPU 口径 |
| C4 | 采集期间打包版 TaiJi.app 重启、且其窗口曾全遮挡 dev 窗口 | 前者 = 竞争噪声；后者曾致 rAF 停摆 → 渲染延迟落 DOM（探针轮询预算内收敛，已用 flag 消除） | 如实标注；after 侧采集窗口均在 rAF 正常态 |
| C5 | worker job wall-clock（5.5–16.4s）长于主线程原同步成本（2.3–2.5s） | 高亮**到达时间**变晚（complete 后数秒内落 DOM；重负载下更久）——感知形态从「冻结」变为「短暂占位」 | 设计取舍（审查 F3：与块大小无关的解的唯一代价）；流式期占位本就存在（G2 保留），用户感知为占位多停数秒而非界面冻结 |
| C6 | worker 挂死（病态输入 ReDoS 类）无自动恢复 | ADR-0190 禁墙钟判死 → fence 渲染停滞至应用重启 | prune P4 登记；对比基线是同输入下主线程全UI冻结（更糟），失败可观测（占位永不消）；shiki 抛错类失败走 jobError 单 job 回退 |
| C7 | 移动壳（runtime HTTP 托管态）未采 after CPU | 无前后对比 | 构建产物已验证（worker chunk 产出 + CSP worker-src 'self'）；移动壳非本次采集环境 |
| C8 | 引擎 warmup 效应（首实例首次调用对 `""` 的 tokenize 差异） | 影响 T2 对拍方法（已用强制重渲染规避） | prune 说明 + §4 记录；两条路径同源，非本批引入 |

## 6. 与题面对齐

| 题面（GLM 审查 F3 / C4 / M6 / D6） | 本表证据 |
|---|---|
| 「fence 闭合的高亮移出主线程（Worker）……主线程零成本、与块大小无关」 | §1 闭合窗口 2.330s → 0.003s；§2 整窗 2.961s → 0.017s（高亮帧 100% 移出） |
| 「分帧 tokenize 对单块无效 / 可视区优先粒度不匹配」→ 不做 | 设计文档显式不做表登记（shiki 无增量 tokenize 接口；virtua 粒度是 turn） |
| 「流式期继续走 streaming-fence 占位不跑 shiki——保留」 | T4 真机：流式中途占位在场且无 shiki 产物；complete 后占位消失 + 高亮在场（leaf 全绿） |
| 「失败降级：worker 不可用 → 回退主线程同步高亮，高亮不丢」 | T3 真机：Worker 打桩 → degrade → 主线程回退，720 span 全量高亮 + 降级出声 |
| 「CSP 评估 + worker-src 放行登记」 | T5 真机（file:// 打包态 + http dev 态双形态 OK）；设计文档「CSP 一次性评估」节；两壳 index.html 显式 `worker-src 'self'` |
| 「一次性成本登记（worker 加载 + 引擎初始化 + 内存常驻）」 | §3 全项实测登记（888K chunk / init 188–629ms / 每 fence 5.5–16.4s / 内存一份） |

## 7. 复算命令（任意 cwd，仓库根）

```bash
P=~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data
# shiki 族 self-time（fence 闭合窗口）
node scripts/perf-probes/shiki-family.mjs $P/run-notrace-renderer.cpuprofile 50 55        # before
node scripts/perf-probes/shiki-family.mjs .run/b3-after-renderer.cpuprofile 63.9 69.2     # after
# shiki 族 self-time（整条流式窗）
node scripts/perf-probes/shiki-family.mjs $P/run-notrace-renderer.cpuprofile 10 73        # before
node scripts/perf-probes/shiki-family.mjs .run/b3-after-renderer.cpuprofile 0 69.2        # after
# after 侧原始产物可由 T1 验收 case 重新生成：
#   node scripts/perf-probes/perf-shiki-worker.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --sid <sid> --threshold-s 0.3 --save .run/b3-after-renderer.cpuprofile
```
