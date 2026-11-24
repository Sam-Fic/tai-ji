# 设计文档 · 批5「干净重测 + GPU 据实决策」

> 分支 `feat-cpu-gpu-performance` · 前置 = 批1/2/3/4 已 delivered（HEAD `4a8e0f147`，34 commit 未推送）。
> 依据 = [adversarial-review-glm.md](../perf/adversarial-review-glm.md) A6/A7/A8/A9/S3/S4/S7/F5/M8（本批直接依据）+ 各批对比表（[batch1](batch1-comparison.md)~[batch4](batch4-comparison.md)）。
> 前后对比口径照批1-4（同脚本同名单、跨运行差含噪声、结论只承载量级与方向）；本批新增「干净 harness 双测量」把 harness 变量与代码变量分离（见下）。

## 背景与目标

批1-4 的优化已全部落地，但**前 4 批的 before 侧全部继承自首轮测量**——而首轮测量被 GLM 对抗审查判定有未披露混杂（M8：打包版 TaiJi.app 全程并存且 GPU helper 64% CPU / renderer 44%；dev 后台窗口被遮挡降帧；三进程数据来自 4 次相隔 40 分钟~2 小时的运行；流式时长 48-155s 不等；GPU trace 墙钟只有 33.67s 且是流式最轻前段、未覆盖 fence 闭合；`Performance.getMetrics` 全空；多个原始文件未归档）。本批做两件事：

1. **干净重测**：按审查清单（S7 + F5 重测清单）消除全部混杂，对最终代码采一次可引用的终版数据；**同时用同一干净 harness 重测原始代码**（pre-batch1 = `eff28e4a5`），使「5 批累计收益」第一次成为**同 harness 直接测量**而非跨 harness 拼接。
2. **GPU 据实决策**：审查明确「拿到干净 GPU 数据前不动 EdgeFade blur/mask 的视觉」（S3/D6/F5）。本批用干净 trace + 受控 A/B 实验裁决 GPU-6（四层 backdrop-blur 降档）与 GPU-7（容器 mask 下沉）。

| 编号 | 目标 | 题面原句（逐字） | 限定词落点 | case/落点 |
|---|---|---|---|---|
| G1 | 干净环境下采齐三进程 profile + GPU trace | 「干净环境下采齐三进程 profile + GPU trace（满足全部测量纪律）」 | 8 条纪律逐条落（见「干净测量纪律」节）；无并存 Electron 的受限条件 L1 显式登记 | M1,M2,M3 |
| G2 | 终版同场景前后对比表（对原始基线） | 「产出最终版『同场景前后对比表』（对原始基线），证明 5 批优化的累计收益（CPU+GPU）」 | 三列口径 = 首轮原始基线（脏 harness）/ 干净基线（原始代码）/ 干净终版（HEAD）；同 harness 双测量隔离 harness 变量 | M1,M2,M3 |
| G3 | GPU 悬置项据干净数据裁动/不动 | 「GPU 悬置项（EdgeFade blur/mask）据干净数据做出『动/不动』决策并记录依据」 | 三臂 A/B（full / no-blur / reduced-transparency）测 compositing+raster 增量；不可证则登记「本环境不可证 + 需要的测量手段」 | G1,G2,G3,G4 |
| G4 | 全项目汇总报告（含前后火焰图对比索引） | 「产出全项目汇总报告（含前后火焰图对比索引）」 | 5 批累计 CPU+GPU+TTFT + 各批收益归因表 + 数据文件索引 + 残余风险 | M1,M2,M3 |
| G5 | 补 fixture 形态覆盖的复测结论 | 「补充 fixture 形态覆盖（多小代码块 + 工具调用 + 重 thinking）的复测结论」 | 三种形态各测一轮（同 harness 同探针），结论进汇总报告 | F1,F2,F3 |

## 验收是什么

本批验收重点是**「测量有效性」本身**：干净 harness 三进程同运行采集、recordContinuously 无 dataLoss、事件驱动窗长覆盖 fence 闭合与 complete、load 门与 HEAD 断言拒绍脏数据——占位与空数据一律 exit 3 而非假绿。
验收判据 = [tp-acceptance-batch5.md](tp-acceptance-batch5.md)（本任务的 acceptance.md）的实机 case 全绿。
| G5 | 补 fixture 形态覆盖的复测结论 | 「补充 fixture 形态覆盖（多小代码块 + 工具调用 + 重 thinking）的复测结论」 | 三种形态各测一轮（同 harness 同探针），结论进汇总报告 | F1,F2,F3 |

## 干净测量纪律（题面 8 条 → 落地手段）

| # | 纪律 | 落地手段 | 残留偏差 |
|---|---|---|---|
| 1 | prod 构建（至少 `--mode production` 的 vite build 产物） | `pnpm --filter @taiji/frontend exec vite build --minify false`（**production 模式 + 关 minify**）+ `vite preview` 静态伺服，经 `TAIJI_VITE_DEV_URL` 注入 dev Electron 壳 | minify 关闭（见 F2：minified 产物函数名被 mangle，CPU 归因不可用）；dev 主进程/runtime/pi 仍 dev 形态（tsx/jiti）——renderer 侧 dev 扭曲（HMR client / Vite 转发 / vue-i18n mark+measure / Vue dev 构建）已消除（F1） |
| 2 | 窗口前台可见 | 不设 `TAIJI_DEV_BACKGROUND`（dev-instance 透传该值才走 showInactive） | 无 |
| 3 | 无其他 Electron 并存 | 测量前枚举并停掉本 worktree 的 dev 实例（端口+明确路径，遵守全局击杀纪律）；**打包版 TaiJi.app 是本会话宿主（session 数据目录 `~/.taiji/ext-sessions`），不可安全关闭 → 登记受限条件 L1**：实测其采集期瞬时 CPU（近 0% 才采，否则重测） | L1：另一合成器在位（idle 形态）；其 GPU helper/renderer 的瞬时 CPU 逐次记录进环境声明 |
| 4 | 同一运行内采齐三进程 | 新探针 `probes/perf-clean-cpu.mjs`：单次运行内 renderer（CDP Profiler，无 tracing）+ runtime（SIGUSR1 → inspector → CDP Profiler）+ pi（mock-pi 置换为 node launcher，`--inspect` → CDP Profiler），同一 send 锚点、事件驱动收尾（`message.complete`） | pi 进程形态 = node + cli.js（非 Bun SEA，见 F6）——绝对 CPU 不可与真 Bun pi 比；流式窗内 pi 的角色（事件转发/序列化）不变 |
| 5 | Tracing recordContinuously + dataLoss 处理 | `probes/gpu-trace.mjs` 增补：`options:'record-continuously'` + `Tracing.dataLossOccured` 监听（记录丢失事件数，丢失 >0 在报告显式登记）+ 窗长按流式实际长度事件驱动延长（覆盖 fence 闭合与 complete） | 无 |
| 6 | Performance.enable 交叉验证 | renderer CDP `Performance.enable` + 窗内每秒 `Performance.getMetrics` 快照 → TaskDuration/LayoutDuration/RecalcStyleDuration/ScriptDuration 与 (program) 占比对账 | 无 |
| 7 | 补 fixture 形态 | `probes/fixtures/gen-fixtures.mjs` 生成三种形态（多小代码块 24 fence / 工具调用 7 次 bash / 重 thinking 24K），体量与 original-45k 对齐（40-46K 字符） | 合成语料 ≠ 真实对话语义；结论只承载「形态覆盖无回归/无新热点」 |
| 8 | 归档全部原始文件 | 采集产物三处分层：① `.cpuprofile`/截图/日志 → `docs/perf/final-measurement/`（入库，体积受控者）；② 大 trace.json（~30MB/个）→ 本会话 artifacts（不入库，报告给绝对路径）；③ 分析中间产物 → `.run/`（gitignore） | 无 |

## 树形拆分

主干 = **干净测量基建**（在当前 HEAD 上先跑通一次完整采集，证明 harness 自身有效且「三进程同运行 + recordContinuously + Performance.enable」可复现）。

主干文件清单：
- probes/
- docs/tp-design-batch5.md
- docs/tp-acceptance-batch5.md
- docs/tp-api-batch5.md
- docs/tp-fact-check-batch5.md
- .tree-plant.json

一枝一目标：

| 枝名 | 目标 | 依赖 | 风险级 | 文件 | case |
|---|---|---|---|---|---|
| B-measure（主干） | G1 的 harness：三进程同运行采集探针 + pi 置换 launcher + GPU trace 补强 + 三种 fixture + `.tree-plant.json` docs 键覆写 | — | 高（测量基建坏 = 全批数据不可引用） | probes/perf-clean-cpu.mjs, probes/pi-profile-launcher.mjs, probes/gpu-trace.mjs, probes/lib/harness.mjs, probes/fixtures/*, .tree-plant.json, docs/tp-*-batch5.md | M1,M2 |
| B-clean-final | G1/G2 的 after 侧：HEAD 代码的干净 CPU + GPU 采集与归档 | trunk | 中 | docs/perf/final-measurement/*, probes/*（探针修正） | M1,M2 |
| B-clean-baseline | G2 的 before 侧：`eff28e4a5`（pre-batch1）代码的干净 CPU + GPU 采集（含 git checkout 舞蹈与 HEAD 断言） | trunk | 高（工作区状态风险） | docs/perf/final-measurement/baseline-* | M3,M4 |
| B-gpu-decision | G3：三臂 A/B（full / no-blur / reduced-transparency）+ 裁决文档 | trunk | 中 | docs/perf/gpu-decision.md, docs/perf/final-measurement/gpu-* | G1,G2,G3,G4 |
| B-fixture-forms | G5：三种 fixture 形态各一轮（HEAD 代码） | trunk | 低 | docs/perf/final-measurement/form-* | F1,F2,F3 |
| B-final-report | G2/G4：终版对比表 + 汇总报告 | B-clean-final, B-clean-baseline, B-gpu-decision, B-fixture-forms | 中 | docs/perf/final-comparison.md, docs/perf/final-summary.md | 不可机验：报告撰写 |

> checkout 舞蹈的安全规程（B-clean-baseline）：dev 实例必须已停（runtime 是 tsx 直读工作区源码，混码即数据污染）；测量探针启动时断言 `git rev-parse HEAD` = 目标 commit，不符即 exit 3；测完立即 `git checkout feat-cpu-gpu-performance` 并复验 HEAD + `git status` 干净。apps/electron 在 34 个 commit 中零改动（F4）⇒ main/preload dist 无需重建；renderer bundle 需按各侧代码分别构建（ui/core/renderer 均经 workspace src 进 bundle，F5）。

## 方案要点

### B-measure：三进程同运行采集（`probes/perf-clean-cpu.mjs`）

单次运行内按序：

1. **前置校验**：load 采样（`uptime` 1 分钟均值，>15 拒绝采集并提示等安静窗）；HEAD 断言（baseline 枝）；pi 二进制 md5 记录；`lsof` 确认 CDP/runtime 端口归属本实例。
2. **pi 置换**：`mv pi-darwin-x64 pi-darwin-x64.b5-bak` + 安装 `probes/pi-profile-launcher.mjs`（chmod +x，shebang `#!/usr/bin/env node`）。launcher = 原样透传 runtime 给的 argv，`spawn(execPath, ['--inspect=9231', CLI, ...args], stdio: pipe)` 并双向 pipe stdin/stdout——**不设任何关 stdin 定时器**（pi 生命周期归 runtime，禁时间机制）；探针显式 CDP Profiler.start/stop 取窗口化 profile，无 flush 依赖。退出时**三核对恢复**（mv 回 + md5 比对 + `file` 形态）。
3. **runtime inspector**：`kill -USR1 <runtimePid>`（Node 默认行为激活 inspector，端口 9229；F6 实证 runtime 源码与 tsx cli 均无 SIGUSR1 handler）→ 轮询 `http://127.0.0.1:9229/json/list` 直到出现 → CDP Profiler。
4. **renderer**：CDP `Profiler.enable/start`（**无 tracing**）+ `Performance.enable` + 每秒 `getMetrics` 快照（异步累积，不进采样栈）。
5. **锚点与收尾**：`delivery.submit`（clientUuid）为 t0；等 `message.complete`（事件驱动，非固定窗；超时 = 用户显式传入预算，到期弃测 exit 3 不杀进程）→ 停三个 profiler → 落盘 3 个 cpuprofile + metrics.json + env.json（load / ps 快照 / 端口归属 / 打包版瞬时 CPU）。
6. **有效性双断言**（沿用批1-4 纪律）：各 profile 采样量 ≥ 窗长 50% + 窗内非 idle ≥ 2%（renderer）；pi/runtime 以「样本数 > 0 且 send 相对窗内有样本」为据。任一不满足 → exit 3，**拒绝产出 PASS/FAIL**。

### B-gpu-decision：三臂受控实验

同一 fixture、同一 harness、同一安静窗，三臂各采一次 GPU trace（`probes/gpu-trace.mjs --arm <full|no-blur|reduced>`）：

| 臂 | 注入 | 隔离的变量 |
|---|---|---|
| `full` | 无（现状） | 基线 |
| `no-blur` | `Runtime.evaluate` 注入 `<style>[class*="backdrop-blur"]{backdrop-filter:none!important}</style>` | 四层 backdrop-blur 的 raster/compositing 成本（mask 与沉色层仍在） |
| `reduced` | CDP `Emulation.setEmulatedMedia{features:[{name:'prefers-reduced-transparency',value:'reduce'}]}` | EdgeFade **整个视觉效果**（组件内建降级路径：遮罩层隐藏 + 容器 mask 摘除）——即「视觉项的总 GPU 账」 |

裁决规则（题面给定）：干净数据里 blur 的 raster 占比若 >20% GPU 主线程工作 → 出「怎么降档」设计建议；不显著 → 记「不动 + 依据」。mask 若可从 `reduced` vs `full` 的合成/raster 差中分离 → 据数据裁；不能 → 登记「本环境不可证 + 需要的测量手段」（候选手段：`chrome://tracing` cc 层树逐层成本 / `--enable-gpu-service-logging` / 组件级拆臂实机对比）。三臂均用 `analyze-gpu-union.mjs` 的 **union 口径**（M1：禁嵌套求和）。

### B-clean-baseline / B-clean-final：双测量隔离 harness 变量

before/after 各一次完整采集（CPU 三进程 + GPU trace），唯一差异 = 代码（34 个 commit）。终版对比表三列：首轮原始基线（脏 harness，仅供溯源）/ 干净基线（原始代码）/ 干净终版（HEAD）——**「5 批累计收益」取干净基线 vs 干净终版**，首轮列仅用于说明「审查指出的混杂曾把数字推向哪边」。

## 非功能设计

- **测量有效性优先于结论**：探针一律「无效即 exit 3」，绝不允许空数据 PASS（批1-4 既定纪律，本批沿用并加 HEAD 断言与 load 门）。
- **禁时间判死**：全部收尾事件驱动（`message.complete`）；超时预算由调用方显式传入；不杀任何进程（含挂死的 pi——收终归用户）。
- **零产品代码改动**：本批交付物 = 探针 + 文档 + 归档。GPU 裁决若为「动」，只产设计建议与后续批次登记，不在本批改视觉代码。
- **可复现**：fixture 由确定性生成器产出并入库；分析脚本全部入库（`probes/analyze-gpu-union.mjs` / `probes/deriv-family.mjs` / `probes/perf-component-render.mjs` / `probes/perf-forced-layout.mjs` / `probes/shiki-family.mjs` / `probes/lib/harness.mjs`）；报告给复算命令。

### 显式不做

| 项 | 理由 | 题面提及 | 重审触发 |
|---|---|---|---|
| 推送分支 / 开 PR | 题面明示「推送/开 PR 不属本批职责」 | 是（明示不做） | 用户显式要求 |
| 改 EdgeFade 视觉代码（即使裁决为「动」） | 本批只产裁决与设计建议；视觉改动需独立批次走设计 | 否（题面要求「据实决策」而非实施） | 裁决为「动」且用户批准后续批次 |
| 完整 `pnpm build` 打包形态 | 打包版 TaiJi.app 是本会话宿主，无法并行起第二份同 bundle 实例（单实例锁 + 数据目录竞争）；prod renderer bundle 已满足纪律 1 的第一选项 | 否（纪律 1 给的是二选一） | 有独立打包测量环境时 |
| `powermetrics` GPU 计数器 | 需 sudo，本机不可用（首轮已登记） | 否 | 用户提供 sudo 环境 |
| 探针的类型层（probes/ 下全部 .mjs） | 类型层放弃：真机采集/分析探针是零依赖 Node 一次性脚本，沿用批1-4 口径不进 tsc 类型层（无构建步骤、无跨包复用） | 否 | 探针被非采集链路依赖（进 CI 常驻、被产品代码 import）或出现跨文件复用需求时，改为 TS + 独立 tsconfig |
| 全量 e2e / 真实 LLM 回归 | 与本批目标无关：零产品代码改动，e2e 影响面为 0（`e2e-map` 无 rule 命中） | 否 | 本批若新增/修改任何产品代码（当前设计明确为零改动）时，重审并跑 `node scripts/select-affected-e2e.mjs --base <ref>` 圈定的子集 |
| 三臂之外的 GPU 拆解（如逐层 blur 半径对照） | 投入产出不符：裁决只需 blur / mask / 总量三档 | 否 | 裁决为「动」且需定降档档位时 |
| 对 pi 用真 Bun SEA 采 profile | Bun 不食 NODE_OPTIONS、SIGUSR1 直接杀死它（首轮已实证）；mock-pi 置换是既有规范手段 | 否 | pi 上游提供 inspector 入口时 |

## 未核实风险（进 fact-check）

- I1 SIGUSR1 在本 runtime（tsx 壳）上激活 inspector 未实测 → 失败回退：`NODE_OPTIONS=--cpu-prof --cpu-prof-dir=<dir>` 仅在本探针进程树内设置（不污染 vite——本 harness 已不用 vite dev server）。
- I2 `--minify false` 的 prod bundle 与发布 bundle 的差异仅限 minify（未测 minify 对加载后流式行为的影响）——流式窗在加载之后，风险低但登记。
- I3 三臂实验测的是 compositing/raster 的**增量**，不是「blur 专属 GPU 计时器」；若增量在噪声内，结论为「不可证」而非「无成本」。
- I4 干净基线的 checkout 舞蹈有工作区状态风险（见安全规程）。
