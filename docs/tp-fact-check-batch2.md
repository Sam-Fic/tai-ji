# 事实核查文档 · 批2

分类三值：**事实**（证据 = 文件:行号 或探针/日志输出）· **推断**（合理推导未核实，登记进「未核实风险」）· **虚构**（无依据臆断，标作废并删分支）。

## 论据三分类表

| 编号 | 论据 | 分类 | 证据 | 说明 |
|---|---|---|---|---|
| A1 | turn.user 引用流式期稳定（delta 路径增量重建复用同一 Message 对象） | 事实 | packages/core/src/domain/chat/message-turns.ts:673,942（均 `user: g.user`）；签名未变时整 turn 复用（:667-669） | 条件：限于流式 delta 路径；store 存在整表克隆路径（store.ts:791-797），彼时 user 引用变→UserBubble 重渲（正确行为，非每 delta，不影响本批优化目标） |
| A2 | turnStableId(turn) 有 user 时恒 = user.id | 事实 | packages/core/src/domain/chat/message-turns.ts:145（`turn.user?.id ?? …`） | UserBubble 的 edit-state turnKey 可改读 user.id |
| A3 | UserBubble 只读 turn.user（content/id/timestamp）+ turn.index（userCopyKey 兜底）+ turnStableId(turn) | 事实 | packages/core/src/domain/chat/message-turns.ts:673 (turn.user 来源)；UserBubble.vue 模板+script 全文核对（读点 :26/:63/:64/:146/:169/:362 index 兜底/:394/:405 turnStableId） | 无其他 turn 字段读取（否定性 grep 零命中） |
| A4 | TurnSummary 读 turn.isStreaming（speakDisabled）+ turn.index（aiCopyKey）+ lastAssistant（content/id）+ deps | 事实 | packages/ui/src/features/chat/chat-view-deps.ts:97 (speakStateOf 收 id)；TurnSummary.vue 全文核对（:129 isStreaming、:151 index、lastAssistant 7 处、deps 5 处） | speakStateOf 收 id，onSpeak/onForkAsk/onHandoffAsk 收 Message（经 getter 取得，签名不变） |
| A5 | UserBubble / TurnSummary 唯一生产消费方 = Turn.vue；`<Turn>` 由 ChatView.vue + MessageStream.vue 消费但其 turn prop 接口不变 | 事实 | packages/ui/src/features/chat/__tests__/Turn.test.ts (mount Turn 消费点)；全仓 grep `:turn=`/`:last-assistant=`/`<UserBubble`/`<TurnSummary` 生产渲染落 Turn.vue:50-52/113/223-226 + ChatView.vue:22 + MessageStream.vue:122（drawer/subagent/btw/workflow 四宿主均经 MessageStream 单点） | 改动 blast radius ⊆ Turn.vue + 两个子组件；全仓无 `:user` prop（无命名碰撞） |
| A6 | chat-view-deps 签名：speakStateOf(messageId)，onSpeak/onForkAsk/onHandoffAsk(sessionId, Message) | 事实 | packages/ui/src/features/chat/chat-view-deps.ts:97,114,116,122 | getter 方案不收紧这些签名（TurnSummary 点击时经 getter 取 Message 传入） |
| A7 | EdgeFade.sync 在 scroll 事件回调读 scroller.scrollTop，成本为强制同步布局 | 事实 | docs/perf/perf-measured-report.md M4/C5 记录 sync 成本为 scrollTop 强制布局；EdgeFade.vue sync 于 scroll 回调读 scrollTop（行 47，maskImage 读为 CSSOM 不触发 reflow） | 字符串拼接是纳秒级，禁优化字符串 |
| A8 | EdgeFade 唯一消费方 = MessageStream 的 `<EdgeFade/>`，是 scrollEl 第一个子元素 | 事实 | packages/renderer/src/components/ui/edge-fade/index.ts (桶出口)；MessageStream.vue:47 `<EdgeFade />` 于 scrollEl 内首行；.githooks/check_edge_fade_scope.mjs 机器确认唯一性 | scrollEl class message-stream relative → position:relative（绝对哨兵包含块） |
| A9 | gap 根因 = padTop(30px) 流内 spacer 未被 virtua container-driver 目标公式计入；通式 gap = padTop + ΔH − startMargin + (viewportSize − clientHeight)，稳态 = 30 − startMargin | 事实 | node_modules/virtua/lib/core/index.js:630（target 公式）、:599（viewportSize=contentRect.height=clientHeight）；style.css:178（padTop=30px）；baseline 日志 gap=29.5px；git 考古 = commit 4eb083942（2026-10-11 padding-top→in-flow spacer 引入） | 排除项（h-8/ActivityStrip/tailHeight 滞后/28px padding/viewportSize≠clientHeight）逐条有反证；三条流行注释（「前置兄弟高度自然计入」「getItemOffset 已含 startMargin」「viewportSize 差 28px」）经 virtua 源码核对为虚构 |
| A10 | IntersectionObserver 在本仓有使用先例 | 事实 | packages/ui/src/features/chat/__tests__/media-suite.test.ts:27 (IO stubGlobal mock 先例)；HtmlPreviewInline.vue:471 生产用法（threshold 0.1 + typeof 降级） | 哨兵实现可参照；happy-dom IO 为 no-op stub 需 stubGlobal 驱动 |
| A11 | RO 循环根因在 virtua 库内部「测量→同步推 stateVersion→重渲染→写 spacer→再 observation」反馈环（virtua issue #470 自认）；业务侧回调零强制布局读已做尽 | 事实 | packages/renderer/src/composables/panel/useMessageStreamFollowTriggers.ts:213 (唯一残留 offsetHeight 兜底，实际不可达)；docs/todo/resize-observer-loop-noise.md 2026-11-08 归因登记 | 本批不承诺 RO loop 归零；仅清理论残留 + 登记残余 |
| A12 | gap=29.5px 在非流式稳定态持续（非流式竞态） | 事实 | packages/renderer/src/composables/panel/usePinBottomGuard.ts (gap 警告发射点 measureGap/report)；baseline renderer-console-2026-11-23.log 多行 `非流式态持续 gap…gap=29.5px` | 系统性记账误差特征，与 A9 一致 |

## 外部接口核实表

| 接口 | 形态 | 依据 | case |
|---|---|---|---|
| IntersectionObserver | `new IntersectionObserver(cb,{root:scroller})`，哨兵可见性经 `entry.isIntersecting` 判；布局后投递零强制 | packages/ui/src/features/chat/__tests__/media-suite.test.ts:27 (IO mock 先例)；HtmlPreviewInline.vue:471 生产用法 | T6 |
| virtua `VirtualizerHandle.scrollToIndex` | `(index,{align:'end',offset,smooth})`，offset=endOffset；目标 = offset+startSpacer+itemOffset+itemSize−viewportSize | node_modules/virtua/lib/core/index.js:630 | T4,T5 |
| virtua viewportSize | = scrollRef(contentRect).height，经 ResizeObserver 更新 | node_modules/virtua/lib/core/index.js:599 | T4 |
| CDP Profiler | `Profiler.enable/start/stop` → profile（无 tracing） | probes/perf-derivatives.mjs | T1,T2,T5 |
| runtime WS `delivery.submit` | `{sessionId,content,clientUuid}` 起流式 | probes/perf-derivatives.mjs | T1,T2,T4,T5,T6 |
| chat-view-deps speakStateOf/onSpeak/onForkAsk/onHandoffAsk | 签名（id / sessionId+Message） | packages/ui/src/features/chat/chat-view-deps.ts:97,114,116,122 | T2 |
| turn.user 稳定引用 / turnStableId | 流式期 user 引用稳定；turnStableId=user.id | packages/core/src/domain/chat/message-turns.ts:673,942,145 | T2,T3 |

## 未核实风险

- A9-fix：`endOffset = tailHeight + headOffset`（headOffset=padTop spacer 实测高）使 gap→0 的效果待 T4 真机闭环确认——触发条件：T4 `gap_warnings` 未归零则修法方向需修正（备选 startMargin=STREAM_TOP_SPACER_HEIGHT，但有 load-more 条/顶部留白回归风险，见 design）。代数推导 + virtua 源码 + git 考古已支撑高置信，缺一次真机闭环。
- A11-ro：wrap RO 兜底读消除后 RO loop 告警预计不变（virtua 内部环为主体，业务侧射程内已做尽）——登记为残余风险，不承诺归零；真机 T4 报数仅证「不恶化」。
