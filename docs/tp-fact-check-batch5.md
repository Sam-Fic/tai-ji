# 事实核查 · 批5「干净重测 + GPU 据实决策」

> 规则：设计只准建立在事实上 + 推断须登记进未核实风险 + 虚构作废并删除依赖它的方案分支。证据 = 文件:行号 / 探针输出 / 命令输出（均可复跑，命令见 acceptance.md 与 api.md）。

## 一、论据三分类

| # | 论据 | 分类 | 证据 |
|---|---|---|---|
| F1 | production 模式构建已消除 renderer 侧的 dev 专属插桩：prod bundle 中 `performance.mark` / `performance.measure` / `validateProps` / `__VUE_DEVTOOLS_GLOBAL_HOOK__` / `devtoolsRawSetupState` / `vue-i18n:` 命中数均为 0 | 事实 | docs/perf/final-measurement/build-probe-grep.txt:8 （六串全 0 的原始输出 + 判据修正记录同文件 :1-6——`friendlyJSONstringify` 是 vue-i18n 生产实现、`ResizeObserver loop` 是本仓噪声过滤器常量，两者已从判据中剔除） |
| F2 | minified prod bundle 的函数名被 mangle，CPU 归因不可用 + `vite build --minify false`（仍 production 模式）后全部在场 | 事实 | docs/perf/final-measurement/build-probe-grep.txt:16 （minified 全 0）与 :18 （--minify false 后 railMemoFor=18 / summarizeAssistantForRail=5 / stripMarkdown=5 / buildStreamViewItems=2） + dist 体积 18M |
| F3 | 首轮原始基线数据集完整在位（44MB） | 事实 | .run/b5-evidence/baseline-archive-ls.txt:13 与 :17 （run-notrace-renderer.cpuprofile 与 run2d-renderer.trace.json 两件权威 + 末行为 `du -sh` = 44M） |
| F4 | 34 个 commit 未触达 `apps/electron/`（顶层分布见证据 + apps/electron 零命中 ⇒ main/preload dist 无需重建） | 事实 | .run/b5-evidence/baseline..HEAD-nameonly-by-topdir.txt:1 （packages/ui 16 起 + 全文 50 行无 apps/ 条目） |
| F5 | `@taiji/ui` 与 `@taiji/core` 的 exports 指向 src ⇒ 一次 renderer build 即捕获三包改动 | 事实 | packages/ui/package.json 第 3 行（`"main": "src/index.ts"`）与 exports 全为 ./src/* + packages/renderer/vite.config.ts 第 31 行 alias 无 ui/core 覆写 |
| F6 | runtime 进程无 SIGUSR1 handler（tsx cli 与 runtime src 均无）⇒ Node 默认行为「SIGUSR1 激活 inspector」可用 | 事实 | `grep -rn SIGUSR1 packages/runtime/src apps/electron/main node_modules/tsx/dist/cli.mjs` 仅命中 packages/runtime/src/infra/infra-root-bundle.test.ts 第 272 行（测试断言子进程被信号杀死，非 handler 注册） |
| F7 | 端口三通道可外部注入：runtime = BASE_PORT(3210) + TAIJI_AGENT_PORT_OFFSET + CDP = TAIJI_CDP_PORT + renderer URL = TAIJI_VITE_DEV_URL | 事实 | packages/shared/src/constants.ts 第 8 行 与 apps/electron/main/supervisor/port-discoverer.ts 第 36 行 与 apps/electron/scripts/dev-electron.mjs 第 162 行 与 apps/electron/main/window/window-factory.ts 第 46 行 |
| F8 | dev-instance.mjs 路径会无条件覆写 TAIJI_VITE_DEV_URL 为 vite dev server 端口 ⇒ 本 harness 必须直起 dev-electron.mjs | 事实 | apps/electron/scripts/dev-instance-lib.mjs 第 145 行（`env.TAIJI_VITE_DEV_URL = ...p.vitePort`） |
| F9 | 静态伺服的 renderer 可连 runtime WS：CSP 允许 `ws://localhost:*` + waitForVite 只要求 HTTP 2xx | 事实 | packages/renderer/index.html 第 37 行（connect-src） + apps/electron/main/window/window-factory.ts 第 136 行起（waitForVite 实现） |
| F10 | EdgeFade 现状（GPU-6/7 的被裁对象）：四层 backdrop-blur 1/2/4/8px + 一层沉色渐变 + 容器 mask 五 stop + 激活判定 = 贴顶哨兵 IO 投递，scroll 回调零几何读 + prefers-reduced-transparency 时整效关闭（遮罩 hidden + mask 摘除） | 事实 | packages/renderer/src/components/ui/edge-fade/EdgeFade.vue:39 （LAYERS）与 :55 （MASK_ACTIVE）与 :92 （IO 绑定）与 :62 （applyMask 降级） |
| F11 | faux 脚本契约支持 thinking / text / toolCalls 三形态，四个演员模型含 faux-1-reasoning（reasoning 为 true） | 事实 | packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts:65 （ScriptedStep）与 :150 （模型表） + 已 seed 的 `agent/models.json` 注册全部四个 |
| F12 | 打包版 TaiJi.app 在跑且本会话宿主即该应用（session 数据目录在 `~/.taiji/ext-sessions` 下，即打包态 getDataDir）⇒ 不可安全关闭，登记受限条件 L1 | 事实 | .run/b5-evidence/electron-procs.txt:3 （pid 11504 /Applications/TaiJi.app/Contents/MacOS/TaiJi） + 本 session artifacts 路径由宿主注入 |
| F13 | 测量前瞬时负载已落安静区（load 1m 2.65，CPU idle 84%），但 1 小时前曾 27.98 ⇒ 采集前必须复测 load | 事实 | .run/b5-evidence/uptime-samples.txt:3 （23:09 采样 load 2.65/3.71/4.86）与 :6 （idle 84.27%） + 21:50 采样 1m 27.98 见题面开局环境事实 |
| F14 | 首轮 pi profile 的采集手段 = mock-pi 置换为 node launcher + Bun SEA 不食 NODE_OPTIONS 且 SIGUSR1 会杀死它 | 事实 | docs/perf/perf-measured-report.md:20 与 :666 （launcher 代码留档）与 :15 （数据文件名） |
| F15 | analyze-gpu-union.mjs 已是 union 口径（墙钟跨度 + 每线程 union + Present/Raster/GPUTask 统计），本批直接复用 | 事实 | probes/analyze-gpu-union.mjs 第 3 行起（头注对齐 GLM M1 口径） |
| F16 | 首轮 GPU trace 墙钟仅 33.67s 且未覆盖 fence 闭合，根因 = Tracing.start 未指定 recordMode（默认 record-until-full）且不处理 dataLoss | 事实 | probes/gpu-trace.mjs 第 109 行（批1 版 Tracing.start 仅 categories + transferMode） + docs/perf/adversarial-review-glm.md 第 66 行起（A6 复算） |
| F17 | 三臂注入手段可经 CDP 完成：CSS 注入 = Runtime.evaluate 追加 style + prefers-reduced-transparency 模拟 = Emulation.setEmulatedMedia | 事实 | packages/renderer/src/components/ui/edge-fade/EdgeFade.vue:104 （matchMedia 监听 = 模拟值的消费点） + 探针实装 probes/gpu-trace.mjs:136 （setEmulatedMedia）与 :125 （no-blur 注入） |
| F18 | 首轮流式窗长度不可复现：faux 200TPS 的实际流式时长在 48-155s 区间波动（事件循环影响配速）⇒ 固定墙钟窗不可用 | 事实 | docs/perf/adversarial-review-glm.md:23 （A1 四次运行 53/74/48/155s）与 :66 （A6 trace 33.67s） |

## 二、推断与未核实风险

I1（SIGUSR1 能否在 tsx 壳上激活 inspector）、I2（minify 差异）、I3（三臂测的是增量而非 blur 专属计时）、I4（checkout 舞蹈不破坏宿主会话）、I5（打包版 idle 污染量级）、I6（prod bundle 上派生生族仍可归因）——逐条见下节「未核实风险（事实核查编号 I*）」。

| # | 推断 | 分类 | 升级条件 |
|---|---|---|---|
| I1 | SIGUSR1 在 tsx 壳上能激活 inspector（F6 只证「无 handler 覆盖」，未证默认行为生效） | 推断 | M1 首跑时 `curl 127.0.0.1:9229/json/list` 出现 target 即升为事实 + 失败则回退 `NODE_OPTIONS=--cpu-prof`（只在本探针进程树内设置，本 harness 已不起 vite dev server，无 A7 的 vite 污染） |
| I2 | `--minify false` 与发布 bundle 的差异仅限 minify，对加载后流式窗行为影响可忽略 | 推断 | 若同一 HEAD 的两个 bundle 在 renderer 流式窗占用率上差异超过跨运行噪声（首轮实证 ≥2.7×），则改为报告 minify 口径差异 |
| I3 | 三臂实验测到的是 compositing/raster 增量，不是 blur 专属 GPU 计时器 + 增量落在噪声内 ⇒ 结论「不可证」而非「无成本」 | 推断（方法学边界） | 若 no-blur 与 full 的 Raster union 差 > 2× 跨运行噪声，则升为「blur 成本可分离」 |
| I4 | baseline checkout 舞蹈不破坏运行中的宿主会话（打包版 runtime 读 `~/.taiji`，其 pi 的 extensions 来自 `/Applications/TaiJi.app/Contents/Resources/extensions`） | 推断 | ps 已证打包版 pi argv 的 --extension 全指 /Applications（F12 附带证据） + 若宿主出现异常再复核 |
| I5 | 打包版 TaiJi.app idle 态对 GPU/FPS 的污染可压到「次要」量级（另一合成器在位但无主动渲染） | 推断 | 采集时瞬时 CPU 若非近 0% 则重测（L1 纪律，落 env.json） |
| I6 | 干净基线的 O(n²) 派生生族在 prod bundle 上仍可归因（函数名保留 + dev/prod 同量级） | 推断 | F2 已证名字可归因 + GLM A2 已证 dev/prod 同量级（docs/perf/adversarial-review-glm.md 第 43 行起） |

## 三、虚构（已作废）

| # | 原主张 | 分类 | 处置 |
|---|---|---|---|
| X1 | 用完整 `pnpm build` 打包形态做本批测量 | 虚构 | 作废：打包版 TaiJi.app 是本会话宿主，同 bundle 第二实例受单实例锁与数据目录竞争阻塞（F12）。降级为纪律 1 的第一选项（production 模式 vite build 产物）并显式声明残留偏差（main/runtime/pi 仍 dev 形态） |
| X2 | GPU trace 与三进程 CPU profile 可在同一次运行内同采 | 虚构 | 作废：GLM A3 实证 tracing 同开会把整条管线 CPU 放大（非 i18n 部分也膨胀，docs/perf/adversarial-review-glm.md 第 47 行起）。CPU 与 GPU 分两次运行采（同 harness 同 fixture），报告声明该分工的依据 |

## 四、外部接口核实表

| 接口 | 依据 | case |
|---|---|---|
| CDP `Profiler.enable/start/stop`（renderer target，无 tracing） | probes/lib/harness.mjs:287 （captureStreamingProfile 既有实装，批1-4 复用） + docs/perf/batch1-comparison.md:18 （无 tracing 口径） | M1 |
| CDP `Performance.enable` + `getMetrics` | probes/perf-clean-cpu.mjs:216 （本批新增，窗内每秒快照） + 首轮缺失证据 = docs/perf/adversarial-review-glm.md:85 （metrics 全空） | M1 |
| CDP `Tracing.start{options:'record-continuously'}` + `Tracing.dataLossOccured` | probes/gpu-trace.mjs:154 （本批改写） + 首轮缺失对照 = docs/perf/adversarial-review-glm.md:66 | M2 |
| CDP `Emulation.setEmulatedMedia{features:[prefers-reduced-transparency]}` | probes/gpu-trace.mjs:136 （本批新增 arm=reduced） + 消费点 packages/renderer/src/components/ui/edge-fade/EdgeFade.vue:104 | G3 |
| Node inspector（SIGUSR1 激活 / `--inspect` 拉起）+ CDP Profiler | probes/lib/harness.mjs:439 （本批新增 connectNodeInspector/startProfiler/stopProfiler） + runtime 无 handler 证据 = F6 | M1 |
| runtime RPC：`session.create` / `session.subscribe` / `delivery.submit` / `message.complete` | probes/vp/lib/protocol.mjs:35 （reply 别名表）与 :393 （waitTurnEnd 事件集） + probes/lib/harness.mjs:340 （waitForSessionComplete） | M1,M2 |
| pi 二进制解析点（dev 分支） | packages/runtime/src/infra/pi/find-pi-executable.ts:31 （dev 分支优先 resources/pi 下的已 prepare 二进制，实装 :62 拼接） | P1 |
| faux 脚本通道（TAIJI_FAUX_SCRIPT / TAIJI_FAUX_TPS） | packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts:141 （脚本读取）与 :147 （tps 流控） | F1,F2,F3 |
| 端口注入三通道 | packages/shared/src/constants.ts:8 与 apps/electron/main/supervisor/port-discoverer.ts:36 与 apps/electron/scripts/dev-electron.mjs:162 与 apps/electron/main/window/window-factory.ts:46 | M1,M2,M3,M4 |
