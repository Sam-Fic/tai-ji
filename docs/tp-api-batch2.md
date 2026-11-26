# API 文档 · 批2（交付物自身对外接口）

本批为渲染层性能/正确性改造，不新增命令/工具/配置/存储。对外表面 = 被改动的组件 props 契约与 composable 行为契约（「挂点」）。命令/工具/配置/存储不适用：理由见各节。

## 命令

不适用：本批无新增 CLI / slash 命令。

## 工具

不适用：本批无新增 agent 工具。

## 配置

不适用：本批无新增配置键。`--message-stream-pad-top`（30px）为既有 CSS 变量，本批经实测 headOffset 消费而非硬编码，不改其值。

## 存储

不适用：本批不触及任何持久化存储 / session 数据布局。

## 挂点

被改动契约（消费方零感知的除外，均标注）：

| 挂点 | 契约变化 | 依据 | 兼容性 |
|---|---|---|---|
| `UserBubble` props | `turn: MessageTurn` → `user: Message`（非空）+ 保留 `sessionId`/`canEdit`/`isSessionEditable` | packages/ui/src/features/chat/UserBubble.vue | 唯一消费方 = Turn.vue；同步改 Turn.vue 传参 |
| `TurnSummary` props | `turn`+`lastAssistant` → `lastAssistantId: string\|null` + `isStreaming: boolean` + `sessionId` + `resolveLastAssistant: () => Message\|null` | packages/ui/src/features/chat/TurnSummary.vue | 唯一消费方 = Turn.vue；同步改 Turn.vue 传参 |
| `Turn` props | **不变**（仍收 `turn: MessageTurn`）——仅改其向 UserBubble/TurnSummary 的下传 | packages/ui/src/features/chat/Turn.vue | ChatView.vue / MessageStream.vue 消费方零改动 |
| `useMessageStreamFollowTriggers` 返回 | 新增 `headOffset: Ref<number>`（padTop spacer 实测高，onMounted 一次缓存）；endOffset 消费方改 `tailHeight + headOffset` | packages/renderer/src/composables/panel/useMessageStreamFollowTriggers.ts | MessageStream.vue 同步接线；既有 tailHeight 语义不变 |
| `EdgeFade` 内部行为 | `on` 由 scroll+scrollTop 读改为 IntersectionObserver 哨兵；删除 scroll 监听；mask 串按 on 翻转套常量 | packages/renderer/src/components/ui/edge-fade/EdgeFade.vue | 自包含组件，消费方（MessageStream `<EdgeFade/>`）零配置零改动；新增一个绝对定位哨兵 DOM 节点（无流内占位） |
| wrap RO 回调 | contentWrapEl 不在 entries 时以 `prevWrapHeight` 快照兜底，替代 `offsetHeight` 同步读 | packages/renderer/src/composables/panel/useMessageStreamFollowTriggers.ts | 纯内部，无对外契约变化 |
