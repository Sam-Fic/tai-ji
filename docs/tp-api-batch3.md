# API 文档 · 批3

交付物自身 API（命令 / 工具 / 配置 / 存储 / 挂点）。本批无面向 agent 的工具面、无用户配置面、无持久化存储面——相应小节保留标题并注明不适用理由。

## 命令

验收/复算命令（真实宿主探针，零依赖 Node .mjs，T2 例外经仓库既有 tsx 运行）：

| 命令 | 用途 | 关键输出 |
|---|---|---|
| `node scripts/perf-probes/perf-shiki-worker.mjs --data-dir <dir> --sid <sid> --threshold-s 0.3 [--save <profile>]` | T1：流式全程 CDP profile → fence 闭合窗口 shiki 族 self-time 阈值断言 + 在场有效性（高亮确实发生 + worker 成本日志） | `RESULT shiki-family-self-time=<s> threshold=<s> PASS\|FAIL`；`worker-init-ms=` / `worker-job-ms=` 行 |
| `node_modules/.bin/tsx scripts/perf-probes/shiki-html-diff.mjs --data-dir <dir> --sid <sid>` | T2：完成消息 DOM 代码块 HTML vs 同源配置主线程算法重算，归一化对拍 | `RESULT shiki-html-identical:true\|false` |
| `node scripts/perf-probes/shiki-fallback-probe.mjs --data-dir <dir> --sid <sid>` | T3：CDP 拦 worker 脚本 → 断言回退同步高亮保留 + 降级出声 | `RESULT fallback-highlight-preserved:true highlighted:true fallback-logged:true` |
| `node scripts/perf-probes/streaming-placeholder.mjs --data-dir <dir> --sid <sid>` | T4：流式中途占位在场（无 shiki 产物）→ complete 后占位消失 + 高亮在场 | `RESULT streaming-placeholder:true final-highlighted:true placeholder-gone:true` |
| `env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/perf-probes/csp-worker-probe.cjs` | T5：真实 Electron 二进制，运行时读取 packages/renderer/index.html 的 CSP 串，验证 file://（打包态）与 http（dev 态）同源 module worker | `FILE_MODULE_WORKER=OK` / `HTTP_MODULE_WORKER=OK` |

复算命令（前后对比表数字，任意 cwd 仓库根）：

```bash
# after 侧 shiki 族 self-time（流式全程，T1 保存的 profile）
node scripts/perf-probes/shiki-family.mjs .run/b3-after-renderer.cpuprofile <relFromS> <relToS>
# before 侧同口径（基线只读）
node scripts/perf-probes/shiki-family.mjs ~/.taiji/ext-sessions/01a2077f-d676-7095-b142-db7b972391f7/artifacts/profiling-data/run-notrace-renderer.cpuprofile 10 73
```

## 工具

不适用：本批不注册/修改任何 agent 可见工具（无 registerTool 面世变更）。

## 配置

不适用：worker 化无用户可配置项（无开关、无阈值、无文件）。语言覆盖范围 SSOT 仍是 `packages/ui/src/features/chat/markdown.ts` 导出的 `SHIKI_LANGS`（迁至 shiki-highlight-core.ts 后导出路径不变语义不变）；降级行为无配置（失败即回退，恒出声）。

## 存储

不适用：无持久化。worker 无常驻磁盘状态；高亮产物只进内存段缓存（既有 D-5 增量前缀缓存，`IncrementalMarkdownCache.prefixSegments`）与 DOM。session jsonl / ext-sessions 树零新增域。

## 挂点

| 挂点 | 形态 | 消费方 |
|---|---|---|
| `renderMarkdown(content, env?, group?)` | 新增**可选**第三参 `group`（取消组令牌，opaque object）；不传 = 每次调用独立组（无外部取消）。返回 Promise 语义不变 | 壳侧 `renderMarkdownSegments` 桥接（useChatViewDeps.ts）不传；增量轴传 cache |
| `renderMarkdownSegments(content, env?, group?)` | 同上，可选第三参透传 | markdown-incremental.ts 内部四处调用点传 cache（`renderIncremental` 的 `c`） |
| `shiki-highlight-core.ts` 导出 | `SHIKI_LANGS` / `SHIKI_DARK` / `SHIKI_LIGHT` / `toTaijiFlatCodeTheme` / `createShikiHighlighter()` / `highlightWithHighlighter(hl, code, lang)` / `TAIJI_FLAT_CODE_TOKEN_COLORS`——worker 与主线程单源 | markdown.ts（getHighlighter/highlightShikiSync 改为转调）、shiki-highlight-worker.ts、既有 `highlightCode` 导出（drawer CodeBlock/DiffView） |
| `shiki-highlight-client.ts` 导出 | `resolveFenceHighlights(jobs, group?): Promise<HighlightResolution[]>`——入参 `jobs: ReadonlyArray<{code,lang}>`（id 由客户端内部分配），返回按入参顺序对齐的结果数组：HTML 串 = worker 产物；`null` = worker 不可用/该 job 失败（调用方主线程同步回退）；`HIGHLIGHT_CANCELLED` 哨兵 = 消费方已卸载（放弃，不烧主线程）。另导出 `cancelShikiHighlightGroup(group)`（卸载路径：结算取消哨兵 + 通知 worker 丢弃未开始的）与 `cancelAllShikiHighlights()`（页面隐藏路径：结算 null → 在途渲染同步回退）。内部状态 idle→ready/degraded（不导出）；degraded 触发面 = typeof Worker 缺席 / new Worker 抛错 / error·messageerror 事件 / 单 job jobError（仅该 job） | markdown.ts（预解析）、markdown-incremental.ts（透传 cache 作组令牌）、useMarkdownStreaming.ts（卸载取消）、页面 visibility 监听（客户端自注册） |
| worker 消息协议 | 主→worker：`{type:'jobs',jobs:[{id,code,lang}]}`、`{type:'cancel',ids:number[]}`；worker→主：`{type:'result',id,html}`、`{type:'jobError',id,message}`、`{type:'log',level,msg}` | 客户端内部协议（不进持久化、不进壳契约） |
| env 内部键（Symbol） | 高亮缓存挂 renderEnv（管线内部自产自销，同信任槽形态）——不进 `MarkdownEnv` 公开类型、不参与增量轴 env 签名（isCacheStable 只比 filePaths/localFiles/resourceBaseDir） | markdown.ts fence 规则读 |
| CSP 挂点 | `packages/renderer/index.html` 与 `packages/mobile-renderer/index.html` 的 meta CSP 增加 `worker-src 'self'` | 双壳 worker 脚本加载 |
