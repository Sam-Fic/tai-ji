/**
 * routing-avoid.ts —— DAG 边路由的避让层纯函数（通道车道错开 / 通道竖线避让 / 同行
 * 直线绕行 / 穿卡判定）。2026-11 自 layout.ts 拆出（layout.ts 超 max-lines 上限；
 * 依赖单向：本文件 import layout 的几何常量与 DagLayoutNode，layout 不反向依赖）。
 *
 * 消费方：layout-edges.layoutEdges（装配期调用 assignChannelLanes /
 * avoidObstructedChannelMid / sameRowBypass）；白盒用例直喂几何输入
 *（workflow-viz-pure-bundle「通道竖线避让」组，导出 avoidObstructedChannelMid 与
 * LANE_STEP_PX / ChannelMember）。
 *
 * 穿卡判定的障碍盒 = 节点主体 + 实例卡区（方案 C demo §3.3 三层结构：实例小卡画在
 * 主体下方——边从卡区穿过同样压卡，故 segmentHitsNode 覆盖到 y + h + zoneH；锚点
 * 仍取主体四边中点，锚定边贴主体）。
 */
import { DAG_NODE_W, type DagLayoutNode } from './layout'

/** 取半除数（中位 x = (x1+x2)/2 等；具名以过 no-magic-numbers——各模块私有同名常量先例）。 */
const HALF = 2

/** 同通道并行边的错开步长（竖线段错开间距；列间走廊 ~56px，容得下常规并行度）。 */
export const LANE_STEP_PX = 6
/** 线段穿卡判定的外扩间隙（px，每侧）：车道/绕行带与卡片缘的最小净距——列间走廊
 * 56px 的容量口径（车道铺开 + 2×本值 ≤ 走廊宽）由它推导。 */
const PIERCE_CLEARANCE_PX = 2
/** 同行绕行带与障碍行缘的间隙（px，设计决策四 margin）。 */
const BYPASS_MARGIN_PX = 12
/** 坐标重合判定（同列回边 bx1≈bx2 的浮点容差；layout-edges 的路由分支共用）。 */
export const COINCIDE_EPS = 0.5

/**
 * 轴对齐线段与节点卡片的穿卡判定（通道竖线避让与同行直线绕行共用的障碍谓词，
 * 设计 workflow-viz-fit-and-routing §3.2 决策三/决策四）。
 *
 * x 覆盖区间两端各外扩 PIERCE_CLEARANCE_PX（车道/绕行带与卡片缘净距口径，列间走廊
 * 容量公式按此推导）；y 覆盖区间开区间相交（端点相触不算穿卡）。障碍盒 = 节点主体
 * + 实例卡区（方案 C demo §3.3 三层结构：实例小卡画在主体下方——边从卡区穿过同样
 * 压卡，故穿卡判定覆盖到 y + h + zoneH；锚点仍取主体四边中点，锚定边贴主体）。
 * excludeNodeId 排除线段自身锚定的端点节点——锚点贴卡片边缘，外扩后必然「命中」
 * 自身，属锚定而非穿卡；一条线段排除一个端点（横段 1 排除源、横段 3 排除目标）。
 */
function segmentHitsNode(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  node: DagLayoutNode,
  excludeNodeId?: string,
): boolean {
  if (node.node.id === excludeNodeId) return false
  const segX0 = Math.min(x0, x1) - PIERCE_CLEARANCE_PX
  const segX1 = Math.max(x0, x1) + PIERCE_CLEARANCE_PX
  const segY0 = Math.min(y0, y1)
  const segY1 = Math.max(y0, y1)
  const nodeX1 = node.x + DAG_NODE_W
  const nodeY1 = node.y + node.h + node.zoneH
  // x 轴经外扩恒非退化区间 → 开区间相交；y 轴在水平段退化为一点 → 按严格包含判定
  //（点落在卡片 y 区间内才算穿，压边框线不算——「端点相触不算」在点轴上的形态）
  const xHit = Math.max(segX0, node.x) < Math.min(segX1, nodeX1)
  const yHit = segY0 === segY1
    ? node.y < segY0 && segY0 < nodeY1
    : Math.max(segY0, node.y) < Math.min(segY1, nodeY1)
  return xHit && yHit
}

/** 通道成员（三段折线前向边）：源同列且目标同列 → 默认路径完全重合，装配前按纵向跨度重叠关系错开车道。
 *  导出仅供避让纯函数的白盒用例直喂几何输入（设计 U3 降级/残留分支用例形态）。 */
export interface ChannelMember { // oe-exempt:20261108:framework:workflow-viz 通道成员数据形状类型（白盒用例直喂几何输入的契约——数据形状非抽象接口，routing-avoid 单源）
  x1: number
  y1: number
  x2: number
  y2: number
  /** 竖线段纵向跨度（lo ≤ hi）。 */
  lo: number
  hi: number
  /** 错开分配后的竖线 x（缺省 = 默认中位；装配前回填）。 */
  laneX: number
  /** 端点节点 id（穿卡检测排除横段自身锚定的端点卡片）。 */
  fromId: string
  toId: string
}

/**
 * 错开分配（通道表原地回填 laneX）：通道内按 y1 升序贪心分「纵向跨度互相重叠」的
 * 游程（首碰归属，端点相触视作重叠）——游程序 = 错开序：同游程的边互不重叠可共线，
 * 跨游程必重叠必须分道；整通道按游程数以默认中位为中心居中错开（单游程回到中位不动）
 * ——fan-in/fan-out 不再叠成一根线。
 */
export function assignChannelLanes(channels: Map<string, ChannelMember[]>): void {
  for (const members of channels.values()) {
    members.sort((a, b) => a.y1 - b.y1 || a.y2 - b.y2)
    const runs: ChannelMember[][] = []
    const runMaxHi: number[] = []
    for (const m of members) {
      const fit = runs.findIndex((_, i) => m.lo > runMaxHi[i])
      if (fit === -1) {
        runs.push([m])
        runMaxHi.push(m.hi)
      } else {
        runs[fit].push(m)
        runMaxHi[fit] = Math.max(runMaxHi[fit], m.hi)
      }
    }
    const midX = (members[0].x1 + members[0].x2) / HALF
    const laneBase = -((runs.length - 1) * LANE_STEP_PX) / HALF
    runs.forEach((run, ri) => {
      const laneX = midX + laneBase + ri * LANE_STEP_PX
      for (const m of run) m.laneX = laneX
    })
  }
}

/** 节点列间走廊带（通道避让候选）：相邻两列卡片带之间的空隙（lo/hi = 卡片缘，center = 带中心）。 */
interface CorridorBand { // oe-exempt:20261108:framework:workflow-viz 路由几何数据形状类型（列间走廊带的 lo/hi/center 三数值——数据形状非抽象接口，routing-avoid 单源）
  lo: number
  hi: number
  center: number
}

/** 枚举节点列间走廊带：按节点左缘 x 聚列（容差同列判定），相邻列卡片右/左缘之间为一带。 */
function corridorBands(nodes: DagLayoutNode[]): CorridorBand[] {
  const columns: number[] = []
  for (const n of nodes) {
    if (!columns.some((x) => Math.abs(x - n.x) < COINCIDE_EPS)) columns.push(n.x)
  }
  columns.sort((a, b) => a - b)
  const bands: CorridorBand[] = []
  for (let i = 0; i + 1 < columns.length; i++) {
    const lo = columns[i] + DAG_NODE_W
    const hi = columns[i + 1]
    if (hi - lo <= 0) continue
    bands.push({ lo, hi, center: (lo + hi) / HALF })
  }
  return bands
}

/**
 * 通道竖线避让（设计 workflow-viz-fit-and-routing §3.2 决策三）：穿卡检测覆盖三段
 * 折线全程（竖线迁移后横段仍可能穿卡——走查反例：避让侧选中等距一侧时「源右缘→竖线」
 * 横段完整穿过中间列节点带）；通道内全部成员的竖线随车道整体平移同一差值（车道相对
 * 错开保持，折点结构不变），候选 = 跨度内列间走廊带中心。
 *
 * 选择规则：①零穿卡候选取距原中位最近者（等距取较大 x）；②有候选但全穿卡 → 取穿卡
 * 线段数最少、再距原中位最近者（已知残留：错误呈现不追阶梯绕行，恢复路径 = 任一 DAG
 * 变更触发布局重评，重审触发 = 残留形态稳定复现，见设计「残留登记要素」）；③无任何
 * 可容纳车道铺开的走廊（高并行车道铺开越界）→ 降级单线宽（车道并线）重评，仍无 →
 * 保持中位（罕见残留，不抛）。
 *
 * 零扰动约束：无障碍通道（相邻列常态）的走廊中心恰等于原中位，零穿卡且最近候选即
 * 自身，laneX 不动——既有中位断言用例保持绿。
 */
export function avoidObstructedChannelMid(channels: Map<string, ChannelMember[]>, nodes: DagLayoutNode[]): void {
  const bands = corridorBands(nodes)
  if (bands.length === 0) return
  for (const members of channels.values()) {
    const midX = (members[0].x1 + members[0].x2) / HALF
    const spanLo = Math.min(members[0].x1, members[0].x2)
    const spanHi = Math.max(members[0].x1, members[0].x2)
    const laneSpread = Math.max(...members.map((m) => m.laneX)) - Math.min(...members.map((m) => m.laneX))
    const inSpan = (band: CorridorBand): boolean => band.center > spanLo && band.center < spanHi
    /** 走廊容量：车道铺开 + 两侧净距须容于带宽（spread=0 即单线宽档）。 */
    const capacityOk = (band: CorridorBand, spread: number): boolean =>
      band.hi - band.lo >= spread + PIERCE_CLEARANCE_PX * HALF
    /** 候选中心下全通道的穿卡线段数（collapse=true 时全体成员竖线并到 center，丢弃车道错开）。 */
    const countPierced = (center: number, collapse: boolean): number => {
      let count = 0
      for (const m of members) {
        const lane = collapse ? center : m.laneX + (center - midX)
        const segments: [number, number, number, number, string | undefined][] = [
          [m.x1, m.y1, lane, m.y1, m.fromId],
          [lane, m.y1, lane, m.y2, undefined],
          [lane, m.y2, m.x2, m.y2, m.toId],
        ]
        for (const [sx0, sy0, sx1, sy1, excludeId] of segments) {
          const hit = nodes.some((n) => segmentHitsNode(sx0, sy0, sx1, sy1, n, excludeId))
          if (hit) count += 1
        }
      }
      return count
    }
    /** 距原中位最近者（等距取较大 x）。 */
    const pickNearest = (candidates: CorridorBand[]): CorridorBand => {
      let best = candidates[0]
      for (const b of candidates.slice(1)) {
        const db = Math.abs(b.center - midX)
        const dBest = Math.abs(best.center - midX)
        if (db < dBest || (db === dBest && b.center > best.center)) best = b
      }
      return best
    }

    const usable = bands.filter((b) => inSpan(b) && capacityOk(b, laneSpread))
    if (usable.length > 0) {
      const zeros = usable.filter((b) => countPierced(b.center, false) === 0)
      if (zeros.length > 0) {
        const delta = pickNearest(zeros).center - midX
        for (const m of members) m.laneX += delta
      } else {
        // 规则②：全穿卡残留——最少穿卡线段数优先，再距原中位最近，再取较大 x
        const ranked = [...usable].sort((a, b) =>
          countPierced(a.center, false) - countPierced(b.center, false)
          || Math.abs(a.center - midX) - Math.abs(b.center - midX)
          || b.center - a.center)
        const delta = ranked[0].center - midX
        for (const m of members) m.laneX += delta
      }
      continue
    }
    // 规则③：无任何可容纳车道铺开的走廊 → 降级单线宽（并线）重评；仍无 → 保持中位
    const collapsedZeros = bands.filter((b) => inSpan(b) && capacityOk(b, 0) && countPierced(b.center, true) === 0)
    if (collapsedZeros.length > 0) {
      const center = pickNearest(collapsedZeros).center
      for (const m of members) m.laneX = center
    }
  }
}

/**
 * 同行直线边的纵向绕行带（设计 workflow-viz-fit-and-routing §3.2 决策四）：直线由
 * 两端点决定无法横向迁移（纯水平路径必穿同 y 节点），唯一避让维度 = 纵向。障碍 =
 * 覆盖边 y 且 x 区间与 (x1,x2) 相交的节点（共用穿卡谓词——障碍盒含实例卡区，多障碍
 * 取并集）；绕行带 yB 取全部障碍行底（含卡区）+ margin（向下）或行顶 − margin
 * （向上）的近者（等距取上），选择后校验绕行横段（yB 高度上跨度内无任何节点覆盖），
 * 不满足试另一方向，两方向均不满足 → null（调用方保持直线，罕见残留——恢复路径与
 * 重审触发同决策三「残留登记要素」，重审后评估多级绕行档）。
 */
export function sameRowBypass(
  x1: number,
  y: number,
  x2: number,
  nodes: DagLayoutNode[],
  fromId: string,
  toId: string,
): { yB: number } | null {
  const notEndpoint = (n: DagLayoutNode): boolean => n.node.id !== fromId && n.node.id !== toId
  const obstacles = nodes.filter((n) => notEndpoint(n) && segmentHitsNode(x1, y, x2, y, n))
  if (obstacles.length === 0) return null
  const downY = Math.max(...obstacles.map((o) => o.y + o.h + o.zoneH)) + BYPASS_MARGIN_PX
  const upY = Math.min(...obstacles.map((o) => o.y)) - BYPASS_MARGIN_PX
  const preferUp = Math.abs(upY - y) <= Math.abs(downY - y)
  for (const yB of preferUp ? [upY, downY] : [downY, upY]) {
    const crossed = nodes.some((n) => notEndpoint(n) && segmentHitsNode(x1, yB, x2, yB, n))
    if (!crossed) return { yB }
  }
  return null
}

