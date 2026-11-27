# 设计文档 · 批2「契约层更新跳过 + 强制布局纪律」

> 分支 `feat-cpu-gpu-performance` · 前置 = 批1 已 delivered（HEAD 2f20e85f9，派生归零：rail 冻结 + preview 懒计算 + truncate 码点级 early-exit）。
> 依据 = [docs/perf/adversarial-review-glm.md](../perf/adversarial-review-glm.md) 建议 F2/F4 与 N1/N2 + [perf-measured-report.md](../perf/perf-measured-report.md) §1.2 修订版结论。前后对比口径照 [batch1-comparison.md](../perf/batch1-comparison.md)。

## 背景与目标

批1 消掉了「每 delta O(n²) 字符串派生」。批2 攻 GLM 对抗审查在两个真机火焰图问题上实证的剩余项：

① **组件更新未跳过**：`Turn.vue` 把整个 turn 对象传给 UserBubble（`:turn="turn"`），流式 turn 每 delta 重建（新引用）→ 静态用户气泡每 delta 重渲染。而 `turn.user` 引用在流式期稳定（`message-turns.ts:673/942` = `user: g.user`，D-4 增量缓存按成员引用复用）。传稳定引用 + 标量即可让 `shouldUpdateComponent` 整体跳过更新——比 v-memo 更彻底（连 render 都不跑）且无 deps 簿记（审查 D2/M9 判定 v-memo deps 漏 edit 态/复制反馈/撤回置灰/locale/density 会出陈旧 UI）。

② **强制布局（layout thrash）**：实测 `EdgeFade.sync` 2.5ms/次是 `scroller.scrollTop` 读取引发的强制同步布局（字符串拼接纳秒级，禁优化字符串）；`scrollTo` 2.2s 同族；每运行 164 条 ResizeObserver loop 错误是同一病灶；贴底跟随存在 `pin-bottom-guard gap=29.5px` 不收敛（正确性 bug）。

| 编号 | 目标 | 题面原句（逐字） | 限定词落点 | case/落点 |
|---|---|---|---|---|
| G1 | UserBubble/TurnSummary 流式期跳过重渲染 | 「Turn.vue 把整个 turn 对象传给 UserBubble（:turn="turn"），流式 turn 每 delta 重建 → 静态用户气泡每 delta 重渲染；而 turn.user 引用在流式期是稳定的」 | 机制：Turn→UserBubble 传 `:user="turn.user"` + sessionId/canEdit/isSessionEditable 标量；Turn→TurnSummary 传 lastAssistant.id + isStreaming + 稳定 getter（复制正文点击时按 id 取） | T2,T3 |
| G2 | EdgeFade 消除 scroll 回调强制布局 | 「EdgeFade.sync 2.5ms/次是 scroller.scrollTop 读取引发的强制同步布局（字符串拼接纳秒级，别去优化字符串）」 | 机制：on 改 IntersectionObserver 哨兵，scroll 回调零几何读 | T5 |
| G3 | 贴底跟随收敛（gap 修复） | 「贴底跟随存在 pin-bottom-guard gap=29.5px 不收敛（正确性 bug）」 | 机制：endOffset = tailHeight + headOffset，headOffset = padTop spacer 实测高（补偿未被 virtua container-driver 目标公式计入的流内前置 spacer）——根因见 fact-check A9 | T4 |
| G4 | 削减 RO 循环业务侧几何读 | 「每运行 164 条 ResizeObserver loop 错误是同一病灶」 | 简化实现 + 声明代价：消除 wrap RO 回调内 offsetHeight 兜底读；**virtua 库内部「测量-写 spacer」收敛环为残余，本批不承诺归零**（根因在依赖内部，docs/todo/resize-observer-loop-noise.md 已登记归因） | T4 |
| G5 | N1 mask 串常量提取 | 「N1 mask 串常量提取（等价重构，审查判定收益≈0，仅顺手做勿记为收益）」 | 简化实现 + 声明代价：等价重构，**不记收益**（收益≈0，仅偿 review 建议） | T6 |
| G6 | N2 aiCopyKey 改用 id | 「TurnSummary 的 aiCopyKey = ai-${turn.index} 改用 id（index 不稳）」 | 机制：随 G1 移除 turn prop 而强制改用 lastAssistant.id | T2 |
| G7 | 三包 test+typecheck 全绿 | 「三包 test+typecheck 全绿」 | 不可机验：由 trunk/leaf gate 的 testCommand + typecheckCommand 承载（非真机探针） | 不可机验：gate 承载 |

## 验收是什么

实机验收重点 = **组件 render inclusive 下降 + 强制布局次数下降 + 贴底收敛**，全部走 dev 实例 + faux LLM + CDP 真实采集（禁单测 runner 冒充实机）；外加 rail 视觉零回归对拍。验收判据 = acceptance.md（本任务 = `docs/tp-acceptance-batch2.md`）的实机 case 全绿（T1–T6）。真机阈值类 case 兼顾「上界阈值 + 下界在场有效性」双断言（防「窗内什么都没发生」与「优化生效」同为 0 的假 PASS）。

## 树形拆分

主干 = 真机探针基建 + 无回归 smoke（不改生产行为，既有测试绿）。两枝递进：契约新面（B-props，含 N2 aiCopyKey）→ 高风险 + 等价收尾（B-layout，含 N1 mask 常量）。N1 与 EdgeFade IO 哨兵同文件同批落地、N2 由 B-props 移除 turn prop 强制改用 id，故不单设 B-polish 枝。

主干文件清单（trunk 期允许改动）：
- scripts/perf-probes/
- .tree-plant.json

| 枝名 | 目标 | 依赖 | 风险级 | 文件 | case |
|---|---|---|---|---|---|
| B-props | G1 稳定引用 props + G6 aiCopyKey 用 id | trunk | 中 | packages/ui/src/features/chat/Turn.vue, packages/ui/src/features/chat/UserBubble.vue, packages/ui/src/features/chat/TurnSummary.vue, packages/ui/src/features/chat/__tests__/ | T2,T3 |
| B-layout | G2 EdgeFade IO 哨兵 + G3 gap 修复 + G4 RO 循环削减 + G5 mask 常量（N1） | trunk | 高 | packages/renderer/src/components/ui/edge-fade/EdgeFade.vue, packages/renderer/src/composables/panel/useMessageStreamFollowTriggers.ts, packages/renderer/src/components/panel/MessageStream.vue, packages/renderer/src/composables/panel/message-stream-layout.ts, packages/renderer/src/composables/panel/__tests__/, packages/renderer/src/__tests__/, scripts/perf-probes/lib/harness.mjs, scripts/perf-probes/edge-fade-mask.mjs | T4,T5,T6 |

> 范围注记：B-layout 验收 case T4/T6 依赖两个验收探针基建（trunk gate 仅跑 T1、未覆盖这些路径），随 B-layout 一并补齐：① `scripts/perf-probes/lib/harness.mjs` 的 `waitForSessionComplete` 漏 `session.subscribe`（未订阅则收不到 message.complete 广播 → T4/T6 超时 exit 3）；② `scripts/perf-probes/edge-fade-mask.mjs`（T6）原断言「贴顶 mask 空」在跟底会话不可达（follow 拉回底部、哨兵恒滚离视口），简化为验「滚离顶 → active 常量」（贴顶 mask 空态由单测 edge-fade-sentinel 覆盖）。二者列入 B-layout 改动范围。

## 方案要点（每枝）

**B-props（稳定引用 props）**：
- `UserBubble` props 由 `turn: MessageTurn` 改为 `user: Message`（Turn 只在 `v-else-if="turn.user"` 时渲染，user 恒非空）+ `sessionId`/`canEdit`/`isSessionEditable` 三标量不变。`userCopyKey`/`revokeTargetId`/`isEditingThisUser`/`edit-state-change` 的 turnKey 全部改读 `user.id`（`turnStableId(turn)` 有 user 时恒 = user.id）。流式期 `turn.user` 引用稳定 → props 全稳定 → `shouldUpdateComponent` 跳过。
- `TurnSummary` props 由 `turn`+`lastAssistant` 改为 `lastAssistantId: string|null` + `isStreaming` + `sessionId` + `resolveLastAssistant: () => Message|null`（Turn setup 期一次创建的稳定闭包）。`speakStateOf(lastAssistantId)`；`onSpeak/onForkAsk/onHandoffAsk` 与 `copy` 在点击时经 `resolveLastAssistant()` 取 Message。`aiCopyKey = ai-${lastAssistantId}`（G6）。流式期 lastAssistant.id / isStreaming 稳定 → 跳过更新。

**B-layout（强制布局纪律）**：
- EdgeFade：`on` 由 scroll 回调读 `scroller.scrollTop` 改为 IntersectionObserver 哨兵。渲染 fragment = 绝对定位哨兵（`top-0 h-1`，无流内占位，root=scroller）+ 原 sticky 渐焦带。`on = 哨兵不可见 ∧ ¬reducedTransparency`；**删除 scroll 监听**，mask 串按 `on` 翻转时套常量（G5 预留）。
- gap 修复：virtua container-driver `$scroll` 目标公式（`node_modules/virtua/lib/core/index.js:630`）= `offset + startSpacerSize + itemOffset(last) + itemSize(last) − viewportSize`，只建模 contentWrapEl 及以下，**不含 contentWrapEl 之前的 padTop spacer（30px）**；`viewportSize = contentRect.height`（:599）= 原生 clientHeight（scrollEl 无纵向 padding），`scrollOffset = 原生 scrollTop`。通式 `gap = padTop + ΔH − startMargin + (viewportSize − clientHeight)`，稳态 = `padTop − startMargin` = 30px（无截断条时 startMargin=0；实测 29.5 = 亚像素取整）。修法 = `endOffset = tailHeight + headOffset`，headOffset = padTop spacer 实测高（onMounted 一次读取缓存，非每 delta）。**只改滚动落点目标、浏览器对 scrollTop 的 clamp 使过补自收敛到 gap=0，零视觉回归**（不动 item 定位 / load-more 条预留 / 顶部留白）。这与 P-timing 双 rAF / D7 收敛抑制窗 / INVAR-M4-2′ guard 正交（不改触发时序与判据）。
  - **备选已评估驳回**：`startMargin = STREAM_TOP_SPACER_HEIGHT(30)` 常量（审查建议方向）语义更贴近 virtua API，但 item CSS 定位是否含 startMargin 在 0.54.2 实装上无法静态定论（ListItem.tsx item-top=itemOffset vs 现状首消息=spacer30+startMargin44 自相矛盾），两种模型下都有顶部留白翻倍 / load-more 条（尤其错误行 +32）重叠回归风险；endOffset 补偿无此风险，故选之。
- RO 循环削减：wrap RO 回调内 `contentWrapEl.value?.offsetHeight ?? 0` 兜底读改为「contentWrapEl 不在 entries 时用上次快照 prevWrapHeight」，消除 RO 回调内同步几何读（feedback 环放大源，注释已归因 2026-11-08）。

**B-polish（N1）**：EdgeFade mask active/inactive 两态串提为模块级常量，`on` 翻转时套用。等价重构。

## 非功能设计

| 项 | 类别 | 不做会怎样 | 预计多久出问题 |
|---|---|---|---|
| 贴底落点正确收敛 | 正确性 | 用户贴底阅读时最新内容恒差 ~30px 被裁在视口外（gap bug），且多出无谓滚动工作 | 已发生（baseline 每运行 gap=29.5px） |
| 单卡渲染项契约稳定 | 业务安全/可靠性 | 稳定引用 props 让静态气泡流式期零重渲染，deps 簿记漏项会出陈旧 UI（编辑态/复制反馈/撤回置灰/locale/density） | 引入 props 改动即触发 |
| EdgeFade 消费范围门禁 | 架构约束 | `.githooks/check_edge_fade_scope.mjs` 强制 EdgeFade 仅对话流同族可用；哨兵化不得绕过 | 哨兵 DOM 新增即触发 |

### 显式不做

| 项 | 理由 | 题面提及 | 重审触发 |
|---|---|---|---|
| v-memo deps 簿记 | 审查 D2/M9 判定 deps 不全会出陈旧 UI；稳定引用 props 从结构上消除簿记 | 否（题面选稳定引用） | UserBubble/TurnSummary 出现新的 render 期响应式读取且无法以标量/id 表达时 |
| 高度增量预测 / align:end 快路径 | 审查 CPU-4 判定对症错误（scrollTo 是原生滚动强制布局），会与 virtua 收敛互斗 | 否 | virtua 提供无强制布局的 bottom-sticky API 时 |
| 修改 virtua 上游 | 红线：禁改上游 pi/依赖；gap 修法走 taiji 侧 endOffset 补偿 | 否 | virtua 升级改变 ref-scroller 目标公式（重跑 check-pi-semantics 族）时 |
| EdgeFade blur/mask 视觉降档 | GPU-6/7 数据未采到大 DOM 阶段（A6），批5 干净重测前不动视觉 | 否 | 批5 拿到干净 GPU trace 证明 blur 是 raster 大头时 |
| EdgeFade scrollTop 读优化成字符串常量即止 | 审查 D4：0.86s 是强制布局非字符串；本批用 IO 哨兵根治，N1 常量仅等价顺手 | 是（N1 收益≈0） | 常量化引入视觉差异即回退 |
| 探针脚本类型层（scripts/perf-probes/ .mjs） | 真机采集探针为零依赖 Node .mjs 一次性脚本（沿用批1 口径），不做 tsc 类型层；生产交付面（packages/）全 .ts 由 typecheckCommand 承载 | 否 | 探针引入跨文件复用/复杂逻辑，或被非采集链路依赖时 |
| gap 修法改跟底读写时机（移出双 rAF） | P-timing 双 rAF 是为让 virtua 内部 RO 先更新测量缓存（消除「用旧视口算目标」缝隙），改动会引入竞态 | 否 | virtua 提供同步测量 API 或去掉该缝隙需求时 |
| padTop 硬编码常量 | 优先 RO/offsetTop 实测 headOffset，避免与 CSS 变量漂移；仅在实测路径不可行时回落常量 + dev 断言 | 否 | `--message-stream-pad-top` 值变更且实测路径失效时 |
