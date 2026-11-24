# 设计文档（四件事，一件不多）

## 背景与目标

对话流里「两段正文之间的执行信息」（思考 + 工具步骤）现行是三态：进行中双窗（思考窗 92px + 聚合条 116px）、完成后一行摘要、点开为无上限的平铺列表。长回合里它占据过大高度、聚合条与轮头计数重复，进行中看不出「还在推进」还是「卡住了」。同时，模型切换成功后对话流里没有任何记录（pi 落 `model_change` entry 但无事件、reducer 该类型 no-op、轮头不显示模型名），用户无从知道后半段回答换了模型。

目标：① 过程卡改成「一张卡 + 12 行窗口、一个 block 一行」：进行中卡头常驻「此刻在做什么 + 计时」，落成后收成一行、点开是同一窗口；② 模型切换成功后，在对话流里于切换发生的位置出一条横线分隔行（box 图标），回合进行中切换插入回合内部。

| 编号 | 目标 | 题面原句（逐字） | 限定词落点 | case/落点 |
|---|---|---|---|---|
| G1 | 过程卡窗口上限 12 行、一个 block 一行 | 「窗口 12 行。」「改成一个 block height 为一行，改成12行」 | 机制：窗口行数由 CSS 令牌 `--proc-tape-rows: 12` 定义，行高 24px，整卡 316px | AC-H12 |
| G2 | 进行中卡头常驻「此刻在做什么 + 计时」 | 「2. 卡头常驻OK」 | 机制：卡头右侧活动 chip（类型词 + 计时），每秒刷新 | AC-CHIP |
| G3 | 进行中要能感知持续推进 | 「要给用户能感知到是在持续推进，而不是固定4行陷入了停滞的感觉」 | 机制：跟随滚动 + 上沿淡出 + 「更早 N 条/回到最新」+ 执行中命令同行输出 + 计时 | AC-LIVE |
| G4 | 落成后收成一行，点开是 12 行窗口 | 「3. 落成后收成一行OK」 | 机制：`followedByText`/回合落成 → 收成一行；点卡头展开窗口 | AC-SETTLE |
| G5 | 单条详情走右侧抽屉（沿用 D4，不改行内展开） | 用户裁决：「沿用右侧详情抽屉（推荐）」 | 机制：点击窗口内工具行 → 现行 `AggregateToolDetailDrawer`（2026-11-06 D4 保持） | AC-DETAIL |
| G6 | 思考文字在窗口里只占一行，点开看全文 | 「一个 block 一行」 | 机制：live 只露最新一行（只显示一行）；点开在窗口内展开 240px 滚动区 | AC-THINK |
| G7 | 保留同类工具分组标题行 | 用户裁决：「保留组标题」 | 机制：窗口行 = 组标题行 + 成员行，全部计入 12 行 | AC-H12 |
| G8 | 模型切换成功后出一条横线分隔行（box 图标） | 「对话中如果切换了模型，并且 pi 也接收到了切换，那么也要展示一条模型切换的消息」「5. 横线分隔行」「用box。」 | 机制：新系统消息 `modelSwitch`，渲染复用 SystemNotice 横线分隔行族，图标 = lucide Box | AC-MSW-LIVE, AC-MSW-ICON |
| G9 | 回合进行中切换插入回合内部 | 用户裁决：「回合内插入（推荐）」 | 机制：`message-turns` 给打开的回合加回合内通知位，trace 按时间插入该行 | AC-MSW-MID |
| G10 | 只有 pi 确认成功才出行；同模型重复写入不出行 | 「并且 pi 也接收到了切换」 | 机制：行以 pi `model_select`（仅真实变化时发出）为信号源；reducer 对「与上一生效模型相同」的 `model_change` 不出行 | AC-MSW-REPLAY, AC-MSW-DEDUPE |
| G11 | 实时与回放两条通路同形 | 项目红线：live ≡ reload（AGENTS.md 关键规则 9） | 机制：同一 reducer 派生同一 `modelSwitch` 消息；live 走合成 entry、回放走真实 `model_change` entry | AC-CORE-EQUIV |
| G12 | 新增文案中英双侧对齐 | 项目规范（check_i18n_locale_sync） | 机制：`packages/ui/src/locale/{zh-CN,en-US}/panel.ts` 同组新增键 | AC-I18N |

## 验收是什么

本验收的重点是**真机 DOM 行为**：开发实例 + faux 对话（真 Electron + 真 pi 子进程 + 真扩展装载）驱动出长回合与模型切换，用 CDP 断言窗口 12 行上限、卡头计时唯一、落成收起/展开、切换行在回合内/回合间的位置；core 侧另用真实 pi session JSONL fixture 直跑 reducer 断言回放派生。

验收判据 = [acceptance.md](acceptance.md) 的实机 case 全绿（trunk = AC-H12）。

## 方案对比与层归属

| 方案 | 形态 | 取舍 |
|---|---|---|
| A（选定） | 在现组件族内改：`ProcessAggregateBlock` 保留为容器（header + tape 两段），`AggregateLiveWindows`/`AggregateExpandedBody`/`AggregateSummaryRow` 被新 header + tape 取代；延续 `SegmentThinkingRow`/`SegmentToolGroup`/`SegmentToolRow`/抽屉/悬停卡 | 复用既有段契约、组分组、i18n 词表与测试范式；改动集中在一个组件族 |
| B | 新建独立组件替换整族 | 控制更自由，但丢弃既有组分组/抽屉/悬停卡接线与 fixture 测试，重复实现 |
| C | 只给现有双窗加限高 | 改动最小，但「一个 block 一行 / 卡头计时 / 落成后点开同一窗口」三件事都做不到 |

层归属：过程卡的**行数据**（段、组、计数、单位序）留在 core `process-segment` / `trace-window`（不改）；**展示态**（窗口展开、跟随、活动 chip 文案）留在 ui 组件本地 + composable（不落 store，沿用 D6 不持久化）；**模型切换的事实**在 core 派生（`apply-entry` 新增 `model_change` case），**实时信号**经 pi 扩展 → runtime 帧 → 前端合成 entry（沿用压缩摘要的现行范式：`message.compactionSummary` + `cmp-<uuid>` 合成）。

## 树形拆分

主干文件清单：
- packages/ui/src/features/chat/process-aggregate/
- packages/ui/src/features/chat/composables/
- packages/ui/src/features/chat/ProcessAggregateBlock.vue
- packages/ui/src/features/chat/Turn.vue
- packages/ui/src/features/chat/__tests__/
- packages/ui/src/locale/zh-CN/panel.ts
- packages/ui/src/locale/en-US/panel.ts
- packages/renderer/src/style.css
- packages/shared/src/message.ts
- scripts/acceptance/
- docs/tree-plant/

| 枝名 | 目标 | 依赖 | 风险级 | 文件 | case |
|---|---|---|---|---|---|
| tape-scroll | 跟随滚动/上滚暂停/「更早 N 条」「回到最新」「下面还有 N 条」 | 主干 | 中 | packages/ui/src/features/chat/composables/useProcessAggregate.ts, packages/ui/src/features/chat/process-aggregate/AggregateTape.vue, packages/ui/src/locale/zh-CN/panel.ts, packages/ui/src/locale/en-US/panel.ts | AC-LIVE |
| tape-chip | 卡头活动 chip：类型词 + 计时（每秒，页面隐藏暂停），全卡唯一计时 | 主干 | 中 | packages/ui/src/features/chat/composables/useProcessAggregate.ts, packages/ui/src/features/chat/process-aggregate/AggregateCardHeader.vue, packages/ui/src/locale/zh-CN/panel.ts, packages/ui/src/locale/en-US/panel.ts | AC-CHIP |
| tape-settle | 落成后收成一行、点开 12 行窗口、详情走右侧抽屉、思考点开看全文 | 主干 | 中 | packages/ui/src/features/chat/process-aggregate/, packages/ui/src/features/chat/ProcessAggregateBlock.vue, packages/ui/src/features/chat/Turn.vue, packages/ui/src/features/chat/__tests__/ | AC-SETTLE, AC-DETAIL, AC-THINK |
| msw-replay | 回放派生：`model_change` entry → `modelSwitch` 系统消息；同模型/首个切换不出行 | 主干 | 高 | packages/core/src/domain/chat/apply-entry.ts, packages/core/src/domain/chat/__tests__/, packages/shared/src/message.ts | AC-MSW-REPLAY, AC-MSW-DEDUPE, AC-CORE-EQUIV |
| msw-live | 实时链路：host-internals 扩展转发 `model_select` → runtime 帧 → 前端合成 entry | msw-replay | 高 | extensions/taiji/host-internals/src/, packages/runtime/src/services/session/event-interpreter.ts, packages/runtime/src/services/session/event-interpreter*.ts, packages/shared/src/protocol.ts, packages/core/src/domain/chat/effects/, packages/runtime/src/__tests__/ | AC-MSW-LIVE |
| msw-ui | 切换行渲染（横线分隔行族 + box 图标）与回合内插入 | msw-replay, msw-live | 高 | packages/core/src/domain/chat/message-turns.ts, packages/core/src/domain/chat/__tests__/, packages/ui/src/features/chat/Turn.vue, packages/ui/src/features/chat/SystemNotice.vue, packages/ui/src/locale/zh-CN/panel.ts, packages/ui/src/locale/en-US/panel.ts | AC-MSW-MID, AC-MSW-ICON |
| i18n-final | 文案双侧对齐与词表核对 | 主干 | 低 | packages/ui/src/locale/zh-CN/panel.ts, packages/ui/src/locale/en-US/panel.ts | AC-I18N |

（长叶阶段：空段/无模型信息/超长命令截断/暂停后新内容/12 行临界/组标题跨段/失败步/思考无文字，归入 `leaf`，不单独立枝。）

## 非功能设计

| 项 | 类别 | 不做会怎样 | 预计多久出问题 |
|---|---|---|---|
| 计时器生命周期：unmount 清理、页面隐藏暂停、只更新 chip 文本不重算段 | 可靠性/性能 | 多个过程卡各持 interval，卸载不清理会持续重渲染；页面隐藏仍在跑白烧 CPU | 一次 packed 长回合、多卡同屏即出现 |
| 高度上限在任意内容下成立（行高固定 24px、长命令/长参数截断、组标题行计入行数） | 可靠性 | 超出上限的卡把对话流挤走，用户回到「太长了」的原问题 | 首个长回合 |
| live ≡ reload：同一现象两通路同形（合成 entry 与真实 entry 派生同字段） | 可靠性 | 实时看到切换行、重开会话消失（或反之），用户不信任记录 | 首次重开会话 |
| 每秒 tick 的更新范围限定在 chip 文本（不触发段重算/列表重排） | 性能 | 长回合里每秒全量重渲染，滚动卡顿 | 数百步的回合 |

### 显式不做

| 项 | 理由 | 题面提及 | 重审触发 |
|---|---|---|---|
| 连续切换合并成一行（写最早→最后，中途进悬停） | 每次切换是独立事实，合并需引入相邻判定与额外展示状态；先逐条记录，真实噪声出现再合并 | 否 | 真实使用中 1 秒内出现 ≥3 次切换 |
| 切换来源归属（定时任务名） | pi `model_select` 不带来源信息，scheduler 只调 `pi.setModel`；要归属需扩展另发上下文信号 | 否 | 用户把定时任务切换误读为手切（反馈记录出现时） |
| 思考文字多行预览（窗口里一次露多行） | 用户裁决「一个 block 一行」；全文通过点开查看 | 是 | 题面口径变化（要求预览多行）时 |
| 卡片内搜索/过滤 | 未过三个月判据 | 否 | 窗口内行数 × 回合数使定位成本明显上升（用户反馈检索困难时） |
| 模型切换展示字段的持久化格式演进（格式版本 / 迁移 / 重建代价） | 本交付不新增持久化格式：`model_change` 由 pi 写入、本交付只读；project 不引入新字段落盘，旧会话无需改写（格式版本 = 无新增，不迁移，重建代价 = 0） | 否 | pi 升级改变 `model_change` entry 结构（发行说明或回放用例开始失败时） |
