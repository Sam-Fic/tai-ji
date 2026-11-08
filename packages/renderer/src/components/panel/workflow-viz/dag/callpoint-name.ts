/**
 * callpoint-name.ts —— 调用点显示名派生纯函数（2026-11-08 用户裁决：卡片标题不渲染
 * 占位符段，只渲染名称）。
 *
 * 输入 = 解析器产出的模板名（字面段 + `${…}` 变量段合成标记，或非静态整段 `*`），
 * 输出 = 调用点显示名：剥掉全部 `${…}` 段后拼接剩余静态段、折叠相邻重复分隔符、
 * 清理首尾分隔符。静态段拼接（而非仅取首段）保住同族变体的消歧——「诊断-f-r」与
 * 「诊断-i」是两个不同调用点，仅取首段会同为「诊断」撞名（demo W2 样本实证）。
 * 悬停 <title> 与匹配层（blueprint-match tier 2 的 matchPattern）仍消费完整模板名
 * ——显示名只影响卡片标题渲染，不进匹配协议。
 *
 * 兜底：静态段拼空（名字全动态，如整段 `${…}`）→ 原样返回模板名（保留 `${…}`
 * 标识「这是无静态名的动态调用点」）；通配 `*`（description 非静态）不含 `${…}`
 * 段，替换后原样返回，无需特判。
 */

/** 模板名变量段合成标记（u1 解析器折叠动态 description 段的产物，字面 U+2026 省略号）。 */
const VAR_MARKER = '${…}'
/** 名称分隔符（拼接后相邻游程折叠为首字符 + 首尾清理；覆盖连字符/下划线/点/斜杠/空格）。 */
const SEPARATOR_RUN_RE = /[-_./ ]+/g
/** 首尾分隔符清理。 */
const EDGE_SEPARATOR_RE = /^[-_./ ]+|[-_./ ]+$/g

/**
 * 调用点显示名：模板名剥 `${…}` 段 → 拼接静态段 → 相邻分隔符游程折叠为首字符 →
 * 清首尾。静态段拼空（全动态名）→ 原样返回模板名。
 *
 * 样本（demo W2 对账集）：`fan-out-${…}` → `fan-out`；`诊断-${…}-f${…}-r${…}` →
 * `诊断-f-r`；`诊断-${…}-i${…}` → `诊断-i`；`验收聚合-r${…}` → `验收聚合`；
 * `node-${…}` → `node`；`接替-${…}` → `接替`；`*` → `*`（原样）。
 */
export function callpointDisplayName(templateName: string): string {
  if (!templateName.includes(VAR_MARKER)) return templateName
  const displayName = templateName
    .split(VAR_MARKER)
    .join('')
    .replace(SEPARATOR_RUN_RE, (run) => run[0] ?? run)
    .replace(EDGE_SEPARATOR_RE, '')
  return displayName.length > 0 ? displayName : templateName
}
