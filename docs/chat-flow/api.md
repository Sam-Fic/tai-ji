# 交付物 API

## 命令

无新增用户命令。验收探针（随交付物入库，scripts/acceptance/）：`harness.mjs`（共用装配：开发实例启动、WS 建会话并订阅会话事件、CDP 挂载；切换模型、读历史接口、读会话文件、重载后重进会话）与 `tape-height.mjs` / `tape-look.mjs` / `motion-overflow.mjs` / `tape-think.mjs` / `tape-live.mjs` / `tape-scroll.mjs` / `tape-settle.mjs` / `msw-replay.mjs` / `msw-live.mjs` / `msw-mid.mjs` / `msw-icon.mjs`，统一 `node <脚本>` 运行，成功打印 `OK-*` 标记串并以 0 退出。

## 工具

不适用：不改 pi 工具面，不新增模型可见的工具/命令。

## 配置

- 用户配置：不新增。无开关、无默认值变更。
- 设计令牌（`packages/renderer/src/style.css` `:root`）：`--proc-tape-rows: 12`（窗口行数上限）、`--proc-tape-row-h: 24px`（单行高度）。过程卡的底色、圆角、字号与颜色取既有令牌（`--bg-input` / `--radius` / `--text-sm` / `--text-xs` / `--text-base` / `--neutral-*`），不新增令牌。
- 文案键（`packages/ui/src/locale/{zh-CN,en-US}/panel.ts` 的 `message` 组新增）：`procTapeEarlier`（更早 {count} 条）、`procTapeBelow`（下面还有 {count} 条）、`procTapeToTop`（回到开头）、`procThinkCount`（思考 {count}）、`runGroupExplore` / `runGroupEdit` / `runGroupExec`（探索 / 改动 / 执行命令，进行中活动 chip 的类型词）、`procChipThinking`（思考中）、`modelSwitchRow`（已切换模型）。键随消费它的枝入库：零引用的键由文案反向检查拒收。复用既有键：`scrollToBottom`（回到最新）、`thinkingBlock`（思考）、`runGroupSteps`（{count} 步）、`aggProcessLabel`（过程）、`aggGroupRunning`（进行中）、`traceFailed`（含 {count} 次失败）。

## 存储

不新增持久化格式。模型切换的持久事实 = pi 写在 session JSONL 的 `model_change` entry（唯一写方 = pi；本交付只读）。`modelSwitch` 只是对话流消息的展示字段，不落盘；旧会话回放按 `model_change` 派生，无格式演进与迁移代价（既有会话文件无需改写）。

## 挂点

| 挂点 | 位置 | 形态 |
|---|---|---|
| pi 扩展监听 | `extensions/taiji/host-internals/src/` | `pi.on('model_select', …)`（事件由 pi `setModel` 在模型真实变化时发出，携带 model / previousModel / source） |
| 扩展 → runtime 信号 | 同上 | `pi.sendMessage({ customType: 'taiji:model-select', display: false, details: { provider, modelId, previousProvider, previousModelId, source } }, { triggerTurn: false })`（沿用压缩落盘信号同款通道） |
| runtime 分诊 | `packages/runtime/src/services/session/event-interpreter.ts` | customType + details 双判据 → 广播 WS 帧 `message.modelSwitch`（带切换前模型；模型 id 为空不广播） |
| WS 帧契约 | `packages/shared/src/protocol.ts` | `'message.modelSwitch': { sessionId, provider?, modelId, previousProvider?, previousModelId?, timestamp }`。previous* 供前端在没有会话基线时补基线 |
| 前端合成 entry | `packages/core/src/domain/chat/effects/registry.ts` | 按帧构造合成 `model_change` entry（id `ms-<uuid>`）。切换行的派生依赖「上一生效模型」，不走「空 state 派生」的入流骨架：handler 经 `ctx.getLastModel`（`effect-types.ts`，实现在 `store.getLastModel`）读权威 state 的模型基线，缺且帧带切换前模型时先喂一条基线 entry；权威 state 与渲染列表用同一基线、同一 reducer 派生 |
| core 派生 | `packages/core/src/domain/chat/apply-entry.ts` | `model_change` case：会话首条记录只记基线；与上一生效模型相同的记录不出行；真实变化 → `modelSwitch` 系统消息 |
| 历史回放 | `packages/runtime/src/infra/pi/session-entry-mapper.ts`、`message-converter.ts` | `mapSessionEntries` 把 pi 落盘的 `model_change` 映射成 wire 伪角色 `{ role: 'modelChange', provider, modelId, timestamp }`；`liftHistoryToEntries` 把它还原成专用 `model_change` entry（与实时合成的是同一种 entry） |
| 历史窗口的模型基线 | `packages/runtime/src/services/session-history.ts` | `convertWindowEntries(entries, store, segments?, orphans?, windowSource?)`：`windowSource = { filePath, endOffset? }`。窗口不含文件头且含 `model_change` 时，以窗口起点处的生效模型前插一条基线伪消息（不产消息，只让 reducer 有上一模型可比）；其余情况不读文件 |
| 窗口基线查找 | `packages/runtime/src/infra/pi/session-model-tail-read.ts` | `findModelChangeBaselineBefore(filePath, fromParentId, endOffset?)`：读 `[0, endOffset)` 建 id → 父节点映射，从 `fromParentId`（窗口第一条 entry 的真实父亲）沿父链回溯，取链上最近一条 `model_change`。被撤子树里的记录不在链上。文件不变且起点不变时命中进程内缓存（上限 16 条） |
| 逆读终点 | `packages/runtime/src/utils/history-reverse-read.ts` | `forEachReversedLineChunk(filePath, { endOffset }, visit)`：只向前读 `[0, endOffset)`；endOffset 须落在行首 |
| 回合归属 | `packages/core/src/domain/chat/message-turns.ts` | `modelSwitch` 消息：回合打开时插入该回合的回合内通知位（按分组时点的 assistant 序锚排入 trace，不比较时间戳）；无打开回合时作为回合间的静态分隔行 |
| UI 渲染 | `packages/ui/src/features/chat/` | 切换行渲染进 SystemNotice 横线分隔行族（box 图标）；过程卡 = `ProcessAggregateBlock` → `AggregateTape`（卡片：`AggregateSummaryRow` 卡头 + 窗口；右侧 `AggregateActivityChip` 活动计时与滚动提示；窗口内 `AggregateExpandedBody` 逐行平铺 `SegmentThinkingRow` / `SegmentToolRow`） |
