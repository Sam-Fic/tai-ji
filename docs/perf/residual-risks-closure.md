# 批6 · 残余风险全部闭环（R1–R9）

> 前置 = [final-summary.md](final-summary.md)（批5 交付，§5 登记 R1–R9）· 分支 `feat-cpu-gpu-performance`。
> 本批目标：对批5 登记的全部残余风险**逐项调查 + 修复优化或定量裁决**。产品代码改动 1 处（R1 守卫），其余为测量基建与登记证据的升级。
> 所有数字均可复算（命令随条目给出）。A/B 原始 profile 归档于 `.run/b6ab2/`（gitignore，复算命令见 §1）。

## 0. 结论总表

| # | 风险 | 批5 状态 | 批6 结果 |
|---|---|---|---|
| R1 | scrollTo self +57~62%，根因未定位 | 未定位 | **已定位 + 已修复**：85.7% 是恒等写；守卫砍掉 83% DOM 写、scrollTo 归因 −86%、窗内 Task −4.1s（§1） |
| R2 | minify 关闭的偏差 | 登记 | **已定量**：主 chunk 解析编译差 6ms（一次性、加载期）；流式窗内 parse/compile 仅 0.378s/59.1s（§2） |
| R3 | 打包版 TaiJi.app 并存（L1） | 无法消除 | 维持 L1 + 量化界：并存 helper 瞬时 39–48% 单核，A/B 双臂同条件（§3） |
| R4 | 组件级 inclusive 在 prod bundle 不可测 | 方法学限制 | **已推翻**：`--minify false` 保留 `__name` 标记，行号映射可归因；实测组件渲染层 inclusive 仅 1.42s（2.4% 窗）（§4） |
| R5 | pi profile 用 node 代理 | 首轮已证 Bun 不可 inspect | **升级为真实证据**：macOS `sample` 直接采真实 Bun SEA 二进制；流式窗 pi CPU 5.56s/65.8s（8.4%，含冷启动段），流中 1782/1921 样本处于 `kevent` 等待（§5） |
| R6 | 补充形态为合成语料 | 确定性生成器 | **已定量**：fence/heading/list 刻意超加权（×4~×45），per-char 成本是真实流量的**上界**；tool-calls 形态行密度 ×10.8 偏差登记（§6） |
| R7 | `(program)` 34% 未归因 | 定量但未拆解 | **已归因**：= Blink 原生 Layout 10.1–11.5s + Paint 6.6–7.5s + rAF 派发等；JS 侧强制布局仅 0.28–0.30s——是内容增长的每帧原生渲染，非 JS 可消除项（§7） |
| R8 | pi 冷启动 dev 20s（不可优化） | 已裁决 | 维持裁决 + 新证据：新会话 pi 生命周期 CPU 0:07.73→0:13.29（冷启动 ~5.5s CPU + 流式近零），与批4 结论一致（§8） |
| R9 | 分支未推送 / 独立 clone | 批4 遗留 | 维持登记：推送是用户裁决的外部动作；本批结束时分支含批1–6 全部提交（§9） |

## 1. R1 · scrollTo 上升：根因定位 + 修复（本批唯一产品代码改动）

### 1.1 根因（三层证据）

1. **恒等写占绝对多数**（`probes/scroll-churn.mjs`，流式窗 2979–3179 次写）：85.1–86.4% 的 `scrollTo` 调用发生在「写前 scrollTop 已在 max（before==max）且目标 ≥ max」——virtua 的 end 目标公式（`offset + startSpacer + itemOffset(last) + itemSize(last) - viewport`，叠加 endOffset 补偿项）结构性超出浏览器 scrollTop 上界，靠 clamp 收口；已贴底时每次写都被夹回原位。
2. **profile 的 scrollTo 归因 ≠ 函数执行时长**：同运行并存插桩对账（`--profile`）显示，插桩读 scrollTop 会把「scroll 写入触发的 pending 样式/布局 flush」从 scrollTo 帧挪进 getter 帧（scrollTo 0.24s + `get scrollTop` 6.6s，而未插桩归档全在 scrollTo 2.3s）——**总量是同一笔强制布局，归因位置随观测方式移动**。因此「省掉调用数」的真实收益必须用未插桩干净 harness 复测（§1.3）。
3. **写入数不随 delta 数变化**：trace 里 `ScrollTree::SetScrollOffset` 20986→21569（+2.8%）、`ws.onmessage` 2882→2875——批1–5 之间写次数几乎不变，批5 报告的「+57~62%」是**归因漂移**（强制布局成本在两份 profile 里落点不同），不是「滚动写变多变贵」。

### 1.2 修复（commit 52b49aa16）

`useVirtuaFollow.scrollToRealBottom` 增加恒等写守卫：距底（`scrollSize + endOffset - scrollOffset - viewportSize`）≤ 1px 时跳过 `scrollToIndex`。判据全部读 virtua store 属性（零 DOM 几何读、零强制布局）；endOffset 计入距底（否则差一个 tail+padTop 时会误判已到底而漏跟随）。

- 单测 41 条全绿，含 2 条新用例（已底→跳过；距底 2px→照常写）；**变异验证**：摘掉守卫新用例必红。
- 正确性红线实测（`probes/scroll-count.mjs`，流结束 gap ≤4px 断言，违规 exit 5）：ON/OFF 两臂 mid-stream(30s) 均贴底（top=284.5/max=285）、结束 gap 0 / −0.5。

### 1.3 干净 A/B（同实例相邻窗，`perf-clean-cpu.mjs`，completes 1/1）

| 指标 | OFF（守卫关闭 scratch build） | ON（守卫） | 变化 |
|---|---|---|---|
| DOM scrollTo 写 | **3283**（49.0/s） | **568**（8.5/s） | **−83%**（`scroll-count` 计数探针，零几何读） |
| scrollTo self（profile） | 2.242s (3.70%) | **0.322s (0.53%)** | **−86%** |
| 非 idle | 54.3% | **46.6%** | −7.7pp |
| CDP TaskDuration | 34.0s | **29.9s** | −4.1s（−12%） |
| (program) | 34.0% | 31.7% | −2.3pp |
| JS busy | 20.3% | 14.9% | −5.4pp |
| flushJobs / componentUpdateFn | 5.737 / 4.589s | 4.840 / 3.832s | −0.90 / −0.76s |

复算：`node probes/analyze-clean-cpu.mjs off6=.run/b6ab2 on6=.run/b6ab2`；写入计数 `node probes/scroll-count.mjs --data-dir ~/.taiji-dev/verify-b5-final --sid <sid>`（OFF 束需换回 scratch chunk）。

**批6 后的「final」口径更新**：scrollTo 0.322s（批5 归档 2.242s）、非 idle 46.6%（批5 54.3/48.8%）、JS busy 14.9%（20.5%）——派生族 0.084s、shiki 0、EdgeFade.sync 0 不变。

## 2. R2 · minify 关闭偏差：6ms 一次性加载成本

- 主 chunk V8 解析+编译（`node --experimental-vm-modules` + `SourceTextModule`，5 次取中位）：non-minify **35ms**（1.7MB）vs minified **29ms**（0.6MB）——差 **6ms**，一次性，发生在页面加载期。
- 流式窗内 parse/compile 采样：0.378s / 59.1s = **0.64%**（archived final profile，均为懒加载 chunk 的按需编译），与 minify 与否无关。
- 结论：R2 偏差有界（~6ms 加载期 + 懒 chunk 按需编译），不触达流式窗结论。minify 关闭仍是 CPU 归因的必要条件（minified 产物 4 个关键函数名命中 0，`build-probe-grep.txt`）。

## 3. R3 · 打包版并存（L1）：量化界

并存 helper 瞬时 CPU 39–48% 单核（本轮 A/B 期，宿主 GUI 正在渲染本会话流）；批5 归档窗内为 4–16%。A/B 双臂同条件、归档 baseline/final 同条件，且 GPU/scrollTo 的臂内对比（no-blur/no-mask）不受影响。L1（宿主会话不可关闭）维持，风险 = 绝对值不可跨环境比较，臂内相对结论不受累。

## 4. R4 · 组件级 inclusive：方法已打通（推翻「不可测」）

`probes/analyze-component-attribution.mjs`：`--minify false` 产物保留 Vue `__name` 编译标记（125 个），SFC 渲染闭包排布在所属组件标记区段内——采样行号 → 最近前驱 `__name` 归回组件；inclusive 沿 parent 链（每栈一计）。

r1fix 窗（60.1s）实测：组件渲染层 inclusive 合计 **1.42s（2.4% 窗）**——MessageStream 0.742s（52.4%）+ StreamItemBoundary 0.538s（38.0%），其余全部 <2.5%。**证实批1/2 的稳定引用 props 改造后组件渲染已不是热点**，与 §7 的「热点在原生 Layout/Paint」互相印证。复算：`node probes/analyze-component-attribution.mjs --profile <cpuprofile> --env <env.json> --bundle main-CAu_cdgk.js`（bundle 必须与 profile 同源）。

## 5. R5 · pi profile：升级为真实 Bun SEA 证据

- macOS `sample` 可直接采真实 `pi-darwin-x64`（Bun SEA）：新会话流式 12s 时采样 3s，1921 样本中 1782 处于 `kevent64` 事件等待。
- 流式窗 CPU 增量（`ps -o time`）：新会话 pi 0:07.73 → 0:13.29，窗 65.8s → **5.56s（8.4% 单核，含 ~5.5s 冷启动段）**；其余 pi 进程增量 ≤2.4s。
- 结论：pi 流式本体近乎零耗，CPU 集中在会话冷启动（即 R8 的 dev 形态成本）。R5 的「node 代理 profile」降级为附录——真实二进制的直接证据已足够。

## 6. R6 · 合成语料保真度：定量（`/tmp/r6-fidelity3.mjs` 口径，广谱真实语料 n=9 + 原型 1 条）

- fixture 刻意**超加权**昂贵结构：fence 0–39（真实中位 0）、headings 至 ×37.7、listItems 至 ×45——**per-char 测量成本是真实流量的上界**（基准保守方向正确）。
- 偏差登记：`tool-calls` 形态 avgLineLen 741.5（真实中位 ×10.8）——长行意味着每字符的行级 markdown 结构更少，该形态结论带「行密度低于真实」caveat。
- 原型真实语料（01a2077f 会话 45K 级回复）：avgLineLen 41.6、blankRatio 0.007、fence 0——fixture 的 fence 加权是该真实回复所没有的结构（首轮实测场景即无 fence），45K fixture 的单一大 fence（27010 字符）是刻意构造的 shiki 压力形态。
- 行动：维持合成语料 + 本表作为外推边界；后续如需「真实语料回放」应从真实 session JSONL 提取 assistant 全文生成 fixture（结构已在本表登记）。

## 7. R7 · `(program)` 归因：= 每帧原生 Layout/Paint，非 JS 可消除项

`probes/analyze-renderer-native.mjs`（CrRendererMain X 事件 self-time，禁嵌套求和；复算命令见脚本头）：

| 臂 | 原生 self | Layout | Paint | Composite | GC | EventDispatch | 未分桶（rAF/BeginMainFrame 派发） |
|---|---|---|---|---|---|---|---|
| baseline-traced | 26.78s（42.2%） | 10.13s | 6.62s | 0.35s | 0.56s | 0.97s | 8.16s |
| final-traced | 27.77s（43.6%） | 11.51s | 7.48s | 0.36s | 0.22s | 0.99s | 7.22s |

- `(program)`（V8 profile 29–34%）≈ 原生 self 中 Layout+Paint+GC+EventDispatch 合计（baseline 18.3s ≈ (program) 17.2s；同窗对齐 ±2pp）。
- **JS 侧强制布局仅 0.28–0.30s**（Layout/UpdateLayoutTree 的祖先链里有 FunctionCall 的部分）——`(program)` 不是「JS 逼出来的同步布局」，而是内容增长驱动的**每帧原生渲染管线**（BeginMainFrame 9639→10032 次、每帧 Layout 1.64→1.83ms）。
- 处置：这是流式渲染的固有成本，JS 优化已到边界；唯一剩余杠杆是减少每帧需要重排的 DOM（虚拟化已做）。登记为「已归因、接受」。

## 8. R8 · pi 冷启动 dev：维持裁决 + 新证据

新会话 pi 生命周期 CPU 0:07.73 → 0:13.29（spawn→流式结束）：冷启动段 ~5.5s CPU（jiti 模块风暴，批4 根因），流式段近零。与批4 结论（dev 6.0–6.5s 墙钟 / 7.3–9.0s CPU；bundle 2s）一致，prod 不受影响。裁决不变：taiji 侧不可优化（上游禁改 + jiti 不缓存模块解析）。

## 9. R9 · 分支状态：维持登记

本批结束时分支含批1–6 全部提交（`git rev-list --count origin/main..HEAD` 随批增长）；推送/开 PR 是用户裁决的外部动作，不属测量批次职责。独立 clone（非 `.bare` worktree）事实不变。

## 10. 本批新增/修改资产

| 资产 | 用途 |
|---|---|
| `probes/scroll-churn.mjs` | 滚动写归因（次数/恒等写占比/目标 vs 底/同几何重复 + `--skip-noop` A/B 臂 + 同运行 profile 对账；注意口径纪律：插桩读几何会挪动布局 flush 的归因位置） |
| `probes/scroll-count.mjs` | 零几何读的写计数 + 流结束贴底断言（gap ≤4px，违规 exit 5）——A/B 与正确性红线 |
| `probes/analyze-renderer-native.mjs` | R7：CrRendererMain 原生 self 分桶（union，禁嵌套求和） |
| `probes/analyze-component-attribution.mjs` | R4：`__name` 行号映射的组件级 self/inclusive |
| `packages/renderer/src/composables/panel/useVirtuaFollow.ts` | R1 修复：恒等写守卫（含 endOffset 的距底 ≤1px 跳过） |
| `packages/renderer/src/__tests__/effects/_virtua-mock-helper.ts` | mock 默认几何改为「离底 200px」（默认贴底会让 follow 断言全部落进守卫）；贴底场景由用例显式声明 |
| `packages/renderer/src/composables/panel/__tests__/use-message-stream-rail-freeze-reset.test.ts` | 修复 3 条存量类型漂移（tsconfig.typecheck-test.json 基线，HEAD 上即红） |
| `docs/perf/final-measurement/b6-ab-env.json` | R1 A/B 双臂 env 快照（profile 本体在 `.run/b6ab2`，gitignore） |
| `docs/perf/final-measurement/b6-pi-stream-sample.txt` | R5：真实 Bun SEA pi 流式中的 `sample` 原生栈（1921 样本，主体 kevent 等待） |

## 11. B6 机器判据（自包含，全部离线可复算）

| 判据 | 命令 | 通过条件 |
|---|---|---|
| 守卫单测 + 变异验证 | `cd packages/renderer && pnpm vitest run src/__tests__/effects/use-virtua-follow.test.ts`（41 条；摘掉守卫 2 条新用例必红） | exit 0 |
| renderer 全量回归 | `cd packages/renderer && pnpm vitest run` | 141 文件 / 3393 用例全绿 |
| 测试类型基线 | `cd packages/renderer && npx vue-tsc --noEmit -p tsconfig.typecheck-test.json` | exit 0（含 3 条存量漂移修复） |
| R7 归因复算 | `node --max-old-space-size=12288 probes/analyze-renderer-native.mjs b="<trace>"`（trace 路径见 gpu-trace-manifest.json） | 原生 self ≈ 42–44%，Layout+Paint 占主导 |
| R4 归因复算 | `node probes/analyze-component-attribution.mjs --profile .run/r1fix/r1fix-renderer.cpuprofile --env .run/r1fix/r1fix-env.json --bundle main-CAu_cdgk.js` | 组件 inclusive ≈ 1.42s（2.4% 窗） |
| R2 复算 | `node --experimental-vm-modules /tmp/r2-parse.mjs <non-min chunk> <min chunk>`（或按 §2 记录的 6ms 结论引用） | 比率 ≈1.2x |
| R1 正确性红线（需实例） | `node probes/scroll-count.mjs --data-dir ~/.taiji-dev/verify-b5-final --sid <sid>`（ON bundle；流结束 gap ≤4px 否则 exit 5） | exit 0 |
| R1 A/B 复算 | `node probes/analyze-clean-cpu.mjs off6=.run/b6ab2 on6=.run/b6ab2` | scrollTo 0.32 vs 2.24s |
| R5 复算 | `sample <pi-pid> 3 -file out.txt`（流式中）+ `ps -o time` 窗口前后差 | 流中主体 kevent 等待 |
| R6 复算 | `/tmp/r6-fidelity3.mjs` 口径已内联于 §6 表格 | — |

> 树形协议说明：本批是批5 交付后的 follow-up（批5 tree-plant 已 delivered 归档，验收文档保持冻结）；批6 的机器终态 = 上表全部命令绿 + 本文档随批提交，不走批5 的 root/harvest 基线。
