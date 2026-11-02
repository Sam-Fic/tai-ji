# handoff 取消链无界悬挂（abortHandoff 直连出口治理）

状态：未治理（显式豁免运行中——停止升级窗射程不含此出口，pi-stall-detection D2① 消费方裁决 ⑤ / G2 注记；重审触发条件见下，任一命中即回头裁决是否扩射程。2026-11 登记）

## 现状

- 交接（handoff，把当前会话交接给新会话的编排）进行中用户取消：renderer → `session.abortHandoff` RPC → `HandoffService.abortHandoff`（packages/runtime/src/services/handoff-service.ts:359）→ `entry.srcClient.abort()`（:372）**直连** pi client.abort，不经 message-dispatcher 的 abort 唯一封装——停止升级链（abort 悬挂超窗自动升级强杀）不覆盖此出口，是 dispatcher.abort 消费方枚举中唯一直连出口。
- 悬挂形态：pi 事件循环挂死时取消永不返回——handingOff 占用维不复位、停止无回执、无自动强杀；`abortHandoff` 的 catch 只覆盖显式失败（「pi 进程可能已退出，abort 失败不应阻塞」），不覆盖悬挂形态。
- 量级（豁免代价要素，pi-stall-detection review-impact#5 登记）：射程仅 handoff 取消链一条路径；触发频率无现成遥测，不臆测。

## 重审触发条件（pi-stall-detection D2① 裁决 ⑤，任一命中即回头裁决）

1. 交接域纳入停止/判死同型机制改造（scope 变化）
2. 生产出现经该出口的悬挂事故——判定锚 = [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md)「会话停滞判定与恢复」条目的 handoff 取消链小节命中

## 手动恢复（出口未治理期间）

- 侧栏右键强制退出该会话（走 forceQuitSession 强杀编排，不经挂死的 abort 通道），或重启应用（runtime 退出连带回收 pi 进程）

## 权威登记

- 豁免裁决：pi-stall-detection 设计 G2 注记 + D2① 消费方裁决 ⑤（工作流过程产物，库外 git 外；登记内容以本文件与 TROUBLESHOOTING 条目为准）
- 排障指引：docs/TROUBLESHOOTING.md「会话停滞判定与恢复」条目
