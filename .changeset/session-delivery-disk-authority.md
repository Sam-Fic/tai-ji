---
"@zhushanwen/session-delivery": minor
---

投递终态语义变更：ack 现在磁盘先行——store.ack 写盘成功后才登记内存终态；写盘失败时内存保持未终态并抛/记 `DeliveryAckPersistError`（含 entryId、目标终态、恢复提示），不再出现「内存已终态、磁盘未终态」的分叉。confirmDelivered 失败返回 false（边沿重驱动即重试）、cancel 失败上抛（用户驱动 RPC 显式失败）、drain 失败逐条降级留痕。恢复与判重以磁盘为唯一权威；接受写盘失败期间的语义后果为 at-least-once（宁可恢复后可能重投，不做内存单方终态）。
