# 事实核查 · 批4「TTFT（首 token 延迟）」

> 规则：设计只准建立在事实上；推断须登记进未核实风险；虚构作废并删除依赖它的方案分支。证据 = 文件:行号 或探针输出（探针可复跑，命令见 acceptance.md；实例数据目录与归档目录以 ~ 表示）。

## 一、论据三分类

| # | 论据 | 分类 | 证据 |
|---|---|---|---|
| F1 | runtime WS 消息处理是 fire-and-forget 并发（文件 walk 不阻塞后续 WS 消息） | 事实 | message 监听注册与 onMessage 不 await 调用。源码 packages/runtime/src/transport/connection-manager.ts:225 与 packages/runtime/src/transport/connection-manager.ts:252 |
| F2 | 两次 .gitignore 编译的触发源 = 渲染侧会话挂载（file.tree 来自 FileView；file.search 来自 useChatViewDeps） | 事实 | watch sessionId 即发两请求。源码 packages/renderer/src/components/sidebar/FileView.vue:273 与 packages/renderer/src/composables/panel/useChatViewDeps.ts:154 ，runtime handler packages/runtime/src/transport/file-message-handler.ts:77 |
| F3 | 激活时两次编译相隔约 53ms（非并发，在途合并不适用） | 事实 | dev 实例 runtime 日志两条 gitignore 编译行 07:51:48.934 与 07:51:48.987 ；打点源 packages/runtime/src/services/file-service.ts:540 |
| F4 | 单次 compileIgnoreRules 约 0.178ms（82 规则），重复编译本身可忽略 | 事实 | 本 session 复跑 hrtime 7 乘 100 取中位数得 0.178 ms 每次；被测函数在 packages/runtime/src/infra/fs/ignore-parser.ts |
| F5 | matchPath 成本：改造前 226.3ms 每轮降到快路径 80.2ms 每轮（2.82 倍），6961 条真实路径零分歧 | 事实 | 探针末行 RESULT old-ms=226.3 new-ms=80.2 speedup=2.82 calls=6961 ，前置门 equivalence OK 6961 paths 0 mismatch。探针 probes/perf-ignore-match.mjs |
| F6 | TTFT 实测：warm 47-65ms，walk 并发 file.tree 加 file.search 时 40-65ms，fresh 新建会话 GUI 流 87-227ms，walk 与 warm 地板无统计差异 | 事实 | 探针三模式 RESULT 行（dev 实例加 faux 200TPS，本批基线采集）。探针 probes/perf-ttft.mjs |
| F7 | 机制压测：prompt 在途时并发 12 个全树 walk，TTFT 劣化至 896ms（机制存在但真实负载不触达） | 事实 | 探针 walk 模式 stress 12 单轮得 ttft=896ms submit-rtt=276ms gitignore-compiles=14 。探针 probes/perf-ttft.mjs |
| F8 | 冷启动模块数：dev 源码集 1769 个 jiti 模块且 100% fsCache 命中零转译，packaged bundle 集 59 个（30 倍差距） | 事实 | JITI_DEBUG=1 直 spawn pi 计数得 dev cache hit 1769 miss 0 与 pkg cache hit 59 miss 0 ；spawn 形态依据 packages/runtime/src/infra/installers/extension-resolver.ts:209 |
| F9 | jiti 2.7.0 的 fsCache 只缓存转译产物，不缓存模块解析，成本在 resolution 的 statSync 风暴 | 事实 | jiti 源码含 getCache 与 prepareCacheDir 与 fsCache env 读取，加载入口传 moduleCache false 且未传 fsCache 故 env 默认开。源码 node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:472 与 node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/jiti-loader-C3NU2SDH.js |
| F10 | profile 的 statSync 4.05s、stat 1.85s、NodeError 0.72s 全部来自 jiti moduleResolve | 事实 | find-callers 对归档 pi profile 输出 statSync 上行链为 tryStatSync 到 moduleResolve 到 resolveSync ；jiti 侧源码同上 node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/jiti-loader-C3NU2SDH.js |
| F11 | dev 传源码目录，packaged 传 staged bundle（esbuild 自包含 index.js） | 事实 | scanBundledExtensions 双分支及历史三阶段记录。源码 packages/runtime/src/infra/installers/extension-resolver.ts:209 ；dev-instance 启动日志 argv 实证 |
| F12 | warmup-pi-slot 消费驱动，只服务冷切与崩溃恢复的会话切换，对全新 session 首 prompt 无命中路径 | 事实 | 头部注释记载补位等于失败即空槽加消费驱动、冷启动恒空。源码 packages/runtime/src/services/session/warmup-pi-slot.ts:5 |
| F13 | dirOnly 规则不标记目录自身（.run 目录自身无 ignored 标记但其内容有），快路径必须保持 | 事实 | 既有测试 dirOnly 套件含 does not match a file named like the dir ；判据源 ruleMatchesPath 的 dirOnly 分支。源码 packages/runtime/test/domains-bundle.test.ts:6598 与 packages/runtime/src/infra/fs/ignore-parser.ts:216 |
| F14 | 快路径语义等价，含历史怪癖（a 括号 b 竖线 c 等 pattern 不自匹配）与反斜杠 pattern 永不命中，覆盖度 76/82 | 事实 | B4 oracle 套件 4 例全过，bench 前置门 6961 路径零分歧。源码 packages/runtime/test/domains-bundle.test.ts:6817 与 probes/perf-ignore-match.mjs |
| F15 | dev spawn 23 扩展等于 22 mandatory 加 1 faux fixture，prod staged 22 bundle | 事实 | mandatory 清单 22 条。源码 packages/shared/src/mandatory-extensions.json ；dev-instance 日志 argv 与 apps/electron/resources/extensions/@zhushanwen 实测 |
| F16 | 冷启动墙钟随负载大幅波动，dev quiet 6.2-6.7s 与 loaded 23.2s，pkg 2.3-6.8s | 事实 | 探针多轮（本日 load 8 至 17 两档各 3 轮）加 JITI_DEBUG 计数运行。探针 probes/perf-pi-coldstart.mjs |
| X1 | 审查 S9 的 walk 0.9s 阻塞首 token 转发主张 | 虚构 | 作废：F6 与 F7 实测证伪，真实负载 40-65ms 等同 warm 地板 47-65ms，仅 12 路并发压测下劣化。该主张降级为机制存在但真实负载不触达，不作为设计依据，依赖它的缓存与时间窗类防阻塞分支全部删除 |

## 二、推断与未核实风险

| # | 推断 | 分类 | 证据 |
|---|---|---|---|
| I1 | prod 真实 app 的会话就绪时长约等于探针的 pi spawn 到 get_state（2.3-6.8s）加 runtime 侧 restore 编排成本 | 推断 | 探针只量 pi 段 probes/perf-pi-coldstart.mjs ，runtime restore 编排段未测 |
| I2 | 渲染侧空会话跳过白名单加载存在竞态，watch sessionId 先于 history 加载落地 | 推断 | 代码阅读 packages/renderer/src/composables/panel/useChatViewDeps.ts:154 即发而 session.history 异步无同步信号，未实测 |
| I3 | 审查引用的原始 20s（restore elapsed 20443ms）含负载与采集放大 | 推断 | 本批探针两档复测 6.2-23.2s（见 F16），原测量条件未复刻 |

### 未核实风险（推断登记的处置）

1. I1：对比表 prod 行标注 pi 段实测加编排段未测；结论以模块数结构性差距为据（F8 得 1769 对 59），不依赖绝对值。若需 prod 整链数字，用打包版 app 加全新数据目录测 session.create 到首 prompt 就绪。
2. I2：仅支撑显式不做的理由链，不影响交付物；重审触发为 sessionStore 暴露同步消息数判据时。
3. I3：对比表所有墙钟数字标注采集时 load，跨批比较只取量级与方向（照批3 口径声明）。

## 三、外部接口核实表

| 接口 | 形态（handler 可得 ctx 与载荷字段） | 依据 | case |
|---|---|---|---|
| WS file.tree | payload 含 sessionId，reply 为 file.tree:result 带 tree 数组（children 两层，ignored 标记） | packages/runtime/src/transport/file-message-handler.ts:58 与 packages/runtime/src/services/file-service.ts:172 | T4 |
| WS file.search 与 file.search.cwd | payload 含 sessionId 与 showIgnored 或 cwd，reply 带 files 与 truncated（全量递归，5000 截断） | packages/runtime/src/transport/file-message-handler.ts:63 与 packages/runtime/src/services/file-service.ts:307 | T1 |
| WS delivery.submit | payload 含 sessionId 与 content 与 clientUuid，受理回执，prompt 实际发出经内核 | packages/runtime/src/services/session/message-dispatcher.ts:154 与 packages/runtime/src/services/session/session-delivery-registry.ts:900 | T1 |
| WS session.subscribe 与广播帧 | 订阅后收 message.message_start 与 message.text_delta 与 message.complete，payload.sessionId 归属 | packages/shared/src/protocol.ts:1856 与 probes/lib/harness.mjs:44 | T1 |
| WS session.create 与 session.list | create payload 含 cwd 与 label 与 presetId 与 projectId 与 clientUuid，list reply 带 groups 数组 | packages/runtime/src/transport/session-message-handler.ts:374 与 probes/lib/harness.mjs | T1,T4 |
| CDP renderer | Runtime.evaluate 取 data-session-id 在场判定，Profiler 采集 | probes/lib/harness.mjs:85 | T1 |
| pi spawn 冷启动探针直 spawn 不经 runtime | pi-darwin-x64 带 mode rpc 与 no-extensions 与 approve 与三个 builtin 扩展加 22 个源或 bundle 扩展，get_state 首响即就绪 | packages/runtime/src/infra/installers/extension-resolver.ts:209 与 probes/perf-pi-coldstart.mjs | T3 |
| jiti 行为属外部 npm 包内部 | fsCache 默认开（env JITI_FS_CACHE 与 JITI_CACHE），缓存键为文件名哈希加选项，JITI_DEBUG=1 输出 cache hit 与 miss 与 store 及 transpile 到 stdout | node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:456 与 node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/jiti-loader-C3NU2SDH.js | T3 |

## 四、主 agent 亲核记录

- 亲核一（文件行号）：connection-manager.ts:225 与 :252 得 fire-and-forget；file-message-handler.ts:58 至 :120 得 file 路由与 reply 契约；extension-resolver.ts:209 得 dev 与 pkg 分流；warmup-pi-slot.ts:5 得消费驱动；useChatViewDeps.ts:154 与 FileView.vue:273 得双编译触发源；file-service.ts:540 得编译 debug 打点。逐条打开核对，与登记形态相符。
- 亲核二（探针复跑）：probes/perf-ignore-match.mjs 得 equivalence OK 与 speedup 2.82；probes/perf-pi-coldstart.mjs 得 dev 与 pkg 对照；JITI_DEBUG 模块计数得 1769 对 59；compileIgnoreRules 计时得 0.178ms。均在本 session 复跑，输出与登记一致。
