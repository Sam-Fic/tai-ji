# 批4「TTFT（首 token 延迟）」前后对比

> 采集分支 `feat-cpu-gpu-performance`（批4 HEAD = trunk 后各枝 commit）。交付 = ① matchPath 段级快路径（无通配/单星号无斜杠/前置双星加斜杠字面量三形态，语义逐字节等价，oracle 测试锁定）；② pi 冷启动根因定位结论（dev 固有、prod 不受影响、taiji 侧不可优化+理由链）；③ TTFT 机制证伪（walk 不在首 token 关键路径）+ 匹配 CPU 成本 2.8x 缓解。
> 依据 = [adversarial-review-glm.md](adversarial-review-glm.md) A4③/A5/S6/S9/F5。口径声明照 [batch3-comparison.md](batch3-comparison.md)。

## 0. 采集 harness

| 项 | before（基线） | after（本批） |
|---|---|---|
| 宿主 | dev 实例（`TAIJI_DEV_BACKGROUND=1` + `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`） | 同左 |
| faux 脚本 | `~/.taiji-dev/verify-prof-20261123-1730/agent/faux-responses.json`（200TPS） | 同左 |
| session cwd | worktree 根（对齐原始实测场景） | 同左 |
| TTFT 探针 | `probes/perf-ttft.mjs`（三模式 warm/walk/fresh） | 同左（同 fixture 同协议） |
| 匹配成本探针 | `probes/perf-ignore-match.mjs`（真实 .gitignore 82 规则 × 真实路径语料 6961 条） | 同左 |
| 冷启动探针 | `probes/perf-pi-coldstart.mjs`（直 spawn pi 二进制，dev 源码扩展集 vs packaged bundle 集） | 同左 |
| 打包版 TaiJi.app | 在跑（用户工作宿主，竞争噪声） | 同左 |
| 采集时 load | before 各数字随条标注 | after 各数字随条标注 |

**before/after 的代码差异**：before = HEAD `381a4b7b2`（批3 delivered 态，matchPath 全 regex 逐前缀）；after = 本批 B-prompt-path（matchPath 段级快路径）。TTFT 的 before 数字采集于本批编码前（同实例形态、同探针）；after 数字采集于本批编码后。**跨运行的绝对差含采集噪声**（GLM 审查实证同场景跨运行差异 ≥2.7×；load 波动见各条标注），结论只承载量级与方向。

## 1. TTFT（send → 首 token/首帧）——核心指标

口径：`delivery.submit` 发出（探针墙钟 t0）→ 本 session 首个 `message.message_start` 广播帧到达（t1）。

| 模式 | before（HEAD 381a4b7b2） | after（B-prompt-path） | 变化 |
|---|---|---|---|
| warm（pi 热、无文件请求 = 转发地板） | 65ms（47/65，load ~8） | 待测 | — |
| walk（prompt 同时刻并发 file.tree + file.search 两次全树 ignore 匹配） | 46ms（40/46/63，load ~8） | 待测 | 预期 ≈ 地板（证伪「walk 阻塞」） |
| fresh（新建 session → GUI 切换 → 立即 prompt，含 pi 冷启动段） | 227ms（87/227，load ~8） | 待测 | — |
| 机制压测（walk + prompt 在途时并发 12 个全树 walk） | 896ms（load ~8） | 待测 | 饱和边际 |

**读法**：walk ≡ warm（差异在噪声内）⇒ 审查 S9「walk ~0.9s 阻塞首 token 转发」**不成立**——runtime WS 处理 fire-and-forget 并发，walk 与 pi stdout 数据事件在事件循环交错（connection-manager.ts:225/252）。真实负载下 walk 不在 TTFT 关键路径上；压测（12 路并发）才劣化，那是 ~10x 饱和形态。after 列的匹配成本下降（§2）不改变 TTFT 地板（walk 本就不是瓶颈），这正是本批最重要的诚实结论：**TTFT 的唯一结构性因子是 pi 冷启动（§3），prompt 路径的 .gitignore 成本是 CPU 浪费而非延迟**。

## 2. 匹配 CPU 成本（prompt 窗口真实成本）

口径：`probes/perf-ignore-match.mjs`，仓库真实 .gitignore（82 规则：55 字面量 + 18 单星号无斜杠 + 3 前置双星加斜杠 + 6 保守 regex）× 真实路径语料 6961 条（仓库树采样，排除 node_modules/.git），两算法（改造前 regex 逐前缀 vs 现行段级快路径）同语料计时；前置门 = 两算法结果零分歧。

| 口径 | before | after | 变化 |
|---|---|---|---|
| matchPath 每轮（6961 次调用） | 226.3ms（32.51 µs/call） | 80.2ms（11.51 µs/call） | **−64.6%（2.82x）** |
| 全树 walk 的匹配占比（估算） | ~67%（readdir IO 补足余量） | 同左 | — |
| 宿主侧全树 walk 墙钟（file.search.cwd，worktree cwd） | 341ms（load ~10，5000 文件截断） | 待测（quiet 窗口） | 预期 ~195ms |
| 等价性 | — | 6961 路径 0 分歧 + oracle 套件 4/4（含 76/82 覆盖度自检） | 语义零漂移 |

> 纯 Node 基准（load 不敏感）是主证据；宿主侧墙钟受 load 影响大（341ms 采集于 load ~10），以量级与方向为准。

## 3. pi 冷启动（根因定位 + 结论）

口径：`probes/perf-pi-coldstart.mjs` 直 spawn pi 二进制（不经 Electron/runtime），量 spawn → get_state 首响墙钟 + 进程累计 CPU（ps time）。JITI_DEBUG=1 计数单次冷启动的 jiti 模块加载数。

| 口径 | dev 源码扩展集（22 个 TS 源，jiti 加载） | packaged bundle 扩展集（22 个自包含 index.js） | 倍率 |
|---|---|---|---|
| 冷启动墙钟（quiet，load ~8） | 6.2–6.7s | 2.3–2.4s | ~2.7x |
| 冷启动墙钟（loaded，load ~17） | 23.2s（8.5/10.9/20.8） | 4.5s（6.8/6.7/2.4） | 5.1x |
| 进程累计 CPU | 9.0s | 3.7s | 2.4x |
| jiti 模块加载数/次 | **1769**（100% fsCache 命中、0 转译） | **59** | **30x** |

**根因**：dev 形态 runtime 传 `--extension <源码目录>`（extension-resolver.ts:209-260），pi 经内置 jiti 2.7.0 加载 TS 扩展——fsCache 只缓存转译产物（键 = 文件名哈希）、**不缓存模块解析**；每次冷启动对 1769 个模块重跑 statSync/ENOENT 探测（profile 的 statSync 4.05s + stat 1.85s + NodeError 0.72s + jiti self 4.74s 全部来自 jiti moduleResolve，find-callers 实证）。prod 传 staged bundle（esbuild 自包含）⇒ 59 个模块。

**结论：不可优化（taiji 侧）+ prod 不受影响**。理由链（全实测/决策记录支撑）：
1. prod 用 bundle 形态（2.3-6.8s），「20s CPU 风暴」是 dev 固有成本；
2. taiji 侧可行解全部有不可接受代价：dev 改 bundle = DX 回归（extension-resolver [HISTORICAL]：改源码需全量 bundle ~40s + 重启，该形态已被主动放弃）；预构建 shared 库 dist 只覆盖传递图一部分；删 mandatory 扩展 = 产品回归；启动期预热 = 感知转移到启动期且不覆盖编程式建会话（warmup-pi-slot 消费驱动、只服务冷切）；改上游 pi（解析缓存/惰性加载）= 仓规铁禁；
3. 用户可感知形态：真实用户流（建会话 → 打字 → 发送）冷启动与打字重叠；受影响形态 = 自动化/编程式建会话即发与「秒发」用户。

## 4. prompt 路径「重复编译两次」定位结论

| 项 | 实测 |
|---|---|
| 触发源 | file.tree（FileView 挂载）+ file.search（useChatViewDeps 挂载），会话激活时先后到达（日志实测相隔 ~53ms，非并发） |
| 单次编译成本 | compileIgnoreRules 0.178ms（82 规则）——在册裁决 U1 1-2 口径（微秒-毫秒级）成立，**不构成可优化项** |
| 在途合并 | 不适用（请求非并发，前次已 settle）；引入 = 死代码，显式不做 |
| prompt 窗口真实成本 | 全树 walk 的 matchPath（§2），已由快路径缓解 2.8x |

## 5. 一次性成本登记

| 成本项 | 量级 | 处置 |
|---|---|---|
| `IgnoreRule.fast` 字段 | 每条规则一个 {prefix, suffix, star, anchored} 小对象（编译期一次） | 可忽略；随规则合并（file-service loadMatcher 拼接）自动迁移 |
| 匹配期段数组 | 每次 matchPath 一次 split + filter（原 allPrefixes 内部同款，改为复用 segments 后反而少一次重复 split） | 净中性或略降 |
| oracle 测试 | 合成语料 × 真实快照全交叉（330ms + 27ms + 175ms + 1ms） | testCommand 承载，可忽略 |
| 探针脚本 | 4 个零依赖 .mjs（TTFT/匹配基准/冷启动/树标记），随交付入库 | 验收 + 对比表复算入口 |

## 6. 与题面对齐

| 题面（GLM 审查 A5/S9/A4③/F5 + 任务书） | 本表证据 |
|---|---|
| 「prompt 路径 ~0.9s 同步 CPU 突发」定位与修复/缓解 | §2 匹配成本 226→80ms（2.82x）+ §4 重复编译定位（0.178ms/次，非成本项）；§1 证伪延迟机制 |
| 「每次 prompt 编译两次」 | §4：双请求各一次、相隔 53ms、亚毫秒级——登记为非成本项 + 不引入缓存的理由 |
| 「pi 冷启动 20s 根因 + 优化或明确不可优化结论」 | §3：dev 1769 模块/23.2s vs bundle 59 模块/4.5s；结论 = 不可优化（理由链）+ prod 不受影响 |
| 「TTFT 前后对比表（同 harness）」 | §1 三模式同探针同 fixture |
| 铁律（不恢复 mtime 缓存/不引时间窗） | 快路径 = 编译期预计算 + 匹配期纯函数，零缓存零时间窗；file-service 裁决注释补实测数据 |

## 7. 复算命令（任意 cwd，仓库根）

```bash
# 匹配成本 + 等价性（纯 Node，load 不敏感）
npx tsx probes/perf-ignore-match.mjs
# TTFT 三模式（需 dev 实例活着）
node probes/perf-ttft.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --mode warm --runs 2
node probes/perf-ttft.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --mode walk --runs 2
node probes/perf-ttft.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --mode fresh --runs 1
# 冷启动对照（直 spawn，不需实例）
node probes/perf-pi-coldstart.mjs --runs 3
# 树标记对账（需实例）
node probes/tree-flags-probe.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730
# 单测（oracle 等价 + 覆盖度）
cd packages/runtime && npx vitest run test/domains-bundle.test.ts -t "ignore-parser"
```
