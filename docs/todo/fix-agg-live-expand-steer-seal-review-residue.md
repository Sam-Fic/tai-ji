# dev-merge 审查残余登记（fix-agg-live-expand-steer-seal）

> 来源：dev-merge-gates branch-review 2 轮收敛后的 minor 残余（不阻塞合并，随分支带走，终局 PR 期复核）。
> run 产物目录：`~/.agents/skill-data/dev-merge/fix-agg-live-expand-steer-seal-444ac37b/dmg-c54191745/`。

## 问题登记 1（dmg-r2-1，minor）

「帧到达后 pi 在同一同步续体内完成落盘」子断言的锚点链缺 session-manager 落盘层——pi 升级把写入改异步缓冲时无机器信号报警。

- 文件：`packages/core/src/domain/chat/streaming-state-machine.ts`（sealStreamingAssistants 边界事实注释）
- 为什么不修：断言本身成立（当前 pi 版本同步写），补齐锚点链需要核 pi session-manager 落盘实装并把锚点延伸过去；属注释精度增强，非行为缺陷。
- 复核触发：pi 升级（尤其写入路径改动）或终局 PR 期。

## 问题登记 2（dmg-r2-2，minor）

`block-icon.ts` SSOT 注释「唯一副本/一律」全称断言与 renderer 层两处既有登记手抄副本的磁盘事实矛盾。

- 文件：`packages/ui/src/features/chat/block-icon.ts`
- 为什么不修：手抄副本是本次改动之前的存量（非本分支引入），改注释措辞即可消歧，等该文件下次触碰时顺手处理（对齐审查建议「随下批触碰顺手改」口径）。

## 披露（non-evidence，降级不修）

聚合裁决披露：streaming-state-machine.ts 注释引用 pi dist 锚点「:734-735」行号差一行（实际发射对 :735-736，:734 为注释行）。被引用断言（先发射后落盘）三维核实成立、区间引用 :734-750 覆盖完整，属注释引用精度问题；两个来源维度均判 INFO 不计缺陷。已由聚合器亲读 dist 收敛勘误（仅 :619-620 一处含该子句）。
