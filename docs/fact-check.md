# 事实核查文档

分类三值：**事实**（已核实，证据=文件:行号 或探针输出文件）、**推断**（合理推导未核实）、**虚构**（无依据臆断——须标「作废」并删除依赖它的方案分支）。
纪律：最终设计只准建立在事实上；推断须升级为事实或进「未核实风险」；虚构作废。

## 论据三分类表

| 编号 | 论据 | 分类 | 证据 | 说明 |
|---|---|---|---|---|
| A1 | railMemoFor 按 turn 引用 WeakMap 缓存；流式 turn 每 delta 新引用 ⇒ 每 delta miss 重算 summarize | 事实 | packages/ui/src/features/chat/rail-turn-memo.ts:38 packages/ui/src/features/chat/rail-turn-memo.ts:51 | 主 agent 亲核 |
| A2 | summarizeAssistantForRail 对流式 turn 取首个非空 assistant 全文跑 stripMarkdown（19 条全文正则） | 事实 | packages/core/src/domain/chat/summarize-turn.ts:60 packages/core/src/domain/chat/summarize-turn.ts:27 | 亲核 |
| A3 | truncate 先 Array.from(text) 全量码点化才判长 | 事实 | packages/core/src/domain/chat/summarize-turn.ts:51-56 | 亲核 |
| A4 | turnPreview 先试 user?.content；live 态 user content 是 Segment[] 时 previewText 返回空串从而回落 assistant 全文 | 事实 | packages/renderer/src/components/panel/message-stream/stream-view-items.ts:41 | 亲核 |
| A5 | turn 项 preview 唯一消费点是 broken/failed 占位行（MessageStream.vue:121 v-else 降级位）；skillNotice preview 是小文本另一消费点 | 事实 | packages/renderer/src/components/panel/MessageStream.vue:121 packages/renderer/src/components/panel/MessageStream.vue:167 | 亲核 |
| A6 | 流式期 content append-only（前 K 字符一旦形成不再变） | 事实 | packages/runtime/src/infra/pi/event-adapter.ts:144 | 亲核 |
| A7 | 实测该族在流式窗 ≈4.5s/7.2% | 事实 | docs/perf/adversarial-review-glm.md 复算命令对 run-notrace-renderer.cpuprofile 流式窗聚合 | T1 探针复现 |
| A8 | turn.user 引用流式期稳定（D-4 成员引用复用） | 事实 | packages/core/src/domain/chat/message-turns.ts:673 packages/core/src/domain/chat/message-turns.ts:942 | 批2 依赖，本批不直接用 |
| A9 | canReuseView 的 turn 分派当前比对 preview 值 ⇒ 懒计算后须移除 | 推断 | packages/renderer/src/components/panel/message-stream/stream-view-items.ts:145 结构推导 | 登记 R2；实现时读 turn 分派确认 |
| A10 | streaming 态信号可取（turn 字段或调用方传参） | 推断 | packages/renderer/src/components/panel/MessageStream.vue 含 hasStreamingTurn 判定 | 登记 R3；实现时定 |
| A11 | rail 摘要 = 前 20 码点，长消息流式 1-2s 后不再变化 | 推断 | MAX_CHARS=20 + append-only 推导 | 登记 R1；极短消息由 length≥K 天然豁免 |

## 外部接口核实表

| 接口 | 形态 | 依据 | case |
|---|---|---|---|
| railMemoFor(turn) | 返回 RailTurnMemo 四字段；冻结逻辑内嵌或包装 | packages/ui/src/features/chat/rail-turn-memo.ts:51 | T1,B1 |
| summarizeTurnForRail/summarizeAssistantForRail | 纯函数 MessageTurn→string(20 码点) | packages/core/src/domain/chat/summarize-turn.ts:19 packages/core/src/domain/chat/summarize-turn.ts:60 | T2,B1,B3 |
| truncate(text,maxChars) | 纯函数；码点截断加省略号 | packages/core/src/domain/chat/summarize-turn.ts:51 | B3 |
| stripMarkdown(text) | 纯函数；fence 行剥离改无条件 | packages/core/src/domain/chat/summarize-turn.ts:27 | B1,B3 |
| previewText/turnPreview | 模块私有；经 StreamViewItem 出图 | packages/renderer/src/components/panel/message-stream/stream-view-items.ts:41 | B2 |
| StreamViewItem turn 项 preview 字段 | string 改惰性求值形态 | packages/renderer/src/components/panel/message-stream/stream-view-items.ts:33 | T1,B2 |
| canReuseView turn 分派 | 复用判定；移除 preview 比对 | packages/renderer/src/components/panel/message-stream/stream-view-items.ts:145 | T1,B2 |
| StreamItemBoundary :preview | broken 占位行消费点 | packages/renderer/src/components/panel/MessageStream.vue:121 | B2 |
| runtime WS 协议（auth+session.create+chat.send） | auth.result → RPC；零依赖 WebSocket；服务端入口 | packages/runtime/src/transport/message-broker.ts scripts/perf-probes/perf-derivatives.mjs | T1 |
| CDP Profiler（renderer target） | json/list 取 webSocketDebuggerUrl 后 Profiler.start/stop | scripts/perf-probes/perf-derivatives.mjs | T1 |

## 未核实风险

- R1（A11，**已按 card-03 P3-3 / card-06 P6-1 实证修正**）：跨 K 未闭合 markdown 构造（`**…**` / `[a](b)` 的闭合符落在前 256 字符之外）会使冻结摘要残留标记，**持续整个流式窗**（不是「一闪而过」）——旧实现每 delta 重算、闭合后下一帧即自愈，故「现状流式期同样如此」的原表述不成立。这是本批引入的新鲜度回退，触发条件**确定性**（非偶发）：消息以跨 K 未闭合的强调/链接开头。生产可达性：一条以超长 URL 的 markdown 链接或未闭合加粗开头的回复即可。收窄需在 delta 粒度验「闭合后摘要是否已变」（O(K)/delta，与「冻结零成本」目标冲突），本批不做。同一根因的另一形态（前 256 字符是可剥空的引导内容：纯空白 / hr 行 / `[](u)` 空链接）已由第四道守卫 `isRailSummarySettled` 修掉（未触顶不冻结）。触发条件：用户报告流式期 rail 标签残留 `*`/`[` 或内容迟迟不出现。
- R4（card-01 P1-3 / card-03 P3-4，新增）：冻结槽是模块级**单槽**，两个并发流式 turn（split mode 双 session 同时流式；单 panel 插话回流后新旧回合双工作态并存）会交替覆写同一槽，该窗口内冻结收益归零。**无错值**（守卫是 id + 前缀双等，miss 只会导致重算）。改 per-message-id Map 有泄漏面（须配 WeakRef/上限），代价大于收益，本批不做。触发条件：用户报告并发流式场景下主线程占用未下降。
- R5（card-01 P1-4，新增）：流结束后 `isStreaming` 可经 `forceWorking` / `redriveLastTurnStreaming` 复翻 true，把已完结 turn 的陈旧冻结摘要召回显示。仅影响视觉（值仍是该 message 前缀的正确摘要），且随下一次重算自愈。触发条件：用户报告已完结回合的 rail 标签内容陈旧。
- R6（card-08 P8-1/P8-4，新增）：验收流程零 session/pi 进程收尾——每条真机 case 都 `session.create` 新 session（= 新 pi 进程），跑完 gate 后残留进程互相抢 CPU。本批已实测：dev 实例与 vitest 并发导致 renderer 三个存量测试 hook 超时误报（`respawn-pending` / `session-exited` / `chat-lru-agentcall`，均与本次改动无关、单跑全绿）。属验收基建议题，不在本批代码范围。触发条件：gate 出现与改动无关的 hook 超时。
- R2（A9）：若 canReuseView turn 分派实际不比对 preview，则本改动为空操作（无害）；若比对，移除后复用率变化由 T1 的 buildStreamViewItems 成本断言验证。触发条件：实现时读取该函数。
- R3（A10）：若 turn 无 isStreaming 字段，冻结门需由 railMemoFor 增加参数或由调用方传 streaming 标志——接口形态随之微调，api.md 同步更新。触发条件：实现时确认 MessageTurn 字段。
