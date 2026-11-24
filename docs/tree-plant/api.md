# 交付物 API

## 命令

无新增用户命令。验收探针（随交付物入库，scripts/acceptance/）：`tape-height.mjs` / `tape-scroll.mjs` / `tape-chip.mjs` / `tape-settle.mjs` / `tape-detail.mjs` / `tape-think.mjs` / `msw-replay.mjs` / `msw-equivalence.mjs` / `msw-live.mjs` / `msw-mid.mjs` / `msw-icon.mjs`，统一 `node <脚本>` 运行，成功打印 `OK-*` 标记串并以 0 退出。

## 工具

不适用：不改 pi 工具面，不新增模型可见的工具/命令。

## 配置

- 用户配置：不新增。无开关、无默认值变更。
- 设计令牌（`packages/renderer/src/style.css` `:root` 新增）：`--proc-tape-rows: 12`（窗口行数上限）、`--proc-tape-row-h: 24px`（单行高度）。值真值在 style.css，`docs/DESIGN.md` 不声明颜色/圆角即不触发 token 挂值检查。
- 文案键（`packages/ui/src/locale/{zh-CN,en-US}/panel.ts` 的 `message` 组新增）：`procTapeEarlier`（更早 {count} 条）、`procTapeBelow`（下面还有 {count} 条）、`modelSwitchRow`（已切换模型）。复用既有键：`scrollToBottom`（回到最新）、`thinkingBlock`（思考）、`runGroupExec`（执行命令）、`aggProcessLabel`（过程）、`aggGroupRunning`（进行中）。

## 存储

不新增持久化格式。模型切换的持久事实 = pi 写在 session JSONL 的 `model_change` entry（唯一写方 = pi；本交付只读）。`modelSwitch` 只是对话流消息的展示字段，不落盘；旧会话回放按 `model_change` 派生，无格式演进与迁移代价（既有会话文件无需改写）。

## 挂点

| 挂点 | 位置 | 形态 |
|---|---|---|
| pi 扩展监听 | `extensions/taiji/host-internals/src/` | `pi.on('model_select', …)`（事件由 pi `setModel` 在模型真实变化时发出，携带 model / previousModel / source） |
| 扩展 → runtime 信号 | 同上 | `pi.sendMessage({ customType: 'taiji:model-select', display: false, details: { provider, modelId, previousProvider, previousModelId, source } }, { triggerTurn: false })`（沿用压缩落盘信号同款通道） |
| runtime 分诊 | `packages/runtime/src/services/session/event-interpreter.ts` | customType + details 双判据 → 广播 WS 帧 `message.modelSwitch` |
| WS 帧契约 | `packages/shared/src/protocol.ts` | `'message.modelSwitch': { sessionId, provider, modelId, previousProvider, previousModelId, source?, timestamp }` |
| 前端合成 entry | `packages/core/src/domain/chat/effects/registry.ts` | 按帧构造合成 `model_change` entry（id `ms-<uuid>`，附 previous* 与 source），喂 reducer（compaction `cmp-<uuid>` 同式） |
| core 派生 | `packages/core/src/domain/chat/apply-entry.ts` | 新增 `model_change` case：与上一生效模型不同且上一模型存在 → `modelSwitch` 系统消息；否则不出行 |
| 回合归属 | `packages/core/src/domain/chat/message-turns.ts` | `modelSwitch` 消息：回合打开时插入该回合的回合内通知位（按时间排入 trace）；无打开回合时作为回合间的静态分隔行 |
| UI 渲染 | `packages/ui/src/features/chat/` | 切换行渲染进 SystemNotice 横线分隔行族（box 图标）；过程卡窗口渲染由 `ProcessAggregateBlock` 族承担 |
