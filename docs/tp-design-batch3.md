# 设计文档 · 批3「fence 闭合高亮移出主线程」

> 分支 `feat-cpu-gpu-performance` · 前置 = 批1/批2 已 delivered（HEAD 6be6b64ff：派生归零 + 稳定引用 props + 强制布局纪律）。
> 依据 = [docs/perf/adversarial-review-glm.md](../perf/adversarial-review-glm.md) F 节建议 3 / C4 / D6 / M6（本批直接依据）+ [perf-measured-report.md](../perf/perf-measured-report.md) §1.2 第 5 条。前后对比口径照 [batch1-comparison.md](../perf/batch1-comparison.md) / [batch2-comparison.md](../perf/batch2-comparison.md)，对比表落 [batch3-comparison.md](../perf/batch3-comparison.md)。

## 背景与目标

批1/批2 之后，批2 after TOP10 里 `findNextMatchSync` 0.983s 仍居第 5（shiki fence 闭合高亮）——本批攻它。

问题实证（GLM 对抗审查 C4/M6，复算脚本可从基线 cpuprofile 复现）：shiki 语法高亮的突发发生在 **fence 闭合时刻**（流式中途、全文约 60% 处，`markdown.ts` 的 fence 规则 → `highlightShikiSync` 同步 `codeToHtml`），**不是**消息 complete 瞬间（complete 处实测零 shiki）——单次实测 1.16s / 3.15s / 3.26s 主线程硬冻结，用户正盯着文字流时发生。机制原因：D-5 增量渲染流式期对未闭合 fence 走 streaming-fence 占位（不跑 shiki）；闭行到达后边界前进把整个 fence 纳入前缀缓存，`advancePrefixCache` → `renderMarkdownSegments(piece)` → fence 规则一次同步 `codeToHtml`（600 行 fence 就是一次调用）。

审查已判定两条替代路线无效：**分帧 tokenize 对单块无效**（一个 600 行 fence 就是一次 `codeToHtml`，无增量接口）；**「可视区优先」粒度不匹配**（virtua 虚拟化粒度是 turn 不是行）。结论：**Web Worker 高亮是唯一与块大小无关的解**（审查 F3/D6）。

| 编号 | 目标 | 题面原句（逐字） | 限定词落点 | case/落点 |
|---|---|---|---|---|
| G1 | fence 闭合的 shiki 高亮移入 Web Worker | 「把 fence 闭合的 shiki 高亮移入 Web Worker（主线程发「代码文本+语言」给 worker，worker 跑 codeToHtml 回填 HTML）」 | 机制：`md.render` 拆为 `md.parse` + 预解析 fence 高亮（worker）+ `renderer.render` 三段；fence 规则改为读 env 内高亮缓存；闭合同步路径整体移出主线程 | T1,T2 |
| G2 | 流式期占位行为不变 | 「fence 未闭合的流式期继续走已有 streaming-fence 占位不跑 shiki——保留」 | 机制：不触碰 `markdown-incremental.ts` 的占位分支与 finalize 契约（complete 单触发源）；worker 只承接「已闭合 fence 的高亮」 | T4 |
| G3 | CSP 评估与放行登记 | 「CSP 评估（shiki WASM 已在 CSP 内，但 Worker 需 worker-src/script-src 放行——查 packages/renderer 的 CSP 定义并在设计文档登记为一次性评估项）」 | 机制：两壳 CSP 显式加 `worker-src 'self'`；file://（打包态）与 http（dev/移动壳托管态）双形态实测登记为本设计文档「CSP 一次性评估」节 | T5 |
| G4 | 失败降级不回丢高亮 | 「失败降级（worker 不可用如 CSP 被外部策略拦或抛错 → 回退主线程同步高亮，不能出现高亮永久丢失）」 | 机制：worker 创建抛错 / error 事件 / 单 job 抛错 / 任务被取消 → 该批 fence 回退主线程同步高亮（`getHighlighter` + 同一高亮函数）；降级出声（console.error）不静默 | T3 |
| G5 | 一次性成本登记 | 「一次性成本登记（worker 加载 + shiki 引擎在 worker 内初始化 + 内存常驻，进设计文档代价节）」 | 机制：worker 侧 init/job 耗时经消息回主线程 console 出声，探针采集进对比表「worker 侧成本登记」；主线程 shiki 副本改惰性（仅降级/drawer 才建） | T1 |
| G6 | 三包 test+typecheck 全绿 | 「三包 test+typecheck 全绿」 | 不可机验：由 trunk/leaf gate 的 testCommand + typecheckCommand 承载（非真机探针） | 不可机验：gate 承载 |

## 验收是什么

实机验收重点 = **fence 闭合窗口主线程 shiki self-time 归零（+ 在场有效性：高亮确实发生）+ 高亮产物与主线程路径逐字节对拍 + 降级路径真机可观测 + 流式期占位不变 + CSP 双形态实测**，全部走 dev 实例 + faux LLM + CDP 真实采集（禁单测 runner 冒充实机）；降级路径的单测状态机归长叶 testCommand。验收判据 = acceptance.md（本任务 = `docs/tp-acceptance-batch3.md`）的实机 case 全绿（T1–T5）。阈值类 case 兼顾「上界阈值 + 下界在场有效性」双断言（防「窗内什么都没发生」与「优化生效」同为 0 的假 PASS）。

## 树形拆分

主干 = 真机探针基建（T1/T2/T4/T5 四个探针 + harness console 采集扩展）+ 无回归 smoke（T4 在当前 HEAD 即绿，证明探针有效且占位行为基线可测）。三枝递进：核心路径（B-worker，含 G1/G2/G5）→ CSP 放行与登记（B-csp，G3）→ 降级路径硬化（B-fallback，G4）。生命周期/排队/单测补全归长叶。

主干文件清单（trunk 期允许改动）：
- scripts/perf-probes/
- scripts/perf-probes/lib/

| 枝名 | 目标 | 依赖 | 风险级 | 文件 | case |
|---|---|---|---|---|---|
| B-worker | G1 worker 化高亮主干 + G2 占位保留 + G5 成本出声 | trunk | 高 | packages/ui/src/features/chat/shiki-highlight-core.ts, packages/ui/src/features/chat/shiki-highlight-worker.ts, packages/ui/src/features/chat/shiki-highlight-client.ts, packages/ui/src/features/chat/markdown.ts, packages/ui/src/features/chat/markdown-incremental.ts, packages/ui/src/features/chat/composables/useMarkdownStreaming.ts, packages/ui/src/features/chat/__tests__/, scripts/perf-probes/shiki-html-diff.mjs, docs/tp-design-batch3.md | T1,T2 |
| B-csp | G3 两壳 CSP `worker-src 'self'` + 一次性评估登记 | trunk | 中 | packages/renderer/index.html, packages/mobile-renderer/index.html, scripts/perf-probes/csp-worker-probe.cjs | T5 |
| B-fallback | G4 降级路径硬化（error 事件 / 单 job 抛错 / 取消 → 主线程同步回退）+ 真机降级探针 | B-worker | 中 | packages/ui/src/features/chat/shiki-highlight-client.ts, packages/ui/src/features/chat/markdown.ts, scripts/perf-probes/shiki-fallback-probe.mjs | T3 |

> 范围注记：B-worker 的 markdown-incremental.ts 改动仅「把 cache 对象作为取消组令牌透传给 renderMarkdownSegments」（新增可选第三参，壳侧不传）；useMarkdownStreaming.ts 改动仅「卸载时按 cache 取消在途高亮组」。占位/finalize 逻辑零改动（G2 由 T4 断言）。T2 探针 scripts/perf-probes/shiki-html-diff.mjs 随本枝收尾一并修正：DOM outerHTML 序列化会把 > 转义为 &gt; 而 shiki 原串是字面 >（纯序列化差异），对拍前增加 HTML 实体解码归一化 + pre.shiki 回填轮询（complete 时 worker 可能在途）——属「worker 产物 vs 主线程同源算法」对拍的探针正确性修正，故声明进本枝文件列；docs/tp-design-batch3.md 的改动即本条范围声明本身（自指登记，审计入口 = git log 96eea45f..本枝 commit）。

## 方案要点（每枝）

**B-worker（Worker 化高亮主干）**：
- **渲染三段拆分**（行为保持）：`renderMarkdown` 由 `md.render(content, env)`（内部 = `parse` + `renderer.render`，markdown-it 14.3.0 `index.mjs:529-533` 实证）拆为显式三段：`md.parse` → 预解析 fence 高亮 → `md.renderer.render`。parse 产出 token 树，遍历 `type==='fence'` 的 token（markdown-it 块 token 是带嵌套层级的扁平表，blockquote/list 内的 fence 同在 `state.tokens`，无需递归 children）；跳过 mermaid / html-preview（fence 规则内已有分支，不走 shiki）；其余按 `(lang, code)` 去重成一批 job 发 worker；结果写 `env` 内高亮缓存（Symbol 键，管线内部自产自销，不进 MarkdownEnv 公开协议、不参与增量轴 env 签名）；`renderer.render` 的 fence 规则读缓存，未命中 → 既有降级串（转义 `<pre><code>`，内容不丢）。
- **配置单源**（防 worker 与主线程产物漂移）：现 `markdown.ts` 内的 shiki 装配（SHIKI_LANGS 13 项、min-dark/min-light 双主题、MF-1-27 扁平三色档 `toTaijiFlatCodeTheme`、JS 正则引擎、`highlightShikiSync` 的 lang 解析 + try/catch 语义）原样抽至 `shiki-highlight-core.ts`，主线程 `getHighlighter`/`highlightShikiSync` 与 worker 共用同一导出。CSP 历史教训（2026-08 Oniguruma 被拦事故）不重演：引擎恒 `createJavaScriptRegexEngine()`（禁回落 Oniguruma WASM，注释随迁）。
- **worker 协议**：主 → worker `{type:'jobs',jobs:[{id,code,lang}]}` / `{type:'cancel',ids}`；worker → 主 `{type:'result',id,html}` / `{type:'jobError',id,message}` / `{type:'log',level,msg}`（init/job 耗时，供成本登记）。worker 惰性建 highlighter（首条 jobs 触发），job 串行处理（单线程天然排队；多 fence 连续闭合 = 一批 job 一次往返）。
- **主线程零墙钟**：worker 往返不设任何超时/判死（ADR-0190 白名单外禁令；远程网络调用超时白名单不覆盖 worker postMessage）。失败信号只认确定性事件：`new Worker` 同步抛错、`error`/`messageerror` 事件、单 job `jobError`。
- **主线程 shiki 副本改惰性**：`getMarkdown` 不再 await `getHighlighter`（md 实例创建与 shiki 解耦）→ 常规聊天路径主线程永不建 shiki 引擎；`highlightCode`（drawer CodeBlock/DiffView）与降级路径才建。首屏/流式期主线程省掉一次 shiki 引擎初始化。

**B-csp（CSP 放行 + 一次性评估）**：
- 两壳 index.html CSP 显式加 `worker-src 'self'`（packages/renderer 桌面壳 = file:// 打包态；packages/mobile-renderer = runtime HTTP 托管态）。当前 CSP 无 worker-src 时按 CSP 回退链（worker-src → child-src → script-src → default-src）已落在 script-src 'self' 上、实测可建 worker，但显式登记把「worker 脚本与脚本同源策略」变成显式决策而非隐式依赖（防未来收紧 script-src 时静默断裂）。
- blob: worker 不采用（实测当前 CSP 下 blob worker 被拦，且无此需要——同源 URL worker 双形态实测通过）。评估全文见下「CSP 一次性评估」节。

**B-fallback（降级路径）**：
- 降级触发面：① `typeof Worker === 'undefined'`（vitest/happy-dom 等无 Worker 环境 → 直接同步回退，既有测试零改动通过）；② `new Worker` 同步抛错；③ worker `error`/`messageerror` 事件（CSP 被外部策略拦 / 脚本加载失败）→ 客户端永久 degraded + 全部在途 job 回退同步；④ 单 job `jobError` → 该 job 同步回退；⑤ job 被取消（组取消/全局取消）→ 该批同步回退（见长叶）。
- 降级语义：回退 = 主线程 `getHighlighter()` + 同一 `highlightWithHighlighter` 同步高亮后填入同一缓存 → fence 规则照常消费。**高亮不丢、内容不丢、DOM 结构不变**；每次降级 `console.error` 出声（2026-08 CSP 事故教训：静默吞错不可查）。

### CSP 一次性评估（G3 登记）

评估手段 = 真实 Electron 二进制 + 与 `packages/renderer/index.html` 逐字相同的 CSP meta（探针 `scripts/perf-probes/csp-worker-probe.cjs` 运行时读取该文件 CSP 串，不手抄），Electron 42.3.3：

| 形态 | CSP | 同源 URL module worker | 判定 |
|---|---|---|---|
| 打包态（file:// 文档 + file:// worker，script-src 'self' 现状） | 现状（无 worker-src） | **OK**（回退链落 script-src 'self'；Chromium 对 file: 源按 scheme+host+port 匹配 'self'） | 可用 |
| 打包态 + 显式 `worker-src 'self'` | B-csp 后 | **OK** | 可用（本批采用） |
| dev 态（http://127.0.0.1 文档 + 同源 worker） | 现状 | **OK** | 可用 |
| 任意态 + blob: worker | 无 `worker-src blob:` | FAIL（error 事件） | 不采用 |

双形态差异结论：dev 与打包态均无需额外放行；shiki WASM 不涉本批（引擎恒 JS regex，WASM 本就被 CSP 拦——`markdown.ts` 既有注释 + `.githooks/check_csp_compatibility.py` 守护）。残余风险 = 外部策略（企业注入的响应头 CSP / 未来壳层 CSP 重构）若拦 worker → error 事件 → 自动回退主线程同步高亮（G4），功能不丢、仅性能回退。

### 一次性成本登记（G5 代价节）

| 成本项 | 量级 | 处置 |
|---|---|---|
| worker 脚本加载 | 一次/页生命周期；dev = Vite 模块请求，打包 = file:// asset；worker chunk 与主 chunk 共享 shiki 模块（code splitting 去重），净增 ≈ 一份 shiki 引擎代码 | 探针 T1 采集 worker console 日志（init/job 耗时）进对比表 |
| shiki 引擎在 worker 内初始化 | 一次/worker 生命周期（13 grammar + 2 theme + JS 引擎装配）；与主线程原初始化同量级，但移出主线程且不再阻塞首屏 | 实测值由 T1 的 `[shiki-worker] highlighter init Xms` 日志给出，登记进对比表 |
| 内存常驻 | worker 常驻一份 shiki 引擎（grammar/theme JS 对象）；主线程副本改惰性后常规聊天路径净增 ≈ 一份 | 不主动回收 worker（页生命周期内复用；回收再建 = 重复 init 成本） |
| 每 fence 一次消息往返 | postMessage 结构化克隆（code 文本 + HTML 回传）；600 行 fence ≈ 数十 KB 级，克隆成本相对 codeToHtml 可忽略 | 批量 job 一次往返（多 fence 连续闭合不放大往返次数） |

## 非功能设计

| 项 | 类别 | 不做会怎样 | 预计多久出问题 |
|---|---|---|---|
| worker 与主线程高亮产物一致性 | 正确性 | 配置单源被破坏 → 降级路径与 worker 路径产物漂移 → 同一代码块两种视觉 | 改 shiki 配置时即触发（T2 对拍 + 单测锁定） |
| 高亮永不丢失（含降级） | 可靠性 | worker 被拦/抛错时若直接吐纯文本且无回退 → 高亮静默丢失（2026-08 CSP 事故同族） | worker 首次失败即触发（T3 真机 + 单测） |
| 在途任务可取消（切 session/页面隐藏） | 资源 | 切 session 后旧消息的高亮 job 继续跑完，后台白烧 worker CPU；页面隐藏时同理 | 流式中途切 session 即发生（长叶 + 单测） |
| 无墙钟判死 | 架构红线（ADR-0190） | worker 往返加超时 = 时间阈值判死回潮，pre-commit/审查拦截 | 引入即违规 |
| 探针脚本类型层（scripts/perf-probes/ .mjs/.cjs） | 工程纪律 | 探针零依赖一次性脚本（沿用批1/批2 口径），无 tsc 类型层 | 探针出现跨文件复用/被非采集链依赖时 |

### 显式不做

| 项 | 理由 | 题面提及 | 重审触发 |
|---|---|---|---|
| drawer CodeBlock/DiffView 也 Worker 化 | 本批射程 = 对话流 fence 闭合路径；drawer 非流式热路径，`highlightCode` 保持主线程 | 否（题面限定 fence 闭合） | drawer 代码块被实测进火焰图 TOP10 时 |
| 分帧 tokenize / 可视区优先 | 审查 D6/D0 已判：单块无增量接口、virtua 粒度是 turn 不是行 | 是（题面引审查结论否决） | shiki 暴露增量 tokenize API 时 |
| worker 超时/健康探测/自动重建 | ADR-0190 时间阈值判死禁令；失败只认确定性事件（error 事件/抛错），挂死收终归用户 | 否 | —（红线，不设重审） |
| 探针脚本类型层（scripts/perf-probes/ .mjs/.cjs/.mts） | 真机采集探针为零依赖 Node 一次性脚本（沿用批1/批2 口径），不进 tsc 类型层；T2 探针经仓库既有 tsx 运行（dev 依赖，非新增） | 否 | 探针引入跨文件复用/复杂逻辑，或被非采集链路依赖时 |
| 页面可见性恢复后的重渲染兜底 | rAF 在页面隐藏期天然暂停、可见时挂起帧自然续跑（事件驱动，非时间机制）；无需额外兜底 | 否 | 实测发现可见性恢复后高亮不恢复时 |
| 移动壳独立 worker 客户端 | 双壳共用 ui 包同一客户端（移动壳 HTTP 托管态同源 worker 实测可用），不复制实现 | 否 | 移动壳出现独立 CSP/构建约束时 |
| worker 池/多 worker 并发 | 单 worker 串行已覆盖本场景（一批 job 一次往返）；多 worker 增量收益未测量 | 否 | 实测 fence 密度高到单 worker 排队可感知时 |
| 旧 run 重放兼容（连字符工具名等） | 本批无工具名/协议面世变更，不涉及重放兼容 | 否 | 本批产物进入 session 持久化重放路径时 |
