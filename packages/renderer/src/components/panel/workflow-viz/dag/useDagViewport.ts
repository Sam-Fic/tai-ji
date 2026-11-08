/**
 * useDagViewport —— DAG 画布视口 composable（fit/free 二态状态机 + pan/zoom 手势）。
 * 2026-11 自 WorkflowVizDag.vue 拆出（组件 script setup 超 300 行门禁上限）；视口语义
 * 与 2026-10-23「fit 不追打」裁决逐条保持——拆分纯搬移零行为变更。
 *
 * 视口模式：'fit' = 全图自适应态（挂载/切 run/回到全景时进入，容器尺寸变化自动
 * 重新 fit）；'free' = 用户接管态（pan 位移超阈值或 wheel 缩放触发，自动 fit 停用，
 * 直至回到全景或切 run 重置）。转 'free' 只存在于两个用户手势处理器内——程序化写
 * 视口（fitView 及其调用路径：挂载、切 run、ResizeObserver 回调、回到全景按钮）
 * 结构性不可能触发接管。
 *
 * 消费方：WorkflowVizDag（模板绑定 svgRef/vp/viewMode 与四手势处理器；画布点击
 * 路由 emit 依赖留组件侧经 onCanvasClick 注入）。
 */
import { onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from 'vue'
import { ZOOM_MIN, computeFitTransform } from './layout'

/** wheel 缩放灵敏度（指数系数，原型同款）。 */
const ZOOM_WHEEL_FACTOR = 0.0012
/** wheel 缩放上限（下限 ZOOM_MIN 单处在 layout，fit 与手动缩放共用同值）。 */
const ZOOM_MAX = 2.6
/** 拖拽判定阈值（px 位移，超过 = pan 非 click）。 */
const PAN_THRESHOLD_PX = 5

/** 视口模式（fit 自适应 / free 用户接管）。 */
export type DagViewMode = 'fit' | 'free'

/** 视口变换（k 缩放 + tx/ty 平移，画布 viewport 的 transform 三元组）。 */
export interface DagViewportTransform { // oe-exempt:20261108:framework:workflow-viz 视口变换三元组数据形状类型（k/tx/ty——数据形状非抽象接口，useDagViewport 单源）
  k: number
  tx: number
  ty: number
}

/**
 * 视口 composable 入口。
 *
 * @param options.contentSize fit 内容尺寸（画布 layout 产物宽高；每次 fit 调用时现取
 *   ——实例流式到达的节点增高不触发重 fit，fit 态下内容仍完整可达）
 * @param options.runSignature 切 run 重置锚（节点 id 集签名——宿主传入的是重归属派生
 *   视图 blueprint-attribution，实例流式到达会换对象引用，引用判等会把每次实例到达
 *   误判成切 run；同一蓝图的节点 id 集稳定不变，只有换脚本才会变）
 * @param options.onCanvasClick 纯点击回调（pointerdown 后零位移的 pointerup）——画布
 *   点击路由依赖组件 emit，留在组件侧注入
 */
export function useDagViewport(options: {
  contentSize: () => { width: number; height: number }
  runSignature: () => string
  onCanvasClick: (target: EventTarget | null) => void
}): {
  svgRef: Ref<SVGSVGElement | null>
  vp: DagViewportTransform
  viewMode: Ref<DagViewMode>
  backToFit: () => void
  onPointerDown: (e: PointerEvent) => void
  onPointerMove: (e: PointerEvent) => void
  onPointerUp: () => void
  onWheel: (e: WheelEvent) => void
} {
  const svgRef = ref<SVGSVGElement | null>(null)
  /** 视口变换（tx/ty 平移 + k 缩放；初始与切换 run 重置时居中——见 fitView）。 */
  const vp = reactive<DagViewportTransform>({ k: 1, tx: 0, ty: 0 })
  const viewMode = ref<DagViewMode>('fit')

  /**
   * fit-to-view（fit 态的视口写入单源）：内容缩放到四周各留 FIT_PAD_PX 空隙后居中；
   * 内容小于视口不放大（k 封顶 1，文字原生渲染）。容器尺寸无布局环境（jsdom
   * clientWidth 缺失）→ computeFitTransform 退化 k=1 平移 0，不破坏渲染。实例流式
   * 到达的节点增高不触发本函数（布局变化不改视口——free 态不与用户手势竞争，
   * fit 态下内容仍完整可达无需重 fit）。
   */
  function fitView(): void {
    const content = options.contentSize()
    const fit = computeFitTransform(
      svgRef.value?.clientWidth ?? 0,
      svgRef.value?.clientHeight ?? 0,
      content.width,
      content.height,
    )
    vp.k = fit.k
    vp.tx = fit.tx
    vp.ty = fit.ty
  }

  /**
   * fit 前的容器尺寸就绪闸（挂载过渡态竞态）：overlay 刚挂载时容器可能尚未布局
   * （宽高均为 0 的过渡态）——此时 fit 只得 k=1 平移 0 的退化形态（内容宽于视口
   * 即裁切）。就绪 = 任一轴有布局（> 0），与 computeFitTransform 的单轴参与口径
   * 对齐（缺席轴不参与约束、该向偏移取 0）；未就绪时不 fit，由持续 ResizeObserver
   * 在 fit 态下首次非零尺寸回调补 fit。
   */
  function containerSizeReady(): boolean {
    const el = svgRef.value
    return (el?.clientWidth ?? 0) > 0 || (el?.clientHeight ?? 0) > 0
  }

  function fitWhenContainerReady(): void {
    if (containerSizeReady()) fitView()
  }

  /**
   * 容器尺寸持续观察（fit 态自动重新 fit 的驱动源）：fit 态下容器变化（窗口拖宽、
   * overlay 布局就绪）→ 重新 fit；free 态 → 不动（用户接管后自动 fit 停用）。
   * 环境无 ResizeObserver（jsdom）时不观察，维持既有退化口径（挂载时一次性 fit）。
   */
  let resizeObserver: ResizeObserver | null = null

  // 打开 overlay 即挂载（壳 v-if dag !== null）→ 初始视口 = 全图 fit 居中
  // （容器未布局时不 fit，观察器回调就绪后补 fit）
  onMounted(() => {
    fitWhenContainerReady()
    const el = svgRef.value
    if (el === null || typeof ResizeObserver === 'undefined') return
    resizeObserver = new ResizeObserver(() => {
      if (viewMode.value !== 'fit' || !containerSizeReady()) return
      fitView()
    })
    resizeObserver.observe(el)
  })

  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
  })

  // 切换 run（D11：开新 run 切内容）→ 视口重置为新蓝图的 fit（全图居中、四周
  // FIT_PAD_PX 留白）+ 状态机回 fit 态：此前用户 pan/zoom 接管过也在重置中放弃，
  // 此后恢复自动 fit 直至下次接管。
  watch(options.runSignature, () => {
    viewMode.value = 'fit'
    fitWhenContainerReady()
  })

  /**
   * 「回到全景」入口（free 态右下角按钮）：回 fit 态并 fit 一次——此后恢复自动
   * fit 语义（容器变化重新 fit）直至下次用户接管。
   */
  function backToFit(): void {
    viewMode.value = 'fit'
    fitWhenContainerReady()
  }

  // ── 缩放平移（原型 04-final-overlay.html 手法：client 坐标差换算，规避
  // getScreenCTM 在测试环境缺失；pan 位移按 1/k 修正保持视觉等速）。
  // 指针事件经 setPointerCapture 锁定到 svg（指针移出画布释放/移动仍可达——W3C
  // 指针捕获语义，比 window 级监听干净且无泄漏；环境不支持 capture 时退化为
  // 画布内交互，拖出释放的边缘场景丢失可接受） ──

  interface PanState { // oe-exempt:20261108:framework:workflow-viz 拖拽会话状态数据形状类型（指针手势的瞬时状态字段集——数据形状非抽象接口，useDagViewport 单源）
    sx: number
    sy: number
    tx0: number
    ty0: number
    moved: boolean
    target: EventTarget | null
  }
  let pan: PanState | null = null

  function onPointerDown(e: PointerEvent): void {
    pan = { sx: e.clientX, sy: e.clientY, tx0: vp.tx, ty0: vp.ty, moved: false, target: e.target }
    const svg = svgRef.value
    if (svg && typeof svg.setPointerCapture === 'function') {
      try {
        svg.setPointerCapture(e.pointerId)
      } catch (err) {
        // 捕获失败（指针已释放等竞态）：退化画布内交互（拖出释放的边缘场景丢失），不阻断
        console.warn('[useDagViewport] setPointerCapture failed, fallback to in-canvas pan', err)
      }
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pan) return
    if (Math.abs(e.clientX - pan.sx) + Math.abs(e.clientY - pan.sy) > PAN_THRESHOLD_PX) pan.moved = true
    if (pan.moved) {
      // pan 接管（位移超阈值的拖拽）→ free 态（自动 fit 停用；pointerdown 未移动
      // 不进此分支——纯点击不算接管）
      viewMode.value = 'free'
      vp.tx = pan.tx0 + (e.clientX - pan.sx) / vp.k
      vp.ty = pan.ty0 + (e.clientY - pan.sy) / vp.k
    }
  }

  function onPointerUp(): void {
    const wasClick = pan !== null && !pan.moved
    const target = pan?.target ?? null
    pan = null
    if (!wasClick) return
    options.onCanvasClick(target)
  }

  /** wheel 缩放：以指针位置为缩放中心（画布坐标系下保持指针下的内容点不动）。
   *  wheel 即用户接管 → free 态（自动 fit 停用）。 */
  function onWheel(e: WheelEvent): void {
    const rect = svgRef.value?.getBoundingClientRect()
    if (!rect) return
    viewMode.value = 'free'
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const k2 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, vp.k * Math.exp(-e.deltaY * ZOOM_WHEEL_FACTOR)))
    // 保持指针下的画布坐标点不动：new_tx = px - (px - tx) * (k2/k)
    vp.tx = px - (px - vp.tx) * (k2 / vp.k)
    vp.ty = py - (py - vp.ty) * (k2 / vp.k)
    vp.k = k2
  }

  return {
    svgRef,
    vp,
    viewMode,
    backToFit,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheel,
  }
}
