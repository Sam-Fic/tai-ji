# 事实核查

## 论据三分类

| 编号 | 论据 | 分类 | 证据 | 说明 |
|---|---|---|---|---|
| F1 | pi `setModel` 落 `model_change` entry，并且只在模型真实变化时向扩展发 `model_select`（携带 next/previous/source） | 事实 | node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1917; node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1898; node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:851 | 仓库内安装副本（1.0.0）实读；`model_select` 走扩展 runner |
| F2 | RPC 客户端事件面 = AgentSessionEvent 联合，不含 `model_select` | 事实 | packages/runtime/src/infra/pi/pi-protocol.ts:848 | runtime 镜像事件清单 21 项无该事件；drift guard 同文件 |
| F3 | runtime 自发起切换的成功分支在覆写前持有旧模型（`session.modelId`） | 事实 | packages/runtime/src/services/session/session-model-control.ts:267 | 覆写发生在 `client.setModel` 成功之后 |
| F4 | 压缩摘要的实时合成范式：runtime 广播 `message.compactionSummary` 帧 | 事实 | packages/runtime/src/services/session/event-interpreter-compaction.ts:157; packages/shared/src/protocol.ts:3200 | |
| F5 | 前端 effects 层把帧合成 entry（`cmp-<uuid>`）再喂 reducer | 事实 | packages/core/src/domain/chat/effects/registry.ts:789 | |
| F6 | reducer 对 `model_change` entry 现为 default no-op | 事实 | packages/core/src/domain/chat/apply-entry.ts:709 | |
| F7 | compaction 派生范式：entry case + derive 纯函数 | 事实 | packages/core/src/domain/chat/apply-entry.ts:680; packages/core/src/domain/chat/apply-entry.ts:503 | |
| F8 | message-turns 规则 6：其余可见 system → 回合边界（关闭当前 turn） | 事实 | packages/core/src/domain/chat/message-turns.ts:556 | 回合内插入需要新通知位 |
| F9 | 扩展已有监听 `model_select` 的先例 | 事实 | extensions/universal/smart-context/src/index.ts:418; extensions/universal/subagent-workflow/src/model-events.ts:21 | |
| F10 | 扩展 → runtime 的可用通道 = `pi.sendMessage` custom message → runtime 分诊 | 事实 | extensions/universal/smart-context/src/notices.ts:228; packages/runtime/src/services/session/event-interpreter.ts:1325 | 压缩落盘信号同款 |
| F11 | host-internals 是 pi 侧基础设施扩展的装配点（registerHostCommands 等） | 事实 | extensions/taiji/host-internals/src/index.ts:8 | |
| F12 | 现行过程卡三态 = 摘要行 + 进行中双窗 + 展开平铺 | 事实 | packages/ui/src/features/chat/ProcessAggregateBlock.vue:24 | |
| F13 | 工具输出的行内展开已按 D4 退役，详情 = 右侧抽屉 | 事实 | packages/ui/src/features/chat/process-aggregate/SegmentToolRow.vue:11 | 本次不推翻 D4 |
| F14 | 轮头耗时已有 1 秒 tick + 页面隐藏停表范式 | 事实 | packages/ui/src/features/chat/composables/useTurnElapsed.ts:109 | 卡头计时沿用同式 |
| F15 | i18n 落点 = ui 两个 panel.ts；已有键：回到最新/思考/执行命令/过程/进行中 | 事实 | packages/ui/src/locale/zh-CN/panel.ts:182; packages/ui/src/locale/zh-CN/panel.ts:123; packages/ui/src/locale/zh-CN/panel.ts:210; packages/ui/src/locale/zh-CN/panel.ts:216 | en 侧同组 |
| F16 | 过程卡测试范式 = fixture 驱动 mount，现含「高度恒定」等 describe | 事实 | packages/ui/src/features/chat/__tests__/process-aggregate-block.test.ts:1 | 本次「长到 12 行再封顶」会改写该不变量 |
| F17 | faux 扩展注册四个模型（真机可切模型） | 事实 | packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts:153 | faux-1 / faux-1-reasoning / faux-1-b / faux-1-c |
| F18 | 域测试入口存在，chat+session-manager 基线全绿（227 文件） | 事实 | scripts/run-domain-tests.mjs:23 | 作为 testCommand |
| I1 | `pi.sendMessage({ display: false })` 的 custom_message entry 在回放侧不渲染 | 推断 | extensions/universal/smart-context/src/notices.ts:228 | 压缩信号同款；需核对 reducer 对 custom_message display 的过滤 |
| I2 | 回合内通知可按时间戳与 trace 单元混排（block 时间戳与 notice 时间戳可比） | 推断 | packages/ui/src/features/chat/composables/use-turn-trace.ts:101 | 需核对 block startTime 的来源与缺省 |
| I3 | 每张过程卡各持一个 1 秒 interval 可接受 | 推断 | packages/ui/src/features/chat/composables/useTurnElapsed.ts:109 | 同屏卡数有上限时成立；超出则共享单 tick |
| I4 | 模型切换行的中英文案无需新增 locale 目录（只改 ui 两文件） | 推断 | packages/ui/src/locale/zh-CN/panel.ts:108 | renderer locales 无 chat 域；需实现期跑同步脚本核实 |

## 外部接口核实表

| 接口 | 形态 | 依据 | case |
|---|---|---|---|
| pi 扩展事件面：`model_select` | `pi.on('model_select', (event, ctx) => …)`，event = { model, previousModel, source } | extensions/universal/smart-context/src/index.ts:418 | AC-MSW-LIVE |
| pi 扩展发消息：`pi.sendMessage` | customType + display:false + details + triggerTurn:false | extensions/universal/smart-context/src/notices.ts:228 | AC-MSW-LIVE |
| pi RPC 事件面 | 不转发 `model_select`；`model_change` append 无事件 | packages/runtime/src/infra/pi/pi-protocol.ts:848 | AC-MSW-LIVE |
| runtime WS 帧 | `type: 'message.compactionSummary'` 范式；新增 `message.modelSwitch` | packages/runtime/src/services/session/event-interpreter-compaction.ts:157; packages/shared/src/protocol.ts:3200 | AC-MSW-LIVE |
| 前端合成 entry | 构造 entry（id `cmp-<uuid>` 范式）→ `applyEntryFrameWithOverlay` | packages/core/src/domain/chat/effects/registry.ts:789 | AC-CORE-EQUIV |
| reducer entry 契约 | `model_change` = { type, id, parentId, timestamp, provider, modelId } | node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:851; packages/core/src/domain/chat/apply-entry.ts:709 | AC-MSW-REPLAY |
| 回合归属 | message-turns 规则 6（system → boundary） | packages/core/src/domain/chat/message-turns.ts:556 | AC-MSW-MID |
| 过程卡 props/段契约 | `segment` / `turnWorking` / `turnStreaming`；段含 members/units/counts/followedByText | packages/ui/src/features/chat/ProcessAggregateBlock.vue:40; packages/core/src/domain/chat/process-segment.ts:126 | AC-H12 |
| 详情抽屉 | `AggregateToolDetailDrawer`（dialog 壳、420px 右贴边、Esc/焦点归还） | packages/ui/src/features/chat/process-aggregate/AggregateToolDetailDrawer.vue:1 | AC-DETAIL |
| 计时 tick | `setInterval(1s)` + visibilitychange 停表/补算 | packages/ui/src/features/chat/composables/useTurnElapsed.ts:109 | AC-CHIP |
| i18n 双侧 | `packages/ui/src/locale/{zh-CN,en-US}/panel.ts` 的 `message` 组 | packages/ui/src/locale/zh-CN/panel.ts:108; packages/ui/src/locale/en-US/panel.ts:111 | AC-I18N |
| 真机装配 | 开发实例（vite+electron+真 pi）+ faux 演员（四模型） | .agents/skills/verify-taiji/SKILL.md:29; packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts:153 | AC-H12 |
| 图标资源 | lucide `box` 字形可直接引用（@lucide/vue） | node_modules/@lucide/vue/dist/esm/icons/box.mjs | AC-MSW-ICON |

## 未核实风险

- I1：`display:false` custom_message 在回放侧的可见性；若 reducer 会渲染它，需在合成侧用「无 UI 字段 + display 标记」两条都过滤（实现期核对 `apply-entry` 的 custom_message 分支，核对不过则在 design 增加过滤机制并重跑 root）。
- I2：回合内通知与 trace 单元的时间可比性；若 block 缺 startTime（历史会话），通知退化为「回合末尾」位置并在报告中登记。
- I3：同屏过程卡数量上限；若实测超过 3 张卡，改为「单一 tick 广播」的共享计时器。
- I4：locale 目录是否只有 ui 两文件需要改；实现期跑 `check_i18n_locale_sync.py` 核实（AC-I18N 已覆盖）。
