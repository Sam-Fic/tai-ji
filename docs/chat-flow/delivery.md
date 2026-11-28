# 交付终态证明

- 终态：delivered
- root 基线 commit：ff2f0ea77fed1fb49c972d68f5278cafaea02221
- case 并发度：自适应，上限 3

## 实机 case 终态重跑（16 条，16 绿）

- ✓ AC-H12（trunk）exit=0
- ✓ AC-LOOK（tape-look）exit=0
- ✓ AC-MOTION（tape-look）exit=0
- ✓ AC-THINK（tape-think）exit=0
- ✓ AC-CHIP（tape-live）exit=0
- ✓ AC-RUN（tape-live）exit=0
- ✓ AC-LIVE（tape-scroll）exit=0
- ✓ AC-SETTLE（tape-settle）exit=0
- ✓ AC-DETAIL（tape-settle）exit=0
- ✓ AC-MSW-REPLAY（msw-replay）exit=0
- ✓ AC-MSW-DEDUPE（msw-replay）exit=0
- ✓ AC-MSW-LIVE（msw-live）exit=0
- ✓ AC-CORE-EQUIV（msw-live）exit=0
- ✓ AC-MSW-MID（msw-ui）exit=0
- ✓ AC-MSW-ICON（msw-ui）exit=0
- ✓ AC-I18N（i18n-final）exit=0

## 各枝范围核对（改动 ⊆ 声明清单）

- i18n-final：✓ 改动在声明清单内
- msw-live：✓ 改动在声明清单内
- msw-replay：✓ 改动在声明清单内
- msw-ui：✓ 改动在声明清单内
- tape-live：✓ 改动在声明清单内
- tape-look：✓ 改动在声明清单内
- tape-scroll：✓ 改动在声明清单内
- tape-settle：✓ 改动在声明清单内
- tape-think：✓ 改动在声明清单内

## 修剪发现摘要

- fixed 6 / refuted 2 / registered 4
- 不修 G1-1：跳变真实存在（core 复现脚本 8/8 + 真机取证），但终态位置时序正确且 live≡reload 不破；G1-4 修复后主流场景（流式中切）不再翻转，残留面收窄到 append 形态（工具执行中切 + 回合中止）
- 不修 G2-5：非实现缺陷（渲染时窗固有）；探针断言已加固为轮询式（probeDomStable 15s 内轮询到 ok 即过），护栏消除该不稳定面
- 不修 G3-1：文档与字段已就地修正：design.md 依据句改为真实事实（pi 事件携带 source 且转发器已拿到，不做是范围裁决——须帧加字段逐层透传）、shared 死字段删除并注明去向；无行为面可变异，登记交裁决确认
- 不修 G3-3：api.md 已同步序锚措辞（行为效果一致，属声明措辞滞后）；措辞级修正无行为面可变异，登记交裁决确认

## 编号对照

- G1-1 = card-03 的修剪发现：切换行归属随回合落成翻转（live 位置一次性跳变，终态由向后看判定给出、重载同形）
- G1-2 = card-03 的修剪发现：isMidTurnSwitch 把「不切断 turn」类可见消息（liveOnly 健康警告 / turn 内 bash 执行记录）判为回合已终：切换行翻出回合且后续 assistant 分裂成无 user 锚的自启回合
- G1-3 = card-02 的修剪发现：疑点：纯文本 streaming 中切模型的切换行出行形态不稳定（跑 1 行 15s 未出行、跑 2 static 形态，单次观察未定论）
- G1-4 = card-03 的修剪发现：live ≡ reload 在「流式中切」场景破裂：pi 对流式中的 assistant 要到 message_end 才落 entry，切换 entry 落盘序先于该 assistant（文件序 [u1, sw, a1]），live 帧序却为 [u1, a1, sw]——live 行落 static / 重载行在回合内（翻转探针修复前取证：阶段1 static、阶段4 in-turn）
- G2-1 = card-05 的修剪发现：会话 JSONL 被 FIFO 置换时 findModelChangeBaselineBefore 永久挂起（statSync 无 isFile 前置，openSync('r') 对 FIFO 阻塞）
- G2-2 = card-05 的修剪发现：会话文件路径被目录占位（EISDIR）时抛异常穿透逆读兜底，违反「不抛」承诺
- G2-3 = card-05 的修剪发现：基线回溯未传 maxTotalBytes（=MAX_SAFE_INTEGER）：64.5MB 前缀同步阻塞 575-693ms，偏离同文件 32MB 上限惯例
- G2-4 = card-06 的修剪发现：切换行 meta（前 → 后模型 id）无长度上界无截断声明：超长自定义 modelId 撑破行宽
- G2-5 = card-06 的修剪发现：疑点：AC-MSW-MID 重载腿断言撞异步 markdown 渲染空窗（首拍纯时钟、6s 自愈；修复前取证，修复后 HEAD 连续 2 次全绿）
- G3-1 = card-07 的修剪发现：Message.modelSwitch.source 是零写点死字段，且设计「显式不做：切换来源归属」的依据句（「pi model_select 不带来源信息」）与 pi 真实事件面矛盾（agent-session.js:1898-1904 emit {type,model,previousModel,source}）
- G3-2 = card-07 的修剪发现：Message.modelSwitch.provider / previousProvider 是写而不读字段（reducer 写入、全仓生产代码零消费）
- G3-3 = card-07 的修剪发现：api.md「回合归属」挂点行措辞滞后（「按时间排入 trace」vs 实现序锚、不比较时间戳）

## git status 快照（clean=true）

- 工作区清洁，无未提交/未忽略文件（本文件由终裁生成，入库提交见提交记录）

## 回溯核对与残余登记

- 门禁基线：本会话先合并 remote main（4f2d6331e），四文档按 skill 2.10.0 补齐（d05a4b7bf）后重跑 root 与全部枝门禁。tape 五枝与 msw-replay/msw-live 的枝提交早于本次合并，其枝记录为合并后重跑（基线 d05a4b7bf）；msw-ui/i18n-final 的枝记录基线为本轮各自提交。
- 跨枝修复：修剪发现 G1-4 的修复改动落在 registry.ts（msw-live 枝声明的文件），由 msw-ui 交付后的修剪轮驱动，宿主执行；各枝范围核对行已如实呈现。
- R4（定向复审登记，存量不扩权修复）：FIFO 占位挂起的暴露面不止本次修复的单点——readTailBytes（packages/runtime/src/infra/pi/jsonl.ts:134）、forEachReversedLineChunk 自身 openSync（三处消费方共因）、network-proxy-config.ts:319 无上界读，均系存量路径，待另行立项。
- 深评角色：.tree-plant.json 未配置 subagentRoles 映射，深评环节由宿主自任（协议合法形态）；修剪攻击由三个与宿主同档的 subagent 并行执行（三组 × 三份缺陷清单）。
- 工具缺口（环境侧，非本任务交付物）：tree-plant xvalidate 的网格污染快照对「symlink 指向目录」直接 readFileSync（EISDIR 崩溃）——worktree 的 .agents symlink 与 gitignored 运行时产物（apps/electron/.dev-electron、apps/electron/resources/pi 的子目录 symlink）都会触发；本次以「跑前临时挪开、跑后立即恢复」绕过，产物内容零改动。修复属 zsw-skills 仓库，待用户裁决。
- I6/I7 指向：工具步计时起点偏早（显式不做）与窗口基线 32MB 有界降级（头端基线距窗口起点超过 32MB 的会话重载后切换行缺失）见 fact-check.md 未核实风险节。
- 验收空白：纯文本流式中切的形态断言由 .run/g1-probe-flip.mjs 承载（修剪专用探针，不入库）；验收矩阵的 AC-MSW-MID 以工具执行中切为主形态。
