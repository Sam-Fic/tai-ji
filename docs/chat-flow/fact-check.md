# 事实核查

## 论据三分类

| 编号 | 论据 | 分类 | 证据 | 说明 |
|---|---|---|---|---|
| F1 | pi `setModel` 落 `model_change` entry，并且只在模型真实变化时向扩展发 `model_select`（携带 next/previous/source） | 事实 | node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1917; node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1898; node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:851 | 仓库内安装副本（1.0.0）实读；`model_select` 走扩展 runner |
| F2 | RPC 客户端事件面 = AgentSessionEvent 联合，不含 `model_select` | 事实 | packages/runtime/src/infra/pi/pi-protocol.ts:848 | runtime 镜像事件清单 21 项无该事件；drift guard 同文件 |
| F3 | runtime 自发起切换的成功分支在覆写前持有旧模型（`session.modelId`） | 事实 | packages/runtime/src/services/session/session-model-control.ts:267 | 覆写发生在 `client.setModel` 成功之后 |
| F4 | 压缩摘要的实时合成范式：runtime 广播 `message.compactionSummary` 帧 | 事实 | packages/runtime/src/services/session/event-interpreter-compaction.ts:157; packages/shared/src/protocol.ts:3200 | |
| F5 | 前端 effects 层把帧合成 entry（`cmp-<uuid>`）再喂 reducer | 事实 | packages/core/src/domain/chat/effects/registry.ts:789 | |
| F6 | reducer 的 `model_change` case：会话首条记录只记基线、与上一生效模型相同的记录不出行、真实变化出一条 system 行 | 事实 | packages/core/src/domain/chat/apply-entry.ts:739 | 核实时（2026-11-24）为 default no-op，msw-replay 枝实现 |
| F7 | compaction 派生范式：entry case + derive 纯函数 | 事实 | packages/core/src/domain/chat/apply-entry.ts:680; packages/core/src/domain/chat/apply-entry.ts:503 | |
| F8 | message-turns 规则 6：其余可见 system → 回合边界（关闭当前 turn） | 事实 | packages/core/src/domain/chat/message-turns.ts:556 | 回合内插入需要新通知位 |
| F9 | 扩展已有监听 `model_select` 的先例 | 事实 | extensions/universal/smart-context/src/index.ts:418; extensions/universal/subagent-workflow/src/model-events.ts:21 | |
| F10 | 扩展 → runtime 的可用通道 = `pi.sendMessage` custom message → runtime 分诊 | 事实 | extensions/universal/smart-context/src/notices.ts:228; packages/runtime/src/services/session/event-interpreter.ts:1325 | 压缩落盘信号同款 |
| F11 | host-internals 是 pi 侧基础设施扩展的装配点（registerHostCommands 等） | 事实 | extensions/taiji/host-internals/src/index.ts:8 | |
| F12 | 过程卡容器 = ProcessAggregateBlock（卡头 + 12 行窗口由 AggregateTape 承载） | 事实 | packages/ui/src/features/chat/ProcessAggregateBlock.vue:22 | |
| F13 | 工具输出的行内展开已按 D4 退役，详情 = 右侧抽屉 | 事实 | packages/ui/src/features/chat/process-aggregate/SegmentToolRow.vue:11 | 本次不推翻 D4 |
| F14 | 轮头耗时已有 1 秒 tick + 页面隐藏停表范式 | 事实 | packages/ui/src/features/chat/composables/useTurnElapsed.ts:109 | 卡头计时沿用同式 |
| F15 | i18n 落点 = ui 两个 panel.ts；已有键：回到最新/思考/执行命令/过程/进行中 | 事实 | packages/ui/src/locale/zh-CN/panel.ts:182; packages/ui/src/locale/zh-CN/panel.ts:123; packages/ui/src/locale/zh-CN/panel.ts:210; packages/ui/src/locale/zh-CN/panel.ts:216 | en 侧同组 |
| F16 | 过程卡测试范式 = fixture 驱动 mount | 事实 | packages/ui/src/features/chat/__tests__/process-aggregate-block.test.ts:1 | |
| F17 | faux 扩展注册四个模型（真机可切模型） | 事实 | packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts:153 | faux-1 / faux-1-reasoning / faux-1-b / faux-1-c |
| F18 | testCommand 收窄到 ui/core 的 chat 子集（域全量 227 文件超 300s 门禁超时） | 事实 | .tree-plant.json:2 | |
| F19 | 执行中的 bash 输出经 runtime `message.tool_call_update`（载荷 output / outputRaw，尾窗 8KB）送到前端并回填 `ToolCall.output` | 事实 | packages/runtime/src/infra/pi/event-adapter.ts:1402; packages/core/src/domain/chat/effects/registry.ts:698 | 执行中命令行尾输出的数据源 |
| F20 | 带位移的入场动效会临时增大滚动容器的内容高度；只用透明度的动效不改变它（离线最小页实测） | 事实 | scripts/acceptance/motion-overflow.mjs:1 | 探针即证据（AC-MOTION） |
| F21 | 轮头进行中变暗 = 按钮基类的禁用态半透明叠加「进行中禁用折叠」；Button 经类合并，外部同变体类可覆盖 | 事实 | packages/ui/src/primitives/button/button-variants.ts:15; packages/ui/src/features/chat/TurnMeta.vue:42; packages/ui/src/primitives/button/Button.vue:24 | 覆盖后禁用行为不变 |
| F22 | 工具类型表：exec = bash、explore = read/grep/find/ls、edit = edit/write（命令行形态的判定源），经 chat barrel 导出 | 事实 | packages/core/src/domain/chat/trace-window.ts:119; packages/core/src/domain/chat/index.ts:66 | |
| F23 | 耗时格式化入口 formatDuration（行内历史耗时与卡头计时共用） | 事实 | packages/ui/src/features/chat/format-utils.ts:58 | |
| F24 | 窗口挂载首帧，流式中的思考行高度处于过渡态（逐帧记录：首帧内容 42px / 可视 25px），窗口被量成未贴底；把这次测量当作用户滚动即会停吸，之后内容恢复贴底（46/46、21/21）却没有事件再触发测量，「回到最新」残留 | 事实 | scripts/acceptance/tape-scroll.mjs:1 | 真机逐帧记录（AC-LIVE 据此断言） |
| I2 | 回合内切换行与 trace 单元的交错位置可由分组时点推导（不依赖时间戳比较） | 事实 | packages/core/src/domain/chat/message-turns.ts:216; packages/ui/src/features/chat/composables/use-turn-trace.ts:60 | 实现期修正：原判「block 时间戳与 notice 时间戳可比」被真机否证——回放侧 assistant 消息用 pi 消息体 timestamp（会话级常量）、切换行用 entry timestamp，两钟不同源（F31），跨钟比较把行排到新模型正文之后（AC-MSW-MID 探针重载段红）。插入改按序锚：规则 4c 附着时点记录「组内已有 assistant 数」（switchAfter），渲染层插在第 N 条 assistant 的块之后，实时与回放按同一数组序推导同一锚 |
| I3 | 每张过程卡各持一个 1 秒 interval 可接受 | 推断 | packages/ui/src/features/chat/composables/useTurnElapsed.ts:109 | 同屏卡数有上限时成立；超出则共享单 tick |
| I4 | 模型切换行的中英文案无需新增 locale 目录（只改 ui 两文件） | 推断 | packages/ui/src/locale/zh-CN/panel.ts:108 | renderer locales 无 chat 域；需实现期跑同步脚本核实 |
| I6 | 工具步的计时起点（`ToolCall.startTime`）早于实际开始执行，行内耗时与卡头活动计时因此偏大；进行中轮头计时与窗口内各步耗时之和对不上与此同源 | 推断 | packages/runtime/src/services/session/event-interpreter.ts:630 | 真机探针实测：命令刚开始执行，卡头活动计时已显示 23s；用户实例里瞬时完成的 ls 显示 5–6s。起点取自哪一事件未核实，显式不做 |
| F25 | pi 新建会话时落一条 `model_change` 记录初始模型，这一步不发 `model_select`；`setModel` 无条件落 `model_change`，仅模型真实变化时发 `model_select` | 事实 | node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:285; node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1895 | 仓库内安装副本（1.0.0）实读；本机数据目录 690 个 pi 会话文件全部在第 2 行有这条记录（2026-11-27 统计）。所以「会话首条记录不出行」是对的；实时侧收不到它，新会话的第一次切换要靠帧携带的切换前模型补基线 |
| F26 | 对话流历史默认按索引窗口读：最近 20 个回合、640KB。窗口含第一个回合时从文件头读，否则从窗口第一个回合的行首读——文件头那条初始记录不在窗口里 | 事实 | packages/runtime/src/services/session/history-reader.ts:189; packages/shared/src/constants.ts:458 | 真机：25 回合的会话，历史接口返回 loadedTurns 20、truncated true（AC-MSW-REPLAY）。超过 20 回合的会话里切换过模型，重开后切换行曾因此消失 |
| F27 | 前端实时渲染列表与权威 reducer state 是两份；合成的 entry 经 `applyEntryFrameWithOverlay` 入流，该骨架在空 state 上派生本条消息，适用前提是「派生不依赖前置 state」 | 事实 | packages/core/src/domain/chat/effects/entry-overlay.ts:18 | 切换行的派生依赖「上一生效模型」，走该骨架恒不出行（真机：切换后界面上没有行）。handler 改为经 `ctx.getLastModel` 取权威基线，权威与渲染用同一基线派生 |
| F28 | runtime 历史链路把 message / compaction / branch_summary / custom_message 映射成伪消息，custom 进数据侧，其余记录类型跳过；`model_change` 核实时被跳过 | 事实 | packages/runtime/src/infra/pi/session-entry-mapper.ts:239; packages/runtime/src/infra/pi/entry-tree-builder.ts:222 | 压缩、分支记录曾因同一原因在重开后消失（同处注释）。msw-replay 枝补上 `model_change` → wire 伪角色 `modelChange`，lift 时还原成专用 entry |
| F29 | pi 写的记录 id / parentId 在行首附近，扩展写的 custom 记录 id / parentId 在行尾，且父链会经过 custom 记录 | 事实 | node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:828; node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:902 | 仓库内安装副本（1.0.0）实读：appendMessage 的键序 type / id / parentId / timestamp / message，appendCustomEntry 的键序 type / customType / data / id / parentId / timestamp。真机探针保留的会话文件里窗口第一条的父亲是 custom 记录；本机数据目录前 60 个会话文件的顶层键序统计同此（2026-11-27）。找窗口基线要逐行解析取顶层字段，按位置匹配不可靠 |
| F30 | 隐藏的模型切换信号消息在回放侧不出行：切换行只由 `model_change` 记录派生 | 事实 | scripts/acceptance/msw-replay.mjs:1 | 探针里每次切换都伴随扩展发出的隐藏信号消息落盘，重载后切换行条数与真实切换次数一致（AC-MSW-DEDUPE）；原 I1 由此升级为事实 |
| F31 | pi assistant 消息体 timestamp 与 entry timestamp 不同源：同回合两条 assistant 的消息体 timestamp 逐毫秒相同且早于 user 消息体 timestamp，entry timestamp 才按 append 时序递增（≈ 消息产出结束） | 事实 | scripts/acceptance/msw-mid.mjs:1 | AC-MSW-MID 探针保留的会话文件实测（2026-11-28）：a1/a2 消息体 timestamp 均为 16:33:49.422Z（会话起步常量，早于 user 的 16:34:12.051Z），entry timestamp 分别为 16:34:12.302Z / 16:34:16.576Z。回放侧 user/assistant 的 Message.timestamp 优先取消息体（core dispatchMessageEntry 的 fallbackTs 只在缺失时用），切换行取 entry 时间——两钟不可比，序列锚替代时间戳比较（I2） |
| I7 | 窗口基线查找的代价：窗口含切换记录且不含文件头时读一遍窗口之前的文件并逐行解析，10MB 量级约百毫秒、同步阻塞 runtime；文件与窗口起点不变时命中进程内缓存 | 推断 | packages/runtime/src/infra/pi/session-model-tail-read.ts:77 | 量级是估计，未实测；触发面 = 超过 20 回合且最近切换过模型的会话 |

## 外部接口核实表

| 接口 | 形态 | 依据 | case |
|---|---|---|---|
| pi 扩展事件面：`model_select` | `pi.on('model_select', (event, ctx) => …)`，event = { model, previousModel, source } | extensions/universal/smart-context/src/index.ts:418 | AC-MSW-LIVE |
| pi 扩展发消息：`pi.sendMessage` | customType + display:false + details + triggerTurn:false | extensions/universal/smart-context/src/notices.ts:228 | AC-MSW-LIVE |
| pi RPC 事件面 | 不转发 `model_select`；`model_change` append 无事件 | packages/runtime/src/infra/pi/pi-protocol.ts:848 | AC-MSW-LIVE |
| runtime WS 帧 | `type: 'message.compactionSummary'` 范式；新增 `message.modelSwitch` | packages/runtime/src/services/session/event-interpreter-compaction.ts:157; packages/shared/src/protocol.ts:3200 | AC-MSW-LIVE |
| 前端合成 entry | 构造 entry（id `ms-<uuid>`）→ 读权威基线（`ctx.getLastModel`）→ 缺则用帧的切换前模型先补一条基线 entry → 权威与渲染用同一基线、同一 reducer 派生 | packages/core/src/domain/chat/effects/registry.ts:783; packages/core/src/domain/chat/effect-types.ts:86; packages/core/src/domain/chat/effects/entry-overlay.ts:18 | AC-MSW-LIVE |
| reducer entry 契约 | `model_change` = { type, id, parentId, timestamp, provider, modelId } | node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:851; packages/core/src/domain/chat/apply-entry.ts:739 | AC-MSW-REPLAY |
| 记录映射与还原 | `mapSessionEntries`：`model_change` → `{ role: 'modelChange', provider, modelId, timestamp }`；`liftHistoryToEntries`：伪角色 → 专用 `model_change` entry | packages/runtime/src/infra/pi/session-entry-mapper.ts:239; packages/runtime/src/infra/pi/message-converter.ts:72 | AC-MSW-REPLAY |
| 历史窗口转换 | `convertWindowEntries(entries, store, segments?, orphans?, windowSource?)`：窗口不含文件头且含 `model_change` 时前插一条基线伪消息 | packages/runtime/src/services/session-history.ts:464; packages/runtime/src/services/session-history.ts:504 | AC-MSW-REPLAY |
| 窗口基线查找 | `findModelChangeBaselineBefore(filePath, fromParentId, endOffset?)`：从窗口第一条的父亲沿 parentId 回溯，取链上最近一条 `model_change`（被撤子树的记录不在链上） | packages/runtime/src/infra/pi/session-model-tail-read.ts:77 | AC-MSW-REPLAY |
| 逆读终点 | `forEachReversedLineChunk(filePath, { endOffset }, visit)`：只向前读 `[0, endOffset)` | packages/runtime/src/utils/history-reverse-read.ts:46 | AC-MSW-REPLAY |
| 历史窗口大小 | 索引窗口：最近 `HISTORY_BUDGET.RECENT_TURNS`（20）个回合；窗口含第一个回合时从文件头读 | packages/shared/src/constants.ts:458; packages/runtime/src/services/session/history-reader.ts:189 | AC-MSW-REPLAY |
| 回合归属 | 规则 4c：回合进行中切换行归当前回合 notices（`isMidTurnSwitch` 向后看下一条非透明消息是 assistant；连续切换行互跳；数组末尾窗口按 `isTurnGroupActive`——流式中 / running 工具 / user 锚待首回复读作进行中），回合之间切换独立静态分隔行 + 关闭回合 | packages/core/src/domain/chat/message-turns.ts:261; packages/core/src/domain/chat/message-turns.ts:273; packages/core/src/domain/chat/message-turns.ts:590 | AC-MSW-MID |
| 切换行 trace 插入 | `TraceUnit` 第三型 `notice`：`buildTraceUnits` 按序锚交错——锚 = 规则 4c 附着时点组内 assistant 数（`MessageTurn.switchAfter`），行插在首个「所属 assistant 序号 ≥ 锚」的块之前，实时与回放同一数组序同一锚；折叠态正文收敛末位一条而切换单元保持原位恒显；单元 testid `turn-switch-notice` | packages/ui/src/features/chat/composables/use-turn-trace.ts:37; packages/ui/src/features/chat/composables/use-turn-trace.ts:60 | AC-MSW-MID |
| 切换行渲染分支 | `resolveNotice` 的 modelSwitch 分支：lucide Box 图标 + `t('panel.message.modelSwitchRow')` 主体短语 + 钉右 mono meta「前 → 后」模型 id（防御形态无前值时只显新模型） | packages/ui/src/features/chat/SystemNotice.vue:267; packages/ui/src/features/chat/SystemNotice.vue:270 | AC-MSW-ICON |
| 过程卡 props/段契约 | `segment` / `turnWorking` / `turnStreaming`；段含 members/units/counts/followedByText | packages/ui/src/features/chat/ProcessAggregateBlock.vue:32; packages/core/src/domain/chat/process-segment.ts:103 | AC-H12 |
| 详情抽屉 | `AggregateToolDetailDrawer`（dialog 壳、420px 右贴边、Esc/焦点归还） | packages/ui/src/features/chat/process-aggregate/AggregateToolDetailDrawer.vue:1 | AC-DETAIL |
| 计时 tick | `setInterval(1s)` + visibilitychange 停表/补算 | packages/ui/src/features/chat/composables/useTurnElapsed.ts:109 | AC-CHIP |
| 执行中的命令输出 | `ToolCall.output` 在 running 态流式回填（尾窗 8KB） | packages/runtime/src/infra/pi/event-adapter.ts:1402; packages/core/src/domain/chat/effects/registry.ts:698 | AC-RUN |
| 滚动窗口贴底判据 | `scrollHeight − clientHeight − scrollTop > 1` 即未贴底 | packages/ui/src/features/chat/composables/useProcessAggregate.ts:142 | AC-LIVE |
| 命令行形态判定 | `RUN_GROUP_TOOLS.exec` 类型表内的工具按命令行形态显示 | packages/core/src/domain/chat/trace-window.ts:119 | AC-LOOK |
| 轮头禁用态样式 | Button 基类 `disabled:opacity-50`，经 `cn` 合并可覆盖 | packages/ui/src/primitives/button/button-variants.ts:15; packages/ui/src/primitives/button/Button.vue:24 | AC-LOOK |
| i18n 双侧 | `packages/ui/src/locale/{zh-CN,en-US}/panel.ts` 的 `message` 组 | packages/ui/src/locale/zh-CN/panel.ts:108; packages/ui/src/locale/en-US/panel.ts:111 | AC-I18N |
| 页面可见性 | `document.hidden`（浏览器接口）：活动计时器页面不可见时停表、恢复可见补算；与会话 hidden 状态同名无关，登记进同名白名单 | packages/ui/src/features/chat/composables/useProcessAggregate.ts:309; scripts/check-session-hidden-surface.mjs:196 | AC-CHIP |
| 真机装配 | 开发实例（vite+electron+真 pi）+ faux 演员（四模型） | .agents/skills/verify-taiji/SKILL.md:29; packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts:153 | AC-H12 |
| 图标资源 | lucide `box` 字形可直接引用（@lucide/vue） | node_modules/@lucide/vue/dist/esm/icons/box.mjs | AC-MSW-ICON |

## 未核实风险

- I2：回合内通知与 trace 单元的时间可比性；若 block 缺 startTime（历史会话），通知退化为「回合末尾」位置并在报告中登记。
- I3：同屏过程卡数量上限；若实测超过 3 张卡，改为「单一 tick 广播」的共享计时器。
- I4：locale 目录是否只有 ui 两文件需要改；实现期跑 `check_i18n_locale_sync.py` 核实（AC-I18N 已覆盖）。
- I6：各步计时的起点偏早（命令刚开始执行，卡头活动计时已显示 23s；轮头计时与窗口内各步耗时之和对不上）。起点取自哪一事件未核实；修正要动工具调用时间戳的来源，不属本交付，已登记为显式不做。
- I7：窗口基线查找的性能代价：读入量受 READ_PRECHECK_MAX_BYTES（32MB）硬上限（对齐同文件惯例；修复前无上界，64.5MB 前缀同步阻塞 575-693ms，修复后有界实测约 200-290ms）。超上限的远古前缀读不全——链查不到基线 → undefined → 该会话重载后切换行缺失（极端大文件降级，触发面 = 头端切换记录距窗口起点超过 32MB）；就近切换记录（最近 32MB 内）不受影响。实测明显卡顿时改为在回合索引里带上模型基线。
- I8：切换行归属的末尾窗口双向一次性跳变（live 瞬时形态 → 设计终态的收敛，跳一次后不再变）：① 切换帧到达时回合既无后续消息也无活动信号 → 行落为回合之间静态分隔行，后续 assistant 到达后移入回合内部；② 流式中/工具中切（行先归回合内部）之后回合落成且始终无后续消息 → 行移出为回合之间的静态分隔行。两个方向的终态位置都由向后看判定给出（时序正确），跳变触发面 = 切换行处于数组末尾窗口期间发生状态变化，接受；出现明显困扰再收窄判定（如结合会话级活动信号入参）。
