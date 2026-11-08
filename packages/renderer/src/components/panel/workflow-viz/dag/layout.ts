/**
 * DAG 列式布局纯函数（workflow-visualization 设计 §3.2「自绘 SVG，手写布局」：
 * 按 phase 列分区，调用点按词法序排列）。
 *
 * 输入 = u2 冻结的 WorkflowDag（shared 协议类型）+ 可选的节点高度表，输出 = 画布
 * 几何（分区矩形 / 节点左上角坐标与高度 / 画布总尺寸 / 边路径）。纯函数零 IO、
 * 零 DOM——构建者白盒测试对象。
 *
 * 布局规则：
 * - 分区列：WorkflowDagPhase.order 升序从左到右；分区内节点按 templateName
 *   词法序（codepoint）垂直排列——同列词法序是设计原型的排列口径。
 * - 节点几何（方案 C demo §3.3/§6 三层形态）：调用点主体框恒高 DAG_NODE_H（44），
 *   实例 = 主体下方的独立边框小卡（每实例一张 + 间距；0 实例一行虚线占位卡），
 *   卡区总高 = instanceZoneHeight(实例数)，经 nodeZones 表传入布局（高度派生单处
 *   在消费侧——画布按 instancesByNode 计算），布局只消费数值表（缺省键 = 0 实例
 *   占位卡高）；边锚点取主体四边中点（实例小卡不参与锚点几何）。
 * - 节点归属分区缺失（node.phase 不在 phases 清单，防御解析器缺省分区缺口）时
 *   动态补尾部分区，节点不丢弃。
 * - 分区可见性（方案 C）：空 default 分区（重归属后无归属节点的解析器缺省兜底名）
 *   整体消隐不占列；非 default 空分区保留为纯脚本段（cluster.scriptOnly=true，
 *   渲染层虚线边框 + 「纯脚本」标注）。
 * - 并行组（parallelGroups）v1 不画组框：同组节点天然同列相邻（同 phase 内词法
 *   序排列），并行语义由调用点行内的实例列表表达（设计 §3.1-3 最小形态）。
 *
 * 边路由（正交，2026-11 拆出至同目录 layout-edges.ts 与 routing-avoid.ts——本文件
 * 只承载布局与 fit；拆分动因 = 本文件行数超 max-lines 上限）：全部边只走横竖两向，
 * 任何段不穿节点卡片；连线锚点只取节点四条边的中点（上/下/左/右共 4 个连线点，
 * 上边中点预留）——
 * - 顺序/数据流/条件边：源右中心 → 通道竖线 → 目标左中心的三段折线（同行退化直线）；
 *   跨列并行边（同源列且同目标列）竖线段默认重合，按纵向跨度重叠游程居中错开横向偏移
 *   （LANE_STEP_PX），fan-in/fan-out 不再叠成一根线；同列前向边（源与目标同列）
 *   走列右缘细道绕行——缺省通道中位竖线会落在节点列内穿卡片（绘制顺序遮住不可见）；
 * - loop-back（底边中点进出）：跨列回边在两端同列下方均无堆叠节点时四折点直连——
 *   源底边中点垂直下探 → 底部总线（全图最深节点下方）横行 → 目标底边中点垂直
 *   上升，进出垂直于底边、节点附近无横行段；任一端下方被同列堆叠节点挡住时回退
 *   侧向细道 + 底边下空隙带横行（LOOP_APPROACH_DROP，不压边框）；同列回边 = U 形
 *   细道折返；自环边（from===to）画不出合法的四中点正交环，不产出几何。
 * 折点处用小半径圆弧过渡（视觉圆角，路由仍严格轴对齐）。
 */
import type { WorkflowDag, WorkflowDagNode } from '@taiji/shared'

/** 节点卡片尺寸（px，画布坐标系）。 */
export const DAG_NODE_W = 156
export const DAG_NODE_H = 44

/** 列内节点行距（节点间空隙，px；步进 = 节点高 + 行距）。 */
const NODE_GAP = 18
/** 分区内边距（节点区四周）。 */
const CLUSTER_PAD_X = 12
/** 分区顶带高：分区标题 + 副标题 + 谓词徽章带（条件边谓词徽章的专属平铺行，
 *  2026-11-08 视觉裁决：列间走廊 32px 与标题带空档均容不下 16 字符徽章，统一
 *  预留 14px 专属带使谓词徽章全场景无冲突平铺）。 */
const CLUSTER_PAD_TOP = 44
const CLUSTER_PAD_BOTTOM = 12
/** 分区标题行高。 */
const CLUSTER_TITLE_H = 18
/** 分区列间水平间距。 */
const CLUSTER_GAP_X = 32
/** 比较器返回值（排序比较器惯例语义，命名消 magic number）。 */
const ORDER_BEFORE = -1
const ORDER_AFTER = 1
/** 零节点 run 的最小占位尺寸（渲染层居中摘要提示的底板）。 */
const EMPTY_DAG_MIN_W = 240
const EMPTY_DAG_MIN_H = 96
/** 中点除数（矩形中心 = 左上 + 尺寸/2）。 */
const HALF = 2

// ── 实例小卡（节点主体下方的独立边框小卡，方案 C demo §3.3/§6 形态）几何 ──

/** 实例小卡高（px）：独立 rect 卡（状态点 + 实例 agent 名 + 状态染边框）。 */
export const INSTANCE_CHIP_H = 24
/** 相邻实例小卡间距（px；步进 = 卡高 + 间距）。 */
export const INSTANCE_CHIP_GAP = 4
/** 实例小卡左缩进（px；卡宽 = DAG_NODE_W − 本值，demo chip x+8 宽 148）。 */
export const INSTANCE_CHIP_INSET_X = 8
/** 0 实例占位卡高（px；虚线「未触发 · 0 实例」——不伪造运行实例名）。 */
export const INSTANCE_PLACEHOLDER_H = 18
/** 实例卡区与节点主体的上间隙（px；卡区画在主体 rect 之外下方）。 */
export const INSTANCE_ZONE_TOP_GAP = 4

/**
 * 实例卡区总高（按挂接实例数，方案 C 三层结构：分区框 → 调用点主体框 → 独立实例小卡，
 * 实例区在主体 rect 之外）：≥1 实例每实例一张独立小卡（步进卡高 + 卡间距，末卡不带
 * 尾距）；0 实例一行虚线占位卡。主体高恒 DAG_NODE_H——边锚点用主体四边中点。
 */
export function instanceZoneHeight(instanceCount: number): number {
  if (instanceCount <= 0) return INSTANCE_ZONE_TOP_GAP + INSTANCE_PLACEHOLDER_H
  return INSTANCE_ZONE_TOP_GAP + instanceCount * (INSTANCE_CHIP_H + INSTANCE_CHIP_GAP) - INSTANCE_CHIP_GAP
}

// ── fit-to-view（默认打开时全图居中自适应）──

/** fit 四周留白（px，用户裁决：主体居中、四周空 ~20px）。 */
export const FIT_PAD_PX = 20
/** fit 缩放下限（与画布手动缩放共用同一可读性下限）。 */
export const ZOOM_MIN = 0.35
/** fit 缩放上上限：内容比视口小不放大（k 封顶 1，保持文字原生渲染不虚）。 */
const FIT_MAX_K = 1

/** 视口变换（k 缩放 + tx/ty 平移，画布 viewport 的 transform 三元组）。 */
export interface FitTransform { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——布局纯函数的输出契约（数据形状非抽象接口，layout 单源）
  k: number
  tx: number
  ty: number
}

/**
 * 计算 fit-to-view 变换：内容缩放到两侧各留 pad 空隙后居中。
 * 容器某轴无布局环境（jsdom clientWidth/Height 缺失 = 0）时该轴不参与缩放约束、
 * 偏移取 0（退化贴左上，与既有退化口径一致，不破坏渲染）；两轴均缺失 → k=1 平移 0。
 * 内容某轴尺寸 > 0 恒成立（零节点 run 也有最小占位）。
 */
export function computeFitTransform(
  containerW: number,
  containerH: number,
  contentW: number,
  contentH: number,
): FitTransform {
  if (contentW <= 0 || contentH <= 0) return { k: 1, tx: 0, ty: 0 }
  let k = FIT_MAX_K
  if (containerW > 0) k = Math.min(k, (containerW - FIT_PAD_PX * HALF) / contentW)
  if (containerH > 0) k = Math.min(k, (containerH - FIT_PAD_PX * HALF) / contentH)
  k = Math.max(ZOOM_MIN, Math.min(FIT_MAX_K, k))
  return {
    k,
    tx: containerW > 0 ? (containerW - contentW * k) / HALF : 0,
    ty: containerH > 0 ? (containerH - contentH * k) / HALF : 0,
  }
}

/** 布局后的节点几何（x/y = 主体左上角，h = 主体高恒 DAG_NODE_H，zoneH = 主体下方实例卡区总高——方案 C 三层结构：实例是卡外独立小卡，节点总占位高 = h + zoneH）。 */
export interface DagLayoutNode { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——列式布局纯函数的输出契约（数据形状非抽象接口，layout 单源）
  node: WorkflowDagNode
  x: number
  y: number
  h: number
  /** 实例卡区总高（含与主体的上间隙；布局步进与回边总线底锚消费）。 */
  zoneH: number
}

/** 布局后的 phase 分区矩形（背景分区列）。 */
export interface DagLayoutCluster { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——列式布局纯函数的输出契约（数据形状非抽象接口，layout 单源）
  phase: string
  x: number
  y: number
  width: number
  height: number
  /**
   * 纯脚本段（方案 C）：无归属调用点的非 default 分区（phase() 作用域内只有脚本步骤）。
   * 渲染层出虚线边框 + 「纯脚本」标注；与空 default 分区（整体消隐）区分——default
   * 是解析器缺省兜底名，不是脚本作者声明的执行段。
   */
  scriptOnly: boolean
  /**
   * 分区展示序号（1 起，执行序——布局列序即执行序，方案 C demo §3.1「执行段 0N」）。
   * 渲染层分区副标题消费；与 WorkflowDagPhase.order 区分（order 是词法序号，展示序
   * 号 = 消隐 default 后的可见列序）。
   */
  order: number
  /** 分区归属调用点数（副标题「n 调用点」数据源）。 */
  nodeCount: number
}

/** 布局产物：分区矩形 + 节点几何 + 画布总尺寸。 */
export interface DagLayout { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——列式布局纯函数的输出契约（数据形状非抽象接口，layout 单源）
  clusters: DagLayoutCluster[]
  nodes: DagLayoutNode[]
  width: number
  height: number
}

/** 词法序比较（codepoint 序，环境无关——测试确定性优先于 locale 感知序）。 */
function lexicalCompare(a: string, b: string): number {
  if (a < b) return ORDER_BEFORE
  if (a > b) return ORDER_AFTER
  return 0
}

/**
 * 解析器缺省分区名（workflow-dag-parser WORKFLOW_DAG_DEFAULT_PHASE 的展示层镜像——
 * shared 未冻结该常量值，两侧字面量一致由测试锚定）。空 default 分区整体消隐：
 * 它是词法归属的兜底产物而非脚本声明的执行段，重归属后无节点即无展示价值
 *（方案 C「分区层不再出现 default」；仍有未触发零实例节点时如实保留）。
 */
const DEFAULT_PHASE_NAME = 'default'

/**
 * 布局单列：给定分区名与归属节点（已按词法序排好），产出分区矩形与节点坐标。
 * 节点实例卡区高度查 nodeZones 表（缺省 = 0 实例占位卡高）——同列步进按主体高 +
 * 各自实例卡区高度累加（主体恒 44，实例小卡在主体之外向下展开）。
 */
function layoutCluster(
  phase: string,
  order: number,
  members: WorkflowDagNode[],
  x: number,
  nodeZones: Map<string, number>,
): {
  cluster: DagLayoutCluster
  placed: DagLayoutNode[]
} {
  const placed: DagLayoutNode[] = []
  let cursorY = CLUSTER_PAD_TOP + CLUSTER_TITLE_H
  for (const node of members) {
    const zoneH = nodeZones.get(node.id) ?? instanceZoneHeight(0)
    placed.push({ node, x: x + CLUSTER_PAD_X, y: cursorY, h: DAG_NODE_H, zoneH })
    cursorY += DAG_NODE_H + zoneH + NODE_GAP
  }
  const singleNodeMinHeight = CLUSTER_PAD_TOP + CLUSTER_TITLE_H + DAG_NODE_H + CLUSTER_PAD_BOTTOM
  const last = placed[placed.length - 1]
  const contentBottom = last !== undefined
    ? last.y + last.h + last.zoneH + CLUSTER_PAD_BOTTOM
    : singleNodeMinHeight
  const cluster: DagLayoutCluster = {
    phase,
    x,
    y: 0,
    width: DAG_NODE_W + CLUSTER_PAD_X * HALF,
    height: Math.max(contentBottom, singleNodeMinHeight),
    scriptOnly: members.length === 0 && phase !== DEFAULT_PHASE_NAME,
    order,
    nodeCount: members.length,
  }
  return { cluster, placed }
}

/** 节点实例卡区高度表（nodeId → zoneH；缺省键按 0 实例占位卡高）。 */
export type DagNodeZoneMap = Map<string, number>

/**
 * 计算 DAG 列式布局。零节点 run（纯门禁脚本）：nodes 空数组、clusters 空、
 * 画布取最小占位尺寸——渲染层出空画布 + 居中摘要提示（设计 §3.1-3，提示由画布组件
 * 渲染，不归布局）。
 */
export function layoutDag(dag: WorkflowDag, nodeZones: DagNodeZoneMap = new Map()): DagLayout {
  // 分区清单（order 升序）；防御：节点归属分区缺失时动态补尾部分区（节点不丢弃）
  const phaseOrder = new Map<string, number>()
  const orderedPhases = [...dag.phases].sort((a, b) => a.order - b.order)
  orderedPhases.forEach((p) => phaseOrder.set(p.name, p.order))

  const missing = new Set<string>()
  for (const node of dag.nodes) {
    if (!phaseOrder.has(node.phase)) missing.add(node.phase)
  }
  let nextOrder = orderedPhases.length
  for (const phase of [...missing].sort(lexicalCompare)) {
    phaseOrder.set(phase, nextOrder)
    orderedPhases.push({ name: phase, order: nextOrder })
    nextOrder += 1
  }

  // 分区内节点按词法序分组
  const byPhase = new Map<string, WorkflowDagNode[]>()
  for (const node of dag.nodes) {
    const list = byPhase.get(node.phase) ?? []
    list.push(node)
    byPhase.set(node.phase, list)
  }
  for (const [phase, list] of byPhase) {
    list.sort((a, b) => lexicalCompare(a.templateName, b.templateName) || lexicalCompare(a.id, b.id))
    byPhase.set(phase, list)
  }

  const clusters: DagLayoutCluster[] = []
  const nodes: DagLayoutNode[] = []
  let cursorX = 0
  let maxBottom = 0
  let visibleOrder = 0
  for (const phase of orderedPhases) {
    const members = byPhase.get(phase.name) ?? []
    // 空 default 分区消隐（方案 C）：重归属后无归属节点的缺省兜底分区不占列——
    // 有节点（未触发零实例调用点）时如实保留，非 default 空分区保留为纯脚本段
    if (members.length === 0 && phase.name === DEFAULT_PHASE_NAME) continue
    visibleOrder += 1
    const { cluster, placed } = layoutCluster(phase.name, visibleOrder, members, cursorX, nodeZones)
    clusters.push(cluster)
    nodes.push(...placed)
    maxBottom = Math.max(maxBottom, cluster.height)
    cursorX += cluster.width + CLUSTER_GAP_X
  }

  // 零分区（零节点 run）：最小占位，渲染层出居中摘要提示（无独立卡片容器）
  const width = clusters.length > 0 ? cursorX - CLUSTER_GAP_X : EMPTY_DAG_MIN_W
  const height = clusters.length > 0 ? maxBottom : EMPTY_DAG_MIN_H
  return { clusters, nodes, width, height }
}

