/**
 * run journal 行解析器（域无关 tail 原语的 run 域注入）。
 *
 * [events-projection 拆分] 自 events-projection.ts 移出（该文件 max-lines 上限顶满，
 * 先例 = events-projection-last-round.ts 同款 sibling 拆分）：词表集合 + 编译锁 +
 * 行解析器三件自成一个概念（run 域行级判定，零投影状态），消费方含投影本体、
 * model-override-query、workflow-run-events-reader——经 events-projection 的 re-export
 * 维持原导出路径（消费方 import 零改动）。
 */
import {
  ALL_RUN_OUTCOMES, RUN_EVENT_TYPES,
  type WorkflowRunEvent,
} from '@zhushanwen/subagent-core'

/**
 * run 事件 type 词表集合（词表 SSOT = core run-events RUN_EVENT_TYPES，经 barrel
 * 消费——判定面与 core isWorkflowRunEventLine 同词表单源）。编译期穷尽守卫双向：
 * Set 构造泛型校验「词表 ⊆ WorkflowRunEvent['type'] 判别联合」，下方编译锁校验
 * 反向「union 成员 ⊆ 词表」——core 词表增删成员时漂移在编译期显形，运行时零漂移面。
 * 词表外历史行（ask-executing / member-pool 等删值成员）经词表外判定返回
 * undefined，由 tailer 跳过计日志。
 */
const RUN_EVENT_TYPE_SET: ReadonlySet<string> = new Set<WorkflowRunEvent['type']>(RUN_EVENT_TYPES)

// 编译锁（纯类型，零运行时）：union 成员缺席词表 → Exclude 非 never → 三元求值
// never，赋值处编译红（先例：subagent-engine-sdk wire-field-locks 的
// _assertNoDoubleWrite 同款形态）
const _assertRunEventTypeWordlist: Exclude<
  WorkflowRunEvent['type'],
  (typeof RUN_EVENT_TYPES)[number]
> extends never ? true : never = true

/**
 * run journal 文件行解析器（event-tail parseLine 注入面，run 域）。
 *
 * 守卫对齐 core run-events isWorkflowRunEventLine 的最宽共同判定面：JSON 对象 +
 * type 落词表 + ts 有限数值 + seq（携带时）正安全整数 + outcome（agent-settled /
 * run-settled 携带时）落词表。seq 缺失放行——W1 前存量 事件行无该字段（D7
 * 惰性兼容读，旧行为不变）。坏行返回 undefined 交 tailer 计数（宽容跳过，不卡游标）。
 */
export function parseWorkflowRunEventFileLine(line: string): WorkflowRunEvent | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const rec = parsed as { type?: unknown; ts?: unknown; seq?: unknown; outcome?: unknown }
  if (typeof rec.type !== 'string' || !RUN_EVENT_TYPE_SET.has(rec.type)) return undefined
  if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) return undefined
  if (
    rec.seq !== undefined &&
    (typeof rec.seq !== 'number' || !Number.isSafeInteger(rec.seq) || rec.seq < 1)
  ) {
    return undefined
  }
  if (
    rec.outcome !== undefined &&
    !(ALL_RUN_OUTCOMES as readonly string[]).includes(rec.outcome as string)
  ) {
    return undefined
  }
  return parsed as WorkflowRunEvent
}
