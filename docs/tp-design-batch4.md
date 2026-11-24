# 设计文档 · 批4「TTFT（首 token 延迟）」

> 分支 `feat-cpu-gpu-performance` · 前置 = 批1/批2/批3 已 delivered（HEAD `e5cc777fd`）。
> 依据 = [adversarial-review-glm.md](../perf/adversarial-review-glm.md) A4③/A5/S6/S9/F5（本批直接依据）+ [perf-measured-report.md](../perf/perf-measured-report.md) §1.2 第 5 条。前后对比口径照 [batch1](batch1-comparison.md)/[batch2](batch2-comparison.md)/[batch3](batch3-comparison.md)-comparison.md，对比表落 [batch4-comparison.md](batch4-comparison.md)。

## 背景与目标

GLM 对抗审查指出数据里两个未入榜的用户可感知项（S6/A4③/F5）：① **prompt 路径的 runtime ~0.9s 同步 CPU 突发**（ruleMatchesPath 0.50s + readdir 0.37s + writev 0.13s + parseJsonl 0.05s，日志显示 `send: type=prompt` 后紧跟 `.gitignore 读取/编译`、每次 prompt 编译两次），审查推断「阻塞 runtime 事件循环 = 首 token 转发被顶后 ~0.9s」；② **pi 冷启动 20+ 秒 CPU 满载**（jiti 4.74s + statSync 4.05s + NodeError 0.72s…，`restore elapsed=20443ms`）。

本批先用真机测量把两个问题的机制钉死（扎根结论见下），再据此定方案。**关键实测结论（本批设计的基石）**：

1. **「.gitignore 编译阻塞首 token 转发」不成立（测量证伪）**。TTFT 探针（`probes/perf-ttft.mjs`）三模式实测：warm（pi 热、无文件请求）47–65ms；walk（prompt 同时刻并发 file.tree + file.search 两次全树 ignore 匹配，worktree cwd 实测单次全树 walk 341ms/5000 文件截断）40–65ms——**与 warm 地板无统计差异**；机制压测（prompt 在途时并发 12 个全树 walk）TTFT 才劣化到 896ms。结论：runtime 的 WS 消息处理是 fire-and-forget 并发（connection-manager.ts:225-252），文件 walk 与 pi stdout 数据事件在事件循环里交错，**真实负载下 walk 不在 TTFT 关键路径上**；审查的「~0.9s 阻塞」是把「prompt 窗口内的 CPU 成本」误推为「转发延迟」。
2. **walk 的真实成本是 CPU 浪费**：全树 walk 的 matchPath 占大头——实测（`probes/perf-ignore-match.mjs`，仓库真实 .gitignore 82 规则 × 真实路径语料 6960 条）：改造前 229ms/轮（33µs/call），其中 27 条通配规则的 regex 逐前缀求值占 131ms。
3. **「每 prompt 编译两次」是两次请求各编译一次，不是并发重复**：file.tree（FileView 挂载）与 file.search（useChatViewDeps 挂载）在会话激活时先后到达（日志实测相隔 ~53ms），单次读+编译亚毫秒-毫秒级（file-service.ts 503-507 裁决注释口径），**在途合并（in-flight coalescing）不适用**（请求到达时前一次已 settle）。
4. **pi 冷启动 20s 是 dev 形态成本，prod 不是**：`probes/perf-pi-coldstart.mjs` 直接 spawn pi 二进制对照——dev 源码扩展集（22 个 TS 源扩展，jiti 加载）23.2s 墙钟 / 9.0s CPU；packaged bundle 扩展集（esbuild 自包含 index.js）4.5s / 3.7s（**5.1x / 2.4x**）。根因 = jiti 2.7.0 的 fsCache 只缓存转译产物、**不缓存模块解析**，每次冷启动对 ~1000 个 TS 模块（22 扩展 + shared 库 + subagent-core 传递图）重跑 statSync/ENOENT 解析风暴（profile 的 statSync 4.05s + stat 1.85s + NodeError 0.72s 全部来自 jiti `moduleResolve`，find-callers 实证）。

| 编号 | 目标 | 题面原句（逐字） | 限定词落点 | case/落点 |
|---|---|---|---|---|
| G1 | 定位 prompt 路径 runtime 同步阻塞的根因并修复/缓解 | 「定位并修复/缓解 prompt 路径的 runtime 同步阻塞（基线 ~0.9s/次，每 prompt 重复编译两次）」 | 机制：根因 = 全树 ignore 匹配（matchPath）的 CPU 成本 + 双请求双 walk；缓解 = matchPath 段级快路径（三形态，语义逐字节等价，oracle 测试锁定）；TTFT 机制经实测证伪并登记 | T1,T2 |
| G2 | 铁律：不恢复 mtime 缓存、不引入时间窗缓存 | 「不得恢复 .gitignore mtime 缓存」「不得引入时间窗缓存/轮询兜底」 | 机制：快路径是纯计算优化（编译期预计算判据、匹配期字符串比较），零缓存零时间窗；裁决注释随实测数据更新（编译成本量级登记） | T2 |
| G3 | pi 冷启动根因定位 + 优化或明确不可优化结论 | 「pi 冷启动 20s CPU 风暴完成根因定位，给出优化或明确的「不可优化+理由」结论」 | 机制：根因 = dev 形态 jiti TS 加载（实测 5.1x 于 packaged bundle）；taiji 侧可行解全部有不可接受代价（见「冷启动结论」节），上游禁改 | T3 |
| G4 | TTFT 前后对比表（同 harness） | 「TTFT（send → 首 token/首帧）前后对比表（同 harness）」 | 机制：同 fixture（faux 200TPS）、同实例形态、同探针（probes/perf-ttft.mjs）三模式（warm/walk/fresh）+ 匹配成本基准（probes/perf-ignore-match.mjs） | T1,T2 |
| G5 | 三包 test+typecheck 全绿 | 「三包 test+typecheck 全绿」 | 不可机验：由 trunk/leaf gate 的 testCommand + typecheckCommand 承载（非真机探针） | 不可机验：gate 承载 |

## 验收是什么

实机验收重点 = **TTFT 三模式前后对比（walk 模式证明文件 walk 不在关键路径 + 优化后匹配成本下降）+ 匹配等价性（oracle 单测承载）+ 冷启动对照（dev vs bundle 实测）**。真机部分走 dev 实例 + faux LLM + CDP/WS 真实采集（禁单测 runner 冒充实机）；等价性 oracle 与覆盖度自检归 testCommand。阈值类 case 兼顾「上界阈值 + 下界在场有效性」双断言（防「窗内什么都没发生」与「优化生效」同为 0 的假 PASS——TTFT 探针以 gitignore 编译次数 + 首帧到达双事实判据）。验收判据 = acceptance.md（本任务 = `docs/tp-acceptance-batch4.md`）的实机 case 全绿。

## 树形拆分

主干 = TTFT 测量基建（`probes/perf-ttft.mjs` 三模式探针 + `probes/lib/harness.mjs` 复用）+ 诊断探针（`probes/perf-pi-coldstart.mjs` 冷启动对照 + `probes/perf-ignore-match.mjs` 匹配成本基准）——探针在当前 HEAD（批3 已 delivered 代码）上先跑出基线，证明测量有效且「walk 不阻塞 TTFT」的结论可复现。一枝一目标：B-prompt-path（matchPath 段级快路径 + 裁决注释实测更新）。冷启动（B-cold-start）= 纯诊断结论，无代码改动，其「实现」= 设计文档结论节 + 对比表登记（不可优化的理由链）。

主干文件清单（trunk 期允许改动）：
- probes/
- probes/lib/
- .tree-plant.json
- docs/tp-design-batch4.md
- docs/tp-acceptance-batch4.md
- docs/tp-api-batch4.md
- docs/tp-fact-check-batch4.md

> 范围注记：.tree-plant.json 与四份 tp 文档属 trunk 期基础设施（门禁配置 + root 阶段产物——工具链把未提交文档计为改动，故登记进主干清单）；探针 = TTFT 测量与诊断基建（在当前 HEAD 即绿，证测量有效且「walk 不阻塞 TTFT」可复现）。runtime 代码改动归 B-prompt-path 枝，不在主干范围。testCommand 收窄至 @taiji/runtime（本批唯一改动包；四包链超 gate 900s 超时）——core/ui/frontend 三包未触达，其套件在批1-3 交付时为绿且本批零改动，typecheck 四包恒跑。

| 枝名 | 目标 | 依赖 | 风险级 | 文件 | case |
|---|---|---|---|---|---|
| B-prompt-path | G1/G2：matchPath 段级快路径（字面量 / 单星号无斜杠 / `**/字面量` 三形态）+ oracle 等价测试（含修剪 P1 连续斜杠回归）+ 裁决注释实测数据更新 + 匹配成本基准探针 + 属性式模糊对拍探针（修剪 card-04/05 证据，随交付入库） | trunk | 高 | packages/runtime/src/infra/fs/ignore-parser.ts, packages/runtime/test/domains-bundle.test.ts, packages/runtime/src/services/file-service.ts, probes/perf-ignore-match.mjs, probes/ignore-match-fuzz.mjs, probes/tree-flags-probe.mjs, docs/tp-design-batch4.md, docs/tp-fact-check-batch4.md, docs/tp-acceptance-batch4.md | T2,T4,T5 |
| B-cold-start | G3：冷启动根因结论（dev jiti TS 加载 5.1x；taiji 侧不可优化理由链）——无代码改动，结论落设计文档 + 对比表 | trunk | 中（结论风险） | docs/tp-design-batch4.md, probes/perf-pi-coldstart.mjs, docs/perf/batch4-comparison.md | T3,T6 |

> 范围注记：B-prompt-path 不触碰 file-service 的 walk 结构（searchFilesInCwd 的递归/并发/截断语义）与 loadMatcher 的无缓存直读裁决——快路径是 ignore-parser.ts 内的纯计算替换；file-service.ts 的改动仅「裁决注释补实测数据」（编译成本量级、在途合并不适用的理由），零行为变更。docs/tp-design-batch4.md 与 docs/tp-fact-check-batch4.md 在本枝的改动 = 修剪 P1（连续斜杠 coverage 怪癖）的发现登记与本枝范围声明本身（自指登记，审计入口 = git log <trunk commit>..本枝 commit）；docs/tp-acceptance-batch4.md 与 probes/tree-flags-probe.mjs 的改动 = 本枝首次 gate 暴露的验收资产缺陷修正（命令列反引号被 sh 当命令替换执行；探针误用 TS 类型注解 + dirOnly 目录自身预期写反 + listTree 层级误判）——验收资产正确性修正，非交付物行为变更。渲染侧候选方案（空会话跳过白名单加载）经评估不采纳：history 加载与 watch(sessionId) 存在竞态，「会话有无消息」无同步可靠信号，误跳转会导致切会话时路径链接化闪烁——理由登记进设计文档「显式不做」。

## 方案要点（每枝）

**B-prompt-path（matchPath 段级快路径）**：

- **三形态快路径化**（`computeFastPath`，编译期为每条规则预计算判据；匹配期 `fastRuleMatches` 用字符串/段比较替代 `regex.test`）：
  1. **字面量**（无 `*` / `?`）：regex 形态退化为 `^L$` / `(?:^|/)L$`（元字符已转义）。锚定判据 = `path === L \|\| path.startsWith(L + '/')`（L 可含 '/'）；非锚定判据 = 段成员（`L ∈ path 的段`，dirOnly 时须为严格祖先段——首现下标 < 段数-1）。
  2. **单星号**（恰一个 `*`、两侧不含 `/` 与 `?`）：regex 段形态 `P1[^/]*P2`，`[^/]*` 不跨斜杠 ⇒ 段判据 = `startsWith(P1) && endsWith(P2) && 长度 ≥ P1+P2`（`[^/]*` 可空，长度下限不可省）；锚定时命中的前缀必须整体无 '/' ⇒ 仅首段可命中（coverage：单段路径 = isSelf，多段 = isAncestorDir）。
  3. **`**/字面量`**（含 `/**/字面量`）：regex `^(?:.*/)?L$` 的 `^` 被 `(?:.*/)?` 吸收 ⇒ 与非锚定字面量等价（gitignore 文档明示 `**/foo` ≡ `foo`）；rest 含 '/'（如 `**/foo/bar`，末两段匹配）不快路径化。
  - 保守排除（恒走 regex）：多星号、星号两侧含 '/'、`**` 跨目录、`?` 通配、空 pattern、含反斜杠 pattern。
- **语义逐字节等价（本枝的第一风险）**：规则扫描序 + last-match-wins、coverage 判据（isSelf / isAncestorDir / dirOnly 不匹配同名文件）、normalizePath 反斜杠归一（含反斜杠 pattern 两侧都永不命中）、元字符字面量与历史怪癖（`a(b|c)+^d${e}\f` 不自匹配——锚定测试在册）全部不变。等价性由 **oracle 测试**锁定：改造前算法原样内联作 oracle，合成规则语料（形态空间全覆盖）× 合成路径语料（确定性生成）+ 仓库真实 .gitignore 全量快照（82 条）× 合成路径，全交叉断言；另加「覆盖度自检」（真实 .gitignore 的 76/82 条须进快路径，防优化空转）。
- **[修剪 P1 已修] 连续斜杠路径的 coverage 怪癖**：旧算法的前缀是折叠空段后的 join（`'a//b'` → 前缀 `'a/b'`），而 coverage 判据 `path.startsWith(prefix + '/')` 对**原始归一化路径**判——`'a//b'.startsWith('a/b/')` 为 false ⇒ 命中段落在 `//` 之后的规则（如 `b`）旧算法判不命中。初版快路径按段成员判定会误判 true（修剪模糊探针 16000 例抓到 13 例）。修正：coverage 一律按调用预计算、对原始路径判（`coverageOf`），与 regex 路径逐字节一致。回归锁定：oracle 套件「连续斜杠 × 单规则集」定点用例 + 属性式模糊对拍探针（`probes/ignore-match-fuzz.mjs`，随机规则集 × 随机路径，10 种子 × 32000 例零分歧）。
- **收益实测**（`probes/perf-ignore-match.mjs`，真实语料 6969 路径）：见对比表——改造前 regex 逐前缀 vs 现行快路径，同语料同时段计时，加速比 **2.2–2.5x（安静窗 load ~5：265→114ms / 244→109ms；高负载 load 8–27 下 2.05–3.83x 波动）**；绝对毫秒数受负载放大，结论取比率。全树 walk 的匹配成本占比约 67%，walk 总墙钟相应下降。
- **file-service.ts 裁决注释更新**：原注释（U1 1-2 裁决）称「读盘编译微秒-毫秒级」——本批补实测数据（单次读+编译亚毫秒级；双请求双编译非并发、在途合并不适用；真正的 prompt 窗口成本是全树 walk 的 matchPath，已由快路径缓解）。**不恢复任何缓存**（G2）。

**B-cold-start（诊断结论，无代码改动）**：

根因链（全部实测，探针可复跑）：
1. pi 二进制 = Bun 编译 SEA（`apps/electron/resources/pi/pi-darwin-x64`），不食 NODE_OPTIONS；
2. 扩展加载：extension-resolver dev 分支传**源码目录**（`extensions/<group>/<pkg>/`，TS），packaged 分支传 **staged bundle**（esbuild 自包含 index.js）；
3. pi 经内置 jiti 2.7.0 加载 TS 扩展：fsCache 只缓存转译产物（`os.tmpdir()/jiti`，实测 3710 条缓存条目在命中），**模块解析不缓存**——每次冷启动对 ~1000 个 TS 模块重跑 statSync/ENOENT 探测（profile：statSync 4.05s + stat 1.85s + NodeError 0.72s + jiti self 4.74s，find-callers 实证全部来自 jiti `moduleResolve`）；
4. 对照实测：dev 23.2s/9.0s CPU vs bundle 4.5s/3.7s CPU（5.1x/2.4x）。

taiji 侧可行解与否决理由：
- **dev 改用 staged bundle**：extension-resolver [HISTORICAL] 注释明确记录该形态已被主动放弃（改源码需跑全量 bundle ~40s + 重启 dev，「彻底消除 dev 的 bundle 成本」是现行决策）——恢复 = DX 回归，超出性能批次的裁决范围；
- **预构建 shared 库 dist**：只覆盖扩展的传递依赖图一部分（subagent-core 399 个 TS 文件仍是源），jiti 解析成本的大部分仍在，且改变 workspace 构建形态；
- **减少扩展数**：mandatory-extensions.json 是产品功能 SSOT，删功能换启动速度 = 产品回归；
- **预热 pi 槽**：warmup-pi-slot 已存在且只服务「冷切/崩溃恢复」的会话切换（消费驱动、签名匹配），对「全新 session 首 prompt」无命中路径（新 session 的 preset/cwd 签名事先未知）；app 启动期预热 = 把 20s 移到启动期，用户感知从「首 token 慢」变成「app 慢」，且仍不覆盖 agent 编程式建会话；
- **改上游 pi**（jiti 解析缓存 / 惰性扩展加载）：仓规铁禁（不修改 pi 源码、不提 PR、不 fork）。

**结论：prod 不受影响（bundle 形态 4.5s）；dev 的 20s 是 jiti TS 源码加载的固有成本，taiji 侧无可接受解，登记为不可优化（附理由链）**。用户可感知形态说明：真实用户流（建会话 → 打字 → 发送）下冷启动与打字重叠；受影响形态 = 自动化/编程式建会话即发（session-manager agent 通路）与「秒发」用户。

## 非功能设计

- **等价性优先于收益**：快路径任何语义漂移 = 文件树/搜索的 ignored 标记错误（文件被错误隐藏/显示）——oracle 测试（6960 真实路径 + 全形态合成语料）是第一交付物，收益第二。
- **零缓存零时间窗**：快路径是编译期预计算 + 匹配期纯函数，不引入任何跨调用状态（G2 铁律）。
- **失败显式化**：快路径无新失败形态（纯计算）；regex 路径的既有容错（per-dir try/catch、readIgnoreFile 失败→空规则）不变。

### 显式不做

| 项 | 理由 | 题面提及 | 重审触发 |
|---|---|---|---|
| 恢复 .gitignore mtime/身份戳缓存 | 在册裁决 U1 1-2（「同毫秒等长写」陈旧窗口）；实测编译成本 0.178ms/次，缓存无收益 | 是（铁律明禁） | —（红线，不设重审） |
| 在途合并（in-flight coalescing）编译 | 实测双请求相隔 ~53ms、单次编译 0.178ms——非并发，合并永不触发；死代码不如不写 | 否 | 实测出现同 tick 并发编译（如 split mode 双 panel 同帧挂载）时 |
| 渲染侧「空会话跳过白名单 file.search」 | history 加载与 watch(sessionId) 竞态，「有无消息」无同步可靠信号；误跳过 = 切会话路径链接化闪烁（推断 I2） | 否 | sessionStore 暴露同步消息数判据时 |
| walk 分片让出（setImmediate 批处理） | 实测真实负载下 walk 不在 TTFT 路径（40-65ms）；本仓库最大目录同步块 ~3ms；让出不降总 CPU 且给 D7-4 并发 walk 增加调度风险 | 否 | 实测单目录同步块 >50ms（超大扁平目录仓库）时 |
| 搜索深度/结果上限调整 | 产品行为变更（composer 候选与链接化白名单的覆盖面），超出本批范围 | 否 | 白名单漏链的用户反馈积累时 |
| pi 上游修改（jiti 解析缓存/惰性加载） | 仓规铁禁（不修改 pi 源码、不提 PR、不 fork） | 是（铁律明禁） | —（红线，不设重审） |
| dev 改 staged bundle / 删 mandatory 扩展 / 启动期预热 pi | DX 回归（extension-resolver [HISTORICAL] 决策记录）/ 产品回归 / 感知转移到启动期且不覆盖编程式建会话 | 否 | 用户裁决重新权衡 dev 启动成本 vs live-edit DX 时 |
| 探针脚本类型层（probes/ .mjs） | 真机采集/诊断探针为零依赖 Node 一次性脚本（沿用批1/批2/批3 口径），不进 tsc 类型层；T2/T3 探针经仓库既有 tsx 运行（dev 依赖，非新增） | 否 | 探针引入跨文件复用/复杂逻辑，或被非采集链路依赖时 |

## 冷启动结论（G3 登记）

见上「B-cold-start」：**dev 固有成本（jiti TS 源码加载，实测 5.1x 于 bundle 形态），taiji 侧无可接受解，登记不可优化**；prod 用 bundle 形态不受影响（4.5s）。复算命令与原始数据落 [batch4-comparison.md](batch4-comparison.md) §冷启动节。
