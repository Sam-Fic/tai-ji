# 交付物 API · 批5「干净重测 + GPU 据实决策」

## 实例启动（production 模式 renderer bundle）

本批 renderer 走 **production 模式构建 + 静态伺服**（纪律 1），dev Electron 壳只提供主进程/runtime/pi（dev 形态，登记为残留偏差）。

```bash
# ① renderer bundle（production 模式；--minify false 保函数名可归因，见 fact-check F2）
pnpm --filter @taiji/frontend exec vite build --minify false     # → apps/electron/renderer/dist

# ② 静态伺服（vite preview；本 harness 不起 vite dev server——消除其插桩与 WS 转发）
pnpm --filter @taiji/frontend exec vite preview --port 4173 --strictPort

# ③ faux 数据目录预置（四类文件 + 响应脚本）
node .agents/skills/verify-taiji/scripts/seed-faux.mjs <repo> ~/.taiji-dev/verify-b5-final probes/fixtures/original-45k.json --force

# ④ 启动（前台：不设 TAIJI_DEV_BACKGROUND）
TAIJI_AGENT_DATA_DIR=~/.taiji-dev/verify-b5-final \
TAIJI_AGENT_PORT_OFFSET=410 \
TAIJI_CDP_PORT=9488 \
TAIJI_VITE_DEV_URL=http://localhost:4173 \
TAIJI_FAUX_SCRIPT=~/.taiji-dev/verify-b5-final/agent/faux-responses.json \
TAIJI_EXTENSION_PATHS=<repo>/e2e/fixtures/faux-provider-ext \
TAIJI_FAUX_TPS=200 \
TAIJI_DEV_EXTRA_CHROMIUM_FLAGS="--disable-backgrounding-occluded-windows --disable-renderer-backgrounding" \
node apps/electron/scripts/dev-electron.mjs .
```

端口推导（源码事实）：runtime = `BASE_PORT(3210) + TAIJI_AGENT_PORT_OFFSET`（packages/shared/src/constants.ts:8 + apps/electron/main/supervisor/port-discoverer.ts:36）；CDP = `TAIJI_CDP_PORT`（apps/electron/scripts/dev-electron.mjs:162）；renderer = `TAIJI_VITE_DEV_URL`（apps/electron/main/window/window-factory.ts:46）。dev Electron 壳直起（不经 dev-instance.mjs）的原因：dev-instance-lib.mjs:145 无条件覆写 `TAIJI_VITE_DEV_URL` 为 vite dev server 端口——本 harness 的 renderer 不由 vite dev server 供货。

## 探针（命令面）

| 命令 | 用途 | 关键参数 | 输出契约 |
|---|---|---|---|
| `node probes/perf-clean-cpu.mjs --data-dir <dir> --cdp-port <p> [--fixture <json>] [--tag <t>] [--model <provider/id>] [--window-ms <n>] [--expect-head <sha>] [--save-dir <dir>] [--runtime-inspect-port 9229] [--pi-inspect-port 9231]` | 干净 CPU 采集：单次运行内 renderer（CDP Profiler 无 tracing + Performance.enable 指标快照）+ runtime（SIGUSR1→inspector→CDP Profiler）+ pi（mock-pi 置换 launcher `--inspect`→CDP Profiler）三进程 profile；pi 二进制三核对置换/恢复 | `--fixture` 指定 faux 脚本（写入 `<dataDir>/agent/faux-responses.json`）；`--expect-head` HEAD 断言（baseline 枝用）；`--window-ms` = 事件驱动收尾的**上限预算**（用户显式传入，非探针自设墙钟） | 末行 `RESULT clean-cpu tag=<t> profiles=3 renderer-sampled=<s>s renderer-nonidle=<p>% runtime-samples=<n> pi-samples=<n> turn-count=<n> load-1m=<n>`；测量无效 exit 3；pi 恢复失败 exit 4 |
| `node probes/perf-clean-cpu.mjs --verify-pi-only` | pi 置换位三核对（md5 + Mach-O 形态 + 无残留 .b5-bak），不采数据 | — | 末行 `RESULT pi-restore ok=<bool> md5-match=<bool>` |
| `node probes/pi-profile-launcher.mjs` | mock-pi 置换位本体（被 runtime 当 pi 二进制 exec）：透传 argv，`--inspect` 起 pi cli.js，stdio 双向 pipe，**无任何定时关 stdin** | 环境变量 `PI_PROFILE_INSPECT_PORT`（缺省 9231） | 无 stdout 契约（协议转发）；stderr 一行启动标识 |
| `node probes/gpu-trace.mjs --data-dir <dir> --sid <sid> [--cdp-port 9478] [--arm full\|no-blur\|reduced] [--window-ms 110000] [--save <file>] [--shot <file>]` | GPU trace 采集（三臂受控实验）：recordContinuously + dataLoss 监听 + 事件驱动窗长 + 中期截图 + FPS overlay | `--arm no-blur` 注入 `[class*="backdrop-blur"]{backdrop-filter:none!important}`；`--arm reduced` 经 `Emulation.setEmulatedMedia` 模拟 prefers-reduced-transparency | 末行 `RESULT gpu-trace arm=<a> wall-span=<s>s events=<n> dataLoss=<n>`；采集无效 exit 3 |
| `node probes/analyze-gpu-union.mjs <trace.json> [label]` | union 口径分析（墙钟跨度 / 每线程顶层切片 union / Present / ApplyBackpressure / Raster / GPUTask / BeginMainFrame） | — | 多行文本（M1 口径：禁嵌套求和） |
| `node probes/fixtures/gen-fixtures.mjs` | 三种 fixture 形态生成（确定性 LCG，同 seed 同字节） | `--out` 覆写输出目录 | 每个文件一行 `chars=` |

公共 harness：`probes/lib/harness.mjs`（connectRuntime / connectRendererCdp / ensureGuiOnSession / captureStreamingProfile / waitForSessionComplete / windowStats / inclusiveByLabel / selfTimeByLabel；本批新增 `connectNodeInspector` / `captureWindowedProfile` / `readLoadAvg` / `instantCpuOf`）。

## fixture 契约（`probes/fixtures/`）

| 文件 | 形态 | 字符数 | 用途 |
|---|---|---|---|
| `original-45k.json` | 首轮原始 fixture 逐字节副本（单 600 行 fence 占 60% + 180 bullet） | 45,663 | 与首轮基线同场景对齐 |
| `multi-small-fences.json` | 24 个 20-30 行 fence（7 种语言轮换）+ 段落/列表/表格 | 41,010 | 形态覆盖：多小块的前缀缓存与多次 fence 闭合 |
| `tool-calls.json` | 5 轮 × (bash 工具调用 + ~8K 文本)，共 7 次 toolCall | 40,870 | 形态覆盖：工具卡/结果渲染与多 turn 流式 |
| `heavy-thinking.json` | 24K thinking + 22K 正文（模型 faux/faux-1-reasoning） | 46,009 | 形态覆盖：思考块跟底路径（GPU-8 未测项） |

FauxStep 契约 = packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts `ScriptedStep`（`{thinking?, text?, toolCalls?, stopReason?}`；数组 = 统一队列，逐轮 shift 消费）。

## 归档布局（`docs/perf/final-measurement/`）

| 文件 | 内容 |
|---|---|
| `final-renderer.cpuprofile` / `final-runtime.cpuprofile` / `final-pi.cpuprofile` | 干净终版三进程 profile（入库；单个 ≤5MB） |
| `baseline-renderer.cpuprofile` / `baseline-runtime.cpuprofile` / `baseline-pi.cpuprofile` | 干净基线三进程 profile |
| `final-metrics.json` / `baseline-metrics.json` | Performance.getMetrics 窗内快照（TaskDuration/LayoutDuration/RecalcStyleDuration/ScriptDuration） |
| `final-env.json` / `baseline-env.json` | 环境声明（load 1/5/15、端口归属、打包版 TaiJi.app 瞬时 CPU、HEAD、fixture md5、renderer bundle md5） |
| `final-midstream.png` / `baseline-midstream.png` | 流式中期截图（FPS overlay） |
| `gpu-arm-{full,no-blur,reduced}.trace.json` | 三臂 trace（若体积超限则仅存分析输出，trace 本体入会话 artifacts） |
| `*-analysis.txt` | 各探针/分析脚本的原始输出（复算锚点） |

> 大 trace.json（~30MB/个）原则上入本会话 artifacts 目录并在报告给绝对路径；入库仅保留分析输出与体积受控产物。

## 基线采集（一次性流程，归档后由 `analyze-clean-cpu.mjs` 复算）

基线与终版必须同 harness。因为「同 harness」要求同一份代码的 dev 实例，基线只能在 checkout 到
`eff28e4a5` 的窗口内采一次（gate 在 HEAD 上跑，所以这一步不进球 gate，产物入库后由 M3 机器复算）。

```bash
# 0) 停 HEAD 侧实例（端口 + 明确路径逐个甄别；遵守全局击杀纪律）
for p in 4173 9488 3620; do lsof -nP -iTCP:$p -sTCP:LISTEN -t; done   # 逐个 ps -o command= -p <pid> 确认后再 kill

git checkout eff28e4a5
pnpm --filter @taiji/frontend exec vite build --minify false     # 基线侧的 production bundle
node .agents/skills/verify-taiji/scripts/seed-faux.mjs . ~/.taiji-dev/verify-b5-baseline probes/fixtures/original-45k.json --force
DATA_DIR=~/.taiji-dev/verify-b5-baseline PREVIEW_PORT=4174 CDP_PORT=9489 PORT_OFFSET=411 bash probes/b5-start-instance.sh &

node probes/perf-clean-cpu.mjs --data-dir ~/.taiji-dev/verify-b5-baseline --cdp-port 9489 \
  --fixture probes/fixtures/original-45k.json --tag baseline --expect-head eff28e4a5f39743782066f6055532924a8ffea8c \
  --window-ms 200000 --save-dir docs/perf/final-measurement
node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-baseline --cdp-port 9489 --arm full --window-ms 160000 \
  --save <artifacts>/b5-traces/baseline-gpu.trace.json --shot docs/perf/final-measurement/baseline-midstream.png

# 采完立刻回 HEAD 并重建 bundle，再复验 HEAD 与 bundle 标识（防「测了 A 报成 B」）
git checkout feat-cpu-gpu-performance && pnpm --filter @taiji/frontend exec vite build --minify false
```

## 存储 / 挂点

不适用：本批无新增存储、无新增挂点、无协议变更（WS 协议、CDP 用法、faux 脚本格式均沿用既有契约）。

## 日志

不新增产品日志。探针自身的诊断输出走 stdout/stderr（采集有效性拒绝时给可操作提示）；pi 置换/恢复的审计行走探针 stderr（含 md5 前后值）。
