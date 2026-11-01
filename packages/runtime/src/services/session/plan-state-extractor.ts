/**
 * plan-state-extractor — plan 模式状态派生视图域（plan 模式重设计 D1④，照 subagent-extractor /
 * workflow-extractor 同族形态）。
 *
 * `scanPlanStateEntries(entries)` 是 plan 状态唯一派生函数，也是唯一读入口的数据源：
 * 实时（SessionRecords get_entries 拉取批）与冷启动（[U5 plan 冷路径归一 D6] 续读链扫描
 * 产出——buildProjection 首建 / 续读核对增量 / 异步续读 / 截断整建四挂点，见
 * session-records.ts）共用同一份代码——live ≡ reload 由「派生代码唯一 + 读路径归一」
 * 构造性保证（session-records.ts:64-79 同款「数据写路径唯一 = entry 扫描」不变量；
 * 独立全文读路径已随 D6 退役——getPlanState 不再独立解析文件，与 getSubagents/getWorkflows
 * 同走统一续读链）。
 *
 * 派生语义 = 读 session **活跃路径内最后一条**合法 plan-state entry（extension 侧
 * reconstructPlanState 的逆序取首同构——entry 顺序即时间顺序，每次状态迁移整体重写快照，
 * 无 per-key merge；[message-revoke U6d] 活跃路径裁剪 = G2 二分的未来状态随树路径，被撤
 * 子树的 plan-state entry 不进派生态——live（SessionRecords 全量重建传 leafId）/ 冷启
 * （续读链扫描产出直取，见下「冷启动裁剪边界」）三处同批，见 scanPlanStateEntries 注释）。
 *
 * 冷启动裁剪边界（[U5 D6] 实施期登记）：续读链扫描产出是行预过滤子集（对话行不进产出），
 * 活跃路径裁剪需要的全量 parent 链构造不出来——冷启动派生走 scanPlanStateEntries 缺省
 * 分支（不传 leafId = 全集逆序取首）。与非撤回形态的全文裁剪语义等价（plan entry 写入时
 * parentId=当时 leaf，非撤回下文件序末条 plan entry 恒在活跃链上）；pi branch 撤回（纯内存
 * leaf 指针、不落盘，pi 1.0.0 session-manager.js branch 实锚）后仅写对话/record 族条目、
 * 未再进 plan 模式即冷启动查看的形态，冷启动派生会短暂显示被撤残影——激活会话后 live
 * 全量轮（pi 内存 leafId）恒正确裁剪并经水位补帧修正。全文读形态在「撤回后无写入」形态
 * 同有残影（文件尾 leaf 链含被撤条目），本边界是续读产物子集下的收窄而非新增缺口。
 *
 * schema 兼容（D4）：entry data 无版本字段（版本号字段 + 迁移逻辑已被 D1 明文否决），新旧
 * schema 靠**字段级 optional 判存在**消解——skills/docs 逐字段检查透传，不做
 * v 检查（与 subagent/workflow extractor 的 v !== 1 早退是刻意差异，依据 D4「版本号字段不采用」）。
 *
 * 派生归一（plan 状态机显式化 D2 读方②）：产出 View **恒携带 `state`**（新 entry 直读 /
 * 旧 entry 经 reviewState 映射（awaiting→reviewing、revising→revising、无→planning|idle
 * 按 isActive）），resumeHint 直读或由 reviewStateSource:'resubmit' 同义映射；**旧字段
 * （reviewState/reviewStateSource）只作映射输入、永不透出进 View**（取代式演进；
 * selfReview 不派生，D9③：消费方止于审批请求帧 + entry 比较基线）。映射实现单源 =
 * extension-protocol legacy-entries（plan-mode-audit-remediation D-B4-1 下沉——原内联
 * 拷贝删除，扩展读方①同引一份；契约断言范围 = protocol 包内 legacy-entries.test.ts）。
 *
 * runtime 不 import extensions/ 源码（依赖方向不允许，同 subagent-extractor:194 先例），
 * entry data 按防御式逐字段检查消费；extension-protocol 是包依赖（tsup noExternal 已打包，
 * 与 event-adapter 的 marker 常量同引法）。
 */
import type { PlanDocMeta, PlanStateView } from '@taiji/shared'
// 生命周期值域与 legacy entry 映射 canonical = extension-protocol（包依赖，非 extensions/
// 源码——tsup noExternal 已打包该包，与 event-adapter 的 marker 常量同引法）
import {
  PLAN_STATE_CUSTOM_TYPE,
  readLifecycleState,
  readResumeHint,
} from '@zhushanwen/extension-protocol'
// 活跃路径裁剪（message-revoke U6d）：U6a 导出的 SSOT 纯函数（live 全量重建传 leafId 的
// 裁剪单点；冷启动续读链产出因对话行缺席走缺省直通分支，见头注释「冷启动裁剪边界」）
import { computeActivePathEntries } from '../../infra/pi/session-entry-mapper.js'

/** JSONL 中的 custom entry 结构（照 subagent-extractor JsonlCustomEntry 简化形态）。 */
interface JsonlCustomEntry {
  type: string
  customType?: string
  data?: unknown
}

/**
 * requirement 读侧封顶上限（64KB = 64 * 1024 字节）：与 extension 写侧
 * MAX_PLAN_REQUIREMENT_LENGTH（extensions/universal/plan/src/state.ts）刻意同值——
 * runtime 不 import extensions/ 源码（依赖方向不允许，同 subagent-extractor:194 先例），
 * 跨包对齐靠注释互指。数值用单字面量而非 64 * 1024 乘法形态：乘法操作数仍会被
 * no-magic-numbers 逐个告警，本处以命名 + 注释承载换算语义，不加静默规则豁免
 * （BYTES_PER_MB 的既有豁免注释不在此修复范围）。
 */
const MAX_PLAN_REQUIREMENT_LENGTH_BYTES = 65_536

/**
 * 「未激活」缺省 View（无 entry / ENOENT / oversize 降级共用，对齐 extension
 * DEFAULT_PLAN_STATE 的 View 域派生）。导出给 SessionRecords 的 publish 归一
 * （全量重建发现 entry 被外部清空 → 缺省 View 发布帧，见 mergePlanState）。
 */
export const INACTIVE_PLAN_STATE_VIEW: PlanStateView = {
  isActive: false,
  planFilePath: null,
  requirement: null,
  templateName: null,
}

/**
 * entry 扫描器：从 entry 列表派生 plan 状态视图（D1④）。
 *
 * [message-revoke U6d] 派生语义升级为「**活跃路径内**最后一条」合法 plan-state entry
 * （G2 二分的未来状态随树路径——plan 状态 = 当前状态，被撤子树的 plan-state entry 不得
 * 进派生态）：提供 leafId 时先经 computeActivePathEntries（U6a 导出 SSOT）裁剪再逆序扫；
 * 缺省 = 现行为（全文件逆序取首）。调用点契约（U6a 同款）：仅全量重建路径传 leafId、
 * 增量合并路径不传（delta 是活跃路径后缀切片，裁剪是全树语义，统一传会在窗口越界误裁）。
 *
 * 坏 entry 跳过继续向前（extension 侧 state.ts reconstructPlanState 的 continue 语义
 * 同构）；无任何合法命中返回 null（= 活跃路径从未进过 plan 模式，publish 侧跳过；冷路径
 * 调用方归一为「未激活」缺省 View）。
 *
 * entries 来源两种形态同构（pi SessionEntry 内存对象与 JSONL 行反序列化，type 判定
 * 'custom'，对齐 subagent-extractor:181-182 注释）。
 */
export function scanPlanStateEntries(entries: unknown[], leafId?: string): PlanStateView | null {
  // leafId 缺省时 computeActivePathEntries 原样直通（同一引用），既有调用零行为变化；
  // leafId 与 entries 不匹配（上游异常）→ 纯函数 fail-safe 原样返回 + warn（宁多显）
  const scoped = leafId !== undefined
    ? computeActivePathEntries(entries as Array<{ id?: unknown; parentId?: unknown }>, leafId)
    : entries
  for (let i = scoped.length - 1; i >= 0; i--) {
    const view = parsePlanStateEntry(scoped[i])
    if (view) return view
  }
  return null
}

/**
 * 单条 entry → PlanStateView（type/customType/data 逐层检查，非 plan-state entry 或坏
 * data 返回 null）。字段映射规则：
 * - 四必填字段：isActive 严格 `=== true`（其他形态归 false——View 契约是 boolean，防御
 *   extension 侧异常写入）；三个 string 字段空串归一 null（normalizeNonEmptyString）。
 * - optional 字段区（D4 + D2 归一）：skills/docs 字段存在且形状合法才透传（不存在 → View
 *   上不设键，而非显式 undefined——「旧 entry 派生出无新字段区」的字面语义）；state 恒携带
 *   （派生归一）、resumeHint 条件落键，全部下沉到 applyOptionalPlanFields。
 */
function parsePlanStateEntry(entry: unknown): PlanStateView | null {
  if (typeof entry !== 'object' || entry === null) return null
  const e = entry as JsonlCustomEntry
  if (e.type !== 'custom' || e.customType !== PLAN_STATE_CUSTOM_TYPE) return null
  const data = e.data
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>

  const view: PlanStateView = {
    isActive: d.isActive === true,
    planFilePath: normalizeNonEmptyString(d.planFilePath),
    requirement: normalizeNonEmptyString(d.requirement, MAX_PLAN_REQUIREMENT_LENGTH_BYTES),
    templateName: normalizeNonEmptyString(d.templateName),
  }
  applyOptionalPlanFields(view, d)
  return view
}

/**
 * string 字段读取 + 空串归一 null（parsePlanStateEntry 三个必填 string 字段共用）：
 * entry 域「无文件/无需求」的历史形态是空串，View 域归一为 null 单一表达
 * （shared PlanStateView 的 `string | null` 值域），消费方判式单一（`=== null` 即「无」）。
 * capTo 参数：requirement 传封顶上限（P3-8 读侧对齐——封顶机制上线前写入的超长 entry
 * 在派生处同样截断，保证 plan 帧恒有界；新写入恒已在 extension 写侧封顶，本防御只服务
 * 存量旧 entry）。
 */
function normalizeNonEmptyString(v: unknown, capTo?: number): string | null {
  if (typeof v !== 'string' || v === '') return null
  if (capTo !== undefined && v.length > capTo) {
    const omitted = v.length - capTo
    console.warn(
      `[plan-state-extractor] requirement entry over cap (${v.length} > ${capTo} chars), ` +
      `truncating in derived view (${omitted} characters omitted)`,
    )
    return v.slice(0, capTo)
  }
  return v
}

/**
 * optional 字段派生（D4 + D2 读方② 归一）：skills 要求 string[]、docs 逐元素检查（坏元素
 * 过滤）；state 恒携带（readLifecycleState 归一）、resumeHint 条件落键（readResumeHint）；
 * 旧字段 reviewState/reviewStateSource **只作映射输入、不透出进 View**（D2 取代式演进）；
 * selfReview 不派生（D9③——派生范围止于审批请求帧，planState 帧有界前提不扩展）。
 */
function applyOptionalPlanFields(view: PlanStateView, d: Record<string, unknown>): void {
  if (isStringArray(d.skills)) {
    view.skills = d.skills
  }
  if (Array.isArray(d.docs)) {
    view.docs = d.docs.map(parsePlanDocMeta).filter((doc): doc is PlanDocMeta => doc !== null)
  }
  // View 恒携带 state（D2 读方②）：新 entry 直读、旧 entry 经 reviewState 映射——映射
  // 实现单源直引 extension-protocol legacy-entries（D-B4-1 下沉，扩展读方①同引一份）
  view.state = readLifecycleState(d, view.isActive)
  // resumeHint 只认 'resubmit' 一字面量：新 entry 直读，旧 entry 由 reviewStateSource
  // 同义映射（'explain' 等存量值归无值——explain 交互已删，renderer 缺省分支渲染通用文案）
  const resumeHint = readResumeHint(d)
  if (resumeHint !== undefined) view.resumeHint = resumeHint
}

/** string[] 检查（skills 透传前置条件，空数组合法——extension 侧语义由其自行定义）。 */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string')
}

/**
 * docs 元素逐字段检查 → PlanDocMeta（shared 契约四字段；坏元素返回 null 被过滤——
 * 单文档元数据损坏不拖垮整组产物清单，未损坏部分照常显示）。
 */
function parsePlanDocMeta(v: unknown): PlanDocMeta | null {
  if (typeof v !== 'object' || v === null) return null
  const d = v as Record<string, unknown>
  if (
    typeof d.fileName !== 'string' ||
    typeof d.absPath !== 'string' ||
    typeof d.sourceSkill !== 'string' ||
    typeof d.version !== 'number'
  ) {
    return null
  }
  return { fileName: d.fileName, absPath: d.absPath, sourceSkill: d.sourceSkill, version: d.version }
}
