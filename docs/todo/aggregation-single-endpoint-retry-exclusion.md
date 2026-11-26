# 单端点路由在自动重试时被排除为空导致路由失败（待裁决）

状态：未修复，待裁决——属设计语义取舍（route-matrix 总则 5 与矩阵「移除后为空 → 路由失败」是显式裁决），改行为前需先定新语义；发现于 2026-11-23 压缩故障排查同会话（非压缩原因，独立缺陷）。

## 现状

pi 发 `reason: "retry"` 请求时携带 `request.failed`（上一失败请求的物理模型），provider-aggregation 把它作为重试排除输入（`extensions/universal/provider-aggregation/src/index.ts` 的 `retryExclude`，`evaluateRoute` 内 `collectMemberBlockReasons` 记 `retry-excluded`）。

单端点路由下这个排除必然把唯一候选判掉：`outcome === "no-candidate"` → `buildNoCandidateError` 的 `retryOnly` 分支 → 抛

```
模型路由 "<id>"（<name>）：上一端点失败且无其他可用端点。请检查其余端点的条件配置，或在模型选择器更换模型。
```

后果：pi 的瞬态错误自动重试（AS13 分类为可重试的网络/5xx 类）不会变成「重发一次」，而是被替换成一条路由配置错误——用户侧读到的是一次硬失败，且文案指向「检查条件配置」，与实际原因（上一请求瞬态失败）无关。

会话 `01a2077f-d676-7095-b142-db7b972391f7` 里该形态出现 3 次（09:07 / 10:12 / 11:54，模型 `aggregation/step-5-preview`，单端点路由 → `stepfun-step-plan/step-5-preview`），当时与压缩失败混在一起难以区分（两件事同会话，原因不同：压缩是调用通道选错，这些是路由排除语义）。

## 候选方向（需裁决，勿直接改）

1. **排除后为空 → 退回刚失败的端点**（`retryOnly` 时不抛错，回落到 `request.failed` 的物理模型重发一次）。代价：与 D6「上一失败端点本次排除」的字面语义相反，且要明确「退回」的次数边界（依赖 pi 自身的重试上限，本仓不引入计数）。
2. **只在多端点路由内排除**（单端点路由不参与排除，等价于①的单端点特化）。语义差异：多端点仍按矩阵求值，单端点视为「无替代可选」。
3. **保持现状，只改文案**（`retryOnly` 分支的错误改为「上一端点请求失败，本路由无其他可用端点，请手动重试或在模型选择器更换模型」）。不改行为，只消除误导性指引。

倾向：①或②（瞬态错误应当重发而非转硬失败）。

pi 侧约束已核（1.0.0 实装）：

- `reason: "retry"` 只在自动重试的 prepareRequest 上出现——`dist/core/agent-session.js:454` `reason: failed ? "retry" : userTurn ? "user" : "continuation"`，`failed` 来自 `this._failedResponse`（:424-425 读取后即清空）。
- 重试上限由 pi settings 的 `retry.maxRetries` 决定（`dist/core/settings-manager.js:662` 缺省 3，`_retryAttempt >= maxRetries` 时不再重试，:787）。
- `request.failed` = 上一条 assistant 消息（:1393 / :2373 赋值），其 `model` 是当次实际发出的物理端点——故①「退回刚失败端点」可直接取 `request.failed.model`，无需另建状态。
- 因此①不会放大重试次数：本仓只是让「本轮重试」能真正重发，次数边界仍归 pi 的 maxRetries。改语义前需同批复核 `route-matrix.test.ts` 的 retry 用例与设计文档总则 5。

## 判定方式

```bash
# 会话内该形态的直接证据（与压缩失败区分：压缩是 No API provider registered）
grep -o '上一端点失败且无其他可用端点' <sessionfile>.jsonl | wc -l
```

命中即本次登记形态；同时看 `providers.json` 的 `routes` 段该路由 `members` 长度是否为 1（单端点 = 必然命中）。

## 关联

- 设计依据（现行语义）：`docs/design/provider-aggregation-route-matrix.md` 总则 5 + 矩阵「retry 且上一失败端点 ∈ 可选集」行。
- 测试锚：`extensions/universal/provider-aggregation/src/__tests__/route-matrix.test.ts`「retry 排除后为空 → no-candidate」（改语义时须同批改该用例）。
- 同会话另一独立缺陷（已修）：`docs/TROUBLESHOOTING.md` 第 46 条 + 约束 C-pi-19（扩展侧 LLM 调用通道）。
