/**
 * Workflow DAG 缺省分区名单源常量（workflow-visualization §3.1-3 u2 协议冻结段的
 * 运行时常量）：未标注 phase 的调用点在 DAG 静态蓝图中归入的分区名。
 *
 * 为什么独立成 subpath 纯常量模块（session-store-paths 先例）：消费方两侧跨包——
 * 解析器产出侧（subagent-core workflow-dag-parser，npm 发布包，只允许经本 subpath
 * 消费，import 包根 barrel 会把 private 包整体拖进发布闭包）与展示层消费侧
 * （renderer dag/layout 的空缺省分区消隐判据，经包根 barrel 重导出）。单源冻结
 * 消除双侧手抄副本：解析器侧改名经 import 编译期直接传播到 renderer 消隐判据，
 * 不再依赖任何跨侧字面量对账。本模块零 import、零 env 读写，bundle 内联无副作用。
 */
export const WORKFLOW_DAG_DEFAULT_PHASE = 'default'
