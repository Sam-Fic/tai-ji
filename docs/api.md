# 交付物 API：批1 派生归零

> 交付物 = 三个包的纯函数/memo 层改动 + 一处视图模型字段形态变化。无新增用户面向命令/工具/配置/存储/挂点；不适用的小节保留标题写理由。

## 1. 纯函数契约（@taiji/core · domain/chat）

### `truncate(text: string, maxChars: number): string`
- **行为**：截断到 maxChars 个 Unicode 码点（中文/emoji 均算 1），超出以 `…` 结尾。
- **本批变化**：`Array.from(text)` 全量码点化 → 字符串迭代器惰性迭代，满 `maxChars - ELLIPSIS.length` 码点即停。**输出与旧实现逐字等价**（含 maxChars ≤ 1 返回 `'…'` 的边界）。
- **不变量**：纯函数；无状态；代理对不被切断（码点级）。

### `stripMarkdown(text: string): string`
- **本批变化**：首条 fence 规则由「配对匹配 /```[\s\S]*?```/」改为「行级无条件剥离」（任意行首 ``` 整行删除，闭行同样删除）。
- **影响面**：仅 rail 摘要消费方（20 码点标签）。闭合代码块的输出与旧实现一致（旧实现在闭合后也是删 fence 行保留代码内容）；**未闭合 fence 的输出变化 = 本批的有意修复**（旧：fence 标记泄漏到摘要；新：已剥离）。
- **不变量**：纯函数；其余 18 条规则不变。
- **终态一致性边界（card-06 P6-2 实证）**：与旧实现的逐字一致**只在「fence 在行首」时成立**。`text ```lang more`（fence 在行中）等非行首 fence 形态下，旧实现的配对匹配不删、新实现也不删（一致）；但**仅由 ``` 构成的行**（`'```'` 单独一行、`''```'''` 嵌套形态）旧实现留下残余反引号、新实现整行删除——这是「无条件剥离」的必然差异，非缺陷。故 G5「rail 终态逐字一致」的准确表述是「行首 fence 形态下逐字一致」，已在 fact-check 登记。

### `summarizeTurnForRail / summarizeAssistantForRail(turn): string`
- 签名与返回形态不变；内部经上述两函数间接受益。

## 2. memo 契约（@taiji/ui · features/chat）

### `railMemoFor(turn: MessageTurn): RailTurnMemo`
- **本批变化**：内部新增「流式冻结」——当 turn 判定为 streaming、且现行四重守卫全过（**同 message id**、**同 64 字节前缀指纹** FREEZE_PREFIX、**块长 ≥ K=256**、摘要**已触顶** `isRailSummarySettled`）时，复用上次计算的 `agentSummary`。无 fence 闭合条件——`fenceOpen` 守卫已删除（append-only 下前 K 字符恒不变 ⇒ 该值是常量，会使 coding 主场景长响应整个 turn 永不冻结；未闭合 fence 标记由 stripMarkdown 行级无条件剥离结构性排除，见同文件 §1）。
  - `userSummary` / `failed` / `iconClass` **不冻结**，按 turn 现算（成本 O(结构化 content 块数 + 工具数)，不随 assistant 文本长度增长）。
- **正确性契约**：
  - 冻结仅在 streaming 态生效；streaming 结束（turn 引用末次变化）正常重算，终态值与旧实现一致；
  - 换消息 id / 前缀指纹变化立即使冻结失效；
  - 纯空白首块不会成为冻结锚点：冻结记录的 id 必须是 `summarizeAssistantForRailWithSource` 实际产出摘要的那个 message id（`sourceId`），在 **message 粒度**上排除「锚点指向空白块、摘要来自别块」的错绑；fallback 计数摘要（无文本块时按 thinking/toolCalls 计数）`sourceId` 为 null，永不被冻结；
  - 摘要必须已触顶（`isRailSummarySettled`——带省略号后缀），未触顶的空/短摘要其前 20 码点仍可能被后续 delta 改变，冻结它会把「尚未成形」的值钉住整个流式窗；
  - 缓存仍为 WeakMap<MessageTurn, …>（turn GC 自动回收，无新增缓存槽、无泄漏面）；冻结槽为模块级单槽，切 session 时由 `resetRailFreezeSlot()` 显式清空。
- **保证的边界（诚实声明）**：上述守卫保证的是「摘要前 20 码点由前 K 原始字符决定」这一**充分条件**，不是必要条件。跨 K 才闭合的 markdown 构造（`**…**` / `[a](b)` 的闭合符落在 K 之外）仍可能让冻结值残留标记，直到流结束才自愈——旧实现下一 delta 即更新，故这是本批引入的新鲜度回退，触发条件确定（非偶发）：消息以跨 K 未闭合的强调/链接开头。收窄它需要在 delta 粒度上验「闭合后摘要是否已变」（O(K)/delta），代价大于收益，本批不做（登记于 docs/fact-check.md R1）。
- **调用方无感**：`TurnRail.vue` / `useMessageStreamRail` 签名不变。

### `summarizeAssistantForRailWithSource(turn): { text: string; sourceId: string | null }`
- **本批新增**（@taiji/core · domain/chat）：`summarizeAssistantForRail` 的带来源形态。
- **行为**：与原函数同一选取规则（normalizeContent 后 trim 非空的首个 assistant 块）；额外返回产出摘要的 message id。无任何文本块时回落 thinking/toolCalls 计数摘要，此时 `sourceId` 为 null（计数摘要跨全部 assistants，无单一来源 message）。
- **存在理由**：冻结复用的对齐判据——只有摘要确实由锚点块产出时才可跨 delta 复用。

### `streamingRailAnchor(turn): { id, length, prefix } | null`
- **本批新增**（@taiji/core · domain/chat）：流式冻结锚点。O(块数 + K) 成本，不物化全文 `normalizeContent`。
- **选取规则**：首个 `text.length > 0` 的 assistant 文本块。注意这是**块级候选规则**，与 `summarizeAssistantForRailWithSource` 的规范化规则并非同一判据（纯空白首块会被本函数选中、却被摘要函数跳过）——故锚点只作候选，冻结复用另需 `sourceId` 与锚点 id 相等。

### `isRailSummarySettled(summary: string): boolean`
- **本批新增**（@taiji/core · domain/chat）：摘要是否已触顶（`endsWith('…')`）。
- **用途**：冻结门槛的第四道守卫——未触顶的空/短摘要其前 20 码点仍可能被后续 delta 改变，冻结它会把「尚未成形」的值钉住整个流式窗（实测：`'[](u)'×70` 前缀 → 流式期标签恒空，终态才出现正文）。

### `resetRailFreezeSlot(): void`
- **本批新增**（@taiji/ui · features/chat）：显式清空模块级冻结槽。幂等，无槽时零操作。
- **调用方**：`useMessageStreamRail` 在 sessionId 变化时调用（切 session 入口）。守卫（同 id + 同前缀指纹）已使跨 session 错用在结构上不可能（message id 全局唯一），本函数是让「槽只属于当前 session 的流式 turn」这一不变量可局部检验的显式化。

## 3. 视图模型契约（@taiji/frontend · message-stream）

### `StreamViewItem`（turn 项）
- **本批变化**：`preview: string` → `preview: () => string`（惰性 thunk）。
- **消费契约**：仅 `StreamItemBoundary` 的 broken/failed 占位行调用求值；正常渲染路径零调用。`StreamItemBoundary` 的求值自带 try/catch 降级——thunk 抛错时降级为空串（诊断文本可丢，兜底占位行不可丢）。
- **`canReuseView`**：turn 分派移除 preview 值比对（纯函数产物，同 turn 引用 ⇒ 同值），其余判定不变。
- **skillNotice 项 preview**：不变（小文本即时计算，仍是 `string`）。

## 4. 不适用的小节

- **命令/工具**：不适用——本批无新增 CLI/工具/registerTool。
- **配置**：不适用——无新增配置项（K=256 为模块级常量，随设计文档登记）。
- **存储/挂点**：不适用——无磁盘写入、无跨进程挂点、无协议帧变化（纯 renderer 侧派生优化，WS 载荷不变）。
