# 交付物 API · 批4「TTFT（首 token 延迟）」

## 探针（命令面）

| 命令 | 用途 | 关键参数 | 输出契约 |
|---|---|---|---|
| `node probes/perf-ttft.mjs --data-dir <dir> [--cdp-port 9478] [--mode warm\|walk\|fresh] [--runs N] [--walk-lead-ms N] [--walk-stress N] [--cwd <path>] [--text <prompt>]` | TTFT（delivery.submit → 首个 message_start / text_delta 帧）三模式测量 + 窗口内 .gitignore 编译次数对账 | `--mode walk` 复刻 GUI 挂载时的 file.tree+file.search 并发；`--walk-stress N` 机制压测（N 个并发全树 walk）；`--cwd` 会话 cwd（缺省仓库根，对齐实测场景） | 末行 `RESULT mode=<m> ttft-ms=<n> first-delta-ms=<n> gitignore-compiles=<n>`；测量无效（超时/无首帧）exit 3 |
| `node probes/perf-ignore-match.mjs [--repo <repo>] [--limit N] [--rounds N]` | matchPath CPU 成本对比（改造前 regex 逐前缀 vs 现行段级快路径），仓库真实 .gitignore × 真实路径语料；前置正确性门（两算法不等即弃测 exit 3） | `--limit` 截断语料；`--rounds` 轮数取中位数 | 末行 `RESULT old-ms=<n> new-ms=<n> speedup=<n>x calls=<n> per-call-old-us=<n> per-call-new-us=<n>` |
| `node probes/perf-pi-coldstart.mjs [--repo <repo>] [--runs N]` | pi 冷启动对照：直接 spawn pi 二进制（不经 Electron/runtime），dev 源码扩展集 vs packaged bundle 扩展集，量 spawn → get_state 首响墙钟 + 进程累计 CPU | `--runs` 各集合轮数（中位数） | 末行 `RESULT dev-cold-ms=<n> dev-cpu-s=<n> pkg-cold-ms=<n> pkg-cpu-s=<n> ratio-cold=<n>` |
| `node probes/tree-flags-probe.mjs --data-dir <dir>` | 真机文件树 ignored 标记对账（快路径宿主侧确认）+ file.tree 的编译行数 | 复用/自建 cwd=仓库根的 session | 末行 `RESULT tree-flags-ok=<bool> mismatches=<n> compile-lines=<n>`；有 mismatches exit 1 |

公共 harness：`probes/lib/harness.mjs`（connectRuntime / connectRendererCdp / ensureGuiOnSession / sleep，批1-批3 既有，本批零改动）。

## 库 API（`packages/runtime/src/infra/fs/ignore-parser.ts`）

```ts
/** [B4] 段级快路径判据；null = 走 regex 逐前缀路径 */
export interface IgnoreFastPath {
  readonly prefix: string   // 星号左侧字面（star=false 时 = 完整字面量）
  readonly suffix: string   // 星号右侧字面（star=false 时 = 完整字面量）
  readonly star: boolean    // 是否单星号形态（false = 整段相等）
  readonly anchored: boolean // 有效锚定：true = 仅首段可命中；false = 任意段
}

export interface IgnoreRule {
  readonly pattern: string
  readonly negated: boolean
  readonly dirOnly: boolean
  readonly anchored: boolean
  readonly regex: RegExp
  readonly fast: IgnoreFastPath | null  // [B4] 新增
}

export function compileIgnoreRules(content: string): IgnoreMatcher
export function matchPath(matcher: IgnoreMatcher, path: string): boolean
```

- **新增字段 `IgnoreRule.fast`**（必填，编译期由 `computeFastPath` 填充）：三形态可快路径化——字面量（无 `*`/`?`）、单星号（恰一个 `*`、两侧不含 `/` 与 `?`）、前置双星加斜杠的字面量（`**/L` ≡ 非锚定字面量）。其余形态恒 null。
- **`matchPath` 行为契约不变**：签名、语义（last-match-wins、coverage、normalizePath）逐字节保持；快路径与 regex 路径对同一 (rule, path) 结果等价（oracle 测试锁定）。`fast` 为非公开消费字段（file-service 只读 `rules` 拼接合并，literal/fast 随规则迁移）。
- **构造面**：`IgnoreRule` 新增必填字段，唯一构造点是 `compileRule`（ignore-parser 内）；`IgnoreMatcher` 形状不变，file-service 的 `{ rules: [...] }` 合并/EMPTY_MATCHER 构造不受影响（复用已编译规则）。

## 存储 / 挂点

不适用：本批无新增存储、无新增挂点、无协议变更（WS 协议、文件树 reply 契约零改动）。

## 日志

既有 `[file-service] .gitignore 读取/编译: <path>`（debug 级）继续作为编译次数的验证通道（探针 T4/T1 消费）；本批不新增日志行。
