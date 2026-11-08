<!--
  WorkflowVizDag —— DAG 画布（自绘 SVG，无图库；workflow-visualization 设计 §3.2
  渲染选型 A：列式布局 + 状态点亮 + 缩放平移 + 点击上抛）。

  结构：phase 分区背景列（WorkflowDagPhase.order 升序）→ 边（顺序/数据流/条件谓词
  标注/循环回边）→ 节点卡片（per-node 包 WorkflowVizDagNodeGuard 节点级边界）。

  交互：
  - 视口（fit/free 二态状态机，2026-10-23 设计裁决）：fit 态 = 全图自适应
    （computeFitTransform 缩放到四周留 FIT_PAD_PX 空隙并居中，内容小于视口不放大
    k 封顶 1；容器尺寸变化经 ResizeObserver 重新 fit——含挂载时容器未布局的
    首次就绪补 fit）；用户接管即转 free 态——自动 fit 停用（容器变化、实例流式
    到达引起的节点增高不追打，不与用户手势竞争），右下角出「回到全景」入口
    （点击回 fit 态并 fit 一次，此后恢复自动 fit 直至下次接管）。接管判定：
    拖拽位移超 PAN_THRESHOLD_PX 的 pan 与 wheel 缩放算接管，pointerdown 未移动
    不算（纯点击）；程序化写视口（fitView 及其全部调用路径）结构性不触发接管
    ——转 free 只存在于两个手势处理器内；切 run 重置回 fit 态；
  - 点击上抛（[2026-10-19] agent 钻取语义删除，钻取入口 = 下方实例 trace 行）：
    pending/skipped 节点（零实例、无对话可看——skipped = run 终局后零实例）与
    phase 分区 → semantic 'phase'（设计 §3.1-2 点击行为边界）；其余节点/实例行
    no-op（纯展示）。

  运行实况：节点七态经 props.nodeStates 接收已派生映射（派生单处归 u5，D9 单点
  实现——本组件不自行判定 retrying/skipped；方案 C 后七态仅作 data-state 观察
  锚与 skipped 淡化判据，卡片着色恒中性——状态语义归节点卡片内实例行）；执行实例
  经 props.instancesByNode 接收已匹配映射（D2 产物含 tier 2 名称族回落，宿主单处
  派生），用于节点实例行渲染与布局高度表；run 停止叠加（D9）消费 run 级原始输入
  （runStatus/runOutcome）归一为 stopTone 传入节点卡片（作用于在途实例行 dot）；
  当前 phase 分区高亮经 props.activePhase（已派生，由壳透传）。dag prop = 宿主的
  重归属派生视图（blueprint-attribution：调用点按实例运行时 phase 落回语义分区，
  分区按执行序）。
-->
<template>
  <div
    class="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-surface-2 active:cursor-grabbing"
    data-testid="wfvz-dag-root"
    :style="DAG_DOTGRID_STYLE"
  >
    <!-- select-none 替代原 :deep(svg/g) user-select——none 经 auto 传播覆盖全部后代 -->
    <svg
      ref="svgRef"
      class="block h-full w-full select-none"
      role="img"
      :aria-label="t('panel.workflowViz.dagCanvasLabel')"
      data-testid="wfvz-dag-svg"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @wheel.prevent="onWheel"
    >
      <!-- 边方向箭头（单一 marker + context-stroke 继承各边 kind 描边色——Chromium
           119+ 支持；markerUnits=userSpaceOnUse 随视口缩放同步，与线宽同比） -->
      <defs>
        <marker
          id="wfvz-dag-arrow"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
          markerUnits="userSpaceOnUse"
          data-testid="wfvz-dag-arrow-def"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
      </defs>
      <g :transform="`translate(${vp.tx},${vp.ty}) scale(${vp.k})`" data-testid="wfvz-dag-viewport">
        <!-- phase 分区背景列（当前 phase 高亮：accent 描边）。分区标签 2xs/font-medium
             与节点名 3xs 拉开半档（D3 标签档位，V1-wf③ 分层断言口径）+ 副标题
             「执行段 0N · n 调用点」（方案 C demo §3.1 分区信息行）。描边形态
             （方案 C demo 裁决，覆盖 workflow-overlay-refine D3 恒虚线形态）：普通
             分区实线（虚线 = 纯脚本段专属语义——demo §9.2 中优先级「普通 phase 实线
             与 DAG 一致」；空 default 分区在布局层已整体消隐不产 cluster） -->
        <g
          v-for="c in layout.clusters"
          :key="c.phase"
          :data-wfvz-cluster="c.phase"
          :data-active="c.phase === activePhase ? 'true' : undefined"
          :data-script-only="c.scriptOnly ? 'true' : undefined"
          :data-testid="`wfvz-dag-cluster-${c.phase}`"
        >
          <rect
            :class="[
              'stroke-border-strong [rx:var(--radius-sm)]',
              c.scriptOnly ? 'fill-transparent [stroke-dasharray:5_4]' : 'fill-surface',
              c.phase === activePhase ? 'stroke-accent [stroke-width:1.5]' : '',
            ]"
            :x="c.x"
            :y="c.y"
            :width="c.width"
            :height="c.height"
          />
          <text
            class="fill-neutral-mid text-[length:var(--text-2xs)] font-medium tracking-[0.03em]"
            :x="c.x + CLUSTER_TITLE_INSET"
            :y="c.y + CLUSTER_TITLE_H_BASE"
          >{{ c.phase }}</text>
          <!-- 分区副标题（方案 C demo §3.1）：展示序号（消隐 default 后的可见列序，
               1 起补零两位）+ 调用点计数；纯脚本段以「纯脚本」替代计数（合一行，
               demo 同款「执行段 01 · 纯脚本」） -->
          <text
            class="fill-neutral-faint text-[length:var(--text-3xs)] font-mono"
            :x="c.x + CLUSTER_TITLE_INSET"
            :y="c.y + CLUSTER_TITLE_H_BASE + CLUSTER_SUB_BASELINE_DROP"
            :data-testid="`wfvz-dag-cluster-sub-${c.phase}`"
          >{{
            c.scriptOnly
              ? t('panel.workflowViz.clusterStageScript', { order: formatStageOrder(c.order) })
              : t('panel.workflowViz.clusterStageSub', { order: formatStageOrder(c.order), count: c.nodeCount })
          }}</text>
        </g>

        <!-- 边：kind 着色（sequence 灰 / dataflow 实线深 / conditional 中性虚线 /
             loop-back 虚线 accent 下绕弧）。conditional 2026-11-08 视觉裁决退黄：warn
             色三重叠加（边 + 箭头 + 谓词文字）视觉噪声大，分支语义收敛为「中性虚线
             线型」（虚线 = 非必走），推翻 fit-and-routing 的 warn 着色；marker-end 箭头
             标流向（tip 落在目标锚点 = 节点边中点，色随 context-stroke 跟边） -->
        <path
          v-for="le in edges"
          :key="le.edge.id"
          class="fill-none"
          :class="EDGE_KIND_CLASS[le.edge.kind]"
          :d="le.d"
          marker-end="url(#wfvz-dag-arrow)"
          :data-testid="`wfvz-dag-edge-${le.edge.id}`"
        />
        <!-- 条件边谓词徽章（2026-11-08 视觉裁决）：小圆角底徽章，跨列边悬浮在连线
             上方不遮盖连线（徽章底距线 4px，布局 PREDICATE_BADGE_LINE_LIFT 口径），
             同列边平铺分区头徽章带；截短文本常显 + title 悬停全文 -->
        <g
          v-for="le in conditionalEdges"
          :key="`label-${le.edge.id}`"
          :data-testid="`wfvz-dag-edge-label-${le.edge.id}`"
        >
          <title>{{ le.edge.predicate }}</title>
          <rect
            class="fill-[var(--surface)] stroke-[var(--border-strong)] [rx:3]"
            :x="(le.labelX ?? 0) - badgeWidth(le.edge.predicate) / HALF"
            :y="(le.labelY ?? 0) - PREDICATE_BADGE_H + TEXT_BASELINE_DROP"
            :width="badgeWidth(le.edge.predicate)"
            :height="PREDICATE_BADGE_H"
          />
          <text
            class="fill-[var(--neutral-mid)] text-[length:var(--text-3xs)] font-mono"
            :x="le.labelX ?? 0"
            :y="le.labelY ?? 0"
            text-anchor="middle"
          >{{ truncate(le.edge.predicate ?? '', PREDICATE_MAX_CHARS) }}</text>
        </g>

        <!-- 节点卡片（per-node 边界：单节点渲染失败 = 占位错误态，不挂整画布）；
             data-stop-tone 同值绑外层与节点卡片根（测试观察锚点，非 CSS 选择器——
             着色由节点卡片 tone computed 整组切换 Tailwind 类） -->
        <g
          v-for="ln in layout.nodes"
          :key="ln.node.id"
          :transform="`translate(${ln.x},${ln.y})`"
          :data-wfvz-node="ln.node.id"
          :data-wfvz-phase="ln.node.phase"
          :data-state="nodeState(ln.node.id)"
          :data-stop-tone="stopTone ?? undefined"
          :data-testid="`wfvz-dag-node-${ln.node.id}`"
        >
          <WorkflowVizDagNodeGuard>
            <WorkflowVizDagNode
              :node="ln.node"
              :status="nodeState(ln.node.id)"
              :stop-tone="stopTone"
              :instances="instancesByNode?.get(ln.node.id)"
            />
          </WorkflowVizDagNodeGuard>
        </g>
      </g>
    </svg>

    <!-- 零节点 run（纯门禁脚本无 agent()）：空画布 + 居中摘要提示（设计 §3.1-3） -->
    <div
      v-if="isEmptyDag"
      class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1"
      data-testid="wfvz-dag-empty"
    >
      <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('panel.workflowViz.noAgentCalls') }}</p>
      <p class="text-[length:var(--text-3xs)] text-neutral-dim">{{ t('panel.workflowViz.noAgentCallsHint') }}</p>
    </div>

    <!-- free 态右下角「回到全景」（接管后自动 fit 停用的唯一恢复入口）；fit 态该
         位置为操作提示角标——两态互斥占位，零布局冲突 -->
    <Button
      v-if="viewMode === 'free'"
      variant="secondary"
      size="dense"
      class="absolute bottom-2 right-3 h-6 gap-1 rounded-sm px-2 text-[length:var(--text-2xs)]"
      data-testid="wfvz-dag-back-to-fit"
      @click="backToFit"
    >{{ t('panel.workflowViz.dagBackToFit') }}</Button>
    <span
      v-else
      class="pointer-events-none absolute bottom-2 right-3 text-[length:var(--text-3xs)] text-neutral-faint"
      data-testid="wfvz-dag-hint"
    >{{ t('panel.workflowViz.dagZoomHint') }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WorkflowAgentCall, WorkflowDag, WorkflowDagEdgeKind, WorkflowRunOutcome, WorkflowRunStatus } from '@taiji/shared'
import { Button } from '@/components/ui/button'
import { instanceZoneHeight, layoutDag, PREDICATE_MAX_CHARS, predicateBadgeWidth } from './layout'
import { layoutEdges } from './layout-edges'
import { useDagViewport } from './useDagViewport'
import WorkflowVizDagNode from './WorkflowVizDagNode.vue'
import WorkflowVizDagNodeGuard from './WorkflowVizDagNodeGuard.vue'
import type { WorkflowVizDagClickPayload, WorkflowVizDagNodeStatus, WorkflowVizDagStopTone } from './types'

const props = defineProps<{
  /** DAG 蓝图（session.getWorkflowDag 成功臂；null = 数据未就绪——空画布）。 */
  dag: WorkflowDag | null
  /**
   * 节点七态映射（nodeId → 状态）。已派生数据（D9 派生单处在 u5——retrying/skipped
   * 判定不在此实现）；缺失键按 'pending' 兜（run 运行中零实例节点一律 pending）。
   */
  nodeStates?: Record<string, WorkflowVizDagNodeStatus>
  /** run 级状态（D9 停止维度输入：非 running 时在途节点叠加停止着色）。 */
  runStatus?: WorkflowRunStatus
  /** run 终局形态（runStatus='done' 时叠加着色随 outcome；缺省保守中性）。 */
  runOutcome?: WorkflowRunOutcome
  /** 当前 phase 分区（已派生；命中分区 accent 描边高亮）。 */
  activePhase?: string | null
  /**
   * 执行实例挂接映射（D2 匹配单源 matchInstancesToNodes().byNode，宿主单处派生；
   * nodeId → 实例列表 taskIndex 升序）。画布消费两处：节点实例行渲染 + 增高节点
   * 的布局高度表。缺省（数据未就绪）= 全部节点零实例形态（模板名标题、基准高）。
   */
  instancesByNode?: Map<string, WorkflowAgentCall[]>
}>()

const emit = defineEmits<{
  /** 点击上抛：pending/skipped 节点（=phase 语义）/ phase 分区（agent 钻取语义已删）。 */
  select: [payload: WorkflowVizDagClickPayload]
}>()

const { t } = useI18n()

/**
 * 边 kind → Tailwind 着色类（每分支给全 stroke 色 + 宽度/虚线，不做「基类 +
 * kind 覆盖」——同名 stroke-* 工具类并存时胜负取决于调色板发射序而非 class 顺序）。
 * conditional 中性虚线（2026-11-08 视觉裁决退黄，见模板注释）：虚线线型承载「分支
 * = 可能不走」语义，warn 色退场（此前边+箭头+谓词文字三重黄视觉噪声大）。
 */
const EDGE_KIND_CLASS: Record<WorkflowDagEdgeKind, string> = {
  sequence: 'stroke-neutral-faint [stroke-width:1.2]',
  dataflow: 'stroke-neutral-ico [stroke-width:1.3]',
  conditional: 'stroke-neutral-dim [stroke-width:1.2] [stroke-dasharray:5_4]',
  'loop-back': 'stroke-accent [stroke-width:1.2] [stroke-dasharray:6_4]',
}

/** 画布点阵背景（demo graph-scroll 同款形态：1px 点 × 18px 网格，2026-11-08 用户
 *  裁决）：点色经 color-mix 从 --neutral-fg 派生（暗族白点微亮 / 亮族墨点微暗，六主题
 *  自动跟随），行内 style 而非 Tailwind 任意值类（radial-gradient 含逗号的任意值类
 *  挂 JIT 生成风险）。 */
const DAG_DOTGRID_STYLE = {
  backgroundImage: 'radial-gradient(circle at 1px 1px, color-mix(in oklch, var(--neutral-fg) 4%, transparent) 1px, transparent 0)',
  backgroundSize: '18px 18px',
} as const
const CLUSTER_TITLE_INSET = 12
const CLUSTER_TITLE_H_BASE = 20
/** 分区副标题与分区标题的基线落差（px；副标题挂在标题下一行）。 */
const CLUSTER_SUB_BASELINE_DROP = 14
/** 谓词徽章截断上限与宽度估算单源在 layout（PREDICATE_MAX_CHARS /
 *  predicateBadgeWidth——列距自适应与徽章渲染同宽，跨列徽章骑线平铺在自己专属的
 *  列间隙内不跨卡片）。 */
/** 谓词徽章高（px，= 分区头预留徽章带的带高）。 */
const PREDICATE_BADGE_H = 14
/** 文字基线到徽章底边的下伸量（px，基线以下 3px 下缘收在底边内）。 */
const TEXT_BASELINE_DROP = 3
/** 取半除数（徽章中心 x = 锚点 x − 宽/2；具名以过 no-magic-numbers）。 */
const HALF = 2

/** 谓词徽章宽（单源 layout.predicateBadgeWidth；空谓词按 0 宽）。 */
function badgeWidth(predicate: string | undefined): number {
  return predicate === undefined ? 0 : predicateBadgeWidth(predicate)
}
/** 分区展示序号补零位数（demo 同款「执行段 01」两位序）。 */
const STAGE_ORDER_PAD = 2

/** 分区展示序号格式化（1 → '01'，10 起原样两位）。 */
function formatStageOrder(order: number): string {
  return String(order).padStart(STAGE_ORDER_PAD, '0')
}


/** dag prop 未就绪（null）时布局用的空 DAG（layoutDag/layoutEdges 均纯函数不 mutate 输入）。 */
const EMPTY_DAG: WorkflowDag = { nodes: [], edges: [], phases: [], parallelGroups: [], loops: [] }

/**
 * 节点实例卡区高度表（方案 C demo §3.3 三层形态：实例 = 主体外独立小卡，全部节点
 * 的卡区按 instanceZoneHeight 派生——0 实例也含一行虚线占位卡；与节点卡片同一高度
 * 函数，布局几何与卡片渲染单源，不会出现小卡溢出分区矩形。挂接映射未就绪/零实例
 * 节点缺省键 = 0 实例占位卡高，由 layout 兜底）。
 */
const instanceZones = computed(() => {
  const zones = new Map<string, number>()
  const byNode = props.instancesByNode
  if (byNode === undefined) return zones
  for (const [id, calls] of byNode) {
    zones.set(id, instanceZoneHeight(calls.length))
  }
  return zones
})

const layout = computed(() => layoutDag(props.dag ?? EMPTY_DAG, instanceZones.value))
const edges = computed(() => layoutEdges(props.dag ?? EMPTY_DAG, layout.value.nodes))
const conditionalEdges = computed(() => edges.value.filter((le) => le.edge.kind === 'conditional' && le.edge.predicate))
const isEmptyDag = computed(() => (props.dag?.nodes.length ?? 0) === 0)

function nodeState(nodeId: string): WorkflowVizDagNodeStatus {
  return props.nodeStates?.[nodeId] ?? 'pending'
}

/**
 * D9 停止叠加归一（叠加两档只属于「被停止的 run」，正常完成不是停止）：
 * run 运行中 = null（无叠加，在途节点正常蓝脉冲）；outcome='done' = null（正常
 * 完成的 run 七态自明——done 节点 success 绿与 skipped 虚线不被叠加吞掉，D9
 * 「DAG done = success 供扫读」）；interrupted（暂停）与 cancelled（用户主动终局）
 * 落中性暗（tray-tone「同语义同色」先例）；failed / time_limited 落失败色系
 * （D9 着色映射全枚举）；done + outcome 缺省（v1 存量数据缺口）保守中性暗，
 * 不作成败断言。
 */
const stopTone = computed<WorkflowVizDagStopTone>(() => {
  if (props.runStatus === undefined || props.runStatus === 'running') return null
  if (props.runStatus === 'interrupted') return 'neutral'
  if (props.runOutcome === 'failed' || props.runOutcome === 'time_limited') return 'failed'
  if (props.runOutcome === 'done') return null
  return 'neutral'
})

// 视口（fit/free 状态机与 pan/zoom 手势）单源在 useDagViewport composable——
// 2026-11 拆出（本组件 script setup 超 300 行门禁上限，拆分纯搬移零行为变更）；
// 切 run 重置锚 = 节点 id 集签名（重归属派生视图引用不稳，签名判等防实例流式
// 到达误判切 run——机制注释见 composable）；画布点击路由（emit 依赖）留本组件，
// 经 onCanvasClick 注入（function 声明提升使其可前向引用）。
const {
  svgRef, vp, viewMode, backToFit,
  onPointerDown, onPointerMove, onPointerUp, onWheel,
} = useDagViewport({
  contentSize: () => ({ width: layout.value.width, height: layout.value.height }),
  runSignature: () => (props.dag?.nodes ?? []).map((n) => n.id).join('\u0000'),
  onCanvasClick: routeClick,
})

/**
 * 点击路由（[2026-10-19] agent 钻取语义删除——节点/实例行不再开 agent 详情，归宿 =
 * 下方实例 trace 行）：节点按渲染态分语义——pending（运行中零实例）与 skipped（run
 * 终局后零实例）同为「零实例、无对话可看」，点击开所属 phase tab（设计 §3.1-2 点击
 * 行为边界）；其余态节点与实例行 no-op（纯展示）；phase 分区点击开 phase tab。
 */
function routeClick(target: EventTarget | null): void {
  const el = target as Element | null
  if (!el || typeof (el as Element).closest !== 'function') return
  const nodeEl = (el as Element).closest('[data-wfvz-node]')
  if (nodeEl) {
    const id = nodeEl.getAttribute('data-wfvz-node') ?? ''
    const node = props.dag?.nodes.find((n) => n.id === id)
    if (!node) return
    const state = nodeState(id)
    if (state === 'pending' || state === 'skipped') {
      emit('select', { semantic: 'phase', phase: node.phase })
    }
    return
  }
  const clusterEl = (el as Element).closest('[data-wfvz-cluster]')
  if (clusterEl) {
    emit('select', { semantic: 'phase', phase: clusterEl.getAttribute('data-wfvz-cluster') ?? '' })
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
</script>

