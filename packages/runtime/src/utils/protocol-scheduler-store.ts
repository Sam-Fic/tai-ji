/**
 * `@zhushanwen/extension-protocol/scheduler-store` 子出口的 runtime 侧统一入口
 * （纯 named re-export）。
 *
 * 形态同先例 utils/protocol-background-task.ts：protocol 子出口的 runtime 消费全部
 * 经本文件单点——scheduler 任务库分片的路径推导公式（`schedulerStoreFilePath`）是
 * 扩展侧（pi 进程内写方）与 taiji 侧（面板只读 + 删除级联清点）两侧必须构造性一致
 * 的同源单实现（data-source-registry.md #88），双实现会漂移；protocol 出口形态再调整
 * 时只动此处。
 *
 * 只 re-export 纯函数（路径推导，零 fs 副作用）——store.ts 的读写原语不进 runtime：
 * runtime 侧对分片只有「删」一个动作（session 删除级联清点，见 services/session/
 * scheduler-shard-purge.ts），读写在扩展侧与面板侧。
 */

export { schedulerStoreFilePath } from '@zhushanwen/extension-protocol/scheduler-store'
