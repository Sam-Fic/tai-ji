/**
 * blueprint-attribution.ts —— 方案 C 展示层重归属纯函数（2026-11，scheme-c-demo spec
 * §2-§3：修正归属与分区顺序）。
 *
 * 输入 = u2 冻结的静态 DAG（解析器纯词法产物）+ D2 匹配产物 byNode（含 tier 2 名称族
 * 回落的挂接实例）+ 可选的运行时 phase 执行序；输出 = 重归属后的展示用 WorkflowDag
 *（新对象，输入不 mutate）。修的是解析器词法归属与运行时 phase 的已知错位：
 * 具名函数在全部 phase() 之前声明、运行时才在 phase 作用域内被调——词法遍历把调用点
 * 归 default，具名 phase 分区静态为空。重归属规则：
 * - 节点显示 phase = 挂接实例运行时 phase 的众数（并列取 taskIndex 首现者）；零实例
 *   或实例 phase 全缺失 → 保持词法 phase（静态信息不被无实例时的猜测改写——零实例
 *   调用点在 default 分区如实展示「未触发」，名称族→phase 的显式映射表属 spec §9.4
 *   登记的边界，不在此发明）。
 * - 分区清单序 = 运行时执行序（run.phases 快照，phase-started 事件流序）优先，静态
 *   词法序补尾（未执行到的 phase），运行时新增 phase（实例携带、两侧都没有）再补尾
 *   （节点序首现）。词法首现序对「声明先于 main() 的延迟调用函数」会错排执行段
 *   （wave-executor 实测：失败聚合/修复组的 phase() 调用词法先于校验/开发段）。
 * - 边/并行组/循环照抄输入（重归属只改 node.phase 与 phases 清单序——节点 id、模板、
 *   matchPattern 均不变，D2 挂接映射与布局消费侧零迁移）。
 *
 * 消费链：WorkflowVizOverlayHost 单处派生（matchResult 之后），画布/图例/点击语义
 * 消费重归属后的 dag；Phase 标签页与 trace 表不受影响（按运行时事件流分组，本就正确）。
 */
import type { WorkflowAgentCall, WorkflowDag } from '@taiji/shared'

/**
 * 节点显示 phase：挂接实例运行时 phase 的众数（并列取首现——实例按 taskIndex 升序
 * 传入，首现 = 最早派发者）。零实例 / 实例 phase 全缺失 → undefined（调用方保持词法）。
 */
function majorityInstancePhase(calls: readonly WorkflowAgentCall[]): string | undefined {
  const counts = new Map<string, number>()
  for (const call of calls) {
    if (call.phase === undefined) continue
    counts.set(call.phase, (counts.get(call.phase) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  for (const [phase, count] of counts) {
    // 严格大于保证并列时 Map 插入序（taskIndex 首现序）先到者胜
    if (count > bestCount) {
      best = phase
      bestCount = count
    }
  }
  return best
}

/**
 * 重归属主入口：静态 DAG + 挂接实例 → 展示用 DAG（新对象）。
 *
 * @param dag 静态蓝图（session.getWorkflowDag 成功臂，词法归属口径）
 * @param instancesByNode D2 匹配产物 byNode（matchInstancesToNodes().byNode；缺省/空 =
 *   无实例数据——全部节点保持词法 phase，分区清单只做执行序重排）
 * @param runPhaseOrder 运行时 phase 执行序（run.phases 的 phase 名序列；缺省 = 无运行时
 *   快照可用，分区清单退回静态词法序）
 */
export function reattributeDagPhases(
  dag: WorkflowDag,
  instancesByNode?: ReadonlyMap<string, readonly WorkflowAgentCall[]>,
  runPhaseOrder?: readonly string[],
): WorkflowDag {
  // 节点重归属（新数组；词法 phase 不变者也产新对象——下游按引用消费，统一新引用
  // 避免「部分节点换对象部分不换」的混合形态）
  const nodes = dag.nodes.map((node) => {
    const calls = instancesByNode?.get(node.id)
    const phase = calls !== undefined ? majorityInstancePhase(calls) : undefined
    return phase === undefined ? node : { ...node, phase }
  })

  // 分区名全集三源：运行时执行序 → 静态词法序 → 重归属后节点携带的运行时新增 phase
  //（节点序首现——节点已按词法序排列，首现序稳定）
  const names: string[] = []
  const seen = new Set<string>()
  const add = (phase: string): void => {
    if (!seen.has(phase)) {
      seen.add(phase)
      names.push(phase)
    }
  }
  for (const phase of runPhaseOrder ?? []) add(phase)
  for (const phase of dag.phases) add(phase.name)
  for (const node of nodes) add(node.phase)

  return {
    ...dag,
    nodes,
    phases: names.map((name, order) => ({ name, order })),
  }
}
