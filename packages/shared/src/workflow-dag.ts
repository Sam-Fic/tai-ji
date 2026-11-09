/**
 * Workflow DAG 跨侧运行时常量单源（workflow-visualization u2 协议冻结段的运行时
 * 常量集）：未标注 phase 的调用点归入的缺省分区名 WORKFLOW_DAG_DEFAULT_PHASE；
 * 模板名变量段合成标记 WORKFLOW_DAG_VAR_MARKER（解析器把 description 模板中的
 * 动态段折叠为 `${…}`，字面含 U+2026 省略号——产出侧合成、展示层剥段与标题
 * 分段共用同一标记）。
 *
 * 为什么独立成 subpath 纯常量模块（session-store-paths 先例）：消费方两侧跨包——
 * 解析器产出侧（subagent-core workflow-dag-parser，npm 发布包，只允许经本 subpath
 * 消费，import 包根 barrel 会把 private 包整体拖进发布闭包）与展示层消费侧
 * （renderer dag/layout 的空缺省分区消隐判据与调用点标题分段，经包根 barrel
 * 重导出）。单源冻结消除双侧手抄副本：任一侧改标记经 import 编译期直接传播到
 * 另一侧，不再依赖任何跨侧字面量对账。本模块零 import、零 env 读写，bundle
 * 内联无副作用。
 */
export const WORKFLOW_DAG_DEFAULT_PHASE = 'default'

/** 模板名变量段合成标记：解析器折叠 description 模板动态段的产物（字面 U+2026 省略号）。 */
export const WORKFLOW_DAG_VAR_MARKER = '${…}'
