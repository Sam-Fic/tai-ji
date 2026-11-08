/**
 * layout-edges.ts —— DAG 边几何装配（正交路由：折点序列 + 圆角 path + 条件谓词徽章
 * 锚）。2026-11 自 layout.ts 拆出（layout.ts 超 max-lines 上限；依赖单向：本文件
 * import layout 的几何常量与 DagLayoutNode、routing-avoid 的避让层，layout 不反向
 * 依赖；消费方 = WorkflowVizDag 画布 + workflow-viz-pure-bundle 白盒用例）。
 *
 * 路由规则（消费 layoutDag 产出的节点几何）：
 * - 顺序/数据流/条件边：源右中心 → 通道竖线 → 目标左中心的三段折线（同行退化直线）；
 *   同列前向边走列右缘细道绕行；loop-back 见 loopBackPoints；折点处小半径圆弧过渡
 *  （视觉圆角，路由仍严格轴对齐）。
 * - 通道竖线先经 routing-avoid.assignChannelLanes 按纵向跨度游程错开（fan-in/out 不
 *   叠线），再经 routing-avoid.avoidObstructedChannelMid 整体平移到最近零穿卡走廊；
 *   同行直线有障碍时升级 routing-avoid.sameRowBypass 上下绕行 4 折线。
 * - 条件谓词徽章锚：跨列边悬浮在连线上方（间隙中线 × 线段中点上方 − LIFT——不遮盖
 *   连线，2026-11-08 用户裁决；列距已由 layoutDag 按徽章宽自适应拉开，不跨卡片）；
 *   同列边无间隙专属空间，退分区头徽章带（badgeAnchorY）。
 * - 锚点取节点主体四边中点（主体高恒 DAG_NODE_H=44，实例小卡不参与锚点几何），
 *   loop-back 底锚 = 主体 + 实例卡区总底（y + h + zoneH——回边从实例小卡下方走）。
 */
import type { WorkflowDag, WorkflowDagEdge } from '@taiji/shared'
import { DAG_NODE_W, PREDICATE_BADGE_LINE_LIFT, type DagLayoutNode } from './layout'
import {
  COINCIDE_EPS,
  assignChannelLanes,
  avoidObstructedChannelMid,
  sameRowBypass,
  type ChannelMember,
} from './routing-avoid'

/** 取半除数（节点中心 = 顶 + 高/2；具名以过 no-magic-numbers）。 */
const HALF = 2

/** 路径折点（画布坐标）。 */
export interface DagPoint { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——路由纯函数的输出契约（数据形状非抽象接口，layout 单源）
  x: number
  y: number
}

/** 布局后的边几何：折点序列（严格轴对齐）+ 圆角 path d 串 + 条件边谓词标注锚点。 */
export interface DagLayoutEdge { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——路由纯函数的输出契约（数据形状非抽象接口，layout 单源）
  edge: WorkflowDagEdge
  /** 路由折点（相邻两点恒共享 x 或 y——横竖两向的正交不变量，测试断言锚点）。 */
  points: DagPoint[]
  /** SVG path d 串（fill:none；折点处小半径圆弧过渡）。 */
  d: string
  /** 谓词标注锚点（kind='conditional' 时携带；置于本边通道竖线旁）。 */
  labelX?: number
  labelY?: number
}

/** 回边下探深度（画布坐标系常量——loop-back 横行总线的 y——压在所有分区内容之下）。 */
const LOOP_DROP = 28
/** 回边侧向细道偏移（节点缘到细道；细道落在分区内边距带内——节点列之外，不穿节点）。 */
const LOOP_SIDE_OFFSET = 8
/** 回边贴边水平段相对节点底边的下移间隙（px）：横行段落在底边与分区底界
 *  （CLUSTER_PAD_BOTTOM=12）或下邻节点（NODE_GAP=18）之间的空隙带内——不压节点
 *  边框，进出锚点仍唯一落在底边中点。 */
const LOOP_APPROACH_DROP = 5
/** 折点圆角半径（px；实际半径再按相邻段长收敛，短段不打弯）。 */
const CORNER_RADIUS = 6
/** 谓词徽章基线相对两端节点主体顶边的上移间隙（px）——徽章平铺在分区头预留的
 *  谓词徽章带（layout CLUSTER_PAD_TOP 含 14px 专属带）：min(两端主体顶) − 本值 =
 *  徽章文字基线，任何贴边位置（列间走廊 32px / gutter 8px）均容不下徽章。 */
const LABEL_ABOVE_GAP = 4
/**
 * 折点序列 → 圆角 path d 串：直线段 L 连接，内部折点处用半径 r 的二次贝塞尔
 * 过渡（r 收敛到相邻段长一半，避免短段翻折）。折点本身保持轴对齐不变量。
 */
function roundedPath(points: DagPoint[]): string {
  /** 线段最少点数（起点 + 终点；少于则无路径可言）。 */
  const MIN_PATH_POINTS = 2
  if (points.length < MIN_PATH_POINTS) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const next = points[i + 1]
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y)
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y)
    const r = Math.min(CORNER_RADIUS, inLen / HALF, outLen / HALF)
    const t1 = r / (inLen || 1)
    const t2 = r / (outLen || 1)
    const p1 = { x: cur.x + (prev.x - cur.x) * t1, y: cur.y + (prev.y - cur.y) * t1 }
    const p2 = { x: cur.x + (next.x - cur.x) * t2, y: cur.y + (next.y - cur.y) * t2 }
    d += ` L ${p1.x} ${p1.y} Q ${cur.x} ${cur.y} ${p2.x} ${p2.y}`
  }
  const last = points[points.length - 1]
  d += ` L ${last.x} ${last.y}`
  return d
}

/** 待装配边（保持 dag.edges 序——输出序不因错开分配分遍打乱）：已定型路径或通道成员。 */
/** 同列边谓词徽章锚 y：徽章带（min(两端主体顶) − LABEL_ABOVE_GAP，分区头预留的
 *  专属平铺行）——同列边不占列间隙（无专属水平空间），徽章退徽章带平铺。
 *  跨列边不消费本带：列距已按谓词徽章宽自适应拉开（layoutDag），徽章骑线平铺在
 *  列间隙内（见各路由分支的 label 锚——2026-11-08 用户裁决）。 */
function badgeAnchorY(from: DagLayoutNode, to: DagLayoutNode): number {
  return Math.min(from.y, to.y) - LABEL_ABOVE_GAP
}

type PendingEdge =
  | { edge: WorkflowDagEdge; kind: 'fixed'; points: DagPoint[]; labelX?: number; labelY?: number }
  | { edge: WorkflowDagEdge; kind: 'channeled'; chan: ChannelMember; labelX?: number; labelY?: number }

/**
 * loop-back 路由（锚点只取节点四边中点：底边中点进出）。形态分三档：
 * - 自环边（解析器把单调用点循环折叠成 from===to）：闭环要同时起止于底边中点必沿
 *   底边折返或与自身重叠，无合法正交形态，不产出几何——循环语义由实例行重试状态
 *   呈现，不画自指线；
 * - 同列回边：U 形侧向细道折返（细道在分区左内边距带内，贴边横行走底边下空隙带）；
 * - 跨列回边：两端同列下方均无堆叠节点时四折点直连——源底边中点垂直下探 → 底部
 *   总线（全图最深节点下方 LOOP_DROP 处）横行 → 目标底边中点垂直上升，进出垂直
 *   于底边；任一端下方被同列堆叠节点挡住（中轴升降段会穿卡片）时回退侧向细道 +
 *   空隙带横行，细道取朝向对端一侧（总线不回头折）。
 */
function loopBackPoints(
  from: DagLayoutNode,
  to: DagLayoutNode,
  deepestBottom: number,
  nodes: DagLayoutNode[],
): DagPoint[] {
  if (from === to) return []
  // 底锚 = 节点总占位底（主体 + 实例卡区）——实例小卡在场时回边从最底元素下方走
  const fromBottom = from.y + from.h + from.zoneH
  const toBottom = to.y + to.h + to.zoneH
  const fromLaneY = fromBottom + LOOP_APPROACH_DROP
  const toLaneY = toBottom + LOOP_APPROACH_DROP
  const bx1 = from.x + DAG_NODE_W / HALF
  const bx2 = to.x + DAG_NODE_W / HALF
  if (Math.abs(bx1 - bx2) < COINCIDE_EPS) {
    const sx = Math.min(from.x, to.x) - LOOP_SIDE_OFFSET
    return [
      { x: bx1, y: fromBottom },
      { x: bx1, y: fromLaneY },
      { x: sx, y: fromLaneY },
      { x: sx, y: toLaneY },
      { x: bx2, y: toLaneY },
      { x: bx2, y: toBottom },
    ]
  }
  const busY = Math.max(deepestBottom, fromBottom, toBottom) + LOOP_DROP
  // 同列下方堆叠节点会挡住中轴升降段（垂直段穿卡片）——任一端被挡即整体回退细道
  const columnBlocked = (n: DagLayoutNode): boolean =>
    nodes.some((o) => o !== n && Math.abs(o.x - n.x) < COINCIDE_EPS && o.y > n.y)
  if (!columnBlocked(from) && !columnBlocked(to)) {
    return [
      { x: bx1, y: fromBottom },
      { x: bx1, y: busY },
      { x: bx2, y: busY },
      { x: bx2, y: toBottom },
    ]
  }
  const towardTo = from.x > to.x
  const fromSideX = towardTo ? from.x - LOOP_SIDE_OFFSET : from.x + DAG_NODE_W + LOOP_SIDE_OFFSET
  const toSideX = towardTo ? to.x + DAG_NODE_W + LOOP_SIDE_OFFSET : to.x - LOOP_SIDE_OFFSET
  return [
    { x: bx1, y: fromBottom },
    { x: bx1, y: fromLaneY },
    { x: fromSideX, y: fromLaneY },
    { x: fromSideX, y: busY },
    { x: toSideX, y: busY },
    { x: toSideX, y: toLaneY },
    { x: bx2, y: toLaneY },
    { x: bx2, y: toBottom },
  ]
}

/**
 * 计算边几何（正交路由）。顺序/数据流/条件边 = 源右中心 → 通道竖线 → 目标左中心
 * （同行退化为直线）：同一通道（源同列且目标同列）的并行边竖线段默认重合，装配前
 * 经 assignChannelLanes 按车道错开，再经 avoidObstructedChannelMid 整体避让到最近
 * 零穿卡走廊；同行直线边有障碍时升级上下绕行 4 折线（标注锚随迁绕行横段）。loop-back
 * 见 loopBackPoints。端点缺失（边引用不存在节点——防御解析器缺口）的边不产出
 * （跳过，不抛）。
 */
export function layoutEdges(dag: WorkflowDag, nodes: DagLayoutNode[]): DagLayoutEdge[] {
  const byId = new Map<string, DagLayoutNode>()
  for (const ln of nodes) byId.set(ln.node.id, ln)

  // 全图最深节点底（loop-back 横行总线的 y——压在所有分区内容之下，不穿行内节点；
  // 实例小卡在场时含卡区高度）
  let deepestBottom = 0
  for (const ln of nodes) deepestBottom = Math.max(deepestBottom, ln.y + ln.h + ln.zoneH)

  const pending: PendingEdge[] = []
  const channels = new Map<string, ChannelMember[]>()
  for (const edge of dag.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    if (edge.kind === 'loop-back') {
      const points = loopBackPoints(from, to, deepestBottom, nodes)
      if (points.length > 0) pending.push({ edge, kind: 'fixed', points })
      continue
    }
    const x1 = from.x + DAG_NODE_W
    const y1 = from.y + from.h / HALF
    const x2 = to.x
    const y2 = to.y + to.h / HALF
    // 同列前向边（同 phase 内上下游调用点）：右中点出 → 列右缘细道下/上升 → 右中点
    // 入（入锚取朝向细道一侧——若入左边中点，末段横线要从右侧细道横穿整张卡片，
    // 箭头被「边先节点后」的绘制顺序遮住不可见）。缺省通道路由的中位竖线 = 两端 x
    // 的中点，同样落在节点列内部穿卡片；细道在分区右内边距带内（LOOP_SIDE_OFFSET，
    // CLUSTER_PAD_X=12 容得下），与回边细道共带——同列多条边共享细道时纵向跨度
    // 相邻链（a→b→c）天然衔接不重叠，跨行跳连（a→c 与 a→b 并存）的重叠为已知罕见形态
    if (Math.abs(from.x - to.x) < COINCIDE_EPS) {
      const gutterX = from.x + DAG_NODE_W + LOOP_SIDE_OFFSET
      pending.push({
        edge,
        kind: 'fixed',
        points: [
          { x: x1, y: y1 },
          { x: gutterX, y: y1 },
          { x: gutterX, y: y2 },
          { x: to.x + DAG_NODE_W, y: y2 },
        ],
        // 同列边谓词徽章锚：本列卡中心 × 徽章带（同列无列间隙专属空间——badgeAnchorY）
        labelX: from.x + DAG_NODE_W / HALF,
        labelY: badgeAnchorY(from, to),
      })
      continue
    }
    if (Math.abs(y1 - y2) < COINCIDE_EPS) {
      // 同行直线边（残余 5）：有障碍升级上下绕行 4 折线；无障碍/两方向均不满足保持
      // 直线（零扰动——直线公式不变）。跨列谓词徽章悬浮在连线上方：列距已按徽章宽
      // 自适应拉开（layoutDag gapExtra），徽章底距线 4px——不遮盖连线、不跨任何卡片
      const bypass = sameRowBypass(x1, y1, x2, nodes, from.node.id, to.node.id)
      if (bypass !== null) {
        pending.push({
          edge,
          kind: 'fixed',
          points: [
            { x: x1, y: y1 },
            { x: x1, y: bypass.yB },
            { x: x2, y: bypass.yB },
            { x: x2, y: y2 },
          ],
          labelX: (x1 + x2) / HALF,
          labelY: bypass.yB - PREDICATE_BADGE_LINE_LIFT,
        })
        continue
      }
      pending.push({
        edge,
        kind: 'fixed',
        points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
        labelX: (x1 + x2) / HALF,
        labelY: y1 - PREDICATE_BADGE_LINE_LIFT,
      })
      continue
    }
    const chan: ChannelMember = {
      x1, y1, x2, y2,
      lo: Math.min(y1, y2),
      hi: Math.max(y1, y2),
      laneX: (x1 + x2) / HALF,
      fromId: from.node.id,
      toId: to.node.id,
    }
    // 跨列谓词徽章悬浮在通道竖线段旁（间隙中线 × 竖线段中点上方——列距自适应已保空间）
    pending.push({ edge, kind: 'channeled', chan, labelX: (x1 + x2) / HALF, labelY: (y1 + y2) / HALF - PREDICATE_BADGE_LINE_LIFT })
    const key = `${x1}|${x2}`
    const list = channels.get(key)
    if (list) list.push(chan)
    else channels.set(key, [chan])
  }

  // 错开分配：同通道并行边按纵向跨度重叠游程序错开（机制见 assignChannelLanes）
  assignChannelLanes(channels)
  // 通道竖线避让：穿卡通道整体平移到最近零穿卡走廊（机制见 avoidObstructedChannelMid）
  avoidObstructedChannelMid(channels, nodes)

  const result: DagLayoutEdge[] = []
  for (const item of pending) {
    if (item.kind === 'fixed') {
      result.push({ edge: item.edge, points: item.points, d: roundedPath(item.points), labelX: item.labelX, labelY: item.labelY })
      continue
    }
    const c = item.chan
    const points: DagPoint[] = [
      { x: c.x1, y: c.y1 },
      { x: c.laneX, y: c.y1 },
      { x: c.laneX, y: c.y2 },
      { x: c.x2, y: c.y2 },
    ]
    result.push({
      edge: item.edge,
      points,
      d: roundedPath(points),
      // 谓词徽章锚随边定型（间隙中线 × 竖线段中点——骑线平铺）
      labelX: item.labelX,
      labelY: item.labelY,
    })
  }
  return result
}
