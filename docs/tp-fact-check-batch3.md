# 事实核查文档 · 批3

分类三值：**事实**（证据 = 文件:行号 或探针/日志输出）· **推断**（合理推导未核实，登记进「未核实风险」）· **虚构**（无依据臆断，标作废并删分支）。

## 探针输出存档

root 期实跑，脚本与输出均落 `.run/`（git 忽略，可复跑）：

| 探针 | 复跑命令 | 输出文件 |
|---|---|---|
| shiki 无 DOM 实跑 | node_modules/.bin/tsx .run/probe-shiki-nodedom.mts | .run/probe-shiki-nodedom.txt |
| happy-dom Worker 缺席 | node -e 一行 Window 探针（见 .run/probe-happy-dom-worker.txt 头部注释） | .run/probe-happy-dom-worker.txt |
| CSP × worker 双形态 | env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron .run/probe-csp-worker.cjs | .run/probe-csp-worker.txt |
| fixture 形态 | python3 读 faux-responses.json（脚本见 .run/probe-fixture-shape.txt 头部注释） | .run/probe-fixture-shape.txt |
| tsx 通道 | node_modules/.bin/tsx --version | .run/probe-tsx-highlight.txt |

F3 的否定性搜索命令（shiki 全 dist + @shikijs 四包 dist，grep 四个 DOM 全局标识）与逐条命中核对记录，见 `.run/probe-shiki-nodedom.txt` 尾部注释段。

## 论据三分类表

| 编号 | 论据 | 分类 | 证据 | 说明 |
|---|---|---|---|---|
| F1 | fence 闭合的 shiki 同步高亮发生在 fence 规则内，调用链 = renderMarkdown → md.render → fence 规则 | 事实 | packages/ui/src/features/chat/markdown.ts:231 packages/ui/src/features/chat/markdown.ts:252 packages/ui/src/features/chat/markdown.ts:181 GLM 审查完整链登记于 docs/perf/adversarial-review-glm.md | 时刻 = fence 闭合而非 complete（审查实证 complete 处零 shiki） |
| F2 | markdown-it 的 render 内部就是 renderer.render(parse(src, env), options, env)——拆成显式三段零行为变化 | 事实 | node_modules/markdown-it/lib/index.mjs:529 版本见 node_modules/markdown-it/package.json | parse 与 render 共用同一 env（trust slot 与 filePaths 白名单经 env 透传）语义不变 |
| F3 | shiki fine-grained core + JS 正则引擎 + 静态 grammar/theme 不依赖任何 DOM API，可在 Web Worker（无 document/window）运行 | 事实 | .run/probe-shiki-nodedom.txt （Node v22 无 document/window/Worker，createHighlighterCore init 9ms 后 codeToHtml 产出 1081 字符 HTML） 否定性搜索记录同文件尾部 | 搜索半径 = shiki 全 dist + @shikijs 四包 dist；langs 目录的命中逐条核对为 grammar 内部字符串（如 at-rule scope 名），非 API 调用 |
| F4 | happy-dom 不定义 Worker 全局 → 客户端默认工厂直接回落主线程同步路径，既有 markdown 测试零改动 | 事实 | .run/probe-happy-dom-worker.txt （happyDomWorker=undefined） 测试环境配置 packages/ui/vitest.config.ts | 测试内不会误建 worker；vi.mock 的 shiki stub 经同步回退路径消费，输出不变 |
| F5 | file:// 文档（打包态）+ script-src 'self' CSP 可创建同源 file:// module worker（含 import 链）；显式加 worker-src 'self' 后同样可建；http（dev 态）可建；blob: worker 在当前 CSP 下被拦（error 事件） | 事实 | .run/probe-csp-worker.txt （Electron 42.3.3 真实二进制，CSP 串与 packages/renderer/index.html:30 逐字一致） 单场景复跑 .run/probe-csp-one.cjs | 双形态差异结论：dev 与打包态都无需 blob:；worker-src 显式化只为意图登记 |
| F6 | 流式期未闭合 fence 走占位不跑 shiki；闭行到达后 advancePrefixCache 把含闭合 fence 的 piece 整段渲染（fence 规则同步 shiki）——即「fence 闭合冻结」的落点 | 事实 | packages/ui/src/features/chat/markdown-incremental.ts:671 packages/ui/src/features/chat/markdown-incremental.ts:632 占位 finalize 契约 packages/ui/src/features/chat/composables/useMarkdownStreaming.ts:168 | 占位机制本批零改动（G2 由 T4 断言） |
| F7 | getMarkdown 当前 await getHighlighter（md 实例与 shiki 单例耦合）；拆三段后 md 实例不再依赖 shiki 存在 | 事实 | packages/ui/src/features/chat/markdown.ts:201 packages/ui/src/features/chat/markdown.ts:139 | fence 规则闭包中的 hl 引用（:231 起作用域）随之移除 |
| F8 | useMarkdownStreaming 持有 incrementalCache（per-instance opaque 句柄）且有 onScopeDispose——天然的「取消组」挂点 | 事实 | packages/ui/src/features/chat/composables/useMarkdownStreaming.ts:54 packages/ui/src/features/chat/composables/useMarkdownStreaming.ts:124 packages/ui/src/features/chat/composables/useMarkdownStreaming.ts:180 | 组令牌 = cache 对象（每消息每实例唯一）；split mode 双实例各持各的 cache，组取消不跨 pane |
| F9 | shiki 4.3.1，引擎恒 JS regex（Oniguruma WASM 被 CSP 拦的历史教训在册）→ worker 内无 WASM 加载，本批不触 wasm-unsafe-eval 评估 | 事实 | node_modules/shiki/package.json packages/ui/src/features/chat/markdown.ts:148 .githooks/check_csp_compatibility.py | 产物级 WASM 扫描见 scripts/postbuild-validate.sh |
| F10 | 验收 fixture 形态：首轮响应 45326 字符 / 792 行 / 单个约 600 行 fence（首个 fence 开行在第 5 行，开闭各一个 marker） | 事实 | .run/probe-fixture-shape.txt （chars=45326 lines=792 fenceMarkers=2 firstFenceLine=5） | 数据源路径见 docs/tp-acceptance-batch3.md 头部；与 GLM 审查 S4 登记的极端形态一致 |
| F11 | node_modules/.bin/tsx（v4.23.0）可在仓库内 import ui 包 shiki 配置模块（.ts）并实跑高亮——T2 探针的同源重算通道成立 | 事实 | .run/probe-tsx-highlight.txt .run/probe-shiki-nodedom.txt | markdown.ts 本体因 import katex.min.css 不可直接入 Node，故 T2 引无 CSS 依赖的 shiki 配置模块（同一 createHighlighterCore 与 codeToHtml 函数） |
| F12 | worker 与主线程高亮产物一致性由「同一配置模块 + 同一高亮函数」构造性保证（而非对拍兜底） | 事实 | packages/ui/src/features/chat/markdown.ts:88 packages/ui/src/features/chat/markdown.ts:120 packages/ui/src/features/chat/markdown.ts:127 packages/ui/src/features/chat/markdown.ts:148 packages/ui/src/features/chat/markdown.ts:181 抽取方案登记于 docs/tp-design-batch3.md 与 docs/tp-api-batch3.md | T2 对拍是该保证的回归防线，不是唯一防线 |
| F13 | 「分帧 tokenize 对单块无效 / 可视区优先粒度不匹配」两条替代路线已被审查否决，Worker 是唯一与块大小无关的解 | 事实 | docs/perf/adversarial-review-glm.md （D6 节与 D0 表 CPU-2 行） | 本批不做这两条 |
| F14 | 基线 shiki 族 self-time（流式窗 +10..+73s）：findNextMatchSync 1.257s + #execCore 0.561s + shiki_core 0.722s ≈ 2.54s（模块合计 2.96s），单次抽样跨运行 1.16 / 3.15 / 3.26s | 事实 | docs/perf/adversarial-review-glm.md （B 表与 C4） 基线产物 ~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data/run-notrace-renderer.cpuprofile | 阈值 0.3s = 基线 1/8 以下，任何「冻结回退」都会打红 |

## 外部接口核实表

| 接口 | 形态 | 依据 | case |
|---|---|---|---|
| new Worker 同源 module worker | Vite/rolldown 标准 worker 模式；dev = 同源 dev-server URL，打包 = file:// asset；CSP 经 worker-src（显式）回落 script-src 'self' 放行 | .run/probe-csp-worker.txt packages/renderer/vite.config.ts packages/mobile-renderer/vite.config.ts | T1,T5 |
| shiki createHighlighterCore 与 codeToHtml（worker 内，无 DOM） | createHighlighterCore 装配后 codeToHtml；lang 未加载回落 typescript；抛错返回空串 | .run/probe-shiki-nodedom.txt packages/ui/src/features/chat/markdown.ts:139 | T1,T2 |
| CDP Profiler.start 与 Profiler.stop（renderer 主线程） | 无 tracing；profile 只含主线程——worker 成本不经此口径（改由 worker 日志登记） | scripts/perf-probes/lib/harness.mjs | T1 |
| CDP Network.setBlockedURLs | 按 URL 模式拦截 worker 脚本加载 → worker error 事件 → 降级路径 | scripts/perf-probes/lib/harness.mjs （CDP 通道已具备） | T3 |
| runtime WS delivery.submit 与 chat.wait | 起流式 / 等 complete | scripts/perf-probes/perf-derivatives.mjs scripts/perf-probes/vp/vp.mjs | T1,T2,T3,T4 |
| DOM 提取面 | .md-codeblock 容器（data-code base64 + lang 标签 + pre.shiki）；data-testid=md-streaming-fence 占位 | packages/ui/src/features/chat/markdown.ts:264 packages/ui/src/features/chat/MarkdownRenderer.vue | T2,T3,T4 |
| CSP meta（两壳 index.html） | renderer = file:// 打包态；mobile-renderer = runtime HTTP 托管态；均为 script-src 'self' | packages/renderer/index.html:30 packages/mobile-renderer/index.html:17 | T5 |
| worker 消息协议 | 主到 worker 的 jobs 与 cancel 两类消息；worker 回主线程的 result / jobError / log 三类消息；无 ready 握手（worker 内部排队） | docs/tp-design-batch3.md docs/tp-api-batch3.md | T1,T3 |
| MarkdownEnv 信任槽机制 | Symbol 键挂 env，净化后回填；本批高亮缓存同形态（内部字段，不进公开协议、不进增量轴 env 签名） | packages/ui/src/features/chat/markdown-sanitize.ts:55 packages/ui/src/features/chat/markdown-sanitize.ts:64 packages/ui/src/features/chat/markdown-sanitize.ts:228 packages/ui/src/features/chat/markdown-types.ts:57 | T2 |

## 未核实风险

- I1（推断）：worker chunk 与主 chunk 经 code splitting 共享 shiki 模块，产物净增约等于一份 shiki 引擎代码——rolldown 分组行为未实测。处置：B-worker 期跑一次 renderer 生产构建核对产物（worker chunk 不重复打包两份 shiki）；若重复则补 codeSplitting 分组配置。
- I2（推断）：探针实证 file:// 加 'self' 可建 worker（F5），但「Chromium 对 file: 源按 scheme/host/port 匹配 self」的机制解释未从 Chromium 源码核实——行为已实证，机制解释仅作文档背景。处置：Electron 升级时重跑 T5 复核。
- I3（推断）：getMarkdown 不再 await getHighlighter 后，主线程在常规聊天路径省掉一次 shiki 引擎初始化（首屏/流式期）——量级未测，只登记方向不承诺数值。
