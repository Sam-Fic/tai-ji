# 批4「TTFT（首 token 延迟）」前后对比

> 采集分支 `feat-cpu-gpu-performance` · before = HEAD `381a4b7b2`（批3 delivered 态，matchPath 全 regex 逐前缀）；after = 本批 B-prompt-path（matchPath 段级快路径，commit `faad62ff8` + `900a3d6da`）。
> 交付 = ① matchPath 段级快路径（字面量 / 单星号无斜杠 / 前置双星加斜杠字面量 三形态，语义逐字节等价，oracle + 属性模糊双锁定）；② pi 冷启动根因定位结论（dev 固有、prod 不受影响、taiji 侧不可优化 + 理由链）；③ TTFT「walk 阻塞首 token」机制经实测证伪 + 匹配 CPU 成本 2.1–2.5x 缓解。
> 依据 = [adversarial-review-glm.md](adversarial-review-glm.md) A4③/A5/S6/S9/F5。口径声明照 [batch3-comparison.md](batch3-comparison.md)。
>
> **口径声明**：前后两次采集不是同一次运行；所有数字同探针、同 fixture、同实例形态。跨运行绝对差含采集噪声（GLM 审查实证同场景跨运行差异 ≥2.7×；本机采集期 load 在 4–27 间波动，各条随注），结论只承载量级与方向；凡涉及「前/后」的差，一律给绝对值 + 采集条件。

## 0. 采集 harness

| 项 | before（基线） | after（本批） |
|---|---|---|
| 宿主 | dev 实例（`TAIJI_DEV_BACKGROUND=1`，`~/.taiji-dev/verify-prof-20261123-1730`） | 同左 + `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`（批3 逃生舱，防遮挡停 rAF） |
| faux 脚本 | `~/.taiji-dev/verify-prof-20261123-1730/agent/faux-responses.json`（200TPS） | 同左 |
| session cwd | worktree 根（对齐原始实测场景） | 同左 |
| TTFT 探针 | `probes/perf-ttft.mjs`（warm / walk / fresh 三模式） | 同左（同协议；after 侧 text_delta 改 3s 宽限——faux 短响应可无 text_delta 帧，不影响 TTFT=message_start 口径） |
| 匹配成本探针 | `probes/perf-ignore-match.mjs`（真实 .gitignore 82 规则 × 仓库真实路径语料 ~6970 条，两算法同语料同时段计时，前置等价门） | 同左 |
| 冷启动探针 | `probes/perf-pi-coldstart.mjs`（直 spawn pi 二进制，dev 源码扩展集 vs packaged bundle 集） | 同左 |
| 打包版 TaiJi.app | 在跑（用户工作宿主，竞争噪声） | 同左 |

## 1. TTFT（send → 首 token/首帧）——核心指标

口径：`delivery.submit` 发出（探针墙钟 t0）→ 本 session 首个 `message.message_start` 广播帧到达（t1）。submit-rtt = delivery.submit RPC 往返（受理段：BeforeSend hook + 内核提交 + prompt 写 stdin），用来分辨延迟落在受理段还是转发段。

| 模式 | before（381a4b7b2） | after（本批，leaf 采集 load ~5） | 变化 |
|---|---|---|---|
| warm（pi 热、无文件请求 = 转发地板） | 65ms 中位（47/65；load ~8） | **39ms** 中位（39/33；submit-rtt 3–4ms） | 噪声内 |
| walk（prompt 同时刻并发 file.tree + file.search = 两次全树 ignore 匹配，worktree cwd） | 46ms 中位（40/46/63；lead 50–1000ms 四组均 37–63；load ~8） | **130ms** 中位（130/48；submit-rtt 28ms / 7ms） | 噪声内（见读法） |
| fresh（新建 session → GUI 切换 → 立即 prompt，含 pi 冷启动段） | 227ms 中位（87/227；load ~8） | **71ms**（first-delta 583ms） | 噪声内 |
| 机制压测（walk + prompt 在途时并发 12 个全树 walk） | 896ms（submit-rtt 276ms；load ~8） | 未复测（压测形态非交付目标；after 侧单次 walk 成本已降 2.1x，饱和阈值相应抬高） | — |

**读法（本批最重要的诚实结论）**：
1. **walk ≡ warm 地板**。after 侧 walk 两轮 130ms / 48ms 对 warm 39ms / 33ms——差异完全由 submit-rtt 解释（28ms→130ms、7ms→48ms、3–4ms→33–39ms）：延迟落在**受理段**（delivery.submit 处理，含 Worker RPC hook；run1 恰逢该 session 的 pi 刚冷启动完、JIT 未稳），不在首 token 转发段。before 侧同样（walk 37–63ms，有的组甚至低于 warm）。
2. 审查 S9「walk ~0.9s 阻塞首 token 转发」**不成立**：runtime WS 处理 fire-and-forget 并发（connection-manager.ts:225/252），文件 walk 与 pi stdout 数据事件在事件循环交错；真实负载下 walk 不在 TTFT 关键路径上。只有 ~10x 饱和形态（12 路并发全树 walk）才劣化到 896ms。
3. **TTFT 的唯一结构性因子是 pi 冷启动**（§3）：fresh 模式 71–227ms 是因为 GUI 切换/打字时间已让 pi 完成大部分冷启动；自动化/编程式「建会话即发」才吃满冷启动（dev 6–23s）。
4. 本批 after 侧 TTFT 与 before 无统计差异——**这是预期**：快路径降的是 CPU 浪费（§2），不是 TTFT；TTFT 本就不被 walk 阻塞。

## 2. 匹配 CPU 成本（prompt 窗口的真实成本）

口径：`probes/perf-ignore-match.mjs`——仓库真实 .gitignore（82 规则：55 字面量 + 18 单星号无斜杠 + 3 前置双星加斜杠 = 76 条进快路径；余 6 条保守 regex）× 仓库真实路径语料 ~6970 条（排除 node_modules/.git，对齐 walk 的 BUILTIN_IGNORE_DIRS 口径），两算法同语料同时段计时（中位数）；前置门 = 两算法逐路径结果零分歧。

| 口径 | before | after | 变化 |
|---|---|---|---|
| matchPath 每轮（~6970 次调用，load ~5） | 265ms（38.0 µs/call）/ 244ms（35.0）/ 226ms（32.3） | **114ms（16.3）/ 109ms（15.7）/ 106ms（15.2）** | **2.13–2.33x** |
| 同上，load 8–27（高负载） | 758–787ms | 349–369ms | 2.05–2.25x（安静瞬段 3.83x） |
| 全树 walk 的匹配占比 | ~67%（readdir IO 补足余量） | 同左（匹配下降，IO 不变） | — |
| 宿主侧全树 walk 墙钟（file.search，worktree cwd，5000 文件截断） | 341ms（load ~10） | 未单独计时（T4 对账 file.search 5000 文件、ignored 泄漏 0、在场抽查 2/2） | 以纯 Node 基准为主证据 |
| 等价性 | — | 6970 路径 0 分歧 + oracle 套件 5/5（76/82 覆盖度自检）+ 属性模糊 15 种子 × 16000–32000 例 0 分歧 | 语义零漂移 |

> 纯 Node 基准是主证据（load 不敏感——两算法同时段同条件）；宿主侧墙钟受 load 影响大，只取量级。初版快路径（仅字面量形态、按段数判 coverage）安静窗 2.82x；修剪 P1 修正 coverage 怪癖后 2.1–2.5x——正确性优先于最后那 0.3x。

## 3. pi 冷启动（根因定位 + 结论）

口径：`probes/perf-pi-coldstart.mjs` 直 spawn pi 二进制（不经 Electron/runtime），量 spawn → get_state 首响墙钟 + 进程累计 CPU（ps time）。模块数 = JITI_DEBUG=1 直 spawn 计数（`[cache hit]` 行）。

| 口径 | dev 源码扩展集（22 个 TS 源，jiti 加载） | packaged bundle 扩展集（22 个自包含 index.js） | 倍率 |
|---|---|---|---|
| 冷启动墙钟（quiet，load ~4–5，leaf/branch 采集） | 6.0–6.5s | 1.98–2.17s | **3.0x** |
| 冷启动墙钟（loaded，load ~17，批首采集） | 23.2s（8.5/10.9/20.8） | 4.5s（6.8/6.7/2.4） | 5.1x |
| 进程累计 CPU | 7.3–9.0s | 3.1–3.7s | 2.3–2.4x |
| jiti 模块加载数/次 | **1769**（100% fsCache 命中、0 转译） | **59** | **30x** |

**根因**：dev 形态 runtime 传 `--extension <源码目录>`（extension-resolver.ts:209-260），pi 经内置 jiti 2.7.0 加载 TS 扩展——fsCache 只缓存转译产物（键 = 文件名哈希，`os.tmpdir()/jiti`），**不缓存模块解析**；每次冷启动对 1769 个模块重跑 statSync/ENOENT 探测（归档 profile 的 statSync 4.05s + stat 1.85s + NodeError 0.72s + jiti self 4.74s 全部来自 jiti `moduleResolve`，find-callers 实证）。prod 传 staged bundle（esbuild 自包含）⇒ 59 个模块。墙钟随负载 6s→23s 放大 = 大量小同步 IO 在 CPU 争抢下最受伤。

**结论：不可优化（taiji 侧）+ prod 不受影响**。理由链（全实测 / 决策记录支撑，见 [tp-design-batch4.md](../tp-design-batch4.md)「B-cold-start」）：
1. prod 用 bundle 形态（2.0–6.8s），「20s CPU 风暴」是 dev 固有成本；
2. taiji 侧可行解全部有不可接受代价：dev 改 bundle = DX 回归（extension-resolver [HISTORICAL]：该形态已被主动放弃——改源码需全量 bundle ~40s + 重启）；预构建 shared 库 dist 只覆盖传递图一部分；删 mandatory 扩展 = 产品回归；启动期预热 = 感知转移到启动期且不覆盖编程式建会话（warmup-pi-slot 消费驱动、只服务冷切）；改上游 pi（解析缓存 / 惰性加载）= 仓规铁禁；
3. 用户可感知形态：真实用户流（建会话 → 打字 → 发送）冷启动与打字重叠；受影响形态 = 自动化 / 编程式建会话即发（session-manager agent 通路）与「秒发」用户。

残余（登记未核实风险 I1）：探针只量 pi 段，packaged app 的 restore 编排段未测；prod 绝对值可能更高，但 dev/prod 的结构性差距（模块数 30x）不受影响。

## 4. prompt 路径「重复编译两次」定位结论

| 项 | 实测 |
|---|---|
| 触发源 | file.tree（FileView 挂载）+ file.search（useChatViewDeps 挂载），会话激活时先后到达（runtime 日志 07:51:48.934 / 48.987，相隔 53ms，**非并发**） |
| 单次编译成本 | compileIgnoreRules 0.178ms（82 规则）——在册裁决 U1 1-2「微秒-毫秒级」口径成立，**不构成可优化项** |
| 在途合并（in-flight coalescing） | 不适用（请求非并发，前次已 settle）；引入 = 永不触发的死代码，显式不做 |
| 编译次数对账（探针 T1/T5/T4） | walk 模式每轮 2 次（探针自发的两请求）、warm 模式 0 次、file.tree 单请求 1 次——与触发源一致 |
| prompt 窗口真实成本 | 全树 walk 的 matchPath（§2），已由快路径缓解 2.1–2.5x |

## 5. 一次性成本登记

| 成本项 | 量级 | 处置 |
|---|---|---|
| `IgnoreRule.fast` 字段 | 每条规则一个 {prefix, suffix, star, anchored} 小对象（编译期一次，0.178ms/82 规则不变） | 可忽略；随规则合并（loadMatcher 拼接）自动迁移 |
| 匹配期 coverage 表 | 每次 matchPath 两次小数组分配（段数长度）；免拼接判据（startsWith + 长度/下一字符比较） | 已计入 §2 的 after 数字 |
| oracle 套件 | 5 例（合成 × 合成 1.2s + 真实快照 27ms + 组合 0.7s + 连续斜杠 + 覆盖度自检） | testCommand 承载 |
| 模糊对拍探针 | `probes/ignore-match-fuzz.mjs`，400 迭代 ≈ 10s | 修剪证据 + 回归复算入口（不进 CI） |
| 探针脚本 | 5 个零依赖 .mjs（TTFT / 匹配基准 / 冷启动 / 树标记 / 模糊），随交付入库 | 验收 + 对比表复算入口 |

## 6. 与题面对齐

| 题面（GLM 审查 A5/S9/A4③/F5 + 任务书） | 本表证据 |
|---|---|
| 「prompt 路径 ~0.9s 同步 CPU 突发」定位与修复/缓解 | §2 匹配成本 2.1–2.5x（226–265ms → 106–114ms）；§1 证伪其「阻塞首 token」推论 |
| 「每次 prompt 编译两次」 | §4：双请求各一次、相隔 53ms、0.178ms/次——登记为非成本项 + 不引入缓存的理由（铁律：不恢复 mtime 缓存、不引时间窗） |
| 「pi 冷启动 20s 根因 + 优化或明确不可优化结论」 | §3：dev 1769 模块 / 6–23s vs bundle 59 模块 / 2.0–6.8s；结论 = 不可优化（理由链）+ prod 不受影响 |
| 「TTFT 前后对比表（同 harness）」 | §1 三模式同探针同 fixture（before/after 均标 load） |
| 修剪（card-04 注入与输出伪造） | P1：含 `//` 路径的 coverage 怪癖——属性模糊抓到 13/16000，修正后 15 种子零分歧，回归用例入库 |

## 7. 复算命令（任意 cwd，仓库根）

```bash
# 匹配成本 + 等价性（纯 Node；load 敏感，取 load<8 窗口；两算法同时段同条件）
npx tsx probes/perf-ignore-match.mjs --rounds 5
# 属性模糊对拍（修剪证据 / 回归）
npx tsx probes/ignore-match-fuzz.mjs --iter 800 --seed 1
# TTFT 三模式（需 dev 实例活着；每 case ≤ 900s）
node probes/perf-ttft.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --mode warm --runs 2
node probes/perf-ttft.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --mode walk --runs 2
node probes/perf-ttft.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730 --mode fresh --runs 1
# 冷启动对照（直 spawn，不需实例）
node probes/perf-pi-coldstart.mjs --runs 3
# 树标记 + walk 侧对账（需实例）
node probes/tree-flags-probe.mjs --data-dir ~/.taiji-dev/verify-prof-20261123-1730
# 单测（oracle 等价 + 覆盖度 + 连续斜杠回归）
cd packages/runtime && npx vitest run test/domains-bundle.test.ts -t "ignore-parser"
```

before 侧 TTFT 基线数字（本批编码前同实例形态采集）：warm 47/65ms、walk 40/46/63ms（lead 50/400/700/1000ms 四组 37–63ms）、fresh 87/227ms、压测 896ms——原始输出见本批 tree-plant `.run/` 历史与 [tp-fact-check-batch4.md](../tp-fact-check-batch4.md) F6/F7。
