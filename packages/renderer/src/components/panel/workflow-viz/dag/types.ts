/**
 * workflow-viz DAG 画布的渲染层类型（workflow-visualization 设计 §3.3-D9）。
 *
 * 七态是渲染层派生态、不进 shared 协议（D9 明示「retrying 与 skipped 为渲染层
 * 派生态、不进协议」；pending/running/done/failed/cancelled 五值与 WorkflowAgentCall.status
 * 词表对齐，retrying/skipped 由派生函数产出；cancelled = run 终局收尾的在途成员，
 * §3.3.8）。
 *
 * 派生单处口径：节点七态的判定（retrying = 存在 agent-retrying 且无终局 settled；
 * skipped = 仅 run 终局后判定零实例挂接的调用点）集中在 renderer 单处实现、
 * trace 表与 DAG 共用同一函数（设计 §3.3-D9 单点实现，实装落 u5 gantt-segments /
 * panel 侧）——本画布经 props 接收已派生的七态映射，不自行判定。
 */

/** DAG 节点七态（D9 渲染层派生态词表）。 */
export type WorkflowVizDagNodeStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'retrying'
  | 'cancelled'
  | 'skipped'

/**
 * DAG 画布点击上抛语义（[2026-11-08 用户裁决] 图上点击钻取恢复——推翻 [2026-10-19]
 * 「DAG 点击 no-op、钻取收归 trace 行」的收编裁决，trace 行入口保留）：
 * - 'agent'：实例小卡点击 / 有实例调用点卡片点击（打开或切回该 agent 的对话流
 *   tab——多实例调用点取末位实例，「点抽象名切回该 agent」语义）；callId =
 *   WorkflowAgentCall.id，call 数据由宿主在 run.agentCalls 反查（画布不复制投影）；
 * - 'phase'：pending/skipped 节点（零实例、无对话可看——skipped = run 终局后零
 *   实例）与 phase 分区点击（开所属 phase tab）——「pending/skipped 节点点击 =
 *   phase 语义」由画布按已派生七态路由（设计 §3.1-2 点击行为边界），非业务派生。
 */
export type WorkflowVizDagClickPayload =
  | { semantic: 'phase'; phase: string }
  | { semantic: 'agent'; callId: number }

/**
 * run 停止时在途节点的叠加着色调（画布归一 D9 着色映射后传入节点卡片；叠加
 * 两档只属于「被停止的 run」——正常完成 outcome='done' 不是停止）：
 * - 'neutral'：中性暗——interrupted（暂停态，可续跑）、cancelled（用户主动终局，
 *   tray-tone「同语义同色」先例）与 done + outcome 缺省（v1 存量数据缺口保守
 *   中性，不作成败断言）三源共用一档；
 * - 'failed'：失败色系——failed 与 time_limited 终局（D9 着色映射全枚举）；
 * - null：无叠加——run 运行中（在途节点正常蓝脉冲）与 outcome='done'（正常完成，
 *   七态自明：done 节点 success 绿与 skipped 虚线不被叠加吞掉）。
 */
export type WorkflowVizDagStopTone = 'neutral' | 'failed' | null
