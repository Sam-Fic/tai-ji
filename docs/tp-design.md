# 设计文档（四件事，一件不多）

## 背景与目标

批1 源自 GLM 对抗审查（adversarial-review-glm.md 建议 F1）：实测发现 renderer 流式窗约 4.5s（7.2%）主线程成本是 **O(n²) 字符串派生**——`railMemoFor` 对流式 turn 每 delta miss 后全文跑 19 条 regex，`turnPreview` 对 45K assistant 全文压平空白却只喂一个从不显示的占位行。本批把这两个派生清零并消除 `truncate` 的全量码点化，dev/prod 同收益、零视觉变化。给对话流渲染链路的所有后续批次打底。

| 编号 | 目标 | 题面原句（逐字） | 限定词落点 | case/落点 |
|---|---|---|---|-------|
| G1 | rail 摘要流式期零重算 | 审查 F1：「rail 摘要对流式 turn 按 message id 记忆、`content.length ≥ K` 后冻结，fence 行无条件剥离」 | 机制：WeakMap 冻结 + streaming 态门 + 未闭合 fence 不冻结 | T1,B1 |
| G2 | preview 零成本 | 审查 F1：「`StreamViewItem.preview` 懒计算（只在 StreamItemBoundary 失败路径求值）」 | 机制：惰性求值 + canReuseView 移除 preview 比对 | T1,B2 |
| G3 | truncate 无全量分配 | 审查 D1：「真正有效的是『只迭代到 maxChars 个码点』……替代 `Array.from(text)` 的全量分配」 | 机制：码点迭代 early-exit，输出逐字等价 | T1,B3 |
| G4 | 收益可证 | 审查 F1：「流式窗 **≈ −7%** 主线程」 | 机制：真机 profile 复测，派生族 self-time 阈值断言 | T1 |
| G5 | 零视觉变化 | 审查 F1：「零视觉变化（rail 只修掉瞬时泄漏）」 | 简化实现+代价：行首 fence 形态下 rail 终态逐字一致（非行首 fence / 纯 ``` 行的差异见 api.md stripMarkdown 节）；流式期 fence 标记泄漏为有意修复；跨 K 未闭合链接/强调的残余标记接受为已知代价（fact-check R1，含触发条件与生产可达性） | T2,B1 |

## 验收是什么

本次验收重点 = 真机流式窗的派生族成本归零（阈值断言）+ rail 终态视觉逐字不变。验收判据 = acceptance.md 的实机 case 全绿。

## 树形拆分

主干文件清单：
- packages/core/src/domain/chat/
- packages/ui/src/features/chat/
- packages/renderer/src/components/panel/message-stream/
- packages/renderer/src/composables/panel/
- scripts/perf-probes/
- .tree-plant.json
- packages/renderer/src/__tests__/wave3/happy-dom-21-composer-landing-skill-reload-stream-view-items.test.ts

| 枝名 | 目标 | 依赖 | 风险级 | 文件 | case |
|---|---|---|---|---|---|
| B1 rail-freeze | rail 流式冻结 + fence 行无条件剥离 | 无（先行：契约新面） | 中 | packages/ui/src/features/chat/rail-turn-memo.ts, packages/core/src/domain/chat/summarize-turn.ts | B1,B3 |
| B2 preview-lazy | turn 项 preview 懒计算 + canReuseView 去 preview 比对 | 无 | 中 | packages/renderer/src/components/panel/message-stream/stream-view-items.ts, packages/renderer/src/components/panel/MessageStream.vue | B2 |
| B3 truncate-exit | truncate 码点级 early-exit | 无 | 低 | packages/core/src/domain/chat/summarize-turn.ts | B3 |
| B-gpu | GPU after-side trace 采集 + 前后对比表 | 主干实现（B1-B3） | 中 | scripts/perf-probes/gpu-trace.mjs, scripts/perf-probes/analyze-gpu-union.mjs, scripts/perf-probes/rail-visual-diff.mjs, docs/perf/batch1-comparison.md | G1 |
| B-harden | 边界加固：anchor 对 whitespace-only assistant 的处理、preview thunk 抛错降级、冻结槽显式 reset 入口（切 session） | 主干实现（B1-B3） | 中 | packages/core/src/domain/chat/summarize-turn.ts, packages/ui/src/features/chat/rail-turn-memo.ts, packages/renderer/src/components/panel/message-stream/stream-view-items.ts, packages/renderer/src/components/panel/message-stream/StreamItemBoundary.vue, packages/renderer/src/composables/panel/useMessageStreamRail.ts, packages/core/src/domain/chat/__tests__/summarize-rail.test.ts, scripts/perf-probes/deriv-family.mjs, scripts/perf-probes/gpu-compare.mjs, packages/ui/src/features/chat/__tests__/rail-freeze.test.ts, packages/renderer/src/components/panel/message-stream/__tests__/preview-lazy.test.ts | B1,B2,B3 |

## 非功能设计

| 项 | 类别 | 不做会怎样 | 预计多久出问题 |
|---|---|---|---|
| 冻结缓存无泄漏（沿用 WeakMap，不新增 Map 槽） | 容量 | 流式会话累积残留条目，长会话内存单调涨 | 一次长会话即可暴露 |
| 语义边界单测（truncate 边界/fence 对拍/冻结状态机） | 可靠性 | 后续改 stripMarkdown 规则时静默改变 rail 标签 | 下次改动即暴露 |
| 真机探针入库（scripts/perf-probes/，阈值断言） | 性能 | 收益无机器证伪手段，回归无门禁 | 下次改动即暴露 |

### 显式不做

| 项 | 理由 | 题面提及 | 重审触发 |
|---|---|---|---|
| store 层 delta 合帧 | 审查 D3：已删 delta-coalescer 复活，同宏任务批大小恒 1 | 否 | 若未来 WS 投递模型改为同帧多 delta 打包 |
| 先截后剥（truncate 前置） | 审查 D1 四类反例（fence 开头永久泄漏/长链接/跨切点强调/代理对） | 否 | 若 rail 摘要改为码点级前缀剥离且反例被单测全覆盖 |
| v-memo / 组件 props 改造 | 属批2 范围 | 否 | 批2 启动时 |
| DOMPurify 快速通道 | 审查 D5：判据不可满足 + <1% 收益 + 契约冲突 | 否 | 若 DOMPurify 占比复测 >5% |
| .gitignore mtime 缓存 | 推翻在册裁决（缓存治理 U1 1-2）；属批4 TTFT 议题 | 否 | 批4 |
| 性能回归 CI 门禁 | 真机 profiling 成本高（需起 dev 实例 + 65s 流式） | 否 | 若 probes 运行时降到 <30s 且稳定 |
