# taiji 领域模型登记

> **本文件定位**：领域聚合、不变量与状态机的登记处（统一语言词条在 [CONTEXT.md](CONTEXT.md)）。当前登记域：**画布（problem-solve canvas，聚合与不变量，2026-10）**；**状态机基建与六域状态机（run / 画布节点 / plan / goal / permanent-session + 归档单元 + session occupancy turn，2026-10，见下「状态机基建」节）**；**会话健康分层（停滞判定三层信号源与判定权归属，2026-11，见下「会话健康分层」节）**；**session 存储归档域（归档单元聚合 + 不变量 + 转移表，2026-10，见下「session 存储归档域」节）**；**subagent 会话轮债权域（record 会话 / 轮 / 债权聚合不变量，2026-10，见下「subagent 会话轮债权域」节）**；**模型路由域（模型路由 / 端点 / 路由规则概念与不变量 AX1-AX5，2026-11，见下「模型路由域」节）**。
>
## 状态机基建（@zhushanwen/state-machine）

「领域状态必须显式状态机」裁决（2026-09-21）的共享实现载体（[ADR-0152](adr/decisions.md)）：`packages/state-machine`，零运行时依赖，npm 发布（`@zhushanwen` 命名空间，pi 扩展侧可依赖）。新领域立状态机 = 一份声明（状态词表含 terminal 位 + 事件词表 + 行式转移表含 guard 与动作引用 + 每实体错误策略），机器机制由基建统一提供：合法性判定（`transition` 纯函数内核——guard 按行序求值、多命中 = 转移表不变量破坏恒 throw、planned 只计划不执行）、定义期自检（词表外行 / 多行混入无 guard 行即 throw）、转移动作执行（`runTransition` 事务性编排外壳——宿主按名注入实现，全部成功次态才应用，单态 fail-fast）、穷举单测生成（`generateTableTests`）、词表外运行时输入映射（`coerceState`——枚举 includes 白名单，拒原型链键）。

纪律：

- 新状态机一律声明即用，不再手写转移表 + transition 函数 + 穷举单测；穷举由生成器承载，行为级/契约级断言（错误类型、错误码、降级行为）保留域内
- 表外 fail-fast 不静默吞：throw 族错误信息含当前态合法事件清单（`errorFactory` 保形既有错误类型，消费方 instanceof 分类分支不受迁移影响）；result 族返回 `{ok:false}`，调用方义务 = 不落盘、不执行副作用
- 事务外壳边界外域：run 与 canvas 的域内编排（「内存权威先推进 + 动作失败分级容忍」/「权威事件流先行 + 快照与广播失败容忍」）不经外壳事务化，编排上收须按已接受变更单独登记（ADR-0152）

五域迁移登记（2026-10 迁入，只迁表与判定，域内编排留域内）：

| 域 | 状态词表 | 机器声明（实现载体 = 本基建） | 错误策略 / 表外处置 |
|----|---------|------------------------------|---------------------|
| workflow run 生命周期（outcome 五值正交 `done/failed/cancelled/time_limited/partially_succeeded`，仅 terminal 产生——partially_succeeded 见 [ADR-0159](adr/decisions.md)：run 终局吸收成员交付，run 级终局优先于成员集合派生） | created / running / settling / terminal + interrupted 暂停态（resume 流回 running） | `RUN_MACHINE`（packages/subagent-core/src/orchestration/run-events.ts） | throw——`IllegalTransitionError` 保形（errorFactory 构造既有类实例，消息含合法事件清单） |
| 画布节点生命周期 | draft / under-review / passed（terminal）/ rejected / shelved | `canvasLifecycleMachine`（packages/runtime/src/services/canvas/canvas-foundation.ts） | throw——`CanvasDomainError` 保形（`lifecycle_transition_illegal` 错误码 + recover 指引） |
| plan 计划生命周期 | idle / planning / reviewing / revising / approved / dispatching / completed / exited（终态 + enter 重启出边并存） | `PLAN_MACHINE`（packages/extension-protocol/src/extensions/plan/state-machine.ts） | result——表外 `{ok:false}` 不炸 turn |
| goal 目标状态 | active / paused / blocked / complete / budget_limited / cancelled（后三 terminal） | `GOAL_MACHINE`（extensions/universal/goal/src/engine/goal.ts；`transitionStatus` 保形包装对外） | throw |
| permanent-session 两态 | running / idle（词表与 ExecutionStatus satisfies 双向锁定） | `permanentSessionStatusMachine`（packages/subagent-core/src/execution/domain/record-status-machine.ts） | result——表外拒绝经域内原语转 return false（两态 CAS 语义保形） |
| 归档单元（session 归档子域，基建首个新消费者） | staging / archived / restoring | `archiveEntryMachine`（packages/runtime/src/services/archive/archive-entry-machine.ts） | throw——对外错误码由服务层承载 |
| session occupancy turn 维（对话回合进行阶段，chat-flow-consistency D1 承接 ADR-0152 第 5 条 session 域立项） | idle / dispatching / generating / settling（无 terminal——回合状态可任意重入） | `SESSION_TURN_MACHINE`（packages/runtime/src/services/session/event-interpreter.ts） | throw（词表外事件在枚举类型层拦截 + 机器定义期自检兜底；**全组合合法表**形态——每事件 × 每状态一行、幂等 no-op 也是行，表外仅词表外值可达，详见下「session occupancy turn 状态机」节） |

边界登记：background-task 域尚无转移表（显式化独立立项，ADR-0152）；core 的 streaming-state-machine.ts 是消费顺序 factory 深模块、非转移表状态机，不属本基建范畴；归档子域的聚合与不变量登记见下「session 存储归档域」节（本节只登记其状态机实现载体）。

## session occupancy turn 状态机（chat-flow-consistency D1，2026-10）

session 的会话占用（occupancy）是四维结构：turn 维（状态机，见上表 `SESSION_TURN_MACHINE`）+ compacting / bash / handingOff 三个与 turn 正交的两态布尔维（ADR-0080 先例：两态域布尔判定比表级 fail-fast 更早更严，不建机器）。唯一写入口 = `applySessionOccupancyTransition`（event-interpreter.ts），内部编排「turn 机器 transition + 布尔维 patch」一次合并写；值变化才广播 `session.occupancy` 状态事件（全等去重）。原「同点双写」的派生三布尔（isGenerating/isCompacting/isBashRunning）已删除，消费方一律从 occupancy 派生（`isGeneratingTurn` = turn ∈ {dispatching, generating} 单点定义；「回合进行中」判定集合 = shared `ACTIVE_TURN_PHASES`，含 settling——投递判定、发送位预测、前端回合判定引用判定集合；活动条（ActivityStrip）消费 sessionPhase 派生视图按阶段分行，不直接引用集合）。

- **事件词表与挂点**（词表派发点静态审计锁定每项必有派发点）：dispatching（投递受理出站）/ generating（message_start）/ settling（agent_end）/ idle（agent_settled + abort 型 1 + abort await 失败收尾 + 异常兜底 + handled 终局回落）/ reject-other（prompt 真失败收尾）/ full-reset（进程死亡四维全复位）；compacting± / bash±（压缩与 bash 窗口）/ handingOff±（交接编排在途，挂点 handoff-service：编排开始置位、cleanupInflight 统一复位）。后台压缩（smart-context 自管路径，ADR-0182）不进入 compacting 维：不经 AgentSession、不置 pi 压缩锁、不产 compaction_start/end 事件，compacting± 挂点仅由 pi 同步压缩路径驱动。announce-idle 事件退出词表（宣告语义归广播层原语 `announceSessionOccupancy`，跳过全等去重强制广播）；abort-stall 两死行与 reject-processing（随 u5a 忙闲门禁退役——processing 分型重试随忙闲门禁退役、转移行零消费）已删（派发点审计防死行复发，退役词清单一一对应 session-turn-machine.test.ts 静态审计 it.each 清单）。
- **不变量**：
  1. occupancy 四维唯一合法写点 = 转移原语（绕开直写在编译期红）；session 记录不存任何平行忙闲布尔
  2. turn 维转移行为 = 全组合合法表（绝对式幂等 patch 保形：任何状态收任何事件都写事件目标值，乱序/重复事件不产生错误状态——读侧零回归是迁移约束）
  3. abort 链的 idle 转移只允许在型 1（入口快照 turn ∈ {dispatching, generating}，有回合被中止）内调用；压缩取消与收尾窗口不写终态、不广播、不动 turn
  4. 终态 sidecar 写入纪律 = 第一终态优先（persistSessionOutcome 统一层：已有 done/error/stopped 则跳过；willRetry=true 的 attempt 级中间失败跳过终态写入、settling 转移保留）
- **穷举与审计**：`generateTableTests` 全组合穷举（4 态 × 6 事件）+ 词表派发点静态审计 + 退役词零残留断言（session-turn-machine.test.ts）。

## 会话健康分层（pi-stall-detection，2026-11）
> 机制纪律：健康信号分层独立——每层信号源只探测本层，不跨层外推（事件循环挂死与回合推进停滞共用单层信号必然产生盲区）；观测通道与业务通道分离——请求级有界等待只存在于健康探测请求，业务 RPC（prompt / steer / bash / compact）永不携带墙钟超时，失败信号归 pi exit/error 事件链（[ADR-0122](adr/decisions.md) 保留白名单「PingProbe 无进展检测」行承载的观测通道例外）。判定与处置的机制单点在 runtime session 域：探测 = `PingProbe`（event-interpreter-ping.ts），第 2 层判定 = 静默判定矩阵（event-interpreter-silence.ts），自动处置链编排 = message-dispatcher.ts；renderer 只做辅助呈现，不复制判定规则。排障入口见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)「会话停滞判定与恢复」条目。

会话健康由三层各自独立的信号源判定，与上节 occupancy 正交——occupancy 回答「回合处于哪个进行阶段」，健康分层回答「占用中的会话是否停滞」：

| 层 | 信号源 | 判定权威 | 判定语义 |
|----|--------|---------|---------|
| 第 0 层 进程存活 | pi exit / error 事件链 | RpcClient exit 链（进程生死唯一权威） | 进程死 → 全部在途 RPC 显式失败（rejectAll）→ 错误入流 + 显式收尾广播 |
| 第 1 层 事件循环活性 | get_state 探测请求有界等待（`PING_OBSERVE_TIMEOUT_MS` 5s 窗，60s 周期） | `PingProbe` 失败计数（每回合瞬态，探测生命期随 occupancy 转移边沿启停） | 窗内响应 = 事件循环活（失败计数清零）；超时计一次失败——2 次广播停滞 WARN，3 次判停滞（get_state 同步内存读必响应，连续观测超时即停滞确定性成立，无误杀范围） |
| 第 2 层 回合推进 | 帧流事件静默计时 + 在途阶段定位 + 豁免锚点检查 | runtime 静默判定矩阵（event-interpreter-silence.ts；判定阈值 T = idleBackgroundSec + 300s 与提示阈值 T_hint = T − 60s 同源联动推导，经广播携带，renderer 不复制推导） | 静默超 T_hint → 活动条温和提示（判定权在 runtime，呈现只是辅助）；超 T 且无在途信号、无豁免锚点（ask_user 等待 / 压缩中）→ 判死；前台命令转后台不设锚点——防线 = T 公式恒盖过转后台窗 + 转后台早退边沿帧（tool_execution_end）刷新计时 + 转后台关闭配置不装配判死分支 |

**非 occupancy 第五维**：停滞判定是信号驱动的瞬态判定与广播，不产生持久状态、不进 occupancy 状态机（上节四维结构与 `SESSION_TURN_MACHINE` 转移表不受影响）；与 occupancy 的唯一交点是生命期——探测与静默计时只在回合占用期运行、随 occupancy 转移边沿启停。

**自动处置分型**（处置经强杀编排 forceQuitSession 唯一实现，按来源分型）：

- 第 1 层判停滞且进程存活（事件循环挂死形态）→ 自动处置链：sample 调用栈取证 → 判死强杀（`probe_stall_auto_quit` 机器分型）→ 窄化自动恢复接回会话 → steer 注入原因提示；恢复失败降级死亡发声 + 用户手动重开。进程已死形态不进自动链，维持错误入流 + 用户显式重开。
- 第 2 层判死 → 自动 abort + steer 注入原因提示（含静默时长与判定依据）；abort 悬挂超升级窗升级判死强杀（与第 1 层共用机器分型与自动恢复接线）。边界：转后台后同回合仍占用且静默超 T 照常判死——pending 后台任务无帧流信号可作锚点（完成通知经 steer 注入开新回合），占用回合的持续静默即停滞目标形态；pi 整体挂死由第 1 层探测兜底。禁用超时配置（httpIdleTimeoutMs=0）、自愈窗实际配置值超出 T 覆盖公式、或转后台关闭（idleBackgroundSec=null）的会话不启用第 2 层判死，降级仅提示（显式登记边界，非缺陷）。
- 用户停止分型（`abort_timeout` / `user_force_quit`）语义不变：升级窗强杀后恢复归用户显式重开，不进自动恢复接线。

## 画布域
> 机制纪律：不变量与状态机转移表的实现单点在 runtime CanvasService（`packages/runtime/src/services/canvas/`）——renderer / extension 侧不复制领域规则，全部写操作经唯一入口 `mutate`（契约 = `packages/extension-protocol/src/extensions/canvas/`，agent 工具实现 = `extensions/taiji/canvas/`，GUI 写通道 = WS RPC `canvas.mutate`）。


问题解决画布是 tech-design-wf 之前的方向规划层，一个独立限界上下文：与会话上下文经回推 prompt（文本防腐）交互、与 workflow 上下文无直接依赖（审查 subagent 只复用派发基建）、与计划上下文（plan）互不感知；对下游 tech-design-wf 经需求卡（requirement card）防腐对接。状态权威 = runtime CanvasService；持久化 = session 存储树域 8 `<dataDir>/ext-sessions/<ownerSessionId>/canvases/<canvasId>/` 下 `events.jsonl`（append-only 领域事件流，唯一权威）+ `canvas.json`（可由事件流全量重放推导的加速快照，写入顺序恒「先事件后快照」——快照允许滞后、永不超前）。归属即路径：一张画布恒归属创建它的 session（ownerSessionId），一个 session 可有多个画布（1:N）。

单一「问题解决画布」上下文含两个聚合。

### 聚合 1：画布（聚合根）

成员：全部图节点（问题 / 方案 / 论据 / 约束四类；约束类第二版可达——MVP 的 grow 邻接矩阵四条 case 均不产约束节点，无创建通道）、边（六种：decompose / resolve / argue / rebut / constrain / reference，MVP 落地前四种——constrain / reference 第二版，契约词表不预留）、评论（锚定附件）、支撑度（主干边评价值）、方向裁决记录（画布元数据 + 事件留痕，非图节点）、待重审路径集合。

不变量（全部可核对，表外写入 fail-fast 并返回结构化错误码 + 恢复动作文案）：

1. 一张画布有且仅有一个根节点，类型为 question，且带完成判据（可证伪）与范围排除
2. 主干图（decompose + resolve）无环
3. 任一 question 的 resolve 边中，selected 至多一条；selected 变更产生方案选择事件并留对比理由（换选走同一调用事务内的迁移语义）；方案被否决 / 搁置时其 selected 标记同步清除（否决 = 放弃该候选——transition 转移侧清除，事件流重放同函数还原，复活后须重新选定），resolve 路径的「selected 方案」由此恒处于有效生命周期
4. rejected 节点不可删除、不可从 rejected 直接转 passed（必须先复活为 draft）
5. 素材性为 fact 的论据必须携带核实状态（已核实 / 未核实）；未核实论据不得作为 passed 的依据
6. constrain 边的目标必须是画布内存在的节点（子树锚点）——第二版生效：MVP 契约词表无 constrain 边，此不变量暂无校验对象
7. 执行叶子 passed 前完成判据必填；dispatched 前必须 passed 且下游产物指针必填
8. 评论被添加后，响应状态初始为待响应；agent 的采纳 / 反驳留痕前不得转为已响应
9. 用户对节点内容的改动（patch / select / comment）在 mutate 事务内自动计算传播范围进待重审集合：一般改动 = 从该节点上溯到根的路径；换选 = 上溯路径 + 旧选中方案整个子树。dispatch 只在已 passed 的执行叶子上登记下游产物指针、decide-direction 只拍板画布方向元数据，均不改变可审内容，不进传播集
10. 规划收敛终态的前置 = 待重审集合为空 + must-fix 清零 + 执行叶子全部 passed/dispatched（收敛确认与 export 均校验此不变量；export 另要求收敛确认已执行——converged 终态，GUI 与 agent 代执行两条表面同一前置）
11. 唯一入口：图元素增删改、状态转移、评价、派发均经画布聚合根的操作（actor 字段区分 user / agent / review；per-action × actor 合法性矩阵在契约模块，表外组合 fail-fast）
12. 一张画布有且仅有一个归属 session；画布的创建与访问校验归属（GUI 清单与 agent 侧工具 canvas_list 按归属过滤，跨会话访问返回 `forbidden` 结构化拒绝）；session 删除级联删除其全部画布（画布落归属 session 的存储树内，随整树回收）

**节点状态机**（生命周期 × 派发二维正交，禁止直写状态字段）：

- 生命周期维（根节点除外——根不可搁置 / 否决）：`draft（草案）→ under-review（审查中）→ passed（通过）| rejected（否决，灰显保留）`；draft/under-review 均可 `→ shelved（搁置）`；`rejected → draft`（复活须新证据或用户裁决，留理由）；`shelved → draft`。合法转移表之外的写入一律 fail-fast（判定载体 = `canvasLifecycleMachine`，@zhushanwen/state-machine 声明，见「状态机基建」节）；每次转移记录触发者（agent 提案 / 用户裁决 / 审查结论）。
- 派发维（仅执行叶子，与生命周期正交）：`passed 的执行叶子 →（用户拍板）→ dispatched（已派发，登记下游产物指针）`。dispatched 后仍可编辑（patch 无 dispatched 门槛），编辑使该叶子进待重审、门禁红、导出锁定，复审通过后解锁重新导出。
- 状态机不作用于边——边的缺陷经支撑度（有缺口 / 不成立）+ 关联 must-fix 表达，不另建边状态机。

**就绪递归与收敛判据**（自底向上传播，与反向审查同方向）：

- question 就绪 = 该问题被 rejected/shelved（判定范围外），或其完成路径全部成立：resolve 路径（存在 selected 方案且该方案子树就绪）与 decompose 路径（分解子问题全部就绪）并存时须同时成立；两路皆无 = 悬空问题，不就绪
- option 就绪 = 无分解子问题，或子问题全部就绪
- 叶子 = 无分解出边的 selected 方案（结构派生）；执行叶子 = 叶子且被显式标记可派发（规划决策，非结构事实）
- 规划收敛 = 根就绪 + 至少一个执行叶子（防空集 vacuous 收敛——无执行叶子 = 无交付单元，拒绝收敛）+ 全部执行叶子 passed/dispatched + must-fix 清零 + 待重审集合为空（不变量 10）

### 聚合 2：审查报告（ReviewReport，聚合根）

成员：轮次、条目（must-fix / suggestion 两级，经图元素 id 引用）、处置记录（采纳 / 登记后做 / 拒绝留理由，first-writer-wins——已有处置记录的条目再次处置被拒绝并报错误码）、终态（converged / max-rounds / escalated / stuck 四值，除 converged 外全部附停回说明与恢复动作建议）。

**轮次口径（一轮 = 一循环）**：一轮 = 一次完整审查循环（发起 → reviewer 报告写回 → 处置）。当前轮已有报告条目 = 轮次完成；未完成时再发起 = 同一轮重发（GUI 发起链路 user 发起 → 回推 → agent run 再发起两跳计一轮），不推进轮次、不消耗轮次预算。maxRounds 按完成的审查循环计数；达上限后再发起置终态 max-rounds 停回，用户升级裁决放行恰一轮（round+1 且 maxRounds 同步抬升，ReviewEscalated 事件留痕，放行后即回 in-progress——escalated 不驻留 status；stuck 为词表值，MVP 无触发路径）。

不变量：

1. 条目引用的图元素 id 必须存在于画布
2. 终态 converged 必须满足全部 must-fix 条目关闭；max-rounds / escalated / stuck 终态必须附停回说明与恢复动作建议
3. 审查与修复分离：审查聚合只追加条目与结论，不直接改画布聚合（reviewer 只读 + review-append；修复由执行侧按处置表经 mutation 完成后逐条 review-resolve 登记）

**审查产物与图的分界**：论证留图（对结果有持久影响的反对 / 证据成为论据节点），过程留报告（轮次、处置表、终态）——图承载内容，报告承载过程。

### 领域事件

节点历史 = 事件流回放（who / when / why / what）。每个 mutation action 至少产出一个事件（read / list 为查询类不产事件）；事件词表 18 值（全量 SSOT = 契约 `CANVAS_EVENT_TYPES`，`packages/extension-protocol/src/extensions/canvas/state.ts`）：主事件族（14 mutation action 各一，映射 = 契约 `ACTION_EVENT_MAP`）CanvasCreated / GrowthDirectionDecided / NodeCreated / NodeModified / StateTransitioned / OptionSelected / NodeDispatched / CommentAdded / CommentResponded / ReviewRequested / ReviewEntryAppended / ReviewEntryResolved / ConvergenceChecked / CanvasExported，附属事件（不独立对应 action）DirtiedPathMarked（待重审标记）与审查终态族 ReviewConverged / ReviewMaxRoundsReached / ReviewEscalated。`events.jsonl` 是唯一持久权威，`canvas.json` 快照损坏或不一致时从事件流头全量重放重建。

## session 存储归档域
> 机制纪律：领域规则的实现单点在 runtime ArchiveService（`packages/runtime/src/services/archive/`）——renderer（归档列表/摘要视图）、transport（三 RPC 分发）、extension（session-reader 归档根感知）不复制领域规则，全部经共享契约（`packages/shared/src/archive.ts`）消费。统一语言词条（归档 / 归档单元 / 簿记文件）见 [CONTEXT.md](CONTEXT.md)；存储布局与「归档态不进 SessionStatus」决策登记 [ADR-0153](adr/decisions.md)。

session 存储域（SessionLifecycle 写、SessionScanner 读、文件系统为唯一持久化）的归档存储子域：输入是「在场 session 的全部磁盘构成」，输出是「归档目录内的归档单元」，与运行时对话状态（pi 进程、内存 Map）解耦。归档态与 session 的「在场」状态空间正交（归档 = 不在场，条目不进列表响应），**不进 SessionStatus 词表**——一等载体是簿记 status 字段与 ArchiveSummary。

### 聚合：归档单元（ArchiveEntry，聚合根 = 簿记文件）

成员：主文件压缩体（`<原主文件名>.jsonl.zst`，staging 期为明文 `.jsonl`）+ 六类旁挂文件（project / 终态 / 预设 / agent 绑定等，原样明文随迁）+ 附件三目录（`assets/<sessionId>/{attachments,artifacts,image-cache}`——源为 session 存储树三域，恢复时反向搬回）+ 簿记文件（`.archive.json`，聚合根——簿记在即单元在，簿记消失即单元消亡）。物理落位镜像 sessions 布局（`<agentDir>/archive/<encodeCwd>/`）。留置域（btw 线 / subagents / canvases / workflow / plugin-data / logs 等）不随档、原位未动（随档范围逐域裁决见 ADR-0153）。

不变量（全部可核对：单测 + e2e 可断言，运行时校验 fail-fast）：

1. **互斥存在**：同一 session 的主文件（sessions/ 树内 `.jsonl`）与归档单元（archive/ 树内 `.archive.json` / `.restoring` 簿记）不得同时存在于稳定态——恢复前冲突检测（`archive_restore_conflict`）与启动自愈（双存在归位）保证
2. **压缩体消费前校验**：恢复与 purge 引用枚举两条路径消费压缩体前 sha256 校验必须通过（agent 引用只读簿记明文，不消费压缩体，不涉校验；purge 侧校验不过 = 引用状态不可知 → 级联 keep-all 保守保留，宁保留不误删）
3. **列表派生**：归档列表条目恒等于 `archive/**/*.archive.json` 扫描结果——不允许存在独立登记渠道（`.restoring` 标记不在列表，恢复中条目对用户不可见）
4. **扫描范围互斥**：归档目录永不进 SessionScanner 的 sessions 扫描范围（物理隔离，构造性保证——构造性 = 由结构本身保证、无需额外验证；两根互不为对方子树）

**归档单元状态机**（`@zhushanwen/state-machine` 声明，实现载体登记见上「状态机基建」节；表外转移一律 fail-fast）：

| from | on | to | 说明 |
|------|----|----|------|
| （initial） | — | staging | archive 动作创建实体（同步段完成搬移 + 簿记骨架），由机器 `initial: 'staging'` 承载 |
| staging | compress_done | archived | 后台压缩任务提交簿记终态 |
| staging \| archived | unarchive | restoring | 簿记 rename 为 `.restoring` 后缀 |
| restoring | restore_done | （消亡） | 恢复完成，归档单元清除——`to: null` 实体消亡形态 |
| restoring | restore_rollback_to_staging | staging | 冲突/校验失败回滚（原态 = staging 支） |
| restoring | restore_rollback_to_archived | archived | 冲突/校验失败回滚（原态 = archived 支） |
| staging \| archived | purge | （消亡） | 彻底删除——`to: null` |

状态判定唯一权威 = 读磁盘（无簿记 = 无单元；status 字段 = staging / archived；`.restoring` 后缀 = restoring）。同 session 的归档域操作（后台压缩任务 / unarchive / purgeArchive）按到达顺序串行执行，后到者对已消失归档单元按簿记存在性门 fail-fast（`archive_not_found`，拒绝时零副作用）；操作中途崩溃由启动自愈归位（七行表覆盖全部中间态，含压缩收尾窗口〔明文已删 + 压缩体在场 + 簿记仍 staging〕：archive / unarchive 态自动归位，purge 态簿记保持可见、重试幂等达终态）。

**唯一入口**：领域规则单实现 = `ArchiveService`（archive / unarchive / purgeArchive 三操作 + 启动自愈，`packages/runtime/src/services/archive/`）；transport 入口两条，均只调该服务、不各自持有归档规则——① 三条 WS RPC（`session.archive` / `session.unarchive` / `session.purgeArchive`，分发表挂 session 域，命名避开已承载「重开 dead session」语义的 `session.restore`；GUI 侧栏 / 归档视图的调用通道）② session-manager select 通道 `archive` action（agent 工具 `archive_session` → `SessionManagerHandler.handleArchive`：归属校验〔仅限该 agent 管理的子会话〕后调 `archiveService.archive(sessionId)`；仅开放 archive 一操作，unarchive / purgeArchive 不开放给 agent）；彻底删除复用 session 删除级联原语（cascadeDeleteSessionContent + 引用枚举源入参扩展），不自建删除清单。

## subagent 会话轮债权域
> 机制纪律：record 会话状态权威 = subagent-core RecordStore 意图原语族（唯一写入口，C-data-20），轮成败判定唯一产点 = 引擎收尾边沿（pi 引擎适配层），债权结清唯一裁决 = 轮终事实（pending 注销枚举 SettlementReason）。统一语言词条（轮收条 / 失败分类 / 债权结清 / 失联清点 / 被接管轮）见 [CONTEXT.md](CONTEXT.md)；决策登记 [ADR-0158](adr/decisions.md)～[ADR-0163](adr/decisions.md)。

subagent 体系的领域模型在「会话 + 轮 + 债权」框架下组织（permanent-session 模型，万物可续）：**record 是会话**不是任务——两态（running/idle）+ 归档 + 复活（归档唤醒续聊），没有也不需要任务终局（失败可续聊、成功也可续聊）；**轮**（round）是一次有边界的执行（一进程、一问一答），是成败判定与收条的承载单位；**债权**是一笔「等待这轮结果」的请求（派发即欠、轮终结清、失联也是结清形态，对齐 managed session 债权模型 ADR-0087）；**run** 是一次性编排，有终局（与 record 无终局不矛盾——run 终局由成员交付结算集合派生，见 [ADR-0159](adr/decisions.md)）。

不变量（全部可核对，违反即缺陷；词表锚与枚举完整性测试 = `packages/subagent-engine-sdk/src/__tests__/failure-cause-vocabulary.test.ts` / `packages/subagent-core/src/execution/domain/__tests__/record-types.test.ts` / `packages/subagent-core/src/shared/__tests__/run-vocabulary.test.ts`）：

1. **record 事件流 append-only**，历史不可改写——派生层禁止反写事实源（失败事实只追加进轮级 `errors: ErrorFact[]`，`lastError` 由「最后一个非空轮失败」派生，`applyTurnEnd` 不清空）
2. **轮成败判定只产自引擎收尾边沿**（看见 stopReason / exitCode / 引擎 error 事件的层）——最后一条 assistant 消息停因 ∈ {error, aborted} 或存在未消费引擎 error 事件 → 轮失败；`agent_settled` 是 run 结束信号不是成功证据，不构成任何置成功依据；aborted 三源判别（用户/run 取消 → user.cancelled；turn 预算耗尽 → harness.turn_budget_exhausted；其余引擎异常 → engine.*），禁止把中止一律记失败
3. **轮收条只存事实**（引擎停因原值 + FailureCause + 结果正文），推断词只派生不存储——「completed」这类「没报错=成功」的推断只允许作为展示层派生词（引擎停因 = stop 且无失败分类 → 派生「正常收尾」）；被接管轮（promptDisposition=handled）无停因、构造性不满足派生判据，不产生假成功
4. **派生视图只读事实源**（manifest / 通知文案 / list 字段 / 展示词 / renderer 失败红点判据全部消费轮收条事实字段，禁止自建成败推断）
5. **债权结清状态如实**（SettlementReason 封闭五值 completed/failed/cancelled/lost/no_result，fail-visible——词表外解析缺省 unknown，「遇未知按成功」的 fail-open 方向废除）；run 终局如实吸收成员交付（partially_succeeded 入 RunOutcome 值域，一半失败不再显示 done）

## view 展示位域（composer-tray-protocol，2026-11-04）

插件/扩展推送的界面树（view）在展示容器间的路由统一为 placement 声明制，统一语言：

- **placement 族**（词表 SSOT = core `CONTENT_SLOT_PLACEMENTS`，开放字符串注册制）：`drawer.tab` / `overlay.content` / `sidebar.tab` / `settings.section` 四容器族 + `composer.tray`（托盘 widget 位）+ `host.embed`（宿主内嵌族——宿主组件按 viewId 定点消费的树，不进任何标签条容器）
- **资格制两层**：①会话域存储资格——views.update 的 viewId 必须命中该插件清单 contributes.views 的声明集合（runtime 侧校验；未命中 = UNDECLARED_VIEW_ID 结构化拒绝附补声明指引，不入存储不广播；命中按声明 placement 盖印入存储）；②派生资格——placement 值的词表合法性在 renderer 注册表装载链（unknown-placement 告警 + 标 unavailable 不派生）。词表 SSOT 在 core 单源，runtime 不重复持有（跨进程不可反查）
- **声明与内容分离**：声明是资格不是内容——托盘按钮存在性仍由 ViewHostStore 有树驱动（guiTree 非空）；声明 composer.tray 而未推树 = 无按钮（托盘是任务在途信号，空任务不占位）
- **有效 viewId 映射** = 声明 `view` 字段 ?? `id`（`v.view ?? v.id`）——runtime 命中匹配与渲染端声明投影同源（id/view 分离形态是过命名空间校验与保留原始 viewId 的唯一正确声明形态）
- **全局域 mountId 分支维持现状**：挂载点名由宿主注册上报、插件可 listMountPoints 查询，本身是显式契约，不受会话域资格制约束
- 扩展通道（setWidget）无清单声明，写入点统一盖印 `composer.tray`（API 即声明）；静态信息（标题/图标）取声明、动态信息（角标/状态/进度）取 views.update 载荷可选 meta，托盘按钮渲染单一兜底链 = 声明 title ?? meta.title ?? viewId

## 模型路由域（provider-aggregation，2026-11）
> 机制纪律：领域规则的实现单点分两侧——配置权威读写单点在 runtime（providers.json 顶层 routes 键，`packages/runtime/src/services/provider-extras-store.ts`，写侧唯一写点、复用既有文件锁与原子写）；条件求值纯函数单点在 pi 路由扩展（`extensions/universal/provider-aggregation/src/router.ts`，route 回调在 pi 会话进程）。runtime 目录注入器与 pi 侧注册器都是路由配置的派生视图，任一侧不得自行发明、修改或缓存路由条目语义。决策登记 [ADR-0192](adr/decisions.md)～[ADR-0195](adr/decisions.md)。

概念：**模型路由**（aggregation model）= 把若干已配置 provider 的指定模型登记为一个路由条目，作为一个普通模型出现在模型选择器与会话绑定链中；**端点**（member）= 路由条目内引用的一个 provider+模型渠道（可带条件）；**路由规则** = 端点有序条件求值——mode 为 schema 必填持久化路由字段（simple=依次兜底/advanced=按条件分流，D12；原「模式由数据推导」条款已随实装废除），初始默认 advanced、可随时切换且条件保留；simple 模式跳过全部条件判断（直接取第一个端点），重试排除作为选择层排除仍先行生效（上一失败端点先排除、再取兜底端点）；advanced 模式逐端点求值取第一个条件全满足者；切换不丢条件（simple 下条件不参与求值但保留显示）。条件求值是纯函数：同输入（路由配置 + 额度快照 + 墙钟 + 重试信号）必同输出；时间窗区间起点对齐半小时边界、本地时区语义；specialDates 覆盖周表（exclude 全天除外 / include 仅指定区间判窗内）。

不变量（AX1-AX5，全部可核对，违反即缺陷）：

1. **权威分层**：模型可选性与顺序的权威 = providers.json 顶层 scopedModels 字段（现状字段与语义不动）；端点与条件的权威 = 同文件 routes 域；模型路由页 = runtime 对两者 join 计算的视图（非权威、非持久化），页面编辑分别落回各自权威；pi 进程目录注册与 runtime 目录注入都是路由配置的派生视图，任何一侧不得自行发明、修改或缓存路由条目语义
2. **一次请求恰好发往一个物理模型**：路由选择每请求现算，路由条目本身永不出现在出站请求上（pi 虚拟模型语义：虚拟条目到不了 provider）
3. **不新增持久化事实源**：求值输入只有路由配置（磁盘权威）与额度缓存（QuotaService 权威的落盘形态）；route 调用传入的 reason/failed 是调用参数，不构成持久 state 消费；路由决策不建存储
4. **聚合层零凭据零协议复制**：端点出站走其 provider 的既有通道（models.json/auth.json 凭据 + 既有协议实现），路由条目自身零凭据零 baseUrl
5. **错误呈现分层**：路由层（无候选端点）显式失败并逐端点列明求值输入可知的落选原因（时间窗外 / 额度低于阈值），不做静默猜测；端点供给侧失败（凭据失效、额度硬耗尽）不在求值输入内，由出站层 pi 错误透传并经 runtime 结构化呈现（映射恢复指引）；provider 已删 / 模型已移除属配置层悬空端点——route 须返回已注册物理模型（pi 契约），求值期闭包解析层按不可解析落选该候选、不发出站请求，全部候选不可解析时结构化错误带恢复指引

配置域补充语义：routes 段 schema 字段只加不改（演进契约：M1 schema 预留额度条件字段、M2 只接线不迁移、M3 零迁移）；路由 id 是 set_model、会话还原、目录注入三处的对齐键（保存校验唯一性与字符集）；读取侧产出两类标记——端点悬空标记（引用的 provider 已删 / 模型已移除：允许保留配置 + 提示，不丢用户数据）与 scopedModels 路由引用失效标记（解析不到 routes 定义的聚合 provider 复合串：读取侧标记不自动清理，删除路由时由保存编排精确移除该复合串）；配置损坏沿用 extras store 既有隔离语义（隔离坏文件 + 按空聚合继续 + 显式呈报坏文件路径；runtime 权威侧；扩展侧派生视图读失败保持上一有效注册继续路由——设计 RL4，aggregation-hot-reload.test 损坏隔离断言），不发明「保持上一有效配置」语义。
